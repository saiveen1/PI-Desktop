import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantReplyThinkingContext, UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";
import { captureAssistantProviderReplay } from "./assistant-provider-replay.js";
import { chainRowsToMessages } from "./delegation-history.js";
import { buildProviderModel } from "./provider-binding.js";
import { reasoningFrames, messageFrames, responseBody, responsesModel } from "./test-support/responses-terminal-fixture.js";

const createdAt = "2026-11-18T00:00:00Z";
const row = (id: string, role: UiMessage["role"], content: string): UiMessage => ({ id, role, content, createdAt, status: "complete" });
const answer = (id: string, content: string, thinking: string): UiMessage => ({
  ...row(id, "assistant", content), thinking,
  providerReplay: captureAssistantProviderReplay([
    { type: "thinking", thinking, thinkingSignature: "reasoning_content" },
    { type: "text", text: content },
  ]),
});
const history: UiMessage[] = [
  row("earlier-user", "user", "Earlier question"), answer("earlier", "Earlier answer", "EARLIER_REASON"),
  row("user", "user", "Inspect two files"), answer("a1", "Reading one", "REASON_ONE"),
  { ...row("t1", "tool", "File one"), toolName: "Read", toolCallId: "call1", toolArgs: { path: "one" }, toolResult: { content: "File one" }, toolStatus: "success" },
  answer("a2", "Reading two", "REASON_TWO"),
  { ...row("t2", "tool", "File two"), toolName: "Read", toolCallId: "call2", toolArgs: { path: "two" }, toolResult: { content: "File two" }, toolStatus: "success" },
  answer("a3", "Corrected answer", "REASON_FINAL"),
];
function provider(baseUrl: string): RuntimeProviderConfig {
  return { id: "fixture", name: "Fixture", vendorKey: "deepseek", modelId: "deepseek-fixture", apiKey: "fixture-only",
    baseUrl, apiStyle: "chat_completions", supportsReasoning: true, supportedThinkingLevels: ["off", "high"] };
}
function marked(mode: AssistantReplyThinkingContext, finalHasThinking = true) {
  return history.map(message => {
    if (message.id === "a3" && !finalHasThinking) return { ...message, thinking: undefined, providerReplay: undefined };
    return { ...message, excludeThinkingFromContext: message.id.startsWith("a") && (mode === "turn" || (mode === "reply" && message.id === "a3")) };
  });
}
type WireMessage = { role: string; content?: string; reasoning_content?: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> };
afterEach(() => vi.unstubAllGlobals());

async function request(stored: UiMessage[], baseUrl: string) {
  const bodies: WireMessage[][] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)).messages as WireMessage[]);
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const runtime = new DesktopAgentRuntime({
    sessionId: "reasoning-edit", history: stored, mode: "agent", thinkingLevel: "off", provider: provider(baseUrl),
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { async call<T>(method: string): Promise<T> {
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
      if (method === "provider.delegationSnapshot" || method === "session.appendMessage") return undefined as T;
      if (method === "todos.get") return { sessionId: "reasoning-edit", todos: [] } as T;
      throw new Error(`Unexpected Host call: ${method}`);
    } }, onEvent() {},
  });
  try { await runtime.prompt("Use the corrected answer."); } finally { await runtime.dispose(); }
  expect(bodies).toHaveLength(1);
  return bodies[0]!;
}

