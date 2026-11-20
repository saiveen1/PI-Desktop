import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import type { UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
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

async function capture(stored: UiMessage[], apiStyle: "responses" | "chat_completions") {
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
  try { await runtime.prompt("Continue after reviewing the context."); } finally {
    await runtime.dispose(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  expect(bodies).toHaveLength(1);
  expect(ended).toHaveLength(1);
  expect(ended[0]!.contextOverride).toBeUndefined();
  expect(ended[0]!.thinking).toBe("NEW_THINKING");
  return bodies[0]!;
}

describe.each(["responses", "chat_completions"] as const)("turn context overrides on %s", apiStyle => {
  it("edits intermediate text, thinking, tool arguments/result and final answer without modifying originals", async () => {
    const stored = structuredClone(history);
    stored[3]!.contextOverride = { version: 1, content: "EDITED_PROGRESS", thinking: "EDITED_THINKING" };
    stored[4]!.contextOverride = { version: 1, toolArgs: { path: "edited.txt" }, toolResultText: "EDITED_RECEIPT" };
    stored[5]!.contextOverride = { version: 1, content: "EDITED_ANSWER", excludeThinking: true };
    const original = structuredClone(stored);
    const wire = await capture(stored, apiStyle);
    const text = JSON.stringify(wire);
    for (const value of ["EDITED_PROGRESS", "EDITED_RECEIPT", "EDITED_ANSWER", "edited.txt", "Earlier answer"]) expect(text).toContain(value);
    expect(text).toContain("EDITED_THINKING");
    for (const value of ["ORIGINAL_PROGRESS", "ORIGINAL_RECEIPT", "ORIGINAL_ANSWER", "original.txt", "FINAL_THINKING"]) expect(text).not.toContain(value);
    if (apiStyle === "responses") {
      expect(wire.input!.filter(m => m.type === "function_call")).toHaveLength(1);
      expect(wire.input!.filter(m => m.type === "function_call_output")).toHaveLength(1);
    } else {
      expect(wire.messages!.filter(m => m.role === "tool")).toHaveLength(1);
      expect(wire.messages!.filter(m => Array.isArray(m.tool_calls))).toHaveLength(1);
    }
    expect(stored).toEqual(original);
  });
  it("only-final removes the complete process and tool pair, while restoring original rows replays them", async () => {
    const stored = structuredClone(history);
    stored[3]!.contextOverride = { version: 1, excludeContent: true, excludeThinking: true };
    stored[4]!.contextOverride = { version: 1, excludeTool: true };
    stored[5]!.contextOverride = { version: 1, content: "FINAL_ONLY", excludeThinking: true };
    const wire = await capture(stored, apiStyle);
    const text = JSON.stringify(wire);
    expect(text).toContain("FINAL_ONLY");
    expect(text).toContain("Earlier answer");
    for (const value of ["ORIGINAL_PROGRESS", "ORIGINAL_THINKING", "ORIGINAL_RECEIPT", "read-1", "original.txt", "FINAL_THINKING"]) expect(text).not.toContain(value);
    if (apiStyle === "responses") expect(wire.input!.filter(m => ["function_call", "function_call_output"].includes(String(m.type)))).toEqual([]);
    else expect(wire.messages!.filter(m => m.role === "tool" || Array.isArray(m.tool_calls))).toEqual([]);
    const restored = JSON.stringify(await capture(structuredClone(history), apiStyle));
    expect(restored).toContain("ORIGINAL_PROGRESS"); expect(restored).toContain("ORIGINAL_RECEIPT"); expect(restored).toContain("ORIGINAL_ANSWER");
  });
});
