import { Fragment, useLayoutEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SubagentRunPolicySummary } from "./SubagentRunPolicySummary";
import { SubagentDiagnosticsSummary } from "./SubagentDiagnosticsSummary";
import { SubagentFailurePolicySummary } from "./SubagentFailurePolicySummary";
import { SubagentChildComposer } from "./SubagentChildComposer";
import { DelegationSelectionSummary } from "../../features/chat/transcript/DelegationSelectionSummary";
import { SubagentStopButton } from "../../features/chat/transcript/SubagentStopButton";
import { SubagentRetryButton } from "../../features/chat/transcript/SubagentRetryButton";
import { SubagentTurnContent } from "../../features/chat/transcript/SubagentTurnContent";
import { TranscriptDisclosureProvider } from "../../features/chat/transcript/disclosure";
import { delegateModelId, delegateThinkingLevel } from "../../features/chat/transcript/model";
import { SubagentModelInfo } from "../../features/chat/transcript/SubagentModelInfo";
import { SlotSessionProvider } from "../../plugins/renderer-slots/use-slots";
import { collectDelegationFailures, collectDelegationStatuses, delegationIsCreating } from "../../lib/subagent-topology";
import { delegationAttempt, recordedDelegationId } from "../../lib/subagent-panel";
import { subagentAttemptReason, subagentTaskOutcome, subagentTaskStatusKey, subagentTaskTitle, subagentTaskTone } from "../../lib/subagent-task-presentation";
import { subagentsWorkPanelTab } from "../../lib/work-panel-tabs";
import { toolResultPayload } from "../../lib/tool-presentation";
import { buildSubagentTranscript, delegateTaskDescription } from "../../lib/subagent-transcript";
import { DisclosureAnchorContext } from "../../lib/disclosure-anchor-context";
import { TranscriptSearchContext } from "../../lib/transcript-search-context";
import { useAppStore } from "../../stores/app-store";
import { useFollowScroll } from "../../hooks/use-follow-scroll";
import { useTranscriptView } from "../../hooks/use-transcript-view";
import { useTranscriptSearchFocus } from "../../hooks/use-transcript-search-focus";
import { IconArrowDown, IconBot, IconChevronLeft } from "../icons";
import { Button, TooltipButton } from "../ui";
import { useSubagentHistory } from "../../features/delegations/useSubagentHistory";
import { delegationHistoryDiagnostics } from "../../features/delegations/session-delegation-tasks";

/** Task detail, direct input and index share the originating session and chain. */
export function SubagentTranscriptTab({ delegationId }: { delegationId: string }) {
  const sessionId = useAppStore((state) => state.activeSessionId) ?? "";
  return <SlotSessionProvider sessionId={sessionId}>
    <TranscriptDisclosureProvider key={`${sessionId}:${delegationId}`} sessionId={sessionId}>
      <SubagentTranscriptSurface key={`${sessionId}:${delegationId}`} delegationId={delegationId} sessionId={sessionId} />
    </TranscriptDisclosureProvider>
  </SlotSessionProvider>;
}

