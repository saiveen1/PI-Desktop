import { describe, expect, it } from "vitest";
import { RunDiagnosticsTracker } from "./run-diagnostics-tracker.js";

describe("RunDiagnosticsTracker", () => {
  it("retains whole-turn retry evidence across recovery while resetting the next logical request", () => {
    const tracker = new RunDiagnosticsTracker({
      turnId: "turn-a",
      startedAt: 1_000,
      infiniteRetry: true,
    });

    tracker.startRequest({
      at: 1_010,
      inputTokens: 123,
      contextWindow: 8_192,
    });
    const firstAttempt = tracker.startAttempt(1_011);
    tracker.observeProviderEvent(firstAttempt, { kind: "text", hasNewText: true }, 1_020);
    tracker.recordRetry({
      at: 1_030,
      code: "NETWORK_ERROR",
      networkCode: "ECONNRESET",
    });

    expect(tracker.snapshot(1_045)).toMatchObject({
      turnId: "turn-a",
      startedAt: 1_000,
      requestCount: 1,
      attemptCount: 1,
      requestAttempt: 1,
      retryCount: 1,
      transientRetries: 1,
      rateLimitRetries: 0,
      retryWaitMs: 15,
      requestStartedAt: 1_010,
      attemptStartedAt: 1_011,
      lastTextAt: 1_020,
      infiniteRetry: true,
      lastRetry: { at: 1_030, code: "NETWORK_ERROR", networkCode: "ECONNRESET" },
    });

    const recoveredAttempt = tracker.startAttempt(1_050);
    tracker.observeProviderEvent(firstAttempt, { kind: "thinking" }, 1_051);
    tracker.observeProviderEvent(recoveredAttempt, { kind: "thinking" }, 1_052);

    expect(tracker.snapshot(1_052)).toMatchObject({
      requestCount: 1,
      attemptCount: 2,
      requestAttempt: 2,
      retryWaitMs: 20,
      lastEventAt: 1_052,
      lastTextAt: 1_020,
      lastEventKind: "thinking",
      phase: "thinking",
    });

    tracker.startRequest({ at: 1_100, inputTokens: 456, contextWindow: 16_384 });
    const toolFollowUp = tracker.startAttempt(1_101);
    tracker.observeProviderEvent(toolFollowUp, { kind: "tool" }, 1_102);
    expect(tracker.snapshot(1_102).phase).toBe("generating");
    tracker.startTool();
    expect(tracker.snapshot(1_103).lastEventAt).toBe(1_102);
    const final = tracker.finish(1_120);

    expect(final).toMatchObject({
      requestCount: 2,
      attemptCount: 3,
      requestAttempt: 1,
      retryCount: 1,
      transientRetries: 1,
      retryWaitMs: 20,
      inputTokens: 456,
      contextWindow: 16_384,
      phase: "tool",
      lastEventKind: "other",
      endedAt: 1_120,
    });
  });

  it("reports only elapsed retry wait and retains sanitized retry metadata on cancellation", () => {
    const tracker = new RunDiagnosticsTracker({ turnId: "turn-b", startedAt: 5_000 });
    tracker.startRequest({ at: 5_001 });
    tracker.startAttempt(5_002);
    tracker.recordRetry({
      at: 5_010,
      code: "raw provider prose is never retained",
      providerStatus: 503,
      networkCode: "unexpected detail",
    });

    expect(tracker.snapshot(5_035)).toMatchObject({
      retryWaitMs: 25,
      retryCount: 1,
      transientRetries: 1,
      lastRetry: { at: 5_010, code: "UNKNOWN", providerStatus: 503 },
    });
    expect(tracker.finish(5_040)).toMatchObject({ retryWaitMs: 30, endedAt: 5_040 });
  });
});

it("rejects abandoned events during backoff and freezes wait time at cancellation", () => {
  const tracker = new RunDiagnosticsTracker({ turnId: "cancelled", startedAt: 1000 });
  tracker.startRequest({ at: 1001 });
  const attempt = tracker.startAttempt(1002);
  tracker.recordRetry({ at: 1010, code: "NETWORK_ERROR" });
  expect(tracker.observeProviderEvent(attempt, { kind: "text", hasNewText: true }, 1020)).toBe(false);
  tracker.stopRetryWait(1030);
  const final = tracker.finish(1100);
  expect(final.retryWaitMs).toBe(20);
  expect(final.lastTextAt).toBeUndefined();
  expect(tracker.observeProviderEvent(attempt, { kind: "thinking" }, 1200)).toBe(false);
  expect(tracker.snapshot(1300)).toEqual(final);
});
