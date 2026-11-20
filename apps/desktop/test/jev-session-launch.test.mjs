import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionLaunchRuntime } = await import("../electron/main/runtime/session-launch.ts");

test("session launch resolves Jev credentials only for opted-in Agent mode", async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "jev-launch-test-"));
  const priorHome = process.env.HOME;
  process.env.HOME = temp;
  try {
    // Load the actual launch entry through the Node TypeScript fixture hook.
    const provider = {
      id: "fixture-provider",
      name: "Fixture provider",
      authKind: "none",
      apiStyle: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
      enabled: true,
      defaultModelId: "fixture-model",
      models: [],
    };
    const keyReads = [];
    const logs = [];
    let failJevSecretRead = false;
    let disabledSkills = [];
    const host = {
      isAvailable: () => true,
      async call(method, input) {
        if (method === "commandShells.list") {
          const shell = {
            id: "bash",
            label: "Bash",
            dialect: "posix",
            available: true,
            isDefault: true,
          };
          return { configuredId: "bash", effective: shell, fallback: false, choices: [shell] };
        }
        if (method === "providers.list") return { providers: [provider] };
        if (method === "providers.getSecret") return { value: "" };
        if (method === "skills.disabledBuiltins") return { disabled: disabledSkills };
        if (method === "skills.active") return { skills: [] };
        if (method === "mcp.active") return { servers: [] };
        if (method === "agents.active") return { subagents: [] };
        if (method === "agents.disabledBuiltins") return { disabled: [] };
        if (method === "secrets.getForRuntime") {
          keyReads.push(input);
          if (failJevSecretRead) throw new Error("private fixture detail");
          return { value: "jev-launch-fixture-key" };
        }
        throw new Error("Unexpected fixture Host method: " + method);
      },
    };
    const dependencies = {
      runtimeState: {
        host,
        sidecar: { setVendorAuthBindings() {} },
        agentHostBridge: null,
      },
      logger: { app(...args) { logs.push(args); } },
      userMcp: { setRecords() {}, async toolsForProject() { return []; } },
      plugins: {
        getTools: () => [],
        getSkills: () => [],
        listLoaded: () => [],
        getAgentExtensions: () => [],
      },
      sessionProjects: new Map(),
      dataDir: temp,
      vendorOAuth: { async bindingFor() { return undefined; } },
      modelsDevCatalog: {
        async ensureLoaded() {},
        configureAccount() {},
        findModel() { return undefined; },
      },
      getWorkspacePath: () => null,
      pluginActiveInProject: () => true,
      bindingForModel: () => undefined,
      effectiveSubagentModelConfig: () => ({ modelConfig: undefined, capabilities: {} }),
      normalizeThinkingLevel: () => "off",
    };
    const launchRuntime = createSessionLaunchRuntime(dependencies);
    const launch = async (mode, jevEnabled, extra = {}) =>
      launchRuntime.resolveAgentRuntimeLaunch(
        "session-fixture",
        { providerId: provider.id, modelId: provider.defaultModelId },
        {
          defaultProviderId: provider.id,
          defaultModelId: provider.defaultModelId,
          defaultMode: mode,
          jevEnabled,
          ...extra,
        },
      );

    // Inline visualizations are opt-in: an absent setting withholds the
    // directory, so the prompt never points the model at a card this build
    // would not render. The catalog side is covered in visualize-skill.test.mjs
    // — this bundle cannot resolve the packaged skill files.
    const defaultOff = await launch("agent", false);
    assert.equal("visualizationsDir" in defaultOff.sidecarParams, false);
    assert.equal(defaultOff.sidecarParams.autoContinueUnfinishedTodos, true);
    const continuationOff = await launch("agent", false, { autoContinueUnfinishedTodos: false });
    assert.equal(continuationOff.sidecarParams.autoContinueUnfinishedTodos, false);
    const continuationOn = await launch("agent", false, { autoContinueUnfinishedTodos: true });
    assert.equal(continuationOn.sidecarParams.autoContinueUnfinishedTodos, true);
    const guards = await launch("agent", false, { agentOutputGuard: { earlyEndMode: "continue", recoveryLimit: 2, symbolMinChars: 6000 } });
    assert.equal(guards.sidecarParams.agentOutputGuard.earlyEndMode, "continue");
    assert.equal(guards.sidecarParams.agentOutputGuard.recoveryLimit, 2);
    assert.equal(guards.sidecarParams.agentOutputGuard.symbolMinChars, 6000);
    assert.equal(guards.sidecarParams.agentOutputGuard.repeatedParagraphsEnabled, true);
    const malformed = await launch("agent", false, { agentOutputGuard: { recoveryLimit: 99, repetitiveOutputEnabled: false } });
    assert.equal(malformed.sidecarParams.agentOutputGuard.recoveryLimit, 1);
    assert.equal(malformed.sidecarParams.agentOutputGuard.repetitiveOutputEnabled, false);
    assert.equal(defaultOff.sidecarParams.observerGuard.mode, "off");
    const observation = await launchRuntime.resolveAgentRuntimeLaunch("session-fixture",
      { providerId: provider.id, modelId: provider.defaultModelId, observerMode: "guard" },
      { defaultMode: "agent", observerGuard: { providerId: provider.id, modelId: provider.defaultModelId, thinkingLevel: "off", timeoutSeconds: 15 } });
    assert.equal(observation.sidecarParams.observerGuard.mode, "guard");
    assert.equal(observation.sidecarParams.observerGuard.provider.modelId, provider.defaultModelId);
    assert.equal(observation.sidecarParams.observerGuard.settings.timeoutSeconds, 15);
    const endless = await launchRuntime.resolveAgentRuntimeLaunch("session-fixture",
      { providerId: provider.id, modelId: provider.defaultModelId, observerMode: "endless" },
      { defaultMode: "agent", observerGuard: { maxContinuations: 4 } });
    assert.equal(endless.sidecarParams.observerGuard.mode, "endless");
    assert.equal(endless.sidecarParams.observerGuard.settings.maxContinuations, 4);
    assert.equal(endless.sidecarParams.observerGuard.provider, undefined);
    assert.equal(endless.sidecarParams.observerGuard.errorCode, undefined);
    const unconfigured = await launchRuntime.resolveAgentRuntimeLaunch("session-fixture",
      { providerId: provider.id, modelId: provider.defaultModelId, observerMode: "guard" }, { defaultMode: "agent" });
    assert.equal(unconfigured.sidecarParams.observerGuard.errorCode, "MODEL_NOT_CONFIGURED");
    assert.equal(unconfigured.sidecarParams.provider.modelId, provider.defaultModelId);
    const scheduled = await launchRuntime.resolveAgentRuntimeLaunch("session-fixture",
      { providerId: provider.id, modelId: provider.defaultModelId, observerMode: "guard", scheduledRun: true },
      { defaultMode: "agent", observerGuard: { providerId: provider.id, modelId: provider.defaultModelId } });
    assert.equal(scheduled.sidecarParams.observerGuard.mode, "off");
    assert.equal(scheduled.sidecarParams.observerGuard.provider, undefined);

    // The visualization directory follows the visualize skill (D671): a
    // disabled skill must not leave the prompt pointing at it.
    const withSkill = await launch("agent", false, { inlineVisualizations: true });
    assert.equal(
      withSkill.sidecarParams.visualizationsDir,
      join(temp, "visualizations", "session-fixture"),
    );
    disabledSkills = ["pi-desktop/visualize"];
    const withoutSkill = await launch("agent", false, { inlineVisualizations: true });
    assert.equal("visualizationsDir" in withoutSkill.sidecarParams, false);
    // The switch stays authoritative even when the skill is stored as enabled.
    const switchedOff = await launch("agent", false, { inlineVisualizations: false });
    assert.equal("visualizationsDir" in switchedOff.sidecarParams, false);
    disabledSkills = [];
    keyReads.length = 0;

    const enabledAgent = await launch("agent", true);
    assert.equal(enabledAgent.sidecarParams.jevApiKey, "jev-launch-fixture-key");
    assert.equal(enabledAgent.sidecarParams.provider.apiKey, "");
    assert.deepEqual(keyReads, [{ secretRef: "secret:app:typesafe-jev" }]);

    keyReads.length = 0;
    const disabledAgent = await launch("agent", false);
    assert.equal("jevApiKey" in disabledAgent.sidecarParams, false);
    assert.deepEqual(keyReads, []);

    const plan = await launch("plan", true);
    assert.equal("jevApiKey" in plan.sidecarParams, false);
    assert.deepEqual(keyReads, []);

    failJevSecretRead = true;
    const unavailable = await launch("agent", true);
    assert.equal("jevApiKey" in unavailable.sidecarParams, false);
    assert.equal(JSON.stringify(logs).includes("private fixture detail"), false);
    assert.deepEqual(logs, [[
      "session",
      "warn",
      "Jev API key could not be loaded",
      { sessionId: "session-fixture" },
    ]]);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    await rm(temp, { recursive: true, force: true });
  }
});
