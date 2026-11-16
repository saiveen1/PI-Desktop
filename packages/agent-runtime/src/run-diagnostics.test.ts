import { describe, expect, it } from "vitest";
import { RunDiagnosticsTracker } from "./run-diagnostics-tracker.js";
import { diagnosticsForMessage, normalizedStopReason } from "./run-diagnostics.js";

describe("normalized response termination", () => {
  it.each(["stop", "length", "toolUse", "error", "aborted", "unknown"] as const)("retains normalized %s without inventing provider evidence", stopReason => {
    const tracker = new RunDiagnosticsTracker({ turnId: "turn", startedAt: 1 });
    tracker.startRequest({ at: 2, maxOutputTokens: 512 });
    tracker.settleResponse("bubble", { stopReason, usage: { output: 17 } }, 1);
    expect(tracker.finish(3).termination).toEqual({ messageId: "bubble", stopReason, reasonSource: "normalized", outputTokens: 17, maxOutputTokens: 512, recoveryAttempts: 1 });
    expect(normalizedStopReason("provider-private-reason")).toBe("unknown");
  });

  it("supports finishTurn annotations after message_end and isolates snapshots by exact bubble", () => {
    const tracker = new RunDiagnosticsTracker({ turnId: "turn", startedAt: 1 });
    tracker.startRequest({ at: 2 });
    tracker.settleResponse("earlier", { stopReason: "stop" }, 0);
    const beforeFinishTurn = tracker.snapshot(3);
    expect(tracker.annotateEarlyEnd("future", "suspected", 0)).toBe(false);
    expect(tracker.annotateEarlyEnd("earlier", "recovering", 1)).toBe(true);
    expect(beforeFinishTurn.termination?.earlyEnd).toBeUndefined();
    const recovering = tracker.snapshot(4);
    expect(diagnosticsForMessage(recovering, "earlier").termination?.earlyEnd).toBe("recovering");
    expect(diagnosticsForMessage(recovering, "future").termination).toBeUndefined();
    tracker.startRequest({ at: 5 });
    expect(tracker.snapshot(5).termination).toBeUndefined();
    tracker.settleResponse("final", { stopReason: "stop" }, 1);
    expect(tracker.annotateEarlyEnd("final", "exhausted", 1)).toBe(true);
    const final = tracker.finish(6);
    expect(final.termination).toMatchObject({ messageId: "final", earlyEnd: "exhausted", recoveryAttempts: 1 });
    expect(diagnosticsForMessage(final, "earlier").termination).toBeUndefined();
    expect(tracker.annotateEarlyEnd("final", "suspected", 0)).toBe(false);
    tracker.settleResponse("future", { stopReason: "error" }, 2);
    expect(tracker.snapshot(7)).toEqual(final);
  });

  it("never turns normalized length/error/abort into an early warning or retains invalid token counts", () => {
    const tracker = new RunDiagnosticsTracker({ turnId: "turn", startedAt: 1 });
    tracker.startRequest({ at: 2, maxOutputTokens: Number.NaN });
    for (const stopReason of ["length", "error", "aborted"]) {
      tracker.settleResponse("bubble", { stopReason, usage: { output: -1 } }, 0);
      expect(tracker.annotateEarlyEnd("bubble", "suspected", 0)).toBe(false);
      expect(tracker.snapshot(3).termination).toEqual({ messageId: "bubble", stopReason, reasonSource: "normalized", recoveryAttempts: 0 });
    }
  });

  it("records the current attempt's repaired output cap rather than an earlier request cap", () => {
    const tracker = new RunDiagnosticsTracker({ turnId: "turn", startedAt: 1 });
    tracker.startRequest({ at: 2, maxOutputTokens: 1024 });
    tracker.setOutputLimit(256);
    tracker.settleResponse("bubble", { stopReason: "stop", usage: { output: 12 } }, 0);
    expect(tracker.finish(3).termination?.maxOutputTokens).toBe(256);
    tracker.setOutputLimit(512);
    expect(tracker.snapshot(4).termination?.maxOutputTokens).toBe(256);
  });
});
