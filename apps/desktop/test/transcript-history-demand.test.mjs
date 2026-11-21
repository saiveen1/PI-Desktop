import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, watch, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildHistoryFixture } from "./fixtures/delegation-history-build.mjs";

const browser = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(existsSync);

async function debugPort(profile) {
  const file = join(profile, 'DevToolsActivePort');
  const watcher = watch(profile, { signal: AbortSignal.timeout(8000) });
  try {
    for (;;) {
      const contents = await readFile(file, 'utf8').catch(error => {
        if (error.code !== 'ENOENT' && error.code !== 'EBUSY') throw error;
        return ''; // Chromium can still hold its port file open while writing it on Windows.
      });
      if (/^\d+\r?\n\//.test(contents)) return Number(contents.split('\n')[0]);
      await watcher.next();
    }
  } finally { await watcher.return(); }
}

function launch(profile, url) {
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, url];
  if (process.platform !== 'win32') {
    const child = spawn(browser, args, { stdio: 'ignore' });
    return () => child.kill();
  }
  const ps = script => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  const command = [browser, ...args].map(part => `"${part}"`).join(' ').replaceAll("'", "''");
  const pid = Number(ps(`$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${command}'}; if ($r.ReturnValue -ne 0) { throw 'Fixture launch failed' }; $r.ProcessId`).trim());
  assert.ok(pid > 0);
  return () => ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p -and $p.CommandLine.Contains('${profile.replaceAll("'", "''")}')) { Invoke-CimMethod -InputObject $p -MethodName Terminate | Out-Null }`);
}

function command(socket, id, method, params) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { socket.removeEventListener('message', reply); socket.removeEventListener('close', closed); };
    const closed = () => { cleanup(); reject(Error('Fixture browser closed')); };
    const reply = ({ data }) => {
      const result = JSON.parse(data);
      if (result.id !== id) return;
      cleanup();
      if (result.error) reject(Error(result.error.message)); else resolve(result.result);
    };
    socket.addEventListener('message', reply);
    socket.addEventListener('close', closed);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

test('transcript history demand and turn context editing', { timeout: 30000, skip: !browser && 'Standalone Chromium unavailable' }, async t => {
  const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), 'transcript-demand-'));
  const profile = join(dir, 'profile');
  let stop, socket;
  try {
    await buildHistoryFixture(dir, 'transcript-history-demand.jsx');
    // Inline the module so file:// needs neither a server nor relaxed browser security.
    const js = (await readFile(join(dir, 'renderer.js'), 'utf8')).replace(/<\/script/gi, '<\\/script');
    const html = '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><style>' +
      '.thread-scroll{width:560px;height:240px;overflow:auto;overflow-anchor:none}.minimap-rail{position:fixed;left:590px}' +
      '[data-message-id]{height:80px;overflow:hidden}[data-message-id^="older-"]{height:16px}</style><div id="root"></div>';
    const url = pathToFileURL(join(dir, 'fixture.html')).href;
    await writeFile(join(dir, 'fixture.html'), `${html}<script type="module">${js}</script>`);
    await mkdir(profile);
    stop = launch(profile, 'about:blank');
    const port = await debugPort(profile);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find(target => target.type === 'page');
    assert.ok(page, 'isolated browser must expose a page');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await once(socket, 'open');
    let id = 0;
    const send = (method, params = {}) => command(socket, ++id, method, params);
    const evaluate = async expression => {
      const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (exceptionDetails) throw Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value;
    };
    await send('Page.enable');
    const loaded = new Promise(resolve => {
      const onMessage = ({ data }) => {
        if (JSON.parse(data).method !== 'Page.loadEventFired') return;
        socket.removeEventListener('message', onMessage);
        resolve();
      };
      socket.addEventListener('message', onMessage);
    });
    await send('Page.navigate', { url });
    await loaded;
    assert.equal(await evaluate('typeof historyDemand'), 'object', 'production fixture must mount');
    const probe = expr => evaluate('historyDemand.' + expr);

    await t.test('underfilled opening stays idle; each top action prepends only once', async () => {
      const before = await probe('open("underfilled")');
      assert.equal(before.maxTop, 0);
      assert.equal(before.calls, 0, 'underfilled opening requested older history');
      for (const expected of [1, 2]) {
        await probe('click("top")');
        const after = await probe(`afterPage(${expected})`);
        assert.equal(after.calls, expected, 'stationary reader drained another page');
        assert.equal(after.rows, before.rows + expected);
      }
    });
    await t.test('restored near-top reading and layout scroll do not request history', async () => {
      const before = await probe('open("restored")');
      assert.ok(before.top > 0 && before.top < 120 && before.maxTop > 120);
      assert.equal(before.calls, 0);
      const after = await probe('layoutAfterRestore()');
      assert.ok(Math.abs(after.offset + 8) <= 1, `restored row offset ${after.offset}`);
      assert.equal(after.top, 2);
      assert.equal(after.calls, 0, 'unowned scroll after restore requested history');
    });
    for (const input of ['wheel', 'minimap']) await t.test(`${input} from the tail requests one earlier page`, async () => {
      const before = await probe(`open("${input}")`);
      assert.ok(before.top > 120 && before.top === before.maxTop);
      assert.equal(before.calls, 0);
      if (input === 'wheel') {
        const point = await probe('wheelPoint()');
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: -before.maxTop });
      } else await probe('click("minimap")');
      const after = await probe('afterPage(1)');
      assert.equal(after.calls, 1);
      assert.equal(after.rows, before.rows + 1);
    });
    for (const mode of ['continue', 'reverse', 'empty']) await t.test(`upward input during a held page: ${mode}`, async () => {
      const before = await probe(`open("delayed-${mode}")`);
      const point = await probe('wheelPoint()');
      const wheel = deltaY => send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY });
      await wheel(-before.maxTop);
      await probe('atBlockedTop()');
      await wheel(-500);
      assert.equal((await probe('atBlockedTop()')).calls, 1, 'page must stay single-flight');
      if (mode === 'reverse') await wheel(160);
      await probe('releasePage()');
      const after = await probe(mode === 'empty' ? 'state()' : `afterPage(${mode === 'continue' ? 2 : 1})`);
      assert.equal(after.calls, mode === 'continue' ? 2 : 1, 'stationary reader must not drain any further');
      if (mode === 'empty') {
        assert.equal(after.rows, before.rows);
        await wheel(-500);
        assert.equal((await probe('afterPage(2)')).calls, 2, 'new upward input may retry an empty page');
      }
    });
    await t.test('return to latest releases expanded history without losing access', async () => {
      const before = await probe('open("deep")');
      assert.equal(before.rows, 61);
      const point = await probe('wheelPoint()');
      const top = deltaY => send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY });
      await top(-before.maxTop);
      const expanded = await probe('state()');
      assert.equal(expanded.rows, 101);
      assert.equal(expanded.calls, 0, 'cached rows expand before IO');
      const latest = await probe('jumpLatest()');
      assert.equal(latest.rows, 61);
      assert.equal(latest.top, latest.maxTop);
      await top(-latest.maxTop);
      const reopened = await probe('state()');
      assert.equal(reopened.rows, 101);
      assert.equal(reopened.calls, 0);
    });
    await t.test('upward wheel into expanded thinking is not reversed by late layout below it', async () => {
      const opened = await probe('openLongThinking()');
      assert.ok(Math.abs(opened.openDrift) <= 1, `disclosure title drifted: ${opened.openDrift}`);
      const point = await probe('wheelPoint()');
      const wheel = deltaY => send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY });
      await wheel(-12);
      const primed = await probe('state()');
      assert.ok(primed.top < opened.top, 'initial wheel should take over the disclosure');
      const after = await probe('moveDuringLateThinkingLayout()');
      assert.ok(after.belowViewport && after.heightDelta >= 250, JSON.stringify(after));
      assert.ok(after.before - after.wheelTop >= 190, JSON.stringify(after));
      assert.ok(Math.abs(after.finalTop - after.wheelTop) <= 1, `late layout reversed the wheel: ${JSON.stringify(after)}`);
      await wheel(-80);
      assert.ok((await probe('state()')).top < after.finalTop, 'native scrolling still works inside the open reasoning');
    });
    await t.test('ordinary upward navigation keeps the latest rows in a folded long conversation', async () => {
      for (const action of ['top', 'minimap']) {
        const before = await probe(`openFoldedHistory("folded-${action}")`);
        assert.equal(before.calls.length, 0, 'opening does not load history');
        assert.equal(before.latestAnswer, true, 'opening shows the latest answer');
        await probe(`click("${action}")`);
        const page = await probe('foldedHistoryResult()');
        assert.deepEqual(page.calls, ['raw-page'], `ordinary ${action} must not jump to the first prompt`);
        assert.equal(page.rows, 200);
        assert.equal(page.latestAnswer, true);
        assert.equal(page.later, false);
        if (action === 'top') {
          for (let pages = 2; pages <= 8; pages++) {
            await probe('click("top")');
            const older = await probe(`foldedHistoryResult(${pages})`);
            assert.deepEqual(older.calls, Array(pages).fill('raw-page'));
            assert.equal(older.rows, Math.min(883, 100 * (pages + 1)));
            assert.equal(older.latestAnswer, true);
            assert.equal(older.later, false);
          }
          await probe('jumpLatest()');
          const latest = await probe('foldedHistoryResult(8)');
          assert.equal(latest.latestAnswer, true);
          assert.equal(latest.calls.length, 8, 'latest does not refill released history');
        }
      }
      await probe('openFoldedHistory("open-tool-history")');
      await evaluate(`document.querySelector('.turn-process > button').click()`);
      await probe('state()');
      const point = await probe('wheelPoint()');
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: -10000 });
      const open = await probe('foldedHistoryResult()');
      assert.deepEqual(open.calls, ['raw-page']);
      assert.equal(open.latestAnswer, true);
    });
    await t.test('one upward wheel reveals the preceding readable boundary without replacing the latest answer', async () => {
      for (const [name, target, pages] of [['single-reply', 'earlier-user', 7], ['previous-reply', 'previous-answer', 9]]) {
        const before = await probe(`openFoldedHistory("${name}")`);
        assert.deepEqual(before, { calls: [], latestAnswer: true });
        const point = await probe('wheelPoint()');
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: -10000 });
        const landed = await probe(`foldedHistoryResult(1, "${target}")`);
        assert.equal(landed.promptVisible, true, `${name} did not land on ${target}: ${JSON.stringify(landed)}`);
        assert.equal(landed.latestAnswer, true);
        assert.equal(landed.later, false);
        assert.deepEqual(landed.calls, ['previous-prompt', ...Array(pages - 1).fill('raw-page')]);
        const top = await probe('wheelPoint()');
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...top, deltaX: 0, deltaY: -10000 });
        assert.equal((await probe('state()')).top, 0);
        assert.equal((await probe('foldedHistoryResult()')).calls.length, pages, 'the oldest boundary does not read again');
        await probe('jumpLatest()');
        const latest = await probe('foldedHistoryResult()');
        assert.equal(latest.latestAnswer, true);
        assert.equal(latest.calls.length, pages, 'jumping to latest needs no intervening read');
      }
    });
    await t.test('a bounded search page never presents a partial turn as finished', async () => {
      const expected = { answer: 'The persisted final answer.', phase: 'Finished', elapsed: '12s' };
      for (const [action, calls] of [['later', 2], ['latest', 1]]) {
        assert.deepEqual(await probe(`openBoundedTurn("bounded-${action}")`), {
          phase: 'Outcome unknown', elapsed: null, total: false, actions: false, calls: 1,
        });
        assert.deepEqual(await probe(`finishBoundedTurn("${action}")`), { ...expected, calls });
      }
    });
    await t.test('Edit context previews and saves only the latest turn’s model overlays', async () => {
      const result = await evaluate('exerciseTurnContext()');
      assert.deepEqual({ ...result.confirmed, focus: result.initialFocus }, {
        body: 'Edited final answer', bold: true, disclosure: 'Edited · View original', focus: 'Final answer',
      });
      assert.equal(result.actionCount, 1);
      assert.equal(result.forkCount, 2);
      assert.deepEqual(result.collapsed, { kinds: ['final'], expanded: 'false', label: 'Thinking, intermediate text and tools (4)', focusedFinal: true });
      assert.deepEqual(result.defaults, { kinds: ['final', 'thinking', 'text', 'tool', 'thinking'],
        checked: [true, true, true, true, true], saveDisabled: true, count: 'Included: 5 / Omitted: 0' });
      assert.deepEqual(result.layout, [
        { wraps: false, fits: true, bounded: true, noHorizontalScroll: true },
        { wraps: true, fits: true, bounded: true, noHorizontalScroll: true },
      ]);
      assert.equal(result.noThinking, 'Included: 3 / Omitted: 2');
      assert.equal(result.blankFinalBlocked, true);
      assert.equal(result.finalExclusionAllowed, true);
      assert.deepEqual(result.noThinkingKinds, ['text', 'tool', 'final']);
      assert.deepEqual(result.finalOnly, { count: 'Included: 1 / Omitted: 4', values: ['Original final answer'] });
      assert.equal(result.writesAfterCancel, 0);
      assert.deepEqual(result.invalidArgs, { save: true, preview: true, alert: 'Enter a valid JSON object.' });
      assert.deepEqual(result.preview, [['Edited middle thinking'], ['{"path":"model-only.md"}', 'Edited result'], ['Final thinking'], ['**Edited final answer**']]);
      assert.deepEqual(result.pending, { writes: 1, readOnly: true, cancelDisabled: true });
      assert.deepEqual(result.afterFailure, { text: 'Edited middle text', excluded: true, message: 'This turn or draft exceeds the context editor’s size limit.' });
      const toolOverlay = { version: 1, toolArgs: { path: 'model-only.md' }, toolResultText: 'Edited result' };
      assert.deepEqual(result.windows, [6, 4, 5].map(length => ({ length, override: toolOverlay })));
      assert.deepEqual(result.original, { final: 'Original final answer', tool: 'Read', status: 'success', result: 'Original tool result' });
      assert.equal(result.editedAfterReload, true);
      assert.equal(result.copied, '**Edited final answer**');
      assert.equal(result.originalClosed, true);
      assert.equal(result.revealed, 'Original final answer');
      assert.deepEqual(result.receipt, { middle: 'Original intermediate text', path: 'notes.md', result: 'File content\nOriginal tool result', hasOverlay: false });
      assert.deepEqual(result.historical, { body: 'Edited final answer', closed: true, pencil: false });
      assert.deepEqual(result.reopened, ['**Edited final answer**', 'Edited middle text', 'Edited result']);
      assert.deepEqual(result.excluded, { label: 'Not sent to model', copy: false, originalHidden: true, noProse: true, original: 'Original final answer' });
      assert.equal(result.originalDetails, 'Original intermediate text');
      assert.deepEqual(result.restoration, { count: 'Included: 5 / Omitted: 0', text: 'Original intermediate text', writes: 4 });
      assert.equal(result.clearAfterReload, true);
      assert.equal(result.staleReadStarted, 6);
      assert.equal(result.staleReadIgnored, true);
      assert.equal(result.staleSaveIgnored, true);
      assert.equal(result.busyDisabled, true);
      assert.equal(result.busyWrites, 5);
      await evaluate('openKeyboardEditor()');
      assert.equal(await evaluate('document.activeElement.value'), 'Edited final answer');
      await send('Input.insertText', { text: 'Keyboard draft' });
      const key = async (name, code) => {
        const event = { key: name, code: name, windowsVirtualKeyCode: code };
        await send('Input.dispatchKeyEvent', { ...event, type: 'keyDown' });
        if (name === 'Enter') await send('Input.dispatchKeyEvent', { ...event, type: 'char', text: '\r' });
        await send('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
      };
      for (let tab = 0; tab < 3; ++tab) await key('Tab', 9);
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-expanded")'), 'false');
      await key('Enter', 13);
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-expanded")'), 'true');
      await key('Tab', 9);
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), 'Include: Thinking');
      await key('Escape', 27);
      assert.equal(await evaluate('document.querySelector(".message-bubble[data-message-id=answer] .prose-chat").textContent'), 'Edited final answer');
      if (process.env.PI_TURN_CONTEXT_SCREENSHOT) {
        await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1000, deviceScaleFactor: 1, mobile: false });
        const clip = await evaluate('previewTurnContextEditor()');
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...clip, scale: 1 } });
        await writeFile(process.env.PI_TURN_CONTEXT_SCREENSHOT, Buffer.from(shot.data, 'base64'));
      }
      assert.deepEqual(result.errors, []);
      const target = { sessionId: 'context-edit', anchorMessageId: 'answer' };
      assert.deepEqual(result.reads, Array.from({ length: 7 }, () => target));
      const update = { ...target, expectedRevision: '0', edits: [
        { messageId: 'middle', contextOverride: { version: 1, thinking: 'Edited middle thinking', content: 'Edited middle text', excludeContent: true } },
        { messageId: 'tool', contextOverride: toolOverlay },
        { messageId: 'answer', contextOverride: { version: 1, content: '**Edited final answer**' } },
      ] };
      assert.deepEqual(result.writes, [update, update,
        { ...target, expectedRevision: '1', edits: [{ messageId: 'tool', contextOverride: null }] },
        { ...target, expectedRevision: '2', edits: [{ messageId: 'answer', contextOverride: { version: 1, content: '', excludeContent: true } }] },
        { ...target, expectedRevision: '3', edits: [], restore: true },
        { ...target, expectedRevision: '4', edits: [{ messageId: 'answer', contextOverride: { version: 1, content: 'Edited final answer' } }] },
      ]);
    });
  } finally {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ id: 99999, method: 'Browser.close' }));
      socket.close();
    } else stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
