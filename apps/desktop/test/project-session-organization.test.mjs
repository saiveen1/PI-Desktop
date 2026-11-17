import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { groupSessionsByGroup, visibleGroupedSessionIds, sessionGroupKey,
  projectOrganizationScope, sessionOrganizationScope, cleanSessionOrganization,
  sessionOrganizationCatalog } = await import("../src/lib/session-organization.ts");
const { createSessionManagementSlice } = await import("../src/stores/slices/session-management-slice.ts");

const project = { id: "logical-project", name: "App", primaryPath: "D:/app", roots: [
  { path: "D:/app", name: "app", position: 0 }, { path: "D:/plugins", name: "plugins", position: 1 },
] };
const groups = [{ id: "investigation", name: "Investigation", color: "blue" }, { id: "fix", name: "Fix", color: "red" }];
const sessions = ["a", "b", "plain", "orphan"].map(id => ({ id, title: id, projectPath: "D:/app" }));
const meta = { a: { groupId: "fix", labelIds: ["one", "two"] }, b: { groupId: "investigation" }, orphan: { groupId: "deleted" } };

test("groups place each multi-label conversation exactly once and retain empty groups", () => {
  const result = groupSessionsByGroup(sessions, groups, meta);
  assert.deepEqual(result.map(row => [row.group?.id ?? null, row.sessions.map(item => item.id)]), [
    ["investigation", ["b"]], ["fix", ["a"]], [null, ["plain", "orphan"]],
  ]);
  assert.equal(result[1].sessions[0], sessions[0]);
  assert.equal(groupSessionsByGroup([], groups, {}).length, 2);
  const toggled = new Set([sessionGroupKey("project", "investigation")]);
  assert.deepEqual(visibleGroupedSessionIds(result, "project", toggled), ["b", "plain", "orphan"]);
  assert.deepEqual(visibleGroupedSessionIds(result, "other", toggled), ["plain", "orphan"]);
  toggled.add(sessionGroupKey("project", null));
  assert.deepEqual(visibleGroupedSessionIds(result, "project", toggled), ["b"]);
  assert.notEqual(sessionGroupKey("project", null), sessionGroupKey("project", ""));
});

