import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { resolveObserverGuardBinding } = await import("../electron/main/runtime/observer-guard-binding.ts");
const { createProviderCatalogRuntime } = await import("../electron/main/runtime/provider-catalog.ts");
const { OAUTH_AUTH_KIND } = await import("../electron/main/oauth.ts");
const catalog = { source: "models.dev", name: "Fixture", baseUrl: "http://model.invalid", reasoning: false, supportedThinkingLevels: ["off"], input: ["text"], contextWindow: 32000, maxTokens: 4096 };
const provider = { id: "reviewer", name: "Reviewer", defaultModelId: "small", enabled: true, authKind: "none", apiStyle: "chat_completions", baseUrl: "http://model.invalid" };
function fixture(overrides = {}) {
  const calls = [];
  return { calls, deps: { providers: [provider], getSecret: async id => { calls.push(["secret", id]); return "fixture-only"; }, vendorBinding: async (id, model) => { calls.push(["vendor", id, model]); return undefined; }, catalogModel: () => catalog, isImageModel: () => false, ...overrides } };
}
const selection = { providerId: "reviewer", modelId: "small", thinkingLevel: "off" };

test("off and missing selection do not resolve credentials or use a fallback", async () => {
  const f = fixture();
  for (const mode of [undefined, "off", "invalid"]) assert.equal((await resolveObserverGuardBinding(mode, selection, f.deps)).mode, "off");
  for (const settings of [{}, { modelId: "small" }, { providerId: "reviewer" }]) {
    assert.equal((await resolveObserverGuardBinding("guard", settings, f.deps)).errorCode, "MODEL_NOT_CONFIGURED");
  }
  assert.deepEqual(f.calls, []);
});

test("uses the exact ready independent binding and captures policy", async () => {
  const f = fixture();
  const result = await resolveObserverGuardBinding("observe", { ...selection, timeoutSeconds: 15, maxInputChars: 4000 }, f.deps);
  assert.equal(result.mode, "observe"); assert.equal(result.provider.id, "reviewer"); assert.equal(result.provider.modelId, "small");
  assert.equal(result.provider.apiKey, ""); assert.equal(result.settings.timeoutSeconds, 15);
  assert.equal(result.settings.maxInputChars, 4000); assert.deepEqual(f.calls, []);
});

test("unknown, disabled, image and extension bindings fail closed", async () => {
  for (const deps of [fixture({ providers: [] }).deps, fixture({ providers: [{ ...provider, enabled: false }] }).deps,
    fixture({ isImageModel: () => true }).deps, fixture({ providers: [{ ...provider, extensionAgentKey: "plugin" }] }).deps]) {
    assert.equal((await resolveObserverGuardBinding("guard", selection, deps)).errorCode, "MODEL_UNAVAILABLE");
  }
  assert.equal((await resolveObserverGuardBinding("guard", { ...selection, modelId: "typo" }, fixture().deps)).errorCode, "MODEL_UNAVAILABLE");
});

test("does not silently remap unsupported effort", async () => {
  const f = fixture();
  assert.equal((await resolveObserverGuardBinding("guard", { ...selection, thinkingLevel: "high" }, f.deps)).errorCode, "EFFORT_UNAVAILABLE");
  const thinking = fixture({ catalogModel: () => ({ ...catalog, reasoning: true, supportedThinkingLevels: ["low", "high"] }) });
  const result = await resolveObserverGuardBinding("guard", { ...selection, thinkingLevel: "low" }, thinking.deps);
  assert.equal(result.settings.thinkingLevel, "low"); assert.equal(result.provider.supportsReasoning, true);
});

test("respects saved capability overrides and resolves only the chosen secret", async () => {
  const f = fixture({ providers: [{ ...provider, authKind: "api-key", models: [{ id: "small", thinkingLevels: ["off", "high"], maxTokens: 4000 }] }] });
  const result = await resolveObserverGuardBinding("guard", { ...selection, thinkingLevel: "high" }, f.deps);
  assert.equal(result.provider.apiKey, "fixture-only"); assert.deepEqual(result.provider.supportedThinkingLevels, ["off", "high"]);
  assert.deepEqual(f.calls, [["secret", "reviewer"]]);
});

test("OAuth uses its own endpoint and catalog, never a saved API secret", async () => {
  const f = fixture({ providers: [{ ...provider, authKind: OAUTH_AUTH_KIND }], vendorBinding: async () => ({ baseUrl: "http://oauth.invalid", apiStyle: "responses", modelConfig: catalog }) });
  const result = await resolveObserverGuardBinding("observe", selection, f.deps);
  assert.equal(result.provider.baseUrl, "http://oauth.invalid"); assert.equal(result.provider.apiStyle, "responses");
  assert.equal(result.provider.authKind, OAUTH_AUTH_KIND); assert.deepEqual(f.calls, []);
  assert.equal((await resolveObserverGuardBinding("guard", selection, fixture({ providers: [{ ...provider, authKind: OAUTH_AUTH_KIND }] }).deps)).errorCode, "MODEL_UNAVAILABLE");
});

test("credential or catalog failure is bounded and never exposes upstream prose", async () => {
  const f = fixture({ providers: [{ ...provider, authKind: "api-key" }], getSecret: async () => { throw Error("private credential details"); } });
  const result = await resolveObserverGuardBinding("observe", selection, f.deps);
  assert.equal(result.errorCode, "PROVIDER_UNAVAILABLE"); assert.equal(result.provider, undefined);
  assert.equal(JSON.stringify(result).includes("private credential"), false);
});

test("main settings boundary rejects malformed writes but normalizes old values", () => {
  const runtime = createProviderCatalogRuntime({ getHost: () => null, modelsDevCatalog: {} });
  assert.equal(runtime.normalizeSettings({}).observerGuard.providerId, "");
  for (const bad of [null, [], { thinkingLevel: "invalid" }, { timeoutSeconds: 0 }, { includeToolOutput: "yes" }]) {
    assert.throws(() => runtime.validateSettingsWrite({ observerGuard: bad }), /observerGuard is invalid/);
  }
  assert.equal(runtime.validateSettingsWrite({ observerGuard: selection }).observerGuard.modelId, "small");
});

test("the independent assessment cannot inherit native web search", async () => {
  const f = fixture({ catalogModel: () => ({ ...catalog, webSearch: true }), providers: [{ ...provider, models: [{ id: "small", thinkingLevels: ["off"], nativeWebSearch: true }] }] });
  const result = await resolveObserverGuardBinding("guard", selection, f.deps);
  assert.equal(result.provider.modelConfig.webSearch, false);
});
