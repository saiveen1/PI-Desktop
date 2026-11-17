import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VISIBLE_PROJECT_SESSION_COUNT,
  expandSessionGroup,
  paginateSessionGroups,
  resetSessionGroupExpansion,
} from "../src/lib/sidebar-project-sessions.ts";
import { groupSessionsByGroup, sessionGroupKey, visibleGroupedSessionIds } from "../src/lib/session-organization.ts";

const scope = "project:/app";
const groups = [{ id: "large", name: "Large", color: "blue" }, { id: "small", name: "Small", color: "green" }];
const sessions = Array.from({ length: 30 }, (_, index) => ({ id: String(index) }));
const meta = Object.fromEntries(sessions.map((session, index) => [session.id, {
  groupId: index < 12 ? "large" : index < 16 ? "small" : undefined,
}]));
const grouped = groupSessionsByGroup(sessions, groups, meta);
const lengths = rows => rows.map(row => [row.sessions.length, row.visibleSessions.length]);

test("each group retains its complete count and receives its own first page", () => {
  const page = paginateSessionGroups(grouped);
  assert.deepEqual(lengths(page), [[12, 10], [4, 4], [14, 10]]);
  assert.deepEqual(page[1].visibleSessions, sessions.slice(12, 16));
  assert.equal(page[0].sessions, grouped[0].sessions);
  assert.equal(page[0].visibleSessions.length, DEFAULT_VISIBLE_PROJECT_SESSION_COUNT);
  const visible = visibleGroupedSessionIds(page, scope, new Set([sessionGroupKey(scope, "large")]));
  assert.equal(visible.length, 20);
  for (const id of ["10", "11", "12", "15", "26", "29"]) assert.ok(!visible.includes(id));
  assert.deepEqual(grouped.map(row => row.visibleSessions), [undefined, undefined, undefined]);
});

test("loading more affects only its group and collapsing a project resets only its scope", () => {
  const initial = {};
  let expanded = expandSessionGroup(initial, scope, "large");
  expanded = expandSessionGroup(expanded, "project:/other", "large");
  assert.deepEqual(lengths(paginateSessionGroups(grouped, expanded[scope])), [[12, 12], [4, 4], [14, 10]]);
  expanded = expandSessionGroup(expanded, scope, "");
  assert.deepEqual(lengths(paginateSessionGroups(grouped, expanded[scope])), [[12, 12], [4, 4], [14, 14]]);
  const toggled = new Set(groups.map(group => sessionGroupKey(scope, group.id)));
  assert.equal(visibleGroupedSessionIds(paginateSessionGroups(grouped, expanded[scope]), scope, toggled).length, 30);
  const reset = resetSessionGroupExpansion(expanded, scope);
  assert.equal(reset[scope], undefined);
  assert.equal(reset["project:/other"].large, true);
  assert.equal(expanded[scope].large, true);
  assert.deepEqual(initial, {});
  assert.deepEqual(lengths(paginateSessionGroups(grouped, reset[scope])), [[12, 10], [4, 4], [14, 10]]);
});
