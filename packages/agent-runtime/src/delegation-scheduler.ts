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

export type DelegationDecisionRecord = {
  model: string;
  decision: "selected" | "skipped" | "cancelled";
  reason: string;
};

type Options = {
  settings?: DelegationSettings;
  sessionId: string;
  task: string;
  reason?: string;
  selection?: DelegationSelection;
  preferredKey?: string;
  /** Resolved definition pin or resumed chain: preserves the user's binding preference. */
  preferredProvider?: RuntimeProviderConfig;
  legacyFallbacks?: Array<{ key: string; provider?: RuntimeProviderConfig }>;
  resolve: (key: string) => Promise<RuntimeProviderConfig | undefined>;
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
  private readonly options: Options;

  constructor(options: Options) {
    if (options.settings !== undefined && !isDelegationSettings(options.settings)) {
      throw new Error("Invalid delegation scheduling settings; no model was authorized.");
    }
    this.options = options;
    this.requestedModel = options.preferredKey ?? (options.preferredProvider
      ? this.key(options.preferredProvider) : undefined);
  }

  private key(provider: RuntimeProviderConfig): string {
    return delegationModelKey({ providerId: provider.id, modelId: provider.modelId });
  }

  async candidates(): Promise<Array<{ key: string; provider?: RuntimeProviderConfig }>> {
    const { settings, preferredProvider } = this.options;
    if (!settings) return [
      ...(preferredProvider ? [{ key: this.key(preferredProvider), provider: preferredProvider }] : []),
      ...(this.options.selection === "require" ? [] : this.options.legacyFallbacks ?? []),
    ];
    const preferredKey = preferredProvider ? this.key(preferredProvider) : this.options.preferredKey;
    const models = orderDelegationModels(settings, {
      preferredKey,
      selection: this.options.selection,
      reason: this.options.reason ?? (preferredProvider ? "Configured role or resumed binding" : undefined),
    });
    const rows: Array<{ key: string; provider?: RuntimeProviderConfig }> = [];
    for (const model of models) {
      const key = delegationModelKey(model);
      let provider = preferredProvider && this.key(preferredProvider) === key ? preferredProvider : undefined;
      if (!provider) {
        try { provider = await this.options.resolve(key); }
        catch { /* An unavailable candidate is recorded and skipped by select. */ }
      }
      rows.push({ key, provider });
    }
    return rows;
  }

  async select(signal?: AbortSignal): Promise<{
    provider: RuntimeProviderConfig;
    fallbacks: Array<{ key: string; provider?: RuntimeProviderConfig }>;
  }> {
    signal?.throwIfAborted();
    const candidates = await this.candidates();
    signal?.throwIfAborted();
    for (const [index, candidate] of candidates.entries()) {
      if (!candidate.provider) {
        this.decisions.push({ model: candidate.key, decision: "skipped", reason: "Model is unavailable" });
        continue;
      }
      if (await this.authorize(candidate.provider, signal)) {
        return { provider: candidate.provider, fallbacks: candidates.slice(index + 1) };
      }
    }
    throw new Error(`No authorized compatible delegation model is available. ${this.decisions.map((row) => `${row.model}: ${row.reason}`).join("; ")}`);
  }

  /** Called again at fallback, after the carried-context capability check. */
  async authorize(provider: RuntimeProviderConfig, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const key = this.key(provider);
    if (this.approved.has(key)) return true;
    if (this.rejected.has(key)) return false;
    const { settings } = this.options;
    const policy = settings?.models.find((model) => model.providerId === provider.id && model.modelId === provider.modelId);
    const incompatible = this.options.compatible?.(provider);
    if ((settings && !policy?.enabled) || incompatible) {
      this.skip(key, incompatible ?? "Model is disabled or absent from the scheduling pool");
      return false;
    }
    if (!this.options.authorize) {
      if (settings) {
        this.skip(key, "The host does not support mandatory model authorization");
        return false;
      }
      this.approved.add(key);
      return true;
    }
    const requestId = randomUUID();
    let cancel = () => {};
    const aborted = new Promise<DelegationApprovalDecision>((resolve) => {
      cancel = () => {
        void this.options.cancelApproval?.(requestId).catch(() => undefined);
        resolve({ decision: "cancel", reason: "Delegation was cancelled" });
      };
      signal?.addEventListener("abort", cancel, { once: true });
    });
    let result: DelegationApprovalDecision;
    try {
      const request = this.options.authorize({
        sessionId: this.options.sessionId, requestId, providerId: provider.id,
        modelId: provider.modelId, task: this.options.task, reason: this.options.reason,
      });
      result = await Promise.race([request, aborted]);
    } catch {
      result = { decision: "skip", reason: "Model authorization is unavailable" };
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
    signal?.throwIfAborted();
    if (result?.decision === "cancel") {
      this.decisions.push({ model: key, decision: "cancelled", reason: result.reason });
      throw new Error("Delegation cancelled by the user; do not retry or switch models.");
    }
    if (result?.decision !== "allow") {
      this.skip(key, result?.reason ?? "Model was not approved");
      return false;
    }
    this.approved.add(key);
    this.decisions.push({ model: key, decision: "selected", reason: result.reason });
    return true;
  }

  private skip(model: string, reason: string): void {
    this.rejected.add(model);
    this.decisions.push({ model, decision: "skipped", reason });
  }
}
