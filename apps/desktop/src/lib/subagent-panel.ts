import type { DelegationAttemptHistoryEntry, UiMessage } from "@pi-desktop/shared";
import { isDelegationStartTool } from "./tool-display";
import { toolResultPayload } from "./tool-presentation";
import { getToolStatus } from "./tool-status";

/** Only a recorded result identity can be sent to runtime controls. */
export function recordedDelegationId(message: UiMessage): string | undefined {
  const payload = toolResultPayload(message);
  const id = payload && typeof payload === "object" && "delegationId" in payload ? payload.delegationId : undefined;
  return typeof id === "string" && id.length > 0 && id.length <= 256 && id.trim() === id ? id : undefined;
}

export type TaskAttempt = Pick<DelegationAttemptHistoryEntry, "outcome" | "reason" | "resume">;
/** Only applied to renderer-local history projections, never persisted to chat. */
export type AttemptMessage = UiMessage & { historyAttempt?: DelegationAttemptHistoryEntry };

export function delegationAttempt(message: AttemptMessage): TaskAttempt | undefined {
  if (!isDelegationStartTool(message.toolName) || recordedDelegationId(message) || message.toolStatus === "running") return;
  if (message.historyAttempt) return message.historyAttempt;
  if (!message.toolResult || message.status === "streaming" || message.status === "aborted" ||
    (message.toolStatus !== "error" && !(message.toolStatus === undefined && message.isError))) return;
  if (getToolStatus(message).kind === "skipped") return { outcome: "skipped" };
  const args = message.toolArgs;
  const resume = args && typeof args === "object" && "resume" in args && typeof args.resume === "string" ? args.resume.trim() : "";
  if (!resume) return;
  const result = toolResultPayload(message);
  const details = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : undefined;
  const reason = details?.error ?? result;
  if (details?.code === "DELEGATION_RESUME_NOT_RETAINED") return { outcome: "rejected", reason: "Resume chain no longer retained.", resume };
  const prefix = `Unknown delegation "${resume}".`;
  const suffix = typeof reason === "string" && reason.startsWith(prefix) ? reason.slice(prefix.length) : undefined;
  if (details?.code === "DELEGATION_RESUME_UNKNOWN" || (!details?.code && suffix !== undefined &&
    (!suffix || suffix.startsWith(" Reusable: ") || suffix === " No reusable subagent sessions in this conversation."))) {
    return { outcome: "rejected", reason: "Unknown delegation.", resume };
  }
}

/** Keep message navigation separate from provider tool-call and runtime identities. */
export const taskMessageKey = (messageId: string) => `task-message:${messageId}`;

/** A navigation key, not authority to stop/retry/message a child. */
export function delegationIdForMessage(message: UiMessage): string {
  return recordedDelegationId(message) ?? taskMessageKey(message.id);
}
