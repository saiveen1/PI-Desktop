/** Observational facts only: these records never authorize execution or replay. */
export type SubagentModelAttempt = {
  sequence: number;
  model: string;
  startedAt: number;
  finishedAt?: number;
  /** unresolved: the runtime retired without observing provider settlement. */
  outcome: "running" | "completed" | "failed" | "aborted" | "unresolved";
  error?: { code: string; message: string };
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  /** Measured request invocation to settlement, including transport wait, not generation speed. */
  providerDurationMs?: number;
};
export type SubagentToolEvidence = {
  toolCallId: string;
  toolName: string;
  path?: string;
  startedAt: number;
  finishedAt?: number;
  outcome: "pending" | "completed" | "failed";
  /** Even a failed/cancelled call can have partially applied external effects. */
  effects: "unknown" | "read_only" | "write_confirmed";
  outputChars?: number;
  totalLines?: number;
};
export type SubagentApprovalObservation = { model: string; status: "pending" | "accepted" | "rejected" | "cancelled"; at: number };
export type SubagentObservation = {
  version: 1;
  selectedModel: string;
  phase: "preparing" | "model" | "tool" | "retrying" | "approval" | "ended";
  executionStartedAt?: number;
  executionEndedAt?: number;
  reportProducedAt?: number;
  /** Only the report consumer may record delivery; production is not delivery. */
  reportDeliveredAt?: number;
  lastActivityAt: number;
  lastMeaningfulProgressAt?: number;
  diagnostic: {
    state: "observing" | "waiting_tool" | "waiting_model" | "no_new_evidence" | "approval_pending" | "ended";
    observedAt: number;
    thresholdMs: number;
    reason: string;
  };
  attemptCount: number;
  attemptsOmitted: number;
  attempts: SubagentModelAttempt[];
  approvalsOmitted: number;
  approvals: SubagentApprovalObservation[];
  completedToolCalls: number;
  failedToolCalls: number;
  pendingTools: SubagentToolEvidence[];
  pendingToolsOmitted: number;
  recentTools: SubagentToolEvidence[];
  confirmedWritePaths: string[];
  confirmedWritePathsOmitted: number;
};

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
function member<T extends string>(value: unknown, values: readonly T[]): value is T { return values.some(item => item === value); }
function attempt(value: unknown): SubagentModelAttempt | undefined {
  if (!record(value) || !count(value.sequence) || !text(value.model) || !count(value.startedAt) ||
      !member(value.outcome, ["running", "completed", "failed", "aborted", "unresolved"] as const)) return;
  if (value.finishedAt !== undefined && (!count(value.finishedAt) || value.finishedAt < value.startedAt) ||
      value.providerDurationMs !== undefined && (typeof value.providerDurationMs !== "number" || !Number.isFinite(value.providerDurationMs) || value.providerDurationMs < 0)) return;
  let error: SubagentModelAttempt["error"];
  if (value.error !== undefined) {
    if (!record(value.error) || !text(value.error.code, 200) || !text(value.error.message, 2000)) return;
    error = { code: value.error.code, message: value.error.message };
  }
  let usage: SubagentModelAttempt["usage"];
  if (value.usage !== undefined) {
    if (!record(value.usage) || !count(value.usage.inputTokens) || !count(value.usage.outputTokens) || !count(value.usage.totalTokens)) return;
    usage = { inputTokens: value.usage.inputTokens, outputTokens: value.usage.outputTokens, totalTokens: value.usage.totalTokens };
  }
  return { sequence: value.sequence, model: value.model, startedAt: value.startedAt, outcome: value.outcome,
    ...(count(value.finishedAt) ? { finishedAt: value.finishedAt } : {}),
    ...(typeof value.providerDurationMs === "number" ? { providerDurationMs: value.providerDurationMs } : {}),
    ...(error ? { error } : {}), ...(usage ? { usage } : {}) };
}
function tool(value: unknown): SubagentToolEvidence | undefined {
  if (!record(value) || !text(value.toolCallId) || !text(value.toolName, 200) || !count(value.startedAt) ||
      !member(value.outcome, ["pending", "completed", "failed"] as const) ||
      !member(value.effects, ["unknown", "read_only", "write_confirmed"] as const)) return;
  if (value.path !== undefined && !text(value.path, 1000) ||
      value.finishedAt !== undefined && !count(value.finishedAt) ||
      value.outputChars !== undefined && !count(value.outputChars) ||
      value.totalLines !== undefined && !count(value.totalLines)) return;
  return { toolCallId: value.toolCallId, toolName: value.toolName, startedAt: value.startedAt, outcome: value.outcome, effects: value.effects,
    ...(text(value.path, 1000) ? { path: value.path } : {}),
    ...(count(value.finishedAt) ? { finishedAt: value.finishedAt } : {}),
    ...(count(value.outputChars) ? { outputChars: value.outputChars } : {}),
    ...(count(value.totalLines) ? { totalLines: value.totalLines } : {}) };
}
function list<T>(value: unknown, limit: number, parse: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value) || value.length > limit) return;
  const result: T[] = [];
  for (const item of value) { const parsed = parse(item); if (parsed === undefined) return; result.push(parsed); }
  return result;
}