describe("edited reply thinking is display-only when excluded", () => {
  for (const baseUrl of ["https://api.deepseek.com/v1", "https://fixture.invalid/v1"]) {
    it.each(["reply", "turn", "keep"] as const)(`${baseUrl}: %s keeps tools and excludes only marked reasoning`, async mode => {
      const stored = marked(mode);
      const unchanged = structuredClone(stored);
      const wire = await request(stored, baseUrl);
      const assistants = wire.filter(m => m.role === "assistant");
      expect(assistants).toHaveLength(4);
      expect(assistants[0]!.reasoning_content).toBe("EARLIER_REASON");
      for (const [index, reason] of ["REASON_ONE", "REASON_TWO", "REASON_FINAL"].entries()) {
        const excluded = mode === "turn" || (mode === "reply" && index === 2);
        if (excluded) {
          expect(JSON.stringify(wire)).not.toContain(reason);
          expect(assistants[index + 1]!.reasoning_content).toBe(baseUrl.includes("api.deepseek.com") ? "" : "[reasoning not retained for this turn]");
        } else expect(assistants[index + 1]!.reasoning_content).toBe(reason);
      }
      expect(assistants.at(-1)!.content).toBe("Corrected answer");
      expect(wire.filter(m => m.role === "tool").map(m => m.tool_call_id)).toEqual(["call1", "call2"]);
      expect(assistants.flatMap(m => m.tool_calls ?? []).map(m => m.id)).toEqual(["call1", "call2"]);
      expect(stored).toEqual(unchanged);
    });
  }
  it.each(["chat_completions", "responses"] as const)("%s does not inherit exclusion into new thinking or the next request", async apiStyle => {
    const stored = marked("turn").map(message => apiStyle === "responses" ? { ...message, providerReplay: undefined } : message);
    const bodies: unknown[][] = [];
    const reasoning: unknown[] = [];
    const ended: UiMessage[] = [];
    const respond = async (raw: string) => {
      const body = JSON.parse(raw);
      bodies.push(body.messages ?? body.input);
      reasoning.push(body.reasoning);
      const delta = { reasoning_content: `NEW_REASON_${bodies.length}`, content: `New answer ${bodies.length}` };
      if (apiStyle === "responses") {
        return new Response(responseBody([
          ...reasoningFrames(0, delta.reasoning_content, "\u200b"),
          ...messageFrames(1, delta.content, [{ type: "output_text", text: delta.content }]),
        ]), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const response = await respond(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(await response.text());
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const runtime = new DesktopAgentRuntime({
      sessionId: "new-thinking", history: stored, mode: "agent", thinkingLevel: "high",
      provider: { ...provider(baseUrl), apiStyle,
        ...(apiStyle === "responses" ? { modelId: responsesModel.id, modelConfig: { ...responsesModel, source: "generic", baseUrl } } : {}) },
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      host: { async call<T>(method: string): Promise<T> {
        if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
        if (method === "provider.delegationSnapshot" || method === "session.appendMessage") return undefined as T;
        if (method === "todos.get") return { sessionId: "new-thinking", todos: [] } as T;
        throw new Error(`Unexpected Host call: ${method}`);
      } },
      onEvent: ({ event }) => {
        if (event.type === "message_end" && event.message.role === "assistant") ended.push(event.message);
      },
    });
    try {
      await runtime.prompt("Continue after the edit.");
      await runtime.prompt("Continue again.");
      expect(bodies).toHaveLength(2);
      expect(ended.map(message => message.thinking)).toEqual(["NEW_REASON_1", "NEW_REASON_2"]);
      expect(ended.every(message => message.excludeThinkingFromContext === undefined)).toBe(true);
      if (apiStyle === "responses") {
        expect(reasoning).toEqual([expect.objectContaining({ effort: "high" }), expect.objectContaining({ effort: "high" })]);
        expect(bodies[1]!.some(message => (message as { type?: string }).type === "reasoning")).toBe(true);
      } else {
        const assistant = (bodies[1] as WireMessage[]).find(message => message.content === "New answer 1");
        expect(assistant?.reasoning_content).toBe("NEW_REASON_1");
      }
      for (const body of bodies) {
        for (const oldReason of ["REASON_ONE", "REASON_TWO", "REASON_FINAL"]) expect(JSON.stringify(body)).not.toContain(oldReason);
      }
    } finally {
      await runtime.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("a final reply without thinking does not exclude an earlier thinking message", async () => {
    const wire = await request(marked("reply", false), "https://api.deepseek.com/v1");
    expect(JSON.stringify(wire)).toContain("REASON_TWO");
    expect(JSON.stringify(wire)).not.toContain("REASON_FINAL");
  });
  it("context seeding also omits excluded reasoning without deleting original rows", () => {
    const stored = marked("turn");
    const config = provider("https://api.deepseek.com/v1");
    const messages = chainRowsToMessages(stored, config, buildProviderModel(config));
    expect(JSON.stringify(messages)).toContain("EARLIER_REASON");
    expect(JSON.stringify(messages)).not.toContain("REASON_ONE");
    expect(JSON.stringify(messages)).not.toContain("REASON_TWO");
    expect(JSON.stringify(messages)).not.toContain("REASON_FINAL");
    expect(messages.filter(m => m.role === "toolResult")).toHaveLength(2);
    expect(stored.find(m => m.id === "a1")!.thinking).toBe("REASON_ONE");
  });
});
