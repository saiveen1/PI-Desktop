import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

test("task reading: keyboard disclosure, retained changes, task navigation, and light/dark narrow layouts", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const keep = process.env.PI_TASK_READING_ARTIFACT_DIR;
  const temp = keep || await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-task-reading-"));
  await mkdir(temp, { recursive: true });
  try {
    const styles = await Promise.all(["tokens", "base", "ui-kit", "messages", "chat-links", "turn-changes", "work-panel"].map(name =>
      readFile(join(root, `apps/desktop/src/styles/${name}.css`), "utf8")));
    await writeFile(join(temp, "style.css"), styles.join("\n") + `
      html, body { height: auto; min-height: 100%; overflow: auto; background: var(--ds-bg-primary); }
      .fixture-grid { display: grid; grid-template-columns: minmax(0, 1fr) var(--fixture-panel-width, 380px); gap: 28px; padding: 36px; }
      .fixture-chat { min-width: 0; padding: 12px 16px; }
      .fixture-panel { min-width: 0; height: 680px; border: 1px solid var(--ds-border); border-radius: 12px; overflow: hidden; }
      .fixture-panel .subagent-transcript-tab { height: 100%; }
      @media (max-width: 900px) { .fixture-grid { padding: 12px; gap: 12px; } .fixture-chat { padding: 4px; } }
    `);
    await build({
      entryPoints: [join(root, "apps/desktop/test/fixtures/task-reading.jsx")], outfile: join(temp, "renderer.js"),
      bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"DEV":false,"MODE":"production"}' },
      loader: { ".css": "empty" }, alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"), "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"), "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
      }, nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><html data-theme="light"><meta charset="utf-8"><title>Task reading component fixture</title><link rel="stylesheet" href="style.css"><div id="root"></div><script type="module" src="renderer.js"></script></html>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow, session } = require("electron");
const { writeFileSync } = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_, done) => done({ cancel: true }));
  // Hidden Windows fixtures need offscreen painting for normal animation frames.
  const win = new BrowserWindow({ show: false, width: 1300, height: 850, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: process.platform === "win32" } });
  win.webContents.on("console-message", event => { if (event.message.startsWith("TASK_")) console.log(event.message); else if (event.level >= 2) console.error(event.message); });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const probe = async stage => { const started = Date.now(); console.log("TASK_STAGE " + stage + " " + started); console.log("TASK_READING " + JSON.stringify({ ...await win.webContents.executeJavaScript("window.taskReadingProbe(" + JSON.stringify(stage) + ")"), elapsedMs: Date.now() - started })); };
    await probe("initial");
    win.webContents.focus();
    for (const [keyCode, stage] of [["Enter", "keyboard-open"], ["Space", "keyboard-close"]]) {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode });
      win.webContents.sendInputEvent({ type: "char", keyCode: keyCode === "Enter" ? "\\r" : " " });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode });
      await probe(stage);
    }
    await probe("tasks");
    await probe("input");
    await probe("search");
    for (const [theme, width, language] of [["light", 380, "en"], ["dark", 380, "en"], ["light", 300, "zh-CN"], ["dark", 300, "zh-CN"]]) {
      win.setContentSize(width === 300 ? 900 : 1300, 850);
      const result = await win.webContents.executeJavaScript("window.taskReadingLayout(" + [theme, width, language].map(JSON.stringify).join(",") + ")");
      console.log("TASK_LAYOUT " + JSON.stringify(result));
      writeFileSync(path.join(__dirname, theme + "-" + width + ".png"), (await win.webContents.capturePage()).toPNG());
    }
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.PI_DESKTOP_DATA_DIR;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
      output += chunk;
      if (chunk.toString().includes("TASK_")) console.log(chunk.toString().trim());
    });
    const timer = setTimeout(() => child.kill(), 45_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-12000));
    assert.equal(output.split(/\r?\n/).filter(line => line.startsWith("TASK_READING ")).length, 6, output);
    assert.equal(output.split(/\r?\n/).filter(line => line.startsWith("TASK_LAYOUT ")).length, 4, output);
  } finally { if (!keep) await rm(temp, { recursive: true, force: true }); }
});
