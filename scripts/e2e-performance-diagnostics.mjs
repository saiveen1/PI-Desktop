#!/usr/bin/env node
/** Real Electron/preload + production recorder; no Desktop startup, network, Host DB or daily profile. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const source = join(root, "apps/desktop");
const runFile = promisify(execFile);

export async function runFixture(dir) {
  const { app, BrowserWindow, ipcMain } = await import("electron");
  app.setPath("userData", join(dir, "profile"));
  register(pathToFileURL(join(source, "test/helpers/ts-import-hooks.mjs")));
  const { registerDesktopPerformance } = await import(pathToFileURL(join(source, "electron/main/performance/desktop-performance.ts")));
  const children = [];
  const watchdog = setTimeout(() => { for (const child of children) child.stdin.end(); app.exit(2); }, 18_000);
  try {
    await app.whenReady();
    // Their executables are synthetic; attribution uses owned handles, not process names.
    for (let i = 0; i < 2; i++) {
      const child = spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdout.write('ready');"], {
        env: { ELECTRON_RUN_AS_NODE: "1", SystemRoot: process.env.SystemRoot }, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
      });
      children.push(child); await once(child.stdout, "data");
    }
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, preload: join(source, "out/preload/index.cjs") } });
    const page = async partition => {
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, partition } });
      await win.loadURL("data:text/plain,fixture"); return win;
    };
    const guest = await page("fixture-guest"), panel = await page("fixture-plugin");
    let mode = false;
    const clear = registerDesktopPerformance({ isDeveloperMode: () => mode, getMainWindow: () => window,
      getHostPid: () => children[0].pid, getAgentPid: () => children[1].pid, getBrowserPids: () => [guest.webContents.getOSProcessId()],
      pluginForContents: id => id === panel.webContents.id ? "fixture.plugin" : null,
      getPluginProcessOwners: () => new Map(), registrar: {
        assertMainWindowSender(event) { assert.equal(event.sender, window.webContents); },
        handleWithEvent(channel, handler) { ipcMain.handle(channel, async (e, ...args) => {
          try { return { ok: true, data: await handler(e, ...args) }; }
          catch (error) { return { ok: false, error: { message: String(error.message) } }; }
        }); },
      } });
    await window.loadFile(join(dir, "page.html"));
    assert.equal(await window.webContents.executeJavaScript("window.denied()"), true);
    mode = true;
    const report = JSON.parse(await window.webContents.executeJavaScript("window.captureFixture()"));
    assert.equal(report.endReason, "stopped"); assert.ok(report.processes.length >= 2);
    assert.ok(report.ui.some(p => p.toolOpens === 1 && p.stages["markdown-split"]?.count === 1));
    for (const [role, pid] of [["main", process.pid], ["mainRenderer", window.webContents.getOSProcessId()], ["host", children[0].pid], ["agent", children[1].pid],
      ["browser", guest.webContents.getOSProcessId()], ["plugin", panel.webContents.getOSProcessId()]]) {
      const rows = report.processes.flatMap(s => s.processes.filter(r => r.role === role && r.pid === pid));
      assert.ok(rows.length >= 2, `${role} attribution`); assert.equal(rows[0].cpuPercent, null);
      if (role === "plugin") assert.equal(rows[0].owner, "fixture.plugin");
      if (process.platform === "win32") {
        assert.ok(rows.some(r => r.workingSetKiB > 0 && r.privateKiB > 0 && r.startedAt > 0), `${role} native memory and birth`);
        assert.ok(rows.some(r => typeof r.cpuPercent === "number" && r.cpuPercent >= 0 && r.cpuPercent <= 100), `${role} interval CPU`);
      }
    }
    mode = false; clear(); assert.equal(await window.webContents.executeJavaScript("window.denied()"), true);
    await writeFile(join(dir, "result.json"), JSON.stringify({ ok: true, samples: report.processes.length, pulses: report.ui.length }));
  } catch (error) {
    await writeFile(join(dir, "result.json"), JSON.stringify({ ok: false, message: String(error?.stack ?? error) }));
  } finally {
    for (const child of children) child.stdin.end();
    clearTimeout(watchdog); app.exit();
  }
}

const renderer = `
import { api } from './lib/api';
import { installPerformanceUiProbe, recordPerformanceToolOpen } from './lib/performance-ui-probe';
import { beginRenderDiagnostic } from './lib/render-diagnostics';
window.denied = async () => { try { await api.performanceDiagnostics('snapshot'); return false; } catch (e) { return /developer mode/.test(e.message); } };
window.captureFixture = async () => {
  let pulses = 0, ready; const thirdPulse = new Promise(r => { ready = r; });
  const dispose = installPerformanceUiProbe({ onCapture(cb) { return api.onPerformanceCapture(value => {
    cb(value); if (value) { const end = beginRenderDiagnostic('markdown-split'); end(); recordPerformanceToolOpen(); }
  }); }, sendPulse: async p => { await api.sendPerformancePulse(p); if (++pulses === 3) ready(); },
  getState: () => ({ settings: { developerMode: true } }), subscribeState: () => () => {}, document });
  try { const { id } = await api.performanceDiagnostics('start'); await thirdPulse;
    await api.performanceDiagnostics('mark', id); await api.performanceDiagnostics('stop', id);
    return await api.previewPerformanceReport(id);
  } finally { dispose(); }
};`;

if (!process.versions.electron) {
  const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-performance-electron-"));
  const binary = resolveElectronBinary(root).electronBinary;
  const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
  try {
    await mkdir(join(dir, "profile"));
    await build({ stdin: { contents: renderer, resolveDir: join(source, "src"), loader: "ts" }, bundle: true,
      outfile: join(dir, "probe.js"), format: "iife", platform: "browser", define: { "import.meta.env": '{"DEV":false,"MODE":"production"}', "process.env.NODE_ENV": '"production"' } });
    await writeFile(join(dir, "main.mjs"), `import {runFixture} from ${JSON.stringify(import.meta.url)}; void runFixture(${JSON.stringify(dir)}).catch(async e => { const fs = await import('node:fs/promises'); await fs.writeFile(${JSON.stringify(join(dir, "result.json"))}, JSON.stringify({ok:false,message:String(e.stack || e)})); const {app} = await import('electron'); app.exit(1); });`);
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "pi-performance-fixture", version: "1.0.0", type: "module", main: "main.mjs" }));
    await writeFile(join(dir, "page.html"), '<!doctype html><meta charset="utf-8"><script src="probe.js"></script>');
    console.log("Electron fixture: production bridge and synthetic child processes");
    if (process.platform === "win32") {
      const commandLine = [binary, `--user-data-dir=${join(dir, "profile")}`, dir].map(s => `"${s}"`).join(" ").replaceAll("'", "''");
      const ps = `$ErrorActionPreference='Stop'; $r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${commandLine}'}; if($r.ReturnValue -ne 0){throw 'WMI fixture launch failed'}; $p=Get-Process -Id $r.ProcessId -ErrorAction SilentlyContinue; if($p -and !$p.WaitForExit(22000)){throw 'Fixture deadline'}`;
      await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 25_000 });
    } else {
      const env = { ...process.env }; delete env.PI_DESKTOP_DATA_DIR; delete env.ELECTRON_RUN_AS_NODE;
      await runFile(binary, [`--user-data-dir=${join(dir, "profile")}`, dir], { env, timeout: 22_000 });
    }
    const result = JSON.parse(await readFile(join(dir, "result.json"), "utf8"));
    assert.ok(result.ok, result.message); console.log("Performance diagnostics verified:", result);
    await rm(dir, { recursive: true, force: true });
  } catch (error) { console.error("Isolated fixture artifacts:", dir); throw error; }
}
