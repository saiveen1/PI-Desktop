import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pasteComposerClipboardFiles, referenceComposerFiles, resolveComposerFileReference } from "../electron/main/composer-file-references.ts";
import { importComposerSelection } from "../electron/main/composer-file-import.ts";
import { preparePromptAttachments, appendPromptFallbackPaths } from "../electron/main/prompt-attachments.ts";
import { appendLocalFileReferenceContext } from "@pi-desktop/shared";
import { consumeComposerPickerSelection, rememberComposerPickerSelection } from "../electron/main/composer-picker.ts";
import { createLinkOrSkip } from "./helpers/link-fixture.mjs";
import { readFile } from "node:fs/promises";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-file-reference-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "data"), project = join(root, "project"), other = join(root, "other");
  await Promise.all([data, project, other].map(path => mkdir(path)));
  const path = join(root, "outside project & 中文.bin");
  const file = await open(path, "w");
  await file.truncate(64 * 1024 * 1024 + 1);
  await file.close();
  return { root, data, project, other, path };
}

test("large disk file becomes metadata, survives a new session, and refreshes size on send", async t => {
  const { data, project, path } = await fixture(t);
  const [reference] = await referenceComposerFiles(data, "source", project, [path]);
  assert.equal(reference.path, path);
  assert.equal(reference.size, 67108865);
  assert.equal(reference.kind, "file");
  assert.deepEqual(await readdir(data), ["composer-file-references"], "no scratch copy or content-addressed blob");
  await writeFile(path, "changed");
  const [prepared] = await preparePromptAttachments(data, "restored", project, [{ ...reference, size: 1 }], true, `Review @"${path}"`);
  assert.equal(prepared.message.size, 7, "renderer size is not authoritative");
  assert.equal(prepared.message.localReference, reference.localReference);
  assert.equal(prepared.inlineData, undefined);
  const prompt = appendPromptFallbackPaths("Review", [prepared]);
  assert.ok(prompt.includes(path));
  assert.ok(prompt.includes("7 bytes"));
  assert.equal(appendLocalFileReferenceContext(prompt, [{ ...prepared.message, path }]), prompt, "history replay is idempotent");
  assert.deepEqual(await readdir(data), ["composer-file-references"]);
});

test("disk metadata and project line ranges remain distinct in a mixed prompt", async t => {
  const { data, project, path } = await fixture(t);
  const [reference] = await referenceComposerFiles(data, "source", project, [path]);
  const source = join(project, "gpt.py");
  await writeFile(source, "first\nsecond\n");
  const line = { kind: "file", path: source, name: "gpt.py", lineRange: { start: 1, end: 2 } };
  const prepared = await preparePromptAttachments(data, "source", project, [reference, line], false, "Compare");
  assert.equal(prepared.length, 2);
  assert.equal(prepared[0].message.localReference, reference.localReference);
  assert.equal(prepared[0].message.size, 67108865);
  assert.deepEqual(prepared[1].message.lineRange, line.lineRange);
  const prompt = appendPromptFallbackPaths("Compare", prepared);
  assert.ok(prompt.includes("67108865 bytes"));
  assert.ok(!prompt.includes(source), "line ranges are resolved by the scoped runtime Read");
  assert.deepEqual(await readdir(data), ["composer-file-references"]);
  for (const attachment of [{ ...reference, lineRange: line.lineRange }, { ...line, localReference: reference.localReference }]) {
    await assert.rejects(preparePromptAttachments(data, "source", project, [attachment], false, "Inspect"), { errorCode: "INVALID_ARGUMENT" });
  }
});
test("selection records reject forged paths, another project, remote context, and missing files", async t => {
  const { data, project, other, path, root } = await fixture(t);
  const [reference] = await referenceComposerFiles(data, "source", project, [path]);
  const resolve = (projectPath, source = path, id = reference.localReference) => resolveComposerFileReference(data, projectPath, source, id);
  await assert.rejects(resolve(other), /does not belong/);
  await assert.rejects(resolve(undefined), /unavailable/);
  await assert.rejects(resolve(project, path, "../../escape"), /unavailable/);
  await assert.rejects(resolve(project, join(root, "forged")), /does not belong/);
  const moved = join(root, "moved.bin");
  await rename(path, moved);
  await assert.rejects(resolve(project), /Referenced file is unavailable/);
});

test("selection records reject a file replaced by a symbolic link", async t => {
  const { data, project, path, root } = await fixture(t);
  const [reference] = await referenceComposerFiles(data, "source", project, [path]);
  const moved = join(root, "moved.bin");
  await rename(path, moved);
  if (!await createLinkOrSkip(t, moved, path)) return;
  await assert.rejects(resolveComposerFileReference(data, project, path, reference.localReference), /Referenced file is unavailable/);
});

