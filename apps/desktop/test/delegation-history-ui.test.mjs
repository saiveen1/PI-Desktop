import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildHistoryFixture } from "./fixtures/delegation-history-build.mjs";

const browser = process.env.PI_DELEGATION_BROWSER || [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
].find(existsSync);

async function debuggingEndpoint(profile) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const watcher = watch(profile, async (_event, file) => {
      if (String(file) === "DevToolsActivePort") await read();
    });
    const timeout = setTimeout(() => { watcher.close(); reject(new Error("Isolated browser did not publish DevToolsActivePort within 8s")); }, 8000);
    async function read() {
      try {
        const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
        if (finished || !port || !path) return;
        finished = true; watcher.close(); clearTimeout(timeout); resolve(`ws://127.0.0.1:${port}${path}`);
      } catch (error) { if (error.code !== "ENOENT") { watcher.close(); clearTimeout(timeout); reject(error); } }
    }
    void read();
  });
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  const events = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.id) {
      const handler = pending.get(message.id); if (!handler) return;
      pending.delete(message.id);
      if (message.error) handler.reject(new Error(JSON.stringify(message.error))); else handler.resolve(message.result);
    } else if (message.method) {
      for (const handler of events.get(message.method) ?? []) handler(message.params);
    }
  });
  socket.addEventListener("close", () => { for (const handler of pending.values()) handler.reject(new Error("Fixture browser connection closed")); pending.clear(); });
  return {
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }),
    once: (method) => new Promise((resolve) => { const handlers = events.get(method) ?? new Set(); const done = (params) => { handlers.delete(done); resolve(params); }; handlers.add(done); events.set(method, handlers); }),
    close: () => socket.close(),
  };
}

function launchBrowser(profile) {
  const args = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"];
  if (process.platform === "win32") {
    // Only this isolated browser is created; no installed Desktop is launched.
    const command = [browser, ...args].map((part) => `"${part}"`).join(" ");
    const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${command.replaceAll("'", "''")}'}; if ($r.ReturnValue -ne 0) { throw \"WMI browser launch failed: $($r.ReturnValue)\" }; $r.ProcessId`;
    const pid = Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" }).trim());
    assert.ok(pid > 0, "WMI must return the owned fixture browser PID");
    return { pid };
  }
  return spawn(browser, args, { stdio: "ignore" });
}

test("global delegation history production dialog user path", {
  timeout: 30_000,
  skip: browser ? false : "No existing Chromium browser. Set PI_DELEGATION_BROWSER; no dependency is installed by this test.",
}, async () => {
  const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "delegation-history-ui-"));
  const profile = join(directory, "profile");
  let cdp;
  let server;
  let launched;
  try {
    await buildHistoryFixture(directory); await mkdir(profile);
    server = createServer(async (request, response) => {
      const name = new URL(request.url, "http://127.0.0.1").pathname;
      const files = { "/": ["index.html", "text/html"], "/renderer.js": ["renderer.js", "text/javascript"], "/renderer.css": ["renderer.css", "text/css"] };
      const file = files[name]; if (!file) { response.writeHead(404); response.end(); return; }
      response.setHeader("Content-Type", file[1]); response.end(await readFile(join(directory, file[0])));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = debuggingEndpoint(profile); launched = launchBrowser(profile); cdp = await connect(await endpoint);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    await send("Runtime.enable"); await send("Page.enable");
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const loaded = cdp.once("Page.loadEventFired");
    await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` }); await loaded;
    assert.equal(await evaluate("window.fixtureReady"), true, "Fixture must mount real component/hook before probes");
    assert.deepEqual(await evaluate("window.historyProbe()"), { stale: true, pagination: true, source: true, approval: true, focus: true });
    const dark = await evaluate("window.historyLayoutProbe('dark')");
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 640, deviceScaleFactor: 1, mobile: false });
    const light = await evaluate("window.historyLayoutProbe('light')");
    assert.notEqual(dark, light, "Theme tokens must change the dialog surface");
    const closePoint = await evaluate("window.historyPointerProbeStart()");
    assert.equal(closePoint.hitClose, true, "Close button must receive pointer events through the portal host");
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: closePoint.x, y: closePoint.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: closePoint.x, y: closePoint.y, button: "left", clickCount: 1 });
    assert.equal(await evaluate("window.historyPointerProbeEnd()"), true);
  } finally {
    if (cdp) { try { await cdp.send("Browser.close"); } catch { /* Closing the owned browser closes its socket. */ } cdp.close(); }
    else if (launched?.pid) {
      // Only the just-created, scratch-profile browser is eligible for cleanup.
      if (process.platform === "win32") execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${launched.pid}'; if ($p -and $p.CommandLine.Contains('${profile.replaceAll("'", "''")}')) { Invoke-CimMethod -InputObject $p -MethodName Terminate | Out-Null }`]);
      else launched.kill();
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    // Chromium can hold profile files briefly while its acknowledged shutdown completes.
    // Keep isolated scratch artifacts on Windows rather than racing profile deletion.
    if (process.platform !== "win32") await rm(directory, { recursive: true, force: true });
  }
});
