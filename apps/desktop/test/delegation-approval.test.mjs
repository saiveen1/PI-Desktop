import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";
const nativeRequire = createRequire(import.meta.url);
function load(relative, imports = {}) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    if (id.startsWith("node:")) return nativeRequire(id);
    if (id === "@pi-desktop/shared") return shared;
    assert.ok(Object.hasOwn(imports, id), `Unexpected dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}
const boundary = load("../../../packages/host-runtime/src/delegation-boundary.ts");
const catalog = load("../electron/main/services/delegation-catalog.ts", { "@pi-desktop/host-runtime": boundary });
const history = load("../electron/main/services/delegation-approval-history.ts");
const { createDelegationApprovalService } = load("../electron/main/services/delegation-approval.ts", {
  "@pi-desktop/host-runtime": boundary, "./delegation-catalog": catalog,
  "./delegation-approval-history": history,
});
const { registerDelegationApprovalIpc } = load("../electron/main/ipc/delegation-approval-ipc.ts");
const { refreshSavedDelegationPolicy } = load("../electron/main/services/delegation-policy-refresh.ts");
const { registerSettingsIpc } = load("../electron/main/ipc/settings-ipc.ts", {
  "../network-proxy": { currentSystemProxyRelayUrl: () => undefined },
});
const request = { sessionId: "s", requestId: "r", providerId: "p", modelId: "m", task: "Review the diff" };
const action = (row, type = "allow", extra = {}) => ({ sessionId: row.sessionId, requestId: row.requestId, revision: row.revision, action: type, ...extra });
const extension = row => ({ sessionId: row.sessionId, requestId: row.requestId, revision: row.revision });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const drain = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function fixture(context, { timeout = 60, approval = "ask", legacy = false } = {}) {
  const state = { settings: legacy ? {} : { globalPermissionMode: "auto", delegation: {
    version: 1, approvalTimeoutSeconds: timeout,
    models: ["m", "alternate"].map(modelId => ({ providerId: "p", modelId, enabled: true, priority: 1, approval, description: "" })),
  } }, providers: [{ id: "p", name: "My provider", enabled: true, authKind: "none", supportsVision: true,
    apiKey: "fixture-secret", baseUrl: "fixture-endpoint", headers: { Authorization: "fixture-auth" },
    models: [{ id: "m", alias: "Visible model", contextWindow: 8192, thinkingLevels: ["off", "high"] },
      { id: "alternate", contextWindow: 8192, thinkingLevels: ["off", "high"] }] }],
    session: { title: "Source chat", projectPath: "D:/workspace/source", projectTitle: "Source project" },
    barrier: undefined, receiptBarrier: undefined, receiptFailure: false, receipts: [], failed: false, sessionPools: new Map(), sessionApprovals: new Map() };
  const events = [], errors = [];
  let time = Date.parse("2026-11-05T12:00:00.000Z");
  const host = { async call(method, params) {
    if (method.startsWith("delegation.approvalHistory.")) {
      if (state.receiptFailure) throw new Error("Receipt write unavailable");
      if (method.endsWith("record")) { if (state.receiptBarrier) await state.receiptBarrier.promise; state.receipts.push(structuredClone(params)); }
      if (method.endsWith("list")) return { entries: structuredClone(state.receipts) };
      if (method.endsWith("clear")) state.receipts = [];
      if (method.endsWith("markRead")) for (const row of state.receipts) {
        if (!params.sessionId || (row.request.sessionId === params.sessionId && row.request.requestId === params.requestId)) row.readAt = "2026-11-05T12:00:02.000Z";
      }
      return { ok: true };
    }
    if (state.failed) throw new Error("fixture failure");
    if (state.barrier) await state.barrier.promise;
    if (method === "settings.get") return structuredClone(state.settings);
    if (method === "settings.set") { state.settings = { ...state.settings, ...structuredClone(params) }; return state.settings; }
    if (method === "providers.list") return { providers: structuredClone(state.providers) };
    if (method === "session.get") return { session: structuredClone(state.session) };
    if (method === "session.delegationPolicy") return { modelKeys: state.sessionPools.get(params.id) ?? null,
      modelApprovals: state.sessionApprovals.get(params.id) };
    if (method === "projects.list") return { projects: [{ path: state.session.projectPath, name: state.session.projectTitle }] };
    throw new Error(method);
  } };
  let owner = host;
  const service = createDelegationApprovalService({ getHost: () => owner,
    now: () => time, publish: event => events.push(event), onError: error => errors.push(error) });
  context.after(() => service.dispose());
  return { state, events, errors, service, host, loseHost: () => { owner = null; },
    tick: milliseconds => { time += milliseconds; context.mock.timers.tick(milliseconds); } };
}

test("conversation pools constrain approval alternatives and preserve empty versus inherited pools", async t => {
  const { state, service } = fixture(t);
  state.sessionPools.set("custom", ["p/m"]);
  state.sessionPools.set("disabled", []);
  const first = service.authorize({ ...request, sessionId: "custom" });
  await drain();
  const row = service.list().requests[0];
  assert.deepEqual(row.candidates.map(model => model.modelId), ["m"]);
  assert.equal((await service.respond(action(row, "select", { providerId: "p", modelId: "alternate" }))).accepted, false);
  await service.respond(action(row));
  assert.equal((await first).decision, "allow");
  assert.equal((await service.authorize({ ...request, sessionId: "disabled" })).decision, "skip");
  assert.deepEqual((await service.snapshot("disabled")).modelKeys, []);
  assert.equal((await service.snapshot("custom")).selectionMode, "task-fit");
  assert.deepEqual((await service.snapshot("inherited")).modelKeys, ["p/m", "p/alternate"]);
});

test("conversation approval overrides govern admission without changing global consent or eligibility", async t => {
  const { state, service } = fixture(t);
  state.sessionPools.set("custom", ["p/m"]);
  state.sessionApprovals.set("custom", { "p/m": "auto" });
  const snapshot = await service.snapshot("custom");
  assert.equal(snapshot.settings.models[0].approval, "auto");
  assert.equal((await service.authorize({ ...request, sessionId: "custom", automaticOnly: true })).decision, "allow");
  assert.equal((await service.snapshot("inherited")).settings.models[0].approval, "ask");
  assert.equal(state.settings.delegation.models[0].approval, "ask");
  state.sessionApprovals.set("custom", { "p/m": "ask" });
  const revised = await service.snapshot("custom");
  assert.notEqual(revised.revision, snapshot.revision);
  assert.equal((await service.authorize({ ...request, sessionId: "custom", automaticOnly: true })).decision, "skip");
  state.sessionApprovals.set("custom", { "p/m": "auto" });
  state.settings.delegation.models[0].enabled = false;
  assert.deepEqual((await service.snapshot("custom")).modelKeys, []);
  assert.equal((await service.authorize({ ...request, sessionId: "custom", automaticOnly: true })).decision, "skip");
});

test("a session may require consent for a globally automatic model", async t => {
  const { state, service } = fixture(t, { approval: "auto" });
  state.sessionPools.set("custom", ["p/m"]);
  state.sessionApprovals.set("custom", { "p/m": "ask" });
  const done = service.authorize({ ...request, sessionId: "custom" });
  await drain();
  const [row] = service.list().requests;
  assert.ok(row, "the session override must prompt before admission");
  assert.equal(row.candidate.approval, "ask");
  await service.respond(action(row));
  assert.equal((await done).decision, "allow");
});

test("concurrent same-session requests list immediately and user batch acts on the selected subset", async t => {
  const { service, events } = fixture(t);
  const decisions = ["a", "b", "c"].map(requestId => service.authorize({ ...request, requestId }));
  await drain();
  assert.equal(service.list().requests.length, 3);
  assert.deepEqual(events.map(event => event.request.requestId), ["a", "b", "c"]);
  const before = service.list();
  for (const row of before.requests.filter(row => row.requestId !== "b")) assert.equal((await service.respond(action(row))).accepted, true);
  assert.equal((await decisions[0]).decision, "allow");
  assert.equal((await decisions[2]).decision, "allow");
  assert.deepEqual(service.list().requests.map(row => row.requestId), ["b"]);
  assert.equal(before.requests[0].status, "pending", "older list is immutable for event/list race reconciliation");
  assert.ok(events.at(-1).request.revision > before.requests[2].revision);
  service.cancel({ ...request, requestId: "b" });
  assert.equal((await decisions[1]).code, "cancelled");
});

test("full task and runtime metadata use host-resolved source/model labels without credentials", async t => {
  const { service, events } = fixture(t);
  const full = { ...request, task: "A".repeat(12000), reason: "R".repeat(3000), agentName: "reviewer",
    description: "Review role", requestedModel: "original selector", thinkingLevel: "high", requiresImages: true, minContextWindow: 4096 };
  const done = service.authorize(full);
  await drain();
  const [row] = service.list().requests;
  assert.equal(shared.isDelegationApprovalPrompt(row), true);
  assert.equal(row.task, full.task); assert.equal(row.modelReason, full.reason);
  assert.equal(row.agentName, "reviewer"); assert.equal(row.description, "Review role");
  assert.equal(row.requestedModel, "original selector");
  assert.equal(row.sessionTitle, "Source chat"); assert.equal(row.projectTitle, "Source project");
  assert.equal(row.projectPath, "D:/workspace/source");
  assert.equal(row.candidate.providerName, "My provider"); assert.equal(row.candidate.modelLabel, "Visible model");
  assert.equal(row.candidate.thinkingLevel, "high");
  for (const secret of ["fixture-secret", "fixture-endpoint", "fixture-auth", "apiKey", "baseUrl", "headers"]) {
    assert.equal(JSON.stringify(events).includes(secret), false);
  }
  await service.respond(action(row)); assert.equal((await done).decision, "allow");
});

test("select returns exactly one chosen alternative and never changes subsequent invocations", async t => {
  const { service } = fixture(t);
  const done = service.authorize(request); await drain();
  const [row] = service.list().requests;
  assert.equal((await service.respond(action(row, "select", { providerId: "p", modelId: "absent" }))).code, "invalid");
  assert.equal((await service.respond(action(row, "select", { providerId: "p", modelId: "alternate" }))).accepted, true);
  assert.deepEqual((await done).selectedModel, { providerId: "p", modelId: "alternate" });
  assert.equal((await service.respond(action(row))).accepted, false);
  const next = service.authorize({ ...request, requestId: "next" }); await drain();
  assert.equal(service.list().requests[0].candidate.modelId, "m");
  service.cancel({ ...request, requestId: "next" }); await next;
});

test("required exact candidate refuses selection replacement", async t => {
  const { service } = fixture(t);
  const done = service.authorize({ ...request, selection: "require" }); await drain();
  const [row] = service.list().requests;
  assert.deepEqual(row.candidates.map(model => model.modelId), ["m"]);
  assert.equal((await service.respond(action(row, "select", { providerId: "p", modelId: "alternate" }))).code, "invalid");
  await service.respond(action(row, "cancel")); assert.equal((await done).decision, "cancel");
});

for (const mode of ["auto", "zero", "automaticOnly", "legacy", "empty"]) test(`admission without prompt: ${mode}`, async t => {
  const { service, state, events } = fixture(t, { approval: mode === "auto" ? "auto" : "ask", timeout: mode === "zero" ? 0 : 60, legacy: mode === "legacy" });
  if (mode === "empty") state.settings.delegation.models = [];
  const result = await service.authorize({ ...request, ...(mode === "automaticOnly" ? { automaticOnly: true } : {}) });
  assert.equal(result.decision, ["auto", "legacy"].includes(mode) ? "allow" : "skip");
  assert.equal(events.length, 0); assert.deepEqual(service.list(), { requests: [] });
});

test("policy refresh revises pending consent without resetting deadlines; disabled candidate retires", async t => {
  const { service, state, events } = fixture(t);
  const done = service.authorize(request); await drain(); const [old] = service.list().requests;
  state.settings.delegation.models[0].priority = 2;
  state.settings.delegation.approvalTimeoutSeconds = 300;
  await service.refresh(); const [current] = service.list().requests;
  assert.ok(current.revision > old.revision); assert.equal(current.expiresAt, old.expiresAt);
  assert.equal((await service.respond(action(old))).code, "stale");
  state.settings.delegation.models[0].enabled = false; await service.refresh();
  assert.equal((await done).decision, "skip"); assert.equal(events.at(-1).request.status, "invalidated");
  assert.deepEqual(service.list().requests, []);
});

test("actual saved ask-to-auto policy may proceed and changed alternative requires new consent", async t => {
  const f = fixture(t); const done = f.service.authorize(request); await drain();
  const [old] = f.service.list().requests;
  f.state.providers[0].models[1].alias = "New label";
  assert.equal((await f.service.respond(action(old, "select", { providerId: "p", modelId: "alternate" }))).code, "stale");
  f.state.settings.delegation.models[0].approval = "auto"; await f.service.refresh();
  assert.equal((await done).decision, "allow"); assert.equal(f.service.list().requests.length, 0);
});

test("latest availability and compatibility are checked before allow and alternative select", async t => {
  for (const mutate of [f => { f.state.providers = []; }, f => { f.state.providers[0].supportsVision = false; },
    f => { f.state.providers[0].models[1].contextWindow = 100; }]) {
    const f = fixture(t); const done = f.service.authorize({ ...request, requiresImages: true, minContextWindow: 4096 }); await drain();
    const [row] = f.service.list().requests; mutate(f);
    assert.equal((await f.service.respond(action(row, "select", { providerId: "p", modelId: "alternate" }))).accepted, false);
    f.service.dispose(); assert.notEqual((await done).decision, "allow");
  }
});

test("fixed extension retires the old timer, changes consent revision and expires once", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, { timeout: 2 }); const done = f.service.authorize(request); await drain();
  const [row] = f.service.list().requests; f.tick(1000);
  const extended = await f.service.extend(extension(row)); assert.equal(extended.accepted, true);
  assert.equal(Date.parse(extended.request.expiresAt) - Date.parse(row.expiresAt), 300000);
  assert.equal((await f.service.extend(extension(row))).code, "stale");
  assert.equal((await f.service.respond(action(row))).code, "stale");
  f.tick(1000); assert.equal(f.service.list().requests.length, 1);
  f.tick(300000); assert.equal((await done).code, "timeout");
  assert.equal(f.events.filter(event => event.request.status === "expired").length, 1);
  assert.equal((await f.service.extend(extension(extended.request))).accepted, false);
});

for (const interruption of ["cancel", "dispose", "expire", "extend"]) test(`late approval cannot cross ${interruption} during await`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, { timeout: 2 }); const done = f.service.authorize(request); await drain();
  const [row] = f.service.list().requests;
  const barrier = deferred(); f.state.barrier = barrier;
  const approval = f.service.respond(action(row));
  let pendingExtension;
  if (interruption === "cancel") f.service.cancel(request);
  if (interruption === "dispose") f.service.dispose();
  if (interruption === "expire") f.tick(2000);
  if (interruption === "extend") pendingExtension = f.service.extend(extension(row));
  barrier.resolve(); f.state.barrier = undefined;
  if (pendingExtension) await pendingExtension;
  assert.equal((await approval).accepted, false);
  if (interruption === "extend") f.service.cancel(request);
  assert.notEqual((await done).decision, "allow");
});

test("skip differs from cancel; malformed/batch/spoofed actions cannot grant", async t => {
  const f = fixture(t); const done = f.service.authorize(request); await drain(); const [row] = f.service.list().requests;
  for (const invalid of [[action(row)], { ...action(row), extensionId: "core.delegation-approval" },
    { ...action(row), action: "approve-all" }, { ...extension(row), action: "select" }]) {
    assert.equal((await f.service.respond(invalid)).code, "invalid");
  }
  assert.equal((await f.service.extend({ ...extension(row), seconds: 300 })).code, "invalid");
  assert.equal((await f.service.respond(action({ ...row, sessionId: "other" }))).code, "not-found");
  await f.service.respond(action(row, "skip")); assert.equal((await done).code, "skipped");
});

test("transient revalidation failure stays visible and can be retried", async t => {
  const f = fixture(t); const done = f.service.authorize(request); await drain();
  const [row] = f.service.list().requests;
  assert.deepEqual(f.service.list().requests, [row]);
  f.state.failed = true;
  const result = await f.service.respond(action(row));
  assert.equal(result.code, "unavailable"); assert.ok(result.error); assert.ok(f.errors.length);
  assert.deepEqual(f.service.list().requests, [row], "a transient Host failure must not retire pending consent");
  f.state.failed = false;
  assert.equal((await f.service.respond(action(row))).accepted, true);
  assert.equal((await done).decision, "allow");
});

test("policy snapshot is current, credential-free, and distinguishes empty adopted policy from legacy", async t => {
  const f = fixture(t); const first = await f.service.snapshot();
  assert.deepEqual(first.modelKeys, ["p/m", "p/alternate"]);
  f.state.settings.delegation.models = [];
  const empty = await f.service.snapshot(); assert.ok(empty.settings); assert.deepEqual(empty.modelKeys, []);
  assert.notEqual(empty.revision, first.revision);
  delete f.state.settings.delegation;
  assert.equal((await f.service.snapshot()).settings, undefined);
  assert.equal(JSON.stringify(first).includes("fixture-secret"), false);
});

test("dedicated IPC permits only main-window single-item actions and list has no generic queue", async t => {
  const f = fixture(t), handlers = new Map();
  registerDelegationApprovalIpc({ approvals: f.service, registrar: {
    handleWithEvent: (channel, handler) => handlers.set(channel, handler),
    assertMainWindowSender(event) { if (event.sender !== "main") throw new Error("PERMISSION_DENIED"); },
  } });
  const main = { sender: "main" };
  const done = f.service.authorize(request); await drain();
  const listed = await handlers.get(shared.IPC.invoke.delegationApprovalList)(main);
  assert.equal(listed.requests.length, 1);
  await assert.rejects(handlers.get(shared.IPC.invoke.delegationApprovalList)({ sender: "plugin" }), /PERMISSION_DENIED/);
  await assert.rejects(handlers.get(shared.IPC.invoke.delegationApprovalList)(main, {}), /no arguments/);
  assert.equal((await handlers.get(shared.IPC.invoke.delegationApprovalRespond)(main, [action(listed.requests[0])])).code, "invalid");
  assert.equal((await handlers.get(shared.IPC.invoke.delegationApprovalRespond)(main, action(listed.requests[0]))).accepted, true);
  assert.equal((await done).decision, "allow");
});

test("save refresh starts registry invalidation and sends exact advisory runtime method; failure is logged", async () => {
  const order = [], logs = [];
  await refreshSavedDelegationPolicy({ approvals: { refresh: async () => { order.push("pending"); } },
    getSidecar: () => ({ async call(method, params) { order.push([method, params]); throw new Error("unsupported"); } }),
    log: message => logs.push(message) });
  assert.deepEqual(order, ["pending", ["agent.refreshDelegationPolicy", {}]]); assert.equal(logs.length, 1);
});

test("a manual extension cannot override an in-flight saved-policy invalidation", async t => {
  const f = fixture(t); const done = f.service.authorize(request); await drain();
  const [row] = f.service.list().requests;
  const barrier = deferred(); f.state.barrier = barrier;
  f.state.settings.delegation.models[0].enabled = false;
  const refresh = f.service.refresh();
  const extending = f.service.extend(extension(row));
  barrier.resolve(); f.state.barrier = undefined;
  const extensionResult = await extending;
  assert.notEqual(extensionResult.accepted, true);
  await refresh;
  assert.equal(f.service.list().requests.length, 0);
  assert.equal((await done).code, "invalidated");
});

test("manual extension revalidates that the candidate is still enabled", async t => {
  const f = fixture(t); const done = f.service.authorize(request); await drain();
  const [row] = f.service.list().requests;
  f.state.settings.delegation.models[0].enabled = false;
  const result = await f.service.extend(extension(row));
  assert.notEqual(result.accepted, true);
  assert.equal(f.service.list().requests.length, 0);
  assert.equal((await done).code, "invalidated");
});

test("policy revisions never reuse a retired value when the user restores older settings", async t => {
  const f = fixture(t);
  const first = await f.service.snapshot();
  assert.equal((await f.service.snapshot()).revision, first.revision);
  f.state.settings.delegation.models[0].priority = 2;
  const edited = await f.service.snapshot();
  f.state.settings.delegation.models[0].priority = 1;
  const restored = await f.service.snapshot();
  assert.deepEqual(restored.settings, first.settings);
  assert.equal(new Set([first.revision, edited.revision, restored.revision]).size, 3);
});

test("saved settings flow refreshes a live approval through the real settings IPC handler", async t => {
  const f = fixture(t), handlers = new Map(), pushed = [];
  const noOp = () => {};
  registerSettingsIpc({ registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => f.host, getSidecar: () => null, dataDir: "fixture-only", normalizeSettings: value => value,
    validateSettingsWrite: value => value, testNetworkProxy: noOp, applyNetworkProxyFromAppSettings: noOp,
    currentNetworkProxy: noOp, applyApplicationMenuSettings: noOp, applyDeveloperMode: noOp,
    applyPreventScreenSleep: noOp, applyKeepAwakeWhileRunning: noOp, applyUpdatePreference: noOp,
    resolveEffectiveCommandShell: noOp,
    delegationSettingsWritten: () => refreshSavedDelegationPolicy({ approvals: f.service,
      getSidecar: () => ({ async call(method, params) { pushed.push([method, params]); return {}; } }), log: noOp }),
  });
  const done = f.service.authorize(request); await drain();
  assert.equal(f.service.list().requests.length, 1);
  const saved = structuredClone(f.state.settings.delegation); saved.models[0].approval = "auto";
  await handlers.get(shared.IPC.invoke.settingsSet)({ delegation: saved });
  assert.equal((await done).decision, "allow");
  assert.equal(f.service.list().requests.length, 0);
  assert.deepEqual(pushed, [["agent.refreshDelegationPolicy", {}]]);
});

test("terminal publish/list race waits for queued durable receipt; reload/read/clear never grant consent", async t => {
  const f = fixture(t);
  const done = f.service.authorize(request); await drain();
  const row = f.service.list().requests[0];
  f.state.receiptBarrier = deferred();
  await f.service.respond(action(row));
  assert.equal((await done).decision, "allow");
  assert.equal(f.events.at(-1).request.status, "approved");
  let listed = false;
  const listing = f.service.listHistory().then(value => { listed = true; return value; });
  await drain(); assert.equal(listed, false);
  f.state.receiptBarrier.resolve();
  const saved = await listing; assert.equal(saved.entries.length, 1);
  const reload = createDelegationApprovalService({ getHost: () => f.host, publish() {}, onError() {} });
  t.after(() => reload.dispose());
  assert.deepEqual(await reload.listHistory(), saved);
  const next = f.service.authorize({ ...request, requestId: "still-pending" }); await drain();
  await f.service.markHistoryRead({});
  assert.ok((await f.service.listHistory()).entries[0].readAt);
  await f.service.clearHistory();
  assert.deepEqual(await f.service.listHistory(), { entries: [] });
  assert.equal(f.service.list().requests.length, 1);
  assert.equal(f.state.settings.delegation.models[0].approval, "ask");
  assert.equal((await f.service.respond(action(row))).code, "not-found");
  f.service.cancel({ ...request, requestId: "still-pending" }); await next;
});

test("receipt persistence failure is observable and cannot authorize or replay a request", async t => {
  const f = fixture(t); const done = f.service.authorize(request); await drain();
  f.state.receiptFailure = true;
  await f.service.respond(action(f.service.list().requests[0], "cancel"));
  assert.equal((await done).decision, "cancel");
  await assert.rejects(f.service.listHistory(), /persistence failed/);
  assert.ok(f.errors.some(error => error.includes("receipt persistence failed")));
  assert.deepEqual(f.service.list(), { requests: [] });
});
