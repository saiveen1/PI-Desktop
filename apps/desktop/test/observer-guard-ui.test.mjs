import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { observerSelection, observerModelLabel } = await import("../src/lib/observer-guard-models.ts");
const observerPresentation = await import("../src/lib/observer-guard-presentation.ts");
const observerSession = await import("../src/lib/observer-guard-session.ts");
const { resolveObserverEvidenceMessageId } = await import("../src/lib/observer-guard-evidence-navigation.ts");
const { SETTINGS_NAV } = await import("../src/lib/settings-search.ts");
const { catalogs } = await import("../../../packages/i18n/src/index.ts");
const provider = { id: "p", name: "Provider", enabled: true, authKind: "none", hasSecret: false, models: [{ id: "m", thinkingLevels: ["off", "high"] }] };
const base = { defaultMode: "agent", theme: "light", enterToSend: true };
const settings = { ...base, observerGuard: { providerId: "p", modelId: "m", thinkingLevel: "high" } };
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
const primitive = name => Object.assign(() => null, { displayName: name });
const components = Object.fromEntries(["SettingsCard", "SettingsRow", "Input", "Field", "Textarea", "SettingsToggle", "SettingsMenuSelect", "SettingsDisclosure", "Button", "TooltipButton", "AnchoredMenu", "IconCheck", "IconEye"].map(name => [name, primitive(name)]));
const t = key => key;
function load(path, extra) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function("require", "exports", "module", code)(id => {
    if (id === "react") return { useState: value => [value, () => {}], useRef: value => ({ current: value }), useEffect() {}, ...extra.react };
    if (id === "react/jsx-runtime") return jsx;
    if (id === "react-i18next") return { useTranslation: () => ({ t: extra.translate ?? t }) };
    if (id === "@pi-desktop/shared") return shared;
    if (id.includes("observer-guard-models")) return { observerSelection, observerModelLabel };
    if (id.includes("observer-guard-presentation")) return observerPresentation;
    if (id.includes("observer-guard-evidence-navigation")) return { resolveObserverEvidenceMessageId: (sessionId, id) => resolveObserverEvidenceMessageId(sessionId, id, extra.readObserverEvidence ?? (async (sessionId, options) => ({ session: { id: sessionId, messages: [{ id: options.messageAround }] } }))) };
    if (id.includes("disclosure-anchor-context")) return { useDisclosureAnchorNotifier: () => undefined };
    if (id.includes("observer-guard-session")) return observerSession;
    if (id.includes("app-store")) return extra;
    if (id.includes("primitives") || id.includes("/ui") || id.includes("SettingsMenuSelect") || id.includes("SettingsDisclosure") || id.includes("AnchoredMenu") || id.includes("icons")) return components;
    throw Error(id);
  }, module.exports, module);
  return module.exports;
}
const makeStore = state => Object.assign(fn => fn({ agentStatuses: {}, providers: [], ...state }), { getState: () => state });
function nodes(tree) { return tree && typeof tree === "object" ? [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)] : []; }
const rendered = tree => JSON.stringify(tree);
const session = id => ({ id, mode: "agent", source: "desktop" });

test("model and effort availability retain stale selections without remapping", () => {
  assert.equal(observerSelection(settings, [provider], {}).available, true);
  assert.equal(observerSelection({ ...settings, observerGuard: { ...settings.observerGuard, thinkingLevel: "low" } }, [provider], {}).available, false);
  assert.equal(observerSelection(settings, [{ ...provider, enabled: false }], {}).selected, undefined);
  assert.equal(observerSelection(settings, [{ ...provider, authKind: "oauth", hasOauth: true }], {}).available, true);
});