function SubagentTranscriptSurface({ delegationId, sessionId }: { delegationId: string; sessionId: string }) {
  const { t } = useTranslation();
  const transcript = useTranscriptView(sessionId);
  const history = useSubagentHistory(sessionId, delegationId, transcript.messages, transcript.hasMoreBefore || transcript.hasMoreAfter);
  const { messages } = history;
  const openTab = useAppStore((state) => state.openWorkPanelTabForSession);
  const items = useMemo(() => messages.filter(message => message.role === "tool")
    .map(message => ({ kind: "tool" as const, message })), [messages]);
  const sessionRunning = useAppStore((state) => state.runningSessions[sessionId] === true);
  const statuses = useMemo(() => new Map([...collectDelegationStatuses(items, { turnLive: sessionRunning }), ...history.statuses]), [items, sessionRunning, history.statuses]);
  const transcriptResult = useMemo(() => buildSubagentTranscript(messages, delegationId), [messages, delegationId]);
  const selectedCall = history.attemptMessage ?? transcriptResult?.latestCall;
  const selected = selectedCall ? { kind: "tool" as const, message: selectedCall } : undefined;
  const outcome = selected ? subagentTaskOutcome(selected.message, statuses) : undefined;
  const delegateRunning = outcome === "running" && Boolean(selected && !delegationIsCreating(selected.message));
  const attempt = selected && delegationAttempt(selected.message);
  const attemptTask = attempt && selectedCall ? delegateTaskDescription(selectedCall) : "";
  const payload = selected ? toolResultPayload(selected.message) : undefined;
  const recordedId = selected && recordedDelegationId(selected.message);
  const modelId = selected ? delegateModelId(selected.message) : "";
  const thinkingLevel = selected ? delegateThinkingLevel(selected.message) : undefined;
  const title = selected ? subagentTaskTitle(selected.message, t("chat.subagentUnnamed")) : t("panel.subagent");
  const failure = useMemo(() => recordedId ? collectDelegationFailures(items).get(recordedId) : undefined, [items, recordedId]);
  const {
    scrollRef, contentRef, showJump, handleScroll, jumpToLatest, scheduleFollowScroll,
    releaseFollow, disclosureAnchorNotifier,
  } = useFollowScroll();
  const searchTarget = useMemo(() => {
    const focus = transcript.focus;
    if (!focus) return null;
    return transcriptResult?.turns.some(turn => turn.rows.some(row => row.message.id === focus.messageId)) ? focus : null;
  }, [transcript.focus, transcriptResult]);
  useTranscriptSearchFocus({
    target: searchTarget, visible: true,
    source: messages.find(message => message.id === searchTarget?.messageId)?.content ?? "",
    scrollRef, contentRef, contentVersion: messages, onNavigate: releaseFollow,
  });
  useLayoutEffect(() => {
    if (!searchTarget) jumpToLatest();
  }, [jumpToLatest, searchTarget]);
  useLayoutEffect(() => {
    scheduleFollowScroll();
  }, [messages, scheduleFollowScroll]);
  return <TranscriptSearchContext.Provider value={searchTarget}><DisclosureAnchorContext.Provider value={disclosureAnchorNotifier}>
    <div className="subagent-transcript-tab" data-testid="subagent-transcript-tab">
      <header className="subagent-transcript-heading" data-tone={selected ? subagentTaskTone(selected.message) : 0}>
        <TooltipButton tooltip={t("chat.taskGroups.back")} ariaLabel={t("chat.taskGroups.back")}
          onClick={() => openTab(sessionId, subagentsWorkPanelTab())}>
          <IconChevronLeft size={16} />
        </TooltipButton>
        <span className="subagent-task-icon" aria-hidden><IconBot size={17} /></span>
        <span className="subagent-task-kind">{t("subagentControls.taskLabel")}</span>
        <strong className="subagent-task-title">{title}</strong>
        {recordedId ? <span className="subagent-transcript-model"><SubagentModelInfo modelId={modelId} thinkingLevel={thinkingLevel} /></span> : null}
        {selected ? <span className="subagent-task-status" role="status">{t(subagentTaskStatusKey(selected.message, statuses))}</span> : null}
        {recordedId ? <>
          <SubagentStopButton delegationId={recordedId} running={delegateRunning} name={title} compact />
          <SubagentRetryButton delegationId={recordedId} failed={outcome === "failed"} compact />
        </> : null}
      </header>
      <div ref={scrollRef} data-scroll-owner="follow" className="subagent-transcript-scroll"
        onScroll={handleScroll} role="log" aria-live="polite" aria-label={t("panel.subagent")} tabIndex={0}>
        <div ref={contentRef} className="subagent-transcript-list">
          {history.loading && !transcriptResult && !history.entry?.report ? <p role="status">{t("delegationHistory.loading")}</p> : null}
          {history.hasMoreBefore && !history.loading ? <Button size="sm" variant="ghost" disabled={history.loading}
            onClick={() => { releaseFollow(); void history.loadMore("before"); }}>{t("chat.showEarlierMessages")}</Button> : null}
          {history.error ? <p role="alert">{t("delegationHistory.loadFailed")} <Button size="sm" variant="ghost" onClick={history.retry}>{t("delegationHistory.retry")}</Button></p> : null}
          {failure && outcome !== "running" && outcome !== "completed" ? <p className="tool-row-status error" role="alert">{failure.message || failure.code}</p> : null}
          {attempt ? <p className="subagent-attempt-reason">{subagentAttemptReason(attempt, t)}</p> : null}
          {recordedId || history.entry ? <details className="subagent-task-report">
            <summary>{t("chat.runDetails.title")}</summary>
            <DelegationSelectionSummary payload={payload} />
            <SubagentRunPolicySummary payload={payload} />
            <SubagentFailurePolicySummary payload={payload} />
            <SubagentDiagnosticsSummary payload={payload ?? (history.entry ? delegationHistoryDiagnostics(history.entry) : undefined)} />
          </details> : null}
          {transcriptResult ? transcriptResult.turns.map((turn, index) => (
            <Fragment key={`${delegationId}:${index}`}>
              <details className="subagent-task-report">
                <summary>{t("chat.taskGroups.brief")}</summary>
                <div className="message-user-text selectable">{turn.task || t("panel.subagentTaskEmpty")}</div>
              </details>
              <SubagentTurnContent id={`${delegationId}:${index}`} rows={turn.rows}
                active={delegateRunning && index === transcriptResult.turns.length - 1} />
            </Fragment>
          )) : attemptTask ? <details className="subagent-task-report">
            <summary>{t("chat.taskGroups.brief")}</summary><div className="message-user-text selectable">{attemptTask}</div>
          </details> : !attempt && !history.loading && !history.error ? <div className="subagent-transcript-empty" role="status">{t("panel.subagentEmpty")}</div> : null}
          {history.entry?.report && !transcriptResult?.turns.some(turn => turn.rows.some(row => row.kind === "answer" && row.message.content.trim() === history.entry?.report?.trim())) ? <section className="subagent-task-report">
            <h3>{t("delegationHistory.report")}</h3>
            {history.entry.reportTruncated ? <p role="note">{t("delegationHistory.truncated")}</p> : null}
            <div className="message-user-text selectable">{history.entry.report}</div>
          </section> : null}
          {history.hasMoreAfter ? <Button size="sm" variant="ghost" disabled={history.loading}
            onClick={() => void history.loadMore("after")}>{t("chat.loadLaterMessages")}</Button> : null}
        </div>
      </div>
      <div className="subagent-transcript-input">
        {showJump ? <TooltipButton type="button" className="jump-latest-btn subagent-transcript-jump"
          tooltip={t("chat.scrollToBottom")} ariaLabel={t("chat.scrollToBottom")} onClick={jumpToLatest}>
          <IconArrowDown size={14} />
        </TooltipButton> : null}
        {recordedId ? <SubagentChildComposer sessionId={sessionId} chainId={transcriptResult?.chainId ?? delegationId}
          delegationId={recordedId} outcome={outcome}>{null}</SubagentChildComposer> : null}
      </div>
    </div>
  </DisclosureAnchorContext.Provider></TranscriptSearchContext.Provider>;
}
