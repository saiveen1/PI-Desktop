import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

// The real persistence pass, driven directly with a stubbed outbox.
const { createSessionCoordination } = await import(
  "../electron/main/runtime/session-coordination.ts"
);
const { createEventPersistence } = await import(
  "../electron/main/runtime/event-persistence.ts"
);

const SESSION = "s1";
const TURN = "turn-1";

function fixture() {
  const activeTurns = new Map([[SESSION, TURN]]);
  const coordination = createSessionCoordination({
    activeTurns,
    getMainWindow: () => null,
    getViewingSessionId: () => null,
  });
  coordination.recordTurnStart(SESSION, TURN);
  const enqueued = [];
  const steeringReplies = new Set();
  const completionNoticeTurns = new Set();
  const usageCalls = [];
  const persistence = createEventPersistence({
    runtimeState: { host: null },
    steeringReplies,
    completionNoticeTurns,
    activeTurns,
    activeToolCalls: new Map(),
    activeToolCallKey: coordination.activeToolCallKey,
    approvedExecutionIdsBySession: new Map(),
    approvedExecutionTurns: new Map(),
    pendingExecutionFinishes: new Map(),
    planSubmissionTurnIds: new Set(),
    planSubmissionTurnKey: coordination.planSubmissionTurnKey,
    inflightCheckpointer: {
      observe() {},
      flush: async () => {},
      settle() {},
      settleIf() {},
    },
    persistenceOutbox: {
      size: () => 0,
      enqueue: async (entry) => {
        enqueued.push(entry);
      },
      flush: async () => undefined,
    },
    addActiveTurnUsage(...args) { usageCalls.push(args); },
    logger: { app() {} },
    finishTurn: () => Promise.resolve(),
    isStaleTerminalEvent: coordination.isStaleTerminalEvent,
    transcriptRewrite: coordination,
    finishApprovedExecution: async () => undefined,
    emitAgentEvent() {},
  });
  const persistAssistant = (message) =>
    persistence.persistAgentEvent({
      sessionId: SESSION,
      turnId: TURN,
      ts: 1,
      event: {
        type: "message_end",
        message: {
          role: "assistant",
          createdAt: "2026-10-20T00:00:00.000Z",
          ...message,
        },
      },
    });
  const persistSteering = () =>
    persistence.persistAgentEvent({
      sessionId: SESSION,
      turnId: TURN,
      ts: 1,
      event: {
        type: "message_end",
        message: {
          id: "steer-1",
          role: "user",
          content: "continue",
          createdAt: "2026-10-20T00:00:00.000Z",
          status: "complete",
          steering: true,
        },
      },
    });
  const persistAgentEnd = () =>
    persistence.persistAgentEvent({
      sessionId: SESSION,
      turnId: TURN,
      ts: 1,
      event: { type: "agent_end", messageIds: [] },
    });
  return { activeTurns, coordination, enqueued, steeringReplies, completionNoticeTurns, persistAssistant, persistSteering, persistAgentEnd, persistence, usageCalls };
}

test("an empty complete assistant message is not persisted", () => {
  const f = fixture();
  f.persistAssistant({ id: "m1", content: "", thinking: "", status: "complete" });
  assert.equal(f.enqueued.length, 0);
});

test("an empty aborted assistant message without an error is not persisted", () => {
  const f = fixture();
  f.persistAssistant({ id: "m2", content: "", thinking: "", status: "aborted" });
  assert.equal(f.enqueued.length, 0);
});

test("an empty assistant message that still carries a tool row is persisted", () => {
  const f = fixture();
  f.persistAssistant({
    id: "m3",
    content: "",
    thinking: "",
    status: "complete",
    toolName: "Grep",
    toolCallId: "call-1",
    toolStatus: "success",
  });
  assert.equal(f.enqueued.length, 1);
});

test("an empty call-only reply with provider replay data is persisted (#1972)", () => {
  // Gemini signs a function call on its own; a rebuilt runtime can only send
  // that signature back if the reply row that carries it is durable.
  const f = fixture();
  f.persistAssistant({
    id: "m3-signed",
    content: "",
    thinking: "",
    status: "complete",
    providerReplay: { version: 1, blocks: [], toolCalls: [{ id: "call-1", signature: "sig" }] },
  });
  assert.equal(f.enqueued.length, 1);
  assert.deepEqual(f.enqueued[0].message.providerReplay.toolCalls, [{ id: "call-1", signature: "sig" }]);
});

