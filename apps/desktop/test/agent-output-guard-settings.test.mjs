import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const renderer = await import("../src/lib/api.ts");
const { createProviderCatalogRuntime } = await import("../electron/main/runtime/provider-catalog.ts");
const { createSettingsWriter } = await import("../src/lib/settings-save.ts");
const { earlyEndAdvisory } = await import("../src/lib/output-guard-advisory.ts");
const { SETTINGS_NAV } = await import("../src/lib/settings-search.ts");
const { catalogs } = await import("../../../packages/i18n/src/index.ts");
const main = createProviderCatalogRuntime({ getHost: () => null, modelsDevCatalog: {} });
const base = { defaultMode: "agent", theme: "light", enterToSend: true };

test("settings normalize malformed persisted fields and both ingress boundaries reject bad writes", () => {
  globalThis.window = { piDesktop: { platform: "win32" } };
  try {
    for (const normalize of [renderer.normalizeSettings, main.normalizeSettings]) {
      assert.deepEqual(normalize(base).agentOutputGuard, shared.DEFAULT_AGENT_OUTPUT_GUARD_SETTINGS);
      const guard = normalize({ ...base, agentOutputGuard: { earlyEndMode: "continue", recoveryLimit: 100, symbolMinLines: "32", repeatedParagraphsEnabled: false } }).agentOutputGuard;
      assert.equal(guard.earlyEndMode, "continue");
      assert.equal(guard.recoveryLimit, shared.DEFAULT_AGENT_OUTPUT_GUARD_SETTINGS.recoveryLimit);
      assert.equal(guard.symbolMinLines, shared.DEFAULT_AGENT_OUTPUT_GUARD_SETTINGS.symbolMinLines);
      assert.equal(guard.repeatedParagraphsEnabled, false);
    }
    for (const validate of [renderer.validateSettingsWrite, main.validateSettingsWrite]) {
      for (const bad of [null, [], { earlyEndMode: "yes" }, { recoveryLimit: -1 }, { symbolMinChars: 1 }, { repeatedParagraphMinRepeats: 3.5 }, { unexpected: true }]) {
        assert.throws(() => validate({ ...base, agentOutputGuard: bad }), /agentOutputGuard is invalid/);
      }
      assert.equal(validate({ ...base, agentOutputGuard: { recoveryLimit: 0 } }).agentOutputGuard.recoveryLimit, 0);
    }
  } finally { delete globalThis.window; }
});

test("serialized partial saves preserve guard siblings and unrelated settings", async () => {
  let stored = { ...base, agentOutputGuard: { earlyEndMode: "warn", symbolMinChars: 7000 }, autoContinueUnfinishedTodos: false };
  const writer = createSettingsWriter({ read: async () => structuredClone(stored), write: async value => { stored = structuredClone(value); }, publish() {} });
  await Promise.all([writer.save({ agentOutputGuard: { earlyEndMode: "continue" } }), writer.save({ agentOutputGuard: { repeatedParagraphsEnabled: false } }), writer.save({ agentOutputGuard: { recoveryLimit: 0 } })]);
  assert.equal(stored.agentOutputGuard.earlyEndMode, "continue");
  assert.equal(stored.agentOutputGuard.repeatedParagraphsEnabled, false);
  assert.equal(stored.agentOutputGuard.symbolMinChars, 7000);
  assert.equal(stored.agentOutputGuard.recoveryLimit, 0);
  assert.equal(stored.autoContinueUnfinishedTodos, false);
  await assert.rejects(writer.save({ agentOutputGuard: null }), /agentOutputGuard is invalid/);
  assert.equal(stored.agentOutputGuard.recoveryLimit, 0);
});

