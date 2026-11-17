import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionDelegationsSource } = await import("../src/features/delegations/session-delegations-source.ts");
const { createDelegationApprovalState } = await import("../src/lib/delegation-approval-state.ts");
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const tick = () => new Promise(setImmediate);

for (const kind of ["history", "approvals"]) {
  test(`${kind}: successful hydration, including empty results, survives refresh and errors`, async () => {
    const reads = [];
    const read = () => { const request = deferred(); reads.push(request); return request.promise; };
    const source = kind === "history"
      ? createSessionDelegationsSource({ listDelegationHistory: read, onAgentEvent: () => () => {} }, "session")
      : createDelegationApprovalState({ listDelegationApprovals: read, onDelegationApprovalChanged: () => () => {} });
    const empty = kind === "history" ? { entries: [], nextOffset: null } : { requests: [] };
    const error = () => kind === "history" ? source.getSnapshot().error : source.getSnapshot().loadError;
    const release = source.retain();
    try {
      assert.equal(source.getSnapshot().loaded, false);
      assert.equal(source.getSnapshot().loading, true);
      reads[0].resolve(empty); await tick();
      assert.equal(source.getSnapshot().loaded, true);
      assert.equal(source.getSnapshot().loading, false);
      const refresh = source.reload();
      assert.equal(source.getSnapshot().loaded, true, "Background refresh must not return to first-load state");
      reads[1].reject(Error("Offline")); await refresh;
      assert.equal(source.getSnapshot().loaded, true);
      assert.equal(error(), true);
      const retry = source.reload();
      assert.equal(error(), true, "Keep the stale-state warning until a successful read, not merely a retry");
      reads[2].resolve(empty); await retry;
      assert.equal(error(), false);
      assert.equal(source.getSnapshot().loading, false);
    } finally { release(); }
  });
}

test("a failed first read is not successful hydration and a late request cannot clear a newer error", async () => {
  const reads = [];
  const source = createSessionDelegationsSource({
    onAgentEvent: () => () => {},
    listDelegationHistory: () => { const next = deferred(); reads.push(next); return next.promise; },
  }, "session");
  const release = source.retain();
  try {
    const refresh = source.reload();
    reads[1].reject(Error("Offline")); await refresh;
    reads[0].resolve({ entries: [], nextOffset: null }); await tick();
    assert.equal(source.getSnapshot().loaded, false);
    assert.equal(source.getSnapshot().error, true);
  } finally { release(); }
});
