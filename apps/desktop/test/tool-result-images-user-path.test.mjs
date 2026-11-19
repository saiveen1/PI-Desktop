import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { watch } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const stages = ["open", "next", "previous", "close", "keyboard-open", "close-again",
  "lightbox-open", "lightbox-drag", "lightbox-image", "lightbox-zoom", "lightbox-left", "lightbox-reopen", "lightbox-right",
  "restore", "states", "read-disclosure", "turn", "group", "group-next", "group-close", "group-boundaries", "generated", "generated-dismiss", "snapshot-light", "snapshot-dark", "finish"];

async function runFixture(temp) {
  const entry = join(temp, "main.cjs");
  const binary = resolveElectronBinary(root).electronBinary;
  if (process.platform === "win32") {
    let watcher, timer, pid;
    const report = new Promise((resolve, reject) => {
      watcher = watch(temp, (_event, file) => {
        if (String(file) !== "result.json") return;
        void readFile(join(temp, "result.json"), "utf8").then(text => resolve(JSON.parse(text)), reject);
      });
      timer = setTimeout(() => reject(Error("Tool image fixture did not complete within 30s")), 30_000);
    });
    try {
      const command = `"${binary}" "${entry}"`;
      const script = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${command.replaceAll("'", "''")}'}; if ($r.ReturnValue -ne 0) { throw 'WMI fixture launch failed' }; $r.ProcessId`;
      pid = Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim());
      assert.ok(pid > 0);
      return await report;
    } finally {
      watcher?.close(); clearTimeout(timer);
      // The fixture alone owns this process, which normally exits after writing its report.
      if (pid) execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p -and $p.CommandLine.Contains('${entry.replaceAll("'", "''")}')) { Invoke-CimMethod -InputObject $p -MethodName Terminate | Out-Null }`]);
    }
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PI_DESKTOP_DATA_DIR;
  const child = spawn(binary, [entry], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; });
  const timeout = setTimeout(() => child.kill(), 30_000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { code, output };
  } finally { clearTimeout(timeout); }
}

test("Read details and output galleries preserve keyboard viewing, history, session isolation and generation", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-tool-images-ui-"));
  console.log(`TOOL_IMAGES_ARTIFACTS ${temp}`);
  try {
    await build({
      entryPoints: [join(root, "apps/desktop/test/fixtures/tool-result-images.tsx")],
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"DEV":false,"MODE":"production"}' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"), "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"), "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    const cssPath = join(temp, "renderer.css");
    await writeFile(cssPath, (await readFile(cssPath, "utf8")).replace(/@theme\s*\{/g, ":root {"));
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><title>Tool image regression</title><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
app.setPath("userData", path.join(__dirname, "profile"));
let output = "";
const log = text => { output += text + "\\n"; console.log(text); fs.appendFileSync(path.join(__dirname, "progress.log"), text + "\\n"); };
const finish = code => {
  fs.writeFileSync(path.join(__dirname, "result.tmp"), JSON.stringify({ code, output }));
  fs.renameSync(path.join(__dirname, "result.tmp"), path.join(__dirname, "result.json"));
  app.exit(code);
};
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", event => log(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    win.webContents.focus();
    for (const stage of ${JSON.stringify(stages)}) {
      log("TOOL_IMAGES_STAGE " + stage);
      if (stage === "generated") win.setContentSize(360, 640);
      if (stage === "snapshot-light") win.setContentSize(1000, 800);
      const keyCode = { next: "Right", previous: "Left", close: "Escape", "keyboard-open": "Enter", "close-again": "Escape", "group-next": "Right", "group-close": "Escape" }[stage];
      if (keyCode) {
        win.webContents.sendInputEvent({ type: "keyDown", keyCode });
        if (keyCode === "Enter") win.webContents.sendInputEvent({ type: "char", keyCode: "\\r" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode });
      }
      if (["lightbox-drag", "lightbox-image", "lightbox-zoom", "lightbox-left", "lightbox-right", "generated-dismiss"].includes(stage)) {
        const [start, end = start] = await win.webContents.executeJavaScript("window.toolImagesPointer(" + JSON.stringify(stage) + ")");
        win.webContents.sendInputEvent({ type: "mouseDown", x: start[0], y: start[1], button: "left", clickCount: 1 });
        if (end !== start) win.webContents.sendInputEvent({ type: "mouseMove", x: end[0], y: end[1], modifiers: ["leftButtonDown"] });
        win.webContents.sendInputEvent({ type: "mouseUp", x: end[0], y: end[1], button: "left", clickCount: 1 });
      }
      log("TOOL_IMAGES " + JSON.stringify(await win.webContents.executeJavaScript("window.toolImagesProbe(" + JSON.stringify(stage) + ")")));
      if (stage.startsWith("snapshot-") || stage === "lightbox-open" || stage === "generated") {
        fs.writeFileSync(path.join(__dirname, stage + ".png"), (await win.webContents.capturePage()).toPNG());
      }
    }
    finish(0);
  } catch (error) { log(error.stack || String(error)); finish(1); }
});
`);
    const { code, output } = await runFixture(temp);
    console.log(output.slice(-6000));
    assert.equal(code, 0, output.slice(-6000));
    const results = output.split(/\r?\n/).filter(line => line.startsWith("TOOL_IMAGES "))
      .map(line => JSON.parse(line.slice("TOOL_IMAGES ".length)));
    assert.deepEqual(results, stages.map(stage => ({ passed: true, stage })));
  } finally { if (!process.env.PI_SCRATCH_DIR) await rm(temp, { recursive: true, force: true }); }
});
