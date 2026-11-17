import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { observerSelection } = await import("../src/lib/observer-guard-models.ts");
const { SETTINGS_NAV } = await import("../src/lib/settings-search.ts");
const { catalogs } = await import("../../../packages/i18n/src/index.ts");
const provider = { id: "p", name: "Provider", enabled: true, authKind: "none", hasSecret: false, models: [{ id: "m", thinkingLevels: ["off", "high"] }] };
const base = { defaultMode: "agent", theme: "light", enterToSend: true };
const settings = { ...base, observerGuard: { providerId: "p", modelId: "m", thinkingLevel: "high" } };
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
const primitive = name => Object.assign(() => null, { displayName: name });
const components = Object.fromEntries(["SettingsCard", "SettingsRow", "Input", "SettingsToggle", "SettingsMenuSelect", "SettingsDisclosure", "TooltipButton", "AnchoredMenu", "IconCheck", "IconEye"].map(name => [name, primitive(name)]));
const t = key => key;
function load(path, extra) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function("require", "exports", "module", code)(id => {
    if (id === "react") return { useState: value => [value, () => {}], useEffect() {} };
    if (id === "react/jsx-runtime") return jsx;
    if (id === "react-i18next") return { useTranslation: () => ({ t }) };
    if (id === "@pi-desktop/shared") return shared;
    if (id.includes("observer-guard-models")) return { observerSelection };
    if (id.includes("remote-session-safety")) return { isRemoteSession: session => session?.source === "remote" || session?.id?.startsWith("remote:") };
    if (id.includes("app-store")) return extra;
    if (id.includes("primitives") || id.includes("/ui") || id.includes("SettingsMenuSelect") || id.includes("SettingsDisclosure") || id.includes("AnchoredMenu") || id.includes("icons")) return components;
    throw Error(id);
  }, module.exports, module);
  return module.exports;
}
const makeStore = state => Object.assign(fn => fn(state), { getState: () => state });
const session = id => ({ id, mode: "agent", source: "desktop" });

test("model and effort availability retain stale selections without remapping", () => {
  assert.equal(observerSelection(settings, [provider], {}).available, true);
  assert.equal(observerSelection({ ...settings, observerGuard: { ...settings.observerGuard, thinkingLevel: "low" } }, [provider], {}).available, false);
  assert.equal(observerSelection(settings, [{ ...provider, enabled: false }], {}).selected, undefined);
  assert.equal(observerSelection(settings, [{ ...provider, authKind: "oauth", hasOauth: true }], {}).available, true);
});

test("picker targets work session and permits off when model disappears", async () => {
  const calls = [];
  const state = { sessions: [session("a"), { ...session("b"), observerMode: "guard" }], activeSessionId: "a", runningSessions: {}, pendingPlans: {}, settings, providers: [provider], providerModels: {}, configureActiveSession: async (...args) => { calls.push(args); }, showToast() {}, setSettingsTab() {} };
  const { ObserverGuardPicker } = load("../src/features/sessions/ObserverGuardPicker.tsx", { useAppStore: makeStore(state) });
  let tree = ObserverGuardPicker({ sessionId: "b" });
  let choices = tree.props.children[0];
  assert.equal(choices[2].props["aria-checked"], true);
  choices[1].props.onClick();
  assert.equal(ObserverGuardPicker({ sessionId: "a" }).props.children[0][0].props["aria-checked"], true);
  assert.equal(calls[0][1], "b"); assert.equal(calls[0][0].observerMode, "observe");
  state.providers = [];
  tree = ObserverGuardPicker({ sessionId: "b" }); choices = tree.props.children[0];
  assert.equal(choices[1].props.disabled, true); assert.equal(choices[0].props.disabled, false);
  choices[0].props.onClick(); assert.equal(calls.at(-1)[0].observerMode, "off");
  state.runningSessions.b = true; assert.equal(ObserverGuardPicker({ sessionId: "b" }).props.trigger(null).props.disabled, true);
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
  const [modelRow, effortRow] = tree.props.children;
  const model = modelRow.props.children; const effort = effortRow.props.children;
  assert.match(effort.props.options.find(row => row.id === "low").label, /unavailable/);
  effort.props.onChange("high"); assert.deepEqual(writes[0], { observerGuard: { thinkingLevel: "high" } });
  model.props.onChange(""); assert.deepEqual(writes[1], { observerGuard: { providerId: "", modelId: "" } });
});

