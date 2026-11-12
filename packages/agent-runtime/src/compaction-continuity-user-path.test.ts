import { describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextCompactionRecord } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import { convertToLlm, serializeConversation } from "./pi-runtime-messages.js";
import { reduceSummaryInput } from "./compaction-summary-input.js";

const receipt = "APPLIED_ONCE receipt=fixture-17; validation=passed; next=publish";
function reply(content: AssistantMessage["content"], input = 1_024): AssistantMessage {
  return {
    role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
    content, stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 1, usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function fixture(compaction?: ContextCompactionRecord, withSteering = false) {
  let checkpoint: ContextCompactionRecord | undefined;
  let steeringSent = false;
  const dispatch = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false };
    if (method === "provider.delegationSnapshot" || method === "session.appendMessage") return undefined;
    if (method === "todos.get") return { sessionId: "continuity-fixture", todos: [] };
    if (method === "session.appendCompaction") {
      checkpoint = (params as { compaction: ContextCompactionRecord }).compaction;
      return undefined;
    }
    if (method === "tools.execute") {
      runtime["createExtensionBridge"]().compact();
      return { ok: true, content: { exitCode: 0, stdout: receipt } };
    }
    return undefined;
  });
  const runtime: DesktopAgentRuntime = new DesktopAgentRuntime({
    sessionId: "continuity-fixture", mode: "agent", thinkingLevel: "off",
    provider: { id: "fixture", name: "Fixture", modelId: "fixture", apiKey: "fixture",
      baseUrl: "https://fixture.invalid/v1", supportsReasoning: false, supportedThinkingLevels: ["off"],
      modelConfig: { source: "generic", name: "Fixture", baseUrl: "https://fixture.invalid/v1",
        reasoning: false, input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64_000, maxTokens: 8_192 } },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: async <T>(method: string, params?: unknown) => await dispatch(method, params) as T },
    onEvent: ({ event }) => {
      if (withSteering && !steeringSent && event.type === "tool_end") {
        steeringSent = true;
        runtime.steer({ text: "Also use dark mode; keep completed work." }, runtime["turnId"]!, {
          id: "steering-fixture", role: "user", content: "Also use dark mode; keep completed work.",
          createdAt: new Date().toISOString(), status: "complete", steering: true,
        });
      }
    },
    ...(compaction ? { compaction, history: [{ id: compaction.throughMessageId,
      role: "assistant" as const, content: "Fixture checkpoint boundary", status: "complete" as const,
      createdAt: compaction.createdAt }] } : {}),
  });
  const requests: Context[] = [];
  const summaryRequests: Context[] = [];
  vi.spyOn(runtime["models"], "completeSimple").mockImplementation(async (_model, context) => {
    summaryRequests.push(structuredClone(context));
    // Deliberately omit the successful operation: continuity must not rely on
    // an LLM faithfully repeating every receipt in its summary.
    return reply([{ type: "text", text: "The current task is still in progress." }]);
  });
  vi.spyOn(runtime["models"], "streamSimple").mockImplementation((_model, context) => {
    requests.push(structuredClone(context));
    if (requests.length > (withSteering ? 3 : 2)) throw new Error("Unexpected provider retry");
    const message = !compaction && requests.length === 1
      ? reply([{ type: "toolCall", id: "apply-once", name: "Bash",
        arguments: { command: "fixture-apply-once" } }], 46_000)
      : withSteering && requests.length === 2
        ? reply([{ type: "toolCall", id: "verify-next", name: "Read", arguments: { path: "fixture.txt" } }])
        : reply([{ type: "text", text: "Continue with the pending publish step." }]);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
      stream.end(message);
    });
    return stream;
  });
  return { runtime, dispatch, requests, summaryRequests, checkpoint: () => checkpoint };
}

