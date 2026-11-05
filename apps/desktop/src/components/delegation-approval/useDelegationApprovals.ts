import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DelegationApprovalActionRequest,
  DelegationApprovalActionResult,
  DelegationApprovalChangedEvent,
  DelegationApprovalExtendRequest,
  DelegationApprovalPrompt,
  DelegationApprovalSnapshot,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";

export type ApprovalClient = {
  listDelegationApprovals: () => Promise<DelegationApprovalSnapshot>;
  respondDelegationApproval: (input: DelegationApprovalActionRequest) => Promise<DelegationApprovalActionResult>;
  extendDelegationApproval: (input: DelegationApprovalExtendRequest) => Promise<DelegationApprovalActionResult>;
  onDelegationApprovalChanged: (listener: (event: DelegationApprovalChangedEvent) => void) => () => void;
};
export type ApprovalFeedback = { state: "sending" | "success" | "error"; message: string };
export const approvalKey = (request: Pick<DelegationApprovalPrompt, "sessionId" | "requestId">) =>
  JSON.stringify([request.sessionId, request.requestId]);
export const approvalIsLive = (request: DelegationApprovalPrompt, now: number) =>
  request.status === "pending" && Date.parse(request.expiresAt) > now;

/** Host snapshots/events own requests; selection is an explicit revision-bound consent draft. */
export function useDelegationApprovals(client: ApprovalClient = api) {
  const [requests, setRequests] = useState<DelegationApprovalPrompt[]>([]);
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [feedback, setFeedback] = useState<Record<string, ApprovalFeedback>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(false);
  const records = useRef(new Map<string, DelegationApprovalPrompt>());
  const busy = useRef(new Set<string>());
  const eventVersions = useRef(new Map<string, number>());
  const loadGeneration = useRef(0);

  const merge = useCallback((request: DelegationApprovalPrompt) => {
    const key = approvalKey(request);
    const previous = records.current.get(key);
    if (previous && (previous.revision > request.revision ||
      (previous.revision === request.revision && previous.status !== "pending" && request.status === "pending"))) return;
    records.current.set(key, request);
    setRequests([...records.current.values()]);
    if (!previous || previous.revision !== request.revision || request.status !== "pending" ||
      previous.candidate.providerId !== request.candidate.providerId || previous.candidate.modelId !== request.candidate.modelId) {
      setSelected((current) => {
        if (!(key in current)) return current;
        const next = { ...current }; delete next[key]; return next;
      });
    }
  }, []);

  const reload = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const atStart = new Map(eventVersions.current);
    setLoading(true); setLoadError(false);
    try {
      const snapshot = await client.listDelegationApprovals();
      if (!mounted.current || generation !== loadGeneration.current) return;
      const incoming = new Set(snapshot.requests.map(approvalKey));
      for (const [key, request] of records.current) {
        if (!incoming.has(key) && eventVersions.current.get(key) === atStart.get(key)) {
          // A missing row is no longer live; retain a tombstone against stale responses.
          merge({ ...request, status: "invalidated" });
        }
      }
      for (const request of snapshot.requests) {
        const key = approvalKey(request);
        if (eventVersions.current.get(key) === atStart.get(key)) merge(request);
      }
    } catch {
      if (mounted.current && generation === loadGeneration.current) setLoadError(true);
    } finally {
      if (mounted.current && generation === loadGeneration.current) setLoading(false);
    }
  }, [client, merge]);

  useEffect(() => {
    mounted.current = true;
    const off = client.onDelegationApprovalChanged(({ request }) => {
      const key = approvalKey(request);
      eventVersions.current.set(key, (eventVersions.current.get(key) ?? 0) + 1);
      merge(request);
    });
    void reload();
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { mounted.current = false; ++loadGeneration.current; off(); window.clearInterval(clock); };
  }, [client, merge, reload]);

  useEffect(() => {
    setSelected((current) => {
      const entries = Object.entries(current).filter(([key, revision]) => {
        const request = records.current.get(key);
        return request && request.revision === revision && approvalIsLive(request, now);
      });
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [now, requests]);

  const toggle = (request: DelegationApprovalPrompt) => {
    if (!approvalIsLive(request, Date.now()) || busy.current.has(approvalKey(request))) return;
    const key = approvalKey(request);
    setSelected((current) => {
      const next = { ...current };
      if (key in next) delete next[key]; else next[key] = request.revision;
      return next;
    });
  };

  const send = async (request: DelegationApprovalPrompt, action: DelegationApprovalActionRequest | "extend") => {
    const key = approvalKey(request);
    const current = records.current.get(key);
    if (busy.current.has(key) || !current || current.revision !== request.revision || !approvalIsLive(current, Date.now())) return;
    busy.current.add(key);
    setFeedback((previous) => ({ ...previous, [key]: { state: "sending", message: "sending" } }));
    try {
      const identity = { sessionId: request.sessionId, requestId: request.requestId, revision: request.revision };
      const result = action === "extend"
        ? await client.extendDelegationApproval(identity)
        : await client.respondDelegationApproval(action);
      if (!mounted.current) return;
      // An ACK for an older candidate must never settle a newer revision's UI.
      if ((records.current.get(key)?.revision ?? -1) > (result.request?.revision ?? request.revision)) {
        setFeedback((previous) => { const next = { ...previous }; delete next[key]; return next; });
        return;
      }
      if (result.request) merge(result.request);
      const accepted = result.accepted && (action !== "extend" || Boolean(result.request));
      const message = accepted ? (action === "extend" ? "extended" : action.action === "allow" || action.action === "select" ? "approved" : action.action === "skip" ? "skipped" : "cancelled") : result.code ?? "failed";
      if (accepted && action !== "extend") {
        if (!result.request) merge({ ...request, status: message === "approved" ? "approved" : message === "skipped" ? "skipped" : "cancelled" });
        setSelected((previous) => { const next = { ...previous }; delete next[key]; return next; });
      }
      setFeedback((previous) => ({ ...previous, [key]: { state: accepted ? "success" : "error", message } }));
    } catch {
      if (mounted.current) setFeedback((previous) => ({ ...previous, [key]: { state: "error", message: "failed" } }));
    } finally { busy.current.delete(key); }
  };

  // Freeze exact IDs/revisions before any ACK or late-arrival event can alter selection.
  const batch = async (action: "allow" | "skip" | "cancel") => {
    const snapshot = Object.entries(selected).flatMap(([key, revision]) => {
      const request = records.current.get(key);
      return request?.revision === revision && approvalIsLive(request, Date.now()) ? [request] : [];
    });
    for (const request of snapshot) {
      if (!mounted.current) break;
      await send(request, { sessionId: request.sessionId, requestId: request.requestId, revision: request.revision, action });
    }
  };

  return { requests, selected, feedback, loading, loadError, now, reload, toggle, send, batch };
}
