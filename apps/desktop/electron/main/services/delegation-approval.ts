import {
  DELEGATION_APPROVAL_EXTENSION_SECONDS, DEFAULT_DELEGATION_APPROVAL_TIMEOUT_SECONDS,
  isDelegationApprovalActionRequest, isDelegationApprovalExtendRequest,
  type DelegationApprovalActionResult, type DelegationApprovalChangedEvent,
  type DelegationApprovalDecision, type DelegationApprovalPrompt, type DelegationApprovalRequest,
  type DelegationApprovalSnapshot,
} from "@pi-desktop/shared";
import { isDelegationAuthorizationRequest } from "@pi-desktop/host-runtime";
import { createDelegationCatalog, type DelegationCatalogDependencies } from "./delegation-catalog";
import { createDelegationApprovalHistory } from "./delegation-approval-history";

type Dependencies = DelegationCatalogDependencies & {
  publish: (event: DelegationApprovalChangedEvent) => void;
  onError?: (message: string) => void;
  now?: () => number;
};
type Entry = {
  input: DelegationApprovalRequest;
  created: number;
  expires: number;
  initialized: boolean;
  operation: number;
  fingerprint?: string;
  prompt?: DelegationApprovalPrompt;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (decision: DelegationApprovalDecision) => void;
};
const identity = (value: { sessionId: string; requestId: string }) => JSON.stringify([value.sessionId, value.requestId]);
const sameModel = (a: { providerId: string; modelId: string }, b: { providerId: string; modelId: string }) =>
  a.providerId === b.providerId && a.modelId === b.modelId;
const decision = (value: DelegationApprovalDecision["decision"], code: DelegationApprovalDecision["code"], reason: string): DelegationApprovalDecision =>
  ({ decision: value, code, reason });

