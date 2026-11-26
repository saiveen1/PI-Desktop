import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readOpenableImage } from "@pi-desktop/host-runtime";
import { readGeneratedImageOriginal, readGeneratedImagePreview } from "../electron/main/generated-image-preview.ts";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

test("generated preview resizes only contained raster files within the source budget", async (t) => {
  const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "generated-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const large = join(root, "large.png");
  const source = Buffer.alloc(9 * 1024 * 1024);
  pixel.copy(source);
  source.writeUInt32BE(3840, 16);
  source.writeUInt32BE(2160, 20);
  await writeFile(large, source);
  const shouldNotDecode = () => assert.fail("unqualified source must not reach native decode");
  assert.equal((await readOpenableImage(large, root, [])).kind, "tooLarge");
  assert.equal((await readGeneratedImagePreview(large, null, [], "image/png", shouldNotDecode)).errorCode, "PATH_OUTSIDE_ALLOWED_ROOT");
  const preview = await readGeneratedImagePreview(large, root, [], "image/png", (input, width, height) => {
    assert.deepEqual(input, source);
    assert.deepEqual([width, height], [1024, 576]);
    return pixel;
  });
  assert.deepEqual(preview, { kind: "image", isThumbnail: true, size: pixel.length, dataUrl: `data:image/png;base64,${pixel.toString("base64")}` });

  source.writeUInt32BE(50_000, 16);
  await writeFile(large, source);
  assert.equal((await readGeneratedImagePreview(large, root, [], "image/png", shouldNotDecode)).kind, "tooLarge");
  source.fill(0, 0, 8);
  await writeFile(large, source);
  assert.equal((await readGeneratedImagePreview(large, root, [], "image/png", shouldNotDecode)).kind, "notImage");
  await writeFile(large, Buffer.alloc(17 * 1024 * 1024));
  assert.equal((await readGeneratedImagePreview(large, root, [], "image/png", shouldNotDecode)).kind, "tooLarge");
  await writeFile(large, pixel);
  const small = await readGeneratedImagePreview(large, root, [], "image/png", shouldNotDecode);
  assert.equal(small.kind, "image");
  assert.equal(small.isThumbnail, undefined);
  assert.equal(small.dataUrl, preview.dataUrl);
});

test("original read returns exact full canvas bytes only inside the owning scratch root", async (t) => {
  const base = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "generated-original-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const scratch = join(base, "owner"), sibling = join(base, "other");
  await mkdir(scratch); await mkdir(sibling);
  const path = join(scratch, "generated.png"), outside = join(sibling, "other.png");
  const bytes = Buffer.concat([pixel, Buffer.alloc(5 * 1024 * 1024)]);
  await writeFile(path, bytes); await writeFile(outside, pixel);
  const decode = (input) => { assert.deepEqual(input, bytes); return { width: 1, height: 1 }; };
  assert.equal((await readOpenableImage(path, scratch, [])).kind, "tooLarge");
  const result = await readGeneratedImageOriginal(path, scratch, "image/png", decode);
  assert.equal(result.kind, "image");
  assert.equal(result.isThumbnail, undefined);
  assert.deepEqual(Buffer.from(result.dataUrl.split(",")[1], "base64"), bytes);
  assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [1, 1]);
  for (const [ref, root] of [[outside, scratch], [join(scratch, "..", "other", "other.png"), scratch], [path, null], ["generated.png", scratch]]) {
    const denied = await readGeneratedImageOriginal(ref, root, "image/png", () => assert.fail("decoded denied source"));
    assert.equal(denied.kind, "missing");
    assert.equal(denied.dataUrl, undefined);
    assert.ok(!JSON.stringify(denied).includes(base));
  }
  try {
    const link = join(scratch, "escape.png");
    await symlink(outside, link, "file");
    assert.equal((await readGeneratedImageOriginal(link, scratch, "image/png", decode)).kind, "missing");
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS"].includes(error.code)) throw error;
    t.diagnostic(`symlink case unavailable: ${error.code}`);
  }
  try {
    const linkDir = join(scratch, "linked-dir");
    await symlink(sibling, linkDir, "junction");
    assert.equal((await readGeneratedImageOriginal(join(linkDir, "other.png"), scratch, "image/png", decode)).errorCode, "PATH_OUTSIDE_ALLOWED_ROOT");
    assert.equal((await readGeneratedImageOriginal(join(linkDir, "absent.png"), scratch, "image/png", decode)).errorCode, "PATH_OUTSIDE_ALLOWED_ROOT");
    const rootLink = join(base, "linked-root");
    await symlink(sibling, rootLink, "junction");
    assert.equal((await readGeneratedImageOriginal(join(rootLink, "other.png"), rootLink, "image/png", decode)).kind, "missing");
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS"].includes(error.code)) throw error;
    t.diagnostic(`junction case unavailable: ${error.code}`);
  }
  assert.equal((await readGeneratedImageOriginal(join(scratch, "missing.png"), scratch, undefined, decode)).errorCode, "FILE_NOT_FOUND");
  assert.equal((await readGeneratedImageOriginal(path, scratch, "image/jpeg", decode)).kind, "notImage");
  assert.equal((await readGeneratedImageOriginal(path, scratch, "image/png", () => null)).kind, "notImage");
  const bad = join(scratch, "bad.png");
  await writeFile(bad, Buffer.from("not an image"));
  assert.equal((await readGeneratedImageOriginal(bad, scratch, "image/png", decode)).kind, "notImage");
  const wrong = join(scratch, "wrong.jpg"); await writeFile(wrong, pixel);
  assert.equal((await readGeneratedImageOriginal(wrong, scratch, "image/jpeg", decode)).kind, "notImage");
  const huge = join(scratch, "huge.png"); await writeFile(huge, Buffer.alloc(16 * 1024 * 1024 + 1));
  assert.equal((await readGeneratedImageOriginal(huge, scratch, "image/png", decode)).kind, "tooLarge");
  const dimensions = Buffer.from(pixel); dimensions.writeUInt32BE(4001, 16); dimensions.writeUInt32BE(4000, 20);
  await writeFile(bad, dimensions);
  assert.equal((await readGeneratedImageOriginal(bad, scratch, "image/png", decode)).kind, "tooLarge");
});
