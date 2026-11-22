import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { matchingObserver, observerContinuationProgress, observerMessages, observerDecisionKey, observerSummaryKey } = await import("../src/lib/observer-guard-presentation.ts");

const checking = { messageId: "a", mode: "guard", status: "checking", startedAt: 1 };
const assessed = { ...checking, status: "assessed", endedAt: 2, verdict: "incomplete", continued: false, continuationReason: "tool_error" };
const message = { id: "a", role: "assistant", runDiagnostics: { turnId: "turn", observer: assessed } };

test("terminal observer evidence survives late checking and unrelated live responses", () => {
  assert.equal(matchingObserver(message, checking), assessed);
  assert.equal(matchingObserver(message, { ...checking, messageId: "b" }), assessed);
  assert.equal(matchingObserver({ id: "b", runDiagnostics: message.runDiagnostics }), undefined);
  const latest = { ...assessed, startedAt: 3, endedAt: 4 };
  assert.equal(matchingObserver(message, latest), latest);
});

test("shared-cap exhaustion shows the reason without a bogus per-turn zero counter", () => {
  for (const mode of ["endless", "guard"]) {
    const exhausted = { messageId: "a", mode, status: "assessed", continued: false, continuationReason: "continuation_limit", continuationCount: 0, maxContinuations: 2 };
    const owner = { id: "a", runDiagnostics: { observer: exhausted } };
    assert.equal(observerDecisionKey(matchingObserver(owner)), "observerGuard.continuationReasons.continuation_limit");
    assert.equal(observerContinuationProgress(matchingObserver(owner)), undefined);
    assert.equal(observerContinuationProgress(matchingObserver(owner, exhausted)), undefined);
    assert.equal(exhausted.continuationCount, 0);
  }
});

test("turn summary collects an intermediate record once and excludes delegate leakage", () => {
  const parts = [
    { kind: "activity", items: [{ kind: "thinking", message }] },
    { kind: "message", message },
    { kind: "message", message: { id: "final", role: "assistant" } },
    { kind: "message", message: { ...message, parentToolCallId: "task" } },
  ];
  assert.deepEqual(observerMessages(parts), [message]);
  assert.equal(observerMessages([{ kind: "message", message: { ...message, parentToolCallId: "task" } }]).length, 0);
  assert.equal(observerMessages([{ kind: "message", message: { id: "final", role: "assistant" } }], checking).length, 0);
});

test("specific decisions never fabricate missing historical reasons or unknown enum translations", () => {
  assert.equal(observerDecisionKey(assessed), "observerGuard.continuationReasons.tool_error");
  assert.equal(observerSummaryKey(assessed), "observerGuard.summary.notContinued");
  assert.equal(observerDecisionKey({ ...assessed, continuationReason: undefined }), "observerGuard.legacyReason");
  assert.equal(observerDecisionKey({ ...assessed, continuationReason: "invented" }), "observerGuard.legacyReason");
  assert.equal(observerDecisionKey({ ...checking, status: "skipped", skipReason: "response_length" }), "observerGuard.skipReasons.response_length");
  assert.equal(observerDecisionKey({ ...checking, status: "skipped", skipReason: "invented" }), "observerGuard.legacyReason");
  assert.equal(observerDecisionKey({ ...checking, status: "error", errorCode: "invented" }), "observerGuard.errors.unknown");
  assert.equal(observerDecisionKey(checking, true), "observerGuard.interruptedHint");
  assert.equal(observerDecisionKey({ ...assessed, continued: true }), "observerGuard.notReassessed");
});

test("new decisions and lifecycle reasons do not imply reviewer use in Endless", () => {
  const current = { ...checking, status: "assessed", decision: "continue", continued: true, continuationCount: 1, maxContinuations: 3 };
  assert.equal(observerDecisionKey(current), "observerGuard.decisions.continue");
  assert.equal(observerDecisionKey({ ...current, mode: "endless" }), "observerGuard.noReviewer");
  for (const reason of ["continuation_limit", "decision_stop", "user_input_pending"]) {
    assert.equal(observerDecisionKey({ ...current, continued: false, continuationReason: reason }), `observerGuard.continuationReasons.${reason}`);
  }
});

test("transcript keeps an empty assessed response without reviving ordinary empty bubbles", async () => {
  const { buildTranscriptEntries } = await import("../src/lib/assistant-turns.ts");
  const empty = { ...message, content: "", createdAt: "2026-01-01T00:00:00Z", status: "complete" };
  assert.equal(buildTranscriptEntries([empty]).entries.length, 1);
  assert.equal(buildTranscriptEntries([{ ...empty, runDiagnostics: undefined }]).entries.length, 0);
  assert.equal(buildTranscriptEntries([{ ...empty, id: "foreign" }]).entries.length, 0);
});
