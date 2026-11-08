import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

async function waitForExitFile(directory, budgetMs) {
  return new Promise((resolve, reject) => {
    let reading = false;
    const watcher = watch(directory, (_event, file) => { if (String(file) === "exit-code.txt") void read(); });
    const timer = setTimeout(() => { watcher.close(); reject(new Error(`Isolated session fixture did not exit within ${budgetMs}ms`)); }, budgetMs);
    async function read() {
      if (reading) return;
      reading = true;
      try {
        const value = (await readFile(join(directory, "exit-code.txt"), "utf8")).trim();
        if (!value) { reading = false; return; }
        clearTimeout(timer); watcher.close(); resolve(Number(value));
      } catch (error) {
        reading = false;
        if (error.code !== "ENOENT") { clearTimeout(timer); watcher.close(); reject(error); }
      }
    }
    void read();
  });
}

async function runSessionFixture(labelsOnly) {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "session-organization-"));
  let child;
  let wmiPid;
  let completed = false;
  try {
    await build({
      entryPoints: [join(root, "apps/desktop/test/fixtures/session-organization.jsx")],
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      loader: { ".png": "dataurl", ".svg": "dataurl" },
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "renderer.css"), (await readFile(join(temp, "renderer.css"), "utf8")).replace(/@theme(?: inline)?\s*\{/g, ":root {"));
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root" style="width:300px"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (_event, ...args) => console.log("RENDERER", ...args));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    if (${labelsOnly}) {
      const grouping = await win.webContents.executeJavaScript("window.sidebarLabelGroupingProbe().catch(error => { console.error(error.stack); throw error; })");
      console.log("LABEL_GROUPING_PROBE " + JSON.stringify(grouping));
    } else {
      const result = await win.webContents.executeJavaScript("window.organizationProbe().catch(error => { console.error(error.stack); throw error; })");
      console.log("ORGANIZATION_PROBE " + JSON.stringify(result));
    }
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const electron = resolveElectronBinary(root).electronBinary;
    let output = "";
    let code;
    if (process.platform === "win32") {
      const native = value => value.replaceAll("/", "\\");
      const launch = join(temp, "launch.cmd");
      await writeFile(launch, `@echo off\r\nset ELECTRON_RUN_AS_NODE=\r\nset PI_DESKTOP_DATA_DIR=\r\n"${native(electron)}" "${native(join(temp, "main.cjs"))}" >"${native(join(temp, "browser.log"))}" 2>&1\r\necho %ERRORLEVEL% >"${native(join(temp, "exit-code.txt"))}"\r\n`);
      const command = `cmd.exe /d /c ""${native(launch)}""`;
      const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${command.replaceAll("'", "''")}'}; if ($r.ReturnValue -ne 0) { throw 'Isolated fixture WMI launch failed' }; $r.ProcessId`;
      wmiPid = Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" }).trim());
      assert.ok(wmiPid > 0, "WMI must return the owned fixture PID");
      console.log("SESSION_FIXTURE_WMI " + JSON.stringify({ pid: wmiPid, directory: temp }));
      try { code = await waitForExitFile(temp, labelsOnly ? 10_000 : 25_000); }
      finally { output = await readFile(join(temp, "browser.log"), "utf8").catch(() => "No browser log produced"); console.log(output.slice(-12000)); }
    } else {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.PI_DESKTOP_DATA_DIR;
      child = spawn(electron, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8"); stream.on("data", chunk => { output += chunk; process.stdout.write(chunk); });
      }
      const timer = setTimeout(() => child.kill(), labelsOnly ? 10_000 : 25_000);
      try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
      finally { clearTimeout(timer); }
    }
    completed = true;
    assert.equal(code, 0, output.slice(-8000));
    if (labelsOnly) {
      const grouping = output.split(/\r?\n/).find(line => line.startsWith("LABEL_GROUPING_PROBE "));
      assert.ok(grouping, output.slice(-8000));
      assert.deepEqual(JSON.parse(grouping.slice("LABEL_GROUPING_PROBE ".length)), { passed: true, uniqueRows: 1, uniqueSelected: 14, layouts: 6 });
    } else {
      const line = output.split(/\r?\n/).find(item => item.startsWith("ORGANIZATION_PROBE "));
      assert.ok(line, output.slice(-8000));
      assert.deepEqual(JSON.parse(line.slice("ORGANIZATION_PROBE ".length)), { passed: true, locales: 9, permanentDeletes: 3 });
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (wmiPid && !completed) {
      // Only this test's synthetic process tree may be stopped after a failed checkpoint.
      const expected = temp.replaceAll("/", "\\").replaceAll("'", "''");
      try {
        execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$root = Get-CimInstance Win32_Process -Filter 'ProcessId=${wmiPid}'; if ($root -and $root.CommandLine.Contains('${expected}')) { $children = Get-CimInstance Win32_Process -Filter 'ParentProcessId=${wmiPid}'; foreach ($p in $children) { if ($p.CommandLine.Contains('${expected}')) { Invoke-CimMethod -InputObject $p -MethodName Terminate | Out-Null } }; $root = Get-CimInstance Win32_Process -Filter 'ProcessId=${wmiPid}'; if ($root -and $root.CommandLine.Contains('${expected}')) { Invoke-CimMethod -InputObject $root -MethodName Terminate | Out-Null } }`]);
      } catch (error) { console.warn("Isolated fixture cleanup failed:", error.message); }
    }
    if (process.platform !== "win32") await rm(temp, { recursive: true, force: true });
  }
}

const options = {
  timeout: 30_000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Isolated Electron fixture requires a display" : false,
};
test("session organization user path: multiselect archive, trash, restore and confirmed permanent deletion", options, () => runSessionFixture(false));
test("sidebar project grouping user path: descriptive labels, scoped folding, unique selection and narrow layouts", options, () => runSessionFixture(true));
