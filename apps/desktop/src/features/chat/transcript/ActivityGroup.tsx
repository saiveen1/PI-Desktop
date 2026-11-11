import { RunStatusIndicator } from "./RunStatusIndicator";
import { activityGroupStartsOpen } from "../../../lib/activity-group-folding";
import { cachedVisibleActivityItems } from "../../../lib/transcript-activity-summary";
import { reuseReferences } from "../../../lib/transcript-summary";
import { ActivityItems } from "./ActivityItems";
import { disclosureKey } from "./disclosure";
import { ProcessActivityGroup } from "./ProcessActivityGroup";
import { memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentActivity, AgentRunDiagnostics, AgentActivityAgent, ProposalKind } from "@pi-desktop/shared";
import { PROVIDER_RETRY_MAX_RETRIES } from "@pi-desktop/shared";
import type { AssistantActivityItem } from "../../../lib/assistant-turns";
import { subagentRunsEqual } from "../../../lib/assistant-turns";
import {
  collectDelegationStatuses, collectDelegationTimings, isDelegationActivityItem,
  summarizeSubagentActivity, type SubagentOutcome, type SubagentTiming,
} from "../../../lib/subagent-topology";
import { getToolAction } from "../../../lib/tool-display";
import { IconSparkles } from "../../../components/icons";
import { TOOL_RUNNING_KEYS, useAutomaticDisclosure } from "./shared";
import { TranscriptSearchContext } from "../../../lib/transcript-search-context";
import { useAppStore } from "../../../stores/app-store";
import { resolveShowThinking } from "../../../lib/thinking-visibility";
import { resolveAutoCollapseSettledGroups, resolveAutoCollapseThinking } from "../../../lib/transcript-folding";
import { resolveTranscriptDisplayMode } from "../../../lib/transcript-display-mode";

type Translate = (key: string, options?: Record<string, unknown>) => string;

type ActivityItem = AssistantActivityItem;

function waitingSubagentActionLabel(
  agent: AgentActivityAgent,
  t: Translate,
): string {
  if (agent.lastPhase === "thinking") return t("chat.thinking");
  if (agent.lastPhase === "waiting-model") return t("chat.waitingForModel");
  if (agent.lastToolName) {
    return t(TOOL_RUNNING_KEYS[getToolAction(agent.lastToolName)]);
  }
  return "";
}

function waitingSubagentsLabel(
  activity: Extract<AgentActivity, { phase: "waiting-subagents" }>,
  t: Translate,
): string {
  const agents = activity.agents ?? [];
  if (agents.length === 1) {
    const action = waitingSubagentActionLabel(agents[0], t);
    const named = t("chat.waitingForSubagentNamed", { name: agents[0].name });
    return action ? `${named} · ${action}` : named;
  }
  const base = t("chat.waitingForSubagents", { count: activity.subagentCount });
  if (agents.length === 0) return base;
  const details = agents
    .map((agent) => {
      const action = waitingSubagentActionLabel(agent, t);
      return action ? `${agent.name} ${action}` : agent.name;
    })
    .join(", ");
  return `${base} · ${details}`;
}

function retryDelaySeconds(
  activity: Extract<AgentActivity, { phase: "retrying" }>,
  now: number,
): number {
  const delayMs = activity.retryDelayMs ?? 0;
  const elapsedMs = Math.max(0, now - activity.since);
  return Math.max(0, Math.ceil((delayMs - elapsedMs) / 1000));
}

export function runActivityLabel(
  activity: AgentActivity,
  t: Translate,
  now = Date.now(),
): string {
  switch (activity.phase) {
    case "starting":
      return t("chat.startingTurn");
    case "waiting-model":
      return t(activity.slow ? "errors.PROVIDER_STREAM_SLOW" : "chat.waitingForModel");
    case "preparing":
      return t("chat.preparingNextRequest");
    case "waiting-tool-stop":
      return t("chat.waitingForToolStop");
    case "compacting":
      return t("chat.compactingContext");
    case "recovering":
      return t("chat.recoveringTurn");
    case "retrying":
      return t("chat.retryingModel", {
        delaySeconds: retryDelaySeconds(activity, now),
        attempt: activity.attempt,
        maxAttempts: activity.infinite ? "∞" : activity.maxAttempts ?? PROVIDER_RETRY_MAX_RETRIES,
      });
    case "waiting-subagents":
      return waitingSubagentsLabel(activity, t);
  }
}

type ActivityGroupProps = {
  items: ActivityItem[];
  embedded?: boolean;
  isActive: boolean;
  /** The owning assistant turn is still running. */
  turnActive: boolean;
  endedAt?: string;
  /** Current runtime wait phase, when the group owns the live turn tail. */
  runtimeActivity?: AgentActivity;
  /** Delegation statuses from the entire assistant turn (cross-activity-part). */
  turnDelegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  /** Delegation timings from the entire assistant turn (cross-activity-part). */
  turnDelegationTimings?: ReadonlyMap<string, SubagentTiming>;
};

