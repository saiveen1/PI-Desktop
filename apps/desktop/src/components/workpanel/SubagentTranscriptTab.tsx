import { Fragment, useLayoutEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SubagentRunPolicySummary } from "./SubagentRunPolicySummary";
import { SubagentDiagnosticsSummary } from "./SubagentDiagnosticsSummary";
import { SubagentFailurePolicySummary } from "./SubagentFailurePolicySummary";
import { SubagentChildComposer } from "./SubagentChildComposer";
import { DelegationSelectionSummary } from "../../features/chat/transcript/DelegationSelectionSummary";
import { SubagentStopButton } from "../../features/chat/transcript/SubagentStopButton";
import { SubagentRetryButton } from "../../features/chat/transcript/SubagentRetryButton";
import { SubagentTaskList } from "../../features/chat/transcript/SubagentTaskList";
import { SubagentTurnContent } from "../../features/chat/transcript/SubagentTurnContent";
import { TranscriptDisclosureProvider } from "../../features/chat/transcript/disclosure";
import { delegateModelId, delegateThinkingLevel } from "../../features/chat/transcript/model";
import { SlotSessionProvider } from "../../plugins/renderer-slots/use-slots";
import { collectDelegationFailures, collectDelegationStatuses, delegationIsCreating, isDelegationActivityItem } from "../../lib/subagent-topology";
import { delegationIdForMessage } from "../../lib/subagent-panel";
import { subagentTaskOutcome, subagentTaskStatusKey, subagentTaskTitle, subagentTaskTone } from "../../lib/subagent-task-presentation";
import { subagentWorkPanelTab } from "../../lib/work-panel-tabs";
import { toolResultPayload } from "../../lib/tool-presentation";
import { buildSubagentTranscript } from "../../lib/subagent-transcript";
import { DisclosureAnchorContext } from "../../lib/disclosure-anchor-context";
import { TranscriptSearchContext } from "../../lib/transcript-search-context";
import { useAppStore } from "../../stores/app-store";
import { useFollowScroll } from "../../hooks/use-follow-scroll";
import { useTranscriptView } from "../../hooks/use-transcript-view";
import { useTranscriptSearchFocus } from "../../hooks/use-transcript-search-focus";
import { IconArrowDown, IconChevronLeft, IconSparkles } from "../icons";
import { TooltipButton } from "../ui";

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
  const [indexOpen, setIndexOpen] = useState(false);
  const transcript = useTranscriptView(sessionId);
  const { messages } = transcript;
  const openTab = useAppStore((state) => state.openWorkPanelTabForSession);
  const items = useMemo(() => messages.filter(message => message.role === "tool")
    .map(message => ({ kind: "tool" as const, message })), [messages]);
  const sessionRunning = useAppStore((state) => state.runningSessions[sessionId] === true);
  const statuses = useMemo(() => collectDelegationStatuses(items, { turnLive: sessionRunning }), [items, sessionRunning]);
  const tasks = useMemo(() => items.filter(isDelegationActivityItem), [items]);
  const transcriptResult = useMemo(() => buildSubagentTranscript(messages, delegationId), [messages, delegationId]);
  const selectedCall = transcriptResult?.latestCall;
  const selected = selectedCall ? { kind: "tool" as const, message: selectedCall } : undefined;
  const outcome = selected ? subagentTaskOutcome(selected.message, statuses) : undefined;
  const delegateRunning = outcome === "running" && Boolean(selected && !delegationIsCreating(selected.message));
  const selectedId = selected ? delegationIdForMessage(selected.message) : delegationId;
  const payload = selected ? toolResultPayload(selected.message) : undefined;
  const recordedId = payload && typeof payload === "object" && "delegationId" in payload &&
    typeof payload.delegationId === "string" ? payload.delegationId : undefined;
  const modelLabel = selected ? [delegateModelId(selected.message), delegateThinkingLevel(selected.message)].filter(Boolean).join(" · ") : "";
  const title = selected ? subagentTaskTitle(selected.message, t("chat.subagentUnnamed")) : t("panel.subagent");
  const failure = useMemo(() => collectDelegationFailures(items).get(selectedId), [items, selectedId]);
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
    target: searchTarget, visible: !indexOpen,
    source: messages.find(message => message.id === searchTarget?.messageId)?.content ?? "",
    scrollRef, contentRef, contentVersion: messages, onNavigate: releaseFollow,
  });
  useLayoutEffect(() => {
    if (searchTarget) setIndexOpen(false);
    else jumpToLatest();
  }, [jumpToLatest, searchTarget]);
  useLayoutEffect(() => {
    if (!indexOpen) scheduleFollowScroll();
  }, [messages, indexOpen, scheduleFollowScroll]);
  const openTask = (id: string, name: string) => {
    setIndexOpen(false);
    if (id !== selectedId) openTab(sessionId, subagentWorkPanelTab(id, name));
  };
  return <TranscriptSearchContext.Provider value={searchTarget}><DisclosureAnchorContext.Provider value={disclosureAnchorNotifier}>
    <div className="subagent-transcript-tab" data-testid="subagent-transcript-tab">
      <header className="subagent-transcript-heading" data-tone={selected ? subagentTaskTone(selected.message) : 0}>
        {!indexOpen ? <TooltipButton tooltip={t("chat.taskGroups.back")} ariaLabel={t("chat.taskGroups.back")} onClick={() => setIndexOpen(true)}>
          <IconChevronLeft size={16} />
        </TooltipButton> : null}
        <span className="subagent-task-icon" aria-hidden><IconSparkles size={17} /></span>
        <strong className="subagent-task-title">{indexOpen ? t("chat.subagentTopology") : title}</strong>
        {!indexOpen && modelLabel ? <span className="subagent-transcript-model" title={modelLabel}>{modelLabel}</span> : null}
        {!indexOpen && selected ? <span className="subagent-task-status" role="status">{t(subagentTaskStatusKey(selected.message, statuses))}</span> : null}
        {!indexOpen ? <>
          <SubagentStopButton delegationId={selectedId} running={delegateRunning} name={title} compact />
          <SubagentRetryButton delegationId={selectedId} failed={outcome === "failed"} compact />
        </> : null}
      </header>
      {indexOpen ? <div className="subagent-transcript-scroll">
        <SubagentTaskList grouped items={tasks} delegationStatuses={statuses} onOpen={openTask} />
      </div> : null}
      <div ref={scrollRef} data-scroll-owner="follow" className="subagent-transcript-scroll" hidden={indexOpen}
        onScroll={handleScroll} role="log" aria-live="polite" aria-label={t("panel.subagent")} tabIndex={0}>
        <div ref={contentRef} className="subagent-transcript-list">
          {failure && outcome !== "running" && outcome !== "completed" ? <p className="tool-row-status error" role="alert">{failure.message || failure.code}</p> : null}
          <details className="subagent-task-report">
            <summary>{t("chat.runDetails.title")}</summary>
            <DelegationSelectionSummary payload={payload} />
            <SubagentRunPolicySummary payload={payload} />
            <SubagentFailurePolicySummary payload={payload} />
            <SubagentDiagnosticsSummary payload={payload} />
          </details>
          {transcriptResult ? transcriptResult.turns.map((turn, index) => (
            <Fragment key={`${delegationId}:${index}`}>
              <details className="subagent-task-report">
                <summary>{t("chat.taskGroups.brief")}</summary>
                <div className="message-user-text selectable">{turn.task || t("panel.subagentTaskEmpty")}</div>
              </details>
              <SubagentTurnContent id={`${delegationId}:${index}`} rows={turn.rows}
                active={delegateRunning && index === transcriptResult.turns.length - 1} />
            </Fragment>
          )) : <div className="subagent-transcript-empty" role="status">{t("panel.subagentEmpty")}</div>}
        </div>
      </div>
      {!indexOpen ? <div className="subagent-transcript-input">
        {showJump ? <TooltipButton type="button" className="jump-latest-btn subagent-transcript-jump"
          tooltip={t("chat.scrollToBottom")} ariaLabel={t("chat.scrollToBottom")} onClick={jumpToLatest}>
          <IconArrowDown size={14} />
        </TooltipButton> : null}
        <SubagentChildComposer sessionId={sessionId} chainId={transcriptResult?.chainId ?? delegationId}
          delegationId={recordedId} outcome={outcome}>{null}</SubagentChildComposer>
      </div> : null}
    </div>
  </DisclosureAnchorContext.Provider></TranscriptSearchContext.Provider>;
}
