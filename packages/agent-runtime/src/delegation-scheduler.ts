import { randomUUID } from "node:crypto";
import {
  delegationModelKey,
  isDelegationSettings,
  orderDelegationModels,
  type DelegationApprovalDecision,
  type DelegationApprovalRequest,
  type DelegationSelection,
  type DelegationSettings,
} from "@pi-desktop/shared";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import type { CurrentDelegationPolicy } from "./delegation-policy-state.js";

export type DelegationDecisionRecord = {
  model: string;
  decision: "selected" | "skipped" | "cancelled";
  reason: string;
};

export class DelegationAdmissionError extends Error {
  readonly code = "DELEGATION_NO_AUTHORIZED_MODEL";
  constructor(readonly decisions: readonly DelegationDecisionRecord[]) {
    super(`No authorized compatible delegation model is available. ${decisions.map(row => `${row.model}: ${row.reason}`).join("; ")}`);
    this.name = "DelegationAdmissionError";
  }
}

type Candidate = { key: string; provider?: RuntimeProviderConfig };
type Options = {
  settings?: DelegationSettings;
  currentPolicy?: () => Promise<CurrentDelegationPolicy>;
  sessionId: string;
  task: string;
  reason?: string;
  agentName?: string;
  description?: string;
  requestedModel?: string;
  thinkingLevel?: DelegationApprovalRequest["thinkingLevel"];
  requiresImages?: boolean;
  minContextWindow?: number;
  selection?: DelegationSelection;
  preferredKey?: string;
  /** Resolved definition pin or resumed chain: preserves the user's binding preference. */
  preferredProvider?: RuntimeProviderConfig;
  legacyFallbacks?: Candidate[];
  resolve: (key: string) => Promise<RuntimeProviderConfig | undefined>;
  /** Explicit host choices must resolve independently of any launch binding. */
  resolveSelected?: (key: string) => Promise<RuntimeProviderConfig | undefined>;
  authorize?: (request: DelegationApprovalRequest) => Promise<DelegationApprovalDecision>;
  cancelApproval?: (requestId: string) => Promise<unknown>;
  /** Reject incompatible candidates before asking the user. */
  compatible?: (provider: RuntimeProviderConfig) => string | undefined;
};

/** Owns one delegation's candidate order and grants, never the session's authority. */
export class DelegationScheduler {
  readonly decisions: DelegationDecisionRecord[] = [];
  readonly requestedModel?: string;
  private readonly approved = new Set<string>();
  private readonly rejected = new Set<string>();
  private readonly attempted = new Set<string>();
  private automaticOnly = false;
  private current: CurrentDelegationPolicy;

  constructor(private readonly options: Options) {
    this.current = { settings: options.settings };
    this.validate(this.current);
    this.requestedModel = options.requestedModel ?? options.preferredKey ?? (options.preferredProvider
      ? this.key(options.preferredProvider) : undefined);
  }

  get settings(): DelegationSettings | undefined { return this.current.settings; }

  private validate(policy: CurrentDelegationPolicy): void {
    if (policy.settings !== undefined && !isDelegationSettings(policy.settings)) {
      throw new Error("Invalid delegation scheduling settings; no model was authorized.");
    }
  }

  private async policy(): Promise<CurrentDelegationPolicy> {
    const policy = this.options.currentPolicy ? await this.options.currentPolicy() : this.current;
    this.validate(policy);
    this.current = policy;
    return policy;
  }

  private key(provider: RuntimeProviderConfig): string {
    return delegationModelKey({ providerId: provider.id, modelId: provider.modelId });
  }

  private preferredKey(): string | undefined {
    return this.options.preferredProvider ? this.key(this.options.preferredProvider) : this.options.preferredKey;
  }

  async candidates(): Promise<Candidate[]> {
    const { settings, modelKeys, selectionMode } = await this.policy();
    const { preferredProvider } = this.options;
    const keys = settings ? orderDelegationModels(settings, {
      preferredKey: this.preferredKey(), selection: this.options.selection,
      selectionMode,
      reason: this.options.reason ?? (preferredProvider ? "Configured role or resumed binding" : undefined),
    }).map(model => delegationModelKey(model)) : [
      ...(preferredProvider ? [this.key(preferredProvider)] : []),
      ...(this.options.selection === "require" ? [] : (this.options.legacyFallbacks ?? []).map(row => row.key)),
    ];
    const rows: Candidate[] = [];
    for (const key of new Set(keys)) {
      if (modelKeys && !modelKeys.includes(key)) continue;
      let provider: RuntimeProviderConfig | undefined;
      try {
        provider = modelKeys !== undefined ? await this.options.resolve(key)
          : preferredProvider && this.key(preferredProvider) === key ? preferredProvider
          : settings ? await this.options.resolve(key) : this.options.legacyFallbacks?.find(row => row.key === key)?.provider;
      } catch { /* An unavailable candidate is recorded and skipped by select. */ }
      if (provider && settings && this.key(provider) !== key) provider = undefined;
      rows.push({ key, provider });
    }
    return rows;
  }

