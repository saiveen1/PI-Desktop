import assert from "node:assert/strict";
import test from "node:test";
import { groupGeneratedImageMessages, summarizeGeneratedBatches } from "../src/lib/generated-image-groups.ts";

const message = (id, toolResult, toolName = "GenerateImages") => ({ id, toolCallId: `call-${id}`, toolResult, toolName });
const batch = (id, results) => message(id, { details: { kind: "generated-images", results } }, "renamed-tool");
const ok = { index: 0, status: "succeeded", path: "same.png" };
const timeout = { index: 0, status: "failed", errorCode: "IMAGE_TIMEOUT" };

test("project batches at their first source without moving other outputs or merging stored messages", () => {
  const a = batch("a", [ok, timeout]);
  const b = message("b", { kind: "generated-images", results: [ok, ok] });
  const read = message("read", { images: [] }, "Read");
  const mcp = message("mcp", { content: [] }, "mcp_capture");
  const setup = message("setup", { kind: "image-generation-error", errorCode: "IMAGE_NOT_CONFIGURED" });
  const input = [read, a, mcp, b, setup];
  const before = structuredClone(input);
  const entries = groupGeneratedImageMessages(input);
  assert.deepEqual(entries.map(entry => entry.kind === "generated" ? entry.batches.map(batch => batch.message.id) : entry.message.id),
    ["read", ["a", "b"], "mcp", "setup"]);
  assert.deepEqual(input, before);
  const { images, items, counts } = summarizeGeneratedBatches(entries[1].batches);
  assert.deepEqual(counts, { succeeded: 3, timedOut: 1, failed: 0, cancelled: 0 });
  assert.equal(new Set(images.map(image => image.key)).size, 3);
  assert.equal(new Set(images.map(image => image.index)).size, 3, "shared viewer requires distinct numeric indices");
  assert.deepEqual(items.map(item => [item.messageId, item.toolCallId, item.slot]),
    [["a", "call-a", 0], ["a", "call-a", 1], ["b", "call-b", 0], ["b", "call-b", 1]]);
});

test("summarize all-timeout and cancelled batches by actual outcomes; never disclose arbitrary error text", () => {
  const events = [batch("a", [timeout, { status: "cancelled", errorCode: "IMAGE_AUTH_FAILED" }]),
    batch("b", [{ status: "failed", errorCode: "secret: unsafe response" }, { status: "succeeded", path: "" }])];
  const [{ batches }] = groupGeneratedImageMessages(events);
  const { counts, items, images } = summarizeGeneratedBatches(batches);
  assert.deepEqual(counts, { succeeded: 0, timedOut: 1, failed: 2, cancelled: 1 });
  assert.deepEqual(images, []);
  assert.deepEqual(items.map(item => item.errorCode), ["IMAGE_TIMEOUT", "IMAGE_AUTH_FAILED", undefined, undefined]);
});

test("trace names the recorded item and selection follows it when a partial projection gains an earlier result", () => {
  const summarize = results => summarizeGeneratedBatches(groupGeneratedImageMessages([batch("a", results)])[0].batches);
  const earlier = summarize([{ ...ok, index: 7 }]);
  const later = summarize([timeout, { ...ok, index: 7 }]);
  assert.equal(earlier.items[0].sourceIndex, 7);
  assert.equal(later.images[0].key, earlier.images[0].key);
});