test("picker uses off for legacy Observe and requires the exact model only for Guard", () => {
  const calls = [];
  const state = { sessions: [{ ...session("a"), observerMode: "observe" }, { ...session("b"), observerMode: "guard" }], activeSessionId: "a", runningSessions: {}, pendingPlans: {}, settings, providers: [provider], providerModels: {}, configureActiveSession: async (...args) => { calls.push(args); }, showToast() {}, setSettingsTab() {} };
  const { ObserverGuardPicker } = load("../src/features/sessions/ObserverGuardPicker.tsx", { useAppStore: makeStore(state) });
  const options = id => ObserverGuardPicker({ sessionId: id }).props.children[0];
  assert.deepEqual(options("a").map(choice => choice.props.children[0].props.children), ["observerGuard.off", "observerGuard.endless", "observerGuard.guard"]);
  assert.equal(options("a")[0].props["aria-checked"], true);
  assert.equal(options("b")[2].props["aria-checked"], true);
  assert.equal(options("b")[2].props.disabled, false);
  state.settings = { ...settings, observerGuard: { ...settings.observerGuard, modelId: "missing" } };
  assert.equal(options("b")[2].props.disabled, true, "does not substitute an available model");
  state.settings = base;
  state.providers = [];
  assert.equal(options("b")[1].props.disabled, false);
  assert.equal(options("b")[2].props.disabled, true);
  options("b")[2].props.onClick();
  assert.equal(calls.length, 0);
  options("b")[1].props.onClick();
  assert.equal(calls[0][1], "b"); assert.equal(calls[0][0].observerMode, "endless");
  state.sessions[1].observerMode = "endless";
  const endless = ObserverGuardPicker({ sessionId: "b" });
  assert.match(endless.props.trigger(null).props.ariaLabel, /observerGuard.ready/);
  assert.doesNotMatch(rendered(endless), /observerGuard.configuredModel/);
  options("b")[0].props.onClick(); assert.equal(calls.at(-1)[0].observerMode, "off");
  state.runningSessions.b = true; assert.equal(ObserverGuardPicker({ sessionId: "b" }).props.trigger(null).props.disabled, false);
  state.runningSessions.b = false; state.sessions[1].source = "remote"; assert.equal(ObserverGuardPicker({ sessionId: "b" }), null);
  state.sessions[1].source = "native"; assert.equal(ObserverGuardPicker({ sessionId: "b" }), null);
  state.sessions[1].source = "desktop"; state.sessions[1].scheduledRun = true;
  assert.equal(ObserverGuardPicker({ sessionId: "b" }), null);
  assert.equal(ObserverGuardPicker({}).props.trigger(null).props.disabled, true);
});

test("settings model and effort controls use explicit selection and preserve stale effort", () => {
  const writes = [];
  const state = { providers: [provider], providerModels: {} };
  const { ObserverGuardSettings } = load("../src/components/settings/ObserverGuardSettings.tsx", { useAppStore: makeStore(state) });
  const tree = ObserverGuardSettings({ settings: { ...settings, observerGuard: { ...settings.observerGuard, thinkingLevel: "low" } }, saveSettings: async patch => writes.push(patch) });
  const [, modelRow, effortRow] = tree.props.children;
  const model = modelRow.props.children; const effort = effortRow.props.children;
  assert.match(effort.props.options.find(row => row.id === "low").label, /unavailable/);
  effort.props.onChange("high"); assert.deepEqual(writes[0], { observerGuard: { thinkingLevel: "high" } });
  model.props.onChange(""); assert.deepEqual(writes[1], { observerGuard: { providerId: "", modelId: "" } });
});

