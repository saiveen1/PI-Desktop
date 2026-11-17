import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { DelegationApprovalActionRequest, DelegationApprovalActionResult, DelegationApprovalExtendRequest,
  DelegationApprovalPrompt } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { approvalIsLive, approvalKey, delegationApprovalState, type DelegationApprovalSourceClient } from "../../lib/delegation-approval-state";
export { approvalIsLive, approvalKey } from "../../lib/delegation-approval-state";

export type ApprovalClient = DelegationApprovalSourceClient & {
  respondDelegationApproval: (input: DelegationApprovalActionRequest) => Promise<DelegationApprovalActionResult>;
  extendDelegationApproval: (input: DelegationApprovalExtendRequest) => Promise<DelegationApprovalActionResult>;
};
export type ApprovalFeedback = { state: "sending" | "success" | "error"; message: string };
const consentIdentity = (request: DelegationApprovalPrompt) => JSON.stringify([
  request.revision, request.candidate, request.candidates, request.task, request.requestedModel,
]);

/** Selection and feedback stay local; the authoritative request stream is shared. */
export function useDelegationApprovals(client: ApprovalClient = api) {
  const source = useMemo(() => delegationApprovalState(client), [client]);
  const { requests, loading, loaded, loadError } = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Record<string, ApprovalFeedback>>({});
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(false);
  const busy = useRef(new Set<string>());
  const lookup = (key: string) => source.getSnapshot().requests.find(row => approvalKey(row) === key);
  useEffect(() => {
    mounted.current = true;
    const release = source.retain();
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { mounted.current = false; release(); window.clearInterval(clock); };
  }, [source]);
  useLayoutEffect(() => {
    setSelected(current => {
      const entries = Object.entries(current).filter(([key, identity]) => {
        const request = lookup(key);
        return request && consentIdentity(request) === identity && approvalIsLive(request, now);
      });
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [now, requests]);
  const toggle = (request: DelegationApprovalPrompt) => {
    const key = approvalKey(request);
    if (!approvalIsLive(request, Date.now()) || busy.current.has(key)) return;
    setSelected(current => {
      const next = { ...current };
      if (key in next) delete next[key]; else next[key] = consentIdentity(request);
      return next;
    });
  };
  const send = async (request: DelegationApprovalPrompt, action: DelegationApprovalActionRequest | "extend") => {
    const key = approvalKey(request);
    const current = lookup(key);
    if (busy.current.has(key) || !current || consentIdentity(current) !== consentIdentity(request) || !approvalIsLive(current, Date.now())) return;
    busy.current.add(key);
    setFeedback(previous => ({ ...previous, [key]: { state: "sending", message: "sending" } }));
    try {
      const identity = { sessionId: request.sessionId, requestId: request.requestId, revision: request.revision };
      const result = action === "extend" ? await client.extendDelegationApproval(identity) : await client.respondDelegationApproval(action);
      if (!mounted.current) return;
      if ((lookup(key)?.revision ?? -1) > (result.request?.revision ?? request.revision)) {
        setFeedback(previous => { const next = { ...previous }; delete next[key]; return next; }); return;
      }
      if (result.request) source.merge(result.request);
      const accepted = result.accepted && (action !== "extend" || Boolean(result.request));
      const message = accepted ? (action === "extend" ? "extended" : action.action === "allow" || action.action === "select" ? "approved" : action.action === "skip" ? "skipped" : "cancelled") : result.code ?? "failed";
      if (accepted && action !== "extend") {
        if (!result.request) source.merge({ ...request, status: message === "approved" ? "approved" : message === "skipped" ? "skipped" : "cancelled" });
        setSelected(previous => { const next = { ...previous }; delete next[key]; return next; });
      }
      setFeedback(previous => ({ ...previous, [key]: { state: accepted ? "success" : "error", message } }));
    } catch {
      if (mounted.current) setFeedback(previous => ({ ...previous, [key]: { state: "error", message: "failed" } }));
    } finally { busy.current.delete(key); }
  };
  const batch = async (action: "allow" | "skip" | "cancel") => {
    const snapshot = Object.entries(selected).flatMap(([key, identity]) => {
      const request = lookup(key);
      return request && consentIdentity(request) === identity && approvalIsLive(request, Date.now()) ? [request] : [];
    });
    for (const request of snapshot) {
      if (!mounted.current) break;
      await send(request, { sessionId: request.sessionId, requestId: request.requestId, revision: request.revision, action });
    }
  };
  return { requests, selected, feedback, loading, loaded, loadError, now, reload: source.reload, toggle, send, batch };
}
