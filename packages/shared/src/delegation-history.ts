import { isDelegationApprovalPrompt, type DelegationApprovalPrompt } from "./delegation-approval.js";
import type { MessageUsage } from "./types/messages.js";
import { parseSubagentObservation, type SubagentObservation } from "./delegation-observability.js";

export type DelegationRunHistoryQuery = {
  offset?: number; limit?: number; status?: "all" | "running" | "ended"; projectPath?: string; sessionId?: string;
};
export type DelegationRunHistoryEntry = {
  id: string; sessionId: string; sessionTitle: string; projectPath?: string | null; projectTitle?: string;
  delegationId: string; messageId: string; agentName: string; description: string;
  status: "running" | "completed" | "failed" | "stopped" | "aborted" | "timed_out" | "interrupted";
  createdAt: string; completedAt?: string; modelId?: string; modelReason?: string; requestedModel?: string;
  /** Actual recorded start, unlike createdAt which can fall back to the Task row timestamp. */
  startedAt?: string;
  usage?: Pick<MessageUsage, "inputTokens" | "outputTokens" | "totalTokens">;
  observation?: SubagentObservation;
  turns?: number; toolCalls?: number;
  task: string; report?: string; error?: { code: string; message: string };
  taskTruncated?: boolean; reportTruncated?: boolean;
};
/** nextOffset is a candidate cursor; a filtered page can be empty with more candidates. */
export type DelegationRunHistoryPage = { entries: DelegationRunHistoryEntry[]; nextOffset: number | null };
export type DelegationApprovalHistoryEntry = { request: DelegationApprovalPrompt; settledAt: string; readAt?: string | null };
export type DelegationApprovalHistory = { entries: DelegationApprovalHistoryEntry[] };
export type DelegationApprovalHistoryMarkRead = { sessionId?: string; requestId?: string };
export const DELEGATION_HISTORY_TEXT_LIMIT = 32768;
export const DELEGATION_APPROVAL_HISTORY_KEEP = 200;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const identity = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256 && v.trim() === v;
const timestamp = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export function isDelegationRunHistoryQuery(v: unknown): v is DelegationRunHistoryQuery {
  return record(v) && Object.keys(v).every(k => ["offset", "limit", "status", "projectPath", "sessionId"].includes(k)) &&
    (v.offset === undefined || (Number.isSafeInteger(v.offset) && Number(v.offset) >= 0)) &&
    (v.limit === undefined || (Number.isSafeInteger(v.limit) && Number(v.limit) >= 1 && Number(v.limit) <= 100)) &&
    (v.status === undefined || ["all", "running", "ended"].includes(String(v.status))) &&
    (v.projectPath === undefined || (typeof v.projectPath === "string" && v.projectPath.trim() === v.projectPath && v.projectPath.length > 0 && v.projectPath.length <= 4096)) &&
    (v.sessionId === undefined || identity(v.sessionId));
}
export function isDelegationApprovalHistoryMarkRead(v: unknown): v is DelegationApprovalHistoryMarkRead {
  return record(v) && Object.keys(v).every(k => k === "sessionId" || k === "requestId") &&
    ((v.sessionId === undefined && v.requestId === undefined) || (identity(v.sessionId) && identity(v.requestId)));
}
export function isDelegationApprovalHistoryEntry(v: unknown): v is DelegationApprovalHistoryEntry {
  return record(v) && isDelegationApprovalPrompt(v.request) && v.request.status !== "pending" && timestamp(v.settledAt) &&
    (v.readAt === undefined || v.readAt === null || timestamp(v.readAt));
}
export function isDelegationApprovalHistory(v: unknown): v is DelegationApprovalHistory {
  if (!record(v) || !Array.isArray(v.entries) || v.entries.length > DELEGATION_APPROVAL_HISTORY_KEEP) return false;
  const seen = new Set<string>();
  return v.entries.every(entry => {
    if (!isDelegationApprovalHistoryEntry(entry)) return false;
    const key = JSON.stringify([entry.request.sessionId, entry.request.requestId]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
const RUN_STATUSES = ["running", "completed", "failed", "stopped", "aborted", "timed_out", "interrupted"];
const text = (v: unknown, max = DELEGATION_HISTORY_TEXT_LIMIT): v is string =>
  typeof v === "string" && v.length <= max;
export function isDelegationRunHistoryEntry(v: unknown): v is DelegationRunHistoryEntry {
  if (!record(v) || !identity(v.id) || !identity(v.sessionId) || !identity(v.delegationId) ||
    !identity(v.messageId) || !text(v.sessionTitle, 4096) || !text(v.agentName) ||
    !text(v.description) || !text(v.task) || !RUN_STATUSES.includes(String(v.status)) ||
    !timestamp(v.createdAt)) return false;
  if (v.completedAt !== undefined && !timestamp(v.completedAt)) return false;
  if (v.startedAt !== undefined && !timestamp(v.startedAt)) return false;
  for (const key of ["turns", "toolCalls"] as const) {
    if (v[key] !== undefined && !(Number.isSafeInteger(v[key]) && Number(v[key]) >= 0)) return false;
  }
  if (v.observation !== undefined && !parseSubagentObservation(v.observation)) return false;
  if (v.usage !== undefined && (!record(v.usage) ||
    !["inputTokens", "outputTokens", "totalTokens"].every(key =>
      record(v.usage) && Number.isSafeInteger(v.usage[key]) && Number(v.usage[key]) >= 0))) return false;
  if (v.projectPath !== undefined && v.projectPath !== null && !text(v.projectPath, 4096)) return false;
  for (const key of ["projectTitle", "modelId", "modelReason", "requestedModel"] as const) {
    if (v[key] !== undefined && !text(v[key])) return false;
  }
  if (v.report !== undefined && !text(v.report)) return false;
  if (v.error !== undefined && (!record(v.error) || !text(v.error.code, 256) || !text(v.error.message))) return false;
  for (const key of ["taskTruncated", "reportTruncated"] as const) {
    if (v[key] !== undefined && typeof v[key] !== "boolean") return false;
  }
  return true;
}
export function isDelegationRunHistoryPage(v: unknown): v is DelegationRunHistoryPage {
  if (!record(v) || !Array.isArray(v.entries) || v.entries.length > 100) return false;
  if (v.nextOffset !== null && !(Number.isSafeInteger(v.nextOffset) && Number(v.nextOffset) >= 0)) return false;
  const seen = new Set<string>();
  return v.entries.every(entry => {
    if (!isDelegationRunHistoryEntry(entry)) return false;
    const key = JSON.stringify([entry.sessionId, entry.messageId]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