/** Core-owned consent. It never accepts trusted-extension prompt responses. */
export function createDelegationApprovalService(deps: Dependencies) {
  const catalog = createDelegationCatalog(deps);
  const pending = new Map<string, Entry>();
  const now = deps.now ?? Date.now;
  let revision = 0;
  let disposed = false;
  const report = (message: string) => (deps.onError ?? console.error)(message);
  const history = createDelegationApprovalHistory({ getHost: deps.getHost, report, now });
  const live = (entry: Entry) => !disposed && pending.get(identity(entry.input)) === entry;
  function publish(entry: Entry) {
    if (!entry.prompt) return;
    try { deps.publish({ request: structuredClone(entry.prompt) }); }
    catch { report("Delegation approval event delivery failed; pending approvals remain available through list"); }
  }
  /**
   * Terminal row keeps the identity the action produced. `select` acknowledges
   * the alternative it granted instead of the originally proposed candidate,
   * while `requestedModel`/`modelReason` still describe the original request.
   */
  function settle(entry: Entry, result: DelegationApprovalDecision, status: DelegationApprovalPrompt["status"],
    selected?: { providerId: string; modelId: string }) {
    if (pending.get(identity(entry.input)) !== entry) return;
    pending.delete(identity(entry.input));
    if (entry.timer) clearTimeout(entry.timer);
    entry.operation++;
    if (entry.prompt) {
      const chosen = selected && entry.prompt.candidates.find(row => sameModel(row, selected));
      entry.prompt = { ...entry.prompt, status, revision: ++revision, schedulingReason: result.reason,
        ...(chosen ? { candidate: { ...chosen } } : {}) };
      history.record(entry.prompt);
      publish(entry);
    }
    entry.resolve(result);
  }
  function expire(entry: Entry) {
    settle(entry, decision("skip", "timeout", "Delegation approval timeout"), "expired");
  }
  function arm(entry: Entry) {
    if (entry.timer) clearTimeout(entry.timer);
    const deadline = entry.expires;
    entry.timer = setTimeout(() => {
      if (live(entry) && entry.expires === deadline) expire(entry);
    }, Math.max(0, deadline - now()));
  }
  async function load(entry: Entry) {
    const [current, source] = await Promise.all([catalog.read(entry.input.sessionId), catalog.source(entry.input.sessionId)]);
    if (deps.getHost() !== current.host) throw new Error("Delegation host changed");
    return { current, source };
  }
  function reconcile(entry: Entry, loaded: Awaited<ReturnType<typeof load>>, automatic = true) {
    if (!live(entry)) return;
    const { current, source } = loaded;
    if (!entry.initialized) {
      entry.initialized = true;
      entry.expires = entry.created + (current.policy?.approvalTimeoutSeconds || DEFAULT_DELEGATION_APPROVAL_TIMEOUT_SECONDS) * 1000;
      arm(entry);
    }
    if (now() >= entry.expires) { expire(entry); return; }
    if (!current.policy) {
      settle(entry, entry.input.automaticOnly
        ? decision("skip", "declined", "Automatic delegation requires an explicit saved auto policy")
        : decision("allow", "approved", "Legacy delegation policy"), entry.input.automaticOnly ? "skipped" : "approved");
      return;
    }
    const candidates = catalog.candidates(current, entry.input);
    const candidate = candidates.find(row => sameModel(row, entry.input));
    if (!candidate) {
      settle(entry, decision("skip", "invalidated", "Delegation model is disabled, unavailable or incompatible"), "invalidated");
      return;
    }
    if (candidate.approval === "auto" && automatic) {
      settle(entry, decision("allow", "approved", "Automatically allowed by saved delegation policy"), "approved");
      return;
    }
    if (entry.input.automaticOnly || current.policy.approvalTimeoutSeconds === 0) {
      settle(entry, decision("skip", entry.input.automaticOnly ? "declined" : "timeout", "Delegation requires approval; automatic alternatives only"), "skipped");
      return;
    }
    const fingerprint = JSON.stringify([current.snapshot.revision, source]);
    if (entry.prompt && entry.fingerprint === fingerprint) return;
    entry.fingerprint = fingerprint;
    entry.prompt = {
      sessionId: entry.input.sessionId, requestId: entry.input.requestId, revision: ++revision,
      status: "pending", createdAt: new Date(entry.created).toISOString(), expiresAt: new Date(entry.expires).toISOString(),
      ...source, task: entry.input.task, candidate, candidates,
      ...(entry.input.agentName !== undefined ? { agentName: entry.input.agentName } : {}),
      ...(entry.input.description !== undefined ? { description: entry.input.description } : {}),
      ...(entry.input.requestedModel !== undefined ? { requestedModel: entry.input.requestedModel } : {}),
      ...(entry.input.reason !== undefined ? { modelReason: entry.input.reason } : {}),
    };
    publish(entry);
  }
  async function refreshEntry(entry: Entry) {
    const operation = ++entry.operation;
    try {
      const loaded = await load(entry);
      if (!live(entry) || entry.operation !== operation) return;
      reconcile(entry, loaded);
    } catch {
      if (!live(entry) || entry.operation !== operation) return;
      report(entry.prompt
        ? "Delegation policy/source refresh failed; the live request remains available for retry"
        : "Delegation policy/source initialization failed before a prompt could be shown");
      if (!entry.prompt) settle(entry, decision("skip", "unavailable", "Delegation policy or source unavailable"), "invalidated");
    }
  }
  function authorize(input: DelegationApprovalRequest): Promise<DelegationApprovalDecision> {
    if (!isDelegationAuthorizationRequest(input)) return Promise.resolve(decision("skip", "invalid", "Invalid delegation request"));
    if (disposed || pending.has(identity(input))) return Promise.resolve(decision("skip", "unavailable", "Delegation request unavailable"));
    let resolve!: Entry["resolve"];
    const result = new Promise<DelegationApprovalDecision>(done => { resolve = done; });
    const created = now();
    const entry: Entry = { input: structuredClone(input), created,
      expires: created + DEFAULT_DELEGATION_APPROVAL_TIMEOUT_SECONDS * 1000,
      initialized: false, operation: 0, resolve };
    pending.set(identity(input), entry);
    arm(entry); // Also bounds an unavailable host/source read before the first row exists.
    void refreshEntry(entry);
    return result;
  }
  function lookup(input: { sessionId: string; requestId: string; revision: number }): Entry | DelegationApprovalActionResult {
    const entry = pending.get(identity(input));
    if (!entry?.prompt) return { accepted: false, code: "not-found" };
    if (now() >= entry.expires) {
      expire(entry);
      return { accepted: false, code: "expired", request: structuredClone(entry.prompt) };
    }
    if (entry.prompt.revision !== input.revision) return { accepted: false, code: "stale", request: structuredClone(entry.prompt) };
    return entry;
  }
  async function respond(input: unknown): Promise<DelegationApprovalActionResult> {
    if (!isDelegationApprovalActionRequest(input)) return { accepted: false, code: "invalid", error: "Invalid delegation approval action" };
    const found = lookup(input);
    if (!("input" in found)) return found;
    const entry = found;
    if (input.action === "skip" || input.action === "cancel") {
      settle(entry, input.action === "cancel" ? decision("cancel", "cancelled", "Delegation cancelled by user")
        : decision("skip", "skipped", "Alternative model requested by user"), input.action === "cancel" ? "cancelled" : "skipped");
      return { accepted: true, request: structuredClone(entry.prompt) };
    }
    if (input.action === "select" && (!entry.prompt!.candidates.some(row => sameModel(row, input))
      || (entry.input.selection === "require" && !sameModel(entry.input, input)))) {
      return { accepted: false, code: "invalid", error: "Selected model is not an allowed replacement" };
    }
    const operation = entry.operation;
    try {
      const loaded = await load(entry);
      if (!live(entry)) return { accepted: false, code: "not-pending", request: entry.prompt && structuredClone(entry.prompt) };
      if (entry.operation !== operation || entry.prompt?.revision !== input.revision) return { accepted: false, code: "stale", request: structuredClone(entry.prompt) };
      reconcile(entry, loaded, false);
      if (!live(entry)) return { accepted: false, code: now() >= entry.expires ? "expired" : "unavailable", request: entry.prompt && structuredClone(entry.prompt) };
      if (entry.prompt?.revision !== input.revision) return { accepted: false, code: "stale", request: structuredClone(entry.prompt) };
      const selected = input.action === "select" ? entry.prompt!.candidates.find(row => sameModel(row, input)) : entry.prompt!.candidate;
      if (!selected) return { accepted: false, code: "unavailable" };
      // No await between current revision/deadline/eligibility checks and the one grant.
      const result = decision("allow", input.action === "select" ? "selected" : "approved", "User approved this delegation once");
      if (input.action === "select") result.selectedModel = { providerId: selected.providerId, modelId: selected.modelId };
      settle(entry, result, "approved");
      return { accepted: true, request: structuredClone(entry.prompt) };
    } catch {
      report("Delegation approval submission failed during policy/source revalidation");
      return { accepted: false, code: "unavailable", error: "Delegation revalidation failed", request: entry.prompt && structuredClone(entry.prompt) };
    }
  }
  async function extend(input: unknown): Promise<DelegationApprovalActionResult> {
    if (!isDelegationApprovalExtendRequest(input)) return { accepted: false, code: "invalid", error: "Invalid delegation approval extension" };
    const found = lookup(input);
    if (!("input" in found)) return found;
    const entry = found;
    const operation = ++entry.operation;
    try {
      const loaded = await load(entry);
      if (!live(entry)) return { accepted: false, code: "not-pending", request: entry.prompt && structuredClone(entry.prompt) };
      if (entry.operation !== operation || entry.prompt?.revision !== input.revision) return { accepted: false, code: "stale", request: structuredClone(entry.prompt) };
      reconcile(entry, loaded);
      if (!live(entry)) return { accepted: false, code: now() >= entry.expires ? "expired" : "unavailable", request: entry.prompt && structuredClone(entry.prompt) };
      if (entry.prompt?.revision !== input.revision) return { accepted: false, code: "stale", request: structuredClone(entry.prompt) };
      entry.expires += DELEGATION_APPROVAL_EXTENSION_SECONDS * 1000;
      entry.prompt = { ...entry.prompt!, expiresAt: new Date(entry.expires).toISOString(), revision: ++revision };
      arm(entry);
      publish(entry);
      return { accepted: true, request: structuredClone(entry.prompt) };
    } catch {
      report("Delegation approval extension failed during policy/source revalidation");
      return { accepted: false, code: "unavailable", error: "Delegation revalidation failed", request: entry.prompt && structuredClone(entry.prompt) };
    }
  }
  function cancel(input: Pick<DelegationApprovalRequest, "sessionId" | "requestId">) {
    const entry = pending.get(identity(input));
    if (entry) settle(entry, decision("cancel", "cancelled", "Delegation stopped"), "cancelled");
  }
  return {
    authorize, respond, extend, cancel,
    listHistory: history.listHistory, markHistoryRead: history.markHistoryRead, clearHistory: history.clearHistory,
    list(): DelegationApprovalSnapshot {
      for (const entry of pending.values()) if (now() >= entry.expires) expire(entry);
      return { requests: [...pending.values()].flatMap(entry => entry.prompt ? [structuredClone(entry.prompt)] : []) };
    },
    snapshot: catalog.snapshot,
    async refresh() {
      catalog.invalidate();
      await Promise.all([...pending.values()].map(refreshEntry));
    },
    dispose() {
      disposed = true;
      for (const entry of pending.values()) settle(entry, decision("cancel", "cancelled", "Delegation approval disposed"), "cancelled");
    },
  };
}