test("main settings IPC merges validated partial guard writes with stored siblings", async () => {
  const src = readFileSync(new URL("../electron/main/ipc/settings-ipc.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function("require", "exports", "module", code)(id => {
    if (id === "@pi-desktop/shared") return shared;
    if (id === "../network-proxy") return { currentSystemProxyRelayUrl: () => undefined };
    throw new Error(id);
  }, module.exports, module);
  let stored = { ...base, agentOutputGuard: { symbolMinChars: 8000, repeatedParagraphsEnabled: false } };
  let releaseFirst; const gate = new Promise(resolve => { releaseFirst = resolve; }); let writes = 0;
  const host = { async call(method, value) {
    if (method === "settings.get") return structuredClone(stored);
    if (method === "settings.set") { if (++writes === 1) await gate; return stored = { ...stored, ...value }; }
    throw new Error(method);
  } };
  const handlers = new Map();
  module.exports.registerSettingsIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) }, getHost: () => host, getSidecar: () => null,
    normalizeSettings: main.normalizeSettings, validateSettingsWrite: main.validateSettingsWrite,
    applyNetworkProxyFromAppSettings: async () => {}, applyApplicationMenuSettings() {}, applyDeveloperMode() {},
  });
  const set = handlers.get(shared.IPC.invoke.settingsSet);
  const first = set({ agentOutputGuard: { earlyEndMode: "continue" } });
  const second = set({ agentOutputGuard: { recoveryLimit: 2 } });
  releaseFirst(); await Promise.all([first, second]);
  assert.equal(stored.agentOutputGuard.earlyEndMode, "continue");
  assert.equal(stored.agentOutputGuard.symbolMinChars, 8000);
  assert.equal(stored.agentOutputGuard.repeatedParagraphsEnabled, false);
  assert.equal(stored.agentOutputGuard.recoveryLimit, 2);
  await assert.rejects(set({ agentOutputGuard: { symbolMinChars: 0 } }), /agentOutputGuard is invalid/);
  assert.equal(stored.agentOutputGuard.symbolMinChars, 8000);
  await set({ agentOutputGuard: { recoveryLimit: 1 } });
  assert.equal(stored.agentOutputGuard.recoveryLimit, 1);
});

test("warnings require the matching settled response and remain distinct from truncation", () => {
  const message = { id: "answer", status: "complete", outputTruncated: false, runDiagnostics: { termination: { messageId: "answer", reasonSource: "normalized", stopReason: "stop", earlyEnd: "suspected" } } };
  assert.equal(earlyEndAdvisory(message, false), "suspected");
  assert.equal(earlyEndAdvisory({ ...message, outputTruncated: false, runDiagnostics: { termination: { ...message.runDiagnostics.termination, earlyEnd: "exhausted" } } }, false), "exhausted");
  assert.equal(earlyEndAdvisory(message, true), undefined);
  assert.equal(earlyEndAdvisory({ ...message, status: undefined }, false), undefined);
  assert.equal(earlyEndAdvisory({ ...message, status: undefined, runDiagnostics: { ...message.runDiagnostics, endedAt: 1 } }, false), "suspected");
  for (const status of ["streaming", "error", "aborted"]) assert.equal(earlyEndAdvisory({ ...message, status }, false), undefined);
  for (const changes of [{ messageId: "other" }, { earlyEnd: "recovering" }, { stopReason: "length" }, { stopReason: "toolUse" }, { stopReason: "unknown" }, { stopReason: "aborted" }, { stopReason: "error" }]) {
    assert.equal(earlyEndAdvisory({ ...message, runDiagnostics: { termination: { ...message.runDiagnostics.termination, ...changes } } }, false), undefined);
  }
  assert.equal(earlyEndAdvisory({ ...message, error: { code: "ERROR" } }, false), undefined);
});