test("a reference to an image remains metadata and never hydrates outside-project image bytes", async t => {
  const { data, project, path } = await fixture(t);
  const image = path + ".png";
  await rename(path, image);
  const [reference] = await referenceComposerFiles(data, "source", project, [image]);
  const [prepared] = await preparePromptAttachments(data, "source", project, [reference], true, "Inspect");
  assert.equal(prepared.message.kind, "file");
  assert.equal(prepared.inlineData, undefined);
  await assert.rejects(preparePromptAttachments(data, "source", project, [{ ...reference, localReference: undefined }], true, "Inspect"), /outside the session roots/);
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNo2PDgPwAG1AMQ/5r/oAAAAABJRU5ErkJggg==", "base64");

test("automatic native intake preserves projectless file provenance and snapshots images", async t => {
  const { root, data, path } = await fixture(t);
  const image = join(root, "screenshot.png");
  await writeFile(image, PNG);
  const files = await importComposerSelection(data, "source", undefined, [path, image]);
  assert.equal(files[0].path, path);
  assert.ok(files[0].localReference);
  assert.equal(files[1].kind, "image");
  assert.equal(files[1].localReference, undefined);
  await rm(image);
  const prepared = await preparePromptAttachments(data, "source", undefined, files, true, "Inspect");
  assert.equal(prepared[0].message.size, 67108865);
  assert.ok(prepared[1].inlineData);
  await assert.rejects(preparePromptAttachments(data, "other", undefined, [files[0]], false, "Inspect"), /does not belong/);
});

test("native clipboard images are copied like picker imports while other files stay live references (#2529)", async t => {
  const { root, data, project, path } = await fixture(t);
  const image = join(root, "PixPin_2026-11-23_14-37-54.png");
  const notes = join(root, "notes.txt");
  await writeFile(image, PNG);
  await writeFile(notes, "notes");
  const files = await pasteComposerClipboardFiles(data, "source", project, [notes, image, path]);
  assert.deepEqual(files.map(file => file.name), ["notes.txt", "PixPin_2026-11-23_14-37-54.png", "outside project & 中文.bin"], "paste order is preserved");
  assert.equal(files[0].localReference !== undefined, true);
  assert.equal(files[2].localReference !== undefined, true);
  const [, pasted] = files;
  assert.equal(pasted.kind, "image");
  assert.equal(pasted.localReference, undefined);
  assert.equal(pasted.size, PNG.length);
  assert.ok(pasted.path.startsWith(join(data, "scratch", "source", "pasted")), "image is materialized in session scratch");
  assert.deepEqual(readFileSync(pasted.path), PNG);
  // The screenshot tool may clear its temp file before the user sends.
  await rm(image);
  const prepared = await preparePromptAttachments(data, "source", project, files, true, "What is in this screenshot?");
  assert.equal(prepared[1].message.kind, "image");
  assert.ok(prepared[1].inlineData, "vision models receive the image bytes");
  assert.match(prepared[1].message.ref, /^attachments\/[0-9a-f]{64}$/);
  assert.equal(prepared[0].inlineData, undefined);
  assert.equal(prepared[2].inlineData, undefined);
});

test("native clipboard images beyond the import bounds, SVGs, and non-images keep the reference flow", async t => {
  const { root, data, project } = await fixture(t);
  const large = join(root, "huge.png");
  const handle = await open(large, "w");
  await handle.truncate(64 * 1024 * 1024 + 1);
  await handle.close();
  const svg = join(root, "icon.svg");
  await writeFile(svg, "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  const batch = [];
  for (let index = 0; index < 3; index++) {
    const part = join(root, `part-${index}.png`);
    const file = await open(part, "w");
    await file.truncate(60 * 1024 * 1024);
    await file.close();
    batch.push(part);
  }
  const files = await pasteComposerClipboardFiles(data, "source", project, [large, svg, ...batch]);
  assert.deepEqual(files.map(file => file.localReference !== undefined), [true, true, false, false, true], "the batch byte budget overflows to references");
  assert.deepEqual(files.map(file => file.kind), ["file", "file", "image", "image", "file"]);
});

test("native clipboard images paste without a local project; other files still require one", async t => {
  const { root, data } = await fixture(t);
  const image = join(root, "remote.png");
  await writeFile(image, PNG);
  const [pasted] = await pasteComposerClipboardFiles(data, "source", undefined, [image]);
  assert.equal(pasted.kind, "image");
  await writeFile(join(root, "notes.txt"), "notes");
  await assert.rejects(pasteComposerClipboardFiles(data, "source", undefined, [image, join(root, "notes.txt")]), /require a local project/);
  await assert.rejects(pasteComposerClipboardFiles(data, "source", undefined, [join(root, "missing.png")]));
});

test("native selection IPC binds sender and session before registering and dispatching a large reference", async t => {
  const { data, project, path } = await fixture(t);
  const source = readFileSync(new URL("../electron/main/ipc/workspace-ipc.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("workspace.ts", source, ts.ScriptTarget.Latest, true);
  let callback;
  function visit(node) {
    if (ts.isCallExpression(node) && node.arguments[0]?.getText(tree) === "IPC.invoke.composerImportFiles") callback = node.arguments[1];
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(callback);
  const code = ts.transpileModule(`(${callback.getText(tree)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const sessions = { source: { projectPath: project }, remote: { projectPath: project, remoteWorkspace: { id: "remote" } } };
  const host = { call: async (_method, input) => ({ session: sessions[input.id] ?? null }) };
  const handler = vm.runInNewContext(code, {
    host, getHost: () => host, dataDir: data,
    assertMainWindowSender: event => assert.equal(event.sender.id, 1, "main sender required"),
    consumeComposerPickerSelection, referenceComposerFiles, importComposerSelection,
    importComposerFiles: () => assert.fail("native clipboard files must not use the picker importer directly"),
    ErrorCodes: { NOT_FOUND: "NOT_FOUND", INVALID_ARGUMENT: "INVALID_ARGUMENT" },
  });
  const input = { sessionId: "source", token: rememberComposerPickerSelection([path], 1), reference: true };
  await assert.rejects(handler({ sender: { id: 2 } }, input), /main sender/);
  await assert.rejects(handler({ sender: { id: 1 } }, { ...input, sessionId: "deleted" }), /session not found/);
  const { files } = await handler({ sender: { id: 1 } }, input);
  assert.equal(files[0].path, path);
  assert.equal(files[0].size, 67108865);
  await assert.rejects(handler({ sender: { id: 1 } }, input), /selection is unavailable/);
  const remote = { sessionId: "remote", token: rememberComposerPickerSelection([path], 1), reference: true };
  await assert.rejects(handler({ sender: { id: 1 } }, remote), /remote sessions/);
  const [prepared] = await preparePromptAttachments(data, "source", project, files, false, "Inspect");
  assert.equal(prepared.message.size, 67108865);
  assert.ok(appendPromptFallbackPaths("Inspect", [prepared]).includes("67108865 bytes"));
  assert.deepEqual(await readdir(data), ["composer-file-references"]);
});

test("projectless records persist session ownership without snapshots and reject forged scopes", async t => {
  const { data, path, project } = await fixture(t);
  const [reference] = await referenceComposerFiles(data, "source", undefined, [path]);
  const recordPath = join(data, "composer-file-references", `${reference.localReference}.json`);
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  assert.deepEqual(record, { version: 2, scope: "session", path, sessionId: "source" });
  assert.deepEqual(await readdir(data), ["composer-file-references"]);
  const resolve = (sessionId, projectPath) => resolveComposerFileReference(data, projectPath, path, reference.localReference, sessionId);
  assert.equal((await resolve("source")).size, 67108865);
  assert.equal((await resolve("source", project)).path, path, "binding a project later retains the same session's reference");
  await assert.rejects(resolve("other"), /does not belong/);
  await assert.rejects(resolve("other", project), /does not belong/);
  await assert.rejects(resolve(undefined), /does not belong/);
  for (const changed of [{ ...record, version: 99 }, { ...record, scope: "project" }, { ...record, sessionId: undefined }]) {
    await writeFile(recordPath, JSON.stringify(changed));
    await assert.rejects(resolve("source"), /does not belong/);
  }
  await writeFile(recordPath, JSON.stringify(record));
  await writeFile(path, "updated");
  assert.equal((await resolve("source")).size, 7);
  await rm(path);
  await assert.rejects(resolve("source"), /Referenced file is unavailable/);
});

test("existing project records keep version 1 and same-project cross-session compatibility", async t => {
  const { data, path, project } = await fixture(t);
  const [reference] = await referenceComposerFiles(data, "source", project, [path]);
  const record = JSON.parse(await readFile(join(data, "composer-file-references", `${reference.localReference}.json`), "utf8"));
  assert.deepEqual(record, { version: 1, path, projectPath: project, sessionId: "source" });
  assert.equal((await resolveComposerFileReference(data, project, path, reference.localReference, "other")).path, path);
  await assert.rejects(preparePromptAttachments(data, "source", project, [reference], true, "Inspect", true), /remote/);
});

test("normal prompt and steering wiring pass local session ownership and remote rejection", async t => {
  const { data, path } = await fixture(t);
  const [reference] = await referenceComposerFiles(data, "source", undefined, [path]);
  const source = readFileSync(new URL("../electron/main/ipc/agent-ipc.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("agent-ipc.ts", source, ts.ScriptTarget.Latest, true);
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "preparePromptAttachments") calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.equal(calls.length, 2, "cover both normal and steering dispatch");
  for (const call of calls) {
    for (const remote of [false, true]) {
      const remoteWorkspace = remote ? { hostKey: "remote" } : undefined;
      const args = vm.runInNewContext(`[${call.arguments.map(arg => arg.getText(tree)).join(",")}]`, {
        dataDir: data, req: { sessionId: "source", attachments: [reference] },
        session: { remoteWorkspace }, context: { remoteWorkspace, supportsVision: true },
        localProjectPath: undefined, supportsVision: true, steerContent: "Inspect", promptContent: "Inspect",
      });
      assert.equal(args[6], remote);
      if (remote) await assert.rejects(preparePromptAttachments(...args), /remote/);
      else assert.equal((await preparePromptAttachments(...args))[0].message.size, 67108865);
    }
  }
});
