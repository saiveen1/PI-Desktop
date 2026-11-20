// Candidate Host + production IPC fence/runtime, with synthetic data and provider transport only.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { transcriptRewriteHarness } from "../apps/desktop/test/helpers/transcript-rewrite-harness.mjs";
import { DesktopAgentRuntime } from "../packages/agent-runtime/dist/runtime.js";

const data = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "turn-context-e2e-"));
const host = new Host(resolveHostBinary(), data);
const at = "2026-11-20T00:00:00Z";
const row = (id, role, content, extra = {}) => ({ id, role, content, status: "complete", createdAt: at, ...extra });
const get = async id => (await host.call("session.get", { id })).session;
function originalRows(messages) {
  return messages.map(({ contextOverride: _overlay, excludeThinkingFromContext: _legacy, ...message }) => message);
}
async function request(session) {
  const prior = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init.body)).messages);
    return new Response('data: {"choices":[{"index":0,"delta":{"reasoning_content":"New thinking","content":"Done."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  };
  const runtime = new DesktopAgentRuntime({ sessionId: session.id, history: session.messages, compaction: session.compaction,
    mode: "agent", thinkingLevel: "off", provider: { id: "fixture", name: "Fixture", vendorKey: "deepseek", modelId: "deepseek-fixture", apiKey: "fixture-only", baseUrl: "https://fixture.invalid/v1", apiStyle: "chat_completions", supportsReasoning: true },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: (method, params) => method === "provider.delegationSnapshot" ? Promise.resolve(undefined) : host.call(method, params) }, onEvent() {},
  });
  try { await runtime.prompt("Continue with the reviewed context."); assert.equal(requests.length, 1); return requests[0]; }
  finally { await runtime.dispose(); globalThis.fetch = prior; }
}
try {
  await host.start();
  const id = (await host.call("session.create", { title: "Context overlay fixture", mode: "agent" })).session.id;
  for (const message of [
    row("u0", "user", "Earlier question"), row("a0", "assistant", "Earlier answer"),
    row("u1", "user", "Inspect one file"), row("a1", "assistant", "Original progress", { thinking: "Original reasoning" }),
    row("t1", "tool", "Original receipt", { toolName: "Read", toolCallId: "call1", toolArgs: { path: "original.txt" }, toolResult: { content: "Original receipt" }, toolStatus: "success" }),
    row("a2", "assistant", "Original final", { thinking: "Final reasoning" }),
  ]) await host.call("session.appendMessage", { sessionId: id, message });
  const original = originalRows((await get(id)).messages);
  const ipc = transcriptRewriteHarness(host, data);
  let { snapshot } = await ipc.getTurnContext({ sessionId: id, anchorMessageId: "a2" });
  assert.deepEqual(snapshot.messages.map(m => m.messageId), ["a1", "t1", "a2"]);
  assert.equal(snapshot.messages.find(m => m.messageId === "t1").toolName, "Read");
  const firstRevision = snapshot.revision;
  ({ snapshot } = await ipc.editTurnContext({ sessionId: id, anchorMessageId: "a2", expectedRevision: snapshot.revision, edits: [
    { messageId: "a1", contextOverride: { version: 1, content: "Edited progress", thinking: "Edited reasoning" } },
    { messageId: "t1", contextOverride: { version: 1, toolArgs: { path: "edited.txt" }, toolResultText: "Edited receipt" } },
    { messageId: "a2", contextOverride: { version: 1, content: "Edited final", excludeThinking: true } },
  ] }));
  await assert.rejects(ipc.editTurnContext({ sessionId: id, anchorMessageId: "a2", expectedRevision: firstRevision, edits: [] }), { errorCode: "CONFLICT" });
  await host.restart();
  let session = await get(id);
  assert.deepEqual(originalRows(session.messages), original);
  assert.equal(session.messages.find(m => m.id === "t1").toolArgs.path, "original.txt");
  assert.equal(session.messages.find(m => m.id === "t1").toolResult.content, "Original receipt");
  let wire = await request(session);
  for (const value of ["Edited progress", "Edited reasoning", "Edited receipt", "edited.txt", "Edited final"]) assert.ok(JSON.stringify(wire).includes(value), value);
  for (const value of ["Original progress", "Original reasoning", "Original receipt", "original.txt", "Original final", "Final reasoning"]) assert.ok(!JSON.stringify(wire).includes(value), value);
  assert.equal(wire.filter(m => m.role === "tool").length, 1);
  console.log("Middle text/thinking/tool/final edits persisted; original records unchanged; next request verified");
  // The fixture provider does not persist user/final rows; discard only its internal system journal in comparisons.
  ({ snapshot } = await ipc.getTurnContext({ sessionId: id, anchorMessageId: "a2" }));
  await host.call("session.appendCompaction", { sessionId: id, compaction: { id: "cp", throughMessageId: "a1", summary: "Original progress", tokensBefore: 1000, createdAt: at } });
  ({ snapshot } = await ipc.getTurnContext({ sessionId: id, anchorMessageId: "a2" }));
  ({ snapshot } = await ipc.editTurnContext({ sessionId: id, anchorMessageId: "a2", expectedRevision: snapshot.revision, edits: [
    { messageId: "a1", contextOverride: { version: 1, excludeContent: true, excludeThinking: true } },
    { messageId: "t1", contextOverride: { version: 1, excludeTool: true } },
    { messageId: "a2", contextOverride: { version: 1, content: "Only final", excludeThinking: true } },
  ] }));
  await host.restart(); session = await get(id);
  assert.ok(!session.compaction);
  assert.deepEqual(originalRows(session.messages.filter(m => m.role !== "system")), original);
  wire = await request(session);
  assert.deepEqual(wire.filter(m => m.role === "assistant").map(m => m.content), ["Earlier answer", "Only final"]);
  assert.equal(wire.filter(m => m.role === "tool").length, 0);
  assert.equal(wire.flatMap(m => m.tool_calls ?? []).length, 0);
  console.log("Only-final removes the process and complete tool pair, not earlier turns or source history");
  ({ snapshot } = await ipc.getTurnContext({ sessionId: id, anchorMessageId: "a2" }));
  const child = (await host.call("session.fork", { sessionId: id, throughMessageId: "a2" })).session;
  assert.equal(child.messages.filter(m => m.contextOverride).length, 3);
  await ipc.editTurnContext({ sessionId: id, anchorMessageId: "a2", expectedRevision: snapshot.revision, edits: [], restore: true });
  await host.restart(); session = await get(id);
  assert.ok(session.messages.every(m => !m.contextOverride));
  assert.deepEqual(originalRows(session.messages.filter(m => m.role !== "system")), original);
  assert.equal((await get(child.id)).messages.filter(m => m.contextOverride).length, 3);
  wire = await request(session);
  assert.ok(JSON.stringify(wire).includes("Original progress"));
  assert.ok(JSON.stringify(wire).includes("Original receipt"));
  assert.ok(JSON.stringify(wire).includes("Original final"));
  console.log("Restore and independent fork verified after restart; original context is reversible");
  ({ snapshot } = await ipc.getTurnContext({ sessionId: id, anchorMessageId: "a2" }));
  await ipc.editTurnContext({ sessionId: id, anchorMessageId: "a2", expectedRevision: snapshot.revision, edits: [
    { messageId: "a2", contextOverride: { version: 1, content: "", excludeContent: true, excludeThinking: true } },
  ] });
  await host.restart(); session = await get(id);
  assert.deepEqual(originalRows(session.messages.filter(m => m.role !== "system")), original);
  wire = await request(session);
  assert.ok(!JSON.stringify(wire).includes("Original final"));
  assert.ok(!JSON.stringify(wire).includes("Final reasoning"));
  assert.ok(JSON.stringify(wire).includes("Original receipt"));
  ({ snapshot } = await ipc.getTurnContext({ sessionId: id, anchorMessageId: "a2" }));
  await ipc.editTurnContext({ sessionId: id, anchorMessageId: "a2", expectedRevision: snapshot.revision, edits: [], restore: true });
  assert.ok((await get(id)).messages.every(m => !m.contextOverride));
  console.log("Explicit final-answer exclusion survives restart and restores without deleting the original");
} finally { await host.stop(); await rm(data, { recursive: true, force: true }); }
