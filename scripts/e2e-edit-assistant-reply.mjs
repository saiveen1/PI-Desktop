// Run against the candidate Host. No Desktop profile or external provider is used.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopAgentRuntime } from "../packages/agent-runtime/dist/runtime.js";
import { transcriptRewriteHarness } from "../apps/desktop/test/helpers/transcript-rewrite-harness.mjs";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const data = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-reply-edit-"));
const host = new Host(resolveHostBinary(), data);
const get = async (id, window = {}) => (await host.call("session.get", { id, ...window })).session;
const createdAt = "2026-11-18T09:00:00Z";
const old = "Discard this answer. ".repeat(4000);
const corrected = "1+1=2";
const question = "What is 1+1?";
const followup = "Write 2+2 in the same format.";
const originalFetch = globalThis.fetch;
let runtime;
function runtimeFrom(session) {
  return new DesktopAgentRuntime({
    sessionId: session.id, history: session.messages, compaction: session.compaction, mode: "agent", thinkingLevel: "off",
    provider: { id: "fixture", name: "Fixture", vendorKey: "deepseek", modelId: "deepseek-fixture", apiKey: "fixture-only",
      apiStyle: "chat_completions", baseUrl: "https://fixture.invalid/v1", supportsReasoning: false },
    host: { call: async (method, params) => method === "provider.delegationSnapshot" ? undefined : host.call(method, params) },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true }, onEvent() {},
  });
}
try {
  await host.start();
  const source = (await host.call("session.create", { title: "Arithmetic", mode: "agent" })).session.id;
  for (const [id, role, content] of [["u1", "user", question], ["a1", "assistant", old], ["u2", "user", "Later source turn"], ["a2", "assistant", "Later source reply"]]) {
    await host.call("session.appendMessage", { sessionId: source, message: { id, role, content, status: "complete", createdAt } });
  }
  const original = (await get(source)).messages;
  const child = (await host.call("session.fork", { sessionId: source, throughMessageId: "a1" })).session;
  const messageId = child.messages.at(-1).id;
  const preview = await get(child.id, { messageLimit: 1, contentLimit: 256 });
  assert.notEqual(preview.messages[0].content, old);
  const full = await get(child.id, { messageAround: messageId, messageLimit: 1, contentLimit: 256 });
  assert.equal(full.messages[0].content, old);
  await host.call("session.appendCompaction", { sessionId: child.id, compaction: {
    id: "stale-summary", throughMessageId: messageId, summary: "Original summary: Discard this answer.",
    tokensBefore: 18000, createdAt,
  } });
  assert.equal((await get(child.id)).compaction.id, "stale-summary");
  const req = { sessionId: child.id, messageId, expectedContent: full.messages[0].content, content: corrected };
  runtime = runtimeFrom(child);
  const ipc = transcriptRewriteHarness(host, data, {
    clearVendorAuthBindings() {}, clearProjectInstructionRoot() {},
    async call(method, { sessionId }) {
      assert.equal(method, "agent.disposeSession"); assert.equal(sessionId, child.id);
      await runtime?.dispose(); runtime = undefined;
      return { ok: true };
    },
  });
  await ipc.editAssistantReply(req);
  assert.equal(runtime, undefined, "a warm runtime must not survive a successful edit");
  await assert.rejects(ipc.editAssistantReply({ ...req, content: "Stale edit" }), { errorCode: "CONFLICT" });
  await host.restart();
  const reopened = await get(child.id);
  assert.deepEqual(reopened.messages.map(m => [m.role, m.content]), [["user", question], ["assistant", corrected]]);
  assert.ok(!reopened.compaction, "a summary covering the original reply must not seed the next prompt");
  assert.deepEqual((await get(source)).messages, original);
  console.log("Fork, target-only full text, guarded save and restart verified");

  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init.body)).messages);
    const chunk = { choices: [{ index: 0, delta: { content: "2+2=4" }, finish_reason: "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
  runtime = runtimeFrom(reopened);
  await runtime.prompt(followup);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].filter(m => m.role === "assistant").map(m => m.content), [corrected]);
  assert.equal(requests[0].at(-1).role, "user");
  assert.ok(JSON.stringify(requests[0].at(-1).content).includes(followup));
  assert.ok(!JSON.stringify(requests[0]).includes("Discard this answer."));
  console.log("Next provider request contains only the corrected assistant answer");
} finally {
  globalThis.fetch = originalFetch;
  try { await runtime?.dispose(); } finally {
    await host.stop();
    await rm(data, { recursive: true, force: true });
  }
}
