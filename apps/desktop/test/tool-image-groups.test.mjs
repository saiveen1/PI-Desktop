import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { groupTurnToolImages } = await import("../src/lib/tool-image-groups.ts");
const { buildTranscriptEntries } = await import("../src/lib/assistant-turns.ts");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const read = (id, extra = {}) => ({ id, role: "tool", content: "", toolName: "Read", toolCallId: `call-${id}`,
  toolStatus: "success", createdAt: "2026-11-12T10:00:00Z", toolResult: { images: [{ mimeType: "image/png", data: png }] }, ...extra });
const activity = (...messages) => ({ kind: "activity", items: messages.map(message => ({ kind: "tool", message })) });
const ids = parts => groupTurnToolImages(parts).map(group => group.map(message => message.id));

test("consecutive successful Read calls share a group without deduplicating distinct calls", () => {
  const a = read("a"), b = read("b");
  const parts = [activity(a), activity(b, read("c"))];
  assert.deepEqual(ids(parts), [["a", "b", "c"]]);
  assert.equal(groupTurnToolImages(parts)[0][0], a);
  assert.equal(a.toolResult.images[0].data, png);
});

test("narrative, reasoning, searches and other tools break adjacency", () => {
  for (const separator of [
    { kind: "message", message: { id: "text", role: "assistant", content: "Next capture" } },
    { kind: "activity", items: [{ kind: "thinking", message: { id: "thinking", role: "assistant", thinking: "Review" } }] },
    { kind: "activity", items: [{ kind: "hostedSearch", message: { id: "search" }, round: {} }] },
  ]) assert.deepEqual(ids([activity(read("a")), separator, activity(read("b"))]), [["a"], ["b"]]);
  for (const separator of [read("bash", { toolName: "Bash", toolResult: {} }), read("text", { toolResult: { text: "file" } }),
    read("mcp", { toolName: "mcp_screenshot" }), read("pending", { toolStatus: "running" }), read("failed", { isError: true, toolStatus: "error" }),
    read("warning", { toolResult: { images: [{ data: png, mimeType: "image/png" }], imageInput: { issues: [{ code: "MODEL_NO_VISION" }] } } }),
    read("display-warning", { toolResult: { images: [{ data: png, mimeType: "image/png" }, { mimeType: "image/png", displayImageOmitted: true }] } }),
    read("generated", { toolResult: { kind: "generated-images", results: [] } }),
  ]) assert.deepEqual(ids([activity(read("a"), separator, read("b"))]), [["a"], [separator.id], ["b"]]);
});

test("different delegation owners are never grouped", () => {
  for (const owner of ["parentToolCallId", "nestedParentToolCallId", "agentName"]) {
    assert.deepEqual(ids([activity(read("a", { [owner]: "one" }), read("b", { [owner]: "two" }))]), [["a"], ["b"]]);
    assert.deepEqual(ids([activity(read("a", { [owner]: "one" }), read("b", { [owner]: "one" }))]), [["a", "b"]]);
  }
});

test("real transcript projection keeps prose and user turn boundaries", () => {
  const messages = [{ id: "user", role: "user", content: "Inspect", createdAt: "2026-11-12T10:00:00Z" }, read("a"), read("b"),
    { id: "comment", role: "assistant", content: "Next capture", createdAt: "2026-11-12T10:00:01Z" }, read("c"),
    { id: "next-user", role: "user", content: "Continue", createdAt: "2026-11-12T10:00:02Z" }, read("d")];
  const turns = buildTranscriptEntries(messages).entries.filter(entry => entry.kind === "assistant-turn");
  assert.deepEqual(turns.map(turn => ids(turn.parts)), [[["a", "b"], ["c"]], [["d"]]]);
});
