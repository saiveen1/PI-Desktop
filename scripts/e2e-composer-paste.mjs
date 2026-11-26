#!/usr/bin/env node
/** Composer paste regression with real React hooks, preload, and scratch writer. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(
  join(root, "packages/agent-runtime/package.json"),
);
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const directoriesOnly = process.argv.includes("--directories-only");
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-composer-paste-"));
const fileReferencesOnly = process.argv.includes("--file-references-only");
try {
  console.log("COMPOSER_STAGE bundle-current-source");
  await build({
    entryPoints: [join(root, "scripts/e2e/composer-paste.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file", ".png": "dataurl" },
    define: {
      "import.meta.env.DEV": "false",
      "process.env.NODE_ENV": '"production"',
    },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
    plugins: [{
      name: "local-url-assets",
      setup(build) {
        build.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({
          path: join(resolveDir, path.slice(0, -4)), namespace: "local-url-asset",
        }));
        build.onLoad({ filter: /.*/, namespace: "local-url-asset" }, async ({ path }) => ({
          contents: await readFile(path), loader: "file",
        }));
      },
    }],
  });
  await build({
    entryPoints: {
      writer: join(root, "apps/desktop/electron/main/composer-paste.ts"),
      importer: join(root, "apps/desktop/electron/main/composer-file-import.ts"),
      selection: join(root, "apps/desktop/electron/composer-file-selection.ts"),
      directories: join(root, "apps/desktop/electron/main/composer-clipboard-directories.ts"),
      picker: join(root, "apps/desktop/electron/main/composer-picker.ts"),
      prompt: join(root, "apps/desktop/electron/main/prompt-attachments.ts"),
      reader: join(root, "packages/host-runtime/src/workspace-files.ts"),
      video: join(root, "apps/desktop/electron/main/open-attachment-video.ts"),
    },
    outdir: temp,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  await build({
    entryPoints: [join(root, "apps/desktop/electron/preload/index.ts")],
    outfile: join(temp, "preload.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"],
  });
  await writeFile(
    join(temp, "native-image.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNo2PDgPwAG1AMQ/5r/oAAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  await writeFile(join(temp, "native notes.txt"), "native file bytes");
  if (fileReferencesOnly) {
    await mkdir(join(temp, "reference-project"));
    const file = await open(join(temp, "large reference.bin"), "w");
    await file.truncate(64 * 1024 * 1024 + 1);
    await file.close();
  }
  await writeFile(join(temp, "tokens.css"), (await readFile(join(root, "apps/desktop/src/styles/tokens.css"), "utf8")).replace(/@theme(?: inline)?/g, ":root"));
  await writeFile(
    join(temp, "composer.css"),
    await readFile(join(root, "apps/desktop/src/styles/composer.css")),
  );
  await writeFile(
    join(temp, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"><link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="composer.css"><link rel="stylesheet" href="renderer.css"><body><input id="native-files" type="file" multiple hidden><script src="renderer.js"></script>`,
  );
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow, ipcMain, nativeImage } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");
const { saveComposerPasteFiles } = require("./writer.cjs");
const { importComposerSelection } = require("./importer.cjs");
const { COMPOSER_FILE_SELECTION_CHANNEL } = require("./selection.cjs");
const { nativeClipboardPaths, readComposerClipboardDirectories } = require("./directories.cjs");
const { rememberComposerPickerSelection, consumeComposerPickerSelection, rememberComposerNativeFiles } = require("./picker.cjs");
const { preparePromptAttachments, appendPromptFallbackPaths } = require("./prompt.cjs");
const { readOpenableFile, readOpenableImage, resolveRealOpenablePath } = require("./reader.cjs");
const { openableMp4Path } = require("./video.cjs");
app.setPath("userData", path.join(__dirname, "profile"));
const saved = [];
const history = [];
const opened = [];
const revealedFolders = [];
let completeOpens;
const opensDone = new Promise(resolve => { completeOpens = resolve; });
let directoryPastePending = true;
let referencePrompts = 0;
let composerSenderId;
ipcMain.handle(COMPOSER_FILE_SELECTION_CHANNEL, async (event, paths) => {
  assert.equal(event.sender.id, composerSenderId);
  return { ok: true, data: { token: rememberComposerNativeFiles(paths, event.sender.id) } };
});
ipcMain.handle("pi-desktop/composer/pickFiles", async event => ({ ok: true, data: {
  token: rememberComposerPickerSelection(["large reference.bin", "native-image.png", "native notes.txt"].map(name => path.join(__dirname, name)), event.sender.id),
} }));
ipcMain.handle("pi-desktop/composer/readClipboardDirectories", async (event) => {
  if (process.argv.includes("--file-references-only")) {
    const paths = ["large reference.bin", "native-image.png", "native notes.txt"].map(name => path.join(__dirname, name));
    const clipboard = { readBuffer: format => Buffer.from(format === "text/uri-list"
      ? paths.map(source => pathToFileURL(source).href).join("\\r\\n") : "") };
    const data = await readComposerClipboardDirectories(clipboard,
      selected => rememberComposerPickerSelection(selected, event.sender.id),
      () => nativeClipboardPaths(clipboard, process.platform, async () => paths));
    return { ok: true, data };
  }
  if (!directoryPastePending) return { ok: true, data: null };
  directoryPastePending = false;
  const clipboard = {
    readBuffer: format => Buffer.from(format === "text/uri-list"
      ? pathToFileURL(path.join(__dirname, "copied folder")).href : ""),
  };
  // Keep fixture paths native without reading the host clipboard.
  const data = await readComposerClipboardDirectories(clipboard, () => {
    throw new Error("a folder-only paste must not create an import token");
  }, () => nativeClipboardPaths(
    clipboard,
    process.platform,
    () => [path.join(__dirname, "copied folder")],
  ));
  return { ok: true, data };
});
ipcMain.handle("pi-desktop/composer/importFiles", async (event, input) => {
  assert.equal(event.sender.id, composerSenderId);
  assert.equal(input.reference, "auto");
  assert.equal(input.sessionId, "paste-a");
  const referenceMode = process.argv.includes("--file-references-only");
  if (referenceMode) await fs.truncate(path.join(__dirname, "large reference.bin"), 67108865);
  const files = await importComposerSelection(__dirname, input.sessionId,
    referenceMode && !process.argv.includes("--without-project") ? path.join(__dirname, "reference-project") : undefined,
    consumeComposerPickerSelection(input.token, event.sender.id));
  if (referenceMode) {
    assert.equal(files[0].size, 67108865);
    const image = files.find(file => file.name === "native-image.png");
    assert(image, "native selection must include the image");
    assert.equal(image.kind, "image");
    assert.equal(image.localReference, undefined);
    assert(image.path.startsWith(path.join(__dirname, "scratch", input.sessionId) + path.sep));
    // Simulate a source edit after registration, before the user sends the draft.
    await fs.writeFile(path.join(__dirname, "large reference.bin"), "changed");
  } else {
    saved.push({ sessionId: input.sessionId, files, mimeTypes: files.map(file => file.mimeType) });
  }
  return { ok: true, data: { files } };
});
if (process.argv.includes("--file-references-only") || process.argv.includes("--file-references-history-check")) {
  ipcMain.handle("pi-desktop/agent/prompt", async (_event, input) => {
    assert.equal(input.attachments.length, 3);
    const prepared = await preparePromptAttachments(__dirname, input.sessionId,
      process.argv.includes("--without-project") ? undefined : path.join(__dirname, "reference-project"), input.attachments, true, input.content);
    const image = prepared.find(item => item.message.name === "native-image.png");
    assert(image?.message.kind === "image" && image.inlineData, "native image file must reach the model as image bytes");
    assert(prepared.filter(item => item !== image).every(item => item.message.kind === "file" && !item.inlineData));
    const large = prepared.find(item => item.message.name === "large reference.bin");
    assert.equal(large.message.size, 7);
    const context = appendPromptFallbackPaths(input.content, prepared);
    assert(context.includes("7 bytes"));
    assert(context.includes(large.fallbackPath));
    assert.equal(saved.length, 0, "disk references must not invoke the byte writer");
    assert.equal((await fs.readdir(path.join(__dirname, "composer-file-references"))).length, 6);
    referencePrompts++;
    return { ok: true, data: { accepted: true, turnId: "reference-turn" } };
  });
}
ipcMain.handle("pi-desktop/composer/pasteFiles", async (_event, input) => {
  const files = await saveComposerPasteFiles(__dirname, input.sessionId, input.files);
  for (let i = 0; i < files.length; i++) {
    assert.deepEqual(await fs.readFile(files[i].path), Buffer.from(input.files[i].data));
  }
  if (input.files.some(file => file.mimeType.startsWith("image/"))) {
    const wide = nativeImage.createFromBuffer(await fs.readFile(path.join(__dirname, "native-image.png"))).resize({ width: 1200, height: 600 }).toPNG();
    await fs.writeFile(path.join(path.dirname(files[0].path), "wide-fixture.png"), wide);
    await fs.writeFile(path.join(path.dirname(files[0].path), "corrupt-fixture.png"), Buffer.from("invalid PNG fixture"));
  }
  saved.push({
    sessionId: input.sessionId,
    files,
    mimeTypes: input.files.map((entry) => entry.mimeType),
  });
  return { ok: true, data: { files } };
});
ipcMain.handle("pi-desktop/fs/readImageDataUrl", async (_event, input) => ({
  ok: true,
  data: await readOpenableImage(input.ref, null, [path.join(__dirname, "scratch")], input.mimeType),
}));
ipcMain.handle("pi-desktop/fs/read", async (_event, input) => ({
  ok: true,
  data: input.path === "untrusted.sh"
    ? { kind: "tooLarge", size: 512 * 1024 + 1 }
    : await readOpenableFile(input.path, null, [path.join(__dirname, "scratch"), path.join(__dirname, "attachments")], input.mimeType),
}));
ipcMain.handle("pi-desktop/fs/resolveRef", async (_event, input) => {
  const scratchRoot = path.join(__dirname, "scratch") + path.sep;
  if (input.ref.startsWith(scratchRoot)) {
    return { ok: true, data: { match: {
      root: "scratch", relativePath: path.relative(scratchRoot, input.ref),
      absolutePath: input.ref, matchedBy: "exact-absolute",
    } } };
  }
  const hash = input.ref.startsWith("attachments/") ? input.ref.slice("attachments/".length) : "";
  assert(/^[ab]{64}$/.test(hash), "unexpected MP4 attachment reference");
  return { ok: true, data: { match: {
    root: "attachments", relativePath: hash,
    absolutePath: path.join(__dirname, "attachments", hash), matchedBy: "exact-relative",
  } } };
});
ipcMain.handle("pi-desktop/fs/open", async (_event, input) => {
  const target = await resolveRealOpenablePath(input.path, null, [path.join(__dirname, "scratch"), path.join(__dirname, "attachments")]);
  assert(target, "host rejected the MP4 attachment path");
  const openPath = await openableMp4Path(__dirname, target, input.mimeType);
  opened.push(openPath);
  if (opened.length === 3) completeOpens();
  return { ok: true, data: { ok: true } };
});
ipcMain.handle("pi-desktop/fs/reveal", async (_event, input) => {
  revealedFolders.push(input);
  return { ok: true, data: { ok: true } };
});
ipcMain.handle("pi-desktop/clipboard/recordPaste", (_event, input) => {
  history.push(input.text);
  return { ok: true, data: null };
});
app.whenReady().then(async () => {
  if (process.argv.includes("--draft-race")) {
    app.on("window-all-closed", () => {});
    const timestamp = "2026-01-01T00:00:00Z";
    const existing = {
      id: "existing", title: "Existing task", source: "desktop", mode: "agent", permissionMode: "inherit",
      thinkingLevel: "off", providerId: "fixture", modelId: "fixture-model", messageCount: 1,
      createdAt: timestamp, updatedAt: timestamp,
    };
    const created = { ...existing, id: "created", title: "New task", messageCount: 0 };
    const ok = data => ({ ok: true, data });
    let gate;
    let started;
    let creates;
    let prompts;
    ipcMain.handle("pi-desktop/session/create", async () => {
      creates++;
      started.resolve();
      await gate.promise;
      return ok({ session: created });
    });
    ipcMain.handle("pi-desktop/session/get", () => ok({
      session: { ...existing, messages: [{ id: "old", role: "user", content: "Existing message", createdAt: timestamp }] },
    }));
    ipcMain.handle("pi-desktop/agent/prompt", (_event, input) => {
      prompts.push({ id: input.sessionId, content: input.content });
      return ok({});
    });
    try {
      for (const scenario of ["send", "paste", "cancel-send", "cancel-paste"]) {
        gate = Promise.withResolvers();
        started = Promise.withResolvers();
        creates = 0;
        prompts = [];
        saved.length = 0;
        // A never-shown window throttles animation frames; the probe waits on them.
        const window = new BrowserWindow({ show: true, webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
        } });
        window.webContents.on("console-message", (event) => console.error(event.message));
        await window.loadFile(path.join(__dirname, "index.html"));
        await window.webContents.executeJavaScript("globalThis.startComposerDraftRace(" + JSON.stringify(scenario) + "," + JSON.stringify(existing) + ")");
        await started.promise;
        assert.equal(creates, 1, scenario + ": exactly one create must be pending");
        assert.equal(prompts.length + saved.length, 0, scenario + ": input must wait for creation");
        gate.resolve();
        const result = await window.webContents.executeJavaScript("globalThis.finishComposerDraftRace()");
        assert.equal(creates, 1, scenario + ": no second session create");
        assert.deepEqual(result.rows.sort(), ["created", "existing"], scenario + ": exactly one new sidebar row");
        assert.equal(result.selected, scenario.startsWith("cancel") ? "existing" : "created");
        assert.equal(result.attachment, scenario === "paste");
        assert.deepEqual(saved.map(entry => entry.sessionId), scenario === "paste" ? ["created"] : []);
        assert.deepEqual(prompts, scenario === "send" ? [{ id: "created", content: "First message while creation is pending" }] : []);
        window.destroy();
        console.log("COMPOSER_DRAFT_RACE " + scenario + " passed");
      }
      app.exit(0);
    } catch (error) {
      console.error(error.stack || error);
      app.exit(1);
    }
    return;
  }
  if (process.argv.includes("--history-check")) {
    try {
      const window = new BrowserWindow({ show: true, webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      } });
      window.webContents.on("console-message", (event) => {
        if (!event.message.startsWith("PI_PREVIEW_KEY:")) return;
        const key = event.message.slice("PI_PREVIEW_KEY:".length);
        assert(["Escape", "Tab", "ArrowUp", "ArrowDown", "Enter"].includes(key));
        const keyCode = key === "ArrowUp" ? "Up" : key === "ArrowDown" ? "Down" : key;
        window.webContents.sendInputEvent({ type: "keyDown", keyCode });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode });
      });
      await window.loadFile(path.join(__dirname, "index.html"));
      await window.webContents.executeJavaScript('globalThis.composerPreviewPressKey = key => new Promise(resolve => { document.addEventListener("keyup", () => requestAnimationFrame(resolve), { once: true }); console.log("PI_PREVIEW_KEY:" + key); }); void 0');
      const result = await window.webContents.executeJavaScript('globalThis.composerHistoryProbe("verify")');
      assert.equal(result.ok, true, JSON.stringify(result));
      console.log("COMPOSER_HISTORY_RESTART " + JSON.stringify(result));
      app.quit();
    } catch (error) {
      console.error("COMPOSER_HISTORY_RESTART " + JSON.stringify({ ok: false, error: String(error), stack: error?.stack }));
      app.exit(1);
    }
    return;
  }
  await fs.mkdir(path.join(__dirname, "attachments"), { recursive: true });
  await fs.mkdir(path.join(__dirname, "copied folder"), { recursive: true });
  await fs.writeFile(path.join(__dirname, "attachments", "a".repeat(64)), Buffer.alloc(512 * 1024 + 1));
  await fs.writeFile(path.join(__dirname, "attachments", "b".repeat(64)), Buffer.from([0, 1, 2, 0]));
  const window = new BrowserWindow({ show: true, webPreferences: {
    preload: path.join(__dirname, "preload.cjs"),
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  composerSenderId = window.webContents.id;
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    window.webContents.debugger.attach("1.3");
    const { root } = await window.webContents.debugger.sendCommand("DOM.getDocument");
    const { nodeId } = await window.webContents.debugger.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: "#native-files" });
    await window.webContents.debugger.sendCommand("DOM.setFileInputFiles", { nodeId, files: (process.argv.includes("--file-references-only") || process.argv.includes("--file-references-history-check")
      ? ["large reference.bin", "native-image.png", "native notes.txt"] : ["native-image.png", "native notes.txt"])
      .map(name => path.join(__dirname, name)) });
    window.webContents.on("console-message", async (event) => {
      if (!event.message.startsWith("PI_PREVIEW_KEY:")) return;
      const key = event.message.slice("PI_PREVIEW_KEY:".length);
      assert(["Escape", "Tab", "ArrowUp", "ArrowDown", "Enter"].includes(key));
      const keyCode = key === "ArrowUp" ? "Up" : key === "ArrowDown" ? "Down" : key;
      window.webContents.sendInputEvent({ type: "keyDown", keyCode });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode });
    });
    await window.webContents.executeJavaScript('globalThis.composerPreviewPressKey = key => new Promise(resolve => { document.addEventListener("keyup", () => requestAnimationFrame(resolve), { once: true }); console.log("PI_PREVIEW_KEY:" + key); }); void 0');
    if (process.env.PI_COMPOSER_PREVIEW_SCREENSHOT) {
      window.webContents.on("console-message", async (event) => {
        if (event.message !== "PI_PREVIEW_CAPTURE") return;
        await fs.writeFile(process.env.PI_COMPOSER_PREVIEW_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
        await window.webContents.executeJavaScript("globalThis.composerPreviewCaptureDone()");
      });
      await window.webContents.executeJavaScript('globalThis.composerPreviewCapture = () => new Promise(resolve => { globalThis.composerPreviewCaptureDone = resolve; console.log("PI_PREVIEW_CAPTURE"); }); void 0');
    }
    window.webContents.on("console-message", async (event) => {
      if (!event.message.startsWith("PI_PREVIEW_POINTER:")) return;
      const input = JSON.parse(event.message.slice("PI_PREVIEW_POINTER:".length));
      assert(["mousePressed", "mouseMoved", "mouseReleased"].includes(input.type));
      await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
        ...input, button: "left", buttons: input.type === "mouseReleased" ? 0 : 1, clickCount: 1,
      });
      await window.webContents.executeJavaScript("globalThis.composerPreviewPointerDone()");
    });
    await window.webContents.executeJavaScript('globalThis.composerPreviewPointer = input => new Promise(resolve => { globalThis.composerPreviewPointerDone = resolve; console.log("PI_PREVIEW_POINTER:" + JSON.stringify(input)); }); void 0');
    const directoriesOnly = process.argv.includes("--directories-only");
    const screenshotOnly = process.argv.includes("--screenshot-only");
    const fileReferencesOnly = process.argv.includes("--file-references-only");
    const referenceHistoryOnly = process.argv.includes("--file-references-history-check");
    const referenceProject = process.argv.includes("--without-project") ? "" : path.join(__dirname, "reference-project");
    const result = await window.webContents.executeJavaScript(
      "globalThis.composerPasteProbe(" + JSON.stringify({ directoriesOnly, screenshotOnly, fileReferencesOnly, referenceHistoryOnly, referenceProject }) + ")",
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    if (directoriesOnly || fileReferencesOnly || referenceHistoryOnly) {
      assert.equal(saved.length, 0);
      if (directoriesOnly) {
        assert.equal(result.scope, "directories-only");
        assert.equal(result.nativeDirectoryMetadata, true);
        assert.deepEqual(opened, [], "directory paste must not open attachments");
      } else {
        assert.equal(referencePrompts, 1);
      }
      console.log("COMPOSER_PASTE_PROBE " + JSON.stringify(result));
      app.quit();
      return;
    }
    if (screenshotOnly) {
      assert.equal(saved.length, 2);
      assert.deepEqual(saved[0].mimeTypes, ["image/png"]);
      assert.deepEqual(saved[1].mimeTypes, ["image/png"]);
      assert.equal(revealedFolders.length, 1);
      console.log("COMPOSER_PASTE_PROBE " + JSON.stringify({ ...result, scratchBytesVerified: true }));
      app.quit();
      return;
    }
    await opensDone;
    assert.deepEqual(revealedFolders, [{ path: path.join(__dirname, "copied folder"), sessionId: "paste-a", directory: true }]);
    assert.deepEqual(opened.map(path.extname), [".mp4", ".mp4", ".mp4"]);
    assert.equal(await fs.realpath(opened[0]), await fs.realpath(path.join(__dirname, "attachments", "a".repeat(64))));
    assert.equal(await fs.realpath(opened[1]), await fs.realpath(path.join(__dirname, "attachments", "b".repeat(64))));
    assert.equal(opened[2], saved.find(entry => entry.mimeTypes.includes("video/mp4"))?.files[0].path);
    const mimeSets = saved.map((entry) => entry.mimeTypes.join("+"));
    assert.equal(
      saved.length,
      6,
      "unexpected scratch writes (large text, MP4, image-only, native image, empty image-only, native files): " + JSON.stringify(mimeSets),
    );
    assert.deepEqual(
      mimeSets.filter((mimes) => mimes === "text/plain"),
      ["text/plain"],
      "Word text must be the only text-only write: " + JSON.stringify(mimeSets),
    );
    assert.equal(
      mimeSets.filter((mimes) => mimes.includes("image/png")).length,
      4,
      "image-only and native-file pastes must keep writing image bytes: " + JSON.stringify(mimeSets),
    );
    assert.equal(mimeSets.filter((mimes) => mimes === "video/mp4").length, 1);
    assert(history.some(text => text.includes("Word paragraph")), "short text missing from clipboard history");
    console.log("COMPOSER_PASTE_PROBE " + JSON.stringify({ ...result, scratchBytesVerified: true }));
    const historyResult = await window.webContents.executeJavaScript('globalThis.composerHistoryProbe("prepare")');
    assert.equal(historyResult.ok, true, JSON.stringify(historyResult));
    console.log("COMPOSER_HISTORY_PREPARE " + JSON.stringify(historyResult));
    app.quit();
  } catch (error) {
    console.error("COMPOSER_PASTE_PROBE " + JSON.stringify({ ok: false, error: String(error), stack: error?.stack, savedCount: saved.length }));
    app.exit(1);
  }
});
`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const runElectron = async (args = []) => {
    if (process.argv.includes("--without-project")) args = [...args, "--without-project"];
    console.log("COMPOSER_STAGE " + (args.join(" ") || "full-paste"));
    const child = spawn(electronBinary, [join(temp, "main.cjs"), ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (data) => {
        output += data;
      });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timeout);
    }
    return { code, output };
  };
  const draftRace = await runElectron(["--draft-race"]);
  assert.equal(draftRace.code, 0, draftRace.output.slice(-6000));
  const draftCases = draftRace.output.split(/\r?\n/).filter((line) => line.startsWith("COMPOSER_DRAFT_RACE "));
  assert.equal(draftCases.length, 4, draftRace.output.slice(-6000));
  console.log(draftCases.join("\n"));

  const directoriesOnly = process.argv.includes("--directories-only");
  const screenshotOnly = process.argv.includes("--screenshot-only");
  const firstRun = await runElectron(
    directoriesOnly ? ["--directories-only"] : fileReferencesOnly ? ["--file-references-only"] : screenshotOnly ? ["--screenshot-only"] : [],
  );
  const pasteLine = firstRun.output
    .split(/\r?\n/)
    .find((line) => line.startsWith("COMPOSER_PASTE_PROBE "));
  assert(
    pasteLine,
    `renderer returned no paste result (exit=${firstRun.code}): ${firstRun.output.slice(-3000)}`,
  );
  const pasteResult = JSON.parse(pasteLine.slice("COMPOSER_PASTE_PROBE ".length));
  console.log("COMPOSER_PASTE_PROBE " + JSON.stringify(pasteResult));
  assert.equal(firstRun.code, 0, firstRun.output.slice(-4000));
  assert.equal(pasteResult.ok, true);

  if (fileReferencesOnly) {
    assert.equal(pasteResult.largeFileReference, true);
    assert.equal(pasteResult.metadataHistory, true);
    assert.equal(pasteResult.refreshedSize, true);
    const restarted = await runElectron(["--file-references-history-check"]);
    const line = restarted.output.split(/\r?\n/).find(line => line.startsWith("COMPOSER_PASTE_PROBE "));
    assert.equal(restarted.code, 0, restarted.output.slice(-4000));
    assert(line, "reference history restart returned no result");
    const restored = JSON.parse(line.slice("COMPOSER_PASTE_PROBE ".length));
    assert.equal(restored.ok, true);
    assert.equal(restored.processRestartMetadata, true);
    console.log("COMPOSER_FILE_REFERENCES_RESTART " + JSON.stringify(restored));
  } else if (screenshotOnly) {
    assert.equal(pasteResult.screenshotWithoutDirectoryScan, true);
    assert.equal(pasteResult.nativeImagePreserved, true);
  } else if (!directoriesOnly) {
    const restartRun = await runElectron(["--history-check"]);
    const restartLine = restartRun.output
      .split(/\r?\n/)
      .find((line) => line.startsWith("COMPOSER_HISTORY_RESTART "));
    assert(
      restartLine,
      `renderer returned no restart result (exit=${restartRun.code}): ${restartRun.output.slice(-3000)}`,
    );
    const restartResult = JSON.parse(restartLine.slice("COMPOSER_HISTORY_RESTART ".length));
    console.log("COMPOSER_HISTORY_RESTART " + JSON.stringify(restartResult));
    assert.equal(restartRun.code, 0, restartRun.output.slice(-4000));
    assert.equal(restartResult.ok, true);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
