import {
  DELEGATION_APPROVAL_HISTORY_KEEP, isDelegationApprovalHistory, isDelegationApprovalHistoryMarkRead,
  type DelegationApprovalHistory, type DelegationApprovalHistoryEntry, type DelegationApprovalPrompt,
} from "@pi-desktop/shared";
import type { DelegationHost } from "./delegation-catalog";

type Receipt = { owner: DelegationHost | null; entry: DelegationApprovalHistoryEntry };

/** Serialized, retryable receipt writes; never a source of consent or execution. */
export function createDelegationApprovalHistory(deps: {
  getHost: () => DelegationHost | null; report: (message: string) => void; now: () => number;
}) {
  let chain: Promise<void> = Promise.resolve();
  const pending = new Map<string, Receipt>();
  function host() {
    const value = deps.getHost();
    if (!value) throw new Error("Delegation history host unavailable");
    return value;
  }
  function enqueue(operation: () => Promise<unknown>) {
    const result = chain.then(operation).catch(() => { throw new Error("Delegation approval receipt persistence failed"); });
    chain = result.then(() => undefined, () => { deps.report("Delegation approval receipt persistence failed"); });
    return result;
  }
  async function persist(key: string, receipt: Receipt) {
    // A clear or newer revision may have retired this queued snapshot.
    if (pending.get(key) !== receipt) return;
    if (!receipt.owner || deps.getHost() !== receipt.owner) throw new Error("Delegation history host changed");
    await receipt.owner.call("delegation.approvalHistory.record", receipt.entry);
    if (pending.get(key) === receipt) pending.delete(key);
  }
  async function retryPending() {
    await chain;
    for (const [key, receipt] of [...pending]) await enqueue(() => persist(key, receipt));
  }
  return {
    record(request: DelegationApprovalPrompt) {
      const key = JSON.stringify([request.sessionId, request.requestId]);
      const receipt = { owner: deps.getHost(), entry: { request: structuredClone(request), settledAt: new Date(deps.now()).toISOString() } };
      pending.delete(key);
      pending.set(key, receipt);
      // The retry backlog follows the same newest-receipt retention as Host.
      if (pending.size > DELEGATION_APPROVAL_HISTORY_KEEP) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
      void enqueue(() => persist(key, receipt)).catch(() => undefined); // enqueue reports; list retries retained failures.
    },
    async listHistory(): Promise<DelegationApprovalHistory> {
      await retryPending();
      const result = await host().call<unknown>("delegation.approvalHistory.list");
      if (!isDelegationApprovalHistory(result)) throw new Error("Invalid delegation approval history response");
      return result;
    },
    async markHistoryRead(input: unknown) {
      if (!isDelegationApprovalHistoryMarkRead(input)) throw new Error("Invalid delegation history identity");
      await retryPending();
      await enqueue(() => host().call("delegation.approvalHistory.markRead", input));
      return { ok: true as const };
    },
    async clearHistory() {
      const discarded = new Map(pending);
      await enqueue(async () => {
        await host().call("delegation.approvalHistory.clear");
        for (const [key, receipt] of discarded) if (pending.get(key) === receipt) pending.delete(key);
      });
      return { ok: true as const };
    },
  };
}
