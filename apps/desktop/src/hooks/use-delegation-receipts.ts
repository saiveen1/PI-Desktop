import { useCallback, useEffect, useRef, useState } from "react";
import type { DelegationApprovalHistoryEntry, DelegationApprovalHistoryMarkRead } from "@pi-desktop/shared";
import { api } from "../lib/api";

/** Durable receipts are history, never a source of permission or pending work. */
export function useDelegationReceipts() {
  const [entries, setEntries] = useState<DelegationApprovalHistoryEntry[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const mounted = useRef(false);
  const reload = useCallback(async () => {
    const operation = ++generation.current;
    if (mounted.current) setLoading(true);
    try {
      const result = await api.listDelegationApprovalHistory();
      if (mounted.current && operation === generation.current) { setEntries(result.entries); setError(false); }
    } catch (failure) {
      if (mounted.current && operation === generation.current) setError(true);
      throw failure;
    } finally {
      if (mounted.current && operation === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    // Subscribe first; a newer terminal event invalidates an older list response.
    const off = api.onDelegationApprovalChanged(({ request }) => {
      if (request.status !== "pending") void reload().catch(() => undefined);
    });
    void reload().catch(() => undefined); // The error is rendered by the history surface.
    return () => { mounted.current = false; ++generation.current; off(); };
  }, [reload]);
  const mutate = useCallback(async (action: () => Promise<{ ok: boolean }>) => {
    const operation = ++generation.current;
    if (mounted.current) setLoading(true);
    try {
      const result = await action();
      if (!result.ok) throw new Error("Approval history mutation was rejected");
      if (mounted.current) await reload();
    } catch (failure) {
      if (mounted.current && operation === generation.current) setError(true);
      throw failure;
    } finally {
      if (mounted.current && operation === generation.current) setLoading(false);
    }
  }, [reload]);
  const markRead = useCallback((input: DelegationApprovalHistoryMarkRead = {}) =>
    mutate(() => api.markDelegationApprovalHistoryRead(input)), [mutate]);
  const clear = useCallback(() => mutate(() => api.clearDelegationApprovalHistory()), [mutate]);
  return { entries, error, loading, reload, markRead, clear };
}
