import { readTranscriptSource, readMainSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as settle } from "node:timers/promises";
import ts from "typescript";
import { MAX_IMAGE_BYTES, readOpenableImage } from "@pi-desktop/host-runtime";
import { readGeneratedImagePreview } from "../electron/main/generated-image-preview.ts";
import { sessionAllows } from "../src/lib/remote-session-safety.ts";
import * as hooks from "./helpers/react-hook-stub.mjs";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { api } = await import("../src/lib/api.ts");
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [transcript, markdown, main, panel, protocol, hook] = await Promise.all([
  readTranscriptSource(),
  read("../src/components/Markdown.tsx"),
  readMainSource(),
  read("../../../packages/host-runtime/src/workspace-files.ts"),
  read("../../../packages/shared/src/protocol.ts"),
  read("../src/lib/use-referenced-image-data-url.ts"),
]);

function preload(t, invoke) {
  const prior = globalThis.window;
  globalThis.window = { piDesktop: { invoke } };
  t.after(() => { if (prior) globalThis.window = prior; else delete globalThis.window; });
}

test("in-chat image display has a contained renderer-to-main bridge", async (t) => {
  assert.match(protocol, /fsReadImageDataUrl: "pi-desktop\/fs\/readImageDataUrl"/);
  assert.match(main, /IPC\.invoke\.fsReadImageDataUrl/);
  assert.match(main, /readOpenableImage\(/);
  assert.match(panel, /export async function readOpenableImage\(/);
  assert.match(panel, /isAttachmentBlobRef/);
  assert.match(panel, /ALLOWED_IMAGE_MIME/);
  assert.match(panel, /MAX_IMAGE_BYTES/);
  assert.doesNotMatch(panel, /info\.isFile\(\) \? trimmed : null/);

  const base = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "message-image-display-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace"), outside = join(base, "elsewhere");
  await mkdir(root); await mkdir(outside);
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const large = Buffer.alloc(MAX_IMAGE_BYTES + 1); pixel.copy(large);
  await writeFile(join(root, "result.png"), large);
  const payloads = []; let resizes = 0;
  preload(t, async (channel, payload) => {
    assert.equal(channel, "pi-desktop/fs/readImageDataUrl"); payloads.push(payload);
    const data = payload.allowThumbnail ? await readGeneratedImagePreview(payload.ref, root, [], payload.mimeType,
      () => { resizes++; return pixel; }) : await readOpenableImage(payload.ref, root, [], payload.mimeType);
    return { ok: true, data };
  });
  assert.equal((await api.fsReadImageDataUrl("result.png")).kind, "tooLarge");
  assert.equal((await api.fsReadImageDataUrl("result.png", "image/png", "pane")).kind, "tooLarge");
  assert.equal((await api.fsReadImageDataUrl("result.png", "image/png", "pane", true)).isThumbnail, true);
  assert.deepEqual(payloads, [{ ref: "result.png" }, { ref: "result.png", mimeType: "image/png", sessionId: "pane" },
    { ref: "result.png", mimeType: "image/png", sessionId: "pane", allowThumbnail: true }]);
  await rename(join(root, "result.png"), join(outside, "result.png"));
  const denied = [join(outside, "result.png"), join(outside, "absent.png")];
  try {
    await symlink(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    denied.push("link/result.png", "link/absent.png");
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS"].includes(error.code)) throw error;
    t.diagnostic("Directory-link checks unavailable on this filesystem");
  }
  for (const allowThumbnail of [undefined, true]) {
    const readImage = ref => api.fsReadImageDataUrl(ref, "image/png", "pane", allowThumbnail);
    assert.deepEqual(await readImage("result.png"), { kind: "missing", errorCode: "FILE_NOT_FOUND" });
    for (const ref of denied) assert.deepEqual(await readImage(ref), { kind: "missing", errorCode: "PATH_OUTSIDE_ALLOWED_ROOT" });
  }
  assert.equal(resizes, 1, "absent and restricted images must not reach the decoder");
});

test("renderer hook loads referenced image data URLs with a scoped bounded cache", async (t) => {
  let sessionId = "pane-a", ref = "result.png";
  const store = { workspace: { path: "workspace" }, sessions: [] };
  const imports = { react: hooks, "./remote-session-safety": { sessionAllows }, "./api": { api },
    "../plugins/renderer-slots/use-slots": { useSlotSessionId: () => sessionId },
    "../stores/app-store": { useAppStore: select => select(store) } };
  const exports = {};
  const { outputText } = ts.transpileModule(hook, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  new Function("require", "exports", outputText)(id => { assert.ok(Object.hasOwn(imports, id)); return imports[id]; }, exports);
  const render = () => exports.useReferencedImageDataUrl(ref, "image/png");
  const view = () => hooks.__render(render);
  const calls = []; const small = "data:image/png;base64,AA==";
  let result = { kind: "image", dataUrl: small };
  preload(t, async (_channel, input) => { calls.push(input); return { ok: true, data: result }; });
  assert.equal(hooks.__mount(render), null); await settle(); assert.equal(view(), small);
  assert.deepEqual(calls, [{ ref, mimeType: "image/png", sessionId }]);
  sessionId = "pane-b"; result = { kind: "notImage" };
  assert.equal(view(), null); await settle(); assert.equal(view(), null);
  sessionId = "pane-a"; assert.equal(view(), small);
  for (ref of ["https://invalid.test/file.png", small, "blob:invalid"]) assert.equal(view(), null);
  assert.equal(calls.length, 2);

  // Exceed each bound independently; the oldest preview must need a new read.
  for (const [count, dataUrl] of [[51, small], [10, "data:image/png;base64," + "A".repeat(4 * 1024 * 1024)]]) {
    result = { kind: "image", dataUrl };
    for (let i = 0; i < count; i++) {
      ref = `gallery-${count}-${i}.png`; assert.equal(view(), null); await settle(); assert.ok(view() === dataUrl);
    }
    const before = calls.length; ref = `gallery-${count}-0.png`;
    assert.equal(view(), null); await settle(); assert.equal(calls.length, before + 1);
  }
});

test("user message image attachments render as chips with a hover card", () => {
  assert.match(transcript, /function MessageAttachmentImage\(/);
  assert.match(transcript, /useReferencedImageDataUrl\(attachment\.ref, attachment\.mimeType\)/);
  assert.match(transcript, /className="message-attachment-image-chip"/);
  assert.match(transcript, /role="listitem"/);
  assert.match(transcript, /onOpen=\{onOpenFile\}/);
  // One shared preview card serves the draft and the transcript.
  assert.match(
    transcript,
    /import \{ ImageHoverCard, type ImageHoverAnchor \} from "\.\.\/\.\.\/\.\.\/components\/ImageHoverCard";/,
  );
  assert.match(transcript, /<ImageHoverCard src=\{dataUrl\} anchor=\{anchor\} onDismiss=\{dismiss\} \/>/);
  assert.match(
    transcript,
    /attachment\.kind === "image" \?/,
  );
});

test("local markdown images render inline with a chip fallback", () => {
  assert.match(markdown, /useReferencedImageDataUrl\(isRemote \? null : localRef\)/);
  assert.match(markdown, /className="chat-image-local"/);
  assert.match(markdown, /className="chat-image-chip"/);
  assert.match(markdown, /attachmentRef/);
});
