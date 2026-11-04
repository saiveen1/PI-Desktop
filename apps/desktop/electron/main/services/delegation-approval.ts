import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import {
  isDelegationSettings,
  type AppSettings,
  type DelegationApprovalRequest,
  type DelegationApprovalDecision,
  type TrustedExtensionUiRequestEnvelope,
  type TrustedExtensionUiResponse,
} from "@pi-desktop/shared";

type Host = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };
type Provider = {
  id: string; enabled?: boolean; hasSecret?: boolean; hasOauth?: boolean; authKind?: string;
  defaultModelId?: string; models?: { id: string }[];
};
type Dependencies = {
  getHost: () => Host | null;
  requestUi: (request: TrustedExtensionUiRequestEnvelope) => Promise<TrustedExtensionUiResponse>;
};
const namespace = "core.delegation-approval";
const identity = (request: { sessionId: string; requestId: string }) =>
  JSON.stringify([request.sessionId, request.requestId]);
const decision = (value: DelegationApprovalDecision["decision"], reason: string): DelegationApprovalDecision =>
  ({ decision: value, reason });

export function createDelegationApprovalService(deps: Dependencies) {
  const pending = new Map<string, { cancel: () => void }>();
  let disposed = false;

  async function read(request: DelegationApprovalRequest) {
    const host = deps.getHost();
    if (!host || disposed) throw new Error("Delegation host unavailable");
    const [settings, listed] = await Promise.all([
      host.call<AppSettings>("settings.get"),
      host.call<{ providers: Provider[] }>("providers.list", { includeDisabled: false }),
    ]);
    if (deps.getHost() !== host || disposed) throw new Error("Delegation host changed");
    const policy = settings.delegation;
    if (policy === undefined) return { settings, policy, model: undefined };
    if (!isDelegationSettings(policy)) throw new Error("Invalid delegation policy");
    const provider = listed.providers.find((row) => row.id === request.providerId && row.enabled !== false);
    const available = provider && (provider.hasSecret === true || provider.hasOauth === true || provider.authKind === "none")
      && (provider.models?.length ? provider.models.some((row) => row.id === request.modelId) : provider.defaultModelId === request.modelId);
    if (!available) throw new Error("Delegation model unavailable");
    const model = policy?.models.find((row) => row.providerId === request.providerId && row.modelId === request.modelId && row.enabled);
    if (policy && !model) throw new Error("Delegation model disabled");
    return { settings, policy, model };
  }

  function cancel(request: { sessionId: string; requestId: string }) {
    pending.get(identity(request))?.cancel();
  }

  async function authorize(request: DelegationApprovalRequest): Promise<DelegationApprovalDecision> {
    if (!request || [request.sessionId, request.requestId, request.providerId, request.modelId, request.task]
      .some((value) => typeof value !== "string" || !value.trim())
      || (request.reason !== undefined && typeof request.reason !== "string")) {
      return decision("skip", "Invalid delegation request");
    }
    const key = identity(request);
    if (disposed || pending.has(key)) return decision("skip", "Delegation request unavailable");
    let cancelled = false;
    let finish!: (result: DelegationApprovalDecision) => void;
    const interrupted = new Promise<DelegationApprovalDecision>((resolve) => { finish = resolve; });
    const dismiss = () => {
      void deps.requestUi({ sessionId: request.sessionId, extensionId: namespace, extensionLabel: namespace,
        request: { kind: "cancel", requestId: request.requestId } }).catch(() => undefined);
    };
    const entry = { cancel: () => { cancelled = true; finish(decision("cancel", "Delegation cancelled")); dismiss(); } };
    pending.set(key, entry);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = async (): Promise<DelegationApprovalDecision> => {
        const current = await read(request);
        if (cancelled) return decision("cancel", "Delegation cancelled");
        if (!current.policy) return decision("allow", "Legacy delegation policy");
        if (current.model?.approval === "auto") return decision("allow", "Automatically allowed by delegation policy");
        if (current.policy.approvalTimeoutSeconds === 0) return decision("skip", "Delegation approval timeout");
        const strings = catalogs[resolveLocale(current.settings.language ?? "auto")].delegationApproval;
        const t = (key: keyof typeof strings, options: { defaultValue: string }) => strings?.[key] ?? options.defaultValue;
        const allow = t("allowOnce", { defaultValue: "Allow once" });
        const skip = t("useOther", { defaultValue: "Use another model" });
        const stop = t("cancel", { defaultValue: "Cancel delegation" });
        // The deadline includes time queued behind another host prompt.
        timer = setTimeout(() => { finish(decision("skip", "Delegation approval timeout")); dismiss(); },
          current.policy.approvalTimeoutSeconds * 1000);
        let response: TrustedExtensionUiResponse;
        try {
          response = await deps.requestUi({ sessionId: request.sessionId, requestId: request.requestId,
            extensionId: namespace, extensionLabel: t("label", { defaultValue: "Delegation approval" }),
            request: { kind: "select", title: `${t("title", { defaultValue: "Approve delegated model" })}: ${request.providerId}/${request.modelId}\n${request.task.slice(0, 2000)}${request.reason ? `\n${t("reason", { defaultValue: "Selection reason" })}: ${request.reason.slice(0, 1000)}` : ""}`,
              options: [allow, skip, stop] } });
        } catch { return decision("skip", "Delegation approval UI unavailable"); }
        if (cancelled) return decision("cancel", "Delegation cancelled");
        if (response.kind !== "select" || response.cancelled) return decision("skip", "Delegation approval dismissed or expired");
        // Renderer dismissal is an explicit cancellation, not consent to fallback.
        if (response.value === undefined || response.value === stop) return decision("cancel", "Delegation cancelled");
        if (response.value === skip) return decision("skip", "Alternative model requested");
        if (response.value !== allow) return decision("skip", "Invalid delegation approval response");
        const latest = await read(request);
        if (cancelled || disposed) return decision("cancel", "Delegation cancelled");
        if (latest.policy && latest.model?.approval === "ask" && latest.policy.approvalTimeoutSeconds === 0) {
          return decision("skip", "Delegation approval disabled while waiting");
        }
        return decision("allow", "User approved this delegation once");
      };
      return await Promise.race([operation(), interrupted]);
    } catch { return decision("skip", "Delegation policy or model unavailable"); }
    finally {
      if (timer) clearTimeout(timer);
      if (pending.get(key) === entry) pending.delete(key);
      cancelled = true;
      dismiss();
    }
  }

  return { authorize, cancel, dispose() {
    disposed = true;
    for (const entry of pending.values()) entry.cancel();
    pending.clear();
  } };
}
