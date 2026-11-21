export function resolveReleaseDocumentCheck(currentVersion, requestedVersion, stableVersions = []) {
  const beta = /^(\d+\.\d+)\.(\d+)-beta\.\d+$/.exec(currentVersion);
  // Find the compatible inherited baseline in the newest-first catalog. An
  // upstream merge can bring newer entries without changing the personal beta.
  const stableBaseline = requestedVersion === undefined && beta
    ? stableVersions.find(version => {
        const stable = /^(\d+\.\d+)\.(\d+)$/.exec(version);
        return stable && beta[1] === stable[1] && BigInt(stable[2]) <= BigInt(beta[2]);
      })
    : undefined;
  const documentVersion = requestedVersion ?? stableBaseline ?? currentVersion;
  const isPrereleasePreview =
    requestedVersion !== undefined &&
    currentVersion !== documentVersion &&
    currentVersion.startsWith(`${documentVersion}-`);

  return {
    documentVersion,
    surfaceVersion: stableBaseline || isPrereleasePreview ? currentVersion : documentVersion,
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
