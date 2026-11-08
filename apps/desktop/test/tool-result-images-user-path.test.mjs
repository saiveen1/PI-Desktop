import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const stages = ["open", "next", "previous", "close", "keyboard-open", "close-again", "restore", "states", "turn", "generated", "snapshot-light", "snapshot-dark", "finish"];

test("tool images support compact previews, keyboard viewing, history, session isolation and generation", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-tool-images-ui-"));
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
    // The fixture uses esbuild, so expose Tailwind's token declarations as native CSS.
    const cssPath = join(temp, "renderer.css");
    await writeFile(cssPath, (await readFile(cssPath, "utf8")).replace(/@theme\s*\{/g, ":root {"));
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><title>Tool image regression</title><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    win.webContents.focus();
    for (const stage of ${JSON.stringify(stages)}) {
      const keyCode = { next: "Right", previous: "Left", close: "Escape", "keyboard-open": "Enter", "close-again": "Escape" }[stage];
      if (keyCode) {
        win.webContents.sendInputEvent({ type: "keyDown", keyCode });
        if (keyCode === "Enter") win.webContents.sendInputEvent({ type: "char", keyCode: "\\r" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode });
      }
      console.log("TOOL_IMAGES " + JSON.stringify(await win.webContents.executeJavaScript("window.toolImagesProbe(" + JSON.stringify(stage) + ")")));
      if (stage.startsWith("snapshot-") && process.env.PI_SCRATCH_DIR) {
        require("node:fs").writeFileSync(path.join(process.env.PI_SCRATCH_DIR, "tool-images-" + stage + ".png"), (await win.webContents.capturePage()).toPNG());
      }
    }
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.PI_DESKTOP_DATA_DIR;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
      output += chunk;
      for (const line of String(chunk).split(/\r?\n/)) if (line.startsWith("TOOL_IMAGES ")) console.log(line);
    });
    const timeout = setTimeout(() => child.kill(), 30_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timeout); }
    assert.equal(code, 0, output.slice(-6000));
    const results = output.split(/\r?\n/).filter((line) => line.startsWith("TOOL_IMAGES "))
      .map((line) => JSON.parse(line.slice("TOOL_IMAGES ".length)));
    assert.deepEqual(results, stages.map((stage) => ({ passed: true, stage })));
  } finally { await rm(temp, { recursive: true, force: true }); }
});