test("settings use the shared bounds and save the prompt only on explicit action", async () => {
  const writes = [];
  const state = { providers: [], providerModels: {} };
  let hookState = [], cursor = 0, rejectSave = false;
  const react = {
    useState(value) {
      const index = cursor++;
      if (!(index in hookState)) hookState[index] = value;
      return [hookState[index], next => { hookState[index] = next; }];
    },
  };
  const { ObserverGuardSettings } = load("../src/components/settings/ObserverGuardSettings.tsx", { useAppStore: makeStore(state), react });
  const saveSettings = async patch => { writes.push(patch); if (rejectSave) throw new Error("save failed"); };
  const render = settings => ObserverGuardSettings({ settings, saveSettings });
  const [limit, , , prompt, , advanced] = render(settings).props.children;
  assert.equal(limit.props.name, "maxContinuations");
  assert.equal(limit.props.value, 3);
  assert.deepEqual(advanced.props.children.map(node => node.props.name), ["timeoutSeconds", "maxInputChars"]);
  const run = node => { cursor = 0; return node.type(node.props); };
  const number = () => run(limit).props.children.props;
  assert.deepEqual([number().min, number().max], [1, 100]);
  number().onChange({ target: { value: "101" } });
  number().onBlur();
  assert.equal(number()["aria-invalid"], true);
  assert.deepEqual(writes, []);
  number().onChange({ target: { value: "100" } });
  number().onBlur();
  assert.deepEqual(writes.pop(), { observerGuard: { maxContinuations: 100 } });

  hookState = [];
  const saved = render({ ...settings, observerGuard: { prompt: "previous" } }).props.children[3];
  assert.equal(prompt.props.value, shared.DEFAULT_OBSERVER_GUARD_PROMPT);
  const textarea = () => nodes(run(saved)).find(node => node.type === components.Textarea).props;
  const button = label => nodes(run(saved)).find(node => node.type === components.Button && node.props.children === label).props;
  assert.equal(textarea().value, "previous");
  textarea().onChange({ target: { value: "x".repeat(shared.OBSERVER_GUARD_PROMPT_MAX_CHARS + 1) } });
  assert.equal(textarea()["aria-invalid"], true);
  assert.equal(button("common.save").disabled, true);
  button("common.save").onClick();
  assert.deepEqual(writes, []);
  textarea().onChange({ target: { value: "custom" } });
  assert.deepEqual(writes, [], "typing never saves settings");
  rejectSave = true;
  button("common.save").onClick();
  assert.equal(textarea().disabled, true);
  await Promise.resolve();
  assert.deepEqual(writes.pop(), { observerGuard: { prompt: "custom" } });
  assert.equal(textarea().value, "custom");
  assert.ok(nodes(run(saved)).some(node => node.props?.role === "alert"));
  rejectSave = false;
  button("common.save").onClick();
  await Promise.resolve();
  assert.deepEqual(writes.pop(), { observerGuard: { prompt: "custom" } });
  button("observerGuard.resetPrompt").onClick();
  await Promise.resolve();
  assert.deepEqual(writes.pop(), { observerGuard: { prompt: "" } });
});

test("transient recovery defaults off and saves only its setting", () => {
  const writes = [];
  const state = { providers: [], providerModels: {} };
  const { ObserverGuardSettings } = load("../src/components/settings/ObserverGuardSettings.tsx", { useAppStore: makeStore(state) });
  const render = observerGuard => ObserverGuardSettings({ settings: { ...base, observerGuard }, saveSettings: async patch => writes.push(patch) });
  const toggle = tree => nodes(tree).find(node => node.type === components.SettingsToggle).props;
  assert.equal(toggle(render({})).checked, false);
  toggle(render({ providerId: "p", modelId: "m", maxContinuations: 4 })).onChange();
  assert.deepEqual(writes, [{ observerGuard: { continueOnTransientError: true } }]);
  assert.equal(toggle(render({ continueOnTransientError: true })).checked, true);
});

