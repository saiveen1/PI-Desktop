import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { api } = await import("../src/lib/api.ts");
const { SIDEBAR_PREFERENCES_KEY } = await import("../src/lib/sidebar-preferences.ts");
const { withoutRecordKey } = await import("../src/stores/helpers/store-helpers.ts");
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { createSessionCoordination } = await import("../src/stores/runtime/session-coordination.ts");
const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
const { createSessionManagementSlice } = await import("../src/stores/slices/session-management-slice.ts");

const projectPath = "/synthetic/app";
const project = { id: "app", primaryPath: projectPath, roots: [{ path: projectPath }, { path: "/synthetic/extra" }] };
const remoteProject = { hostKey: "ssh-a", projectId: "app", label: "Remote" };
const remoteScope = 'remote:["ssh-a","app"]';
const groups = [{ id: "a", name: "A", color: "blue" }, { id: "b", name: "B", color: "red" }];
const row = (id, opts = {}) => ({ id, title: id, mode: "agent", messageCount: 0, updatedAt: "2026-01-01", ...opts });
const remoteRow = (id, opts) => row(`remote:ssh-a:${id}`, {
  source: "remote", remoteHostKey: "ssh-a", remoteProjectId: "app", ...opts,
});

function fixture(t, patch = {}) {
  const cached = new Map();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: key => cached.get(key) ?? null, setItem: (key, value) => cached.set(key, value),
  } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  });
  const persisted = id => JSON.parse(cached.get(SIDEBAR_PREFERENCES_KEY) ?? "{}").sessionMeta?.[id];
  const selected = [];
  const publications = [];
  let state = {
    activeSessionId: undefined, page: "chat", sessions: [], messages: [],
    sessionMeta: {}, sessionHistory: {}, planningStates: {}, runningSessions: {},
    retainedSessionIds: [], retainedTranscripts: {}, navStack: [], navIndex: -1,
    workPanelContexts: {}, workPanelTabs: [], activeWorkPanelTabId: null,
    workPanelOpen: false, workPanelFileRequest: null,
    settings: {}, providers: [], providerModels: {}, recentModels: [], draftConfiguration: null,
    workspace: { path: projectPath }, activeProjectPath: projectPath, sidebarProjectGroups: [project],
    sessionView: { sort: "recent", archived: false }, projectMeta: {}, openProjectPaths: [], sessionLabels: [],
    sessionOrganization: { version: 1, scopes: Object.fromEntries(["group:app", "temporary", remoteScope]
      .map(scope => [scope, { groups, labels: [] }])) },
    ...patch,
  };
  const get = () => state;
  const set = update => {
    const previous = state;
    state = { ...state, ...(typeof update === "function" ? update(state) : update) };
    for (const session of state.sessions) {
      if (!previous.sessions.some(before => before.id === session.id)) {
        publications.push({ id: session.id, meta: state.sessionMeta[session.id], persisted: persisted(session.id) });
      }
    }
  };
  const runtime = createSessionRuntime({ get, set });
  const decorateSessions = rows => rows;
  const coordination = createSessionCoordination({
    get, set, runtime, decorateSessions, withoutRecordKey, untitledTaskTitle: () => "New task",
  });
  Object.assign(state, createSessionSlice({ get, set, runtime, decorateSessions, ...coordination }),
    createSessionManagementSlice({ get, set, persist() {} }), {
      selectSession: async (id, { navigationIntent }) => {
        if (!runtime.navigationIntentIsCurrent(navigationIntent)) return;
        selected.push({ id, meta: get().sessionMeta[id], persisted: persisted(id) });
        set({ activeSessionId: id });
      },
      clearProject: async () => set({ activeProjectPath: null, workspace: null }),
    });
  return { get, set, selected, persisted, publications, runtime, coordination };
}

