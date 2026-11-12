import type { UiMessage } from "@pi-desktop/shared";
import { delegationIdForMessage } from "./subagent-panel";
import { getToolStatus, TOOL_STATUS_LABEL_KEYS } from "./tool-status";
import { delegationIsCreating, subagentOutcome, type DelegationActivityItem, type SubagentOutcome } from "./subagent-topology";

/** A task's short brief is more useful in a list than its implementation role. */
export function subagentTaskTitle(message: UiMessage, fallback = ""): string {
  const args = message.toolArgs;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const { description, agent } = args as { description?: unknown; agent?: unknown };
    if (typeof description === "string" && description.trim()) return description.trim();
    if (typeof agent === "string" && agent.trim()) return agent.trim();
  }
  return message.agentName || fallback;
}

/** Stable before and after a Task result arrives; never derived from list order. */
export function subagentTaskTone(message: UiMessage): number {
  const identity = message.toolCallId || delegationIdForMessage(message);
  let hash = 0;
  for (const char of identity) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 4;
}

export function subagentTaskOutcome(message: UiMessage, statuses?: ReadonlyMap<string, SubagentOutcome>): SubagentOutcome {
  let outcome = subagentOutcome(message, statuses);
  if (outcome === "running" && delegationIsCreating(message)) outcome = statuses?.get(delegationIdForMessage(message)) ?? outcome;
  if (outcome === "not_started") return outcome;
  const status = getToolStatus(message).kind;
  if (status === "skipped" || status === "interrupted" || status === "context-required") return "aborted";
  return outcome;
}

/** Latest snapshot of each task; completed and interrupted work remain distinct. */
export function groupSubagentTasks(items: readonly DelegationActivityItem[], statuses?: ReadonlyMap<string, SubagentOutcome>) {
  const unique = new Map<string, DelegationActivityItem>();
  for (const item of items) unique.set(delegationIdForMessage(item.message), item);
  const active: DelegationActivityItem[] = [];
  const completed: DelegationActivityItem[] = [];
  const attention: DelegationActivityItem[] = [];
  for (const item of unique.values()) {
    const outcome = subagentTaskOutcome(item.message, statuses);
    (outcome === "running" ? active : outcome === "completed" ? completed : attention).push(item);
  }
  return { active, attention, completed };
}

/** Shared status wording for task activity, index and detail. */
export function subagentTaskStatusKey(message: UiMessage, statuses?: ReadonlyMap<string, SubagentOutcome>): string {
  const outcome = subagentTaskOutcome(message, statuses);
  if (outcome === "not_started") return "subagentControls.notStarted";
  const kind = getToolStatus(message).kind;
  if (kind === "skipped" || kind === "interrupted" || kind === "context-required") return TOOL_STATUS_LABEL_KEYS[kind];
  return outcome === "running" && delegationIsCreating(message)
    ? "chat.subagentCreating" : `chat.subagentStatus.${outcome}`;
}
