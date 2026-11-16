import type { UiMessage } from "@pi-desktop/shared";

/** An advisory is not a task-success or output-truncation signal. */
export function earlyEndAdvisory(message: UiMessage, active: boolean): "suspected" | "exhausted" | undefined {
  const termination = message.runDiagnostics?.termination;
  if (active || (message.status !== "complete" && !(message.status === undefined && message.runDiagnostics?.endedAt !== undefined)) || message.error ||
      !termination || termination.messageId !== message.id || termination.stopReason !== "stop") return undefined;
  return termination.earlyEnd === "suspected" || termination.earlyEnd === "exhausted" ? termination.earlyEnd : undefined;
}
