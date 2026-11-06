import type { DelegationApprovalChangedEvent, DelegationApprovalPrompt, DelegationApprovalSnapshot } from "@pi-desktop/shared";

export type DelegationApprovalSourceClient = {
  listDelegationApprovals: () => Promise<DelegationApprovalSnapshot>;
  onDelegationApprovalChanged: (listener: (event: DelegationApprovalChangedEvent) => void) => () => void;
};
export const approvalKey = (request: Pick<DelegationApprovalPrompt, "sessionId" | "requestId">) =>
  JSON.stringify([request.sessionId, request.requestId]);
export const approvalIsLive = (request: DelegationApprovalPrompt, now: number) =>
  request.status === "pending" && Date.parse(request.expiresAt) > now;

/** A single host subscription shared by approval controls and notification projections. */
export function createDelegationApprovalState(client: DelegationApprovalSourceClient) {
  const records = new Map<string, DelegationApprovalPrompt>();
  const eventVersions = new Map<string, number>();
  const listeners = new Set<() => void>();
  let snapshot = { requests: [] as DelegationApprovalPrompt[], loading: true, loadError: false };
  let references = 0, generation = 0;
  let off: (() => void) | undefined;
  const emit = () => { for (const listener of listeners) listener(); };
  const merge = (request: DelegationApprovalPrompt) => {
    const key = approvalKey(request);
    const previous = records.get(key);
    if (previous && (previous.revision > request.revision
      || previous.revision === request.revision && previous.status !== "pending" && request.status === "pending")) return;
    records.set(key, request);
    if (records.size > 512) {
      for (const [oldKey, old] of records) {
        if (old.status !== "pending" && oldKey !== key) { records.delete(oldKey); eventVersions.delete(oldKey); break; }
      }
    }
    snapshot = { ...snapshot, requests: [...records.values()] };
    emit();
  };
  const reload = async () => {
    const operation = ++generation;
    const atStart = new Map(eventVersions);
    snapshot = { ...snapshot, loading: true, loadError: false }; emit();
    try {
      const result = await client.listDelegationApprovals();
      if (!references || operation !== generation) return;
      const incoming = new Set(result.requests.map(approvalKey));
      for (const [key, request] of records) {
        if (!incoming.has(key) && eventVersions.get(key) === atStart.get(key) && request.status === "pending") {
          merge({ ...request, status: "invalidated" });
        }
      }
      for (const request of result.requests) {
        const key = approvalKey(request);
        if (eventVersions.get(key) === atStart.get(key)) merge(request);
      }
    } catch {
      if (references && operation === generation) snapshot = { ...snapshot, loadError: true };
    } finally {
      if (references && operation === generation) { snapshot = { ...snapshot, loading: false }; emit(); }
    }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    merge,
    reload,
    retain() {
      if (++references === 1) {
        off = client.onDelegationApprovalChanged(({ request }) => {
          const key = approvalKey(request);
          eventVersions.set(key, (eventVersions.get(key) ?? 0) + 1);
          merge(request);
        });
        void reload();
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--references === 0) { ++generation; off?.(); off = undefined; }
      };
    },
  };
}
const sources = new WeakMap<DelegationApprovalSourceClient, ReturnType<typeof createDelegationApprovalState>>();
export function delegationApprovalState(client: DelegationApprovalSourceClient) {
  let source = sources.get(client);
  if (!source) { source = createDelegationApprovalState(client); sources.set(client, source); }
  return source;
}
