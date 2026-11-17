import assert from "node:assert/strict";
import { createElement } from "react";
import test from "node:test";
import { slotSsr } from "./helpers/slot-ssr.mjs";

test("project groups count all members and page independently on the first render", async t => {
  const ssr = await slotSsr(t, { plugins: [{
    name: "ssr-notification-boundary", enforce: "pre",
    transform(code, id) {
      if (!id.replaceAll("\\", "/").endsWith("/stores/runtime/notification-runtime.ts")) return;
      const next = code.replace("    () => pendingSnapshot,", "    () => pendingSnapshot,\n    () => pendingSnapshot,");
      assert.notEqual(next, code);
      return next;
    },
  }] });
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  const { Sidebar } = await ssr.load("/src/components/Sidebar.tsx");
  const sessions = Array.from({ length: 20 }, (_, index) => ({
    id: `session-${index}`, title: `Conversation ${index}`, projectPath: "/app",
    mode: "agent", createdAt: "2026-11-08T10:00:00Z", updatedAt: "2026-11-08T10:00:00Z",
  }));
  const groups = [
    { id: "large", name: "Large", color: "blue" },
    { id: "gateway", name: "Gateway", color: "green" },
    { id: "empty", name: "Empty", color: "red" },
  ];
  const sessionMeta = Object.fromEntries(sessions.map((session, index) => [session.id, {
    order: index, groupId: index < 12 ? "large" : index < 16 ? "gateway" : undefined,
  }]));
  useAppStore.setState({
    sessions, sessionMeta, openProjectPaths: ["/app"], openProjects: [{ path: "/app", name: "App" }],
    workspace: { path: "/app", name: "App" }, activeProjectPath: "/app",
    runningSessions: {}, pendingPermissions: {}, sessionOutcomes: {},
    projectMeta: {}, projectCollapsed: {}, sidebarProjectGroups: [],
    sessionOrganization: { version: 1, scopes: { "project:/app": { groups, labels: [] } } },
  });
  const render = () => {
    Object.assign(useAppStore.getInitialState(), useAppStore.getState());
    return ssr.render(createElement(Sidebar, { onToggleSidebar() {}, sidebarToggleShortcut: "Ctrl+B", sidebarWidth: 300,
      onWidthChange() {}, onWidthCommit() {}, onResizeCollapse() {} }));
  };
  const html = render();
  const headings = [...html.matchAll(/class="sidebar-conversation-group-name">([^<]*)<\/span><span class="sidebar-conversation-group-count">(\d+)<\/span>/g)];
  assert.deepEqual(headings.map(([, name, count]) => [name, Number(count)]), [
    ["Large", 12], ["Gateway", 4], ["Empty", 0], ["Ungrouped", 4],
  ]);
  for (const index of [0, 9, 12, 13, 14, 15, 16, 19]) assert.match(html, new RegExp(`data-sidebar-session-row="session-${index}"`));
  for (const index of [10, 11]) assert.doesNotMatch(html, new RegExp(`data-sidebar-session-row="session-${index}"`));
  assert.equal((html.match(/class="[^"]*sidebar-load-more/g) ?? []).length, 1);
  assert.deepEqual(useAppStore.getState().sessionMeta, sessionMeta);
  assert.equal(useAppStore.getState().sessions.length, 20);
  assert.equal(render(), html, "an unchanged refresh must not alter counts or visible rows");
});
