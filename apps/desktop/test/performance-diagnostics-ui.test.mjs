import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildHistoryFixture } from "./fixtures/delegation-history-build.mjs";

const browser = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
function endpoint(profile) {
  return new Promise((resolve, reject) => {
    const watcher = watch(profile, (_event, file) => { if (String(file) === "DevToolsActivePort") void read(); });
    const timer = setTimeout(() => { watcher.close(); reject(Error("Fixture browser startup timed out")); }, 8000);
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
function connect(url) {
  const socket = new WebSocket(url); let id = 0; const pending = new Map(), events = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.id) { const handler = pending.get(message.id); if (!handler) return; pending.delete(message.id); message.error ? handler.reject(Error(JSON.stringify(message.error))) : handler.resolve(message.result); }
    else for (const handler of events.get(message.method) ?? []) handler(message.params);
  });
  socket.addEventListener("close", () => { for (const handler of pending.values()) handler.reject(Error("Fixture browser closed")); pending.clear(); });
  return {
    ready: new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); }),
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params, sessionId })); }),
    once: method => new Promise(resolve => { const listeners = events.get(method) ?? new Set(); const listener = params => { listeners.delete(listener); resolve(params); }; listeners.add(listener); events.set(method, listeners); }),
    close: () => socket.close(),
  };
}

test("developer Info performance diagnostics: offline actions, lifecycle and responsive access", {
  timeout: 30000, skip: browser ? false : "No existing Chromium browser; no dependencies installed.",
}, async () => {
  const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "performance-diagnostics-ui-"));
  const profile = join(directory, "profile"); let server, launched, cdp;
  console.log(`PERFORMANCE_FIXTURE_ARTIFACTS ${directory}`);
  try {
    await buildHistoryFixture(directory, "performance-diagnostics.jsx");
    await writeFile(join(directory, "index.html"), await readFile(new URL("./fixtures/performance-diagnostics.html", import.meta.url)));
    await appendFile(join(directory, "renderer.css"), "\nhtml, body, #root { margin: 0; height: 100%; } #root { overflow-y: auto; } .fixture-page { box-sizing: border-box; width: 100%; max-width: 800px; margin: 0 auto; padding: 16px; }\n");
    await mkdir(profile);
    server = createServer(async (request, response) => {
      const path = new URL(request.url, "http://127.0.0.1").pathname;
      const file = { "/": ["index.html", "text/html"], "/renderer.js": ["renderer.js", "text/javascript"], "/renderer.css": ["renderer.css", "text/css"] }[path];
      if (!file) { response.writeHead(404).end(); return; }
      response.setHeader("Content-Type", file[1]); response.end(await readFile(join(directory, file[0])));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const ready = endpoint(profile);
    const args = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"];
    if (process.platform === "win32") {
      const command = [browser, ...args].map(part => `"${part}"`).join(" ");
      const ps = `$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${command.replaceAll("'", "''")}'}; if ($r.ReturnValue -ne 0) { throw 'WMI fixture launch failed' }; $r.ProcessId`;
      launched = { pid: Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" }).trim()) };
      assert.ok(launched.pid > 0);
    } else launched = spawn(browser, args, { stdio: "ignore" });
    cdp = connect(await ready); await cdp.ready;
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    await send("Page.enable"); await send("Runtime.enable"); await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
    const loaded = cdp.once("Page.loadEventFired"); await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` }); await loaded;
    const evaluate = async expression => { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
    assert.equal(await evaluate("window.performanceFixtureReady"), true, "synthetic fixture did not load");
    for (const stage of ["gate", "error-and-retry", "record-and-save", "poll-visibility", "stale-navigation", "recording-revisit", "queued-action", "hidden-inflight"]) {
      console.log(`PERFORMANCE_STAGE ${stage}`);
      assert.deepEqual(await evaluate(`window.performanceProbe(${JSON.stringify(stage)})`), { stage, passed: true });
    }
    for (const [width, theme, language] of [[1100, "light", "en"], [360, "light", "zh-CN"], [360, "dark", "zh-TW"], [800, "dark", "en"]]) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      console.log("PERFORMANCE_LAYOUT", await evaluate(`window.performanceLayout(${JSON.stringify(theme)}, ${JSON.stringify(language)})`));
      await evaluate("document.querySelector('.performance-content').scrollIntoView({ block: 'start' })");
      const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      await writeFile(join(directory, `${width}-${theme}-${language}.png`), Buffer.from(screenshot.data, "base64"));
    }
    await evaluate("[...document.querySelectorAll('.performance-actions button')].at(-1).focus()");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    const focus = await evaluate("({ tag: document.activeElement.tagName, visible: document.activeElement.matches(':focus-visible'), outline: getComputedStyle(document.activeElement).outlineStyle })");
    assert.deepEqual(focus, { tag: "PRE", visible: true, outline: "solid" }, "Keyboard must reach a visibly focused read-only preview");
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    assert.equal(await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches && getComputedStyle(document.querySelector('.performance-content')).animationName === 'none'"), true);
    console.log("PERFORMANCE_STAGE keyboard-and-reduced-motion passed");
    assert.deepEqual(await evaluate("window.performanceProbe('disable-developer')"), { stage: "disable-developer", passed: true });
    console.log("PERFORMANCE_STAGE disable-developer passed");
  } finally {
    if (cdp) { try { await cdp.send("Browser.close"); } catch { /* Owned fixture browser is closing. */ } cdp.close(); }
    else if (launched?.pid) {
      if (process.platform === "win32") execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${launched.pid}'; if ($p -and $p.CommandLine.Contains('${profile.replaceAll("'", "''")}')) { Invoke-CimMethod -InputObject $p -MethodName Terminate | Out-Null }`]);
      else launched.kill();
    }
    if (server) await new Promise(resolve => server.close(resolve));
    if (process.platform !== "win32") await rm(directory, { recursive: true, force: true });
  }
});
