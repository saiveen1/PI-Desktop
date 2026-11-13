import { describe, expect, it } from "vitest";
import type { SubagentObservation } from "@pi-desktop/shared";
import { deliveredDelegationObservation, withInitialDelegationApprovals } from "./delegation-observation.js";

const observation = (): SubagentObservation => ({
  version: 1, selectedModel: "fixture/model", phase: "ended", lastActivityAt: 30,
  diagnostic: { state: "ended", observedAt: 30, thresholdMs: 30_000, reason: "Run ended" },
  attemptCount: 0, attemptsOmitted: 0, attempts: [], approvalsOmitted: 0, approvals: [],
  completedToolCalls: 0, failedToolCalls: 0, pendingTools: [], pendingToolsOmitted: 0,
  recentTools: [], confirmedWritePaths: [], confirmedWritePathsOmitted: 0,
});

describe("parent-owned delegation observation", () => {
  it("joins initial admission to bounded child fallback facts without mutating either owner", () => {
    const child = observation();
    child.approvals = [{ model: "fixture/fallback", status: "accepted", at: 20 }];
    const initial = Array.from({ length: 70 }, (_, at) => ({ model: "fixture/model", status: "pending" as const, at }));
    const joined = withInitialDelegationApprovals(child, initial);
    expect(joined.approvals).toHaveLength(64);
    expect(joined.approvalsOmitted).toBe(7);
    expect(joined.approvals.at(-1)).toEqual(child.approvals[0]);
    expect(child.approvals).toHaveLength(1);
    expect(initial).toHaveLength(70);
  });
  it("marks a produced report delivered only once and never promotes partial evidence", () => {
    expect(deliveredDelegationObservation(undefined, 50)).toBeUndefined();
    const partial = observation();
    expect(deliveredDelegationObservation(partial, 50)).toBe(partial);
    const produced = { ...partial, reportProducedAt: 30 };
    const delivered = deliveredDelegationObservation(produced, 50);
    expect(delivered?.reportDeliveredAt).toBe(50);
    expect(deliveredDelegationObservation(delivered, 100)).toBe(delivered);
    expect(deliveredDelegationObservation(produced, 20)?.reportDeliveredAt).toBe(30);
    expect(produced).not.toHaveProperty("reportDeliveredAt");
  });
});
