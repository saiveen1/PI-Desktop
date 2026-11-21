import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type AgentActivity, type AgentRunDiagnostics } from "@pi-desktop/shared";
import { Button } from "../../../components/ui";
import { CopyButton } from "./shared";
import { placeContextInspector, type ContextInspectorPlacement } from "../../../lib/context-inspector-position";
import { portalToBody } from "../../../lib/portal-visibility";
import { runElapsedMs, runEventAgeMs } from "../../../lib/run-diagnostics";
import { formatToolDuration } from "../../../lib/tool-display";

const RETRY_BADGE_MS = 10_000;

/** One factual diagnostic snapshot, shared by live status and completed replies. */
export function RunStatusIndicator({
  diagnostics, activity, label, startedAt, summary = false,
}: {
  diagnostics?: AgentRunDiagnostics;
  activity?: AgentActivity;
  label: string;
  startedAt?: number;
  summary?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState<ContextInspectorPlacement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hovered = useRef(false);
  const panelId = useId();
  const duration = (ms: number) => formatToolDuration(Math.floor(Math.max(0, ms) / 1000));
  // A historical snapshot without a terminal event cannot measure a whole run.
  const referenceTime = diagnostics?.endedAt ?? (summary ? undefined : now);
  const elapsed = referenceTime === undefined ? undefined : diagnostics
    ? duration(runElapsedMs(diagnostics, referenceTime))
    : startedAt !== undefined ? duration(referenceTime - startedAt) : undefined;
  const phaseKey = diagnostics?.phase === "thinking" ? "chat.thinking"
    : diagnostics?.phase === "generating" ? "chat.runDetails.generating"
    : diagnostics?.phase === "searching" ? "chat.runDetails.searching"
    : diagnostics?.phase === "tool" ? "chat.runDetails.tools" : undefined;
  const visibleLabel = !summary && !activity && phaseKey ? t(phaseKey) : label;
  const retryError = activity?.phase === "retrying" ? activity.error : undefined;
  const hasDetails = Boolean(diagnostics || retryError);
  const cancelClose = useCallback(() => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  }, []);
  const close = useCallback(() => {
    cancelClose();
    hovered.current = false;
    setOpen(false);
    setPinned(false);
    setPosition(null);
  }, [cancelClose]);
  const show = useCallback(() => { cancelClose(); setOpen(true); }, [cancelClose]);
  const scheduleClose = useCallback(() => {
    cancelClose();
    if (pinned || hovered.current || trigger.current?.contains(document.activeElement) || panel.current?.contains(document.activeElement)) return;
    closeTimer.current = setTimeout(close, 120);
  }, [cancelClose, close, pinned]);

  useEffect(() => {
    if (summary || diagnostics?.endedAt !== undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [summary, diagnostics?.endedAt]);
  useEffect(() => {
    const at = diagnostics?.lastRetry?.at;
    if (at === undefined) return;
    const current = Date.now();
    setNow(current);
    const remaining = at + RETRY_BADGE_MS - current;
    if (remaining <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [diagnostics?.lastRetry?.at]);
  useEffect(() => cancelClose, [cancelClose]);
  useEffect(() => { close(); }, [diagnostics?.turnId, close]);

  const updatePosition = useCallback(() => {
    const anchor = trigger.current;
    const floating = panel.current;
    if (!anchor || !floating) return;
    const rect = anchor.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) { close(); return; }
    const box = floating.getBoundingClientRect();
    const pane = anchor.closest(".main-pane")?.getBoundingClientRect();
    setPosition(placeContextInspector({ trigger: rect, popover: box, pane: pane ?? null,
      viewport: { width: window.innerWidth, height: window.innerHeight } }));
  }, [close]);
  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updatePosition);
    if (panel.current) observer?.observe(panel.current);
    const pane = trigger.current?.closest(".main-pane");
    if (pane) observer?.observe(pane);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !trigger.current?.contains(target) && !panel.current?.contains(target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (panel.current?.contains(document.activeElement)) trigger.current?.focus();
      close();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", close);
    };
  }, [close, open]);

  const age = (at: number | undefined, run: AgentRunDiagnostics, reference: number) => {
    const ms = runEventAgeMs(at, run, reference);
    return ms === undefined ? t("chat.runDetails.notObserved") : t("chat.runDetails.ago", { time: duration(ms) });
  };
  const number = new Intl.NumberFormat(i18n.language);
  const rows: Array<[string, string]> = [];
  if (diagnostics) {
    if (elapsed !== undefined) rows.push([t("chat.runDetails.total"), elapsed]);
    if (!summary) rows.push([t("chat.runDetails.stage"), visibleLabel]);
    if (referenceTime !== undefined && activity) rows.push([t("chat.runDetails.stageTime"), duration(referenceTime - activity.since)]);
    if (referenceTime !== undefined && diagnostics.requestStartedAt !== undefined)
      rows.push([t("chat.runDetails.requestTime"), duration(referenceTime - diagnostics.requestStartedAt)]);
    rows.push([t("chat.runDetails.requests"), number.format(diagnostics.requestCount)]);
    rows.push([t("chat.runDetails.attempt"), number.format(diagnostics.requestAttempt)]);
    rows.push([t("chat.runDetails.retries"), t("chat.runDetails.retrySplit", { total: diagnostics.retryCount, rate: diagnostics.rateLimitRetries, transient: diagnostics.transientRetries })]);
    rows.push([t("chat.runDetails.backoff"), duration(diagnostics.retryWaitMs)]);
    if (referenceTime !== undefined) {
      rows.push([t("chat.runDetails.modelUpdate"), age(diagnostics.lastEventAt, diagnostics, referenceTime)]);
      rows.push([t("chat.runDetails.answerUpdate"), age(diagnostics.lastTextAt, diagnostics, referenceTime)]);
    }
    if (diagnostics.inputTokens !== undefined) rows.push([t("chat.runDetails.context"), t("chat.runDetails.estimated", { tokens: number.format(diagnostics.inputTokens) })]);
    if (diagnostics.contextWindow !== undefined) rows.push([t("chat.runDetails.window"), number.format(diagnostics.contextWindow)]);
    if (diagnostics.termination) {
      const termination = diagnostics.termination;
      rows.push([t("outputGuard.normalizedReason"), t(`outputGuard.reason.${termination.stopReason}`)]);
      if (termination.outputTokens !== undefined) rows.push([t("outputGuard.outputTokens"), number.format(termination.outputTokens)]);
      if (termination.maxOutputTokens !== undefined) rows.push([t("outputGuard.maxOutputTokens"), number.format(termination.maxOutputTokens)]);
      if (termination.recoveryAttempts !== undefined) rows.push([t("outputGuard.recoveryAttempts"), number.format(termination.recoveryAttempts)]);
    }
    if (diagnostics.lastRetry) rows.push([t("chat.runDetails.lastFailure"), [diagnostics.lastRetry.code,
      diagnostics.lastRetry.providerStatus !== undefined ? `HTTP ${diagnostics.lastRetry.providerStatus}` : undefined,
      diagnostics.lastRetry.networkCode].filter(Boolean).join(" · ")]);
    if (diagnostics.infiniteRetry) rows.push([t("chat.runDetails.policy"), t("chat.runDetails.unlimited")]);
  }
  const contents = <>
    <span className="working-indicator-label">{visibleLabel}</span>
    {elapsed ? <span className="working-elapsed" aria-hidden="true">{summary ? elapsed : t("chat.runDetails.elapsed", { time: elapsed })}</span> : null}
    {diagnostics?.lastRetry && diagnostics.retryCount > 0 && now - diagnostics.lastRetry.at < RETRY_BADGE_MS ? <span className="run-status-retries">{t("chat.runDetails.retryBadge", { count: diagnostics.retryCount })}</span> : null}
  </>;
  return <div className={summary ? "run-status-summary" : `working-indicator${activity ? " run-activity-indicator" : ""}`}
    data-phase={activity?.phase ?? diagnostics?.phase} data-testid={summary ? "run-status-summary" : activity ? "run-activity-indicator" : "working-indicator"}>
    {!summary ? <span className="working-indicator-mark" aria-hidden="true"><span /><span /><span /></span> : null}
    {hasDetails ? <Button variant="ghost" className="run-status-trigger" ref={trigger} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? panelId : undefined} aria-label={t("chat.runDetails.title")}
      onPointerEnter={() => { hovered.current = true; show(); }}
      onPointerLeave={() => { hovered.current = false; scheduleClose(); }}
      onFocus={show} onBlur={scheduleClose}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown") return;
        event.preventDefault();
        show();
        setPinned(true);
        requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>("button")?.focus());
      }}
      onClick={() => { if (pinned) close(); else { show(); setPinned(true); } }}>{contents}</Button> : contents}
    {!summary ? <span className="run-status-announcement" role="status" aria-live="polite">{visibleLabel}</span> : null}
    {open && hasDetails ? portalToBody(<div ref={panel} id={panelId} className={`run-status-popover${position ? " is-open" : ""}`}
      role="dialog" aria-label={t("chat.runDetails.title")}
      style={position ? { top: position.top, left: position.left, maxWidth: position.maxWidth } : undefined}
      onPointerEnter={() => { hovered.current = true; cancelClose(); }}
      onPointerLeave={() => { hovered.current = false; scheduleClose(); }} onBlur={scheduleClose}>
      <strong>{t("chat.runDetails.title")}</strong>
      <dl>{rows.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
      <CopyButton text={JSON.stringify({ runDiagnostics: diagnostics, phase: activity?.phase }, null, 2)} label={t("chat.runDetails.copy")} />
      {retryError ? <div className="run-status-error"><strong>{t(`errors.${retryError.code}`, { defaultValue: t("chat.responseFailed") })}</strong><div>{retryError.code}{retryError.providerStatus ? ` · HTTP ${retryError.providerStatus}` : ""}{retryError.networkCode ? ` · ${retryError.networkCode}` : ""}</div><p>{retryError.message}</p></div> : null}
      <p className="run-status-note">{t("chat.runDetails.evidenceNote")}</p>
    </div>) : null}
  </div>;
}