test("running sessions keep exclusive groups and manual order while entering their group's first page", async () => {
  const { prioritizeRunningSessions } = await import("../src/lib/session-organization.ts");
  const { paginateSessionGroups } = await import("../src/lib/sidebar-project-sessions.ts");
  const rows = Object.freeze(Array.from({ length: 14 }, (_, index) => Object.freeze({ id: String(index) })));
  const assignments = Object.fromEntries(rows.map((row, index) => [row.id, {
    groupId: index === 5 ? "fix" : "investigation", labelIds: ["one", "two"], order: index,
  }]));
  const originalAssignments = structuredClone(assignments);
  const ordered = prioritizeRunningSessions(rows, { "12": true, "13": true });
  assert.deepEqual(ordered.map(row => row.id), ["12", "13", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
  assert.equal(ordered[0], rows[12]);
  const catalog = [...groups, { id: "empty", name: "Empty", color: "green" }];
  const grouped = paginateSessionGroups(groupSessionsByGroup(ordered, catalog, assignments));
  assert.deepEqual(grouped.map(row => row.sessions.length), [13, 1, 0]);
  assert.deepEqual(grouped[0].visibleSessions.map(row => row.id), ["12", "13", "0", "1", "2", "3", "4", "6", "7", "8"]);
  const toggled = new Set(groups.map(group => sessionGroupKey("project", group.id)));
  assert.equal(new Set(visibleGroupedSessionIds(grouped, "project", toggled)).size, 11);
  toggled.delete(sessionGroupKey("project", "investigation"));
  assert.deepEqual(visibleGroupedSessionIds(grouped, "project", toggled), ["5"]);
  assert.deepEqual(prioritizeRunningSessions(rows, {}), rows);
  const expanded = paginateSessionGroups(groupSessionsByGroup(ordered, catalog, assignments), { investigation: true });
  assert.equal(expanded[0].visibleSessions.length, 13);
  assert.deepEqual(rows.map(row => row.id), Array.from({ length: 14 }, (_, index) => String(index)));
  assert.deepEqual(assignments, originalAssignments);
});

test("project scopes join roots, survive primary promotion and isolate remote hosts", () => {
  assert.equal(projectOrganizationScope("D:\\plugins\\", [project]), "group:logical-project");
  assert.equal(projectOrganizationScope("D:/app", [{ ...project, primaryPath: "D:/plugins" }]), "group:logical-project");
  assert.equal(projectOrganizationScope("/other", [project]), "project:/other");
  assert.equal(sessionOrganizationScope({ id: "remote:a", source: "remote", remoteHostKey: "a", remoteProjectId: "same" }, [project]), 'remote:["a","same"]');
  assert.notEqual(sessionOrganizationScope({ id: "remote:a", source: "remote", remoteHostKey: "a", remoteProjectId: "same" }, []),
    sessionOrganizationScope({ id: "remote:b", source: "remote", remoteHostKey: "b", remoteProjectId: "same" }, []));
});

test("organization schema validates catalogs without assigning old labels to groups", () => {
  const original = [{ id: "one", name: "Old label", color: "blue" }];
  const data = cleanSessionOrganization({ version: 1, scopes: { "project:/app": {
    groups: [{ id: "g", name: " Group ", color: "green" }, { id: "g", name: "Duplicate", color: "red" }, { id: "bad", name: "Bad", color: "url(secret)" }],
    labels: [{ id: "custom", name: "Custom", color: "pink" }],
  } } });
  assert.deepEqual(data.scopes["project:/app"].groups, [{ id: "g", name: "Group", color: "green" }]);
  assert.deepEqual(sessionOrganizationCatalog(data, "new-project", original), { groups: [], labels: original });
  assert.deepEqual(cleanSessionOrganization(null), { version: 1, scopes: {} });
});

function harness() {
  let writes = 0;
  let state = { sessions: [...sessions, { id: "other", projectPath: "/other" }], sessionMeta: {
    ...meta, other: { labelIds: ["one"], color: "pink" },
  }, sessionLabels: [{ id: "one", name: "Old label", color: "blue" }, { id: "two", name: "Second", color: "red" }],
    sessionFilter: { labelIds: [] }, sidebarProjectGroups: [project], sessionOrganization: { version: 1, scopes: {} },
  };
  const get = () => state;
  const set = value => { state = { ...state, ...(typeof value === "function" ? value(state) : value) }; };
  Object.assign(state, createSessionManagementSlice({ get, set, persist: () => { writes++; } }));
  return { get, writes: () => writes };
}

test("moving is exclusive, rejects foreign groups and preserves marks and transcripts", () => {
  const h = harness();
  h.get().setSessionGroups("group:logical-project", groups);
  h.get().moveSessionToGroup("a", "investigation");
  h.get().moveSessionToGroup("a", "fix");
  assert.equal(h.get().sessionMeta.a.groupId, "fix");
  assert.deepEqual(h.get().sessionMeta.a.labelIds, ["one", "two"]);
  const before = h.writes();
  h.get().moveSessionToGroup("other", "fix");
  assert.equal(h.writes(), before);
  h.get().moveSessionToGroup("a", null);
  assert.equal(h.get().sessionMeta.a.groupId, undefined);
  assert.equal(h.get().sessions[0], sessions[0]);
});

test("project deletion of a group or label never affects another project or a conversation", () => {
  const h = harness();
  h.get().setSessionGroups("group:logical-project", groups);
  h.get().moveSessionToGroup("a", "fix");
  h.get().setSessionGroups("group:logical-project", groups.slice(0, 1));
  assert.equal(h.get().sessionMeta.a.groupId, undefined);
  h.get().setProjectSessionLabels("group:logical-project", [{ id: "two", name: "Changed", color: "green" }]);
  assert.deepEqual(h.get().sessionMeta.a.labelIds, ["two"]);
  assert.deepEqual(h.get().sessionMeta.other, { labelIds: ["one"], color: "pink" });
  assert.equal(h.get().sessions.length, 5);
  assert.equal(h.get().sessionLabels[0].name, "Old label");
  h.get().markSession("a", { labelIds: ["one", "two"] });
  assert.deepEqual(h.get().sessionMeta.a.labelIds, ["two"]);
});

test("scoped catalogs, exclusive membership and legacy labels survive preference reload", async () => {
  const { loadSidebarPreferences, saveSidebarPreferences } = await import("../src/lib/sidebar-preferences.ts");
  const previous = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  try {
    const initial = loadSidebarPreferences();
    const label = { id: "local", name: "Only this project", color: "blue" };
    saveSidebarPreferences({ ...initial, sessionOrganization: { version: 1, scopes: { "group:logical-project": { groups, labels: [label] } } },
      sessionMeta: { a: { groupId: "fix", organizationScope: "group:logical-project", labelIds: ["local"], order: 4, pinned: true } } });
    const restored = loadSidebarPreferences();
    assert.deepEqual(restored.sessionOrganization.scopes["group:logical-project"], { groups, labels: [label] });
    assert.deepEqual(restored.sessionMeta.a, { groupId: "fix", organizationScope: "group:logical-project", labelIds: ["local"], order: 4, pinned: true });
    assert.deepEqual(restored.sessionLabels, initial.sessionLabels);
    saveSidebarPreferences({ ...restored, sessionOrganization: { version: 1, scopes: { "group:logical-project": { groups: [], labels: [] } } } });
    assert.deepEqual(loadSidebarPreferences().sessionOrganization.scopes["group:logical-project"], { groups: [], labels: [] });
  } finally {
    if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous;
  }
});

test("reorder stays inside a group but supports its logical project's multiple roots", async () => {
  const { reorderSession } = await import("../src/lib/session-activity-order.ts");
  const rows = [{ id: "a", projectPath: "D:/app" }, { id: "b", projectPath: "D:/plugins" }];
  const marks = { a: { groupId: "fix", order: 0 }, b: { groupId: "fix", order: 1 } };
  assert.equal(reorderSession(rows, marks, "b", "a", false, [project]).b.order, 0);
  assert.equal(reorderSession(rows, { ...marks, b: { groupId: "other", order: 1 } }, "b", "a", false, [project]), undefined);
});
