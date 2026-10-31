import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";

function load(relative, imports = {}) {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `Unexpected dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}
const policy = load("../../../packages/shared/src/delegation-policy.ts");
const { createDelegationApprovalService } = load("../electron/main/services/delegation-approval.ts", {
  "@pi-desktop/shared": policy,
  "@pi-desktop/i18n": { catalogs, resolveLocale },
});
const request = { sessionId: "s", requestId: "r", providerId: "p", modelId: "m", task: "Review the diff" };
function fixture({ approval = "ask", timeout = 60, ui, legacy = false, language = "en" } = {}) {
  const state = { settings: legacy ? { language } : { language, globalPermissionMode: "auto", delegation: {
    version: 1, approvalTimeoutSeconds: timeout,
    models: [{ providerId: "p", modelId: "m", enabled: true, priority: 1, approval, description: "" }],
  } }, providers: [{ id: "p", enabled: true, authKind: "none", models: [{ id: "m" }] }] };
  const prompts = [];
  const host = { async call(method) {
    if (method === "settings.get") return state.settings;
    if (method === "providers.list") return { providers: state.providers };
    throw new Error(method);
  } };
  const service = createDelegationApprovalService({ getHost: () => host, requestUi: async (envelope) => {
    prompts.push(envelope);
    return envelope.request.kind === "cancel" ? { kind: "cancel" } : ui(envelope);
  } });
  return { state, prompts, service };
}
for (const [label, value, expected] of [
  ["approve once", "Allow once", "allow"], ["choose alternative", "Use another model", "skip"],
  ["explicit cancellation", "Cancel delegation", "cancel"],
]) test(`Auto permission mode still requires real host UI: ${label}`, async () => {
  const { service, prompts } = fixture({ ui: async () => ({ kind: "select", value }) });
  assert.equal((await service.authorize(request)).decision, expected);
  assert.equal(prompts[0].extensionId, "core.delegation-approval");
  assert.equal(prompts[0].requestId, request.requestId);
});

test("zero deadline skips ask without displaying a prompt; auto and absent policy remain allowed", async () => {
  for (const [options, expected] of [[{ timeout: 0 }, "skip"], [{ timeout: 0, approval: "auto" }, "allow"], [{ legacy: true }, "allow"]]) {
    const { service, prompts } = fixture(options);
    assert.equal((await service.authorize(request)).decision, expected);
    assert.ok(prompts.every((entry) => entry.request.kind === "cancel"));
  }
});

test("missing UI, dismissed prompts and removed provider fail closed", async () => {
  const missing = fixture({ ui: async () => { throw new Error("No window"); } });
  assert.equal((await missing.service.authorize(request)).decision, "skip");
  const dismissed = fixture({ ui: async () => ({ kind: "select", cancelled: true }) });
  assert.equal((await dismissed.service.authorize(request)).decision, "skip");
  const stale = fixture({ ui: async () => {
    stale.state.providers = [];
    return { kind: "select", value: "Allow once" };
  } });
  assert.equal((await stale.service.authorize(request)).decision, "skip");
});

test("pool membership is re-read after approval", async () => {
  const fixtureValue = fixture({ ui: async () => {
    fixtureValue.state.settings.delegation.models[0].enabled = false;
    return { kind: "select", value: "Allow once" };
  } });
  assert.equal((await fixtureValue.service.authorize(request)).decision, "skip");
});

test("exact cancellation settles immediately and a late allow cannot revive work", async () => {
  let reply;
  let dispatched;
  const shown = new Promise((resolve) => { dispatched = resolve; });
  const { service, prompts } = fixture({ ui: () => {
    dispatched();
    return new Promise((resolve) => { reply = resolve; });
  } });
  const result = service.authorize(request);
  await shown;
  service.cancel({ ...request, sessionId: "another-session" });
  assert.equal(prompts.filter((entry) => entry.request.kind === "cancel").length, 0);
  service.cancel(request);
  assert.equal((await result).decision, "cancel");
  reply({ kind: "select", value: "Allow once" });
  service.dispose();
  assert.equal((await service.authorize({ ...request, requestId: "after-dispose" })).decision, "skip");
});

test("deadline starts while the UI request is still queued", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let dispatched;
  const shown = new Promise((resolve) => { dispatched = resolve; });
  const { service, prompts } = fixture({ timeout: 2, ui: () => { dispatched(); return new Promise(() => {}); } });
  const result = service.authorize(request);
  await shown;
  context.mock.timers.tick(2000);
  assert.equal((await result).decision, "skip");
  assert.ok(prompts.some((entry) => entry.request.kind === "cancel" && entry.request.requestId === request.requestId));
});

test("approval shows localized options, task and selection reason from the real catalog", async () => {
  const { service, prompts } = fixture({ language: "zh-CN", ui: async (envelope) => ({ kind: "select", value: envelope.request.options[0] }) });
  assert.equal((await service.authorize({ ...request, reason: "A specialist is needed" })).decision, "allow");
  assert.deepEqual(prompts[0].request.options, ["仅允许本次", "改用其他模型", "取消本次委派"]);
  assert.ok(prompts[0].request.title.includes(request.task));
  assert.ok(prompts[0].request.title.includes("选择理由: A specialist is needed"));
  for (const catalog of Object.values(catalogs)) {
    for (const key of Object.keys(catalogs.en.delegationApproval)) assert.equal(typeof catalog.delegationApproval[key], "string");
  }
});