it("preserves completed work through steering and a second real checkpoint", async () => {
  const f = fixture(undefined, true);
  try {
    await f.runtime.prompt("Apply the fixture once, then publish.");
    expect(f.summaryRequests).toHaveLength(2);
    expect(f.requests).toHaveLength(3);
    assertReceipt(f.requests[2]!);
    expect(JSON.stringify(f.requests[2]?.messages)).toContain("Also use dark mode");
    expect(f.dispatch.mock.calls.filter(([method]) => method === "tools.execute")).toHaveLength(2);
  } finally { await f.runtime.dispose(); }
});

function assertReceipt(context: Context) {
  const call = context.messages.find(message => message.role === "assistant" &&
    message.content.some(block => block.type === "toolCall" && block.id === "apply-once"));
  const result = context.messages.find(message => message.role === "toolResult" && message.toolCallId === "apply-once");
  expect(call, "the original tool call must survive with its result").toBeDefined();
  expect(result?.role === "toolResult" ? JSON.stringify(result.content) : "",
    "the next request must carry provider-visible execution evidence").toContain(receipt);
  expect(JSON.stringify(context)).toContain("not a new task");
}

describe("successful compaction execution continuity", () => {
  it("carries a completed operation into the next real Agent request and restores it without replay", async () => {
    const f = fixture();
    try {
      await f.runtime.prompt("Apply the fixture once, then publish. Do not repeat completed work.");
      expect(f.summaryRequests).toHaveLength(1);
      expect(f.requests).toHaveLength(2);
      const checkpoint = f.checkpoint();
      expect(checkpoint).toBeDefined();
      expect(checkpoint?.details).toMatchObject({ strategy: "summary", retainedTailMode: "active_turn" });
      assertReceipt(f.requests[1]!);
      expect(f.dispatch.mock.calls.filter(([method]) => method === "tools.execute")).toHaveLength(1);
      const restored = fixture(JSON.parse(JSON.stringify(checkpoint)) as ContextCompactionRecord);
      try {
        await restored.runtime.prompt("Continue only the pending publish step.");
        assertReceipt(restored.requests[0]!);
        expect(restored.summaryRequests).toEqual([]);
        expect(restored.dispatch.mock.calls.filter(([method]) => method === "tools.execute")).toEqual([]);
      } finally { await restored.runtime.dispose(); }
    } finally { await f.runtime.dispose(); }
  });

  it("keeps final tool receipts in both normal and reduced summary inputs", () => {
    const messages: AgentMessage[] = [{ role: "toolResult", toolName: "Bash", toolCallId: "apply-once",
      content: [{ type: "text", text: `START fixture\n${"progress\n".repeat(2_000)}${receipt}` }],
      isError: false, timestamp: 1 }];
    const reduced = reduceSummaryInput({ messagesToSummarize: messages, turnPrefixMessages: [],
      isSplitTurn: false, previousSummary: undefined });
    for (const input of [messages, reduced!.messagesToSummarize]) {
      const serialized = serializeConversation(convertToLlm(input));
      expect(serialized).toContain("START fixture");
      expect(serialized).toContain(receipt);
      expect(serialized).toContain("truncated");
      expect(serialized.length).toBeLessThan(2_200);
    }
  });

  it("does not misrepresent attached images as absent from the conversation", () => {
    const input: AgentMessage[] = [{ role: "user", timestamp: 1, content: [
      { type: "text", text: "Use the attached receipt." },
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==" },
    ] }];
    const serialized = serializeConversation(convertToLlm(input));
    expect(serialized).toContain("image");
    expect(serialized).toContain("not included");
    expect(serialized).not.toContain("iVBORw0KGgo");
  });
});

it("rejects a receipt hidden only in non-provider result details", () => {
  const context: Context = { messages: [reply([{ type: "toolCall", id: "apply-once", name: "Bash", arguments: {} }]),
    { role: "toolResult", toolName: "Bash", toolCallId: "apply-once", isError: false,
      content: [{ type: "text", text: "output omitted" }], details: { stdout: receipt }, timestamp: 2 }] };
  expect(() => assertReceipt(context)).toThrow("provider-visible execution evidence");
});
