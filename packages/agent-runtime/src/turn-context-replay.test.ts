import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import type { ContextCompactionRecord, UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import { captureAssistantProviderReplay } from "./assistant-provider-replay.js";
import { messageFrames, reasoningFrames, responseBody, responsesModel } from "./test-support/responses-terminal-fixture.js";

const at = "2026-11-20T00:00:00Z";
const history: UiMessage[] = [
  { id: "prior-user", role: "user", content: "Earlier task", createdAt: at },
  { id: "prior-answer", role: "assistant", content: "Earlier answer", thinking: "EARLIER_THINKING", createdAt: at },
  { id: "user", role: "user", content: "Inspect the fixture", createdAt: at },
  { id: "step", role: "assistant", content: "ORIGINAL_PROGRESS", thinking: "ORIGINAL_THINKING", createdAt: at },
  { id: "tool", role: "tool", content: "ORIGINAL_RECEIPT", toolName: "Read", toolCallId: "read-1", toolArgs: { path: "original.txt" },
    toolResult: { content: [{ type: "text", text: "ORIGINAL_RECEIPT" }] }, toolStatus: "success", createdAt: at },
  { id: "answer", role: "assistant", content: "ORIGINAL_ANSWER", thinking: "FINAL_THINKING", createdAt: at },
];
type Captured = { input?: Array<Record<string, unknown>>; messages?: Array<Record<string, unknown>> };

const continuePrompt = "Continue after reviewing the context.";
async function capture(stored: UiMessage[], apiStyle: "responses" | "chat_completions", followUp?: string, compaction?: ContextCompactionRecord) {
  const bodies: Captured[] = [];
  const ended: UiMessage[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body) as Captured);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(apiStyle === "responses"
      ? responseBody([...reasoningFrames(0, "NEW_THINKING", "NEW_THINKING"), ...messageFrames(1, "Done.", [{ type: "output_text", text: "Done." }])])
      : 'data: {"choices":[{"index":0,"delta":{"reasoning_content":"NEW_THINKING","content":"Done."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const runtime = new DesktopAgentRuntime({ sessionId: "context-overlay", history: stored, mode: "agent", thinkingLevel: "high",
    systemPrompt: "TRUSTED_RUNTIME_INSTRUCTIONS", compaction,
    provider: { id: "fixture", name: "Fixture", modelId: apiStyle === "responses" ? responsesModel.id : "deepseek-fixture", apiKey: "fixture",
      baseUrl, apiStyle, supportsReasoning: true, supportedThinkingLevels: ["off", "high"],
      ...(apiStyle === "responses" ? { modelConfig: { ...responsesModel, source: "generic", baseUrl } } : { vendorKey: "deepseek" }),
    }, commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { async call<T>(method: string): Promise<T> {
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
      if (method === "provider.delegationSnapshot" || method === "session.appendMessage") return undefined as T;
      if (method === "todos.get") return { sessionId: "context-overlay", todos: [] } as T;
      throw new Error(`Unexpected Host call (history must not execute): ${method}`);
    } }, onEvent: ({ event }) => { if (event.type === "message_end" && event.message.role === "assistant") ended.push(event.message); },
  });
  try {
    await runtime.prompt(continuePrompt);
    if (followUp) await runtime.prompt(followUp);
    if (compaction) await expect(runtime.retryFailedSubagent("prefix-delegate", "retry")).rejects.toThrow(/Unknown delegation/);
  } finally {
    await runtime.dispose(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  expect(bodies).toHaveLength(followUp ? 2 : 1);
  expect(ended).toHaveLength(bodies.length);
  for (const reply of ended) {
    expect(reply.contextOverride).toBeUndefined();
    expect(reply.thinking).toBe("NEW_THINKING");
  }
  return { first: bodies[0]!, next: bodies[1] };
}

describe.each(["responses", "chat_completions"] as const)("turn context overrides on %s", apiStyle => {
  it.each(["cut", "cut + no thinking", "cut + final only"])("bounds both requests and recovery on cold restart: %s", async preset => {
    const stored = structuredClone(history);
    stored[2].contextOverride = { version: 1, excludePreviousTurns: true };
    stored[3].contextOverride = { version: 1, thinking: "MY_EDITED_THINKING", excludeThinking: preset !== "cut", excludeContent: preset.endsWith("only") };
    stored[4].contextOverride = { version: 1, excludeTool: preset.endsWith("only") };
    stored[5].contextOverride = { version: 1, excludeThinking: preset !== "cut" };
    stored.splice(2, 0, {
      id: "task-row", role: "tool", content: "PREFIX_RECEIPT", createdAt: at, toolName: "Task", toolCallId: "task-prefix",
      toolArgs: { agent: "worker", task: "PREFIX_TASK" }, toolResult: { content: "PREFIX_RECEIPT",
        details: { delegationId: "prefix-delegate", agent: "worker", status: "completed", modelId: "fixture" } },
    }, { id: "child", role: "assistant", content: "PREFIX_CHILD", parentToolCallId: "task-prefix", createdAt: at });
    stored.unshift({ id: "system-before", role: "system", content: "", createdAt: at, modelSystem: { version: 1, beforeMessageId: "prior-user",
      messageJson: JSON.stringify({ role: "system", content: "PREFIX_HISTORICAL_INSTRUCTION", timestamp: 1 }) } });
    stored.push({ id: "system-after", role: "system", content: "", createdAt: at, modelSystem: { version: 1, afterMessageId: "answer",
      messageJson: JSON.stringify({ role: "system", content: "", sections: { fixture: "RETAINED_TRUSTED_INSTRUCTION" }, timestamp: 2 }) } });
    stored.push({ id: "suffix", role: "user", content: "Later question", createdAt: at });
    // A checkpoint ending inside the retained turn may still summarize the removed prefix.
    const stale = { id: "c", summary: "PREFIX_SUMMARY", throughMessageId: "answer", tokensBefore: 1200, createdAt: at,
      retainedTail: [{ role: "user", content: "PREFIX_TAIL", timestamp: 1 }] };
    const { first, next } = await capture(stored, apiStyle, "Future prompt", stale);
    for (const body of [first, next!]) {
      const text = JSON.stringify(body);
      for (const old of ["Earlier task", "Earlier answer", "EARLIER_THINKING", "PREFIX_", "task-prefix", "prefix-delegate"]) expect(text).not.toContain(old);
      for (const keep of ["TRUSTED_RUNTIME_INSTRUCTIONS", "RETAINED_TRUSTED_INSTRUCTION", "Inspect the fixture", "ORIGINAL_ANSWER", "Later question", continuePrompt]) expect(text).toContain(keep);
      expect(text.includes("MY_EDITED_THINKING")).toBe(preset === "cut");
      for (const process of ["ORIGINAL_PROGRESS", "ORIGINAL_RECEIPT", "read-1"]) expect(text.includes(process)).toBe(!preset.endsWith("only"));
    }
    expect(JSON.stringify(next)).toContain("Future prompt");
  });
  it("replays fork prefixes and removed markers based only on rows present", async () => {
    const stored = structuredClone(history);
    stored[2].contextOverride = { version: 1, excludePreviousTurns: true };
    const before = JSON.stringify((await capture(stored.slice(0, 2), apiStyle)).first);
    expect(before).toContain("Earlier answer"); expect(before).not.toContain("Inspect the fixture");
    const through = JSON.stringify((await capture(stored.slice(0, 4), apiStyle)).first);
    expect(through).not.toContain("Earlier answer"); expect(through).toContain("Inspect the fixture");
    delete stored[2].contextOverride;
    const undone = JSON.stringify((await capture(stored, apiStyle)).first);
    expect(undone).toContain("Earlier answer"); expect(undone).toContain("ORIGINAL_RECEIPT");
  });
  it.each([false, true])("replays historical edits and the later turn in order (exclude all thinking: %s)", async excludeAll => {
    const stored = structuredClone(history);
    stored[3]!.contextOverride = { version: 1, content: "EDITED_PROGRESS", thinking: "EDITED_THINKING" };
    stored[4]!.contextOverride = { version: 1, toolArgs: { path: "edited.txt" }, toolResultText: "EDITED_RECEIPT" };
    stored[5]!.contextOverride = { version: 1, content: "EDITED_ANSWER", excludeThinking: true };
    const suffixAnswer = "Later answer";
    const opaqueItem = { type: "reasoning", id: "rs_suffix", summary: [], encrypted_content: "OPAQUE_SUFFIX" };
    stored.push({ id: "later-user", role: "user", content: "Later question", createdAt: at }, {
      id: "later-answer", role: "assistant", content: suffixAnswer, createdAt: at,
      ...(apiStyle === "responses" ? { providerReplay: captureAssistantProviderReplay([
        { type: "thinking", thinking: "", thinkingSignature: JSON.stringify(opaqueItem) },
        { type: "text", text: suffixAnswer },
      ]) } : { thinking: "SUFFIX_THINKING" }),
    });
    // The Host persists one exclusion per assistant, merging existing overlays.
    if (excludeAll) {
      for (const row of stored) {
        if (row.role === "assistant") row.contextOverride = { ...row.contextOverride, version: 1, excludeThinking: true };
      }
    }
    const original = structuredClone(stored);
    const followUp = "Continue with the new reasoning.";
    const { first, next } = await capture(stored, apiStyle, excludeAll ? followUp : undefined);
    const items = first.input ?? first.messages!;
    const text = JSON.stringify(items);
    const ordered = ["Earlier task", "Earlier answer", "Inspect the fixture", "EDITED_PROGRESS", "EDITED_RECEIPT",
      "EDITED_ANSWER", "Later question", suffixAnswer, continuePrompt];
    let previous = -1;
    for (const marker of ordered) {
      const index = items.findIndex(item => JSON.stringify(item).includes(marker));
      expect(index, marker).toBeGreaterThan(previous);
      previous = index;
    }
    for (const value of ["ORIGINAL_PROGRESS", "ORIGINAL_THINKING", "ORIGINAL_RECEIPT", "ORIGINAL_ANSWER", "original.txt", "FINAL_THINKING"]) expect(text).not.toContain(value);
    if (apiStyle === "responses") {
      expect(items.filter(m => m.type === "function_call")).toMatchObject([
        { name: "Read", call_id: "read-1", arguments: JSON.stringify({ path: "edited.txt" }) },
      ]);
      expect(items.filter(m => m.type === "function_call_output")).toMatchObject([{ call_id: "read-1" }]);
    } else {
      expect(items.filter(m => Array.isArray(m.tool_calls))).toMatchObject([
        { tool_calls: [{ id: "read-1", function: { name: "Read", arguments: JSON.stringify({ path: "edited.txt" }) } }] },
      ]);
      expect(items.filter(m => m.role === "tool")).toMatchObject([{ tool_call_id: "read-1" }]);
    }
    if (excludeAll) {
      const nextItems = next!.input ?? next!.messages!;
      for (const body of [items, nextItems]) {
        const serialized = JSON.stringify(body);
        for (const hidden of ["EARLIER_THINKING", "EDITED_THINKING", "ORIGINAL_THINKING", "FINAL_THINKING", "OPAQUE_SUFFIX", "SUFFIX_THINKING"]) expect(serialized).not.toContain(hidden);
      }
      if (apiStyle === "responses") {
        expect(items.filter(m => m.type === "reasoning")).toEqual([]);
        expect(nextItems.filter(m => m.type === "reasoning")).toMatchObject([{ summary: [{ text: "NEW_THINKING" }] }]);
      } else expect(nextItems).toContainEqual(expect.objectContaining({ role: "assistant", content: "Done.", reasoning_content: "NEW_THINKING" }));
      expect(JSON.stringify(nextItems.at(-1))).toContain(followUp);
    } else {
      expect(text).toContain("[User-edited thinking]");
      expect(text).toContain("EDITED_THINKING");
      if (apiStyle === "responses") expect(items).toContainEqual(expect.objectContaining(opaqueItem));
      else {
        for (const reason of ["EARLIER_THINKING", "SUFFIX_THINKING"]) {
          expect(items).toContainEqual(expect.objectContaining({ reasoning_content: reason }));
        }
      }
    }
    expect(stored).toEqual(original);
  });
  it("only-final removes the complete process and tool pair, while restoring original rows replays them", async () => {
    const stored = structuredClone(history);
    stored[3]!.contextOverride = { version: 1, excludeContent: true, excludeThinking: true };
    stored[4]!.contextOverride = { version: 1, excludeTool: true };
    stored[5]!.contextOverride = { version: 1, content: "FINAL_ONLY", excludeThinking: true };
    const { first: wire } = await capture(stored, apiStyle);
    const text = JSON.stringify(wire);
    expect(text).toContain("FINAL_ONLY");
    expect(text).toContain("Earlier answer");
    for (const value of ["ORIGINAL_PROGRESS", "ORIGINAL_THINKING", "ORIGINAL_RECEIPT", "read-1", "original.txt", "FINAL_THINKING"]) expect(text).not.toContain(value);
    if (apiStyle === "responses") expect(wire.input!.filter(m => ["function_call", "function_call_output"].includes(String(m.type)))).toEqual([]);
    else expect(wire.messages!.filter(m => m.role === "tool" || Array.isArray(m.tool_calls))).toEqual([]);
    const restored = JSON.stringify((await capture(structuredClone(history), apiStyle)).first);
    expect(restored).toContain("ORIGINAL_PROGRESS"); expect(restored).toContain("ORIGINAL_RECEIPT"); expect(restored).toContain("ORIGINAL_ANSWER");
  });
});
