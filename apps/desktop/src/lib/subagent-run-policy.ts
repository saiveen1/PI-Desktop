import {
  isDelegationRunPolicySnapshot,
  type DelegationRunPolicy,
} from "@pi-desktop/shared";

export const delegationRunPolicyFields = [
  { key: "maxToolCalls", label: "settings.delegationRunMaxToolCalls", unit: "settings.delegationRunUnitCalls" },
  { key: "maxDurationSeconds", label: "settings.delegationRunMaxDurationSeconds", unit: "settings.delegationRunUnitSeconds" },
  { key: "finalReportTimeoutSeconds", label: "settings.delegationRunFinalReportTimeoutSeconds", unit: "settings.delegationRunUnitSeconds" },
] as const;

/** Historical tasks must carry every field; never synthesize a snapshot. */
export function delegationRunPolicySnapshot(payload: unknown): DelegationRunPolicy | undefined {
  if (!payload || typeof payload !== "object" || !("runPolicy" in payload)) return undefined;
  const policy = payload.runPolicy;
  return isDelegationRunPolicySnapshot(policy) ? policy : undefined;
}
