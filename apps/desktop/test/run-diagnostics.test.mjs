import assert from "node:assert/strict";
import test from "node:test";
import { latestRunDiagnostics, runElapsedMs, runEventAgeMs } from "../src/lib/run-diagnostics.ts";

const baseline = {
  turnId: "turn-a", startedAt: 1000, requestCount: 1, attemptCount: 1, requestAttempt: 1,
  retryCount: 0, rateLimitRetries: 0, transientRetries: 0, retryWaitMs: 0,
};
const status = (runDiagnostics, currentTurnId = "turn-a") => ({ sessionId: "session-a", isRunning: true,
  currentTurnId, pendingToolConfirmations: 0, runDiagnostics });
const message = (runDiagnostics, extra = {}) => ({ id: "reply", role: "assistant", content: "", createdAt: "2026-11-06T00:00:00Z", runDiagnostics, ...extra });

test("whole-turn elapsed never restarts at request or retry boundaries", () => {
  assert.equal(runElapsedMs({ ...baseline, requestStartedAt: 6000, attemptStartedAt: 9000 }, 11000), 10000);
  assert.equal(runElapsedMs({ ...baseline, endedAt: 12000 }, 30000), 11000);
  assert.equal(runElapsedMs(baseline, 500), 0);
});

test("unknown event times stay unknown rather than claiming a provider heartbeat", () => {
  assert.equal(runEventAgeMs(undefined, baseline, 20000), undefined);
  assert.equal(runEventAgeMs(18000, baseline, 20000), 2000);
  assert.equal(runEventAgeMs(18000, { ...baseline, endedAt: 20000 }, 50000), 2000);
});

test("latest current-turn stream snapshot wins over sparse status, without importing delegates or history", () => {
  const newer = { ...baseline, lastEventAt: 9000 };
  assert.equal(latestRunDiagnostics(status(baseline), [message(newer)]), newer);
  assert.equal(latestRunDiagnostics(status(baseline), [message(newer, { parentToolCallId: "delegate" })]), baseline);
  assert.equal(latestRunDiagnostics(status(baseline), [message({ ...newer, turnId: "old-turn" })]), baseline);
  assert.equal(latestRunDiagnostics(status(baseline, "turn-b"), [message(newer)]), undefined);
  assert.equal(latestRunDiagnostics(undefined, [message(newer)]), undefined);
});

test("a new attempt's status supersedes a late earlier-attempt stream snapshot", () => {
  const nextAttempt = { ...baseline, attemptCount: 2, requestAttempt: 2, retryCount: 1, attemptStartedAt: 8000 };
  const late = { ...baseline, lastEventAt: 10000 };
  assert.equal(latestRunDiagnostics(status(nextAttempt), [message(late)]), nextAttempt);
});
