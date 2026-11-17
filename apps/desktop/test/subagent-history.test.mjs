import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { findSubagentHistoryPage, mergeSubagentHistory, subagentHistoryAddsContent } = await import("../src/features/delegations/subagent-history.ts");
const { transcriptViewFromSession, TRANSCRIPT_SEARCH_PAGE_SIZE } = await import("../src/lib/transcript-reading.ts");
const { buildSubagentTranscript } = await import("../src/lib/subagent-transcript.ts");

const message = (index, extra = {}) => ({ id: `m${index}`, role: "user", content: `Parent ${index}`, createdAt: new Date(1735689600000 + index * 1000).toISOString(), ...extra });
const task = (index, id = "a", resume) => message(index, { role: "tool", content: "", toolName: "Task", toolCallId: `call-${id}`, toolStatus: "success",
  toolArgs: { task: `Inspect ${id}`, ...(resume ? { resume } : {}) }, toolResult: { details: { delegationId: id, status: "completed" } } });
const child = (index, id = "a") => message(index, { role: "assistant", content: `Child ${index}`, parentToolCallId: `call-${id}` });
function fixture(taskIndex = 100) {
  const messages = Array.from({ length: 300 }, (_, i) => message(i));
  messages[taskIndex] = task(taskIndex);
  messages[taskIndex + 1] = child(taskIndex + 1);
  const page = (before) => ({ id: "s", messages: messages.slice(Math.max(0, before - 60), before),
    messageStart: Math.max(0, before - 60), messageEnd: before, hasMoreBefore: before > 60, hasMoreAfter: before < messages.length });
  const initial = transcriptViewFromSession(page(taskIndex + 31));
  const calls = [];
  return { messages, initial, page, calls, readPage: async before => { calls.push(before); return page(Math.min(before, messages.length)); } };
}
const find = (f, direction, options = {}) => findSubagentHistoryPage({ view: f.initial, direction, delegationId: "a", knownMessages: () => f.initial.messages,
  readPage: f.readPage, isCurrent: () => true, ...options });

test("parent history on both sides does not advertise more child content", async () => {
  const f = fixture();
  assert.equal(await find(f, "before"), null);
  assert.equal(await find(f, "after"), null);
  assert.ok(f.calls.length > 2, "Unrelated pages must be checked, not treated as child content");
});

test("already-visible live child rows do not create a redundant later button", async () => {
  const f = fixture();
  f.messages[190] = child(190);
  assert.equal(await find(f, "after", { knownMessages: () => mergeSubagentHistory(f.initial.messages, f.messages.slice(180)) }), null);
});

test("lookahead crosses unrelated/other-delegate pages and finds real later content", async () => {
  const f = fixture();
  f.messages[160] = task(160, "other");
  f.messages[161] = child(161, "other");
  f.messages[250] = child(250);
  const next = await find(f, "after");
  assert.ok(next);
  assert.deepEqual(f.calls, [191, 251]);
  assert.equal(subagentHistoryAddsContent(f.initial.messages, next.messages, "a"), true);
  assert.deepEqual(buildSubagentTranscript(next.messages, "a").turns[0].rows.map(row => row.message.id), ["m101", "m250"]);
});

test("a distant resumed Task is loadable even before it produces an answer", async () => {
  const f = fixture();
  f.messages[250] = task(250, "resumed", "a");
  const next = await find(f, "after");
  assert.equal(buildSubagentTranscript(next.messages, "a").turns.length, 2);
  assert.equal(subagentHistoryAddsContent(f.initial.messages, next.messages, "a"), true);
});

test("earlier scanning retains child rows until their distant original Task is found", async () => {
  const f = fixture(200);
  f.messages[200] = task(200, "resumed", "a");
  f.messages[201] = child(201, "resumed");
  f.messages[20] = task(20);
  f.messages[100] = child(100);
  f.initial = transcriptViewFromSession(f.page(231));
  const next = await find(f, "before", { delegationId: "resumed" });
  assert.ok(next);
  const result = buildSubagentTranscript(next.messages, "resumed");
  assert.equal(result.chainId, "call-a");
  assert.deepEqual(result.turns[0].rows.map(row => row.message.id), ["m100"]);
});

test("live arrival during a read skips a candidate already delivered to the panel", async () => {
  const f = fixture();
  f.messages[190] = child(190);
  let known = f.initial.messages;
  assert.equal(await find(f, "after", { knownMessages: () => known, readPage: async before => {
    known = mergeSubagentHistory(known, [f.messages[190]]);
    return f.readPage(before);
  } }), null);
});

test("lookahead propagates read failures and rejects a cursor that cannot advance", async () => {
  const f = fixture();
  await assert.rejects(find(f, "after", { readPage: async () => { throw Error("Read failed"); } }), /Read failed/);
  await assert.rejects(find(f, "after", { readPage: async () => undefined }), /Conversation unavailable/);
  for (const direction of ["before", "after"]) {
    await assert.rejects(find(f, direction, { readPage: async () => f.page(f.initial.messageEnd) }), /cursor did not advance/);
  }
});

test("cancellation stops scanning after the in-flight page without publishing a candidate", async () => {
  const f = fixture();
  f.messages[190] = child(190);
  let active = true;
  const next = await find(f, "after", { isCurrent: () => active, readPage: async before => { active = false; return f.readPage(before); } });
  assert.equal(next, null);
  assert.equal(f.calls.length, 1);
});

test("every lookahead request stays on the bounded physical-page contract", async () => {
  const f = fixture();
  await find(f, "after");
  assert.equal(f.calls[0], f.initial.messageEnd + TRANSCRIPT_SEARCH_PAGE_SIZE);
  assert.ok(f.calls.every((cursor, index) => index === 0 || cursor - f.calls[index - 1] === TRANSCRIPT_SEARCH_PAGE_SIZE));
});

test("long parent-only gaps do not repeatedly sort unrelated prose", async () => {
  const f = fixture();
  for (let i = 300; i < 2400; i++) {
    const parent = message(i);
    Object.defineProperty(parent, "createdAt", { get() { throw Error("Unrelated prose reached the transcript sorter"); } });
    f.messages.push(parent);
  }
  f.messages[2300] = child(2300);
  let yields = 0;
  const next = await find(f, "after", { yieldControl: async () => { yields++; } });
  assert.ok(yields >= 2, "Cached-page scanning must yield to input at bounded checkpoints");
  assert.deepEqual(buildSubagentTranscript(next.messages, "a").turns[0].rows.map(row => row.message.id), ["m101", "m2300"]);
  assert.equal(next.messages.some(message => message.id === "m400"), false);
});

test("disposal at a cooperative checkpoint prevents the next cached page read", async () => {
  const f = fixture();
  f.messages.push(...Array.from({ length: 2100 }, (_, i) => message(i + 300)));
  let active = true;
  const next = await find(f, "after", { isCurrent: () => active, yieldControl: async () => { active = false; } });
  assert.equal(next, null);
  assert.equal(f.calls.length, 16);
});

test("unrelated Task pages do not rebuild the selected chain", async () => {
  const f = fixture();
  for (let i = 300; i < 2400; i++) {
    const unrelated = i % 60 === 0 ? task(i, `other-${i}`) : message(i);
    Object.defineProperty(unrelated, "createdAt", { get() { throw Error("Unrelated Task page rebuilt the chain"); } });
    f.messages.push(unrelated);
  }
  assert.equal(await find(f, "after", { yieldControl: async () => {} }), null);
});
