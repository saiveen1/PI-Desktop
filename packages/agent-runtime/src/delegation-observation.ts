import type { SubagentApprovalObservation, SubagentObservation } from "@pi-desktop/shared";

/** Initial authorization precedes child construction; fallback facts belong to the child. */
export function withInitialDelegationApprovals(
  observation: SubagentObservation, initial: readonly SubagentApprovalObservation[],
): SubagentObservation {
  const approvals = [...initial, ...observation.approvals];
  return { ...observation, approvals: approvals.slice(-64),
    approvalsOmitted: observation.approvalsOmitted + Math.max(0, approvals.length - 64) };
}

/** Consuming partial evidence is not delivery of a structurally valid final report. */
export function deliveredDelegationObservation(
  observation: SubagentObservation | undefined, at = Date.now(),
): SubagentObservation | undefined {
  return observation?.reportProducedAt !== undefined && observation.reportDeliveredAt === undefined
    ? { ...observation, reportDeliveredAt: Math.max(at, observation.reportProducedAt) } : observation;
}
