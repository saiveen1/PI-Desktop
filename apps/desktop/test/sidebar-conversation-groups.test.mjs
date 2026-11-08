import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { groupSessionsByGroup, sessionGroupKey } = await import("../src/lib/session-organization.ts");
const groups = [{ id: "investigation", name: "Investigation", color: "blue" }, { id: "empty", name: "Empty", color: "green" }];
const rows = ["one", "plain"].map(id => ({ id, title: id }));
const meta = { one: { groupId: "investigation", labelIds: ["a", "b"] } };

test("sidebar groups render multi-label conversations once, keep empty groups and exclude folded rows", async t => {
  const ssr = await slotSsr(t, { translationOverrides: { sessionGroups: { manage: "Manage…", ungrouped: "Ungrouped" } } });
  const { SidebarSessionGroups } = await ssr.load("/src/features/sessions/SidebarSessionGroups.tsx");
  const collapsed = new Set();
  const render = () => ssr.render(createElement(SidebarSessionGroups, {
    groups: groupSessionsByGroup(rows, groups, meta), scope: "project", collapsed, onToggle() {}, onManage() {},
    renderSessions: sessions => sessions.map(row => createElement("button", { key: row.id, "data-session-id": row.id }, row.title)),
  }));
  const html = render();
  assert.equal((html.match(/data-session-id="one"/g) ?? []).length, 1);
  assert.match(html, /Manage…/);
  assert.match(html, /Ungrouped/);
  assert.match(html, /data-sidebar-session-group="empty"/);
  assert.doesNotMatch(html, /data-sidebar-label-group/);
  collapsed.add(sessionGroupKey("project", "investigation"));
  const folded = render();
  assert.doesNotMatch(folded, /data-session-id="one"/);
  assert.match(folded, /aria-expanded="false"/);
  assert.match(folded, /data-session-id="plain"/);
});

