import { imageGenerationBindings, resolveObserverGuardSettings, type AppSettings, type ModelInfo, type ProviderPublic } from "@pi-desktop/shared";
import { composerModelDisplayName, composerModelsForProvider } from "./composer-models";

export function observerModels(settings: AppSettings | null | undefined, providers: readonly ProviderPublic[], catalog: Record<string, ModelInfo[]>) {
  const images = imageGenerationBindings(settings?.imageGenerationModels, settings?.imageGeneration);
  return providers.filter(provider => provider.enabled !== false && (provider.hasSecret || provider.hasOauth || provider.authKind === "none"))
    .flatMap(provider => composerModelsForProvider(provider, catalog[provider.id], images).map(model => {
      const advertised = provider.models?.find(binding => binding.id === model.modelId)?.thinkingLevels;
      return { providerId: provider.id, modelId: model.modelId,
        label: `${provider.name} / ${composerModelDisplayName(provider, model.modelId)}`,
        levels: advertised?.length ? advertised : model.supportedThinkingLevels?.length ? model.supportedThinkingLevels : ["off" as const],
      };
    }));
}

export function observerSelection(settings: AppSettings | null | undefined, providers: readonly ProviderPublic[], catalog: Record<string, ModelInfo[]>) {
  const value = resolveObserverGuardSettings(settings?.observerGuard);
  const models = observerModels(settings, providers, catalog);
  const selected = models.find(model => model.providerId === value.providerId && model.modelId === value.modelId);
  return { value, models, selected, available: Boolean(selected && selected.levels.includes(value.thinkingLevel)) };
}
