/** Host-owned approval DTOs. Display prose and model selectors never grant consent. */
import type { DelegationModel, DelegationModelIdentity } from "./delegation-policy.js";
import { isSessionThinkingLevel } from "./thinking-levels.js";
import type { SessionThinkingLevel } from "./types/models.js";

export const DELEGATION_APPROVAL_EXTENSION_SECONDS = 300;
export const DELEGATION_APPROVAL_STATUSES = [
  "pending", "approved", "skipped", "cancelled", "expired", "invalidated",
] as const;
export type DelegationApprovalStatus = (typeof DELEGATION_APPROVAL_STATUSES)[number];

/** Labels come from the host's current model rows, never a guessed backend. */
export type DelegationApprovalModel = DelegationModelIdentity & {
  providerName: string;
  modelLabel?: string;
  thinkingLevel?: SessionThinkingLevel;
  priority: number;
  approval: DelegationModel["approval"];
};

export type DelegationApprovalPrompt = {
  requestId: string;
  sessionId: string;
  /** Nonnegative safe integer; changed task/candidate invalidates earlier consent. */
  revision: number;
  status: DelegationApprovalStatus;
  /** Canonical UTC ISO timestamps, including milliseconds, owned by the host. */
  createdAt: string;
  expiresAt: string;
  sessionTitle?: string;
  projectTitle?: string;
  projectPath?: string;
  agentName?: string;
  description?: string;
  task: string;
  modelReason?: string;
  requestedModel?: string;
  candidate: DelegationApprovalModel;
  candidates: DelegationApprovalModel[];
  schedulingReason?: string;
};

/** Reload reads live requests from the host rather than persisted renderer state. */
export type DelegationApprovalSnapshot = { requests: DelegationApprovalPrompt[] };

/** Existing main-to-renderer transport envelope carries this payload unchanged. */
export type DelegationApprovalChangedEvent = { request: DelegationApprovalPrompt };

/** Explicit fixed +300 seconds only; never a renderer-authored deadline or duration. */
export type DelegationApprovalExtendRequest = {
  sessionId: string;
  requestId: string;
  revision: number;
};

/** Each call resolves only its own identity/revision, with no ambient batch approval. */
export type DelegationApprovalActionRequest = DelegationApprovalExtendRequest & (
  | { action: "allow" | "skip" | "cancel"; providerId?: never; modelId?: never }
  | { action: "select"; providerId: string; modelId: string }
);

export type DelegationApprovalActionResultCode =
  | "not-found" | "not-pending" | "stale" | "expired" | "unavailable" | "invalid";

export type DelegationApprovalActionResult = {
  accepted: boolean;
  request?: DelegationApprovalPrompt;
  code?: DelegationApprovalActionResultCode;
  error?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentityPart(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim();
}

function hasModelIdentity(value: Record<string, unknown>): boolean {
  return isIdentityPart(value.providerId, 128) && isIdentityPart(value.modelId, 256);
}

function hasRequestIdentity(value: Record<string, unknown>): boolean {
  return isIdentityPart(value.sessionId, 256) && isIdentityPart(value.requestId, 256) &&
    typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0;
}

export function isDelegationApprovalModel(value: unknown): value is DelegationApprovalModel {
  if (!isRecord(value) || !hasModelIdentity(value)) return false;
  return typeof value.providerName === "string" && value.providerName.trim().length > 0 &&
    (value.modelLabel === undefined || typeof value.modelLabel === "string") &&
    (value.thinkingLevel === undefined || isSessionThinkingLevel(value.thinkingLevel)) &&
    typeof value.priority === "number" && Number.isInteger(value.priority) && value.priority >= 1 && value.priority <= 100 &&
    (value.approval === "auto" || value.approval === "ask");
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function isDelegationApprovalPrompt(value: unknown): value is DelegationApprovalPrompt {
  if (!isRecord(value) || !hasRequestIdentity(value)) return false;
  if (typeof value.status !== "string" || !(DELEGATION_APPROVAL_STATUSES as readonly string[]).includes(value.status) ||
    !isTimestamp(value.createdAt) || !isTimestamp(value.expiresAt) || value.expiresAt <= value.createdAt ||
    typeof value.task !== "string" || !value.task.trim()) return false;
  for (const field of ["sessionTitle", "projectTitle", "projectPath", "agentName", "description",
    "modelReason", "requestedModel", "schedulingReason"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") return false;
  }
  if (!isDelegationApprovalModel(value.candidate) || !Array.isArray(value.candidates) ||
    value.candidates.length === 0 || value.candidates.length > 128) return false;
  const seen = new Set<string>();
  for (const candidate of value.candidates) {
    if (!isDelegationApprovalModel(candidate)) return false;
    const key = JSON.stringify([candidate.providerId, candidate.modelId]);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return seen.has(JSON.stringify([value.candidate.providerId, value.candidate.modelId]));
}

export function isDelegationApprovalSnapshot(value: unknown): value is DelegationApprovalSnapshot {
  if (!isRecord(value) || !Array.isArray(value.requests)) return false;
  const seen = new Set<string>();
  for (const request of value.requests) {
    if (!isDelegationApprovalPrompt(request)) return false;
    const key = JSON.stringify([request.sessionId, request.requestId]);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/** Shape validation only: host must recheck pending state, revision and eligibility. */
export function isDelegationApprovalActionRequest(value: unknown): value is DelegationApprovalActionRequest {
  if (!isRecord(value) || !hasRequestIdentity(value)) return false;
  const selecting = value.action === "select";
  if (!selecting && value.action !== "allow" && value.action !== "skip" && value.action !== "cancel") return false;
  const fields = selecting
    ? ["sessionId", "requestId", "revision", "action", "providerId", "modelId"]
    : ["sessionId", "requestId", "revision", "action"];
  return Object.keys(value).every(key => fields.includes(key)) && (!selecting || hasModelIdentity(value));
}

export function isDelegationApprovalExtendRequest(value: unknown): value is DelegationApprovalExtendRequest {
  return isRecord(value) && hasRequestIdentity(value) &&
    Object.keys(value).every(key => key === "sessionId" || key === "requestId" || key === "revision");
}