test("labels render as bounded descriptive chips, never conversation containers", async t => {
  const ssr = await slotSsr(t);
  const { SessionLabelChips } = await ssr.load("/src/features/sessions/SessionLabelControls.tsx");
  const labels = ["A", "B", "C"].map((name, index) => ({ id: String(index), name, color: "#1a8acc" }));
  const html = ssr.render(createElement(SessionLabelChips, { labels, meta: { labelIds: ["0", "1", "2", "removed"] } }));
  assert.equal((html.match(/class="badge /g) ?? []).length, 2);
  assert.match(html, /\+1/);
  assert.match(html, /background-color:#1a8acc/);
  assert.doesNotMatch(html, /aria-expanded|data-sidebar-session-group|<button/);
});

test("row menu moves membership independently from multi-label marking", async t => {
  const ssr = await slotSsr(t);
  const { sessionGroupMenu, sessionMarkMenu } = await ssr.load("/src/features/sessions/SessionLabelControls.tsx");
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  useAppStore.setState({ sessions: [{ id: "one", projectPath: "/app" }], sessionMeta: { one: { labelIds: ["a"] } },
    sessionLabels: [{ id: "a", name: "Alpha", color: "blue" }, { id: "b", name: "Beta", color: "green" }],
    sessionOrganization: { version: 1, scopes: { "project:/app": { groups, labels: [{ id: "a", name: "Alpha", color: "blue" }, { id: "b", name: "Beta", color: "green" }] } } }, sidebarProjectGroups: [],
  });
  const translate = key => key;
  let managed = 0;
  const groupMenu = sessionGroupMenu("one", groups, {}, translate, () => managed++);
  groupMenu.items.find(item => item.id === "session-group-investigation").onSelect();
  const marks = sessionMarkMenu("one", useAppStore.getState().sessionLabels, useAppStore.getState().sessionMeta.one, translate, () => managed++);
  marks[0].items.find(item => item.id === "session-label-b").onSelect();
  assert.equal(useAppStore.getState().sessionMeta.one.groupId, "investigation");
  assert.deepEqual(useAppStore.getState().sessionMeta.one.labelIds, ["a", "b"]);
  groupMenu.items.find(item => item.id === "session-group-none").onSelect();
  assert.equal(useAppStore.getState().sessionMeta.one.groupId, undefined);
  assert.deepEqual(useAppStore.getState().sessionMeta.one.labelIds, ["a", "b"]);
  groupMenu.items.find(item => item.id === "manage-session-groups").onSelect();
  assert.equal(managed, 1);
});

test("the production sidebar keeps running rows and complete status counts across both folder roots", async t => {
  const ssr = await slotSsr(t, { plugins: [{
    name: "ssr-notification-boundary", enforce: "pre",
    transform(code, id) {
      if (!id.replaceAll("\\", "/").endsWith("/stores/runtime/notification-runtime.ts")) return;
      // Native notifications are outside this sidebar test; SSR needs a snapshot.
      const next = code.replace("    () => pendingSnapshot,", "    () => pendingSnapshot,\n    () => pendingSnapshot,");
      assert.notEqual(next, code, "notification subscription fixture must match the production edge");
      return next;
    },
  }] });
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  const { Sidebar } = await ssr.load("/src/components/Sidebar.tsx");
  const roots = [{ path: "/app", name: "App", position: 0 }, { path: "/plugins", name: "Plugins", position: 1 }];
  const sessions = Array.from({ length: 12 }, (_, index) => ({ id: `root-${index}`, title: `Conversation ${index}`, projectPath: roots[index % 2].path,
    mode: "agent", createdAt: "2026-11-08T10:00:00Z", updatedAt: "2026-11-08T10:00:00Z" }));
  const sessionMeta = Object.fromEntries(sessions.map((session, index) => [session.id, {
    order: index, groupId: index === 11 || index === 1 ? "investigation" : undefined,
    ...(index === 0 ? { pinned: true, labelIds: ["a", "b"] } : {}),
  }]));
  useAppStore.setState({ sessions, openProjectPaths: ["/app", "/plugins"], openProjects: roots.map(root => ({ path: root.path, name: root.name })),
    workspace: { path: "/app", name: "Combined" }, activeProjectPath: "/app", sessionMeta,
    runningSessions: { "root-11": true }, pendingPermissions: { "root-0": [{}] },
    sessionOutcomes: { "root-1": "completed", "root-10": "failed" },
    settings: { ...useAppStore.getState().settings, sidebarRunningIndicators: true, sidebarRunningBadge: true },
    projectMeta: {}, projectCollapsed: {}, sessionOrganization: { version: 1, scopes: { "group:combined": { groups, labels: [
      { id: "a", name: "Alpha", color: "blue" }, { id: "b", name: "Beta", color: "green" },
    ] } } }, sidebarProjectGroups: [{ id: "combined", name: "Combined", primaryPath: "/app", roots }],
  });
  // Zustand SSR reads its initial snapshot, not later bootstrap updates.
  const render = () => {
    Object.assign(useAppStore.getInitialState(), useAppStore.getState());
    return ssr.render(createElement(Sidebar, { onToggleSidebar() {}, sidebarToggleShortcut: "Ctrl+B", sidebarWidth: 300,
      onWidthChange() {}, onWidthCommit() {}, onResizeCollapse() {} }));
  };
  const html = render();
  assert.equal((html.match(/data-sidebar-project-group=/g) ?? []).length, 1);
  assert.equal((html.match(/data-sidebar-session-row="root-0"/g) ?? []).length, 1);
  assert.equal((html.match(/data-sidebar-session-row="root-1"/g) ?? []).length, 1);
  assert.equal((html.match(/data-sidebar-session-row="root-11"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /data-sidebar-session-row="root-10"/);
  assert.ok(html.indexOf('data-sidebar-session-row="root-11"') < html.indexOf('data-sidebar-session-row="root-1"'));
  const assertCounts = markup => {
    for (const state of ["running", "waiting", "completed", "failed"]) {
      assert.match(markup, new RegExp(`class="project-run-badge ${state}"[^>]*>[\\s\\S]*?</span>1</span>`), state);
    }
  };
  assertCounts(html);
  assert.match(html, /2 folders/);
  assert.match(html, /data-group-scope="group:combined"/);
  assert.doesNotMatch(html, /data-sidebar-label-group|session-filter-menu/);
  useAppStore.setState({ projectCollapsed: { "/app": true } });
  const folded = render();
  assert.match(folded, /is-collapsed/);
  assertCounts(folded);
  assert.deepEqual(useAppStore.getState().sessionMeta, sessionMeta);
  useAppStore.setState({ runningSessions: {}, projectCollapsed: {} });
  const idle = render();
  assert.doesNotMatch(idle, /data-sidebar-session-row="root-11"/);
  assert.match(idle, /data-sidebar-session-row="root-10"/);
});