test("disclosure matches message IDs, shows live and renders model prose only as text", () => {
  const live = { messageId: "m1", mode: "observe", status: "checking", startedAt: 0 };
  const state = { agentStatuses: { b: { isRunning: true, currentTurnId: "turn", runDiagnostics: { observer: live } } } };
  const { ObserverGuardDisclosure, matchingObserver } = load("../src/features/chat/transcript/ObserverGuardDisclosure.tsx", { useAppStore: makeStore(state) });
  assert.equal(ObserverGuardDisclosure({ sessionId: "b", message: { id: "m2" } }), null);
  assert.equal(matchingObserver({ id: "m1" }, live), live);
  assert.ok(rendered(ObserverGuardDisclosure({ sessionId: "b", message: { id: "m1" } })).includes("observerGuard.status.checking"));
  const restored = { id: "m1", runDiagnostics: { turnId: "old", observer: live } };
  assert.ok(rendered(ObserverGuardDisclosure({ message: restored })).includes("observerGuard.interrupted"));
  state.agentStatuses.b = { isRunning: true, currentTurnId: "new", runDiagnostics: {} };
  assert.ok(rendered(ObserverGuardDisclosure({ sessionId: "b", message: restored })).includes("observerGuard.interrupted"));
  assert.equal(restored.runDiagnostics.observer.status, "checking", "presentation does not rewrite persisted evidence");
  const reason = "<img src=x onerror=alert(1)>";
  const persisted = { ...live, status: "assessed", verdict: "unknown", reason };
  const tree = ObserverGuardDisclosure({ message: { id: "m1", runDiagnostics: { observer: persisted } } });
  const failed = ObserverGuardDisclosure({ message: { id: "m1", runDiagnostics: { observer: { ...live, status: "error", errorCode: "TIMEOUT" } } } });
  assert.ok(rendered(failed).includes("observerGuard.status.error"));
  assert.ok(JSON.stringify(failed).includes("observerGuard.errors.TIMEOUT"));
  assert.ok(JSON.stringify(tree).includes("observerGuard.verdicts.unknown"));
  const row = nodes(tree).find(item => item?.props?.children === reason);
  assert.ok(row); assert.equal(row.type, "p");
  assert.equal(matchingObserver({ id: "m2", runDiagnostics: { observer: persisted } }), undefined);
});

test("all locale catalogs expose observer keys and Behavior search indexes settings", () => {
  const expected = Object.keys(catalogs.en.observerGuard);
  for (const [name, catalog] of Object.entries(catalogs)) {
    assert.deepEqual(Object.keys(catalog.observerGuard), expected, name);
    if (name !== "en") assert.notEqual(catalog.observerGuard.guardHint, catalogs.en.observerGuard.guardHint, name);
  }
  const behavior = SETTINGS_NAV.find(row => row.id === "behavior");
  for (const key of ["title", "model", "effort", "timeoutSeconds", "maxInputChars", "maxContinuations", "prompt", "continueOnTransientError", "continueOnTransientErrorHint"]) assert.ok(behavior.keywordKeys.includes(`observerGuard.${key}`));
  for (const key of ["recentToolCount", "includeToolOutput"]) assert.ok(!behavior.keywordKeys.includes(`observerGuard.${key}`));
});

test("real store writes the work-session ID across selection changes and blocks busy enabling", async t => {
  const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
  const { createSessionCoordination } = await import("../src/stores/runtime/session-coordination.ts");
  const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
  const { api } = await import("../src/lib/api.ts");
  let state = { activeSessionId: "b", sessions: [session("a"), session("b")], runningSessions: {}, pendingPlans: {}, sessionMeta: {}, planningStates: {}, retainedTranscripts: {} };
  const access = { get: () => state, set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; } };
  const runtime = createSessionRuntime(access);
  const slice = createSessionSlice({ ...access, runtime, ...createSessionCoordination({ ...access, runtime }) });
  let resolveWrite; const writes = [];
  t.mock.method(api, "configureSession", (id, config) => { writes.push({ id, config }); return new Promise(resolve => { resolveWrite = resolve; }); });
  const write = slice.configureActiveSession({ mode: "agent", observerMode: "endless" }, "b");
  assert.equal(writes[0].id, "b"); assert.equal(writes[0].config.observerMode, "endless");
  assert.equal(Object.hasOwn(writes[0].config, "thinkingLevel"), false);
  assert.equal(state.sessions.find(row => row.id === "b").observerMode, undefined, "unconfirmed saves do not appear enabled");
  state = { ...state, activeSessionId: "a" };
  resolveWrite({ session: { ...session("b"), observerMode: "endless" } }); await write;
  assert.equal(state.sessions.find(row => row.id === "b").observerMode, "endless");
  assert.equal(state.sessions.find(row => row.id === "a").observerMode, undefined);
  state.runningSessions.b = true;
  await slice.configureActiveSession({ mode: "agent", observerMode: "guard" }, "b");
  assert.equal(writes.length, 1);
});

