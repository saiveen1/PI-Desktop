import { describe, expect, it } from "vitest";
import type { AgentSendSubagentMessageRequest, UiMessage } from "@pi-desktop/shared";
import { DelegationMessages, subagentMessageReceipt } from "./delegation-messages.js";
import type { DelegationChain } from "./delegation-history.js";

const request: AgentSendSubagentMessageRequest = { sessionId: "session", delegationId: "old", messageId: "m", content: "User correction" };
const chain: DelegationChain = { delegateSessionId: "chain", agentName: "worker", toolCallIds: ["call", "subagent-message:m"], delegationIds: ["old", "new"], latestDelegationId: "new", readFiles: [], readLineCount: 0, lastActivityAt: 0 };
const row: UiMessage = { id: "subagent-user:m", parentToolCallId: "call", agentName: "worker", role: "user", content: request.content, createdAt: "2026-11-08T00:00:00Z" };

describe("child message admission journal", () => {
  it("recovers receipts from durable user and Task records", () => {
    expect(subagentMessageReceipt([row], chain, request, "next")).toMatchObject({ delivery: "duplicate", delegationId: "new" });
    const task = { ...row, id: "task", role: "tool" as const, parentToolCallId: undefined, toolCallId: "subagent-message:m", toolArgs: { task: request.content }, toolResult: { details: { delegationId: "new" } } };
    expect(subagentMessageReceipt([task], chain, request, "next")).toMatchObject({ delivery: "duplicate" });
    expect(() => subagentMessageReceipt([row], chain, { ...request, content: "different" }, "next")).toThrow("different content");
    expect(() => subagentMessageReceipt([row], { ...chain, toolCallIds: [] }, request, "next")).toThrow("another delegation");
  });
  it("serializes two different messages and joins a duplicate transport attempt", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const journal = new DelegationMessages();
    const calls: string[] = [];
    const result = { accepted: true as const, turnId: "turn", delegationId: "new", resumedFrom: "old", delivery: "resumed" as const };
    const first = journal.send("chain", request, async () => { calls.push("one"); await gate; return result; });
    const duplicate = journal.send("chain", request, async () => { throw new Error("duplicate execution"); });
    const second = journal.send("chain", { ...request, messageId: "two" }, async () => { calls.push("two"); return result; });
    expect(() => journal.send("chain", { ...request, content: "conflict" }, async () => result)).toThrow("in use");
    release();
    await journal.drain();
    expect(await first).toEqual(result);
    expect(await duplicate).toMatchObject({ delivery: "duplicate" });
    await second;
    expect(calls).toEqual(["one", "two"]);
    expect(journal.busy).toBe(false);
  });
});
