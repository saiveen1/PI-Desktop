import assert from "node:assert/strict";
import test from "node:test";
import { toolResultImageSet, withoutToolImageData } from "../src/lib/tool-result-images.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const image = { type: "image", data: png, mimeType: "image/png" };
const row = (toolResult, toolName = "Read") => ({ toolName, toolResult });

test("Read, MCP, plugin arrays and restored envelopes use actual image content", () => {
  for (const raw of [
    { path: "page.png", images: [image] },
    { content: [image] },
    [image],
    { content: [image], details: { blocks: [image], imageCount: 1 } },
    { content: [image], details: { path: "page.png", imageCount: 1 } },
  ]) {
    const result = toolResultImageSet(row(raw, "any-tool"));
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].dataUrl, `data:image/png;base64,${png}`);
    assert.deepEqual(toolResultImageSet(row(JSON.parse(JSON.stringify(raw)))), result);
  }
});

test("mirrored content and duplicate blocks produce one thumbnail per source image", () => {
  const result = toolResultImageSet(row({ content: [image], details: { content: [image, image] } }));
  assert.equal(result.images.length, 1);
});

test("typed refs survive without bytes, arbitrary output paths are not inferred as images", () => {
  const result = toolResultImageSet(row({ images: [{ path: "missing.png", mimeType: "image/png" }] }));
  assert.equal(result.images[0].path, "missing.png");
  assert.equal(result.images[0].dataUrl, undefined);
  assert.equal(toolResultImageSet(row({ path: "file.png" })).images.length, 0);
  assert.equal(toolResultImageSet(row({ images: [{ path: "https://example.invalid/image.png", mimeType: "image/png" }] })).images.length, 0);
});

test("image generation is recognized by its result contract, not its tool name", () => {
  assert.equal(toolResultImageSet(row({ kind: "generated-images", results: [] }, "renamed-plugin")).generated, true);
  assert.equal(toolResultImageSet(row({ text: "not an image" }, "GenerateImages")).generated, false);
});

test("non-vision images remain viewable with explicit model-input issues", () => {
  const imageInput = { imageCount: 1, includedCount: 0, issues: [{ index: 0, code: "MODEL_NO_VISION", message: "omitted" }] };
  const result = toolResultImageSet(row({ content: [], details: { images: [image], imageInput } }));
  assert.equal(result.images.length, 1);
  assert.deepEqual(result.issueCodes, ["MODEL_NO_VISION"]);
});

test("invalid MIME/base64 and unsafe refs never become active image URLs", () => {
  const result = toolResultImageSet(row({ images: [
    { ...image, mimeType: "image/svg+xml" }, { ...image, data: "%%%" },
    { mimeType: "image/png", path: "javascript:alert(1)" },
  ] }));
  assert.equal(result.images.length, 0);
  assert.ok(result.issueCodes.includes("IMAGE_INVALID"));
});

test("text presentation removes typed binary values without changing narrative or source", () => {
  const raw = { images: [image], content: [image], resource: { blob: png }, narrative: png };
  const clean = withoutToolImageData(raw);
  assert.equal(clean.narrative, png);
  assert.equal(clean.images[0].data, undefined);
  assert.equal(clean.content[0].data, undefined);
  assert.equal(clean.resource.blob, undefined);
  assert.equal(raw.images[0].data, png);
});

test("legacy JSON text mirrors do not expose encoded image bodies", () => {
  const mirror = JSON.stringify({ content: [image], note: "screenshot" });
  const clean = withoutToolImageData({ content: [{ type: "text", text: mirror }, image] });
  assert.ok(!JSON.stringify(clean).includes(png));
  assert.match(clean.content[0].text, /screenshot/);
  assert.equal(withoutToolImageData("A narrative about an image"), "A narrative about an image");
});

test("mixed recognized containers keep every distinct image and no mirror duplicates", () => {
  const second = { ...image, data: "c2Vjb25k" };
  const result = toolResultImageSet(row({ images: [image], content: [second, image] }));
  assert.equal(result.images.length, 2);
});

