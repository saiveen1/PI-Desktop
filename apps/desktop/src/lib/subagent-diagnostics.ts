const STOP_REASONS = ["stop", "tool_calls", "length", "error", "aborted", "unknown"] as const;
const RAW_STOP_REASONS = ["stop", "toolUse", "tool_calls", "length", "max_tokens", "error", "aborted"] as const;
const REPORT_OUTCOMES = ["delivered", "missing", "truncated", "invalid_tool_ending", "error", "cancelled"] as const;
const DECISIONS = ["selected", "skipped", "cancelled"] as const;
import { PROVIDER_RETRY_MAX_RETRIES, parseSubagentObservation, type SubagentObservation } from "@pi-desktop/shared";

type StopReason = typeof STOP_REASONS[number];
type RawStopReason = typeof RAW_STOP_REASONS[number];
type ReportOutcome = typeof REPORT_OUTCOMES[number];
type Decision = typeof DECISIONS[number];

export type SubagentDiagnostics = {
  requestedModel?: string;
  actualModel?: string;
  turns?: number;
  toolCalls?: number;
  lastToolName?: string;
  activityPhase?: "waiting-model" | "retrying";
  startedAt?: number;
  completedAt?: number;
  elapsedMs?: number;
  outputTokens?: number;
  outputTokensPerSecond?: number;
  observation?: SubagentObservation;
  retry?: { attempt: number; limit: number | "unlimited"; message?: string };
  terminal?: {
    stopReason: StopReason;
    rawStopReason?: RawStopReason;
    reportOutcome: ReportOutcome;
    textBlocks: number;
    thinkingBlocks: number;
    toolCalls: number;
    reportRecoveryAttempt: number;
    providerRetries?: number;
  };
  decisions: Array<{ model: string; decision: Decision; reason: string }>;
  modelFailures: Array<{ model: string; code: string; message: string }>;
  error?: { code: string; message: string };
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, limit = 1000): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined;
}

function counter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime()) ? value : undefined;
}


function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

/** Read recorded facts only; current settings never fill gaps in old task history. */
export function subagentDiagnostics(payload: unknown): SubagentDiagnostics | undefined {
  if (!record(payload)) return undefined;
  const scheduling = record(payload.scheduling) ? payload.scheduling : undefined;
  const decisions = (Array.isArray(scheduling?.decisions) ? scheduling.decisions : []).slice(0, 128).flatMap(row => {
    if (!record(row) || !member(DECISIONS, row.decision)) return [];
    const model = text(row.model, 385);
    const reason = text(row.reason);
    return model && reason ? [{ model, decision: row.decision, reason }] : [];
  });
  const modelFailures = (Array.isArray(payload.modelFailures) ? payload.modelFailures : []).slice(0, 128).flatMap(row => {
    if (!record(row)) return [];
    const model = text(row.model, 385);
    const code = text(row.code, 128);
    const message = text(row.message, 600);
    return model && code && message ? [{ model, code, message }] : [];
  });
  const startedAt = timestamp(payload.startedAt);
  const completedAt = timestamp(payload.completedAt);
  const elapsedMs = startedAt !== undefined && completedAt !== undefined && completedAt > startedAt
    ? completedAt - startedAt : undefined;
  const outputTokens = record(payload.usage) ? counter(payload.usage.outputTokens) : undefined;
  const observation = parseSubagentObservation(payload.observation);
  const result: SubagentDiagnostics = {
    requestedModel: text(scheduling?.requestedModel, 385),
    actualModel: text(payload.modelId, 256),
    turns: counter(payload.turns),
    toolCalls: counter(payload.toolCalls),
    lastToolName: text(payload.lastToolName, 256),
    startedAt, completedAt, elapsedMs, outputTokens,
    outputTokensPerSecond: outputTokens && elapsedMs ? outputTokens / (elapsedMs / 1000) : undefined,
    observation,
    decisions,
    modelFailures,
  };
  const terminal = payload.terminal;
  const activity = payload.activity;
  if (record(activity) && member(["waiting-model", "retrying"] as const, activity.phase)) result.activityPhase = activity.phase;
  if (record(activity) && activity.phase === "retrying" && counter(activity.attempt) !== undefined) {
    result.retry = {
      attempt: activity.attempt as number,
      limit: activity.infinite === true ? "unlimited" : counter(activity.maxAttempts) ?? PROVIDER_RETRY_MAX_RETRIES,
      ...(record(activity.error) && text(activity.error.message, 600) ? { message: text(activity.error.message, 600) } : {}),
    };
  }
  if (record(terminal) && member(STOP_REASONS, terminal.stopReason) && member(REPORT_OUTCOMES, terminal.reportOutcome)) {
    const textBlocks = counter(terminal.textBlocks);
    const thinkingBlocks = counter(terminal.thinkingBlocks);
    const toolCalls = counter(terminal.toolCalls);
    const reportRecoveryAttempt = counter(terminal.reportRecoveryAttempt);
    if (textBlocks !== undefined && thinkingBlocks !== undefined && toolCalls !== undefined && reportRecoveryAttempt !== undefined && reportRecoveryAttempt <= 1) {
      result.terminal = {
        stopReason: terminal.stopReason, reportOutcome: terminal.reportOutcome,
        textBlocks, thinkingBlocks, toolCalls, reportRecoveryAttempt,
        ...(counter(terminal.providerRetries) !== undefined ? { providerRetries: counter(terminal.providerRetries) } : {}),
        ...(member(RAW_STOP_REASONS, terminal.rawStopReason) ? { rawStopReason: terminal.rawStopReason } : {}),
      };
    }
  }
  if (record(payload.error)) {
    const code = text(payload.error.code, 128);
    const message = text(payload.error.message, 600);
    if (code && message) result.error = { code, message };
  }
  return result.requestedModel || result.actualModel || result.turns !== undefined || result.toolCalls !== undefined ||
    result.startedAt !== undefined || result.completedAt !== undefined || result.outputTokens !== undefined || result.lastToolName || result.activityPhase || result.observation ||
    result.terminal || result.retry || result.error || decisions.length || modelFailures.length ? result : undefined;
}
