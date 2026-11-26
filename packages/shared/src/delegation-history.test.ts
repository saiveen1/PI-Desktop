import { describe, expect, it } from "vitest";
import {
  IPC, IPC_WHITELIST, isDelegationRunHistoryQuery, isDelegationRunHistoryEntry, isDelegationRunHistoryPage,
  isDelegationApprovalHistoryMarkRead, isDelegationApprovalHistory, DELEGATION_HISTORY_TEXT_LIMIT,
} from "./index.js";

const entry = (extra: Record<string, unknown> = {}) => ({
  id: "s:m", sessionId: "s", sessionTitle: "Chat", delegationId: "d", messageId: "m",
  agentName: "reviewer", description: "objective", status: "completed",
  createdAt: "2026-11-05T12:00:00.000Z", task: "Review", ...extra,
});

describe("delegation history boundary", () => {
  it("strictly validates bounded pagination, filters and paired receipt identity", () => {
    for (const query of [{}, { offset: 0, limit: 100, status: "ended", projectPath: "D:/work", sessionId: "s" }, { sessionId: "😀".repeat(128) }]) {
      expect(isDelegationRunHistoryQuery(query)).toBe(true);
    }
    for (const query of [null, [], { offset: -1 }, { limit: 101 }, { limit: 0 }, { status: "approved" },
      { projectPath: " " }, { authorize: true }, ...["", " ", " s", "s ", "x".repeat(257), "😀".repeat(129), null, 123].map(sessionId => ({ sessionId }))]) {
      expect(isDelegationRunHistoryQuery(query)).toBe(false);
    }
    for (const input of [{}, { sessionId: "s", requestId: "r" }]) {
      expect(isDelegationApprovalHistoryMarkRead(input)).toBe(true);
    }
    for (const input of [null, [], { sessionId: "s" }, { requestId: "r" },
      { sessionId: "s", requestId: " r" }, { action: "allow" }]) {
      expect(isDelegationApprovalHistoryMarkRead(input)).toBe(false);
    }
    expect(isDelegationApprovalHistory({ entries: [] })).toBe(true);
    expect(isDelegationApprovalHistory({ entries: [{ request: { status: "pending" } }] })).toBe(false);
  });

  it("validates run entries, truncation flags and candidate cursors", () => {
    expect(isDelegationRunHistoryEntry(entry())).toBe(true);
    expect(isDelegationRunHistoryEntry(entry({ status: "interrupted", taskTruncated: true, reportTruncated: true }))).toBe(true);
    expect(isDelegationRunHistoryEntry(entry({ createdAt: 1793880000000 }))).toBe(false);
    expect(isDelegationRunHistoryEntry(entry({ status: "pending" }))).toBe(false);
    expect(isDelegationRunHistoryEntry(entry({ taskTruncated: "yes" }))).toBe(false);
    expect(isDelegationRunHistoryEntry(entry({ task: "x".repeat(DELEGATION_HISTORY_TEXT_LIMIT + 1) }))).toBe(false);
    expect(isDelegationRunHistoryPage({ entries: [], nextOffset: null })).toBe(true);
    expect(isDelegationRunHistoryPage({ entries: [entry()], nextOffset: 1 })).toBe(true);
    expect(isDelegationRunHistoryPage({ entries: [entry()], nextOffset: undefined })).toBe(false);
    expect(isDelegationRunHistoryPage({ entries: [entry(), entry()], nextOffset: null })).toBe(false);
  });

  it("accepts additive session attempts but rejects overlap, invalid outcomes and oversized previews", () => {
    const rejected = {
      messageId: "attempt", toolCallId: "call", createdAt: "2026-11-05T12:00:00.000Z",
      agentName: "reviewer", description: "Resume review", task: "Continue", outcome: "rejected",
      reason: "Unknown delegation.", resume: "missing",
    };
    const notRetained = { ...rejected, messageId: "retention", reason: "Resume chain no longer retained." };
    const skipped = { messageId: "skip", createdAt: rejected.createdAt, outcome: "skipped" };
    const page = (attempts: unknown, entries: unknown[] = [entry()]) => ({ entries, nextOffset: 100, attempts });
    expect(isDelegationRunHistoryPage(page([rejected, notRetained, skipped]))).toBe(true);
    expect(isDelegationRunHistoryPage(page([{ ...notRetained, code: "DELEGATION_RESUME_NOT_RETAINED" }]))).toBe(false);
    expect(isDelegationRunHistoryPage(page([skipped], []))).toBe(true);
    for (const attempts of [null, {}, [rejected, rejected], [{ ...skipped, messageId: "m" }],
      ...[{ outcome: "failed" }, { delegationId: "d" }, { sessionId: "other" }, { createdAt: "yesterday" },
        { toolCallId: " " }, { resume: "x".repeat(257) }, { agentName: "x".repeat(1025) },
        { task: "😀".repeat(2049) }, { description: {} }, { reason: null }]
        .map(extra => [{ ...rejected, ...extra }]),
      Array.from({ length: 100 }, (_, index) => ({ ...skipped, messageId: `a${index}` })),
    ]) {
      expect(isDelegationRunHistoryPage(page(attempts)), JSON.stringify(attempts).slice(0, 300)).toBe(false);
    }
  });

  it("keeps a recorded effective thinking level optional and strictly typed", () => {
    // Legacy rows recorded none: the property must stay missing, not defaulted.
    expect(isDelegationRunHistoryEntry(entry())).toBe(true);
    expect("thinkingLevel" in entry()).toBe(false);
    // Recorded concrete levels, explicit off and explicit omit stay distinct.
    for (const thinkingLevel of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "omit"]) {
      const recorded = entry({ thinkingLevel });
      expect(isDelegationRunHistoryEntry(recorded)).toBe(true);
      expect((recorded as { thinkingLevel?: string }).thinkingLevel).toBe(thinkingLevel);
    }
    // Unknown or malformed values never enter the typed entry.
    for (const thinkingLevel of ["turbo", "OFF", " high", "", null, 0, true, {}, ["high"], { level: "high" }]) {
      expect(isDelegationRunHistoryEntry(entry({ thinkingLevel }))).toBe(false);
    }
  });

  it("validates optional recorded execution times and usage without inventing legacy facts", () => {
    expect(isDelegationRunHistoryEntry(entry({ startedAt: "2026-11-05T12:00:00.000Z",
      usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 }, turns: 2, toolCalls: 1 }))).toBe(true);
    for (const extra of [{ startedAt: 123 }, { startedAt: "invalid" }, { turns: -1 },
      { toolCalls: 1.5 }, { usage: null }, { usage: { outputTokens: 10 } },
      { usage: { inputTokens: 50, outputTokens: -1, totalTokens: 49 } },
      { usage: { inputTokens: 50, outputTokens: Infinity, totalTokens: 60 } }]) {
      expect(isDelegationRunHistoryEntry(entry(extra))).toBe(false);
    }
  });

  it("allowlists only the four additive renderer history channels", () => {
    const channels = {
      delegationHistoryList: "pi-desktop/delegationHistory/list",
      delegationApprovalHistoryList: "pi-desktop/delegationApproval/history/list",
      delegationApprovalHistoryMarkRead: "pi-desktop/delegationApproval/history/markRead",
      delegationApprovalHistoryClear: "pi-desktop/delegationApproval/history/clear",
    };
    for (const [key, value] of Object.entries(channels)) {
      expect(IPC.invoke[key as keyof typeof IPC.invoke]).toBe(value);
      expect(IPC_WHITELIST.has(value)).toBe(true);
    }
    expect(IPC_WHITELIST.has("delegation.approvalHistory.record")).toBe(false);
  });
});
