import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { subagentTaskTitle, subagentTaskTone, groupSubagentTasks } = await import("../src/lib/subagent-task-presentation.ts");
const { subagentTurnEntry } = await import("../src/lib/subagent-turn-entry.ts");
const { buildSubagentTranscript } = await import("../src/lib/subagent-transcript.ts");
const { cachedActivityIssues } = await import("../src/lib/transcript-activity-summary.ts");
const { catalogs } = await import("../../../packages/i18n/src/index.ts");
const task = (id, status = "running", extra = {}) => ({ kind: "tool", message: {
  id: `message-${id}`, toolCallId: `call-${id}`, role: "tool", toolName: "Task", content: "", status: "complete",
  createdAt: "2026-11-08T09:00:00Z", toolStatus: "success", toolArgs: { agent: "explorer", description: `Task ${id}` },
  toolResult: { details: { delegationId: id, status, modelId: "test-model", thinkingLevel: "high" } }, ...extra,
} });

test("task identity and title are independent of list position and result arrival", () => {
  const item = task("a");
  assert.equal(subagentTaskTitle(item.message), "Task a");
  assert.equal(subagentTaskTitle({ ...item.message, toolArgs: { agent: "reader", description: " " } }), "reader");
  assert.equal(subagentTaskTitle({ ...item.message, toolArgs: null }, "fallback"), "fallback");
  assert.equal(subagentTaskTone(item.message), subagentTaskTone({ ...item.message, toolResult: undefined }));
  assert.ok(subagentTaskTone(item.message) >= 0 && subagentTaskTone(item.message) < 4);
});

test("task grouping deduplicates snapshots and never calls interrupted work completed", () => {
  const latest = task("a", "completed");
  const groups = groupSubagentTasks([task("a"), task("b", "failed"), latest, task("c"), task("d", "stopped")]);
  assert.deepEqual(groups.active.map(item => item.message.toolCallId), ["call-c"]);
  assert.deepEqual(groups.completed, [latest]);
  assert.equal(groups.attention.length, 2);
  assert.equal(groupSubagentTasks([task("a")], new Map([["a", "failed"]])).attention.length, 1);
});

test("delegate projection preserves chronology, object identity, and both thinking and answer", () => {
  const thought = { id: "thinking", role: "assistant", content: "", thinking: "reasoning" };
  const answer = { id: "answer", role: "assistant", content: "Result" };
  const rows = [{ kind: "thinking", message: thought }, task("a"), { kind: "answer", message: answer }];
  const entry = subagentTurnEntry("delegate-turn", rows);
  assert.deepEqual(entry.parts.map(part => part.kind), ["activity", "message"]);
  assert.equal(entry.parts[0].items[0].message, thought);
  assert.equal(entry.parts[1].message, answer);
  assert.equal(rows.length, 3);
});

test("closed-summary error counts do not reparse unchanged payloads", () => {
  let reads = 0;
  const message = { ...task("a").message, toolName: "Bash", get toolResult() { reads++; return { details: { exitCode: 1 } }; } };
  assert.equal(cachedActivityIssues([{ kind: "tool", message }]), 1);
  reads = 0;
  assert.equal(cachedActivityIssues([{ kind: "tool", message }]), 1);
  assert.equal(reads, 0);
});

test("new task labels are present in every shipped locale", () => {
  for (const [locale, catalog] of Object.entries(catalogs)) {
    for (const key of ["active", "attention", "completed", "back", "brief"]) {
      assert.equal(typeof catalog.chat.taskGroups[key], "string", `${locale}: ${key}`);
    }
  }
});

test("production task list and thinking render the compact defaults", async (t) => {
  const ssr = await slotSsr(t);
  const { SubagentTaskList } = await ssr.load("/src/features/chat/transcript/SubagentTaskList.tsx");
  const { ActivityGroup } = await ssr.load("/src/features/chat/transcript/ActivityGroup.tsx");
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  useAppStore.setState({ settings: { showThinking: true }, activeSessionId: "session-1" });
  const items = [task("a"), task("b", "completed"), task("c", "failed")];
  const html = ssr.render(createElement(SubagentTaskList, { items, grouped: true }));
  const inline = ssr.render(createElement(SubagentTaskList, { items }));
  assert.doesNotMatch(inline, /<h3|Needs attention/);
  assert.ok(inline.indexOf("Task b") < inline.indexOf("Task c"), "inline tasks preserve event order");
  assert.match(html, /Task a/);
  assert.match(html, /Needs attention/);
  assert.match(html, /data-outcome="failed"/);
  assert.doesNotMatch(html, /test-model|topology|coordinator|processingSteps/);
  const thinking = { kind: "thinking", message: { id: "reasoning", role: "assistant", content: "", thinking: "Private detail", status: "streaming", createdAt: "2026-11-08T09:00:00Z" } };
  const group = ssr.render(createElement(ActivityGroup, { items: [thinking], isActive: true, turnActive: true }));
  assert.match(group, /aria-expanded="false"/);
  assert.doesNotMatch(group, /Private detail/);
  const failed = { kind: "tool", message: { ...task("failed").message, toolName: "Bash", toolStatus: "error" } };
  const summary = ssr.render(createElement(ActivityGroup, { items: [thinking, failed], isActive: true, turnActive: true }));
  assert.match(summary, /tool-row-status error/);
  assert.match(summary, /aria-expanded="false"/);
});

test("an open task selection follows the latest resumed handle and survives initial result arrival", () => {
  const first = task("first", "completed").message;
  const resumed = task("resumed").message;
  resumed.toolArgs = { ...resumed.toolArgs, resume: "first" };
  assert.equal(buildSubagentTranscript([first], first.toolCallId).latestCall, first);
  const chain = buildSubagentTranscript([first, resumed], "first");
  assert.equal(chain.turns.length, 2);
  assert.equal(chain.latestCall, resumed);
});

test("task details do not retain a running status after their parent settles", async (t) => {
  const ssr = await slotSsr(t);
  const { SubagentTranscriptTab } = await ssr.load("/src/components/workpanel/SubagentTranscriptTab.tsx");
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  const initial = useAppStore.getInitialState();
  const previous = { ...initial };
  t.after(() => Object.assign(initial, previous));
  Object.assign(initial, { activeSessionId: "session-1", messages: [task("a").message], runningSessions: { "session-1": false } });
  const stopped = ssr.render(createElement(SubagentTranscriptTab, { delegationId: "a" }));
  assert.doesNotMatch(stopped, /aria-label="Stop Task a"/);
  Object.assign(initial, { runningSessions: { "session-1": true } });
  assert.match(ssr.render(createElement(SubagentTranscriptTab, { delegationId: "a" })), /aria-label="Stop Task a"/);
});
