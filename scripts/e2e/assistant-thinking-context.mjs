import assert from "node:assert/strict";
import { DesktopAgentRuntime } from "../../packages/agent-runtime/dist/runtime.js";
import { transcriptRewriteHarness } from "../../apps/desktop/test/helpers/transcript-rewrite-harness.mjs";

const createdAt = "2026-11-18T00:00:00Z";
const row = (id, role, content, thinking) => ({ id, role, content, ...(thinking ? { thinking } : {}), status: "complete", createdAt });
const rows = [
  row("u0", "user", "Previous question"), row("a0", "assistant", "Previous answer", "PREVIOUS_THINKING"),
  row("u1", "user", "Inspect two files"), row("a1", "assistant", "Reading first", "FIRST_THINKING"),
  { ...row("t1", "tool", "first receipt"), toolName: "Read", toolCallId: "c1", toolArgs: { path: "one" }, toolStatus: "success", toolResult: { content: "first receipt" } },
  row("a2", "assistant", "Reading second", "SECOND_THINKING"),
  { ...row("t2", "tool", "second receipt"), toolName: "Read", toolCallId: "c2", toolArgs: { path: "two" }, toolStatus: "success", toolResult: { content: "second receipt" } },
  row("a3", "assistant", "Answer", "FINAL_THINKING"),
];

async function capture(session, host) {
  const priorFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init.body)).messages);
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"Confirmed."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  };
  const runtime = new DesktopAgentRuntime({
    sessionId: session.id, history: session.messages, compaction: session.compaction, mode: "agent", thinkingLevel: "off",
    provider: { id: "fixture", name: "Fixture", vendorKey: "deepseek", modelId: "deepseek-fixture", apiKey: "fixture-only",
      apiStyle: "chat_completions", baseUrl: "https://fixture.invalid/v1", supportsReasoning: true },
    host: { call: async (method, params) => method === "provider.delegationSnapshot" ? undefined : host.call(method, params) },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true }, onEvent() {},
  });
  try {
    await runtime.prompt("Continue with the edited context.");
    assert.equal(requests.length, 1);
    return requests[0];
  } finally { await runtime.dispose(); globalThis.fetch = priorFetch; }
}

export async function verifyThinkingContext(host, data) {
  const ipc = transcriptRewriteHarness(host, data);
  for (const mode of ["reply", "turn", "keep", "restore-reply", "no-final-thinking"]) {
    const id = (await host.call("session.create", { title: `Thinking context ${mode}`, mode: "agent" })).session.id;
    const expected = rows.map(message => ({ ...message, id: `${id}:${message.id}`,
      ...(mode === "no-final-thinking" && message.id === "a3" ? { thinking: undefined } : {}),
    }));
    for (const message of expected) await host.call("session.appendMessage", { sessionId: id, message });
    const request = { sessionId: id, messageId: `${id}:a3`, expectedContent: "Answer", content: "Answer" };
    if (mode === "keep" || mode === "restore-reply") await ipc.editAssistantReply({ ...request, thinkingContext: "turn" });
    if (mode === "turn") {
      await host.call("session.appendCompaction", { sessionId: id, compaction: {
        id: "reason-checkpoint", throughMessageId: `${id}:a1`, summary: "FIRST_THINKING", tokensBefore: 1000, createdAt,
        details: { retainedReasoning: [{ text: "Reading first", thinking: "FIRST_THINKING" }] },
      } });
    }
    const thinkingContext = mode === "no-final-thinking" || mode === "restore-reply" ? "reply" : mode;
    const result = await ipc.editAssistantReply({ ...request, thinkingContext });
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.thinkingContextUpdates));
    await host.restart();
    const session = (await host.call("session.get", { id })).session;
    assert.deepEqual(session.messages.map(m => [m.id, m.content, m.thinking ?? ""]), expected.map(m => [m.id, m.content, m.thinking ?? ""]), "displayed history must survive every option");
    const excluded = (mode === "turn" ? ["a1", "a2", "a3"] : thinkingContext === "reply" && mode !== "no-final-thinking" ? ["a3"] : []).map(key => `${id}:${key}`);
    assert.deepEqual(session.messages.filter(m => m.excludeThinkingFromContext).map(m => m.id), excluded);
    if (mode === "turn") assert.ok(!session.compaction, "summary of excluded thinking must be invalidated");
    const wire = await capture(session, host);
    assert.ok(JSON.stringify(wire).includes("PREVIOUS_THINKING"));
    for (const message of expected.filter(m => m.role === "assistant" && m.thinking)) {
      assert.equal(JSON.stringify(wire).includes(message.thinking), !excluded.includes(message.id));
    }
    assert.deepEqual(wire.filter(m => m.role === "tool").map(m => m.tool_call_id), ["c1", "c2"]);
    assert.equal(wire.filter(m => m.role === "assistant").at(-1).content, "Answer");
    console.log(`Thinking context ${mode}: saved, reopened, display intact, provider request verified`);
  }
}
