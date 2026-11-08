import type { UiMessage } from "@pi-desktop/shared";
import { getToolAction } from "./tool-display";
import { runOutcome, toolResultPayload } from "./tool-presentation";

export type ToolDisplayStatus = "running" | "success" | "failed" | "denied" | "skipped" | "interrupted" | "context-required" | "unknown";
export type ToolStatusPresentation = {
  kind: ToolDisplayStatus;
  reasonKey?: "chat.toolSkippedReason" | "chat.toolInterruptedReason" | "chat.toolWaitInterruptedReason" | "chat.toolExitCodeReason" | "chat.toolContextRevealReason" | "chat.toolContextReadReason";
  detail?: string;
  exitCode?: number;
};

export const TOOL_STATUS_LABEL_KEYS = {
  running: "chat.running", success: "chat.toolCompleted", failed: "chat.toolFailed",
  denied: "chat.toolDenied", skipped: "chat.toolSkipped", interrupted: "chat.toolInterrupted",
  "context-required": "chat.toolContextRequired",
} as const;

const SKIPPED_FOR_INPUT = "Skipped because new user input is waiting.";
const INTERRUPTED_WAITS = new Set([
  "Interrupted by new user input. The background command keeps running; handle the user's message before waiting again.",
  "Interrupted by new user input. Unfinished subagents keep working; handle the user's message before waiting again.",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Read only result metadata, never arguments, stdout or arbitrary nested fields. */
export function getToolStatus(message: UiMessage): ToolStatusPresentation {
  if (message.toolStatus === "running") return { kind: "running" };
  const isRun = getToolAction(message.toolName) === "run";
  const wait = message.toolName === "TaskWait";
  if (message.toolStatus === "success" && !message.isError && !isRun && !wait && message.status !== "aborted") {
    return { kind: "success" };
  }

  const payload = toolResultPayload(message);
  const details = record(payload);
  const envelope = record(message.toolResult);
  const error = details?.error;
  const errorRecord = record(error);
  const code = text(details?.code) ?? text(details?.errorCode) ?? text(errorRecord?.code) ?? message.error?.code;
  // Empty details accompany steering skips; the reason lives in content instead.
  const blocks = Array.isArray(envelope?.content) ? envelope.content : [];
  const first = blocks.length === 1 ? record(blocks[0]) : undefined;
  const resultText = first?.type === "text" ? text(first.text) : undefined;
  const plain = typeof payload === "string" ? payload.trim()
    : (!details || Object.keys(details).length === 0) ? resultText
    : undefined;
  const errorText = text(error) ?? text(errorRecord?.message) ?? text(details?.message) ?? message.error?.message;
  const failed = message.toolStatus === "error" || message.isError === true || envelope?.isError === true;
  const detail = [code, errorText ?? (failed ? plain : undefined)].filter(Boolean).join(": ").slice(0, 600) || undefined;
  const exitCode = isRun && typeof details?.exitCode === "number" && Number.isFinite(details.exitCode)
    ? details.exitCode : undefined;
  if (message.toolStatus === "denied") return { kind: "denied", detail: errorText?.slice(0, 600) ?? plain?.slice(0, 600) };
  if (message.toolName === "Edit" && failed && code === "EDIT_LINES_UNSEEN" &&
      typeof details?.unseenCount === "number" && details.unseenCount > 0) {
    if (details.merged === true && details.revealTruncated === false) {
      return { kind: "context-required", reasonKey: "chat.toolContextRevealReason" };
    }
    if (details.revealTruncated === true) return { kind: "context-required", reasonKey: "chat.toolContextReadReason" };
  }

  // Actual failures outrank a later Stop marker or an interruption-looking output.
  if (exitCode !== undefined && exitCode !== 0) {
    return { kind: "failed", reasonKey: "chat.toolExitCodeReason", exitCode, detail };
  }
  if (code && code !== "TOOL_ABORTED" && code !== "TURN_ABORTED" && failed) {
    return { kind: "failed", detail };
  }
  if (failed && !code && plain === SKIPPED_FOR_INPUT) {
    return { kind: "skipped", reasonKey: "chat.toolSkippedReason" };
  }
  if (message.status === "aborted" || code === "TOOL_ABORTED" || code === "TURN_ABORTED") {
    return { kind: "interrupted", reasonKey: "chat.toolInterruptedReason" };
  }
  if (wait && !failed && (details?.status === "interrupted" || [...INTERRUPTED_WAITS].some((notice) => (resultText ?? plain)?.startsWith(notice)))) {
    return { kind: "interrupted", reasonKey: "chat.toolWaitInterruptedReason" };
  }
  if (isRun) {
    const outcome = runOutcome(message);
    if (outcome === "failed" || failed) return { kind: "failed", detail };
    return { kind: outcome === "ok" ? "success" : outcome };
  }
  if (failed) return { kind: "failed", detail };
  return { kind: message.toolStatus === "success" ? "success" : "unknown" };
}
