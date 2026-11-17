export function resolveReleaseDocumentCheck(currentVersion, requestedVersion, latestStableVersion) {
  const beta = /^(\d+\.\d+)\.(\d+)-beta\.\d+$/.exec(currentVersion);
  const stable = /^(\d+\.\d+)\.(\d+)$/.exec(latestStableVersion ?? "");
  // Personal beta source checks retain the inherited catalog, not a fictitious release.
  const useStableCatalog = requestedVersion === undefined && beta !== null && stable !== null
    && beta[1] === stable[1] && BigInt(stable[2]) <= BigInt(beta[2]);
  const documentVersion = requestedVersion ?? (useStableCatalog ? latestStableVersion : currentVersion);
  const isPrereleasePreview =
    requestedVersion !== undefined &&
    currentVersion !== documentVersion &&
    currentVersion.startsWith(`${documentVersion}-`);

  return {
    documentVersion,
    surfaceVersion: useStableCatalog || isPrereleasePreview ? currentVersion : documentVersion,
    isPrereleasePreview,
  };
}

export function isModelsDevProviderCatalog(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).some(
        (provider) => provider && typeof provider === "object" && provider.models,
      ),
  );
}
