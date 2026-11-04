/**
 * "Save a copy" of a chat/workspace file (`pi-desktop/fs/saveAs`).
 *
 * The contract under test is Electron Main's `saveFileAs`, driven against real
 * files in a scratch directory and a mock native dialog. The dialog is the one
 * real boundary (a user choosing a destination); containment, validation,
 * byte-exact copying, and source preservation all run in production code.
 *
 * Every case asserts the observable promise: what ended up on disk, whether the
 * dialog was even shown, and which classified error came back.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveFileAs } from "../electron/main/fs-save-as.ts";
import { resolveRealOpenablePath } from "../../../packages/host-runtime/src/workspace-files.ts";

/** A real workspace root plus the containment main uses for `fs/open`. */
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "pi-save-as-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "workspace");
  const outside = join(base, "outside");
  const destinationDir = join(base, "destination");
  await Promise.all([mkdir(workspace), mkdir(outside), mkdir(destinationDir)]);
  const containment = (ref) => resolveRealOpenablePath(ref, workspace, []);
  return { base, workspace, outside, destinationDir, containment };
}

/** A dialog that always answers with `filePath` (or a dismissal). */
function dialog(filePath) {
  const calls = [];
  return {
    calls,
    show: async (options) => {
      calls.push(options);
      return filePath === undefined ? { canceled: true } : { canceled: false, filePath };
    },
  };
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

test("canceling the dialog writes nothing and does not touch the source", async (t) => {
  const { workspace, containment } = await fixture(t);
  const source = join(workspace, "notes.md");
  await writeFile(source, "keep me");
  const dialogCalls = dialog();
  let copied = 0;

  const result = await saveFileAs("notes.md", {
    resolveSource: containment,
    showSaveDialog: dialogCalls.show,
    copyFile: async () => {
      copied += 1;
    },
  });

  assert.deepEqual(result, { canceled: true });
  assert.equal(copied, 0);
  assert.equal(dialogCalls.calls.length, 1);
  // The dialog was seeded with the source's own name, never a destination.
  assert.equal(dialogCalls.calls[0].defaultPath, "notes.md");
  assert.equal(await readFile(source, "utf8"), "keep me");
});

test("a binary file is copied byte-for-byte and the source survives", async (t) => {
  const { workspace, destinationDir, containment } = await fixture(t);
  const source = join(workspace, "capture.bin");
  // Every byte value, including NUL runs and invalid UTF-8 sequences: a text
  // preview or a string roundtrip would not survive this.
  const bytes = Buffer.alloc(64 * 1024);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;
  await writeFile(source, bytes);
  const before = await stat(source);
  const destination = join(destinationDir, "copy.bin");

  const result = await saveFileAs("capture.bin", {
    resolveSource: containment,
    showSaveDialog: dialog(destination).show,
  });

  assert.deepEqual(result, { canceled: false });
  const written = await readFile(destination);
  assert.equal(written.length, bytes.length);
  assert.equal(sha256(written), sha256(bytes));
  const after = await stat(source);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("a file larger than the text-preview cap copies completely", async (t) => {
  const { workspace, destinationDir, containment } = await fixture(t);
  const source = join(workspace, "large.log");
  // MAX_TEXT_BYTES is 512KB; anything copied through the preview path would
  // come back as `tooLarge` instead of the real bytes.
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 7, 0x61);
  bytes.write("tail-marker", bytes.length - "tail-marker".length);
  await writeFile(source, bytes);
  const destination = join(destinationDir, "large.log");

  await saveFileAs("large.log", {
    resolveSource: containment,
    showSaveDialog: dialog(destination).show,
  });

  const written = await readFile(destination);
  assert.equal(written.length, bytes.length);
  assert.equal(sha256(written), sha256(bytes));
  assert.equal(written.subarray(-"tail-marker".length).toString(), "tail-marker");
});

test("an unreadable or missing reference fails before any dialog appears", async (t) => {
  const { workspace, containment } = await fixture(t);
  await writeFile(join(workspace, "present.txt"), "x");
  const shown = [];
  const deps = (ref) => ({
    resolveSource: (value) => containment(value),
    showSaveDialog: async () => {
      shown.push(ref);
      return { canceled: true };
    },
  });

  await assert.rejects(
    saveFileAs("missing.txt", deps("missing.txt")),
    (error) => error.errorCode === "INVALID_ARGUMENT",
  );
  // An absolute path outside every allowed root is not readable at all.
  await assert.rejects(
    saveFileAs("../../etc/passwd", deps("escape")),
    (error) => error.errorCode === "INVALID_ARGUMENT",
  );
  await assert.rejects(
    saveFileAs("", deps("empty")),
    (error) => error.errorCode === "INVALID_ARGUMENT",
  );
  // An empty reference, a missing file, and an escape all skip the dialog.
  assert.deepEqual(shown, []);
});

test("a directory source is rejected before the dialog", async (t) => {
  const { workspace, containment } = await fixture(t);
  await mkdir(join(workspace, "folder"));
  let shown = 0;

  await assert.rejects(
    saveFileAs("folder", {
      resolveSource: containment,
      showSaveDialog: async () => {
        shown += 1;
        return { canceled: true };
      },
    }),
    (error) => error.errorCode === "INVALID_ARGUMENT" && /regular file/.test(error.message),
  );
  assert.equal(shown, 0);
});

test("the source is revalidated after the dialog returns", async (t) => {
  const { workspace, destinationDir, containment } = await fixture(t);
  const source = join(workspace, "volatile.txt");
  await writeFile(source, "first");
  const destination = join(destinationDir, "volatile.txt");
  let resolvable = true;

  // The user leaves the dialog open; meanwhile the file is replaced by a
  // different file that now answers the same reference.
  const result = saveFileAs("volatile.txt", {
    resolveSource: async (ref) => {
      if (!resolvable) return null;
      return containment(ref);
    },
    showSaveDialog: async () => {
      resolvable = false;
      await rm(source, { force: true });
      return { canceled: false, filePath: destination };
    },
  });

  await assert.rejects(result, (error) => error.errorCode === "INVALID_ARGUMENT");
  await assert.rejects(stat(destination), { code: "ENOENT" });
});

test("a source whose identity changes while the dialog is open fails with CONFLICT", async (t) => {
  const { workspace, destinationDir, containment } = await fixture(t);
  const source = join(workspace, "swapped.txt");
  await writeFile(source, "original");
  const destination = join(destinationDir, "swapped.txt");

  let swapped = false;
  const result = saveFileAs("swapped.txt", {
    resolveSource: async (ref) => {
      if (!swapped) return containment(ref);
      // A second path under the same reference spelling: same name, different
      // file, so a copy must not proceed under the stale verdict.
      return join(workspace, "elsewhere.txt");
    },
    showSaveDialog: async () => {
      swapped = true;
      await writeFile(join(workspace, "elsewhere.txt"), "replacement");
      return { canceled: false, filePath: destination };
    },
  });

  await assert.rejects(result, (error) => error.errorCode === "CONFLICT");
  await assert.rejects(stat(destination), { code: "ENOENT" });
});

test("saving onto the source path is refused and the original keeps its bytes", async (t) => {
  const { workspace, containment } = await fixture(t);
  const source = join(workspace, "same.txt");
  await writeFile(source, "irreplaceable");

  await assert.rejects(
    saveFileAs("same.txt", {
      resolveSource: containment,
      showSaveDialog: dialog(source).show,
    }),
    (error) => error.errorCode === "INVALID_ARGUMENT" && /source/.test(error.message),
  );
  assert.equal(await readFile(source, "utf8"), "irreplaceable");
});

test("a link that resolves to the source is refused as a self-overwrite", async (t) => {
  const { workspace, destinationDir, containment } = await fixture(t);
  const source = join(workspace, "linked.txt");
  await writeFile(source, "still here");
  const linkPath = join(destinationDir, "alias.txt");
  try {
    await symlink(source, linkPath, "file");
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
    // Windows without developer mode cannot create a symlink. A hard link is
    // the same hazard (another name for the source inode), so it keeps the
    // case meaningful instead of skipping the guard entirely.
    await link(source, linkPath);
  }

  await assert.rejects(
    saveFileAs("linked.txt", {
      resolveSource: containment,
      showSaveDialog: dialog(linkPath).show,
    }),
    (error) => error.errorCode === "INVALID_ARGUMENT" && /source/.test(error.message),
  );
  assert.equal(await readFile(source, "utf8"), "still here");
});

test("a destination that is not a regular file is refused", async (t) => {
  const { workspace, destinationDir, containment } = await fixture(t);
  await writeFile(join(workspace, "src.txt"), "data");
  const directoryDestination = join(destinationDir, "subdir");
  await mkdir(directoryDestination);

  await assert.rejects(
    saveFileAs("src.txt", {
      resolveSource: containment,
      showSaveDialog: dialog(directoryDestination).show,
    }),
    (error) => error.errorCode === "INVALID_ARGUMENT" && /destination/.test(error.message),
  );
});

test("a non-absolute dialog answer is rejected instead of writing elsewhere", async (t) => {
  const { workspace, containment } = await fixture(t);
  await writeFile(join(workspace, "rel.txt"), "data");

  await assert.rejects(
    saveFileAs("rel.txt", {
      resolveSource: containment,
      showSaveDialog: async () => ({ canceled: false, filePath: "relative/copy.txt" }),
    }),
    (error) => error.errorCode === "INVALID_ARGUMENT",
  );
});

test("a copy failure surfaces as a classified error, not a success", async (t) => {
  const { workspace, destinationDir, containment } = await fixture(t);
  await writeFile(join(workspace, "err.txt"), "data");
  const destination = join(destinationDir, "err.txt");

  await assert.rejects(
    saveFileAs("err.txt", {
      resolveSource: containment,
      showSaveDialog: dialog(destination).show,
      copyFile: async () => {
        throw Object.assign(new Error("disk is full"), { code: "ENOSPC" });
      },
    }),
    (error) => error.errorCode === "INTERNAL" && /disk is full/.test(error.message),
  );
  await assert.rejects(stat(destination), { code: "ENOENT" });
});

test("a permission failure on the destination reports UNAUTHORIZED", async (t) => {
  const { workspace, destinationDir, containment } = await fixture(t);
  await writeFile(join(workspace, "locked.txt"), "data");
  const destination = join(destinationDir, "locked.txt");

  await assert.rejects(
    saveFileAs("locked.txt", {
      resolveSource: containment,
      showSaveDialog: dialog(destination).show,
      copyFile: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    }),
    (error) => error.errorCode === "UNAUTHORIZED",
  );
});

test("replacing a source at the same path during the dialog refuses stale identity", async (t) => {
  const { workspace, destinationDir, containment } = await fixture(t);
  const source = join(workspace, "source.txt");
  const replacement = join(workspace, "replacement.txt");
  const destination = join(destinationDir, "copy.txt");
  await writeFile(source, "original");
  await writeFile(replacement, "replacement");
  await assert.rejects(saveFileAs("source.txt", {
    resolveSource: containment,
    showSaveDialog: async () => {
      await rename(replacement, source);
      return { canceled: false, filePath: destination };
    },
  }), (error) => error.errorCode === "CONFLICT");
  await assert.rejects(stat(destination), { code: "ENOENT" });
  assert.equal(await readFile(source, "utf8"), "replacement");
});
