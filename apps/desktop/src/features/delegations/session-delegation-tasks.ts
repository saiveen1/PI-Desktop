import type { DelegationRunHistoryEntry, UiMessage } from "@pi-desktop/shared";
import { delegationIdForMessage } from "../../lib/subagent-panel";
import { collectDelegationStatuses, delegationIsCreating, isDelegationActivityItem, type DelegationActivityItem } from "../../lib/subagent-topology";
import { subagentTaskOutcome } from "../../lib/subagent-task-presentation";

/**
 * Project only recorded start/end values; createdAt may be a Task-row fallback.
 * A recorded effective thinking level is copied verbatim, and an unrecorded one
 * stays absent so current settings can never fill a legacy gap.
 */
export function delegationHistoryDiagnostics(entry: DelegationRunHistoryEntry) {
  return {
    modelId: entry.modelId, scheduling: { requestedModel: entry.requestedModel },
    ...(entry.thinkingLevel === undefined ? {} : { thinkingLevel: entry.thinkingLevel }),
    startedAt: entry.startedAt ? Date.parse(entry.startedAt) : undefined,
    completedAt: entry.status !== "interrupted" && entry.completedAt ? Date.parse(entry.completedAt) : undefined,
    usage: entry.usage, turns: entry.turns, toolCalls: entry.toolCalls, observation: entry.observation,
  };
}

/** A display-only adapter; never inserts history projections into the transcript/store. */
export function delegationHistoryTask(entry: DelegationRunHistoryEntry): DelegationActivityItem {
  return { kind: "tool", message: {
    id: entry.messageId, role: "tool", content: entry.report ?? "", createdAt: entry.createdAt,
    toolName: "Task", toolCallId: entry.messageId, toolStatus: "success", status: "complete",
    toolArgs: { agent: entry.agentName, description: entry.description, task: entry.task },
    toolResult: { details: { ...delegationHistoryDiagnostics(entry), delegationId: entry.delegationId, status: entry.status, error: entry.error } },
  } };
}

/** A stale running/creation snapshot cannot erase a recorded terminal result or handle. */
export function preferRecordedTask(previous: UiMessage | undefined, incoming: UiMessage): UiMessage {
  if (!previous || !isDelegationActivityItem({ kind: "tool", message: previous })) return incoming;
  if (subagentTaskOutcome(incoming) !== "running") return incoming;
  return subagentTaskOutcome(previous) !== "running" ||
    (delegationIsCreating(incoming) && !delegationIsCreating(previous)) ? previous : incoming;
}

export function sessionDelegationTasks(sessionId: string, entries: readonly DelegationRunHistoryEntry[], messages: readonly UiMessage[], running: boolean) {
  const history = entries.filter(entry => entry.sessionId === sessionId).map(delegationHistoryTask);
  const live = messages.filter(message => message.role === "tool" && !message.parentToolCallId)
    .map(message => ({ kind: "tool" as const, message }));
  const unique = new Map(history.map(item => [item.message.id, item]));
  for (const item of live.filter(isDelegationActivityItem)) {
    unique.set(item.message.id, { ...item, message: preferRecordedTask(unique.get(item.message.id)?.message, item.message) });
  }
  // Terminal durable evidence outranks a stale live Task/TaskList running snapshot.
  const statuses = new Map(collectDelegationStatuses([...history, ...live], { turnLive: running }));
  const byId = new Map<string, DelegationActivityItem>();
  for (const item of unique.values()) byId.set(delegationIdForMessage(item.message), item);
  const tasks = [...byId.values()].sort((a, b) => b.message.createdAt.localeCompare(a.message.createdAt));
  if (!running) {
    for (const item of tasks) {
      if (delegationIsCreating(item.message)) statuses.set(delegationIdForMessage(item.message), "aborted");
    }
  }
  let active = 0, starting = 0, attention = 0;
  for (const item of tasks) {
    const outcome = subagentTaskOutcome(item.message, statuses);
    if (outcome === "running") {
      if (delegationIsCreating(item.message)) { if (running) starting++; }
      else active++;
    } else if (outcome === "failed" || outcome === "denied" || outcome === "timed_out") attention++;
  }
  return { tasks, statuses, active, starting, attention, total: tasks.length };
}
