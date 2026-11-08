import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createChildMessageController, childMessageOwner, CHILD_MESSAGE_LIMIT } = await import("../src/components/workpanel/child-message-controller.ts");
const { buildSubagentTranscript } = await import("../src/lib/subagent-transcript.ts");
const { subagentOutcome, summarizeSubagentActivity } = await import("../src/lib/subagent-topology.ts");
const target = { sessionId: "session-a", delegationId: "child-a" };
const owner = childMessageOwner(target.sessionId, "call-a");
const accepted = (delegationId = "child-a", delivery = "steered") => ({ accepted: true, turnId: "turn", delegationId, resumedFrom: "child-a", delivery });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test("child send preserves multiline input, locks double clicks, and clears only confirmed unchanged drafts", async () => {
  const c = createChildMessageController(() => "request-a");
  const wait = deferred();
  const requests = [];
  const send = request => { requests.push(request); return wait.promise; };
  c.edit(owner, "Review this\nwithout changing files.");
  const first = c.send(owner, target, send);
  await c.send(owner, target, send);
  assert.equal(requests.length, 1);
  assert.equal(c.get(owner).pending, true);
  assert.equal(c.get(owner).content, "Review this\nwithout changing files.");
  assert.deepEqual(requests[0], { ...target, messageId: "request-a", content: c.get(owner).content });
  wait.resolve(accepted());
  await first;
  assert.equal(c.get(owner).pending, false);
  assert.equal(c.get(owner).content, "");
});

test("transport retry retains the entire request even when an unconfirmed resume advanced the chain", async () => {
  let ids = 0;
  const c = createChildMessageController(() => `request-${++ids}`);
  const requests = [];
  c.edit(owner, "Continue the review");
  await c.send(owner, target, async request => { requests.push(request); throw new Error("bridge disconnected"); });
  assert.equal(c.get(owner).content, "Continue the review");
  assert.match(c.get(owner).error, /bridge disconnected/);
  await c.send(owner, { ...target, delegationId: "resumed-a" }, async request => { requests.push(request); return accepted("resumed-a", "duplicate"); });
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(ids, 1);
  assert.equal(c.get(owner).error, undefined);
});

test("editing after transport failure gives a new request identity and keeps the error visible", async () => {
  let ids = 0;
  const c = createChildMessageController(() => `request-${++ids}`);
  const requests = [];
  c.edit(owner, "First");
  await c.send(owner, target, async request => { requests.push(request); throw new Error("network"); });
  c.edit(owner, "Changed");
  assert.equal(c.get(owner).error, "network");
  await c.send(owner, target, async request => { requests.push(request); return accepted(); });
  assert.notEqual(requests[0].messageId, requests[1].messageId);
  assert.equal(requests[1].content, "Changed");
});

test("stale success/failure never clears newer text or another session/chain draft", async () => {
  for (const failure of [false, true]) {
    const c = createChildMessageController();
    const other = childMessageOwner("session-b", "call-b");
    c.edit(owner, "Sent");
    c.edit(other, "Other chain");
    const wait = deferred();
    const sending = c.send(owner, target, () => wait.promise);
    c.edit(owner, "Newer draft");
    failure ? wait.reject(new Error("connection")) : wait.resolve(accepted());
    await sending;
    assert.equal(c.get(owner).content, "Newer draft");
    assert.equal(c.get(other).content, "Other chain");
    assert.equal(c.get(owner).request, undefined);
  }
  const c = createChildMessageController();
  c.edit(owner, "Keep when away");
  await c.send(owner, target, async () => accepted(), () => false);
  assert.equal(c.get(owner).content, "Keep when away");
});

test("host rejection is not acceptance; blank/oversize input never invokes IPC", async () => {
  const c = createChildMessageController();
  let calls = 0;
  const send = async () => { calls++; return { accepted: false, turnId: "turn", resumedFrom: "child-a", error: "child unavailable" }; };
  for (const content of ["", " \n ", "x".repeat(CHILD_MESSAGE_LIMIT + 1)]) {
    c.edit(owner, content);
    await c.send(owner, target, send);
  }
  assert.equal(calls, 0);
  c.edit(owner, "x".repeat(CHILD_MESSAGE_LIMIT));
  await c.send(owner, target, send);
  assert.equal(calls, 1);
  assert.equal(c.get(owner).content.length, CHILD_MESSAGE_LIMIT);
  assert.equal(c.get(owner).error, "child unavailable");
});

test("a confirmed resume bridges the transcript delay, but never overrides a later real chain launch", async () => {
  const c = createChildMessageController();
  c.edit(owner, "Resume");
  await c.send(owner, target, async () => accepted("resumed-a", "resumed"));
  const requests = [];
  c.edit(owner, "Steer");
  await c.send(owner, target, async request => { requests.push(request); return accepted("resumed-a"); });
  assert.equal(requests[0].delegationId, "resumed-a");
  c.edit(owner, "New launch");
  await c.send(owner, { ...target, delegationId: "new-parent-launch" }, async request => { requests.push(request); return accepted("new-parent-launch"); });
  assert.equal(requests[1].delegationId, "new-parent-launch");
});

test("transcript chain resolves its newest call and persisted user rows without assistant attribution", () => {
  const call = (id, delegationId, resume) => ({ id, role: "tool", toolName: "Task", toolCallId: id,
    toolArgs: { task: id, ...(resume ? { resume } : {}) }, toolResult: { details: { delegationId, status: "completed" } } });
  const messages = [call("first", "old"), { id: "comment", role: "user", content: "Please inspect tests\nnot docs", parentToolCallId: "first", nestedParentToolCallId: "native-child" },
    call("latest", "current", "old"), { id: "response", role: "assistant", content: "Checked", parentToolCallId: "latest" },
    call("other", "unrelated")];
  for (const id of ["old", "current"]) {
    const transcript = buildSubagentTranscript(messages, id);
    assert.equal(transcript.chainId, "first");
    assert.equal(transcript.latestCall.toolCallId, "latest");
    assert.equal(transcript.turns[0].rows[0].kind, "user");
    assert.equal(transcript.turns[0].rows[0].message.id, "comment");
    assert.equal(transcript.turns[1].rows[0].kind, "answer");
  }
});

test("a skipped Task is not failed or running, and a later launch updates the same history", () => {
  const message = { role: "tool", toolName: "Task", toolStatus: "error", isError: true,
    toolResult: { details: {}, content: [{ type: "text", text: "Skipped because new user input is waiting." }] } };
  assert.equal(subagentOutcome(message), "not_started");
  const items = [{ kind: "tool", message }];
  assert.deepEqual(summarizeSubagentActivity(items), { total: 1, finished: 1, running: 0, issues: 0, warnings: 0 });
  items.push({ kind: "tool", message: { ...message, toolStatus: "running", isError: false } });
  assert.equal(summarizeSubagentActivity(items).running, 1);
});

test("interrupted retained children require an explicit send-and-resume instead of Continue", () => {
  const message = { role: "tool", toolName: "Task", toolStatus: "success",
    toolResult: { details: { delegationId: "recovered", status: "interrupted" } } };
  assert.equal(subagentOutcome(message), "aborted");
  assert.equal(subagentOutcome({ ...message, status: "aborted", toolStatus: "error", toolResult: undefined }), "aborted");
});
