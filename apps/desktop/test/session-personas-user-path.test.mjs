import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { api } = await import("../src/lib/api.ts");
const { createSettingsWriter } = await import("../src/lib/settings-save.ts");
const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
const sessionPersona = await import("../src/stores/runtime/session-persona.ts");
const { approvalIsLive, delegationApprovalState } = await import("../src/lib/delegation-approval-state.ts");
const { sessionDelegationsSource } = await import("../src/features/delegations/session-delegations-source.ts");
const { sessionDelegationTasks } = await import("../src/features/delegations/session-delegation-tasks.ts");
const { useModesStore } = await import("../src/features/modes/modes-store.ts");

const jsx = (type, props, key) => ({ type, props, key });
const treeNodes = (tree) => tree && typeof tree === "object"
  ? [tree, [tree.props.children].flat(Infinity).flatMap(treeNodes)].flat() : [];
const text = (tree) => typeof tree === "string" ? tree : tree && [tree.props.children].flat(Infinity).map(text).join("") || "";
const find = (tree, type, predicate = () => true) => treeNodes(tree).find((node) => node.type === type && predicate(node));
const button = (tree, label) => find(tree, "Button", (node) => text(node) === label) ?? find(tree.props.action, "Button", (node) => text(node) === label);
const typeInto = (node, value) => node.props.onChange({ target: { value } });

// Render and drive real component callbacks; shared visual primitives are leaves.
function component(path, name, dependencies) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const module = { exports: {} };
  let hooks, cursor;
  const react = {
    useState(initial) {
      const key = cursor++;
      if (!(key in hooks)) hooks[key] = initial;
      const owned = hooks;
      return [owned[key], (value) => { owned[key] = typeof value === "function" ? value(owned[key]) : value; }];
    },
    useRef(value) { return this.useState({ current: value })[0]; },
    useCallback: (callback) => callback,
  };
  react.useRef = react.useRef.bind(react);
  const primitives = Object.fromEntries(["Button", "Input", "Textarea", "Field", "SettingsCard", "SettingsMenuSelect",
    "TooltipButton", "HelpIcon", "AnchoredMenu", "SettingsToggle", "IconChevronDown", "IconCheck"].map((name) => [name, name]));
  new Function("require", "exports", "module", code)((id) => {
    if (id === "react") return react;
    if (id === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
    if (id === "react-i18next") return { useTranslation: () => ({ t: (key, vars) => vars?.name ? `${key}:${vars.name}` : key }) };
    if (id === "@pi-desktop/shared") return shared;
    if (/ui$|icons$|primitives$|AnchoredMenu$|SettingsMenuSelect$/.test(id)) return primitives;
    if (id.endsWith(".css")) return {};
    const dependency = dependencies[id.split("/").at(-1)];
    if (dependency) return dependency;
    throw new Error(id);
  }, module.exports, module);
  const stateByComponent = new Map();
  function render(node) {
    while (typeof node?.type === "function") {
      const key = node.key ?? node.type;
      hooks = stateByComponent.get(key) ?? [];
      stateByComponent.set(key, hooks);
      cursor = 0;
      node = node.type(node.props);
    }
    return node;
  }
  return (props = {}) => render(jsx(module.exports[name], props));
}