for (const mode of ["endless", "guard"]) test(`running ${mode} can be turned off through the real store without interrupting its response`, async t => {
  const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
  const { createSessionCoordination } = await import("../src/stores/runtime/session-coordination.ts");
  const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
  const { api } = await import("../src/lib/api.ts");
  const agentStatus = { isRunning: true, currentTurnId: "turn", runDiagnostics: { turnId: "turn", observer: mode === "guard" ? { messageId: "reply", mode, status: "checking", startedAt: 1 } : undefined } };
  let state = { activeSessionId: "a", sessions: [session("a"), { ...session("b"), observerMode: mode }], isRunning: true, runningSessions: { a: true, b: true }, pendingPlans: {}, sessionMeta: {}, planningStates: {}, retainedTranscripts: {}, settings, providers: [provider], providerModels: {}, agentStatuses: { b: agentStatus }, showToast: t.mock.fn() };
  const access = { get: () => state, set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; } };
  const runtime = createSessionRuntime(access);
  const slice = createSessionSlice({ ...access, runtime, ...createSessionCoordination({ ...access, runtime }) });
  state.configureActiveSession = slice.configureActiveSession;
  state.abortSession = t.mock.fn();
  const abort = t.mock.method(api, "abort", async () => {});
  let resolveWrite, rejectWrite;
  const configure = t.mock.method(api, "configureSession", () => new Promise((resolve, reject) => { resolveWrite = resolve; rejectWrite = reject; }));
  const useAppStore = Object.assign(selector => selector(state), { getState: access.get });
  const { ObserverGuardPicker } = load("../src/features/sessions/ObserverGuardPicker.tsx", { useAppStore });
  const picker = () => ObserverGuardPicker({ sessionId: "b" });
  const choices = () => picker().props.children[0];
  const busyHint = /observerGuard\.turnOffWhileRunning/;
  if (mode === "guard") assert.match(rendered(picker()), /observerGuard\.checkingHint/);
  assert.match(rendered(picker()), busyHint);
  assert.deepEqual(choices().map(choice => choice.props.disabled), [false, true, true]);
  for (const option of choices().slice(1)) await option.props.onClick();
  await slice.configureActiveSession({ mode: "plan", observerMode: "off" }, "b");
  await slice.configureActiveSession({ mode: "agent", observerMode: "off", fastMode: true }, "b");
  assert.equal(configure.mock.callCount(), 0);

  const rejected = choices()[0].props.onClick();
  assert.deepEqual(configure.mock.calls[0].arguments, ["b", { mode: "agent", observerMode: "off" }]);
  assert.equal(state.sessions[1].observerMode, mode, "Off displays only after acknowledgement");
  rejectWrite(new Error("write failed"));
  await rejected;
  assert.equal(state.sessions[1].observerMode, mode);
  assert.equal(state.showToast.mock.callCount(), 1);

  const unconfirmed = choices()[0].props.onClick();
  resolveWrite({ session: { ...session("b"), observerMode: mode } });
  await unconfirmed;
  assert.equal(state.sessions[1].observerMode, mode);
  assert.equal(state.showToast.mock.callCount(), 2);

  await slice.configureActiveSession({ mode: "agent", modelId: "queued-model" }, "b");
  state.pendingPlans.b = { status: "pending" };
  const write = choices()[0].props.onClick();
  assert.deepEqual(configure.mock.calls[2].arguments, ["b", { mode: "agent", observerMode: "off" }]);
  state.sessions[1] = { ...state.sessions[1], title: "New title" };
  state.planningStates.b = "awaiting-approval";
  resolveWrite({ session: { ...session("b"), title: "Stale title", observerMode: "off" } });
  await write;
  assert.equal(choices()[0].props["aria-checked"], true);
  assert.ok(choices().every(choice => choice.props.disabled));
  assert.equal(state.sessions[0].observerMode, undefined);
  assert.equal(state.sessions[1].observerMode, "off");
  assert.equal(state.sessions[1].title, "New title");
  assert.equal(state.sessions[1].modelId, "queued-model");
  assert.equal(runtime.pendingSessionConfigurations.get("b").modelId, "queued-model");
  assert.equal(state.planningStates.b, "awaiting-approval");
  assert.equal(state.pendingPlans.b.status, "pending");
  assert.equal(state.isRunning, true);
  assert.deepEqual(state.runningSessions, { a: true, b: true });
  assert.equal(state.agentStatuses.b, agentStatus, "revocation leaves the active turn status alone");
  assert.equal(abort.mock.callCount(), 0);
  assert.equal(state.abortSession.mock.callCount(), 0);
  assert.equal(configure.mock.callCount(), 3);
});

