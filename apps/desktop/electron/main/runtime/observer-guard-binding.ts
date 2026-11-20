import {
  resolveObserverGuardMode, resolveObserverGuardSettings,
  type ModelBinding, type ObserverGuardError,
} from "@pi-desktop/shared";
import {
  capabilitiesFromModelConfig, modelConfigWithBinding, optionalProviderHeaders,
  type ModelConfig, type ObserverGuardRuntimeConfig,
} from "@pi-desktop/agent-runtime";
import { OAUTH_AUTH_KIND } from "../oauth";
import type { RuntimeProvider } from "./provider-catalog";

type VendorBinding = { baseUrl?: string; apiStyle?: string; modelConfig?: ModelConfig };
type Dependencies = {
  providers: readonly RuntimeProvider[];
  getSecret: (providerId: string) => Promise<string | undefined>;
  vendorBinding: (providerId: string, modelId: string) => Promise<VendorBinding | undefined>;
  catalogModel: (provider: RuntimeProvider, modelId: string) => ModelConfig;
  isImageModel: (providerId: string, modelId: string) => boolean;
};

/** Resolve an explicitly selected independent model without borrowing Agent defaults. */
export async function resolveObserverGuardBinding(
  modeValue: unknown, settingsValue: unknown, deps: Dependencies,
): Promise<ObserverGuardRuntimeConfig> {
  const mode = resolveObserverGuardMode(modeValue);
  const settings = resolveObserverGuardSettings(settingsValue);
  const fail = (errorCode: ObserverGuardError): ObserverGuardRuntimeConfig => ({ mode, settings, errorCode });
  if (mode !== "guard") return { mode, settings };
  if (!settings.providerId || !settings.modelId) return fail("MODEL_NOT_CONFIGURED");
  const provider = deps.providers.find(row => row.id === settings.providerId && row.enabled !== false);
  if (!provider || provider.extensionAgentKey || deps.isImageModel(provider.id, settings.modelId)) return fail("MODEL_UNAVAILABLE");
  const stored: ModelBinding | undefined = provider.models?.find(row => row.id === settings.modelId);
  if (!stored && provider.defaultModelId !== settings.modelId) return fail("MODEL_UNAVAILABLE");
  try {
    const vendor = provider.authKind === OAUTH_AUTH_KIND
      ? await deps.vendorBinding(provider.id, settings.modelId) : undefined;
    if (provider.authKind === OAUTH_AUTH_KIND && !vendor) return fail("MODEL_UNAVAILABLE");
    const baseUrl = vendor?.baseUrl ?? provider.baseUrl;
    const apiStyle = vendor?.apiStyle ?? provider.apiStyle;
    const catalog = vendor?.modelConfig ?? deps.catalogModel({ ...provider, baseUrl, apiStyle }, settings.modelId);
    const modelConfig = { ...(stored ? modelConfigWithBinding(catalog, stored) : catalog), webSearch: false };
    const capabilities = capabilitiesFromModelConfig(modelConfig);
    if (!capabilities.supportedThinkingLevels.includes(settings.thinkingLevel)) return fail("EFFORT_UNAVAILABLE");
    const apiKey = provider.authKind === "none" || provider.authKind === OAUTH_AUTH_KIND
      ? "" : await deps.getSecret(provider.id);
    if (!apiKey && provider.authKind !== "none" && provider.authKind !== OAUTH_AUTH_KIND) return fail("PROVIDER_UNAVAILABLE");
    return {
      mode, settings,
      provider: {
        id: provider.id, name: provider.name, modelId: settings.modelId, apiKey: apiKey ?? "",
        ...(provider.vendorKey ? { vendorKey: provider.vendorKey } : {}),
        ...(baseUrl ? { baseUrl } : {}), ...(apiStyle ? { apiStyle } : {}),
        ...(provider.authKind ? { authKind: provider.authKind } : {}),
        ...optionalProviderHeaders(provider.headers),
        supportsReasoning: capabilities.supportsReasoning,
        supportedThinkingLevels: [...capabilities.supportedThinkingLevels],
        ...(modelConfig ? { modelConfig } : {}),
      },
    };
  } catch {
    // The optional observer must not fail the primary launch or expose credential/provider errors.
    return fail("PROVIDER_UNAVAILABLE");
  }
}