/** Allowlist bounded metadata at persistence boundaries; old absent fields stay unknown. */
export function parseSubagentObservation(value: unknown): SubagentObservation | undefined {
  if (!record(value) || value.version !== 1 || !text(value.selectedModel) ||
      !member(value.phase, ["preparing", "model", "tool", "retrying", "approval", "ended"] as const) ||
      !count(value.lastActivityAt) || !record(value.diagnostic) ||
      !member(value.diagnostic.state, ["observing", "waiting_tool", "waiting_model", "no_new_evidence", "approval_pending", "ended"] as const) ||
      !count(value.diagnostic.observedAt) || !count(value.diagnostic.thresholdMs) || !text(value.diagnostic.reason, 1000)) return;
  if (![value.attemptCount, value.attemptsOmitted, value.approvalsOmitted, value.completedToolCalls,
    value.failedToolCalls, value.pendingToolsOmitted, value.confirmedWritePathsOmitted].every(count)) return;
  const attempts = list(value.attempts, 64, attempt);
  const approvals = list(value.approvals, 64, (item): SubagentApprovalObservation | undefined =>
    record(item) && text(item.model) && count(item.at) && member(item.status, ["pending", "accepted", "rejected", "cancelled"] as const)
      ? { model: item.model, status: item.status, at: item.at } : undefined);
  const pendingTools = list(value.pendingTools, 16, tool);
  const recentTools = list(value.recentTools, 12, tool);
  const confirmedWritePaths = list(value.confirmedWritePaths, 32, item => text(item, 1000) ? item : undefined);
  if (!attempts || !approvals || !pendingTools || !recentTools || !confirmedWritePaths ||
      value.attemptCount !== attempts.length + Number(value.attemptsOmitted)) return;
  const times: Partial<Pick<SubagentObservation, "executionStartedAt" | "executionEndedAt" | "reportProducedAt" | "reportDeliveredAt" | "lastMeaningfulProgressAt">> = {};
  for (const key of ["executionStartedAt", "executionEndedAt", "reportProducedAt", "reportDeliveredAt", "lastMeaningfulProgressAt"] as const) {
    if (value[key] !== undefined) { if (!count(value[key])) return; times[key] = value[key]; }
  }
  return { version: 1, selectedModel: value.selectedModel, phase: value.phase, lastActivityAt: value.lastActivityAt, ...times,
    diagnostic: { state: value.diagnostic.state, observedAt: value.diagnostic.observedAt, thresholdMs: value.diagnostic.thresholdMs, reason: value.diagnostic.reason },
    attemptCount: Number(value.attemptCount), attemptsOmitted: Number(value.attemptsOmitted), attempts,
    approvalsOmitted: Number(value.approvalsOmitted), approvals,
    completedToolCalls: Number(value.completedToolCalls), failedToolCalls: Number(value.failedToolCalls),
    pendingTools, pendingToolsOmitted: Number(value.pendingToolsOmitted), recentTools,
    confirmedWritePaths, confirmedWritePathsOmitted: Number(value.confirmedWritePathsOmitted) };
}