test("Endless eligibility is hidden in the transcript and running menu, but historical results still render", () => {
  const marker = { messageId: "reply", mode: "endless", status: "assessed", startedAt: 1, decision: "continue", continued: false, continuationCount: 0, maxContinuations: 3 };
  const runDiagnostics = { turnId: "turn", observer: marker };
  const state = { sessions: [{ ...session("b"), observerMode: "endless" }], runningSessions: { b: true }, pendingPlans: {}, settings, providers: [], providerModels: {}, agentStatuses: { b: { isRunning: true, currentTurnId: "turn", runDiagnostics } } };
  const useAppStore = makeStore(state);
  const { ObserverGuardPicker } = load("../src/features/sessions/ObserverGuardPicker.tsx", { useAppStore });
  const { ObserverGuardDisclosure, ObserverGuardTurnSummary } = load("../src/features/chat/transcript/ObserverGuardDisclosure.tsx", { useAppStore });
  const reply = { id: "reply", role: "assistant", runDiagnostics };
  const menu = () => rendered(ObserverGuardPicker({ sessionId: "b" }));
  assert.equal(ObserverGuardDisclosure({ message: reply }), null);
  assert.equal(ObserverGuardDisclosure({ message: { id: "reply" }, sessionId: "b" }), null);
  assert.deepEqual(ObserverGuardTurnSummary({ parts: [{ kind: "message", message: reply }] }).props.children, []);
  assert.doesNotMatch(menu(), /observerGuard\.(summary\.notContinued|continuationProgress)/);
  assert.match(menu(), /observerGuard\.turnOffWhileRunning/);
  state.agentStatuses.b.runDiagnostics = { turnId: "turn", observer: { ...marker, status: "checking" } };
  assert.equal(ObserverGuardDisclosure({ message: reply, sessionId: "b" }), null, "late checking cannot replace the durable marker");
  state.agentStatuses.b.runDiagnostics = runDiagnostics;

  runDiagnostics.observer = { ...marker, continuationReason: "user_input_pending" };
  for (const html of [menu(), rendered(ObserverGuardDisclosure({ message: reply }))]) {
    assert.match(html, /observerGuard\.summary\.notContinued/);
    assert.match(html, /observerGuard\.continuationProgress/);
  }
  runDiagnostics.observer = { ...marker, continued: true, continuationCount: 1 };
  assert.match(menu(), /observerGuard\.summary\.continued/);
});