for (const entry of ["sidebar", "reply"]) {
  test(`${entry} fork publishes and persists only the source conversation's group`, async t => {
    const parentMeta = { groupId: "a", pinned: true, labelIds: ["review"] };
    const f = fixture(t, {
      activeSessionId: "parent", sessions: [row("parent", { projectPath }), row("other", { projectPath })],
      messages: [{ id: "answer", role: "assistant", content: "Ready" }], transcriptViews: {},
      sessionMeta: { parent: parentMeta, other: { groupId: "b" } }, sessionCompactions: {},
    });
    f.set({ restorePendingPlan: async () => {}, restorePendingInteractive: async () => {} });
    const gate = Promise.withResolvers();
    t.mock.method(api, "forkSession", () => gate.promise);
    const fork = entry === "sidebar" ? f.get().forkSession("parent") : f.get().forkAssistantMessage("answer");
    if (entry === "reply") {
      f.runtime.beginNavigationIntent();
      f.set({ activeSessionId: "other" });
    }
    gate.resolve({ session: row("child", { projectPath, messages: [] }) });
    await fork;
    const meta = { groupId: "a", organizationScope: "group:app" };
    assert.deepEqual(f.publications, [{ id: "child", meta, persisted: meta }]);
    assert.deepEqual(f.get().sessionMeta.parent, parentMeta);
    assert.equal(f.get().activeSessionId, entry === "sidebar" ? "child" : "other");
  });
}

test("named local creation reuses only a visible group member, across logical project roots", async t => {
  const f = fixture(t, {
    sessions: [row("other", { projectPath, updatedAt: "2026-01-06" }),
      row("pinned", { projectPath, updatedAt: "2026-01-05" }),
      row("archived", { projectPath, updatedAt: "2026-01-04" }),
      row("valid", { projectPath: "/synthetic/extra" }), row("foreign", { projectPath: "/other", updatedAt: "2026-01-07" })],
    sessionMeta: { other: { groupId: "b" }, pinned: { groupId: "a", pinned: true },
      archived: { groupId: "a", archived: true }, valid: { groupId: "a" }, foreign: { groupId: "a" } },
  });
  const create = t.mock.method(api, "createSession", async () => ({ session: row("unexpected", { projectPath }) }));
  assert.equal(await f.get().newSession({ projectPath, groupId: "a" }), "valid");
  assert.equal(f.get().activeSessionId, "valid");
  assert.equal(await f.get().newSession({ projectPath }), undefined);
  assert.equal(f.get().activeSessionId, "other", "omitting groupId preserves project-wide reuse");
  assert.equal(create.mock.callCount(), 0);
});

test("explicit Ungrouped reuses only effective Ungrouped, while Temporary named creation is persisted before publication", async t => {
  const f = fixture(t, {
    sessions: [row("named", { updatedAt: "2026-01-04" }), row("orphan"), row("local", { projectPath })],
    sessionMeta: { named: { groupId: "a" }, orphan: { groupId: "deleted" }, local: { groupId: "b" } },
  });
  const create = t.mock.method(api, "createSession", async () => ({ session: row("new-temp") }));
  assert.equal(await f.get().newSession({ projectPath: null, groupId: null }), "orphan");
  assert.equal(await f.get().newSession({ projectPath: null, groupId: "b" }), "new-temp");
  assert.equal(create.mock.callCount(), 1);
  assert.equal(create.mock.calls[0].arguments[0].projectPath, undefined);
  assert.equal("groupId" in create.mock.calls[0].arguments[0], false);
  const meta = { organizationScope: "temporary", groupId: "b" };
  assert.deepEqual(f.publications, [{ id: "new-temp", meta, persisted: meta }]);
  assert.equal(f.get().activeSessionId, "new-temp");
});

test("local pending creates coalesce only in the same group, and the home draft joins the current create", async t => {
  const f = fixture(t);
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  let calls = 0;
  t.mock.method(api, "createSession", () => gates[calls++]?.promise ?? Promise.resolve({ session: row("unexpected", { projectPath }) }));
  const a = f.get().newSession({ projectPath, groupId: "a" });
  const duplicate = f.get().newSession({ projectPath, groupId: "a" });
  const b = f.get().newSession({ projectPath, groupId: "b" });
  const duplicateB = f.get().newSession({ projectPath, groupId: "b" });
  const firstInput = f.coordination.materializeDraftSession();
  assert.equal(calls, 2);
  gates[1].resolve({ session: row("new-b", { projectPath }) });
  assert.deepEqual(await Promise.all([b, duplicateB, firstInput]), ["new-b", "new-b", "new-b"]);
  gates[0].resolve({ session: row("new-a", { projectPath }) });
  assert.deepEqual(await Promise.all([a, duplicate]), [null, null]);
  assert.equal(f.get().activeSessionId, "new-b");
  assert.equal(f.persisted("new-a").groupId, "a");
  assert.equal(f.persisted("new-b").groupId, "b");
  assert.equal(f.runtime.pendingNewSessionRequests.size, 0);
});

