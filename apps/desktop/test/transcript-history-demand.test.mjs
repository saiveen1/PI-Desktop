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
      const contents = await readFile(file, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; });
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

test('transcript history demand and inline reply editing', { timeout: 30000, skip: !browser && 'Standalone Chromium unavailable' }, async t => {
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
    await t.test('Edit reply saves each thinking choice explicitly, including unchanged text', async () => {
      const result = await evaluate('exerciseReplyEdit()');
      const original = '  **Final reply**\n';
      const corrected = '  **Corrected reply**\n';
      assert.equal(result.actionCount, 1);
      assert.equal(result.source, original);
      assert.equal(result.focused, true);
      assert.equal(result.unchangedCanSave, true);
      assert.deepEqual(result.dropdown, { value: 'reply', label: 'Thinking context',
        options: [['reply', "Exclude only the final answer's thinking"], ['turn', 'Exclude all thinking used for this answer'], ['keep', 'Keep all thinking used for this answer']],
        hint: 'Only this answer; earlier turns and saved thinking are unchanged.' });
      assert.deepEqual(result.layout, [
        { wrapped: false, right: true, left: true, fits: true },
        { wrapped: true, right: true, left: true, fits: true },
      ]);
      assert.deepEqual(result.afterCancel, { writes: 0, content: original });
      assert.equal(result.beforeExplicitSave, 1);
      assert.deepEqual(result.pending, { writes: 2, readOnly: true, cancelDisabled: true, saveDisabled: true });
      assert.deepEqual(result.afterFailure, { text: corrected, mode: 'turn', enabled: true });
      assert.deepEqual(result.errors, ['Reply changed']);
      const write = { sessionId: 'reply-edit', messageId: 'answer', expectedContent: original, content: corrected, thinkingContext: 'turn' };
      assert.deepEqual(result.writes, [
        { ...write, content: original, thinkingContext: 'reply' }, write, write,
        { ...write, expectedContent: corrected, thinkingContext: 'keep' },
      ]);
      assert.deepEqual(result.ids, ['older-prompt', 'older-answer', 'prompt', 'narration', 'tool', 'answer']);
      if (process.env.PI_REPLY_EDITOR_SCREENSHOT) {
        await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
        const clip = await evaluate('previewReplyEditor()');
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...clip, scale: 1 } });
        await writeFile(process.env.PI_REPLY_EDITOR_SCREENSHOT, Buffer.from(shot.data, 'base64'));
      }
    });
  } finally {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ id: 99999, method: 'Browser.close' }));
      socket.close();
    } else stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
