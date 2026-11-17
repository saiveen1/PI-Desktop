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
  vi.mocked(completeOneShot).mockResolvedValue({ text: JSON.stringify({ verdict: "incomplete", confidence: "high", reason: "The requested change is missing.", evidenceIds: ["answer"] }) });
  return { policy, turn };
}

it("keeps observer continuation active for compaction until its request is prepared", async () => {
  const { policy, turn } = fixture();
  expect(await policy.finishTurn(turn, new Map(), () => undefined, () => {}, undefined, false, { messageId: "answer", publish() {} })).toEqual({ action: "continue" });
  expect(policy.pending).toBe(true);
  const prepared = policy.prepareRequest({ messages: [] });
  expect(JSON.stringify(prepared)).toContain("observer_guard_correction");
  expect(policy.pending).toBe(false);
  expect(policy.attempts).toBe(1);
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
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: "assessed", continued: false, continuationBlocked: "unsafe", continuationReason: reason }));
  expect(policy.attempts).toBe(0);
});

it("does not spend a review on an ineligible intermediate response or attach it to another reply", async () => {
  const { policy, turn } = fixture();
  const publish = vi.fn();
  await policy.finishTurn({ ...turn, message: { ...turn.message, stopReason: "length" } }, new Map(), () => "pending_work", () => {}, undefined, false, { messageId: "short", publish });
  expect(publish).not.toHaveBeenCalled();
  policy.observer.finish({ messageId: "other", publish });
  expect(publish).not.toHaveBeenCalled();
  expect(await policy.finishTurn(turn, new Map(), () => undefined, () => {}, undefined, false, { messageId: "answer", publish })).toEqual({ action: "continue" });
  expect(vi.mocked(completeOneShot)).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: "answer", status: "assessed", continued: true }));
});
