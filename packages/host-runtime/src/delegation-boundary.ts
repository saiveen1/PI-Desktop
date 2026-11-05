import {
  SESSION_THINKING_LEVELS, isDelegationSettings, resolveDelegationRunPolicy,
  type DelegationApprovalRequest, type DelegationPolicySnapshot,
} from "@pi-desktop/shared";

const requestFields = new Set([
  "sessionId", "requestId", "providerId", "modelId", "task", "reason", "agentName",
  "description", "requestedModel", "thinkingLevel", "requiresImages", "minContextWindow",
  "selection", "automaticOnly",
]);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown, max: number): value is string =>
  typeof value === "string" && !!value.trim() && value === value.trim() && value.length <= max;

/** Reverse RPC is untrusted, including optional scheduler metadata. */
export function isDelegationAuthorizationRequest(value: unknown): value is DelegationApprovalRequest {
  if (!record(value) || Object.keys(value).some(key => !requestFields.has(key))) return false;
  return id(value.sessionId, 256) && id(value.requestId, 256)
    && id(value.providerId, 128) && id(value.modelId, 256)
    && typeof value.task === "string" && !!value.task.trim()
    && ["reason", "agentName", "description", "requestedModel"].every(key =>
      value[key] === undefined || typeof value[key] === "string")
    && (value.thinkingLevel === undefined || (typeof value.thinkingLevel === "string"
      && (SESSION_THINKING_LEVELS as readonly string[]).includes(value.thinkingLevel)))
    && ["requiresImages", "automaticOnly"].every(key => value[key] === undefined || typeof value[key] === "boolean")
    && (value.minContextWindow === undefined || (typeof value.minContextWindow === "number"
      && Number.isSafeInteger(value.minContextWindow) && value.minContextWindow > 0))
    && (value.selection === undefined || value.selection === "prefer" || value.selection === "require");
}

/** Never turn unsupported/malformed snapshots into an authoritative empty pool. */
export function delegationPolicySnapshot(value: unknown): DelegationPolicySnapshot {
  if (!record(value) || Object.keys(value).some(key => !["settings", "revision", "modelKeys"].includes(key))
    || !id(value.revision, 256) || !Array.isArray(value.modelKeys)
    || value.modelKeys.some(key => typeof key !== "string" || !key.trim() || key !== key.trim()
      || key.indexOf("/") <= 0 || key.endsWith("/"))
    || new Set(value.modelKeys).size !== value.modelKeys.length
    || (value.settings !== undefined && !isDelegationSettings(value.settings))) {
    throw new Error("Invalid delegation policy snapshot");
  }
  const settings = value.settings;
  return {
    revision: value.revision,
    modelKeys: [...value.modelKeys] as string[],
    ...(settings !== undefined && isDelegationSettings(settings) ? { settings: {
      version: 1 as const, approvalTimeoutSeconds: settings.approvalTimeoutSeconds,
      models: settings.models.map(row => ({ providerId: row.providerId, modelId: row.modelId,
        enabled: row.enabled, priority: row.priority, approval: row.approval, description: row.description })),
      ...(settings.runPolicy !== undefined ? { runPolicy: { ...resolveDelegationRunPolicy(settings.runPolicy) } } : {}),
    } } : {}),
  };
}
