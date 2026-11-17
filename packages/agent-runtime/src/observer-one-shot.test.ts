import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { completeOneShot } from "./one-shot-complete.js";

const provider = { id: "reviewer", name: "Reviewer", modelId: "judge", apiKey: "", authKind: "none", supportsReasoning: true, supportedThinkingLevels: ["off" as const, "high" as const] };
const context = { messages: [{ role: "user" as const, content: "Bounded local evidence", timestamp: 1 }] };
function message(extra: Partial<AssistantMessage> = {}): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text: '{"verdict":"unknown","confidence":"low","reason":"Uncertain","evidenceIds":[]}' }],
    api: "openai-completions", provider: "reviewer", model: "judge", stopReason: "stop", timestamp: 1,
    usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...extra };
}
function transport(result: AssistantMessage, terminal = true) {
  return vi.fn((_model: unknown, _context: unknown, _options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      if (result.stopReason === "error" || result.stopReason === "aborted") stream.push({ type: "error", reason: result.stopReason, error: result });
      else if (terminal && result.stopReason !== "pending") {
        stream.push({ type: "start", partial: result });
        stream.push({ type: "done", reason: result.stopReason, message: result });
      }
      stream.end(result);
    });
    return stream;
  });
}

describe("strict independent one-shot completion", () => {
  it.each([
    { stopReason: "length" as const },
    { stopReason: "toolUse" as const },
    { stopReason: "pending" as const },
    { stopReason: "deferred" as const },
    { content: [{ type: "toolCall" as const, id: "call", name: "Bash", arguments: {} }] },
  ])("rejects non-final or tool-calling output %j", async extra => {
    const stream = transport(message(extra));
    await expect(completeOneShot(provider, context, "off", { stream, disableRetries: true, requireComplete: true })).rejects.toMatchObject({ errorCode: "INCOMPLETE_COMPLETION" });
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("requires a real final done frame, not just a stop-shaped partial snapshot", async () => {
    await expect(completeOneShot(provider, context, "off", { stream: transport(message(), false), requireComplete: true, disableRetries: true })).rejects.toMatchObject({ errorCode: "INCOMPLETE_COMPLETION" });
  });

  it.each(["429 rate limit exceeded", "503 service unavailable", "400 Bad Request", "400 max_tokens must be less than 128"])("disables every implicit retry and output-limit repair for %s", async errorMessage => {
    const stream = transport(message({ stopReason: "error", errorMessage }));
    await expect(completeOneShot(provider, context, "off", { stream, disableRetries: true, requireComplete: true })).rejects.toBeInstanceOf(Error);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(stream.mock.calls[0][2]?.maxRetries).toBe(0);
  });

  it("forwards effort, cap and cancellation, and accounts separately exactly once", async () => {
    const controller = new AbortController();
    const stream = transport(message());
    const onUsage = vi.fn();
    const result = await completeOneShot(provider, context, "high", { stream, signal: controller.signal, requireComplete: true, disableRetries: true, maxOutputTokens: 512, onUsage });
    expect(stream.mock.calls[0][2]).toMatchObject({ reasoning: "high", maxTokens: 512, signal: controller.signal, maxRetries: 0 });
    expect(result.usage?.totalTokens).toBe(5);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0][0]).toMatchObject({ totalTokens: 5, providerId: "reviewer", modelId: "judge" });
  });

  it("keeps legacy callers' partial-text behavior unchanged unless strict completion is requested", async () => {
    const result = await completeOneShot(provider, context, "off", { stream: transport(message({ stopReason: "length" })) });
    expect(result.text).toContain('"verdict":"unknown"');
  });
});
