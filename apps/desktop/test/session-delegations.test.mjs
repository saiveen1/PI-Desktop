import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionDelegationsSource } = await import("../src/features/delegations/session-delegations-source.ts");
const { sessionDelegationTasks } = await import("../src/features/delegations/session-delegation-tasks.ts");
const entry = (id, status = "running", sessionId = "one") => ({
  id, messageId: `m-${id}`, sessionId, sessionTitle: sessionId, delegationId: id, agentName: "reviewer",
  description: `Review ${id}`, task: "Check results", status, createdAt: "2026-11-12T10:00:00.000Z",
});
const task = (id, status = "running") => ({ id: `m-${id}`, role: "tool", toolCallId: `call-${id}`, toolName: "Task",
  createdAt: "2026-11-12T10:00:00.000Z", content: "", toolStatus: "success", toolArgs: { description: `Review ${id}` },
  toolResult: { details: { delegationId: id, status } },
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(setImmediate);

test("session projection merges history beyond the chat window and excludes lifecycle/child tools", () => {
  const result = sessionDelegationTasks("one", [entry("old", "completed"), entry("a"), entry("foreign", "running", "two")],
    [task("a"), { ...task("child"), parentToolCallId: "call-a" }, { ...task("wait"), toolName: "TaskWait" }], true);
  assert.equal(result.total, 2);
  assert.equal(result.active, 1);
  assert.deepEqual(new Set(result.tasks.map(item => item.message.id)), new Set(["m-old", "m-a"]));
});

test("terminal history wins over stale live running evidence; ended parent cannot remain active", () => {
  const result = sessionDelegationTasks("one", [entry("a", "completed"), entry("b", "failed")], [task("a"), task("b")], true);
  assert.equal(result.active, 0);
  assert.equal(result.attention, 1);
  assert.equal(result.statuses.get("a"), "completed");
  assert.equal(sessionDelegationTasks("one", [entry("a")], [task("a")], false).active, 0);
});

test("creating calls do not inflate running count or disappear from the task index", () => {
  const pending = { ...task("pending"), toolResult: undefined, toolStatus: "running" };
  const result = sessionDelegationTasks("one", [], [pending, task("live")], true);
  assert.equal(result.active, 1); assert.equal(result.starting, 1); assert.equal(result.total, 2);
});

test("source shares one subscription, traverses filtered empty pages and guards the session boundary", async () => {
  let subscriptions = 0, unsubscriptions = 0;
  const calls = [];
  const source = createSessionDelegationsSource({
    onAgentEvent: () => { subscriptions++; return () => { unsubscriptions++; }; },
    listDelegationHistory: async query => {
      calls.push(query);
      return query.offset === 0 ? { entries: [], nextOffset: 100 } : { entries: [entry("a"), entry("foreign", "completed", "two")], nextOffset: null };
    },
  }, "one");
  const first = source.retain(), second = source.retain();
  await tick();
  assert.deepEqual(calls.map(query => [query.sessionId, query.offset]), [["one", 0], ["one", 100]]);
  assert.equal(source.getSnapshot().entries.length, 1);
  assert.equal(source.getSnapshot().loading, false);
  assert.equal(subscriptions, 1);
  first(); assert.equal(unsubscriptions, 0);
  second(); second(); assert.equal(unsubscriptions, 1);
});

test("an older request cannot replace a newer refresh or publish after disposal", async () => {
  const requests = [];
  const source = createSessionDelegationsSource({
    onAgentEvent: () => () => {},
    listDelegationHistory: () => { const next = deferred(); requests.push(next); return next.promise; },
  }, "one");
  const release = source.retain();
  const refresh = source.reload();
  requests[1].resolve({ entries: [entry("a", "completed")], nextOffset: null }); await refresh;
  requests[0].resolve({ entries: [entry("a")], nextOffset: null }); await tick();
  assert.equal(source.getSnapshot().entries[0].status, "completed");
  const late = source.reload(); release();
  const snapshot = source.getSnapshot();
  requests[2].resolve({ entries: [entry("late")], nextOffset: null }); await late;
  assert.equal(source.getSnapshot(), snapshot);
});

test("bad pagination and read failures stay visible rather than claiming empty success", async () => {
  const source = createSessionDelegationsSource({
    onAgentEvent: () => () => {}, listDelegationHistory: async () => ({ entries: [], nextOffset: 0 }),
  }, "one");
  const release = source.retain(); await tick();
  assert.equal(source.getSnapshot().error, true);
  assert.equal(source.getSnapshot().loading, false);
  release();
});

test("only relevant same-session lifecycle events refresh; an in-flight stale page cannot publish", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let listener;
  const reads = [];
  const source = createSessionDelegationsSource({
    onAgentEvent: fn => { listener = fn; return () => {}; },
    listDelegationHistory: () => { const read = deferred(); reads.push(read); return read.promise; },
  }, "one");
  const release = source.retain();
  listener({ sessionId: "two", event: { type: "agent_end" } });
  listener({ sessionId: "one", event: { type: "tool_end", toolCallId: "read", result: {} } });
  t.mock.timers.tick(100); assert.equal(reads.length, 1);
  listener({ sessionId: "one", event: { type: "tool_start", toolCallId: "task", toolName: "Task" } });
  listener({ sessionId: "one", event: { type: "tool_end", toolCallId: "task", result: {} } });
  reads[0].resolve({ entries: [entry("stale")], nextOffset: null }); await tick();
  assert.equal(source.getSnapshot().entries.length, 0);
  t.mock.timers.tick(100);
  reads[1].resolve({ entries: [entry("done", "completed")], nextOffset: null }); await tick();
  assert.equal(source.getSnapshot().entries[0].status, "completed");
  listener({ sessionId: "one", event: { type: "tool_end", toolCallId: "late", result: { details: { delegationId: "late" } } } });
  release(); t.mock.timers.tick(100);
  assert.equal(reads.length, 2);
  assert.equal(source.getSnapshot().entries.length, 0);
});

test("session index uses its own singleton tab without replacing detail or other session tabs", async () => {
  const { subagentsWorkPanelTab, subagentWorkPanelTab, openWorkPanelTabState, switchWorkPanelContextState, emptyWorkPanelContext } = await import("../src/lib/work-panel-tabs.ts");
  let tabs = openWorkPanelTabState(emptyWorkPanelContext(), subagentWorkPanelTab("a"));
  tabs = openWorkPanelTabState(tabs, subagentsWorkPanelTab());
  tabs = openWorkPanelTabState(tabs, subagentsWorkPanelTab());
  assert.equal(tabs.tabs.length, 2); assert.equal(tabs.activeTabId, "subagents");
  const other = switchWorkPanelContextState({}, "one", { ...tabs, open: true, fileRequest: null }, "two");
  assert.equal(other.visible.tabs.length, 0);
  assert.equal(other.contexts.one.tabs.length, 2);
});

test("all shipped locales translate the session index and its explicit counts", async () => {
  const { catalogs } = await import("../../../packages/i18n/src/index.ts");
  for (const [locale, catalog] of Object.entries(catalogs)) {
    for (const key of ["indexLabel", "indexTitle", "runningCount", "pendingCount", "startingCount", "historyCount", "statusUnavailable", "loading", "emptySession"]) {
      assert.equal(typeof catalog.subagentControls[key], "string", `${locale}: ${key}`);
    }
  }
});

test("a creation interrupted before receiving a handle is not left active after settlement", async () => {
  const { groupSubagentTasks } = await import("../src/lib/subagent-task-presentation.ts");
  const pending = { ...task("pending"), toolStatus: "running", toolResult: undefined };
  const result = sessionDelegationTasks("one", [], [pending], false);
  assert.equal(result.active, 0); assert.equal(result.starting, 0);
  assert.equal(groupSubagentTasks(result.tasks, result.statuses).active.length, 0);
  assert.equal(pending.toolStatus, "running", "Projection must not rewrite original evidence");
});

test("a stale creation snapshot cannot discard a durable handle or terminal outcome", () => {
  const creating = { ...task("a"), toolStatus: "running", toolResult: undefined };
  const result = sessionDelegationTasks("one", [entry("a", "completed")], [creating], true);
  assert.equal(result.starting, 0); assert.equal(result.active, 0); assert.equal(result.total, 1);
  assert.equal(result.tasks[0].message.toolResult.details.delegationId, "a");
  assert.equal(result.statuses.get("a"), "completed");
});

test("settlement message_end refreshes tasks outside the loaded transcript without waiting for parent completion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let listener, reads = 0;
  const source = createSessionDelegationsSource({
    onAgentEvent: fn => { listener = fn; return () => {}; },
    listDelegationHistory: async () => ({ entries: [entry("old", ++reads === 1 ? "running" : "completed")], nextOffset: null }),
  }, "one");
  const release = source.retain(); await tick();
  listener({ sessionId: "one", event: { type: "message_end", message: task("old", "completed") } });
  t.mock.timers.tick(100); await tick();
  assert.equal(reads, 2); assert.equal(source.getSnapshot().entries[0].status, "completed");
  release();
});