  async select(signal?: AbortSignal): Promise<{ provider: RuntimeProviderConfig; fallbacks: Candidate[] }> {
    // Refresh after each declined/unavailable model. The finite attempted set
    // also bounds a host that keeps changing the pool while approval is pending.
    while (this.attempted.size < 128) {
      signal?.throwIfAborted();
      const candidates = await this.candidates();
      signal?.throwIfAborted();
      const candidate = candidates.find(row => !this.attempted.has(row.key));
      if (!candidate) break;
      this.attempted.add(candidate.key);
      if (!candidate.provider) { this.skip(candidate.key, "Model is unavailable"); continue; }
      const provider = await this.admit(candidate.provider, signal);
      if (provider) return { provider, fallbacks: candidates.filter(row => !this.attempted.has(row.key) && row.key !== this.key(provider)) };
    }
    throw new DelegationAdmissionError(this.decisions.map(row => ({ ...row })));
  }

  /** Compatibility surface for existing callers that only accept the proposed identity. */
  async authorize(provider: RuntimeProviderConfig, signal?: AbortSignal): Promise<boolean> {
    const selected = await this.admit(provider, signal);
    return Boolean(selected && this.key(selected) === this.key(provider));
  }

  private ineligible(provider: RuntimeProviderConfig, policy: CurrentDelegationPolicy): string | undefined {
    const key = this.key(provider);
    if (policy.modelKeys && !policy.modelKeys.includes(key)) return "Model is unavailable";
    const model = policy.settings?.models.find(row => delegationModelKey(row) === key);
    if (policy.settings && !model?.enabled) return "Model is disabled or absent from the scheduling pool";
    if (this.automaticOnly && model?.approval === "ask") return "Approval wait expired; only automatic models may run in this invocation";
    return this.options.compatible?.(provider);
  }

  /** Returns the actual admitted identity, including one exact host-selected alternative. */
  async admit(provider: RuntimeProviderConfig, signal?: AbortSignal): Promise<RuntimeProviderConfig | undefined> {
    signal?.throwIfAborted();
    const key = this.key(provider);
    const policy = await this.policy();
    signal?.throwIfAborted();
    const incompatible = this.ineligible(provider, policy);
    if (incompatible) { this.skip(key, incompatible); return undefined; }
    if (this.approved.has(key)) return provider;
    if (this.rejected.has(key)) return undefined;
    if (!this.options.authorize) {
      if (policy.settings) { this.skip(key, "The host does not support mandatory model authorization"); return undefined; }
      this.approved.add(key);
      return provider;
    }
    const requestId = randomUUID();
    let cancel = () => {};
    const aborted = new Promise<DelegationApprovalDecision>(resolve => {
      cancel = () => {
        void this.options.cancelApproval?.(requestId).catch(() => undefined);
        resolve({ decision: "cancel", reason: "Delegation was cancelled" });
      };
      signal?.addEventListener("abort", cancel, { once: true });
    });
    let result: DelegationApprovalDecision;
    try {
      result = await Promise.race([this.options.authorize({
        sessionId: this.options.sessionId, requestId, providerId: provider.id,
        modelId: provider.modelId, task: this.options.task, reason: this.options.reason,
        agentName: this.options.agentName, description: this.options.description,
        requestedModel: this.requestedModel, thinkingLevel: this.options.thinkingLevel,
        requiresImages: this.options.requiresImages, minContextWindow: this.options.minContextWindow,
        selection: this.options.selection,
        ...(this.automaticOnly ? { automaticOnly: true } : {}),
      }), aborted]);
    } catch {
      result = { decision: "skip", reason: "Model authorization is unavailable", code: "unavailable" };
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
    signal?.throwIfAborted();
    if (result?.decision === "cancel") {
      this.decisions.push({ model: key, decision: "cancelled", reason: result.reason });
      throw new Error("Delegation cancelled by the user; do not retry or switch models.");
    }
    if (result?.decision !== "allow") {
      if (result?.code === "timeout") this.automaticOnly = true;
      this.skip(key, result?.reason ?? "Model was not approved");
      return undefined;
    }
    const latest = await this.policy();
    signal?.throwIfAborted();
    if (result.selectedModel !== undefined) {
      const target = result.selectedModel;
      if (!target || typeof target.providerId !== "string" || !target.providerId.trim() || target.providerId !== target.providerId.trim() ||
          target.providerId.length > 128 || typeof target.modelId !== "string" || !target.modelId.trim() ||
          target.modelId !== target.modelId.trim() || target.modelId.length > 256) throw new Error("The selected model identity is invalid; no substitute was started.");
      const selectedKey = delegationModelKey(target);
      if (this.options.selection === "require" && selectedKey !== this.preferredKey()) {
        throw new Error("The selected model differs from the required exact model; no substitute was started.");
      }
      let selected: RuntimeProviderConfig | undefined;
      try { selected = await (this.options.resolveSelected ?? this.options.resolve)(selectedKey); } catch { /* Report exact selection failure below. */ }
      signal?.throwIfAborted();
      const current = await this.policy();
      if (!selected || this.key(selected) !== selectedKey || this.rejected.has(selectedKey) || this.ineligible(selected, current)) {
        throw new Error("The selected model is unavailable, disabled or incompatible; no substitute was started.");
      }
      if (selectedKey !== key) this.skip(key, `User selected ${selectedKey} instead`);
      provider = selected;
    } else if (this.ineligible(provider, latest)) {
      this.skip(key, "Model eligibility changed while approval was pending");
      return undefined;
    }
    const selectedKey = this.key(provider);
    this.approved.add(selectedKey);
    this.attempted.add(selectedKey);
    this.decisions.push({ model: selectedKey, decision: "selected", reason: result.reason });
    return provider;
  }

  private skip(model: string, reason: string): void {
    this.rejected.add(model);
    this.decisions.push({ model, decision: "skipped", reason });
  }
}
