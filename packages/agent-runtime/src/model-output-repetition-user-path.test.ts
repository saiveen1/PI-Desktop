import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import { SubagentRun } from "./subagent.js";

const junk = ":\n\n".repeat(3000);
afterEach(() => vi.unstubAllGlobals());

describe("repetitive model output user path", () => {
  it.each([true, false])("honors the delegated repetitive-output setting enabled=%s without hidden retries", async (enabled) => {
    const events: AgentEventEnvelope[] = [];
    const fetch = vi.fn(async () => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: junk }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetch);
    const child = new SubagentRun({
      definition: { name: "fixture", description: "Report", prompt: "Report", source: "builtin", tools: [] },
      sessionId: "repetition-child", parentToolCallId: "task-1", task: "Report briefly.", systemPrompt: "Report briefly.", tools: [], thinkingLevel: "off", infiniteProviderRetry: true,
      agentOutputGuard: { repetitiveOutputEnabled: enabled },
      provider: { id: "fixture", name: "Fixture", modelId: "fixture-model", baseUrl: "http://provider.invalid/v1", apiKey: "fixture-only", apiStyle: "chat_completions", supportsReasoning: false, supportedThinkingLevels: ["off"] },
      onEvent: (event) => events.push(event),
    });
    const result = await child.run();
    expect(result.status).toBe(enabled ? "failed" : "completed");
    expect(fetch).toHaveBeenCalledTimes(1);
    if (enabled) expect(events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: "message_end", message: expect.objectContaining({ status: "error", error: expect.objectContaining({ code: "MODEL_OUTPUT_REPETITION" }) }) }) }));
    else expect(events.some(({ event }) => event.type === "message_end" && event.message.error?.code === "MODEL_OUTPUT_REPETITION")).toBe(false);
  });

  it.each(["content", "reasoning_content"])("stops runaway %s without replaying successful tools or executing siblings", async (field) => {
    let requests = 0;
    const events: AgentEventEnvelope[] = [];
    const hostCall = vi.fn(async (method: string) => {
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false };
      if (method === "provider.delegationSnapshot" || method === "session.appendMessage" || method === "project.instructions.resolve") return undefined;
      if (method === "todos.get") return { sessionId: "repetition-fixture", todos: [] };
      if (method === "tools.execute") return { ok: true, content: "Read complete" };
      throw new Error(`Unexpected Host method: ${method}`);
    });
    const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    vi.stubGlobal("fetch", vi.fn(async () => {
      requests++;
      const call = (id: string) => ({ tool_calls: [{ index: 0, id, type: "function", function: { name: "Read", arguments: '{"path":"fixture.txt"}' } }] });
      const content = requests === 1
        ? chunk({ role: "assistant", ...call("completed") }) + chunk({}, "tool_calls")
        : requests === 2
          ? chunk({ role: "assistant", [field]: junk, ...call("must-not-execute") }) + chunk({}, "tool_calls")
          : chunk({ role: "assistant", content: "Normal later reply." }) + chunk({}, "stop");
      return new Response(content + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }));
    const runtime = new DesktopAgentRuntime({
      sessionId: "repetition-fixture", mode: "agent", thinkingLevel: "off", infiniteProviderRetry: true,
      provider: { id: "fixture", name: "Fixture", modelId: "fixture-model", baseUrl: "http://provider.invalid/v1", apiKey: "fixture-only", apiStyle: "chat_completions", supportsReasoning: false, supportedThinkingLevels: ["off"] },
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      host: { async call<T>(method: string): Promise<T> { return await hostCall(method) as T; } },
      onEvent: (event) => events.push(event),
    });
    try {
      await runtime.prompt("Read and report.", "user-1", "turn-1");
      expect(requests).toBe(2);
      expect(hostCall.mock.calls.filter(([method]) => method === "tools.execute")).toHaveLength(1);
      expect(events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: "error", error: expect.objectContaining({ code: "MODEL_OUTPUT_REPETITION", retriable: false }) }) }));
      const ended = events.flatMap(({ event }) => event.type === "message_end" && event.message.role === "assistant" ? [event.message] : []);
      expect(ended.at(-1)).toMatchObject({ status: "error", error: { code: "MODEL_OUTPUT_REPETITION" } });
      expect(field === "content" ? ended.at(-1)?.content : ended.at(-1)?.thinking).toContain(junk);
      expect(events.filter(({ event }) => event.type === "agent_end")).toHaveLength(1);
      expect(runtime.getStatus().isRunning).toBe(false);
      await runtime.prompt("Give a short answer.", "user-2", "turn-2");
      expect(requests).toBe(3);
      expect(events.filter(({ event }) => event.type === "agent_end")).toHaveLength(2);
    } finally { await runtime.dispose(); }
  });

  it("applies the master switch to the next prompt of a reused main runtime", async () => {
    const events: AgentEventEnvelope[] = [];
    const fetch = vi.fn(async () => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: junk }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetch);
    const runtime = new DesktopAgentRuntime({
      sessionId: "repetition-settings", mode: "agent", thinkingLevel: "off",
      provider: { id: "fixture", name: "Fixture", modelId: "fixture-model", baseUrl: "http://provider.invalid/v1", apiKey: "fixture-only", apiStyle: "chat_completions", supportsReasoning: false, supportedThinkingLevels: ["off"] },
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      host: { async call<T>(method: string): Promise<T> {
        let value: unknown;
        if (method === "tools.fileBatchCapabilities") value = { version: 1, supported: false };
        else if (method === "todos.get") value = { sessionId: "repetition-settings", todos: [] };
        else if (!["provider.delegationSnapshot", "session.appendMessage", "project.instructions.resolve"].includes(method)) throw new Error(`Unexpected Host method: ${method}`);
        return value as T;
      } },
      onEvent: event => events.push(event),
    });
    try {
      await runtime.prompt("Reply once.", "u1", "t1");
      const ended = () => events.flatMap(({ event }) => event.type === "message_end" && event.message.role === "assistant" ? [event.message] : []);
      expect(ended().at(-1)?.error?.code).toBe("MODEL_OUTPUT_REPETITION");
      runtime.setAgentOutputGuard({ repetitiveOutputEnabled: false });
      await runtime.prompt("Reply once again.", "u2", "t2");
      expect(ended().at(-1)).toMatchObject({ status: "complete", content: junk });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { await runtime.dispose(); }
  });
});
