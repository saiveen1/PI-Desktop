import { createHash, randomUUID } from "node:crypto";
import {
  canonicalThinkingLevel, delegationModelKey, nearestSupportedThinkingLevel,
  orderDelegationModels, isSessionDelegationPolicy, resolveSessionDelegationSettings, THINKING_LEVELS, type AppSettings, type DelegationApprovalModel,
  type DelegationApprovalRequest, type SessionDelegationPolicy, type ThinkingLevel,
} from "@pi-desktop/shared";
import { delegationPolicySnapshot } from "@pi-desktop/host-runtime";
import type { RuntimeProvider } from "../runtime/provider-catalog";

export type DelegationHost = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };
type Binding = { id: string; alias?: string; availableForSubagents?: boolean; contextWindow?: number; thinkingLevels?: readonly string[] };
export type DelegationProvider = RuntimeProvider & { contextWindow?: number; thinkingLevels?: readonly string[] };
export type DelegationCatalogDependencies = {
  getHost: () => DelegationHost | null;
  listProviders?: () => Promise<DelegationProvider[]>;
  modelCapabilities?: (provider: DelegationProvider, modelId: string) => {
    supportsVision: boolean; contextWindow?: number; thinkingLevels?: readonly string[];
  };
};

/** This is the only projection from provider/settings records to the approval UI. */
export function createDelegationCatalog(deps: DelegationCatalogDependencies) {
  const authority = randomUUID();
  let generation = 0;
  const fingerprints = new Map<string, { fingerprint: string; revision: string }>();
  let epoch = 0;
  async function read(sessionId?: string) {
    for (;;) {
    const started = epoch;
    const host = deps.getHost();
    if (!host) throw new Error("Delegation host unavailable");
    const [settings, providers, sessionPolicy] = await Promise.all([
      host.call<AppSettings>("settings.get"),
      deps.listProviders?.() ?? host.call<{ providers: DelegationProvider[] }>("providers.list", { includeDisabled: false })
        .then(result => result.providers),
      sessionId ? host.call<SessionDelegationPolicy>("session.delegationPolicy", { id: sessionId }) : undefined,
    ]);
    if (deps.getHost() !== host) throw new Error("Delegation host changed");
    if (epoch !== started) continue;
    if (sessionId && !isSessionDelegationPolicy(sessionPolicy)) throw new Error("Invalid session delegation policy");
    const policy = resolveSessionDelegationSettings(settings.delegation, providers, sessionPolicy ?? { modelKeys: null });
    const customKeys = sessionPolicy?.modelKeys ?? undefined;
    const available = providers.filter(row => row.enabled !== false &&
      (row.hasSecret === true || row.hasOauth === true || row.authKind === "none")).flatMap(provider => {
      const bindings: Binding[] = provider.models?.length ? provider.models : provider.defaultModelId ? [{ id: provider.defaultModelId }] : [];
      return bindings.map(binding => {
        const capabilities = deps.modelCapabilities?.(provider, binding.id) ?? {
          supportsVision: provider.supportsVision === true,
          contextWindow: binding.contextWindow ?? provider.contextWindow,
          thinkingLevels: binding.thinkingLevels ?? provider.thinkingLevels,
        };
        return { providerId: provider.id, providerName: provider.name || provider.id,
          modelId: binding.id, ...(binding.alias ? { modelLabel: binding.alias } : {}),
          legacyEnabled: binding.availableForSubagents === true, ...capabilities };
      });
    });
    const fingerprint = createHash("sha256").update(JSON.stringify({ policy, available, customKeys })).digest("hex");
    const key = sessionId ?? "";
    if (fingerprint !== fingerprints.get(key)?.fingerprint) {
      fingerprints.set(key, { fingerprint, revision: `${authority}:${++generation}` });
    }
    const revision = fingerprints.get(key)!.revision;
    const snapshot = delegationPolicySnapshot({ ...(policy !== undefined ? { settings: policy } : {}), revision,
      ...(customKeys !== undefined ? { selectionMode: "task-fit" } : {}),
      modelKeys: available.filter(model => policy === undefined ? model.legacyEnabled : policy.models.some(row =>
        row.enabled && row.providerId === model.providerId && row.modelId === model.modelId)).map(delegationModelKey) });
    return { host, policy: snapshot.settings, snapshot, available };
    }
  }
  function candidates(current: Awaited<ReturnType<typeof read>>, request: DelegationApprovalRequest): DelegationApprovalModel[] {
    if (!current.policy) return [];
    return orderDelegationModels(current.policy, {
      preferredKey: `${request.providerId}/${request.modelId}`, selection: request.selection, reason: request.reason,
      selectionMode: current.snapshot.selectionMode,
    }).flatMap(row => {
      const model = current.available.find(model => model.providerId === row.providerId && model.modelId === row.modelId);
      if (!model || (request.requiresImages && !model.supportsVision)
        || (request.minContextWindow !== undefined && (model.contextWindow ?? 0) < request.minContextWindow)) return [];
      // Thinking is requested display metadata, not eligibility: the runtime
      // clamps or omits it per model with the same nearest-supported rule, so
      // show the level this model will actually use instead of hiding every
      // model below the parent's requested level.
      const supportedThinking = model.thinkingLevels?.filter((level): level is ThinkingLevel =>
        (THINKING_LEVELS as readonly string[]).includes(level));
      const thinkingLevel = request.thinkingLevel === undefined ? undefined
        : request.thinkingLevel === "omit" ? "omit" as const
        : supportedThinking?.length
          ? nearestSupportedThinkingLevel(canonicalThinkingLevel(request.thinkingLevel), supportedThinking)
          : undefined; // Unknown capability: show nothing rather than a wrong level.
      return [{ providerId: row.providerId, providerName: model.providerName, modelId: row.modelId,
        ...(model.modelLabel ? { modelLabel: model.modelLabel } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        priority: row.priority, approval: row.approval }];
    });
  }
  async function source(sessionId: string) {
    const host = deps.getHost();
    if (!host) throw new Error("Delegation host unavailable");
    const [{ session }, { projects }] = await Promise.all([
      host.call<{ session?: { title?: string; projectPath?: string; projectTitle?: string } }>("session.get", { id: sessionId }),
      host.call<{ projects: { path: string; name: string }[] }>("projects.list"),
    ]);
    if (deps.getHost() !== host || !session) throw new Error("Delegation source session unavailable");
    const projectPath = session.projectPath?.trim();
    return {
      ...(session.title ? { sessionTitle: session.title } : {}),
      ...(projectPath ? { projectPath, projectTitle: projects.find(project => project.path === projectPath)?.name
        || session.projectTitle || projectPath.split(/[\\/]/).filter(Boolean).at(-1) } : {}),
    };
  }
  return { read, candidates, source, invalidate() { epoch++; fingerprints.clear(); }, snapshot: async (sessionId?: string) => (await read(sessionId)).snapshot };
}
