import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const fixture = String.raw`
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { Markdown } from "../../apps/desktop/src/components/Markdown";
import { CopyButton } from "../../apps/desktop/src/features/chat/transcript/shared";

await i18n.use(initReactI18next).init({ lng: "en", resources: { en: { translation: catalogs.en }, "zh-CN": { translation: catalogs["zh-CN"] } } });
let copied;
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { copied = text; } } });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const view = createRoot(document.getElementById("root"));
let checks = 0;
function check(value, name) { if (!value) throw Error(name); checks++; console.log("CHECK " + checks + " " + name); }
const settle = () => act(async () => {});
const render = async (source, streaming = false) => {
  flushSync(() => view.render(<><Markdown source={source} streaming={streaming} /><CopyButton text={source} label="Copy original" /></>));
  await settle();
};
const click = async (label) => {
  const button = [...document.querySelectorAll("button")].find(el => el.getAttribute("aria-label") === label || el.textContent === label);
  check(button && !button.disabled, "Missing enabled button: " + label);
  flushSync(() => button.click()); await settle();
};
const page = () => Number(document.querySelector(".large-text-preview")?.dataset.pageIndex ?? 0);
const bound = () => {
  const pre = document.querySelector("pre");
  check(pre && pre.textContent.length <= 32768, "Preview character cap exceeded");
  check(pre.textContent.split(/\r\n|\r|\n/).length <= 801, "Preview line cap exceeded");
  check(!document.querySelector("[data-source-start]"), "Paged display advertised false raw-source anchors");
};
window.runPreviewChecks = async () => {
  for (const repetitions of [12300, 36000, 100000]) {
    const source = "Intro\n" + ":\n\n".repeat(repetitions) + "End";
    await render(source);
    check(document.querySelector("pre").textContent.includes("lines folded"), "Dense output was not folded");
    check(document.querySelector("pre").textContent.length < 200, "Folded preview is not small");
    bound();
    await click("Copy original");
    check(copied === source, "Copy changed or truncated the raw source");
    await click("Show original text");
    check(!document.querySelector("pre").textContent.includes("lines folded"), "Original view is still folded");
    bound();
    await click("Next part"); check(page() === 1, "Next did not advance"); bound();
    await click("Show folded preview"); check(page() === 1, "Folding changed raw page position"); bound();
    await click("Previous part"); check(page() === 0, "Previous did not return");
  }
  await render("Normal **answer**.");
  check(document.querySelector("strong")?.textContent === "answer", "Normal Markdown changed");
  let source = "stream\n" + "new line\n".repeat(2400);
  await render(source, true);
  const latest = page(); check(latest > 0, "Live preview did not follow latest page");
  await click("Previous part"); const selected = page();
  source += "appended\n".repeat(2000);
  await render(source, true); check(page() === selected, "Streaming pulled reader away from selected page"); bound();
  await render("replacement\n".repeat(3000), false);
  check(page() === 0, "Replacement did not reset page"); bound();
  await i18n.changeLanguage("zh-CN");
  await render(":\n\n".repeat(3000));
  check(document.querySelector("pre").textContent.includes("已折叠"), "Chinese folding label missing");
  await click("查看原文"); bound();
  await click("Copy original"); check(copied === ":\n\n".repeat(3000), "Chinese preview altered Copy");
  flushSync(() => view.unmount());
  return { checks };
};
`;

test("bounded Markdown preview toggles, pages, copies raw text and follows reader intent", {
  timeout: 60_000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-output-preview-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(dir, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"development"', "import.meta.env": '{"DEV":false,"MODE":"test"}' },
      loader: { ".css": "empty" },
      alias: { "@pi-desktop/i18n": join(root, "packages/i18n/src"), "@pi-desktop/shared": join(root, "packages/shared/src"), react: join(root, "apps/desktop/node_modules/react"), "react-dom": join(root, "apps/desktop/node_modules/react-dom") },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(dir, "index.html"), '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(dir, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
let ended = false;
let stage = "boot";
function finish(result) {
  if (ended) return; ended = true;
  writeFileSync(path.join(__dirname, "result.json"), JSON.stringify({ stage, ...result }));
  app.exit(result.ok ? 0 : 1);
}
setTimeout(() => finish({ ok: false, error: "Fixture exceeded 40 seconds at " + stage }), 40000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  stage = "load fixture";
  win.webContents.on("console-message", (event) => { if (event.message.startsWith("CHECK ")) stage = event.message; });
  win.webContents.on("render-process-gone", (_event, details) => finish({ ok: false, error: details.reason }));
  await win.loadFile(path.join(__dirname, "index.html"));
  stage = "run component checks";
  const result = await win.webContents.executeJavaScript("window.runPreviewChecks()");
  finish({ ok: true, ...result });
}).catch(error => finish({ ok: false, error: String(error.stack || error) }));
`);
    const binary = resolveElectronBinary(root).electronBinary;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.PI_DESKTOP_DATA_DIR;
    if (process.platform === "win32") {
      await writeFile(join(dir, "launch.ps1"), `
param([string]$Binary, [string]$Entry)
$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:PI_DESKTOP_DATA_DIR -ErrorAction SilentlyContinue
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('"' + $Binary + '" "' + $Entry + '"'); CurrentDirectory = $PSScriptRoot }
if ($r.ReturnValue -ne 0) { throw "WMI launch failed: $($r.ReturnValue)" }
$p = Get-Process -Id $r.ProcessId -ErrorAction SilentlyContinue
if ($p) { $p | Wait-Process -Timeout 45 }
`);
      await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(dir, "launch.ps1"), "-Binary", binary, "-Entry", join(dir, "main.cjs")], { env, timeout: 50_000 });
    } else {
      const child = spawn(binary, [join(dir, "main.cjs")], { env, stdio: "ignore" });
      await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    }
    const result = JSON.parse(await readFile(join(dir, "result.json"), "utf8"));
    assert.equal(result.ok, true, result.error);
    assert.ok(result.checks >= 60, JSON.stringify(result));
    console.log(`Preview interaction assertions passed: ${result.checks}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