const base = { defaultMode: "agent", theme: "light", enterToSend: true };
const row = (id, extra) => ({ id, title: id, source: "desktop", mode: "agent", ...extra });
function fixture(t) {
  let settings = { ...base };
  const requests = [];
  const saved = new Map(["a", "b"].map((id) => [id, row(id)]));
  const messages = [{ role: "assistant", content: "Past reply is immutable." }];
  let state = { page: "chat", activeSessionId: "a", sessions: [...saved.values()], messages,
    settings, runningSessions: {}, pendingPlans: {}, pendingPermissions: {}, pendingAsks: {} };
  let pendingWrite, responseGate, listGate;
  const get = () => state;
  const set = (update) => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; };
  const actions = createSessionSlice({ get, set, decorateSessions: (rows) => rows });
  set({ ...actions, configureActivePersona: (...args) => pendingWrite = actions.configureActivePersona(...args),
    showToast: () => assert.fail("Unexpected error toast"), setSettingsTab: (tab) => set({ tab }),
    setSettingsAnchor: (anchor) => set({ anchor }) });
  const settingsWriter = createSettingsWriter({ read: api.getSettings, write: api.setSettings, publish: (value) => set({ settings: value }) });
  let revision = 0;
  globalThis.window = { piDesktop: { platform: "win32", invoke: async (channel, ...args) => {
    let data;
    if (channel === shared.IPC.invoke.settingsGet) data = structuredClone(settings);
    else if (channel === shared.IPC.invoke.settingsSet) settings = structuredClone(args[0]);
    else if (channel === shared.IPC.invoke.sessionList) { data = { sessions: structuredClone([...saved.values()]) }; await listGate; }
    else if (channel === "pi-desktop/session/configurePersona") {
      assert.equal(args.length, 1);
      const [request] = args;
      requests.push(request);
      const previous = saved.get(request.id);
      const selected = settings.personas?.find((item) => item.id === request.personaId);
      const persona = request.personaId === null ? null : selected ? {
        version: 1, definition: selected, revision: (++revision).toString(16).padStart(64, "0"),
        inheritToSubagents: request.inheritToSubagents ?? previous.persona?.inheritToSubagents ?? false,
      } : { ...previous.persona, inheritToSubagents: request.inheritToSubagents };
      await responseGate;
      const session = { ...previous, persona };
      saved.set(request.id, session);
      data = { session };
    } else assert.fail(`Unexpected IPC channel ${channel}`);
    return { ok: true, data };
  } } };
  t.after(() => { delete globalThis.window; useModesStore.setState({ runs: {} }); });
  const useAppStore = Object.assign((selector) => selector(state), { getState: get });
  const approvalSource = delegationApprovalState(api);
  const dependencies = {
    "app-store": { useAppStore }, "save-settings": { settingsWriter }, "session-persona": sessionPersona,
    "modes-store": { useModesStore: (selector) => selector(useModesStore.getState()) },
    "useDelegationApprovals": { approvalIsLive, useDelegationApprovals: () => ({ ...approvalSource.getSnapshot(), loaded: true, now: Date.now() }) },
    "useSessionDelegations": { useSessionDelegations: (id) => {
      const history = sessionDelegationsSource(api, id).getSnapshot();
      return { ...history, loaded: true, ...sessionDelegationTasks(id, history.entries, state.messages, !!state.runningSessions[id]) };
    } },
  };
  const settingsCard = component("../src/features/settings/ConversationPersonasSettings.tsx", "ConversationPersonasSettings", dependencies);
  const picker = component("../src/features/chat/composer/ComposerPersonaPicker.tsx", "ComposerPersonaPicker", dependencies);
  const menu = (sessionId = state.activeSessionId) => picker({ sessionId, onOpen() {} });
  return { get, set, menu, settingsCard, requests, saved, approvalSource, setListGate: (gate) => listGate = gate,
    setResponseGate: (gate) => responseGate = gate, write: () => pendingWrite };
}

function choose(tree, label) { button(tree, label).props.onClick(); }
function trigger(tree) { return tree.props.trigger(null).props; }

async function createTemplate(f, name, prompt) {
  choose(f.settingsCard(), "personas.add");
  typeInto(find(f.settingsCard(), "Input"), name);
  typeInto(find(f.settingsCard(), "Textarea"), prompt);
  await button(f.settingsCard(), "common.save").props.onClick();
  assert.equal(f.get().settings.personas.length, 1);
  return f.get().settings.personas[0];
}

test("settings CRUD and composer selection preserve the committed snapshot until explicit reapply or clear", async (t) => {
  const f = fixture(t);
  const template = await createTemplate(f, "  Reviewer  ", "Keep feedback concrete.");
  assert.equal(template.name, "Reviewer");
  assert.equal(trigger(f.menu()).ariaLabel, "personas.chip:personas.default");
  assert.equal(find(f.menu(), "SettingsToggle").props.disabled, true);
  trigger(f.menu()).onClick();
  assert.equal(f.menu().props.open, true);
  choose(f.menu(), "Reviewer");
  await f.write();
  assert.deepEqual(f.requests.at(-1), { id: "a", personaId: template.id });
  const original = f.get().sessions[0].persona;
  assert.equal(original.inheritToSubagents, false);

  find(f.settingsCard(), "SettingsMenuSelect").props.onChange(template.id);
  typeInto(find(f.settingsCard(), "Input"), "A much longer reviewer name that must stay readable in the popover");
  await button(f.settingsCard(), "common.save").props.onClick();
  assert.equal(f.get().sessions[0].persona, original);
  const modifiedName = f.get().settings.personas[0].name;
  choose(f.menu(), modifiedName);
  await f.write();
  assert.notEqual(f.get().sessions[0].persona.revision, original.revision);
  assert.match(trigger(f.menu()).ariaLabel, /much longer reviewer/);

  find(f.settingsCard(), "SettingsMenuSelect").props.onChange(template.id);
  choose(f.settingsCard(), "personas.delete");
  assert.equal(f.get().settings.personas.length, 1);
  await button(f.settingsCard(), "personas.confirmDelete").props.onClick();
  assert.deepEqual(f.get().settings.personas, []);
  assert.match(text(f.menu()), /personas.retained:A much longer reviewer/);
  const snapshot = f.get().sessions[0].persona;
  find(f.menu(), "SettingsToggle").props.onChange();
  await f.write();
  assert.deepEqual(f.requests.at(-1), { id: "a", inheritToSubagents: true });
  assert.deepEqual(f.get().sessions[0].persona, { ...snapshot, inheritToSubagents: true });
  choose(f.menu(), "personas.default");
  await f.write();
  assert.deepEqual(f.requests.at(-1), { id: "a", personaId: null });
  assert.equal(f.get().sessions[0].persona, null);
  assert.equal(find(f.menu(), "SettingsToggle").props.checked, false);
  assert.equal(f.get().messages[0].content, "Past reply is immutable.");
  choose(f.menu(), "personas.manage");
  assert.equal(f.get().tab, "instructions");
});