test("legacy clipped details fall back to intact content without false invalid-image warnings", () => {
  const clipped = { data: `${png.slice(0, 24)}\n\n[truncated for display; the full content remains in the transcript]`, _truncated: true };
  const result = toolResultImageSet(row({ content: [image], details: { images: [clipped] } }));
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].dataUrl, `data:image/png;base64,${png}`);
  assert.deepEqual(result.issueCodes, []);
  assert.equal(result.displayOmitted, false);
});

test("display-only omission is separate from authoritative image-input rejection", () => {
  const omitted = { type: "image", mimeType: "image/png", displayImageOmitted: true };
  const result = toolResultImageSet(row({ details: { images: [omitted], imageInput: { issues: [] } } }));
  assert.deepEqual(result.images, []);
  assert.deepEqual(result.issueCodes, []);
  assert.equal(result.displayOmitted, true);
  const rejected = toolResultImageSet(row({ details: { images: [omitted], imageInput: { issues: [{ code: "IMAGE_INVALID" }] } } }));
  assert.deepEqual(rejected.issueCodes, ["IMAGE_INVALID"]);
});

test("a clipped local ref or binary is never used as an active image source", () => {
  for (const entry of [
    "[truncated for display]",
    { mimeType: "image/png", path: "page.png\n\n[truncated for display]" },
    { mimeType: "image/png", data: `${png.slice(0, 24)}\n\n[truncated for display]` },
  ]) {
    const result = toolResultImageSet(row({ images: [entry] }));
    assert.equal(result.images.length, 0);
    assert.deepEqual(result.issueCodes, []);
    assert.equal(result.displayOmitted, true);
  }
});

test("fallback retains distinct originals and rejects malformed mirrors", () => {
  const second = { ...image, data: "c2Vjb25k" };
  const result = toolResultImageSet(row({ content: [image, second], details: { images: [image, { ...image, data: "%%%" }] } }));
  assert.equal(result.images.length, 2);
  assert.deepEqual(result.issueCodes, ["IMAGE_INVALID"]);
});

test("omission metadata cannot make invalid input or unsafe refs renderable", () => {
  const result = toolResultImageSet(row({ images: [
    { ...image, data: "%%%", displayImageOmitted: true },
    { mimeType: "image/svg+xml", displayImageOmitted: true },
    { mimeType: "image/png", ref: "javascript:alert(1)", displayImageOmitted: true },
    { mimeType: "image/png", ref: "page\u0000.png" },
  ] }));
  assert.deepEqual(result.images, []);
  assert.deepEqual(result.issueCodes, ["IMAGE_INVALID"]);
});

test("typed path mirrors deduplicate and inline size limits remain enforced", () => {
  const result = toolResultImageSet(row({
    content: [image],
    details: { path: "page.png", images: [{ path: "page.png", mimeType: "image/png" }] },
  }));
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].path, "page.png");
  assert.equal(result.images[0].dataUrl, `data:image/png;base64,${png}`);
  const oversized = toolResultImageSet(row({ images: [{ ...image, data: "Y".repeat(13_333_337) }] }));
  assert.equal(oversized.images.length, 0);
  assert.ok(oversized.issueCodes.includes("IMAGE_TOO_LARGE"));
});

test("fallback images have unique indices and different bytes survive a shared path", () => {
  const second = { ...image, data: "c2Vjb25k" };
  const distinct = toolResultImageSet(row({ content: [second], details: { images: [image] } }));
  assert.deepEqual(distinct.images.map(item => item.index), [0, 1]);
  const sharedPath = toolResultImageSet(row({ images: [{ ...image, path: "same.png" }, { ...second, path: "same.png" }] }));
  assert.equal(sharedPath.images.length, 2);
});

test("a missing original without a corresponding fallback retains display feedback", () => {
  const result = toolResultImageSet(row({ content: [image], details: { images: [image,
    { mimeType: "image/png", displayImageOmitted: true }] } }));
  assert.equal(result.images.length, 1);
  assert.equal(result.displayOmitted, true);
});
