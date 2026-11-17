import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildHistoryFixture } from "./fixtures/delegation-history-build.mjs";

const browser = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/chromium"].find(existsSync);
test("group headers and creation menu interactions", { timeout: 30000, skip: !browser && "Chromium unavailable" }, async () => {
  const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "group-header-"));
  const profile = join(dir, "profile");
  let server, socket, child;
  try {
    await buildHistoryFixture(dir, "session-group-header.jsx");
    await writeFile(join(dir, "index.html"), '<!doctype html><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await mkdir(profile);
    server = createServer(async (req, res) => {
      const name = req.url === "/" ? "index.html" : req.url.slice(1);
      if (!["index.html", "renderer.js", "renderer.css"].includes(name)) { res.writeHead(404).end(); return; }
      res.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html");
      res.end(await readFile(join(dir, name)));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { watcher.close(); reject(Error("browser startup timeout")); }, 8000);
      const watcher = watch(profile, async (_event, file) => {
        if (String(file) !== "DevToolsActivePort") return;
        try { const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/); if (!path) return; clearTimeout(timer); watcher.close(); resolve(`ws://127.0.0.1:${port}${path}`); } catch (error) { if (error.code !== "ENOENT") reject(error); }
      });
    });
    const args = ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"];
    if (process.platform === "win32") {
      const command = [browser, ...args].map(part => `"${part}"`).join(" ");
      const ps = `$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${command.replaceAll("'", "''")}'}; if ($r.ReturnValue -ne 0) { throw 'WMI launch failed' }; $r.ProcessId`;
      child = { pid: Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" }).trim()) };
    } else child = spawn(browser, args, { stdio: "ignore" });
    socket = new WebSocket(await ready);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    let id = 0; const pending = new Map();
    socket.addEventListener("message", ({ data }) => { const msg = JSON.parse(String(data)); if (pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(Error(JSON.stringify(msg.error))) : p.resolve(msg.result); } });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params, sessionId })); });
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    const loaded = new Promise(resolve => {
      const listener = ({ data }) => { const message = JSON.parse(String(data)); if (message.method === "Page.loadEventFired" && message.sessionId === sessionId) { socket.removeEventListener("message", listener); resolve(); } };
      socket.addEventListener("message", listener);
    });
    await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` }, sessionId);
    await loaded;
    const evaluate = async expression => { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
    const point = await evaluate(`(async () => {
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      const selector = '[data-sidebar-session-group="a"] .sidebar-session-group-add';
      for (let i = 0; i < 120 && !document.querySelector(selector); i++) await frame();
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point }, sessionId);
    assert.deepEqual(await evaluate("window.created"), ["a"], "clicking the visible group + creates in that group");
    const result = await evaluate(`(async () => {
      const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const assert = (condition, message) => { if (!condition) throw Error(message); };
      const header = document.querySelector('[data-sidebar-session-group="a"]');
      assert(header.querySelector('[role=img]').getAttribute('aria-label') === '2 running · 2 total', 'full group summary');
      assert(!header.querySelector('button button'), 'nested button');
      header.querySelector('.sidebar-conversation-group-title').click(); await frame();
      assert(header.querySelector('[data-sessions]').textContent === '1', 'visible page');
      assert(document.querySelector('[aria-label="Disabled create"]').disabled, 'disabled trigger');
      document.querySelector('[aria-label="Create directly"]').click();
      assert(window.created[1] === null, 'direct create');
      const trigger = document.querySelector('[aria-label="Create project task"]'); trigger.click(); await frame();
      let items = [...document.querySelectorAll('[role=menuitem]')];
      assert(items.map(item => item.textContent).join(',') === 'Alpha,Beta,Ungrouped', 'menu order');
      for (let i = 0; i < 20 && document.activeElement !== items[0]; i++) await frame();
      assert(document.activeElement === items[0], 'initial focus');
      items[0].dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown',bubbles:true}));
      assert(document.activeElement === items[1], 'arrow navigation'); items[1].click(); await frame();
      assert(window.created[2] === 'b' && !document.querySelector('[role=menu]'), 'selection and close');
      trigger.click(); await frame(); window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); await frame();
      assert(!document.querySelector('[role=menu]') && document.activeElement === trigger, 'escape and focus restore');
      trigger.click(); await frame(); document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); await frame();
      assert(!document.querySelector('[role=menu]'), 'outside close');
      trigger.click(); await frame(); [...document.querySelectorAll('[role=menuitem]')].at(-1).click(); await frame();
      assert(window.created[3] === null, 'ungrouped menu selection');
      document.querySelector('[data-sidebar-session-group=""] .sidebar-session-group-add').click();
      assert(window.created[4] === null, 'ungrouped header creation'); return 'ok';
    })()`);
    assert.equal(result, "ok");
  } finally {
    if (socket?.readyState === WebSocket.OPEN) { const id = 99999; socket.send(JSON.stringify({ id, method: "Browser.close" })); socket.close(); }
    else if (child?.pid && process.platform === "win32") execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}'; if ($p -and $p.CommandLine.Contains('${profile.replaceAll("'", "''")}')) { Invoke-CimMethod -InputObject $p -MethodName Terminate | Out-Null }`]);
    else child?.kill();
    if (server) await new Promise(resolve => server.close(resolve));
    if (process.platform !== "win32") await rm(dir, { recursive: true, force: true });
  }
});