test("an empty assistant message with an error payload stays durable", () => {
  const f = fixture();
  f.persistAssistant({
    id: "m4",
    content: "",
    thinking: "",
    status: "error",
    error: { code: "PROVIDER_ERROR", message: "boom" },
  });
  assert.equal(f.enqueued.length, 1);
});

test("an output-limited answer keeps its text and truncation metadata in the outbox", () => {
  const f = fixture();
  f.persistAssistant({ id: "truncated", content: "Partial answer", status: "complete", outputTruncated: true });
  assert.equal(f.enqueued.length, 1);
  assert.equal(f.enqueued[0].message.content, "Partial answer");
  assert.equal(f.enqueued[0].message.outputTruncated, true);
});

test("an empty assistant message reserved for steering is persisted", () => {
  const f = fixture();
  f.steeringReplies.add("m5");
  f.persistAssistant({ id: "m5", content: "", thinking: "", status: "complete" });
  assert.equal(f.enqueued.length, 1);
});

test("a trusted completion notice persists only its first empty complete reply", () => {
  const f = fixture();
  f.completionNoticeTurns.add(TURN);
  f.persistAssistant({ id: "completion-1", content: "", thinking: "", status: "complete" });
  assert.equal(f.enqueued.length, 1);
  assert.equal(f.completionNoticeTurns.has(TURN), false);

  f.persistAssistant({ id: "completion-2", content: "", thinking: "", status: "complete" });
  assert.equal(f.enqueued.length, 1);
});

test("a visible or tool-batch completion reply spends the empty-row exception", () => {
  for (const reply of [
    { id: "visible", content: "done", status: "complete" },
    { id: "tool", content: "", status: "complete", toolName: "Read", toolCallId: "call-1" },
  ]) {
    const f = fixture();
    f.completionNoticeTurns.add(TURN);
    f.persistAssistant(reply);
    f.persistAssistant({ id: `${reply.id}-empty`, content: "", status: "complete" });
    assert.equal(f.enqueued.length, 1);
    assert.equal(f.completionNoticeTurns.has(TURN), false);
  }
});

test("provider error retries keep the completion notice allowance", () => {
  const f = fixture();
  f.completionNoticeTurns.add(TURN);
  f.persistAssistant({
    id: "retry-error",
    content: "",
    status: "error",
    error: { code: "PROVIDER_ERROR", message: "retry" },
  });
  assert.equal(f.enqueued.length, 1);
  assert.equal(f.completionNoticeTurns.has(TURN), true);

  f.persistAssistant({ id: "retry-complete", content: "", status: "complete" });
  assert.equal(f.enqueued.length, 2);
  assert.equal(f.completionNoticeTurns.has(TURN), false);
});

test("accepted user steering revokes the completion notice allowance", () => {
  const f = fixture();
  f.completionNoticeTurns.add(TURN);
  f.persistSteering();
  assert.equal(f.completionNoticeTurns.has(TURN), false);

  f.persistAssistant({ id: "after-steering", content: "", status: "complete" });
  assert.equal(f.enqueued.length, 1);
});

test("turn settlement clears an unused completion notice allowance", () => {
  const f = fixture();
  f.completionNoticeTurns.add(TURN);
  f.persistAgentEnd();
  assert.equal(f.completionNoticeTurns.has(TURN), false);
});

test("a stale turn cannot leave an unused completion notice allowance behind", () => {
  const f = fixture();
  f.completionNoticeTurns.add(TURN);
  f.coordination.beginTranscriptRewrite(SESSION).commit();
  f.persistAssistant({ id: "stale", content: "", status: "complete" });
  assert.equal(f.enqueued.length, 0);
  assert.equal(f.completionNoticeTurns.has(TURN), false);
});

test("a non-empty complete assistant message is persisted", () => {
  const f = fixture();
  f.persistAssistant({ id: "m6", content: "done", status: "complete" });
  assert.equal(f.enqueued.length, 1);
});

