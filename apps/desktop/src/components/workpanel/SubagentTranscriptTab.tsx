import { SubagentRunPolicySummary } from "./SubagentRunPolicySummary";
import { SubagentDiagnosticsSummary } from "./SubagentDiagnosticsSummary";
import { SubagentFailurePolicySummary } from "./SubagentFailurePolicySummary";
import { SubagentChildComposer } from "./SubagentChildComposer";
import { DelegationSelectionSummary } from "../../features/chat/transcript/DelegationSelectionSummary";
import { toolResultPayload } from "../../lib/tool-presentation";
import { SubagentStopButton } from "../../features/chat/transcript/SubagentStopButton";
import { collectDelegationStatuses, subagentOutcome } from "../../lib/subagent-topology";
import { Fragment, useLayoutEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import { useFollowScroll } from "../../hooks/use-follow-scroll";
import { useTranscriptView } from "../../hooks/use-transcript-view";
import { useTranscriptSearchFocus } from "../../hooks/use-transcript-search-focus";
import { IconArrowDown, IconBot, IconChevronDown } from "../icons";
import { Button, TooltipButton } from "../ui";
import { DisclosureAnchorContext } from "../../lib/disclosure-anchor-context";
import { TranscriptDisclosureProvider } from "../../features/chat/transcript/disclosure";
import { buildSubagentTranscript } from "../../lib/subagent-transcript";
import { reviewChangeFromMessage } from "../../lib/workspace-review";
import {
  AssistantErrorMessage,
  ThinkingRow,
} from "../../features/chat/transcript/shared";
import {
  ReviewChangeCard,
} from "../ReviewChangeCard";
import { ToolRow } from "../../features/chat/transcript/ToolRow";
import { Markdown } from "../Markdown";
import { delegateModelId, delegateThinkingLevel } from "../../features/chat/transcript/model";

/**
 * The work-panel tab showing one delegation as a conversation (issue #917).
 *
 * Every `Task` call of the delegation chain opens a turn: the prompt the
 * parent sent renders as a user row, and the rows the delegate produced under
 * that call render with the main transcript's own message-list language —
 * tool rows, thinking rows, and answer bubbles alike. Follow-up `Task` calls
 * on the same delegation append further turns, so a resumed delegate reads as
 * one continuing user/assistant exchange.
 *
 * Local Desktop sessions can message a running child or explicitly resume a
 * settled child. Drafts and request identities are scoped to the owning chain.
 */
export function SubagentTranscriptTab({ delegationId }: { delegationId: string }) {
  return (
    <TranscriptDisclosureProvider key={delegationId}>
      <SubagentTranscriptSurface delegationId={delegationId} />
    </TranscriptDisclosureProvider>
  );
}

function SubagentTranscriptSurface({ delegationId }: { delegationId: string }) {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  // A tab only renders inside a presented panel, which always has a session;
  // the empty key keeps the hook's contract while nothing is active.
  const transcript = useTranscriptView(activeSessionId ?? "");
  const { messages } = transcript;
  const transcriptResult = useMemo(
    () => buildSubagentTranscript(messages, delegationId),
    [messages, delegationId],
  );
  const delegateSettings = useMemo(() => {
    const result = transcriptResult?.latestCall;
    const payload = result ? toolResultPayload(result) : undefined;
    const id = payload && typeof payload === "object" && "delegationId" in payload ? payload.delegationId : undefined;
    return {
      payload,
      delegationId: typeof id === "string" && id ? id : undefined,
      modelId: result ? delegateModelId(result) : "",
      thinkingLevel: result ? delegateThinkingLevel(result) : undefined,
    };
  }, [transcriptResult]);
  const delegateOutcome = useMemo(() => transcriptResult ? subagentOutcome(transcriptResult.latestCall,
    collectDelegationStatuses(messages.filter(message => message.role === "tool")
      .map(message => ({ kind: "tool" as const, message })))) : undefined, [messages, transcriptResult]);
  const delegateRunning = delegateOutcome === "running";
  const isRunning = useAppStore(
    (state) => (activeSessionId ? state.runningSessions[activeSessionId] ?? false : false),
  );
  const {
    scrollRef,
    contentRef,
    showJump,
    handleScroll,
    jumpToLatest,
    scheduleFollowScroll,
    releaseFollow,
    disclosureAnchorNotifier,
  } = useFollowScroll();

  // Several delegation tabs can be open at once, so an explicit search hit
  // is claimed only by the tab whose own conversation contains the message;
  // the other tabs stay where the reader left them.
  const searchTarget = useMemo(() => {
    const focus = transcript.focus;
    if (!focus) return null;
    const claimed = transcriptResult?.turns.some((turn) =>
      turn.rows.some((row) => row.message.id === focus.messageId),
    );
    return claimed ? focus : null;
  }, [transcript.focus, transcriptResult]);

  useTranscriptSearchFocus({
    target: searchTarget,
    source:
      messages.find((message) => message.id === searchTarget?.messageId)?.content ?? "",
    scrollRef,
    contentRef,
    contentVersion: messages,
    onNavigate: releaseFollow,
  });

  useLayoutEffect(() => {
    if (!searchTarget) jumpToLatest();
  }, [jumpToLatest, searchTarget]);

  useLayoutEffect(() => {
    scheduleFollowScroll();
  }, [messages, scheduleFollowScroll]);

  return (
    <DisclosureAnchorContext.Provider value={disclosureAnchorNotifier}>
      <div className="subagent-transcript-tab" data-testid="subagent-transcript-tab">
        <div
          ref={scrollRef}
          data-scroll-owner="follow"
          className="subagent-transcript-scroll"
          onScroll={handleScroll}
          role="log"
          aria-live="polite"
          aria-label={t("panel.subagent")}
          tabIndex={0}
        >
          <div ref={contentRef} className="subagent-transcript-list">
            <DelegationSelectionSummary payload={delegateSettings.payload} />
            <SubagentRunPolicySummary payload={delegateSettings.payload} />
            <SubagentFailurePolicySummary payload={delegateSettings.payload} />
            <SubagentDiagnosticsSummary payload={delegateSettings.payload} />
            {transcriptResult ? (
              transcriptResult.turns.map((turn, turnIndex) => (
                <Fragment key={`turn-${turnIndex}`}>
                  <div className="message-row user">
                    <div className="message-col">
                      <div className="message-bubble">
                        <div className="message-user-text selectable">
                          {turn.task || t("panel.subagentTaskEmpty")}
                        </div>
                      </div>
                    </div>
                  </div>
                  {turn.rows.map((row) =>
                    row.kind === "tool" ? (
                      reviewChangeFromMessage(row.message) ? (
                        <ReviewChangeCard
                          key={row.message.id}
                          message={row.message}
                          asToolRow
                        />
                      ) : (
                        <ToolRow key={row.message.id} message={row.message} />
                      )
                    ) : row.kind === "thinking" ? (
                      <ThinkingRow
                        key={`thinking-${row.message.id}`}
                        message={row.message}
                        streaming={isRunning && row.message.status === "streaming"}
                      />
                    ) : row.kind === "user" ? (
                      <div className="message-row user" data-message-id={row.message.id} key={row.message.id}>
                        <div className="message-col"><div className="message-bubble">
                          <div className="message-user-text selectable">{row.message.content}</div>
                        </div></div>
                      </div>
                    ) : (
                      <div
                        className="message-row assistant"
                        data-message-id={row.message.id}
                        key={`answer-${row.message.id}`}
                      >
                        <div className="message-col">
                          <div className="message-bubble">
                            {row.message.content ? (
                              <div className="prose-chat selectable">
                                <Markdown source={row.message.content} />
                              </div>
                            ) : null}
                            {row.message.error ? (
                              <AssistantErrorMessage message={row.message} />
                            ) : null}
                          </div>
                        </div>
                      </div>
                    ),
                  )}
                </Fragment>
              ))
            ) : (
              <div className="subagent-transcript-empty" role="status">
                {t("panel.subagentEmpty")}
              </div>
            )}
          </div>
        </div>
        {showJump ? (
          <TooltipButton
            type="button"
            className="jump-latest-btn subagent-transcript-jump"
            tooltip={t("chat.scrollToBottom")}
            ariaLabel={t("chat.scrollToBottom")}
            onClick={jumpToLatest}
          >
            <IconArrowDown size={14} />
          </TooltipButton>
        ) : null}
        <SubagentChildComposer sessionId={activeSessionId ?? ""}
          chainId={transcriptResult?.chainId ?? delegationId}
          delegationId={delegateSettings.delegationId} outcome={delegateOutcome}>
            <Button variant="ghost"
              type="button"
              className="icon-btn composer-model-thinking-chip subagent-transcript-model-picker"
              disabled
              aria-haspopup="listbox"
              aria-label={`${t("chat.model")}: ${delegateSettings.modelId || "—"}. ${t("chat.reasoningLevel")}: ${delegateSettings.thinkingLevel || "—"}`}
            >
              <span className="composer-model-thinking-icon" aria-hidden="true"><IconBot size={14} /></span>
              <span className="composer-model-thinking-model">{delegateSettings.modelId || "—"}</span>
              <span className="composer-model-thinking-level">{delegateSettings.thinkingLevel || "—"}</span>
              <IconChevronDown size={12} aria-hidden="true" className="composer-model-thinking-chevron" />
            </Button>
            {delegateRunning && delegateSettings.delegationId ? (
              <SubagentStopButton delegationId={delegateSettings.delegationId} running compact />
            ) : null}
        </SubagentChildComposer>
      </div>
    </DisclosureAnchorContext.Provider>
  );
}
