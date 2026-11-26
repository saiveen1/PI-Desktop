import type { UiMessage } from "@pi-desktop/shared";
import { delegationIdForMessage, type TaskAttempt } from "./subagent-panel";
import { getToolStatus, TOOL_STATUS_LABEL_KEYS } from "./tool-status";
import { delegationIsCreating, subagentOutcome, type DelegationActivityItem, type SubagentOutcome } from "./subagent-topology";

export function subagentAttemptReason(attempt: TaskAttempt, t: (key: string) => string): string {
  if (attempt.outcome === "skipped" && (!attempt.reason || attempt.reason === "Skipped because new user input is waiting.")) return t("chat.toolSkippedReason");
  const reason = attempt.reason === "Unknown delegation." ? t("subagentControls.unknownResume")
    : attempt.reason === "Resume chain no longer retained." ? t("subagentControls.expiredResume") : attempt.reason;
  return [reason, attempt.resume].filter(Boolean).join(" · ");
}

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
  const identity = message.id || message.toolCallId || delegationIdForMessage(message);
  let hash = 0;
  for (const char of identity) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 4;
}

function taskGroup(outcome: SubagentOutcome) {
  if (outcome === "running") return "active";
  if (outcome === "completed") return "completed";
  return outcome === "failed" || outcome === "timed_out" || outcome === "denied" || outcome === "rejected" ? "attention" : "history";
}

export function subagentTaskOutcome(message: UiMessage, statuses?: ReadonlyMap<string, SubagentOutcome>): SubagentOutcome {
  let outcome = subagentOutcome(message, statuses);
  if (outcome === "running" && delegationIsCreating(message)) outcome = statuses?.get(delegationIdForMessage(message)) ?? outcome;
  if (outcome === "not_started" || taskGroup(outcome) === "attention") return outcome;
  const status = getToolStatus(message).kind;
  if (status === "skipped" || status === "interrupted" || status === "context-required") return "aborted";
  return outcome;
}

/** Latest snapshot of each task; completed and interrupted work remain distinct. */
export function groupSubagentTasks(items: readonly DelegationActivityItem[], statuses?: ReadonlyMap<string, SubagentOutcome>) {
  const unique = new Map<string, DelegationActivityItem>();
  for (const item of items) unique.set(delegationIdForMessage(item.message), item);
  const groups: Record<"active" | "completed" | "attention" | "history", DelegationActivityItem[]> = {
    active: [], completed: [], attention: [], history: [],
  };
  for (const item of unique.values()) {
    const outcome = subagentTaskOutcome(item.message, statuses);
    groups[taskGroup(outcome)].push(item);
  }
  return groups;
}

/** Shared status wording for task activity, index and detail. */
export function subagentTaskStatusKey(message: UiMessage, statuses?: ReadonlyMap<string, SubagentOutcome>): string {
  const outcome = subagentTaskOutcome(message, statuses);
  if (outcome === "not_started") return "subagentControls.notStarted";
  if (outcome === "rejected") return "subagentControls.rejected";
  const kind = getToolStatus(message).kind;
  if (outcome === "aborted" && (kind === "skipped" || kind === "interrupted" || kind === "context-required")) return TOOL_STATUS_LABEL_KEYS[kind];
  return outcome === "running" && delegationIsCreating(message)
    ? "chat.subagentCreating" : `chat.subagentStatus.${outcome}`;
}
