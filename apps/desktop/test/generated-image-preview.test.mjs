import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readOpenableImage } from "@pi-desktop/host-runtime";
import { readGeneratedImagePreview } from "../electron/main/generated-image-preview.ts";

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
