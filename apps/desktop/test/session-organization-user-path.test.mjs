import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

test("session organization user path: multiselect archive, trash, restore and confirmed permanent deletion", {
  timeout: 30_000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Isolated Electron fixture requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "session-organization-"));
  let child;
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
    const result = await win.webContents.executeJavaScript("window.organizationProbe().catch(error => { console.error(error.stack); throw error; })");
    console.log("ORGANIZATION_PROBE " + JSON.stringify(result));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.PI_DESKTOP_DATA_DIR;
    child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
    }
    const timer = setTimeout(() => child.kill(), 25_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    } finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-8000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("ORGANIZATION_PROBE "));
    assert.ok(line, output.slice(-8000));
    assert.deepEqual(JSON.parse(line.slice("ORGANIZATION_PROBE ".length)), { passed: true, locales: 9, permanentDeletes: 3 });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await rm(temp, { recursive: true, force: true });
  }
});