/** Whether two activity items render identically, delegate rows included. */
export function activityItemsEqual(
  previous: ActivityItem,
  next: ActivityItem,
): boolean {
  if (previous === next) return true;
  if (previous.kind !== next.kind || previous.message !== next.message) {
    return false;
  }
  if (previous.kind === "tool" && next.kind === "tool") {
    return subagentRunsEqual(previous.delegate, next.delegate);
  }
  if (previous.kind === "hostedSearch" && next.kind === "hostedSearch") {
    return previous.round === next.round;
  }
  return true;
}

function activityGroupPropsEqual(
  previous: ActivityGroupProps,
  next: ActivityGroupProps,
) {
  if (
    previous.embedded !== next.embedded ||
    previous.isActive !== next.isActive ||
    previous.turnActive !== next.turnActive ||
    previous.endedAt !== next.endedAt ||
    previous.runtimeActivity !== next.runtimeActivity ||
    previous.items.length !== next.items.length
  ) {
    return false;
  }
  if (
    previous.items !== next.items &&
    !previous.items.every((item, index) =>
      activityItemsEqual(item, next.items[index]),
    )
  ) {
    return false;
  }
  // Only Task groups consume the turn-wide delegation maps. Ordinary completed
  // work must retain its render boundary when another group's tools update.
  return (
    (previous.turnDelegationStatuses === next.turnDelegationStatuses &&
      previous.turnDelegationTimings === next.turnDelegationTimings) ||
    !previous.items.some(isDelegationActivityItem)
  );
}

export const ActivityGroup = memo(function ActivityGroup({
  items, isActive, turnActive, turnDelegationStatuses, turnDelegationTimings,
}: ActivityGroupProps) {
  const showThinking = useAppStore((state) => resolveShowThinking(state.settings));
  const displayMode = useAppStore((state) => resolveTranscriptDisplayMode(state.settings));
  const collapseSettledGroups = useAppStore((state) => resolveAutoCollapseSettledGroups(state.settings));
  const collapseThinking = useAppStore((state) => resolveAutoCollapseThinking(state.settings));
  const rawDelegateItems = useMemo(() => items.filter(isDelegationActivityItem), [items]);
  const delegatesRef = useRef(rawDelegateItems);
  const delegateItems = reuseReferences(delegatesRef.current, rawDelegateItems);
  delegatesRef.current = delegateItems;
  const delegationStatuses = useMemo(() => turnDelegationStatuses ?? collectDelegationStatuses(items), [items, turnDelegationStatuses]);
  const delegationTimings = useMemo(() => turnDelegationTimings ?? collectDelegationTimings(items), [items, turnDelegationTimings]);
  const subagentSummary = useMemo(() => summarizeSubagentActivity(delegateItems, delegationStatuses), [delegateItems, delegationStatuses]);
  const live = isActive || subagentSummary.running > 0;
  const searchTarget = useContext(TranscriptSearchContext);
  const revealRequest = useMemo(() => searchTarget && items.some((item) => item.message.id === searchTarget.messageId)
    ? searchTarget.requestId : undefined, [items, searchTarget]);
  const visibleItems = useMemo(() => cachedVisibleActivityItems(items, !showThinking, isActive), [items, showThinking, isActive]);
  const first = items[0];
  const disclosure = useAutomaticDisclosure(
    activityGroupStartsOpen({ turnActive, groupActive: live, collapseSettled: collapseSettledGroups }),
    revealRequest,
    disclosureKey("activity", first?.message.id ?? "", first?.kind ?? "", first?.kind === "hostedSearch" ? first.round.id : ""),
  );
  const renderedItems = <ActivityItems
    items={items} isActive={isActive} live={live} delegateItems={delegateItems}
    delegationStatuses={delegationStatuses} delegationTimings={delegationTimings}
    collapseThinking={collapseThinking} onUserInteraction={disclosure.claim}
  />;
  // A task list is already a summary. Do not wrap it in another disclosure.
  if (displayMode === "flat" || delegateItems.length > 0) return <>{renderedItems}</>;
  return (
    <ProcessActivityGroup items={visibleItems} active={isActive} disclosure={disclosure}>
      {renderedItems}
    </ProcessActivityGroup>
  );
}, activityGroupPropsEqual);

/** Keep the running turn visible when no more specific runtime phase is known. */
export function WorkingIndicator({ startedAt, diagnostics }: {
  startedAt?: number;
  diagnostics?: AgentRunDiagnostics;
} = {}) {
  const { t } = useTranslation();
  return <RunStatusIndicator key={diagnostics?.turnId} diagnostics={diagnostics} startedAt={startedAt} label={t("chat.running")} />;
}

export function RunActivityIndicator({ activity, diagnostics }: {
  activity: AgentActivity;
  diagnostics?: AgentRunDiagnostics;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activity.since]);
  return <RunStatusIndicator key={diagnostics?.turnId} diagnostics={diagnostics} activity={activity}
    startedAt={diagnostics?.startedAt} label={runActivityLabel(activity, t as Translate, now)} />;
}

export function PlanningIndicator({ kind }: { kind: ProposalKind }) {
  const { t } = useTranslation();
  return (
    <div
      className="planning-state-indicator"
      role="status"
      aria-live="polite"
      data-kind={kind}
      data-testid="planning-indicator"
    >
      <span className="working-indicator-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{t(`${kind}.planning`)}</span>
    </div>
  );
}