test("main, child, approval and mode blocks disable the picker and reject stale actions before IPC", async (t) => {
  const f = fixture(t);
  const template = await createTemplate(f, "Reviewer", "Keep feedback concrete.");
  const captured = button(f.menu(), "Reviewer").props.onClick;
  const check = async (key) => {
    assert.equal(trigger(f.menu())["aria-disabled"], true);
    assert.match(trigger(f.menu()).tooltip, new RegExp(`personas\\.block\\.${key}`));
    assert.equal(button(f.menu(), "Reviewer").props.disabled, true);
    captured();
    await f.write();
    assert.equal(f.requests.length, 0);
  };
  f.set({ runningSessions: { a: true } }); await check("running");
  f.set({ runningSessions: {}, pendingPermissions: { a: [{}] } }); await check("approval");
  f.set({ pendingPermissions: {}, pendingPlans: { a: { status: "pending" } } }); await check("approval");
  const approval = { sessionId: "a", requestId: "fixture-approval", revision: 1, status: "pending", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  f.set({ pendingPlans: {} });
  f.approvalSource.merge(approval); await check("approval");
  f.approvalSource.merge({ ...approval, status: "approved" });
  useModesStore.setState({ runs: { a: { state: "paused" } } }); await check("modeRun");
  useModesStore.setState({ runs: {} });
  const source = sessionDelegationsSource(api, "a");
  t.mock.method(api, "onAgentEvent", () => () => {});
  t.mock.method(api, "listDelegationHistory", async () => ({ entries: [{ sessionId: "a", messageId: "task", delegationId: "child", createdAt: "2026-11-19T00:00:00Z", status: "running" }], nextOffset: null }));
  const release = source.retain();
  try { await source.reload(); await check("running"); } finally { release(); }
  assert.equal(trigger(f.menu())["aria-disabled"], undefined);
  choose(f.menu(), "Reviewer"); await f.write();
  assert.deepEqual(f.requests, [{ id: "a", personaId: template.id }]);
  f.set({ sessions: [row("a", { source: "pi-native" })] }); assert.equal(f.menu(), null);
  f.set({ sessions: [row("a", { source: "remote" })] }); assert.equal(f.menu(), null);
  f.set({ sessions: [row("a", { providerId: shared.trustedExtensionAgentProviderId("fixture/agent") })] }); assert.equal(f.menu(), null);
});

test("session switch and slow list read cannot move or undo a committed persona", async (t) => {
  const f = fixture(t);
  const template = await createTemplate(f, "Reviewer", "Keep feedback concrete.");
  const select = button(f.menu(), "Reviewer").props.onClick;
  const commit = Promise.withResolvers();
  const list = Promise.withResolvers();
  f.setListGate(list.promise);
  const refreshing = f.get().refreshSessions();
  f.setResponseGate(commit.promise);
  select();
  const saving = f.write();
  assert.equal(f.get().personaWrites.a, true);
  f.set({ activeSessionId: "b" });
  select(); await f.write();
  assert.equal(f.requests.length, 1, "stale UI callback cannot issue a second write");
  f.set({ sessions: [row("a", { title: "Newer title" }), row("b")] });
  commit.resolve(); await saving;
  assert.equal(f.get().sessions[0].title, "Newer title");
  assert.equal(f.get().sessions[0].persona.definition.id, template.id);
  list.resolve(); await refreshing;
  assert.equal(f.get().sessions[0].persona.definition.id, template.id);
  assert.equal(f.get().sessions[1].persona, undefined);
  assert.equal(f.get().activeSessionId, "b");
  assert.deepEqual(f.get().personaWrites, {});
});

test("Default exposes independent help without selecting or clearing a persona", async (t) => {
  const f = fixture(t);
  trigger(f.menu()).onClick();
  const menu = f.menu();
  const help = find(menu, "HelpIcon");
  assert.ok(help, "Default has an explanation affordance");
  assert.equal(help.props.label, "personas.defaultHelp");
  assert.ok(!treeNodes(button(menu, "personas.default")).includes(help), "help is not nested in the selection button");
  assert.deepEqual(f.requests, [], "opening help context does not write session settings");
});
