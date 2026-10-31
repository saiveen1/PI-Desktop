import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

test("session launch sends Fast mode only for a model the user allowed it on (ADR 0334)", async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.fast-mode-launch-test-"));
  const priorHome = process.env.HOME;
  process.env.HOME = temp;
  try {
    const bundle = join(temp, "session-launch.mjs");
    await build({
      entryPoints: [join(root, "apps/desktop/electron/main/runtime/session-launch.ts")],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    const { createSessionLaunchRuntime } = await import(pathToFileURL(bundle).href);
    const provider = {
      id: "openai-provider",
      name: "OpenAI",
      authKind: "none",
      apiStyle: "responses",
      baseUrl: "http://127.0.0.1:11434/v1",
      enabled: true,
      defaultModelId: "allowed-model",
      models: [],
    };
    const allowed = new Set(["allowed-model"]);
    const host = {
      isAvailable: () => true,
      async call(method) {
        if (method === "commandShells.list") {
          const shell = { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true };
          return { configuredId: "bash", effective: shell, fallback: false, choices: [shell] };
        }
        if (method === "providers.list") return { providers: [provider] };
        if (method === "providers.getSecret") return { value: "" };
        if (method === "skills.disabledBuiltins") return { disabled: [] };
        if (method === "skills.active") return { skills: [] };
        if (method === "mcp.active") return { servers: [] };
        if (method === "agents.active") return { subagents: [] };
        if (method === "agents.disabledBuiltins") return { disabled: [] };
        throw new Error("Unexpected fixture Host method: " + method);
      },
    };
    const launchRuntime = createSessionLaunchRuntime({
      runtimeState: { host, sidecar: { setVendorAuthBindings() {} }, agentHostBridge: null },
      logger: { app() {} },
      userMcp: { setRecords() {}, async toolsForProject() { return []; } },
      plugins: { getTools: () => [], getSkills: () => [], listLoaded: () => [], getAgentExtensions: () => [] },
      sessionProjects: new Map(),
      dataDir: temp,
      vendorOAuth: { async bindingFor() { return undefined; } },
      modelsDevCatalog: { async ensureLoaded() {}, configureAccount() {}, findModel() { return undefined; } },
      getWorkspacePath: () => null,
      pluginActiveInProject: () => true,
      bindingForModel: (_provider, modelId) =>
        allowed.has(modelId) ? { id: modelId, fastModeAllowed: true } : { id: modelId },
      effectiveSubagentModelConfig: () => ({ modelConfig: undefined, capabilities: { supportedThinkingLevels: ["off"] } }),
      normalizeThinkingLevel: () => "off",
    });
    const launch = async (modelId, fastMode) => {
      const { sidecarParams } = await launchRuntime.resolveAgentRuntimeLaunch(
        "session-fixture",
        { providerId: provider.id, modelId, ...(fastMode === undefined ? {} : { fastMode }) },
        { defaultProviderId: provider.id, defaultModelId: modelId, defaultMode: "agent" },
      );
      return sidecarParams.fastMode;
    };

    assert.equal(await launch("allowed-model", true), true);
    assert.equal(await launch("allowed-model", false), false);
    assert.equal(await launch("allowed-model", undefined), false);
    assert.equal(await launch("other-model", true), false);
    provider.models = [{ id: "allowed-model", alias: "friendly", availableForSubagents: false },
      { id: "legacy-only", availableForSubagents: true }];
    const delegation = { version: 1, approvalTimeoutSeconds: 0, models: [
      { providerId: provider.id, modelId: "allowed-model", enabled: true, priority: 1, approval: "ask", description: "" },
      { providerId: provider.id, modelId: "legacy-only", enabled: false, priority: 2, approval: "auto", description: "" },
    ] };
    const unified = await launchRuntime.resolveAgentRuntimeLaunch("session-fixture", {
      providerId: provider.id, modelId: "allowed-model",
    }, { delegation });
    assert.equal(unified.sidecarParams.delegationAuthorization, true);
    assert.deepEqual(unified.sidecarParams.delegationSettings, delegation);
    assert.deepEqual(unified.sidecarParams.subagentModelKeys, [`${provider.id}/allowed-model`]);
    const legacy = await launchRuntime.resolveAgentRuntimeLaunch("session-fixture", {
      providerId: provider.id, modelId: "allowed-model",
    }, {});
    assert.equal(legacy.sidecarParams.delegationSettings, undefined);
    assert.deepEqual(legacy.sidecarParams.subagentModelKeys, ["OpenAI/legacy-only"]);
  } finally {
    process.env.HOME = priorHome;
    await rm(temp, { recursive: true, force: true });
  }
});
