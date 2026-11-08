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
    for (const query of [{}, { offset: 0, limit: 100, status: "ended", projectPath: "D:/work" }]) {
      expect(isDelegationRunHistoryQuery(query)).toBe(true);
    }
    for (const query of [null, [], { offset: -1 }, { limit: 101 }, { limit: 0 }, { status: "approved" },
      { projectPath: " " }, { authorize: true }]) {
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
