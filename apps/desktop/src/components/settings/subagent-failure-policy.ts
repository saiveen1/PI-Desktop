import type { DelegationFailurePolicy } from "@pi-desktop/shared";

export const failurePolicyModes = ["inherit", "stop", "retry", "fallback"] as const;

/** Counters that affect the selected failure mode, in display order. */
export function failurePolicyFields(mode: DelegationFailurePolicy["mode"]): readonly ("maxRetries" | "maxFallbacks")[] {
  return mode === "fallback" ? ["maxRetries", "maxFallbacks"]
    : mode === "retry" ? ["maxRetries"] : [];
}
