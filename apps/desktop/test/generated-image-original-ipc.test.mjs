import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";
import * as hostRuntime from "@pi-desktop/host-runtime";
import * as generated from "../electron/main/generated-image-preview.ts";
import * as remoteScope from "../electron/main/remote/workspace-file-scope.ts";

const require = createRequire(import.meta.url);
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

test("image IPC routes original reads only to the owning local session scratch", async (t) => {
  const base = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "image-original-ipc-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const scratch = join(base, "scratch", "local"), other = join(base, "scratch", "other");
  await mkdir(scratch, { recursive: true }); await mkdir(other, { recursive: true });
  const path = join(scratch, "image.png"), otherPath = join(other, "image.png");
  const bytes = Buffer.concat([pixel, Buffer.alloc(5 * 1024 * 1024)]);
  await writeFile(path, bytes); await writeFile(otherPath, pixel);
  const source = await readFile(new URL("../electron/main/ipc/workspace-ipc.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source.replaceAll("import.meta.url", JSON.stringify(import.meta.url)), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} }, handlers = new Map(), calls = [];
  new Function("require", "exports", "module", code)(id => {
    if (id.startsWith("node:")) return require(id);
    if (id === "@pi-desktop/shared") return shared;
    if (id === "@pi-desktop/host-runtime") return hostRuntime;
    if (id === "../generated-image-preview") return generated;
    if (id === "../remote/workspace-file-scope") return remoteScope;
    if (id === "electron") return { nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) }) } };
    if (id === "./sidebar-preferences-ipc") return { registerSidebarPreferencesIpc() {} };
    return {};
  }, module.exports, module);
  const host = { async call(method, input) {
    calls.push([method, input]);
    if (method === "session.get") return { session: input.id === "unknown" ? undefined : { projectPath: input.id === "remote" ? "remote-project:x" : undefined, remoteWorkspace: input.id === "remote-property" ? { hostKey: "remote" } : undefined } };
    if (method === "project.groups.list") return { groups: [{ primaryPath: "remote-project:x", remote: { hostId: "remote" } }] };
    if (method === "session.getScratchPath") return { path: input.sessionId === "local" ? scratch : other };
    throw new Error(`unexpected host RPC ${method}`);
  } };
  module.exports.registerWorkspaceIpc({
    registrar: { handle: (channel, fn) => handlers.set(channel, fn), handleWithEvent() {}, assertMainWindowSender() {} },
    getHost: () => host, getSidecar: () => null, dataDir: base, currentWorkspacePath: () => null,
  });
  const read = handlers.get(shared.IPC.invoke.fsReadImageDataUrl);
  const result = await read({ ref: path, sessionId: "local", mimeType: "image/png", generatedOriginal: true, allowThumbnail: true });
  assert.equal(result.kind, "image");
  assert.deepEqual(Buffer.from(result.dataUrl.split(",")[1], "base64"), bytes);
  assert.equal(result.isThumbnail, undefined);
  assert.ok(calls.some(([method, input]) => method === "session.getScratchPath" && input.sessionId === "local"));
  assert.equal((await read({ ref: path, sessionId: "other", generatedOriginal: true })).kind, "missing");
  assert.equal((await read({ ref: otherPath, sessionId: "remote", generatedOriginal: true })).kind, "missing");
  assert.equal((await read({ ref: otherPath, sessionId: "remote-property", generatedOriginal: true })).kind, "missing");
  assert.equal((await read({ ref: otherPath, sessionId: "remote:host:session", generatedOriginal: true })).kind, "missing");
  assert.equal((await read({ ref: path, sessionId: "unknown", generatedOriginal: true })).kind, "missing");
  assert.equal((await read({ ref: path, sessionId: "native-pi:x", generatedOriginal: true })).kind, "missing");
  assert.equal((await read({ ref: path, generatedOriginal: true })).kind, "missing");
  assert.equal((await read({ ref: path, sessionId: "local" })).kind, "tooLarge");
});
