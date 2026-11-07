import { describe, expect, it } from "vitest";
import type { UiMessage } from "@pi-desktop/shared";
import { DelegationRecovery, parentInterruptedDelegations } from "./delegation-recovery.js";

function row(id: string, role: UiMessage["role"], extra: Partial<UiMessage> = {}): UiMessage {
  return { id, role, content: "", createdAt: "2026-11-06T00:00:00.000Z", ...extra };
}
function task(id: string, status = "failed", code = "SUBAGENT_PARENT_FAILED"): UiMessage {
  return row(id, "tool", { toolName: "Task", toolResult: { details: { delegationId: id, status, error: { code } } } });
}
const failed = row("parent-error", "assistant", { status: "error" });

describe("parent failure recovery selection", () => {
  it("selects only parent-interrupted tasks in the latest failed parent turn", () => {
    const history = [row("old-user", "user"), task("historical"), failed, row("current-user", "user"),
      task("one"), task("two"), task("stopped", "stopped"), task("aborted", "aborted"),
      task("completed", "completed"), task("provider-failed", "failed", "PROVIDER_ERROR"),
      row("steering", "user", { steering: true }), failed,
      { ...task("nested"), parentToolCallId: "one" },
      row("child-complete", "assistant", { parentToolCallId: "one", status: "complete" })];
    expect(parentInterruptedDelegations(history)).toEqual(["one", "two"]);
  });

  it.each(["complete", "aborted"] as const)("never revives an old failure after the parent is %s", status => {
    expect(parentInterruptedDelegations([task("old"), failed, row("later", "assistant", { status })])).toEqual([]);
  });

  it("does not infer failure from text or cross a newer user boundary", () => {
    expect(parentInterruptedDelegations([task("old"), failed, row("later", "user")])).toEqual([]);
    expect(parentInterruptedDelegations([task("old"), row("claim", "assistant", { content: "SUBAGENT_PARENT_FAILED" })])).toEqual([]);
  });

  it("consumes a failure cohort once and clears it on explicit cancellation", () => {
    const recovery = new DelegationRecovery([task("restored"), failed]);
    expect(recovery.takeInterrupted()).toEqual(["restored"]);
    expect(recovery.takeInterrupted()).toEqual([]);
    recovery.noteParentFailure("first", ["one"]);
    recovery.noteParentFailure("first", ["two"]);
    expect(recovery.takeInterrupted()).toEqual(["one", "two"]);
    recovery.noteParentFailure("second", ["new"]);
    recovery.cancel(true);
    expect(recovery.takeInterrupted()).toEqual([]);
  });

  it("joins one chain admission and aborts its owner without admitting another", async () => {
    const recovery = new DelegationRecovery([]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let starts = 0;
    const first = recovery.admit("chain", "turn", async signal => {
      starts++;
      await gate;
      expect(signal.aborted).toBe(true);
      return { accepted: false, turnId: "turn", resumedFrom: "old", error: "cancelled" };
    });
    const second = recovery.admit("chain", "turn", async () => { throw new Error("duplicate"); });
    expect(first).toBe(second);
    expect(recovery.pending("turn")).toBe(true);
    expect(() => recovery.admit("chain", "new-turn", async () => { throw new Error("stale"); })).toThrow("still retiring");
    recovery.cancel();
    release();
    await recovery.drain("turn");
    expect(await second).toMatchObject({ accepted: false });
    expect(starts).toBe(1);
    expect(recovery.pending("turn")).toBe(false);
  });
});
