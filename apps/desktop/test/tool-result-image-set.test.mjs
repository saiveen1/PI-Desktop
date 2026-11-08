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
