import {
  delegationModelKey, isDelegationSettings, legacyDelegationSettings,
  type DelegationModel, type DelegationSettings,
} from "./delegation-policy.js";

export type DelegationModelApprovals = Record<string, DelegationModel["approval"]>;

/** Host-owned session policy; null keys inherit, empty keys disable delegation. */
export type SessionDelegationPolicy = {
  modelKeys: string[] | null;
  modelApprovals?: DelegationModelApprovals | null;
};

function validModelKey(key: unknown): key is string {
  if (typeof key !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(key)) return false;
  const separator = key.indexOf("/");
  if (separator < 1) return false;
  const provider = key.slice(0, separator);
  const model = key.slice(separator + 1);
  return provider === provider.trim() && provider.length <= 128 &&
    model.length > 0 && model === model.trim() && model.length <= 256;
}

export function isSessionDelegationPolicy(value: unknown): value is SessionDelegationPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  if (policy.modelKeys !== null && (!Array.isArray(policy.modelKeys) || policy.modelKeys.length > 128 ||
    !policy.modelKeys.every(validModelKey) || new Set(policy.modelKeys).size !== policy.modelKeys.length)) return false;
  if (policy.modelApprovals == null) return true;
  if (!Array.isArray(policy.modelKeys) || typeof policy.modelApprovals !== "object" || Array.isArray(policy.modelApprovals)) return false;
  const entries = Object.entries(policy.modelApprovals);
  const selected = new Set(policy.modelKeys);
  return entries.length <= 128 && entries.every(([key, approval]) =>
    selected.has(key) && (approval === "auto" || approval === "ask"));
}

/** Launch and live authorization share this projection; overrides never enable a model. */
export function resolveSessionDelegationSettings(
  settings: DelegationSettings | undefined,
  providers: Parameters<typeof legacyDelegationSettings>[0],
  session: SessionDelegationPolicy,
): DelegationSettings | undefined {
  if (settings !== undefined && !isDelegationSettings(settings)) throw new Error("Invalid delegation policy");
  if (!isSessionDelegationPolicy(session)) throw new Error("Invalid session delegation policy");
  if (session.modelKeys === null) return settings;
  const selected = new Set(session.modelKeys);
  const base = settings ?? legacyDelegationSettings(providers);
  return { ...base, models: base.models.filter(model => selected.has(delegationModelKey(model))).map(model => ({
    ...model, approval: session.modelApprovals?.[delegationModelKey(model)] ?? model.approval,
  })) };
}