test("a final diagnostic refresh queues only metadata without settling usage twice", () => {
  const f = fixture();
  const message = { id: "diagnostic-answer", role: "assistant", content: "done", status: "complete",
    createdAt: "2026-11-06T00:00:00Z", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } };
  f.persistAssistant(message);
  const runDiagnostics = { turnId: TURN, startedAt: 1000, endedAt: 3000,
    requestCount: 1, attemptCount: 2, requestAttempt: 2, retryCount: 1,
    rateLimitRetries: 1, transientRetries: 0, retryWaitMs: 500 };
  f.persistence.persistAgentEvent({ sessionId: SESSION, turnId: TURN, ts: 3000,
    event: { type: "message_update", message: { ...message, runDiagnostics } } });
  const rows = f.enqueued.filter(entry => entry.message);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].key, rows[1].key);
  assert.equal(rows[1].turnId, TURN);
  assert.deepEqual(rows[1].message, {
    id: message.id, role: message.role, createdAt: message.createdAt, content: "",
    runDiagnostics: { ...runDiagnostics, refreshOnly: true },
  });
  assert.equal(f.usageCalls.length, 1);
  f.activeTurns.set(SESSION, "new-turn");
  f.coordination.recordTurnStart(SESSION, "new-turn");
  f.persistence.persistAgentEvent({ sessionId: SESSION, turnId: TURN, ts: 4000,
    event: { type: "message_update", message: { ...message, runDiagnostics } } });
  assert.equal(f.enqueued.filter(entry => entry.message).length, 2);
});

test("intermediate observer updates are queued separately from the settled row and its usage", () => {
  const f = fixture();
  const message = { id: "observed", role: "assistant", content: "First answer", status: "complete",
    createdAt: "2026-11-06T00:00:00Z", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, operationId: "request-1" } };
  f.persistAssistant(message);
  const update = (status, { turnId = TURN, messageId = message.id, parentToolCallId, stream } = {}) => {
    const runDiagnostics = { turnId: TURN, startedAt: 1000, observer: {
      messageId, mode: "guard", status, startedAt: 1900,
      ...(status === "assessed" ? { endedAt: 2000, continued: true } : {}),
    } };
    f.persistence.persistAgentEvent({ sessionId: SESSION, turnId, ts: 2000, parentToolCallId,
      event: { type: "message_update", stream, message: { ...message, runDiagnostics } } });
  };
  update("checking");
  update("assessed");
  update("assessed", { messageId: "different-message" });
  update("assessed", { turnId: "different-turn" });
  update("assessed", { parentToolCallId: "delegate" });
  update("assessed", { stream: "delta" });
  f.persistAssistant({ ...message, id: "continuation", content: "Continued answer", usage: undefined });

  const rows = f.enqueued.filter(entry => entry.message);
  assert.deepEqual(rows.map(entry => entry.message.id), ["observed", "observed", "observed", "continuation"]);
  assert.equal(new Set(rows.map(entry => entry.key)).size, rows.length);
  assert.deepEqual(rows.slice(1, 3).map(entry => entry.message.runDiagnostics.observer.status), ["checking", "assessed"]);
  for (const row of rows.slice(1, 3)) {
    assert.equal(row.turnId, TURN);
    assert.equal(row.message.content, "");
    assert.equal(row.message.usage, undefined);
  }
  assert.equal(f.usageCalls.length, 1);
  assert.equal(f.enqueued.filter(entry => entry.usage).length, 1);
});

test("an otherwise empty assistant retains its exact observer skip but not foreign metadata", () => {
  const f = fixture();
  const runDiagnostics = { turnId: TURN, startedAt: 1, observer: { messageId: "empty-observed", mode: "guard", status: "skipped", startedAt: 1, endedAt: 1, skipReason: "empty_response" } };
  f.persistAssistant({ id: "empty-observed", content: "", status: "complete", runDiagnostics });
  assert.equal(f.enqueued.length, 1);
  assert.deepEqual(f.enqueued[0].message.runDiagnostics, runDiagnostics);
  f.persistAssistant({ id: "other-empty", content: "", status: "complete", runDiagnostics });
  assert.equal(f.enqueued.length, 1);
});

test("a late Stop assessment retains a previously filtered tool-only reply", async () => {
  const f = fixture();
  const base = { id: "tool-only", role: "assistant", content: "", status: "complete", createdAt: "2026-01-01T00:00:00Z", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, runDiagnostics: { turnId: TURN, startedAt: 1000 } };
  f.persistAssistant(base);
  assert.equal(f.enqueued.filter(entry => entry.message).length, 0);
  const observer = { messageId: base.id, mode: "guard", status: "skipped", startedAt: 2000, endedAt: 2000, skipReason: "stop_requested" };
  f.persistence.persistAgentEvent({ sessionId: SESSION, turnId: TURN, ts: 2000, event: { type: "message_update", message: { ...base, runDiagnostics: { ...base.runDiagnostics, observer } } } });
  await f.persistence.flush();
  const rows = f.enqueued.filter(entry => entry.message);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].message, base);
  assert.deepEqual(rows[1].message.runDiagnostics.observer, observer);
  assert.equal(f.usageCalls.length, 1);
});
