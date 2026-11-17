import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import vm from "node:vm";
import ts from "typescript";
import { importComposerFiles } from "../electron/main/composer-paste.ts";
import { referenceComposerFiles } from "../electron/main/composer-file-references.ts";
import { consumeComposerPickerSelection, rememberComposerPickerSelection } from "../electron/main/composer-picker.ts";

function importHandler(dataDir, session) {
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
  return vm.runInNewContext(code, {
    host: { call: async () => ({ session }) }, dataDir,
    assertMainWindowSender: event => assert.equal(event.sender.id, 1),
    consumeComposerPickerSelection, referenceComposerFiles, importComposerFiles,
    importComposerSelection: async (...args) => (await import("../electron/main/composer-file-import.ts")).importComposerSelection(...args),
    ErrorCodes: { NOT_FOUND: "NOT_FOUND", INVALID_ARGUMENT: "INVALID_ARGUMENT" },
  });
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "composer-import-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "data"), project = join(root, "project");
  await Promise.all([data, project].map(path => mkdir(path)));
  const large = join(root, "large 中文 file.bin");
  const file = await open(large, "w");
  await file.truncate(64 * 1024 * 1024 + 1);
  await file.close();
  const image = join(root, "image.png"), small = join(root, "small.txt");
  await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6kUAAAAAASUVORK5CYII=", "base64"));
  await writeFile(small, "small content");
  return { data, project, large, image, small };
}

function select(handler, paths, reference = "auto") {
  return handler({ sender: { id: 1 } }, {
    sessionId: "source", token: rememberComposerPickerSelection(paths, 1), reference,
  });
}

test("automatic native selection references large and small files while retaining image attachments in order", async t => {
  const { data, project, large, image, small } = await fixture(t);
  const handler = importHandler(data, { projectPath: project });
  const { files } = await select(handler, [large, image, small]);
  assert.deepEqual(Array.from(files, file => file.kind), ["file", "image", "file"]);
  assert.equal(files[0].path, large);
  assert.equal(files[0].size, 67108865);
  assert.ok(files[0].localReference);
  assert.equal(files[2].path, small);
  assert.ok(files[2].localReference);
  assert.equal(files[1].localReference, undefined);
  assert.notEqual(files[1].path, image);
  assert.deepEqual(await readFile(files[1].path), await readFile(image));
});

test("automatic import preserves copy semantics without a local project and for remote sessions", async t => {
  const { data, project, small } = await fixture(t);
  for (const session of [{}, { projectPath: project, remoteWorkspace: { hostKey: "remote" } }]) {
    const { files } = await select(importHandler(data, session), [small]);
    assert.notEqual(files[0].path, small);
    assert.equal(files[0].localReference, undefined);
    assert.equal(await readFile(files[0].path, "utf8"), "small content");
  }
});

test("legacy copy and reference modes retain their explicit behavior", async t => {
  const { data, project, image, small } = await fixture(t);
  const handler = importHandler(data, { projectPath: project });
  const copied = await select(handler, [small], false);
  assert.notEqual(copied.files[0].path, small);
  const referenced = await select(handler, [image], true);
  assert.equal(referenced.files[0].path, image);
  assert.equal(referenced.files[0].kind, "file");
});
