import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { subagentTaskTitle, subagentTaskTone, groupSubagentTasks, subagentTaskOutcome, subagentTaskStatusKey } = await import("../src/lib/subagent-task-presentation.ts");
const { subagentTurnEntry, subagentTurnEntries } = await import("../src/lib/subagent-turn-entry.ts");
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
  assert.deepEqual(groups.attention.map(item => item.message.toolCallId), ["call-b"]);
  assert.deepEqual(groups.history.map(item => item.message.toolCallId), ["call-d"]);
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

test("child user input splits assistant reading segments without changing roles or disclosure identities", () => {
  const thought = { kind: "thinking", message: { id: "thought", role: "assistant", thinking: "Before input" } };
  const answer = { kind: "answer", message: { id: "answer", role: "assistant", content: "Before answer" } };
  const user = { kind: "user", message: { id: "input", role: "user", content: "Check tests\nfirst" } };
  const after = { kind: "answer", message: { id: "after", role: "assistant", content: "After answer" } };
  const last = { kind: "user", message: { id: "last", role: "user", content: "One more point" } };
  const entries = subagentTurnEntries("chain-turn", [thought, answer, user, task("edit"), after, last]);
  assert.deepEqual(entries.map(entry => entry.kind), ["assistant-turn", "message", "assistant-turn", "message"]);
  assert.equal(entries[1].message, user.message);
  assert.equal(entries[3].message, last.message);
  assert.equal(entries[0].parts[1].message, answer.message);
  assert.equal(entries[2].parts[1].message, after.message);
  assert.equal(subagentTurnEntries("chain-turn", [thought, answer, user, after])[2].id, entries[2].id);
  assert.deepEqual(subagentTurnEntries("chain-turn", [user, last]).map(entry => entry.message), [user.message, last.message]);
  assert.deepEqual(subagentTurnEntries("chain-turn", []), []);
});

test("task lists retain not-started history outside active and completed groups", () => {
  const skipped = task("skip", "running", { toolStatus: "error", toolResult: {
    content: [{ type: "text", text: "Skipped because new user input is waiting." }], details: {},
  } });
  assert.equal(subagentTaskOutcome(skipped.message), "not_started");
  assert.equal(subagentTaskStatusKey(skipped.message), "subagentControls.notStarted");
  const groups = groupSubagentTasks([skipped, task("live"), task("done", "completed")]);
  assert.equal(groups.active.length, 1);
  assert.equal(groups.completed.length, 1);
  assert.deepEqual(groups.attention, []);
  assert.deepEqual(groups.history, [skipped]);
  assert.equal(cachedActivityIssues([skipped]), 0);
});

test("shared child reading keeps user input visible between assistant responses without parent actions", async (t) => {
  const ssr = await slotSsr(t);
  const { SubagentTurnContent } = await ssr.load("/src/features/chat/transcript/SubagentTurnContent.tsx");
  const rows = [
    { kind: "answer", message: { id: "before", role: "assistant", content: "Before input" } },
    { kind: "user", message: { id: "input", role: "user", content: "Review tests\nfirst" } },
    { kind: "answer", message: { id: "after", role: "assistant", content: "After input" } },
  ];
  const html = ssr.render(createElement(SubagentTurnContent, { id: "child", rows, active: true }));
  assert.match(html, /class="message-row user" data-message-id="input"/);
  assert.ok(html.indexOf("Before input") < html.indexOf("Review tests"));
  assert.ok(html.indexOf("Review tests") < html.indexOf("After input"));
  assert.doesNotMatch(html, /aria-label="(?:Edit message|Delete message|Regenerate)"/);
  const waiting = ssr.render(createElement(SubagentTurnContent, {
    id: "waiting-child", rows: [task("prior"), rows[1]], active: true,
  }));
  assert.doesNotMatch(waiting, /class="turn-process[^\"]* active/);
  assert.match(waiting, /class="message-row user" data-message-id="input"/);
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
  assert.match(html, /test-model/);
  assert.match(html, /Effort: high/);
  assert.doesNotMatch(html, /topology|coordinator|processingSteps/);
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
