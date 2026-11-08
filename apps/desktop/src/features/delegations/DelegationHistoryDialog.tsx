import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isNotificationTarget, type DelegationRunHistoryEntry } from "@pi-desktop/shared";
import { IconClose } from "../../components/icons";
import { Button, OverlayBackdrop, SegmentedControl, TooltipButton, portalOverlay } from "../../components/ui";
import { approvalIsLive, useDelegationApprovals } from "../../components/delegation-approval/useDelegationApprovals";
import { api } from "../../lib/api";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { useAppStore } from "../../stores/app-store";
import "./delegation-history.css";

type Filter = "all" | "running" | "ended";

export function DelegationHistoryDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const approvals = useDelegationApprovals();
  const selectSession = useAppStore((state) => state.selectSession);
  const [filter, setFilter] = useState<Filter>("all");
  const [entries, setEntries] = useState<DelegationRunHistoryEntry[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorOffset, setErrorOffset] = useState<number | null>(null);
  const [detail, setDetail] = useState<DelegationRunHistoryEntry | null>(null);
  const [navigationError, setNavigationError] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const generation = useRef(0);
  const loadingRef = useRef(false);
  const pendingRefresh = useRef(false);
  const navigationGeneration = useRef(0);
  const detailReturn = useRef<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(true);
  useBlockingOverlay();

  useEffect(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      navigationGeneration.current++;
      generation.current++;
      if (restoreFocus.current && returnFocus.current?.isConnected) returnFocus.current.focus();
    };
  }, []);

  const load = useCallback(async (offset: number, currentFilter: Filter) => {
    const request = ++generation.current;
    loadingRef.current = true; setLoading(true); setErrorOffset(null);
    try {
      const page = await api.listDelegationHistory({ offset, limit: 30, status: currentFilter });
      if (request !== generation.current) return;
      // Offset cursors are invalidated by newly indexed runs or status changes.
      // Refresh from the first page instead of mixing it with an older snapshot.
      setEntries((previous) => offset === 0 ? page.entries : [...previous, ...page.entries.filter((entry) => !previous.some((old) => old.id === entry.id))]);
      setNextOffset(page.nextOffset);
      setDetail((previous) => previous ? page.entries.find((entry) => entry.id === previous.id) ?? previous : null);
    } catch {
      if (request === generation.current) setErrorOffset(offset);
    } finally {
      if (request === generation.current) { loadingRef.current = false; setLoading(false); }
    }
  }, []);

  useEffect(() => {
    pendingRefresh.current = false; setEntries([]); setNextOffset(null); setDetail(null); setNavigationError(false);
    void load(0, filter);
    return () => { generation.current++; };
  }, [filter, load]);

  useEffect(() => {
    if (loading || !pendingRefresh.current) return;
    pendingRefresh.current = false;
    void load(0, filter);
  }, [loading, filter, load]);

  useEffect(() => {
    let timer: number | undefined;
    const off = api.onAgentEvent((envelope) => {
      if (envelope.event.type !== "tool_start" && envelope.event.type !== "tool_end" && envelope.event.type !== "agent_end") return;
      if (loadingRef.current) { pendingRefresh.current = true; return; }
      if (timer !== undefined) return;
      timer = window.setTimeout(() => { timer = undefined; if (loadingRef.current) pendingRefresh.current = true; else void load(0, filter); }, 500);
    });
    return () => { off(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [filter, load]);

  const pending = approvals.requests.filter((request) => request.status === "pending");
  const openApproval = (request: (typeof pending)[number]) => {
    const target = { kind: "delegation-approval", sessionId: request.sessionId, requestId: request.requestId, revision: request.revision };
    if (!isNotificationTarget(target) || !approvalIsLive(request, Date.now())) return;
    restoreFocus.current = false;
    onClose();
    window.dispatchEvent(new CustomEvent("pi-desktop:notification-target", { detail: target }));
  };
  const openSource = async (sessionId: string) => {
    setNavigationError(false); setNavigating(true);
    const request = ++navigationGeneration.current;
    try {
      await selectSession(sessionId);
      if (request !== navigationGeneration.current) return;
      if (useAppStore.getState().activeSessionId !== sessionId) { setNavigationError(true); return; }
      onClose();
    } catch { if (request === navigationGeneration.current) setNavigationError(true); }
    finally { if (request === navigationGeneration.current) setNavigating(false); }
  };
  const keyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== "Tab") return;
    const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])];
    if (!controls.length) { event.preventDefault(); return; }
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const source = (entry: { projectTitle?: string; projectPath?: string | null; sessionTitle?: string }) =>
    `${entry.projectTitle || entry.projectPath || t("delegationHistory.noProject")} · ${entry.sessionTitle || t("delegationHistory.untitledSession")}`;
  const date = (value: string) => { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(); };

  return portalOverlay(<OverlayBackdrop className="delegation-history-overlay" onClick={onClose}>
    <div ref={dialogRef} className="delegation-history" role="dialog" aria-modal="true" aria-labelledby="delegation-history-title" tabIndex={-1} onClick={(event) => event.stopPropagation()} onKeyDown={keyDown}>
      <header className="delegation-history-header"><div><h2 id="delegation-history-title">{t("delegationHistory.title")}</h2><p>{t("delegationHistory.allProjects")}</p></div>
        <TooltipButton tooltip={t("delegationHistory.close")} ariaLabel={t("delegationHistory.close")} onClick={onClose}><IconClose size={16} /></TooltipButton>
      </header>
      <div className="delegation-history-body">
        {detail ? <section className="delegation-history-detail">
          <div className="delegation-history-detail-head"><Button size="sm" variant="ghost" onClick={() => { setDetail(null); setNavigationError(false); requestAnimationFrame(() => [...(dialogRef.current?.querySelectorAll<HTMLElement>("[data-delegation-id]") ?? [])].find((row) => row.dataset.delegationId === detailReturn.current)?.focus()); }}>{t("delegationHistory.back")}</Button><Button size="sm" disabled={navigating} onClick={() => void openSource(detail.sessionId)}>{t("delegationHistory.openSource")}</Button></div>
          {navigationError ? <p role="alert">{t("delegationHistory.navigationFailed")}</p> : null}
          <h3>{detail.agentName}</h3><p>{source(detail)}</p><p>{detail.description}</p>
          <dl><dt>{t("delegationHistory.status")}</dt><dd>{t(`delegationHistory.statuses.${detail.status}`)}</dd><dt>{t("delegationHistory.created")}</dt><dd>{date(detail.createdAt)}</dd>
            {detail.completedAt ? <><dt>{t("delegationHistory.completed")}</dt><dd>{date(detail.completedAt)}</dd></> : null}
            {detail.modelId ? <><dt>{t("delegationHistory.model")}</dt><dd>{detail.modelId}</dd></> : null}
            {detail.requestedModel ? <><dt>{t("delegationHistory.requestedModel")}</dt><dd>{detail.requestedModel}</dd></> : null}
            {detail.modelReason ? <><dt>{t("delegationHistory.modelReason")}</dt><dd>{detail.modelReason}</dd></> : null}</dl>
          <h4>{t("delegationHistory.task")}</h4>{detail.taskTruncated ? <p role="note">{t("delegationHistory.truncated")}</p> : null}<pre className="selectable">{detail.task}</pre>
          {detail.report !== undefined ? <><h4>{t("delegationHistory.report")}</h4>{detail.reportTruncated ? <p role="note">{t("delegationHistory.truncated")}</p> : null}<pre className="selectable">{detail.report}</pre></> : null}
          {detail.error ? <><h4>{t("delegationHistory.error")}</h4><pre className="selectable">{detail.error.code}: {detail.error.message}</pre></> : null}
        </section> : <>
          <section className="delegation-history-pending"><h3>{t("delegationHistory.pending")}</h3>
            {approvals.loading ? <p role="status">{t("delegationHistory.loading")}</p> : null}
            {approvals.loadError ? <div role="alert">{t("delegationHistory.loadFailed")} <Button size="sm" onClick={() => void approvals.reload()}>{t("delegationHistory.retry")}</Button></div> : null}
            {!approvals.loading && !approvals.loadError && !pending.length ? <p>{t("delegationHistory.noPending")}</p> : null}
            {pending.map((request) => <div className="delegation-history-pending-row" key={`${request.sessionId}:${request.requestId}`}><div><strong>{request.agentName || t("delegationHistory.delegate")}</strong><p>{source(request)}</p><p>{request.description}</p></div><Button size="sm" disabled={!approvalIsLive(request, approvals.now)} onClick={() => openApproval(request)}>{t("delegationHistory.viewApproval")}</Button></div>)}
          </section>
          <section className="delegation-history-runs"><div className="delegation-history-section-head"><h3>{t("delegationHistory.runs")}</h3><Button size="sm" variant="ghost" onClick={() => void load(0, filter)}>{t("delegationHistory.refresh")}</Button></div>
            <SegmentedControl className="delegation-history-filters" role="group" label={t("delegationHistory.filter")} value={filter} onChange={setFilter} options={(["all", "running", "ended"] as const).map((value) => ({ value, label: t(`delegationHistory.filters.${value}`) }))} />
            {entries.map((entry) => <Button key={entry.id} data-delegation-id={entry.id} variant="ghost" className="delegation-history-row" onClick={() => { detailReturn.current = entry.id; setDetail(entry); requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLButtonElement>(".delegation-history-detail-head button")?.focus()); }}><span><strong>{entry.agentName}</strong><span>{source(entry)}</span><span>{entry.description}</span>{entry.modelId ? <span>{t("delegationHistory.model")}: {entry.modelId}</span> : null}</span><span className="delegation-history-row-meta"><span>{t(`delegationHistory.statuses.${entry.status}`)}</span><time dateTime={entry.createdAt}>{date(entry.createdAt)}</time></span></Button>)}
            {loading ? <p role="status">{t("delegationHistory.loading")}</p> : null}
            {errorOffset !== null ? <div role="alert">{t("delegationHistory.loadFailed")} <Button size="sm" onClick={() => void load(errorOffset, filter)}>{t("delegationHistory.retry")}</Button></div> : null}
            {!loading && errorOffset === null && !entries.length && nextOffset === null ? <p>{t("delegationHistory.empty")}</p> : null}
            {!loading && errorOffset === null && nextOffset !== null ? <Button size="sm" onClick={() => void load(nextOffset, filter)}>{t("delegationHistory.loadMore")}</Button> : null}
            {!loading && errorOffset === null && entries.length > 0 && nextOffset === null ? <p>{t("delegationHistory.end")}</p> : null}
          </section>
        </>}
      </div>
    </div>
  </OverlayBackdrop>);
}