test("disclosure matches message IDs, shows live and renders model prose only as text", () => {
  const live = { messageId: "m1", mode: "observe", status: "checking", startedAt: 0 };
  const state = { agentStatuses: { b: { isRunning: true, currentTurnId: "turn", runDiagnostics: { observer: live } } } };
  const { ObserverGuardDisclosure, matchingObserver } = load("../src/features/chat/transcript/ObserverGuardDisclosure.tsx", { useAppStore: makeStore(state) });
  assert.equal(ObserverGuardDisclosure({ sessionId: "b", message: { id: "m2" } }), null);
  assert.equal(matchingObserver({ id: "m1" }, live), live);
  assert.equal(ObserverGuardDisclosure({ sessionId: "b", message: { id: "m1" } }).props.children[0].props.children[2], "observerGuard.status.checking");
  const restored = { id: "m1", runDiagnostics: { turnId: "old", observer: live } };
  assert.equal(ObserverGuardDisclosure({ message: restored }).props.children[0].props.children[2], "observerGuard.interrupted");
  state.agentStatuses.b = { isRunning: true, currentTurnId: "new", runDiagnostics: {} };
  assert.equal(ObserverGuardDisclosure({ sessionId: "b", message: restored }).props.children[0].props.children[2], "observerGuard.interrupted");
  assert.equal(restored.runDiagnostics.observer.status, "checking", "presentation does not rewrite persisted evidence");
  const reason = "<img src=x onerror=alert(1)>";
  const persisted = { ...live, status: "assessed", verdict: "unknown", reason };
  const tree = ObserverGuardDisclosure({ message: { id: "m1", runDiagnostics: { observer: persisted } } });
  const failed = ObserverGuardDisclosure({ message: { id: "m1", runDiagnostics: { observer: { ...live, status: "error", errorCode: "TIMEOUT" } } } });
  assert.equal(failed.props.children[0].props.children[2], "observerGuard.status.error");
  assert.ok(JSON.stringify(failed).includes("observerGuard.errors.TIMEOUT"));
  assert.ok(JSON.stringify(tree).includes("observerGuard.verdicts.unknown"));
  const row = tree.props.children[2].props.children.find(item => item?.props?.children?.[1]?.props?.children === reason);
  assert.ok(row); assert.equal(row.props.children[1].type, "dd");
  assert.equal(matchingObserver({ id: "m2", runDiagnostics: { observer: persisted } }), undefined);
});

test("all locale catalogs expose observer keys and Behavior search indexes settings", () => {
  const expected = Object.keys(catalogs.en.observerGuard);
  for (const [name, catalog] of Object.entries(catalogs)) assert.deepEqual(Object.keys(catalog.observerGuard), expected, name);
  const behavior = SETTINGS_NAV.find(row => row.id === "behavior");
  for (const key of ["title", "model", "effort", "timeoutSeconds", "maxInputChars", "recentToolCount", "includeToolOutput"]) assert.ok(behavior.keywordKeys.includes(`observerGuard.${key}`));
});

test("real store writes the work-session ID across selection changes and blocks live sessions", async t => {
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
  const write = slice.configureActiveSession({ mode: "agent", observerMode: "observe" }, "b");
  assert.equal(writes[0].id, "b"); assert.equal(writes[0].config.observerMode, "observe");
  assert.equal(Object.hasOwn(writes[0].config, "thinkingLevel"), false);
  assert.equal(state.sessions.find(row => row.id === "b").observerMode, undefined, "unconfirmed saves do not appear enabled");
  state = { ...state, activeSessionId: "a" };
  resolveWrite({ session: { ...session("b"), observerMode: "observe" } }); await write;
  assert.equal(state.sessions.find(row => row.id === "b").observerMode, "observe");
  assert.equal(state.sessions.find(row => row.id === "a").observerMode, undefined);
  state.runningSessions.b = true;
  await slice.configureActiveSession({ mode: "agent", observerMode: "off" }, "b");
  assert.equal(writes.length, 1);
});
