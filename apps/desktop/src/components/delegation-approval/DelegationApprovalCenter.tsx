import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DelegationApprovalPrompt } from "@pi-desktop/shared";
import { Button, Checkbox, TooltipButton, portalOverlay } from "../ui";
import { IconClose } from "../icons";
import { useHostSafetySurface } from "../../lib/host-safety-layer";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { ApprovalControls, ApprovalMetadata, modelKey } from "./ApprovalControls";
import { approvalIsLive, approvalKey, useDelegationApprovals } from "./useDelegationApprovals";
import "./delegation-approval.css";

function SafetySurface() { useHostSafetySurface(); useBlockingOverlay(); return null; }
const controlsKey = (request: DelegationApprovalPrompt) => `${approvalKey(request)}:${request.revision}:${modelKey(request.candidate)}`;

/** A non-modal, recoverable decision center. Hiding never sends a host action. */
export function DelegationApprovalCenter({ onNavigate }: { onNavigate: (sessionId: string) => void | Promise<void> }) {
  const { t } = useTranslation();
  const state = useDelegationApprovals();
  const [expanded, setExpanded] = useState(true);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"copied" | "copyFailed" | null>(null);
  const [navigationError, setNavigationError] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const readerRef = useRef<HTMLHeadingElement>(null);
  const copyGeneration = useRef(0);
  const id = useId();
  const pending = state.requests.filter((request) => request.status === "pending");
  const liveCount = pending.filter((request) => approvalIsLive(request, state.now)).length;
  const opened = state.requests.find((request) => approvalKey(request) === openKey);
  const selectedCount = Object.keys(state.selected).length;
  const groups = new Map<string, DelegationApprovalPrompt[]>();
  for (const request of pending) {
    const group = JSON.stringify([request.projectPath ?? request.projectTitle, request.sessionId]);
    groups.set(group, [...(groups.get(group) ?? []), request]);
  }
  const results = state.requests.filter((request) => request.status !== "pending");

  useEffect(() => {
    ++copyGeneration.current; setCopyStatus(null);
    return () => { ++copyGeneration.current; };
  }, [openKey, opened?.revision]);

  const copyTask = async (request: DelegationApprovalPrompt) => {
    const generation = ++copyGeneration.current;
    try {
      await navigator.clipboard.writeText(request.task);
      if (generation === copyGeneration.current) setCopyStatus("copied");
    } catch {
      if (generation === copyGeneration.current) setCopyStatus("copyFailed");
    }
  };

  const navigate = async (sessionId: string) => {
    setNavigationError(false);
    try { await onNavigate(sessionId); } catch { setNavigationError(true); }
  };
  const hide = () => { setExpanded(false); toggleRef.current?.focus(); };
  const closeReader = () => {
    setOpenKey(null);
    requestAnimationFrame(() => document.getElementById(`${id}-task-${state.requests.findIndex((request) => approvalKey(request) === openKey)}`)?.focus());
  };
  const batch = async (action: "allow" | "skip" | "cancel") => {
    setBatchBusy(true);
    try { await state.batch(action); } finally { setBatchBusy(false); }
  };

  if (!state.loading && !state.loadError && (!state.requests.length || (!expanded && !liveCount))) return null;
  return portalOverlay(<aside className={`delegation-center ${opened ? "has-reader" : ""} ${!expanded ? "is-collapsed" : ""}`}
    aria-label={t("delegationApproval.center")}>
    <header className="delegation-center-head">
      <Button ref={toggleRef} variant="ghost" aria-expanded={expanded} aria-controls={`${id}-content`} onClick={() => setExpanded((value) => !value)}>
        {t("delegationApproval.center")} <span className="delegation-count">{liveCount}</span>
      </Button>
      {expanded ? <TooltipButton ariaLabel={t("delegationApproval.hide")} tooltip={t("delegationApproval.hide")} onClick={hide}><IconClose size={16} /></TooltipButton> : null}
    </header>
    <div id={`${id}-content`} className="delegation-center-content" hidden={!expanded}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); hide(); }
      }}>
      {expanded ? <SafetySurface /> : null}
      <section className="delegation-list-column" aria-label={t("delegationApproval.requests")}>
        <div className="delegation-batch">
          <p>{t("delegationApproval.selected", { count: selectedCount })}</p>
          <div className="delegation-row-actions" aria-busy={batchBusy}>
            <Button size="sm" disabled={!selectedCount || batchBusy} onClick={() => void batch("allow")}>{t("delegationApproval.allowSelected")}</Button>
            <Button size="sm" disabled={!selectedCount || batchBusy} onClick={() => void batch("skip")}>{t("delegationApproval.skipSelected")}</Button>
            <Button size="sm" variant="ghost" disabled={!selectedCount || batchBusy} onClick={() => void batch("cancel")}>{t("delegationApproval.cancelSelected")}</Button>
          </div>
        </div>
        <div className="delegation-request-list">
          {state.loading ? <p role="status">{t("delegationApproval.loading")}</p> : null}
          {state.loadError ? <div role="alert"><p>{t("delegationApproval.loadFailed")}</p><Button size="sm" onClick={() => void state.reload()}>{t("delegationApproval.retry")}</Button></div> : null}
          {navigationError ? <p role="alert">{t("delegationApproval.navigationFailed")}</p> : null}
          {!state.loading && !pending.length ? <p className="delegation-empty">{t("delegationApproval.empty")}</p> : null}
          {[...groups].map(([groupKey, requests]) => <section className="delegation-group" key={groupKey} aria-label={requests[0].sessionTitle ?? t("delegationApproval.untitledSession")}>
            <header className="delegation-source">
              <p>{requests[0].projectTitle ?? requests[0].projectPath ?? t("delegationApproval.noProject")}</p>
              <Button variant="ghost" size="sm" onClick={() => void navigate(requests[0].sessionId)}>{t("delegationApproval.openSource", { title: requests[0].sessionTitle ?? t("delegationApproval.untitledSession") })}</Button>
            </header>
            {requests.map((request) => {
              const key = approvalKey(request);
              const index = state.requests.indexOf(request);
              const sending = state.feedback[key]?.state === "sending";
              return <article key={key} className="delegation-request" data-request-id={request.requestId} data-open={openKey === key} aria-labelledby={`${id}-request-${index}`}>
                <div className="delegation-request-heading">
                  <Checkbox checked={key in state.selected} disabled={sending || batchBusy || !approvalIsLive(request, state.now)}
                    label={t("delegationApproval.selectRequest", { agent: request.agentName ?? t("delegationApproval.delegate") })} onChange={() => state.toggle(request)} />
                  <h3 id={`${id}-request-${index}`}>{request.agentName ?? t("delegationApproval.delegate")}</h3>
                </div>
                {request.description ? <p className="delegation-summary">{request.description}</p> : null}
                <ApprovalMetadata request={request} now={state.now} />
                <Button id={`${id}-task-${index}`} size="sm" variant="ghost" className="delegation-task-button" aria-expanded={openKey === key} aria-controls={`${id}-reader`}
                  onClick={() => { setOpenKey(key); requestAnimationFrame(() => readerRef.current?.focus()); }}>{t("delegationApproval.taskDetails")}</Button>
                <ApprovalControls key={controlsKey(request)} request={request} state={state} />
              </article>;
            })}
          </section>)}
          {results.length ? <section className="delegation-results" aria-label={t("delegationApproval.results")}>
            <h3>{t("delegationApproval.results")}</h3>
            {results.map((request) => <p key={approvalKey(request)} role="status">{request.agentName ?? t("delegationApproval.delegate")} · {request.sessionTitle ?? t("delegationApproval.untitledSession")} — {t(`delegationApproval.feedback.${request.status}`)}</p>)}
          </section> : null}
        </div>
      </section>
      {opened ? <section id={`${id}-reader`} className="delegation-reader" aria-labelledby={`${id}-reader-title`}>
        <header className="delegation-reader-head">
          <div className="delegation-reader-title">
            <Button size="sm" variant="ghost" onClick={closeReader}>{t("delegationApproval.back")}</Button>
            <h2 id={`${id}-reader-title`} ref={readerRef} tabIndex={-1}>{t("delegationApproval.taskDetails")}</h2>
            <Button size="sm" onClick={() => void copyTask(opened)}>{t("delegationApproval.copyTask")}</Button>
          </div>
          <Button size="sm" variant="ghost" onClick={() => void navigate(opened.sessionId)}>{t("delegationApproval.openSource", { title: opened.sessionTitle ?? t("delegationApproval.untitledSession") })}</Button>
          <ApprovalMetadata request={opened} now={state.now} compact />
          {copyStatus ? <p role={copyStatus === "copied" ? "status" : "alert"}>{t(`delegationApproval.${copyStatus}`)}</p> : null}
        </header>
        <div className="delegation-task-body selectable" tabIndex={0} aria-label={t("delegationApproval.fullTask")}>
          <ApprovalMetadata request={opened} now={state.now} />
          {opened.task.split(/\n\s*\n/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
        </div>
        <footer className="delegation-reader-actions"><ApprovalControls key={controlsKey(opened)} request={opened} state={state} /></footer>
      </section> : null}
    </div>
  </aside>);
}