test("deleting a group during create preserves the new row ungrouped and does not move the newly selected row", async t => {
  const f = fixture(t, { sessions: [row("elsewhere", { projectPath, messageCount: 1 })],
    sessionMeta: { elsewhere: { groupId: "b" } } });
  const gate = Promise.withResolvers();
  t.mock.method(api, "createSession", () => gate.promise);
  const creation = f.get().newSession({ projectPath, groupId: "a" });
  f.get().setSessionGroups("group:app", [groups[1]]);
  f.runtime.beginNavigationIntent();
  f.set({ activeSessionId: "elsewhere" });
  gate.resolve({ session: row("new", { projectPath }) });
  assert.equal(await creation, null);
  assert.equal(f.get().activeSessionId, "elsewhere");
  assert.equal(f.get().sessionMeta.elsewhere.groupId, "b");
  assert.equal(f.get().sessionMeta.new?.groupId, undefined);
  assert.equal(f.get().sessions.some(session => session.id === "new"), true);
});

test("remote group creation keeps IPC unchanged, coalesces per group, and persists the exact IDs before selection", async t => {
  const f = fixture(t, { sessions: [remoteRow("unrelated", { messageCount: 1 })], sessionMeta: { "remote:ssh-a:unrelated": { groupId: "b" } } });
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  let calls = 0;
  const local = t.mock.method(api, "createSession", async () => ({ session: row("unexpected", { projectPath }) }));
  const create = t.mock.method(api, "createRemoteSession", () => gates[calls++]?.promise);
  const a = f.get().newSession({ remoteProject, groupId: "a" });
  const duplicate = f.get().newSession({ remoteProject, groupId: "a" });
  const ungrouped = f.get().newSession({ remoteProject, groupId: null });
  const duplicateUngrouped = f.get().newSession({ remoteProject, groupId: null });
  assert.deepEqual(create.mock.calls.map(call => call.arguments[0]), Array(2).fill({
    hostKey: "ssh-a", projectId: "app", mode: "agent", permissionMode: "ask",
  }));
  gates[1].resolve({ session: remoteRow("new-plain", { projectPath: "/remote/path" }) });
  assert.deepEqual(await Promise.all([ungrouped, duplicateUngrouped]), ["remote:ssh-a:new-plain", "remote:ssh-a:new-plain"]);
  gates[0].resolve({ session: remoteRow("new-a", { projectPath: "/remote/path" }) });
  assert.deepEqual(await Promise.all([a, duplicate]), [null, null]);
  assert.equal(local.mock.callCount(), 0);
  assert.equal(f.get().sessionMeta["remote:ssh-a:unrelated"].groupId, "b");
  assert.equal(f.get().sessions.find(session => session.id === "remote:ssh-a:new-a").projectPath, undefined);
  assert.equal(f.get().workspace.path, projectPath);
  const meta = { organizationScope: remoteScope };
  assert.deepEqual(f.selected, [{ id: "remote:ssh-a:new-plain", meta, persisted: meta }]);
  assert.deepEqual(f.persisted("remote:ssh-a:new-a"), { ...meta, groupId: "a" });
});

test("remote reuse revalidates the bounded read and rejects a candidate moved during it", async t => {
  const candidate = remoteRow("candidate");
  const pinned = remoteRow("pinned", { updatedAt: "2026-01-02" });
  const f = fixture(t, { sessions: [candidate, pinned], sessionMeta: {
    [candidate.id]: { groupId: "a" }, [pinned.id]: { groupId: "a", pinned: true },
  } });
  const read = t.mock.method(api, "getSession", async () => ({ session: { ...candidate, messages: [], hasMoreBefore: false } }));
  assert.equal(await f.get().newSession({ remoteProject, groupId: "a" }), candidate.id);
  assert.deepEqual(read.mock.calls[0].arguments, [candidate.id]);
  const gate = Promise.withResolvers();
  t.mock.method(api, "getSession", () => gate.promise);
  t.mock.method(api, "createRemoteSession", async () => ({ session: remoteRow("replacement") }));
  const creation = f.get().newSession({ remoteProject, groupId: "a" });
  f.get().moveSessionToGroup(candidate.id, "b");
  gate.resolve({ session: { ...candidate, messages: [], hasMoreBefore: false } });
  assert.equal(await creation, "remote:ssh-a:replacement");
  assert.equal(f.get().sessionMeta[candidate.id].groupId, "b");
  assert.equal(f.selected.at(-1).persisted.groupId, "a");
});
