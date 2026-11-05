import { describe, expect, it, vi } from "vitest";
import type { DelegationSettings } from "@pi-desktop/shared";
import { DelegationPolicyState } from "./delegation-policy-state.js";

const settings: DelegationSettings = { version: 1, approvalTimeoutSeconds: 60, models: [] };
const snapshot = (revision: string) => ({ settings, revision, modelKeys: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("hot delegation policy snapshots", () => {
  it("coalesces admission readers and discards a response invalidated by a save", async () => {
    const old = deferred<unknown>();
    const fetch = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(snapshot("new"));
    const state = new DelegationPolicyState(undefined, fetch);
    const first = state.refresh();
    expect(state.refresh()).toBe(first);
    state.invalidate();
    old.resolve(snapshot("old"));
    expect(await first).toEqual({ settings, modelKeys: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(state.authoritative).toBe(true);
  });
  it("preserves launch policy for a missing legacy callback without treating malformed policy as missing", async () => {
    const missing = new DelegationPolicyState(settings, async () => { throw Object.assign(new Error("Method not found"), { rpcCode: -32601 }); });
    expect(await missing.refresh()).toEqual({ settings });
    const undefinedResult = new DelegationPolicyState(settings, async () => undefined);
    expect(await undefinedResult.refresh()).toEqual({ settings });
    for (const value of [null, {}, { revision: "a", modelKeys: [], settings: null }, { revision: "a", modelKeys: ["broken"] }]) {
      await expect(new DelegationPolicyState(settings, async () => value).refresh()).rejects.toThrow("Invalid delegation policy snapshot");
    }
    await expect(new DelegationPolicyState(settings, async () => { throw new Error("connection lost"); }).refresh()).rejects.toThrow("connection lost");
  });
  it("fails closed for malformed or missing responses after policy support is established", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(snapshot("a")).mockResolvedValue(undefined);
    const state = new DelegationPolicyState(undefined, fetch);
    await state.refresh();
    await expect(state.refresh()).rejects.toThrow("Invalid delegation policy snapshot");
    expect(state.value.settings).toEqual(settings);
  });
  it("never installs a previously retired revision or changed content under the same revision", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(snapshot("a")).mockResolvedValueOnce(snapshot("b"))
      .mockResolvedValueOnce(snapshot("a")).mockResolvedValueOnce({ ...snapshot("b"), settings: undefined });
    const state = new DelegationPolicyState(undefined, fetch);
    await state.refresh();
    await state.refresh();
    await expect(state.refresh()).rejects.toThrow("Stale delegation policy snapshot");
    await expect(state.refresh()).rejects.toThrow("without a new revision");
    expect(state.value).toEqual({ settings, modelKeys: [] });
  });
});
