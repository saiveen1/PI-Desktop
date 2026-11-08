import { describe, expect, it } from "vitest";
import { MAX_REVEAL_PROGRESS_GRACES, MutationRecoveryGuard } from "./mutation-recovery-guard.js";

const overloaded = { ok: false, errorCode: "HOST_OVERLOADED", content: {} };
const ok = { ok: true, content: {} };
const edit = { owner: "parent", toolName: "Edit", path: "file", pathKey: "file" };
const reveal = (lines: number[], extra: Record<string, unknown> = {}) => ({
  ok: false, errorCode: "EDIT_LINES_UNSEEN", content: {
    merged: true, revealTruncated: false, unseenCount: lines.length,
    unseenLines: lines.map(line => ({ line, text: `line ${line}`, clipped: false })), ...extra,
  },
});

describe("separate admission and reveal recovery", () => {
  it("does not forgive an overloaded writer for reads or a different owner's success", () => {
    const guard = new MutationRecoveryGuard();
    for (let i = 0; i < 2; i++) expect(guard.observe({ ...edit, result: overloaded })).toBeUndefined();
    guard.observe({ ...edit, toolName: "Read", result: ok });
    guard.observe({ ...edit, owner: "child", result: ok });
    expect(guard.observe({ ...edit, pathKey: "another", result: overloaded })).toMatchObject({ kind: "host-admission" });
    guard.clear("parent");
    expect(guard.observe({ ...edit, result: overloaded })).toBeUndefined();
  });

  it("resets admission after a successful operation in the same class", () => {
    const guard = new MutationRecoveryGuard();
    guard.observe({ ...edit, result: overloaded });
    guard.observe({ ...edit, result: overloaded });
    guard.observe({ ...edit, toolName: "Write", result: ok });
    expect(guard.observe({ ...edit, result: overloaded })).toBeUndefined();
    expect(guard.observe({ ...edit, result: overloaded })).toBeUndefined();
    expect(guard.observe({ ...edit, result: overloaded })).toMatchObject({ kind: "host-admission" });
  });

  it("keeps admission counters independent across owners and ignores cancelled/denied calls", () => {
    const guard = new MutationRecoveryGuard();
    for (const result of [{ ...overloaded, denied: true }, { ...overloaded, errorCode: "TOOL_ABORTED" }]) {
      for (let i = 0; i < 4; i++) expect(guard.observe({ ...edit, result })).toBeUndefined();
    }
    for (let i = 0; i < 2; i++) guard.observe({ ...edit, owner: "child", result: overloaded });
    guard.clear("parent");
    expect(guard.observe({ ...edit, result: overloaded })).toBeUndefined();
    expect(guard.observe({ ...edit, owner: "child", result: overloaded })).toMatchObject({ kind: "host-admission" });
  });

  it("does not treat reordered or repeated lines as new context", () => {
    const guard = new MutationRecoveryGuard();
    expect(guard.observe({ ...edit, result: reveal([1, 2]) })).toBeUndefined();
    expect(guard.observe({ ...edit, result: reveal([2, 1]) })).toBeUndefined();
    expect(guard.observe({ ...edit, result: reveal([1]) })).toBeUndefined();
    expect(guard.observe({ ...edit, result: reveal([2]) })).toMatchObject({ kind: "edit" });
  });

  it("bounds changing complete reveals and resets after a successful file write", () => {
    const guard = new MutationRecoveryGuard();
    for (let i = 1; i <= MAX_REVEAL_PROGRESS_GRACES + 2; i++) {
      expect(guard.observe({ ...edit, result: reveal([i]) })).toBeUndefined();
    }
    expect(guard.observe({ ...edit, result: reveal([100]) })).toMatchObject({ kind: "edit" });
    guard.observe({ ...edit, result: ok });
    expect(guard.observe({ ...edit, result: reveal([100]) })).toBeUndefined();
  });

  it.each([
    { revealTruncated: true }, { merged: false }, { unseenCount: 99 },
    { unseenLines: [{ line: 1, text: "partial", clipped: true }] },
  ])("does not grant new-progress grace for incomplete or malformed reveals (%j)", extra => {
    const guard = new MutationRecoveryGuard();
    for (let i = 1; i <= 3; i++) expect(guard.observe({ ...edit, result: reveal([i], extra) })).toBeUndefined();
    expect(guard.observe({ ...edit, result: reveal([4], extra) })).toMatchObject({ kind: "edit" });
  });
});