test("all locales expose the full guard copy and Behavior indexes its controls", () => {
  const keys = Object.keys(catalogs.en.outputGuard);
  for (const [locale, catalog] of Object.entries(catalogs)) {
    assert.deepEqual(Object.keys(catalog.outputGuard), keys, locale);
    for (const [key, value] of Object.entries(catalog.outputGuard)) assert.ok(value && (typeof value !== "string" || value.trim()), `${locale}.${key}`);
    assert.equal(catalog.settings.autoContinueUnfinishedTodosDesc, catalog.outputGuard.checklistDesc, locale);
  }
  const keysIndexed = SETTINGS_NAV.find(row => row.id === "behavior").keywordKeys;
  for (const key of ["title", "mode", "recoveryLimit", "symbolGuard", "paragraphGuard", "symbolMinChars", "repeatedParagraphMinRepeats"]) assert.ok(keysIndexed.includes(`outputGuard.${key}`));
});

// Render the actual component with a lightweight hook/JSX fixture. This tests
// control callbacks without starting Electron or requiring a browser profile.
test("guard controls emit partial writes and reject invalid threshold edits", () => {
  let slots = [], cursor = 0;
  const react = { useEffect() {}, useState(initial) { const at = cursor++; if (!(at in slots)) slots[at] = initial; return [slots[at], value => { slots[at] = value; }]; } };
  const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  const primitive = name => Object.assign(() => null, { displayName: name });
  const components = Object.fromEntries(["SettingsCard", "SettingsRow", "Input", "SegmentedControl", "SettingsToggle", "SettingsMenuSelect"].map(name => [name, primitive(name)]));
  const src = readFileSync(new URL("../src/components/settings/AgentOutputGuardSettings.tsx", import.meta.url), "utf8");
  const code = ts.transpileModule(src, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function("require", "exports", "module", code)(id => {
    if (id === "react") return react;
    if (id === "react/jsx-runtime") return jsx;
    if (id === "react-i18next") return { useTranslation: () => ({ t: key => key }) };
    if (id === "@pi-desktop/shared") return shared;
    if (id === "../../features/settings/primitives" || id === "../ui" || id === "./SettingsMenuSelect") return components;
    throw new Error(id);
  }, module.exports, module);
  const writes = [];
  const tree = module.exports.AgentOutputGuardSettings({ settings: base, saveSettings: async patch => { writes.push(patch); } });
  const rows = tree.props.children;
  const mode = rows[0].props.children;
  assert.equal(mode.props.value, "warn");
  for (const choice of ["off", "continue", "warn"]) mode.props.onChange(choice);
  const allowance = rows[1].props.children; allowance.props.onChange("0");
  rows[2].props.children.props.onChange(); rows[3].props.children.props.onChange();
  assert.deepEqual(writes.map(write => write.agentOutputGuard), [{ earlyEndMode: "off" }, { earlyEndMode: "continue" }, { earlyEndMode: "warn" }, { recoveryLimit: 0 }, { repetitiveOutputEnabled: false }, { repeatedParagraphsEnabled: false }]);
  const threshold = rows[4][0];
  const render = () => { cursor = 0; return threshold.type(threshold.props).props.children; };
  let input = render();
  assert.equal(input.props.min, shared.AGENT_OUTPUT_GUARD_LIMITS.symbolMinChars.min);
  input.props.onChange({ target: { value: "10" } }); input = render(); input.props.onBlur(); input = render();
  assert.equal(input.props["aria-invalid"], true);
  assert.equal(writes.length, 6);
  input.props.onChange({ target: { value: "6000" } }); input = render(); input.props.onBlur();
  assert.deepEqual(writes.at(-1), { agentOutputGuard: { symbolMinChars: 6000 } });
  const off = module.exports.AgentOutputGuardSettings({ settings: { ...base, agentOutputGuard: { repetitiveOutputEnabled: false } }, saveSettings: async () => {} }).props.children;
  assert.equal(off[3].props.children.props.disabled, true);
  assert.equal(off[4].every(field => field.props.disabled), true);
  const legacy = module.exports.AgentOutputGuardSettings({ settings: { ...base, agentOutputGuard: { repeatedParagraphsEnabled: false } }, saveSettings: async () => {} }).props.children;
  assert.deepEqual(legacy[4].map(field => field.props.disabled), [false, false, false, true, true]);
});
