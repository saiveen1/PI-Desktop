import { afterEach, expect, it, vi } from "vitest";
import type { AgentTurnContext } from "@earendil-works/pi-agent-core";
import { TurnCorrectionPolicy } from "./turn-correction-policy.js";
import { completeOneShot } from "./one-shot-complete.js";
vi.mock("./one-shot-complete.js", () => ({ completeOneShot: vi.fn() }));
afterEach(() => vi.resetAllMocks());

function fixture(thinkingLevel: "off" | "high" = "off") {
  const host = { async call<T>(): Promise<T> { return { sessionId: "s", todos: [] } as T; } };
  const policy = new TurnCorrectionPolicy(host, "s", false, { earlyEndMode: "off" });
  policy.observer.setConfig({ mode: "guard", settings: { providerId: "review", modelId: "small", thinkingLevel },
    provider: { id: "review", name: "Review", modelId: "small", apiKey: "", authKind: "none", supportsReasoning: true, supportedThinkingLevels: ["off", "high"] } });
  policy.reset(); policy.setTask("Implement the remaining requested change."); policy.observer.userMessage("user", false);
  const turn: AgentTurnContext = { message: { role: "assistant", api: "openai-completions", provider: "main", model: "main", timestamp: 1,
    stopReason: "stop", content: [{ type: "text", text: "The requested change is still missing." }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    toolResults: [], newMessages: [], context: { messages: [] } };
  vi.mocked(completeOneShot).mockResolvedValue({ text: "continue" });
  return { policy, turn };
}

it("staged Guard decisions do not retain an active turn for compaction or survive another request", async () => {
  const { policy, turn } = fixture();
  const sink = { messageId: "answer", publish: vi.fn() };
  expect(await policy.finishTurn(turn, new Map(), () => undefined, () => {}, undefined, false, sink)).toBeUndefined();
  expect(policy.pending).toBe(false);
  const context = { messages: [] };
  expect(policy.prepareRequest(context)).toBe(context);
  policy.observer.finish(sink, true);
  expect(sink.publish).toHaveBeenCalledTimes(2);
  expect(sink.publish).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: "answer", status: "assessed", continued: false, continuationReason: "pending_work" }));
});

it("Endless never prepares a reminder or retains eligibility across another request", async () => {
  const { policy, turn } = fixture();
  policy.observer.setConfig({ mode: "endless", settings: { maxContinuations: 1 } });
  policy.reset(); policy.setTask("Do the task."); policy.observer.userMessage("user", false);
  const sink = { messageId: "answer", publish: vi.fn() };
  expect(await policy.finishTurn(turn, new Map(), () => undefined, () => {}, undefined, false, sink)).toBeUndefined();
  expect(policy.pending).toBe(false);
  const context = { messages: [] };
  expect(policy.prepareRequest(context)).toBe(context);
  policy.observer.finish(sink, true);
  expect(sink.publish).not.toHaveBeenCalled();
});

it("provides a reasoning budget without changing the explicitly selected effort", async () => {
  const { policy, turn } = fixture("high");
  await policy.finishTurn(turn, new Map(), () => undefined, () => {}, undefined, false, { messageId: "answer", publish() {} });
  expect(vi.mocked(completeOneShot).mock.calls[0]?.[2]).toBe("high");
  expect(vi.mocked(completeOneShot).mock.calls[0]?.[3]?.maxOutputTokens).toBe(8192);
});

it.each(["pending_work", "runtime_unavailable"] as const)("records %s without claiming the correction budget", async reason => {
  const { policy, turn } = fixture();
  const publish = vi.fn();
  expect(await policy.finishTurn(turn, new Map(), () => reason, () => {}, undefined, false, { messageId: "answer", publish })).toBeUndefined();
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: "assessed", continued: false, continuationReason: reason }));
  expect(policy.attempts).toBe(0);
});

it("does not spend a review on an ineligible intermediate response or attach it to another reply", async () => {
  const { policy, turn } = fixture();
  const publish = vi.fn();
  await policy.finishTurn({ ...turn, message: { ...turn.message, stopReason: "length" } }, new Map(), () => "pending_work", () => {}, undefined, false, { messageId: "short", publish });
  expect(publish).not.toHaveBeenCalled();
  policy.observer.finish({ messageId: "other", publish }, true);
  expect(publish).not.toHaveBeenCalled();
  expect(await policy.finishTurn(turn, new Map(), () => undefined, () => {}, undefined, false, { messageId: "answer", publish })).toBeUndefined();
  expect(vi.mocked(completeOneShot)).toHaveBeenCalledTimes(1);
  policy.observer.finish({ messageId: "other", publish }, true);
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: "answer", status: "checking" }));
});
