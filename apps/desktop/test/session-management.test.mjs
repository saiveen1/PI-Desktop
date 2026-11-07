import assert from "node:assert/strict";
import test from "node:test";
import { reorderSession, activityOrder } from "../src/lib/session-activity-order.ts";
import { matchesSessionFilter } from "../src/lib/session-labels.ts";
import { delegationSelectionSummary } from "../src/lib/delegation-selection-summary.ts";
import {
  loadSidebarPreferences,
  saveSidebarPreferences,
  sortSessions,
} from "../src/lib/sidebar-preferences.ts";

const row = (id, updatedAt = "2026-11-01T10:00:00Z") => ({
  id, title: id, projectPath: "/project", mode: "agent",
  createdAt: "2026-11-01T09:00:00Z", updatedAt,
});

test("filtered reorder preserves hidden siblings, pin boundaries and other projects", () => {
  const rows = [row("a"), row("hidden"), row("b"), { ...row("other"), projectPath: "/other" }];
  const meta = { a: { order: 0 }, hidden: { order: 1 }, b: { order: 2 }, other: { order: 3 } };
  const moved = reorderSession(rows, meta, "b", "a");
  assert.deepEqual(activityOrder(rows, moved), ["b", "a", "hidden", "other"]);
  assert.equal(reorderSession(rows, moved, "other", "a"), undefined);
  assert.equal(reorderSession(rows, { ...moved, a: { ...moved.a, pinned: true } }, "b", "a"), undefined);
  assert.equal(matchesSessionFilter({ labelIds: ["fix"], color: "red" }, { labelIds: ["fix", "review"], color: "red" }), true);
  assert.equal(matchesSessionFilter({ labelIds: ["fix"], color: "blue" }, { labelIds: ["fix"], color: "red" }), false);
});

test("historical selection separates original rationale from actual fallback decisions", () => {
  const result = delegationSelectionSummary({ modelId: "fallback", scheduling: {
    requestedModel: "p/expert", modelReason: "Concurrency review", decisions: [
      { model: "p/expert", decision: "skipped", reason: "Approval expired" },
      { model: "p/fallback", decision: "selected", reason: "Automatically authorized" },
    ],
  } });
  assert.equal(result.modelReason, "Concurrency review");
  assert.equal(result.requestedModel, "p/expert");
  assert.equal(result.actualModel, "p/fallback");
  assert.equal(delegationSelectionSummary({ modelId: "old" }).modelReason, undefined);
});

test("recent conversation order survives assistant updates and explicit sorts remain independent", () => {
  const rows = [row("z"), row("a", "2026-11-04T10:00:00Z"), row("b")];
  const meta = { z: { order: 0 }, a: { order: 1 }, b: { order: 2 } };
  assert.deepEqual(sortSessions(rows, meta, "recent").map(item => item.id), ["z", "a", "b"]);
  rows[2].updatedAt = "2026-11-06T10:00:00Z";
  assert.deepEqual(sortSessions(rows, meta, "recent").map(item => item.id), ["z", "a", "b"]);
  assert.deepEqual(sortSessions(rows, meta, "name").map(item => item.id), ["a", "b", "z"]);
});

test("global label catalog and independent conversation marks survive preference reload", () => {
  const values = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  try {
    const initial = loadSidebarPreferences();
    assert.equal(initial.sessionLabels.length, 3);
    saveSidebarPreferences({
      ...initial,
      sessionLabels: [{ id: "custom", name: "Review", color: "green" }],
      sessionMeta: { a: { order: 4, labelIds: ["custom"], color: "red" } },
      sessionFilter: { labelIds: ["custom"], color: "red" },
    });
    const restored = loadSidebarPreferences();
    assert.deepEqual(restored.sessionLabels, [{ id: "custom", name: "Review", color: "green" }]);
    assert.deepEqual(restored.sessionMeta.a, { order: 4, labelIds: ["custom"], color: "red" });
    assert.deepEqual(restored.sessionFilter, { labelIds: ["custom"], color: "red" });
    saveSidebarPreferences({ ...restored, sessionLabels: [] });
    assert.deepEqual(loadSidebarPreferences().sessionLabels, [], "deleted defaults must not reappear");
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});
