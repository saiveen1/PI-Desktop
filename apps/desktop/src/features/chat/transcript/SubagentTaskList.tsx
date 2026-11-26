import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { IconArrowUpRight, IconBot } from "../../../components/icons";
import { Button } from "../../../components/ui";
import { useChatSessionCapability } from "../../../hooks/use-chat-session-capability";
import { delegationAttempt, delegationIdForMessage, recordedDelegationId } from "../../../lib/subagent-panel";
import { groupSubagentTasks, subagentAttemptReason, subagentTaskOutcome, subagentTaskStatusKey, subagentTaskTitle, subagentTaskTone } from "../../../lib/subagent-task-presentation";
import { delegationIsCreating, type DelegationActivityItem, type SubagentOutcome } from "../../../lib/subagent-topology";
import { subagentWorkPanelTab } from "../../../lib/work-panel-tabs";
import { useSlotSessionId } from "../../../plugins/renderer-slots/use-slots";
import { useAppStore } from "../../../stores/app-store";
import { SubagentRetryButton } from "./SubagentRetryButton";
import { SubagentStopButton } from "./SubagentStopButton";
import { SubagentModelInfo } from "./SubagentModelInfo";
import { delegateModelId, delegateThinkingLevel } from "./model";

export function SubagentTaskRow({ item, statuses, onOpen }: {
  item: DelegationActivityItem;
  statuses?: ReadonlyMap<string, SubagentOutcome>;
  onOpen?: (delegationId: string, title: string) => void;
}) {
  const { t } = useTranslation();
  const sessionId = useSlotSessionId();
  const localToolsAllowed = useChatSessionCapability("canUseLocalTools");
  const openTab = useAppStore((state) => state.openWorkPanelTab);
  const openTabForSession = useAppStore((state) => state.openWorkPanelTabForSession);
  const { message } = item;
  const id = delegationIdForMessage(message);
  const title = subagentTaskTitle(message, item.delegate?.agentName || t("chat.subagentUnnamed"));
  const outcome = subagentTaskOutcome(message, statuses);
  const creating = outcome === "running" && delegationIsCreating(message);
  const status = t(subagentTaskStatusKey(message, statuses));
  const recordedId = recordedDelegationId(message);
  const attempt = delegationAttempt(message);
  const open = () => {
    if (!localToolsAllowed) return;
    if (onOpen) onOpen(id, title);
    else if (sessionId) openTabForSession(sessionId, subagentWorkPanelTab(id, title));
    else openTab(subagentWorkPanelTab(id, title));
  };
  return (
    <div className="subagent-task-row" role="listitem" data-tone={subagentTaskTone(message)} data-outcome={outcome} data-message-id={message.id}>
      <Button variant="ghost" className="subagent-task-open" disabled={!localToolsAllowed} onClick={open} title={`${title} · ${status}`}>
        <span className="subagent-task-icon" aria-hidden><IconBot size={17} /></span>
        <span className="subagent-task-copy">
          <span className="subagent-task-heading">
            <span className="subagent-task-kind">{t("subagentControls.taskLabel")}</span>
            <span className="subagent-task-title">{title}</span>
            <span className="subagent-task-status" role="status">{status}</span>
          </span>
          {recordedId ? <SubagentModelInfo modelId={delegateModelId(message)} thinkingLevel={delegateThinkingLevel(message)} /> : null}
          {attempt?.outcome === "rejected" ? <span className="subagent-attempt-reason">{subagentAttemptReason(attempt, t)}</span> : null}
        </span>
        <span className="subagent-task-navigation" aria-hidden><IconArrowUpRight size={14} /></span>
      </Button>
      {recordedId ? <div className="subagent-task-actions">
        <SubagentStopButton delegationId={recordedId} running={outcome === "running" && !creating} name={title} compact />
        <SubagentRetryButton delegationId={recordedId} failed={outcome === "failed"} compact />
      </div> : null}
    </div>
  );
}

/** One list language for the main process and the side-panel task index. */
export function SubagentTaskList({ items, delegationStatuses, onOpen, grouped = false }: {
  items: readonly DelegationActivityItem[];
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  onOpen?: (delegationId: string, title: string) => void;
  /** The side-panel index groups outcomes; the main trace keeps chronological rows. */
  grouped?: boolean;
}) {
  const { t } = useTranslation();
  const groups = useMemo(() => groupSubagentTasks(items, delegationStatuses), [items, delegationStatuses]);
  const labels = { active: "chat.taskGroups.active", attention: "chat.taskGroups.attention", history: "subagentControls.inactiveHistory", completed: "chat.taskGroups.completed" } as const;
  if (!grouped) return (
    <div className="subagent-task-list is-inline" role="list" aria-label={t("chat.subagentTopology")}>
      {items.map((item) => <SubagentTaskRow key={item.message.id} item={item} statuses={delegationStatuses} onOpen={onOpen} />)}
    </div>
  );
  const runningIds = groups.active.map(item => recordedDelegationId(item.message)).filter(id => id !== undefined);
  return (
    <div className="subagent-task-list" aria-label={t("chat.subagentTopology")}>
      {(Object.keys(labels) as Array<keyof typeof labels>).map((key) => groups[key].length > 0 ? (
        <section className="subagent-task-group" key={key} aria-label={t(labels[key])}>
          <h3 className="subagent-task-group-label">{t(labels[key])}<span aria-hidden> · {groups[key].length}</span>
            {key === "active" ? <SubagentStopButton running compact delegationIds={runningIds} /> : null}
          </h3>
          <div role="list" aria-label={t(labels[key])}>
            {groups[key].map((item) => <SubagentTaskRow key={item.message.id} item={item} statuses={delegationStatuses} onOpen={onOpen} />)}
          </div>
        </section>
      ) : null)}
    </div>
  );
}
