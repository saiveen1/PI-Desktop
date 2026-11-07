import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { groupSessionsByLabel, visibleLabelSessionIds, sessionLabelGroupKey } = await import("../src/lib/sidebar-label-groups.ts");

const labels = [
  { id: "investigation", name: "Investigation", color: "blue" },
  { id: "bug", name: "Bug", color: "red" },
  { id: "empty", name: "Empty", color: "green" },
];
const sessions = ["one", "two", "plain", "deleted-label"].map(id => ({ id, title: id }));
const meta = { one: { labelIds: ["investigation", "bug", "bug"] }, two: { labelIds: ["investigation"] }, "deleted-label": { labelIds: ["removed"] } };

test("label groups preserve source identity/order and repeat only multi-label entries", () => {
  const groups = groupSessionsByLabel(sessions, labels, meta);
  assert.deepEqual(groups.map(group => [group.label?.id ?? null, group.sessions.map(row => row.id)]), [
    ["investigation", ["one", "two"]], ["bug", ["one"]], [null, ["plain", "deleted-label"]],
  ]);
  assert.equal(groups[0].sessions[0], sessions[0]);
  assert.equal(groups[1].sessions[0], sessions[0]);
  assert.deepEqual(visibleLabelSessionIds(groups, "project", new Set()), ["one", "two", "plain", "deleted-label"]);
  const collapsed = new Set([sessionLabelGroupKey("project", "investigation")]);
  assert.deepEqual(visibleLabelSessionIds(groups, "project", collapsed), ["one", "plain", "deleted-label"]);
  collapsed.add(sessionLabelGroupKey("project", "bug"));
  assert.deepEqual(visibleLabelSessionIds(groups, "project", collapsed), ["plain", "deleted-label"]);
  assert.deepEqual(visibleLabelSessionIds(groups, "other", collapsed), ["one", "two", "plain", "deleted-label"]);
  assert.notEqual(sessionLabelGroupKey("project", null), sessionLabelGroupKey("project", ""));
  assert.deepEqual(groupSessionsByLabel([], labels, meta), []);
  assert.deepEqual(sessions.map(row => row.id), ["one", "two", "plain", "deleted-label"]);
});

test("sidebar label headers span separate rows and fold only their own entries", async (t) => {
  const ssr = await slotSsr(t);
  const { SidebarLabelGroups } = await ssr.load("/src/features/sessions/SidebarLabelGroups.tsx");
  let collapsed = new Set();
  const groups = groupSessionsByLabel(sessions, labels, meta);
  const render = () => ssr.render(createElement(SidebarLabelGroups, {
    groups, scope: "project", collapsed,
    onToggle: key => { collapsed = new Set(collapsed); collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key); },
    renderSessions: rows => rows.map(row => createElement("button", { key: row.id, "data-session-id": row.id }, row.title)),
  }));
  const before = render();
  assert.equal((before.match(/data-session-id="one"/g) ?? []).length, 2);
  assert.match(before, /aria-expanded="true"/);
  assert.match(before, /Unclassified/);
  assert.doesNotMatch(before, /session-label-chip|session-row-labels/);
  collapsed.add(sessionLabelGroupKey("project", "investigation"));
  const folded = render();
  assert.equal((folded.match(/data-session-id="one"/g) ?? []).length, 1);
  assert.doesNotMatch(folded, /data-session-id="two"/);
  assert.match(folded, /aria-expanded="false"/);
  // Removing all assignments makes the same conversation unclassified.
  const moved = groupSessionsByLabel(sessions, labels, {});
  assert.equal(moved.length, 1);
  assert.equal(moved[0].label, null);
  assert.equal(moved[0].sessions[0], sessions[0]);
});
