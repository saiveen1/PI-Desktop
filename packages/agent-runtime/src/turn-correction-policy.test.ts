import { describe, expect, it, vi } from "vitest";
import type { AgentTurnContext } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { TurnCorrectionPolicy } from "./turn-correction-policy.js";
import { CorrectiveBudget } from "./corrective-budget.js";

const turn = (reply = "I will retry with a broader locator."): AgentTurnContext => ({
  message: {
    role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop", timestamp: 1,
    api: "openai-completions", provider: "fixture", model: "fixture",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  },
  toolResults: [], context: { messages: [] }, newMessages: [],
});
const toolTurn = (results: ToolResultMessage[]): AgentTurnContext => ({ ...turn(), message: { ...turn().message,
  content: [{ type: "toolCall", id: "call", name: "Bash", arguments: { command: "printf checked" } }], stopReason: "toolUse",
}, toolResults: results });
const receipt = (id = "call"): ToolResultMessage => ({ role: "toolResult", toolCallId: id, toolName: "Bash", content: [{ type: "text", text: "checked" }], isError: false, timestamp: 1 });
function policy(limit = 1) {
  const host = { async call<T>(): Promise<T> { return undefined as T; } };
  const guard = new TurnCorrectionPolicy(host, "fixture", false, { earlyEndMode: "continue", recoveryLimit: limit });
  guard.setTask("Fix the locator.");
  return guard;
}

describe("shared corrective budget and turn evidence", () => {
  it("has no independent replenishment and resets only at a new turn", () => {
    const budget = new CorrectiveBudget(2);
    expect([budget.claim(), budget.claim(), budget.claim()]).toEqual([true, true, false]);
    expect(budget.attempts).toBe(2);
    budget.reset(0);
    expect(budget.claim()).toBe(false);
    budget.reset(1);
    expect(budget.claim()).toBe(true);
  });

  it.each([[], [receipt("wrong-call")], [{ ...receipt(), isError: true }]].map(results => ({ results })))("excludes missing, unknown and failed tool receipts: $results", async ({ results }) => {
    const guard = policy();
    await guard.finishTurn(toolTurn(results), new Map(), () => true, vi.fn());
    const annotation = vi.fn();
    expect(await guard.finishTurn(turn(), new Map(), () => true, annotation)).toBeUndefined();
    expect(annotation).not.toHaveBeenCalled();
    expect(guard.claimLegacyProgress()).toBe(false);
  });

  it("does not reset failure evidence on a later text-only response", async () => {
    const guard = policy();
    await guard.finishTurn(toolTurn([{ ...receipt(), isError: true }]), new Map(), () => true, vi.fn());
    await guard.finishTurn(turn("Checkpoint saved."), new Map(), () => true, vi.fn());
    expect(await guard.finishTurn(turn(), new Map(), () => true, vi.fn())).toBeUndefined();
  });

  it("requires fresh tool evidence for an ambiguous continue request", async () => {
    const guard = policy();
    guard.setTask("Continue.");
    expect(await guard.finishTurn(turn(), new Map(), () => true, vi.fn())).toBeUndefined();
    await guard.finishTurn(toolTurn([receipt()]), new Map(), () => true, vi.fn());
    expect(await guard.finishTurn(turn(), new Map(), () => true, vi.fn())).toEqual({ action: "continue" });
  });

  it("never corrects while delegates, steering, cancellation or recovery own the boundary", async () => {
    const guard = policy();
    const annotate = vi.fn();
    expect(await guard.finishTurn(turn(), new Map(), () => false, annotate)).toBeUndefined();
    const abort = new AbortController();
    abort.abort();
    expect(await guard.finishTurn(turn(), new Map(), () => true, annotate, abort.signal)).toBeUndefined();
    expect(guard.attempts).toBe(0);
    expect(annotate).not.toHaveBeenCalled();
  });

  it("spends the same budget for legacy and ordinary progress and clears pending reminders on steering", async () => {
    const guard = policy(2);
    expect(guard.claimLegacyProgress()).toBe(true);
    expect(await guard.finishTurn(turn(), new Map(), () => true, vi.fn())).toEqual({ action: "continue" });
    expect(guard.attempts).toBe(2);
    guard.setTask("Fix only the existing locator.", true);
    expect(guard.pending).toBe(false);
    expect(JSON.stringify(guard.prepareRequest({ messages: [] }))).not.toContain("early_end_recovery");
    const annotate = vi.fn();
    expect(await guard.finishTurn(turn(), new Map(), () => true, annotate)).toBeUndefined();
    expect(annotate).toHaveBeenCalledWith("exhausted", 2);
    expect(guard.claimLegacyProgress()).toBe(false);
  });
});
