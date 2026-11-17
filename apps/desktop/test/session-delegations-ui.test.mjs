import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildHistoryFixture } from "./fixtures/delegation-history-build.mjs";

const browser = process.env.PI_DELEGATION_BROWSER || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
async function endpoint(profile) {
  return new Promise((resolve, reject) => {
    const watcher = watch(profile, (_event, file) => { if (String(file) === "DevToolsActivePort") void read(); });
    const timer = setTimeout(() => { watcher.close(); reject(Error("Fixture browser did not become ready within 8s")); }, 8000);
    async function read() {
      try {
        const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
        if (!port || !path) return;
        clearTimeout(timer); watcher.close(); resolve(`ws://127.0.0.1:${port}${path}`);
      } catch (error) { if (error.code !== "ENOENT") { clearTimeout(timer); watcher.close(); reject(error); } }
    }
    void read();
  });
}
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let id = 0;
  const pending = new Map(), events = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.id) {
      const handler = pending.get(message.id); if (!handler) return;
      pending.delete(message.id);
      if (message.error) handler.reject(Error(JSON.stringify(message.error))); else handler.resolve(message.result);
    } else { for (const handler of events.get(message.method) ?? []) handler(message.params); }
  });
  socket.addEventListener("close", () => { for (const handler of pending.values()) handler.reject(Error("Fixture browser closed")); pending.clear(); });
  return {
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params, sessionId })); }),
    once: method => new Promise(resolve => { const handlers = events.get(method) ?? new Set(); const done = params => { handlers.delete(done); resolve(params); }; handlers.add(done); events.set(method, handlers); }),
    close: () => socket.close(),
  };
}

test("session subagents: keyboard entry, scoped history, detail controls, switching and narrow themes", {
  timeout: 30_000, skip: browser ? false : "No existing Chromium browser; no dependencies are installed.",
}, async () => {
  const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "session-delegations-ui-"));
  const profile = join(directory, "profile");
  let cdp, server, launched;
  console.log(`SESSION_DELEGATIONS_ARTIFACTS ${directory}`);
  try {
    await buildHistoryFixture(directory, "session-delegations.jsx");
    await writeFile(join(directory, "index.html"), '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.js"></script></html>');
    await appendFile(join(directory, "renderer.css"), `
      html, body, #root { height: 100%; margin: 0; }
      .fixture-shell { display: flex; height: 100%; background: var(--ds-bg-primary); }
      .fixture-main { position: relative; min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; }
      .fixture-chat { overflow: auto; min-height: 0; margin-top: 48px; flex: 1; padding: 20px; }
      .fixture-panel { flex: 0 0 360px; min-width: 0; min-height: 0; overflow: hidden; border-left: 1px solid var(--ds-border); }
      .fixture-panel > .subagent-transcript-tab { height: 100%; }
      @media (max-width: 720px) { .fixture-shell { flex-direction: column; } .fixture-main { flex: 0 0 180px; } .fixture-panel { flex: 1; min-height: 0; } }
    `);
    await mkdir(profile);
    server = createServer(async (request, response) => {
      const path = new URL(request.url, "http://127.0.0.1").pathname;
      const file = { "/": ["index.html", "text/html"], "/renderer.js": ["renderer.js", "text/javascript"], "/renderer.css": ["renderer.css", "text/css"] }[path];
      if (!file) { response.writeHead(404); response.end(); return; }
      response.setHeader("Content-Type", file[1]); response.end(await readFile(join(directory, file[0])));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const ready = endpoint(profile);
    const args = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"];
    if (process.platform === "win32") {
      const command = [browser, ...args].map(part => `"${part}"`).join(" ");
      const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${command.replaceAll("'", "''")}'}; if ($r.ReturnValue -ne 0) { throw 'WMI fixture launch failed' }; $r.ProcessId`;
      launched = { pid: Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" }).trim()) };
      assert.ok(launched.pid > 0);
    } else launched = spawn(browser, args, { stdio: "ignore" });
    cdp = await connect(await ready);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    await send("Page.enable"); await send("Runtime.enable");
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const evaluate = async expression => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    const loaded = cdp.once("Page.loadEventFired");
    await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` }); await loaded;
    assert.equal(await evaluate("window.fixtureReady"), true);
    console.log("SESSION_DELEGATIONS_STAGE keyboard");
    await evaluate("window.sessionDelegationsProbe('prepare')");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await send("Input.dispatchKeyEvent", { type: "char", text: "\r", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    console.log("SESSION_DELEGATIONS_STAGE navigation");
    assert.deepEqual(await evaluate("window.sessionDelegationsProbe('navigate')"), { stage: "navigate", passed: true });
    for (const [width, theme, language] of [[1280, "light", "en"], [1280, "light", "zh-CN"], [1280, "dark", "zh-CN"], [800, "dark", "en"], [360, "light", "zh-CN"], [360, "dark", "de"]]) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
      console.log("SESSION_DELEGATIONS_LAYOUT", await evaluate(`window.sessionDelegationsLayout('${theme}', '${language}')`));
      const screenshot = await send("Page.captureScreenshot", { format: "png" });
      await writeFile(join(directory, `${width}-${theme}-${language}.png`), Buffer.from(screenshot.data, "base64"));
    }
  } finally {
    if (cdp) { try { await cdp.send("Browser.close"); } catch { /* The owned browser closes its transport. */ } cdp.close(); }
    else if (launched?.pid) {
      if (process.platform === "win32") execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${launched.pid}'; if ($p -and $p.CommandLine.Contains('${profile.replaceAll("'", "''")}')) { Invoke-CimMethod -InputObject $p -MethodName Terminate | Out-Null }`]);
      else launched.kill();
    }
    if (server) await new Promise(resolve => server.close(resolve));
    if (process.platform !== "win32") await rm(directory, { recursive: true, force: true });
  }
});