test("Guard recommendation is shown without claiming a continuation or a budget count", () => {
  const marker = { messageId: "reply", mode: "guard", status: "assessed", startedAt: 1, decision: "continue", continued: false, continuationCount: 0, maxContinuations: 3, modelKey: "p/reviewer", usage: { inputTokens: 19, outputTokens: 7 } };
  const runDiagnostics = { turnId: "turn", observer: marker };
  const state = { sessions: [{ ...session("b"), observerMode: "guard" }], runningSessions: { b: true }, pendingPlans: {}, settings, providers: [provider], providerModels: {}, agentStatuses: { b: { isRunning: true, currentTurnId: "turn", runDiagnostics } } };
  const useAppStore = makeStore(state);
  const { ObserverGuardPicker } = load("../src/features/sessions/ObserverGuardPicker.tsx", { useAppStore });
  const translate = (key, values) => key === "observerGuard.tokens" ? `${key}: ${values.input} / ${values.output}` : key;
  const { ObserverGuardDisclosure } = load("../src/features/chat/transcript/ObserverGuardDisclosure.tsx", { useAppStore, translate });
  const menu = () => rendered(ObserverGuardPicker({ sessionId: "b" }));
  const disclosure = (restore = false) => ObserverGuardDisclosure(restore
    ? { message: { id: "reply", runDiagnostics } } : { message: { id: "reply" }, sessionId: "b" });
  for (const html of [menu(), rendered(disclosure()), rendered(disclosure(true))]) {
    assert.match(html, /observerGuard\.decisions\.continue/);
    assert.match(html, /Provider \/ reviewer/);
    assert.doesNotMatch(html, /observerGuard\.(summary\.(notContinued|continued)|continuationProgress)/);
  }
  for (const tree of [disclosure(), disclosure(true)]) assert.match(rendered(tree), /observerGuard\.tokens: 19 \/ 7/);

  for (const mode of ["guard", "endless"]) {
    state.sessions[0].observerMode = mode;
    runDiagnostics.observer = { ...marker, mode, continuationReason: "continuation_limit" };
    for (const html of [menu(), rendered(disclosure(true))]) {
      assert.match(html, /observerGuard\.continuationReasons\.continuation_limit/);
      assert.doesNotMatch(html, /observerGuard\.continuationProgress/);
    }
  }
  runDiagnostics.observer = { ...marker, continued: true, continuationCount: 1 };
  assert.match(rendered(disclosure(true)), /observerGuard\.summary\.continued/);
  assert.match(rendered(disclosure(true)), /observerGuard\.continuationProgress/);
  runDiagnostics.observer = { ...marker, decision: "stop", continuationReason: "decision_stop" };
  assert.match(rendered(disclosure(true)), /observerGuard\.continuationReasons\.decision_stop/);
  runDiagnostics.observer = { ...marker, status: "error", decision: undefined, errorCode: "TIMEOUT" };
  assert.match(rendered(disclosure(true)), /observerGuard\.errors\.TIMEOUT/);
});

test("observer picker separates configuration readiness from an owned current-turn assessment", () => {
  const state = { sessions: [{ ...session("b"), observerMode: "guard" }], runningSessions: { b: true }, pendingPlans: {}, settings, providers: [provider], providerModels: {}, agentStatuses: { b: { isRunning: true, currentTurnId: "new", runDiagnostics: { turnId: "old", observer: { messageId: "old", status: "assessed", continued: true } } } } };
  const { ObserverGuardPicker } = load("../src/features/sessions/ObserverGuardPicker.tsx", { useAppStore: makeStore(state) });
  assert.ok(rendered(ObserverGuardPicker({ sessionId: "b" })).includes("observerGuard.waiting"));
  assert.ok(!rendered(ObserverGuardPicker({ sessionId: "b" })).includes("observerGuard.summary.continued"));
  state.agentStatuses.b.runDiagnostics.turnId = "new";
  assert.ok(rendered(ObserverGuardPicker({ sessionId: "b" })).includes("observerGuard.summary.continued"));
  state.runningSessions.b = false;
  state.providers = [];
  const tree = ObserverGuardPicker({ sessionId: "b" });
  assert.ok(tree.props.trigger(null).props.ariaLabel.includes("observerGuard.unavailable"));
  assert.ok(!rendered(tree).includes("observerGuard.summary.continued"));
});

