import { useChatSessionCapability } from "../../../hooks/use-chat-session-capability";
import { DelegationSelectionSummary } from "./DelegationSelectionSummary";
import { PlanHistoryCard } from "./PlanHistoryCard";
import { planSubmission } from "../../../lib/plan-history";
import { reviewChangeFromMessage } from "../../../lib/workspace-review";
import { ToolResultImages } from "./ToolResultImages";
import "../../../styles/generated-images.css";
import { memo, useCallback, useId, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { useOpenPreviewTarget } from "../../../hooks/use-preview-target";
import { useChatFileMenu } from "../../../hooks/use-chat-file-menu";
import { ContextMenu } from "../../../components/ContextMenu";
import { useFollowScroll } from "../../../hooks/use-follow-scroll";
import { getToolPreviewTarget } from "../../../lib/chat-links";
import { disclosureKey } from "./disclosure";
import {
  getToolAction,
  getToolDisplayName,
  getToolSummary,
  getToolSummaryValue,
} from "../../../lib/tool-display";
import {
  buildToolPresentation,
  hasToolDetails,
  toolResultChips,
  toolResultPayload,
} from "../../../lib/tool-presentation";
import { getToolStatus, TOOL_STATUS_LABEL_KEYS } from "../../../lib/tool-status";
import { ToolStatusBadge } from "./ToolStatusBadge";
import {
  subagentRunsEqual,
  type SubagentRun,
  type SubagentRunItem,
} from "../../../lib/assistant-turns";
import {
  delegationWasPreempted,
  delegationRoster,
  delegationRosterOutcome,
  delegationRosterSummary,
  lifecycleKindOf, backgroundJobRowOf,
} from "../../../lib/subagent-topology";
import { useAppStore } from "../../../stores/app-store";
import { Markdown } from "../../../components/Markdown";
import { ReviewChangeCard } from "../../../components/ReviewChangeCard";
import { ToolChips, ToolDetailBlocks } from "../../../components/ToolDetails";
import {
  IconArrowDown,
  IconBot,
  IconChevronRight,
} from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import { DisclosureAnchorContext } from "../../../lib/disclosure-anchor-context";
import {
  AssistantErrorMessage,
  DisclosureCollapseRail,
  LIFECYCLE_LABEL_KEYS,
  LIFECYCLE_RUNNING_KEYS,
  PREVIEWABLE_ACTIONS,
  ThinkingRow,
  ToolActionIcon,
  ToolCommandCopy,
  TOOL_ACTION_KEYS,
  TOOL_RUNNING_KEYS,
  useAutomaticDisclosure,
  useMessageRevealRequest,
} from "./shared";
import { delegateAgentName } from "./model";
import { PluginToolCard } from "./PluginToolCard";
import { SubagentUserMessage } from "./SubagentUserMessage";
import { useSlotEntryForKey } from "../../../plugins/renderer-slots/use-slots";

type ToolRowProps = {
  message: UiMessage;
  /** Rows the delegate produced, when this row is a `Task` call (ADR 0062). */
  delegate?: SubagentRun;
  /** The containing turn renders image results outside its process disclosure. */
  imagesInTurn?: boolean;
  /** Claims the containing activity group when this row is manually used. */
  onUserInteraction?: () => void;
};

/** Ordinary rows only depend on their message and attached delegate rows. */
function toolRowPropsEqual(previous: ToolRowProps, next: ToolRowProps): boolean {
  return previous.message === next.message &&
    previous.imagesInTurn === next.imagesInTurn &&
    previous.onUserInteraction === next.onUserInteraction &&
    subagentRunsEqual(previous.delegate, next.delegate);
}

/**
 * One tool call. A call of a plugin's own tool renders the card that plugin
 * registered for it (the `toolCard` slot); the host card below is its
 * fallback, and the only card for every other call. Denied rows keep the host card.
 */
export const ToolRow = memo(function ToolRow(props: ToolRowProps) {
  const { message } = props;
  const cardEntry = useSlotEntryForKey(
    "toolCard",
    message.toolStatus !== "denied" ? message.toolName : undefined,
  );
  const proposal = planSubmission(message);
  if (proposal && message.toolStatus !== "denied") {
    return <PlanHistoryCard message={message} proposal={proposal} onUserInteraction={props.onUserInteraction} />;
  }
  const hostRow = <HostToolRow {...props} />;
  return cardEntry ? (
    <PluginToolCard key={cardEntry.id} entry={cardEntry} message={message} fallback={hostRow} />
  ) : (
    hostRow
  );
}, toolRowPropsEqual);

function HostToolRow({
  message,
  delegate,
  imagesInTurn = false,
  onUserInteraction,
}: ToolRowProps) {
  const { t } = useTranslation();
  const detailsId = useId();
  const localToolsAllowed = useChatSessionCapability("canUseLocalTools");
  const root = useAppStore((s) => localToolsAllowed ? s.workspace?.path : undefined);
  const openTarget = useOpenPreviewTarget();
  const { fileMenu, openFileMenu, closeFileMenu } = useChatFileMenu();
  const status = message.toolStatus;
  const action = getToolAction(message.toolName);
  // Classify the result once; execution and persisted statuses stay untouched.
  const toolStatus = getToolStatus(message);
  const neutralStatus = toolStatus.kind === "skipped" || toolStatus.kind === "interrupted" || toolStatus.kind === "context-required";
  const notStarted = delegationWasPreempted(message);
  // A tool call never opens itself: the payload waits for the user, and a
  // failure or denial stays in the row head either way.
  const revealRequest = useMessageRevealRequest(message.id);
  const disclosure = useAutomaticDisclosure(
    false,
    revealRequest,
    disclosureKey("tool", message.id),
  );
  const { open, toggle: toggleDisclosure, collapse: collapseDisclosure } = disclosure;
  const titleRef = disclosure.titleRef;
  const toggleRow = useCallback(() => {
    onUserInteraction?.();
    toggleDisclosure();
  }, [onUserInteraction, toggleDisclosure]);
  const collapseRow = useCallback(() => {
    onUserInteraction?.();
    collapseDisclosure();
  }, [collapseDisclosure, onUserInteraction]);
  const actionLabel = t(
    status === "running" ? TOOL_RUNNING_KEYS[action] : TOOL_ACTION_KEYS[action],
  );
  const rawName = getToolDisplayName(message.toolName) || t("chat.tool");
  const argSummary = getToolSummary(message.toolName, message.toolArgs);
  const previewTarget = PREVIEWABLE_ACTIONS.has(action)
    ? getToolPreviewTarget(message.toolArgs, root)
    : null;
  // A run row keeps its command in the head and only its output in the body, so
  // the head carries the two things the body no longer offers: a copy of the
  // command, and the outcome (D226).
  const runHead = action === "run";
  const command = runHead
    ? getToolSummaryValue(message.toolName, message.toolArgs)
    : "";
  // A delegation is always expandable: its brief, report and the delegate's
  // own rows all live in the body.
  const hasDetails = hasToolDetails(message) || Boolean(delegate);
  const chips = toolResultChips(message);
  // A lifecycle row (ADR 0089) is about subagents, so it is presented as one:
  // the agent names it reports on replace the bare delegation ids it was
  // called with, and its badge rolls up their statuses (D268).
  const lifecycle = action === "delegate" ? lifecycleKindOf(message) : null;
  const jobRow = lifecycle ? backgroundJobRowOf(message) : null;
  const roster = lifecycle ? delegationRoster(message) : [];
  const rosterSummary = lifecycle ? delegationRosterSummary(roster) : "";
  const rosterOutcome = lifecycle ? delegationRosterOutcome(roster) : null;
  const agentName =
    action === "delegate" && !lifecycle
      ? delegateAgentName(message, delegate)
      : "";
  // The delegate's last answer row is its report, so the body must not print
  // the same text a second time.
  const nestedReport = delegate?.items.some((item) => item.kind === "answer");
  // Keep mounted output and its reading position while an ancestor is folded,
  // but defer formatting hidden streaming updates until it becomes visible.
  const presentation = useRef<{
    message: UiMessage;
    nestedReport: boolean | undefined;
    blocks: ReturnType<typeof buildToolPresentation>;
  } | null>(null);
  if (open && hasDetails && disclosure.parentVisible &&
    (presentation.current?.message !== message || presentation.current?.nestedReport !== nestedReport)) {
    presentation.current = {
      message,
      nestedReport,
      blocks: buildToolPresentation(message, {
        hideSummaryArg: true,
        ...(nestedReport ? { hideDelegateReport: true } : {}),
      }),
    };
  }
  const blocks = open && hasDetails ? presentation.current?.blocks : null;
  const toolStatusLabel = toolStatus.kind === "unknown" ? "" : t(TOOL_STATUS_LABEL_KEYS[toolStatus.kind]);
  // A lifecycle row never falls back to its arguments: while it is still
  // running it has no roster yet, and `delegationIds` would otherwise reach the
  // head as a JSON blob of UUIDs (D268).
  const summary = jobRow
    ? [
        rosterSummary, jobRow.command,
        jobRow.count !== undefined && t("backgroundTasks.headerCount", { count: jobRow.count }),
        jobRow.state && t(`backgroundTasks.${jobRow.state}`),
      ].filter(Boolean).join(" · ")
    : lifecycle ? rosterSummary : argSummary;
  const statusLabel = notStarted ? t("subagentControls.notStarted") : neutralStatus ? toolStatusLabel
    : rosterOutcome ? t(`chat.subagentStatus.${rosterOutcome}`) : toolStatusLabel;

  // Auto-scroll the nested `.tool-row-content` containers to their bottom
  // while the tool is still running. These elements have `max-height: 260px`
  // and `overflow: auto`, creating a nested scroll area that the transcript-
  // level follow scroll cannot reach once the height cap is hit. Only scroll
  // when the container is already near the bottom so a manual scroll-up by
  // the user is not overridden.
  useLayoutEffect(() => {
    if (status !== "running" || !open) return;
    const body = disclosure.bodyRef.current;
    if (!body) return;
    const containers = body.querySelectorAll<HTMLElement>(".tool-row-content");
    for (const el of containers) {
      const nearBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (nearBottom) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [status, open, message, disclosure.bodyRef]);


  const caret = hasDetails ? <IconChevronRight size={12} /> : null;

  return (
    <div
      className={`tool-row ${open ? "open" : ""} status-${toolStatus.kind === "failed" ? "error" : toolStatus.kind}`}
      role="region"
      data-message-id={message.id}
      aria-label={`${t("chat.toolCall")}: ${rawName}${agentName ? `, ${agentName}` : ""}${statusLabel ? `, ${statusLabel}` : ""}`}
    >
        <div className={`tool-row-head${runHead ? " is-run" : ""}`}>
          <button
            ref={titleRef}
            className="tool-row-header"
            aria-expanded={open}
            aria-controls={hasDetails ? detailsId : undefined}
            disabled={!hasDetails}
            title={summary || rawName}
            onClick={() => hasDetails && toggleRow()}
          >
            <span
              className={`tool-row-icon${lifecycle && !jobRow ? " is-subagent" : ""}`}
            >
              <ToolActionIcon action={jobRow ? (jobRow.kind === "list" ? "list" : "run") : action} />
            </span>
            <span
              className={`tool-row-name ${status === "running" ? "running" : ""}`}
            >
              {jobRow ? rawName : lifecycle
                ? t(
                    (status === "running"
                      ? LIFECYCLE_RUNNING_KEYS
                      : LIFECYCLE_LABEL_KEYS)[lifecycle],
                  )
                : actionLabel}
            </span>
            {status === "running" ? <span className="activity-marker" aria-hidden /> : null}
            {lifecycle && roster.length > 0 ? (
              <span className="tool-row-agent is-count">
                {t("chat.subagentCount", { count: roster.length })}
              </span>
            ) : null}
            {agentName ? (
              <span className="tool-row-agent" title={t("chat.subagentAgent")}>
                {agentName}
              </span>
            ) : null}
            {summary ? (
              <span
                className={`tool-row-summary${previewTarget && localToolsAllowed ? " linked" : ""}`}
                title={
                  previewTarget && localToolsAllowed
                    ? previewTarget.kind === "file"
                      ? t("chat.previewFile")
                      : t("chat.previewUrl")
                    : undefined
                }
                onClick={
                  previewTarget && localToolsAllowed
                    ? (e) => {
                        // Open the preview target instead of toggling details.
                        e.stopPropagation();
                        openTarget(previewTarget);
                      }
                    : undefined
                }
                onContextMenu={
                  localToolsAllowed && previewTarget?.kind === "file"
                    ? (event) =>
                        openFileMenu(event, { path: previewTarget.path })
                    : undefined
                }
              >
                {summary}
              </span>
            ) : null}
            <ToolChips chips={chips} />
            <ToolStatusBadge status={toolStatus} label={statusLabel} runHead={runHead} />
            {runHead || !caret ? null : (
              <span className="tool-row-caret" aria-hidden>
                {caret}
              </span>
            )}
          </button>
          {runHead && command ? <ToolCommandCopy command={command} /> : null}
          {runHead && caret ? (
            // Redundant for the keyboard — the header itself is the disclosure —
            // so it is a pointer target only and stays out of the reading order.
            <button
              className="tool-row-caret is-toggle"
              aria-hidden="true"
              tabIndex={-1}
              onClick={toggleRow}
            >
              {caret}
            </button>
          ) : null}
        </div>
      {blocks && blocks.length > 0 ? (
        <div className="tool-row-body" id={detailsId} ref={disclosure.bodyRef} {...disclosure.bodyEvents}>
          <DisclosureCollapseRail
            label={t("chat.collapseToolOutput")}
            onCollapse={collapseRow}
          />
          {action === "delegate" && !lifecycle ? <DelegationSelectionSummary payload={toolResultPayload(message)} /> : null}
          <ToolDetailBlocks blocks={blocks} plain={runHead} streaming={status === "running"} />
        </div>
      ) : null}
      {!imagesInTurn && <ToolResultImages message={message} />}
      {open && delegate ? (
        <SubagentRunRows
          run={delegate}
          agentName={agentName}
          onCollapse={collapseRow}
        />
      ) : null}
      <ContextMenu state={fileMenu} onClose={closeFileMenu} />
    </div>
  );
}

/**
 * What a delegate did, nested under the `Task` call that spawned it.
 *
 * The rows are the delegate's context, not the parent's, so they are visibly
 * one level in and stay collapsed with the call. Only one level is possible: a
 * delegate has no `Task` tool of its own (ADR 0062).
 */
export const SubagentRunRows = memo(function SubagentRunRows({
  run,
  agentName,
  onCollapse,
  scrollable = true,
  variant = "inline",
}: {
  run: SubagentRun;
  agentName: string;
  onCollapse?: () => void;
  /** Side-panel mode lets the parent panel own the only scrollbar. */
  scrollable?: boolean;
  /** Dock headings are section labels; inline headings name the delegate. */
  variant?: "inline" | "dock";
}) {
  const { t } = useTranslation();
  const headingId = useId();
  if (run.items.length === 0) return null;
  const dock = variant === "dock";
  return (
    <div className={dock ? "subagent-run is-dock" : "subagent-run"}>
      {onCollapse ? (
        <DisclosureCollapseRail
          label={t("chat.collapseDetails")}
          onCollapse={onCollapse}
        />
      ) : null}
      <div
        className={dock ? "subagent-run-heading is-dock" : "subagent-run-heading"}
        id={headingId}
      >
        {dock ? null : <IconBot size={13} aria-hidden />}
        <span>
          {dock
            ? t("chat.subagentProcess")
            : agentName
              ? t("chat.subagentWork", { agent: agentName })
              : t("chat.subagentWorkUnnamed")}
        </span>
        <span className="subagent-run-count">
          {t("chat.processingSteps", { count: run.items.length })}
        </span>
      </div>
      <SubagentRunFollow
        headingId={headingId}
        items={run.items}
        scrollable={scrollable}
      />
    </div>
  );
});

/**
 * Nested follow-scroll for one expanded delegate (D302). Mounted only once
 * the run has rows, so the first layout pins to the latest output instead of
 * to an empty scroller.
 */
function SubagentRunFollow({
  headingId,
  items,
  scrollable = true,
}: {
  headingId: string;
  items: SubagentRunItem[];
  scrollable?: boolean;
}) {
  const { t } = useTranslation();
  const {
    scrollRef,
    contentRef,
    showJump,
    handleScroll,
    jumpToLatest,
    scheduleFollowScroll,
    disclosureAnchorNotifier,
  } = useFollowScroll();

  useLayoutEffect(() => {
    if (!scrollable) return;
    scheduleFollowScroll();
  }, [items, scheduleFollowScroll, scrollable]);

  return (
    <DisclosureAnchorContext.Provider value={disclosureAnchorNotifier}>
      <div className="subagent-run-follow">
        {/* The rows scroll inside the run rather than growing the transcript
          * (D271). Follow sticks to the latest output while pinned (D302).
          * Labelled and focusable so a keyboard reader can reach the scroll
          * area the pointer can already use. */}
        <div
          ref={scrollRef}
          data-scroll-owner="follow"
          className={`subagent-run-rows${scrollable ? "" : " is-panel-flow"}`}
          role="group"
          tabIndex={scrollable ? 0 : undefined}
          aria-labelledby={headingId}
          onScroll={scrollable ? handleScroll : undefined}
        >
          <div ref={contentRef}>
            {items.map((item) =>
              item.kind === "tool" ? (
                reviewChangeFromMessage(item.message) ? (
                  <ReviewChangeCard
                    key={item.message.id}
                    message={item.message}
                    asToolRow
                  />
                ) : (
                  <ToolRow key={item.message.id} message={item.message} />
                )
              ) : item.kind === "thinking" ? (
                <ThinkingRow
                  key={`thinking-${item.message.id}`}
                  message={item.message}
                  streaming={item.message.status === "streaming"}
                />
              ) : item.message.role === "user" ? (
                <SubagentUserMessage key={item.message.id} message={item.message} />
              ) : (
                <div
                  className="subagent-answer"
                  data-message-id={item.message.id}
                  key={`answer-${item.message.id}`}
                >
                  {item.message.content ? (
                    <div className="prose-chat">
                      <Markdown source={item.message.content} />
                    </div>
                  ) : null}
                  {item.message.error ? (
                    <AssistantErrorMessage message={item.message} />
                  ) : null}
                </div>
              ),
            )}
          </div>
        </div>
        {scrollable && showJump ? (
          <TooltipButton
            type="button"
            className="jump-latest-btn"
            ariaLabel={t("chat.scrollToBottom")}
            tooltip={t("chat.scrollToBottom")}
            onClick={jumpToLatest}
          >
            <IconArrowDown size={14} />
          </TooltipButton>
        ) : null}
      </div>
    </DisclosureAnchorContext.Provider>
  );
}

/** The task text sent to the delegate, shown as the conversation-like body. */
