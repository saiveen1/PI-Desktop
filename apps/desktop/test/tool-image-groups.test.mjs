import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { toolImagesInDetails, turnToolImageMessages } = await import("../src/lib/tool-image-groups.ts");
const { buildTranscriptEntries } = await import("../src/lib/assistant-turns.ts");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const read = (id, extra = {}) => ({ id, role: "tool", content: "", toolName: "Read", toolCallId: `call-${id}`,
  toolStatus: "success", createdAt: "2026-11-12T10:00:00Z", toolResult: { images: [{ mimeType: "image/png", data: png }] }, ...extra });
const activity = (...messages) => ({ kind: "activity", items: messages.map(message => ({ kind: "tool", message })) });

test("Read inspection belongs to details regardless of lifecycle, diagnostics or restored history", () => {
  for (const extra of [
    {}, { toolStatus: "running" }, { toolStatus: undefined }, { toolStatus: "error", isError: true },
    { toolResult: { images: [{ data: png, mimeType: "image/png" }], imageInput: { issues: [{ code: "MODEL_NO_VISION" }] } } },
    { toolResult: { images: [{ mimeType: "image/png", displayImageOmitted: true }] } },
    { toolResult: { details: { images: [{ data: png, mimeType: "image/png" }] } } },
  ]) {
    const message = JSON.parse(JSON.stringify(read("input", extra)));
    const before = JSON.stringify(message);
    assert.equal(toolImagesInDetails(message), true);
    assert.deepEqual(turnToolImageMessages([activity(message)]), []);
    assert.equal(JSON.stringify(message), before);
  }
});

test("generated contracts and other tool images remain outside process details", () => {
  const messages = [read("mcp", { toolName: "mcp_screenshot" }),
    read("plugin", { toolName: "plugin_capture" }),
    ...["generated-images", "image-generation-error"].flatMap(kind => [
      read(kind, { toolResult: { kind, results: [] } }),
      read(`${kind}-envelope`, { toolResult: { details: { kind, results: [] } } }),
    ])];
  for (const message of messages) assert.equal(toolImagesInDetails(message), false);
  assert.deepEqual(turnToolImageMessages([activity(read("input"), ...messages, read("another"))]), messages);
});

test("real transcript projection preserves output order and user turn boundaries without echoing Reads", () => {
  const messages = [{ id: "user", role: "user", content: "Inspect", createdAt: "2026-11-12T10:00:00Z" },
    read("a"), read("b"), read("output-a", { toolName: "mcp_screenshot" }),
    { id: "comment", role: "assistant", content: "Next capture", createdAt: "2026-11-12T10:00:01Z" },
    read("c"), read("output-b", { toolName: "plugin_capture" }),
    { id: "next-user", role: "user", content: "Continue", createdAt: "2026-11-12T10:00:02Z" },
    read("d"), read("output-c", { toolName: "mcp_screenshot" })];
  const turns = buildTranscriptEntries(messages).entries.filter(entry => entry.kind === "assistant-turn");
  assert.deepEqual(turns.map(turn => turnToolImageMessages(turn.parts).map(message => message.id)),
    [["output-a", "output-b"], ["output-c"]]);
  assert.equal(turns[0].parts.flatMap(part => part.kind === "activity" ? part.items : [])
    .filter(item => item.kind === "tool" && item.message.toolName === "Read").length, 3);
});