test("evidence actions target their own session and do not post a user prompt", async () => {
  const navigations = [];
  const state = { activeSessionId: "own-session", providers: [], agentStatuses: {}, navigateTranscript: async target => navigations.push(target), showToast() {} };
  const { ObserverGuardDisclosure } = load("../src/features/chat/transcript/ObserverGuardDisclosure.tsx", { useAppStore: makeStore(state) });
  const message = { id: "candidate", runDiagnostics: { observer: { messageId: "candidate", mode: "guard", status: "assessed", startedAt: 1, verdict: "incomplete", continued: false, continuationReason: "tool_error", evidenceIds: ["candidate", "tool"], blockingTool: { toolName: "Bash", toolCallId: "tool" } } } };
  const tree = ObserverGuardDisclosure({ message, sessionId: "own-session" });
  const buttons = nodes(tree).filter(node => node.type === components.Button);
  assert.equal(buttons.length, 4);
  for (const button of buttons) await button.props.onClick();
  assert.deepEqual(navigations.map(target => target.messageId), ["tool", "candidate", "candidate", "tool"]);
  assert.ok(navigations.every(target => target.sessionId === "own-session" && target.query === ""));
  assert.equal(nodes(ObserverGuardDisclosure({ message })).filter(node => node.type === components.Button).length, 0);
});

test("running observer displays its recorded model rather than a changed next-turn selection", () => {
  const state = { sessions: [{ ...session("b"), observerMode: "guard" }], runningSessions: { b: true }, pendingPlans: {}, settings, providers: [provider], providerModels: {}, agentStatuses: { b: { isRunning: true, currentTurnId: "turn", runDiagnostics: { turnId: "turn", observer: { messageId: "reply", status: "checking", modelKey: "p/active-model" } } } } };
  const { ObserverGuardPicker } = load("../src/features/sessions/ObserverGuardPicker.tsx", { useAppStore: makeStore(state) });
  const html = rendered(ObserverGuardPicker({ sessionId: "b" }));
  assert.ok(html.includes("Provider / active-model"));
  assert.ok(!html.includes("observerGuard.configuredModel"));
  state.agentStatuses.b.runDiagnostics.observer = undefined;
  state.providers = [];
  const pending = ObserverGuardPicker({ sessionId: "b" });
  assert.ok(pending.props.trigger(null).props.ariaLabel.includes("observerGuard.waiting"));
  assert.ok(rendered(pending).includes("observerGuard.configuredModel"));
});

test("evidence clicks resolve stored tool IDs and abandon stale session navigation", async () => {
  const navigations = [];
  const state = { activeSessionId: "own", providers: [], agentStatuses: {}, navigateTranscript: async target => navigations.push(target), showToast() { assert.fail("unexpected toast"); } };
  let release;
  const read = async (id, options) => options.messageAround === "tool"
    ? { session: null } : new Promise(resolve => { release = () => resolve({ session: { id, messages: [{ id: "own:tool", role: "tool", toolCallId: "tool" }] } }); });
  const { ObserverGuardDisclosure } = load("../src/features/chat/transcript/ObserverGuardDisclosure.tsx", { useAppStore: makeStore(state), readObserverEvidence: read });
  const message = { id: "reply", runDiagnostics: { observer: { messageId: "reply", mode: "guard", status: "assessed", startedAt: 1, evidenceIds: ["tool"] } } };
  const button = nodes(ObserverGuardDisclosure({ message, sessionId: "own" })).find(node => node.type === components.Button && node.props.title === "tool");
  let action = button.props.onClick();
  await Promise.resolve(); await Promise.resolve();
  release(); await action;
  assert.equal(navigations[0].messageId, "own:tool");
  action = button.props.onClick();
  await Promise.resolve(); await Promise.resolve();
  state.activeSessionId = "other";
  release(); await action;
  assert.equal(navigations.length, 1);
});
