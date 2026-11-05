import type { createDelegationApprovalService } from "./delegation-approval";

type Sidecar = { call<T>(method: string, params: Record<string, unknown>): Promise<T> };

/** The push is advisory; provider.delegationSnapshot is authoritative at admission. */
export async function refreshSavedDelegationPolicy(deps: {
  approvals: Pick<ReturnType<typeof createDelegationApprovalService>, "refresh">;
  getSidecar: () => Sidecar | null;
  log: (message: string) => void;
}): Promise<void> {
  // Start immediately: pending actions must be invalidated before any other await.
  const pending = deps.approvals.refresh();
  const runtime = deps.getSidecar();
  const push = runtime?.call("agent.refreshDelegationPolicy", {}).catch(() => {
    deps.log("Delegation policy refresh push failed; authoritative admission snapshot will retry");
  });
  await Promise.all([pending, push]);
}
