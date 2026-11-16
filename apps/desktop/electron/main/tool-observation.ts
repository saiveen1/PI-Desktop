import { createHash } from "node:crypto";
import { ErrorCodes, type ToolObservation, type ToolObservationOutcome } from "@pi-desktop/shared";

const TOOLS = new Set([
  "Read", "Write", "Edit", "Bash", "Glob", "Grep", "Task", "TaskWait", "TaskStop", "TaskList",
  "TaskModels", "TodoWrite", "ToolSearch", "Skill", "asktool", "BrowserPreview", "GenerateImages",
  "EnterPlanMode", "SubmitPlan", "PluginCheck", "PluginPack", "PluginScaffold", "external", "unknown",
]);
const SHELLS = new Set(["bash", "git-bash", "cmd", "windows-powershell", "windows-pwsh"]);
const CODES: ReadonlySet<string> = new Set(Object.values(ErrorCodes));
const OUTCOMES: ReadonlySet<string> = new Set<ToolObservationOutcome>([
  "success", "command_nonzero", "tool_error", "timeout", "cancelled", "interrupted", "background_started", "unknown",
]);

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}
function duration(value: unknown): number | undefined {
  const n = number(value);
  return n !== undefined && n >= 0 ? n : undefined;
}
function identifier(value: unknown): string | undefined {
  // Opaque correlation IDs only; no paths, URLs, free text, or known secret prefixes.
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
    && !/^(?:sk-|rk-|pk-|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|AIza|ya29)/.test(value)
    ? value : undefined;
}
function callIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 256) return undefined;
  const parts = value.split("|");
  return parts.length <= 2 && parts.every((part) => identifier(part) !== undefined) ? value : undefined;
}
function version(value: unknown): string {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]{1,64})?$/.test(value)
    ? value : "unknown";
}
function platform(value: unknown): string {
  return value === "win32" || value === "linux" || value === "darwin" ? value : "unknown";
}
function tool(value: unknown): string {
  if (typeof value !== "string") return "external";
  return [...TOOLS].find((name) => name.toLowerCase() === value.toLowerCase()) ?? "external";
}
function shell(value: unknown): string | undefined {
  return typeof value === "string" && SHELLS.has(value) ? value : undefined;
}
function code(value: unknown): string | undefined {
  return typeof value === "string" && CODES.has(value) ? value : undefined;
}
export function observationId(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

export type ObservationContext = {
  timestamp: number;
  desktopPlatform: string;
  appVersion: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  durationMs?: number;
};

/** Read only structured outcomes, never parse stderr or model-generated text. */
export function observeToolResult(
  context: ObservationContext,
  toolName: string,
  result: unknown,
  isError: boolean,
  interrupted = false,
): ToolObservation | undefined {
  if (!Number.isFinite(new Date(context.timestamp).getTime())) return undefined;
  const root = object(result);
  const details = object(root.details);
  const content = object(details.content);
  const nodes = [root, details, content];
  const exitCode = nodes.map((node) => number(node.exitCode)).find((value) => value !== undefined);
  const errorCode = nodes.flatMap((node) => [code(node.errorCode), code(node.code)])
    .find((value) => value !== undefined);
  const shellId = nodes.map((node) => shell(node.commandShellId)).find((value) => value !== undefined);
  const command = tool(toolName) === "Bash";
  const backgroundTaskId = command
    ? nodes.map((node) => identifier(node.backgroundTaskId)).find((value) => value !== undefined) : undefined;
  const failed = isError || nodes.some((node) => node.isError === true || node.ok === false);
  let outcome: ToolObservationOutcome;
  if (interrupted) outcome = "interrupted";
  else if (errorCode === "TOOL_TIMEOUT" || errorCode === "TIMEOUT") outcome = "timeout";
  else if (errorCode === "TOOL_ABORTED" || nodes.some((node) => node.aborted === true)) outcome = "cancelled";
  else if (command && exitCode !== undefined && exitCode !== 0) outcome = "command_nonzero";
  else if (failed) outcome = "tool_error";
  else if (backgroundTaskId) outcome = "background_started";
  else outcome = command && exitCode === undefined ? "unknown" : "success";
  return sanitizeObservation({
    ...context,
    timestamp: new Date(context.timestamp).toISOString(),
    id: observationId(["tool", context.sessionId, context.turnId, context.toolCallId ?? context.timestamp]),
    toolName: tool(toolName), outcome, exitCode, errorCode, shellId, backgroundTaskId,
    truncated: nodes.some((node) => node.truncated === true),
  });
}

/** Defense in depth for on-disk input: rebuild from an explicit field allowlist. */
export function sanitizeObservation(value: unknown): ToolObservation | undefined {
  const row = object(value);
  if (typeof row.timestamp !== "string" || !Number.isFinite(Date.parse(row.timestamp))
    || typeof row.outcome !== "string" || !OUTCOMES.has(row.outcome)
    || typeof row.id !== "string" || !/^[a-f0-9]{24}$/.test(row.id)) return undefined;
  return {
    id: row.id,
    timestamp: new Date(row.timestamp).toISOString(),
    toolName: tool(row.toolName),
    outcome: row.outcome as ToolObservationOutcome,
    desktopPlatform: platform(row.desktopPlatform),
    appVersion: version(row.appVersion),
    shellId: shell(row.shellId),
    errorCode: code(row.errorCode),
    exitCode: number(row.exitCode),
    durationMs: duration(row.durationMs),
    sessionId: identifier(row.sessionId),
    turnId: identifier(row.turnId),
    toolCallId: callIdentifier(row.toolCallId),
    backgroundTaskId: identifier(row.backgroundTaskId),
    truncated: row.truncated === true,
  };
}

/** Terminal notifications are distinct from the tool call that started a job. */
export function observeBackgroundResult(
  context: Omit<ObservationContext, "sessionId" | "toolCallId">,
  payload: unknown,
): ToolObservation | undefined {
  if (!Number.isFinite(new Date(context.timestamp).getTime())) return undefined;
  const row = object(payload);
  const taskId = identifier(row.taskId);
  const sessionId = identifier(row.sessionId);
  if (!taskId || !sessionId || !["exited", "failed", "stopped"].includes(String(row.state))) return undefined;
  const exitCode = number(row.exitCode);
  const outcome: ToolObservationOutcome = row.state === "stopped" ? "cancelled"
    : row.state === "failed" ? (exitCode !== undefined && exitCode !== 0 ? "command_nonzero" : "tool_error")
      : exitCode === undefined ? "unknown" : exitCode === 0 ? "success" : "command_nonzero";
  return sanitizeObservation({
    ...context,
    id: observationId(["background", sessionId, taskId]),
    timestamp: new Date(context.timestamp).toISOString(),
    toolName: "Bash", outcome, sessionId, backgroundTaskId: taskId,
    shellId: row.commandShellId, exitCode, durationMs: row.durationMs, truncated: row.truncated,
  });
}
