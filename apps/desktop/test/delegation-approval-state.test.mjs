import assert from "node:assert/strict";
import test from "node:test";
import { createDelegationApprovalState } from "../src/lib/delegation-approval-state.ts";

const row = (revision = 1, status = "pending") => ({ sessionId: "s", requestId: "r", revision, status,
  expiresAt: "2099-01-01T00:00:00Z", candidate: { providerId: "p", modelId: "m" } });
function fixture() {
  let listener, resolve; let subscriptions = 0, removed = 0;
  const source = createDelegationApprovalState({
    onDelegationApprovalChanged: fn => { listener = fn; subscriptions++; return () => { removed++; }; },
    listDelegationApprovals: () => new Promise(done => { resolve = done; }),
  });
  return { source, emit: request => listener({ request }), snapshot: requests => resolve({ requests }),
    counts: () => [subscriptions, removed] };
}
test("one shared subscription feeds multiple views and subscribes before snapshot", async () => {
  const f = fixture(); const a = f.source.retain(), b = f.source.retain();
  assert.deepEqual(f.counts(), [1, 0]);
  f.emit(row(2)); f.snapshot([row(1)]); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.source.getSnapshot().requests[0].revision, 2);
  a(); assert.deepEqual(f.counts(), [1, 0]); b(); assert.deepEqual(f.counts(), [1, 1]);
});
test("terminal tombstone rejects stale snapshot/event resurrection", async () => {
  const f = fixture(); const stop = f.source.retain();
  f.emit(row(3, "approved")); f.snapshot([row(2)]); await Promise.resolve(); await Promise.resolve();
  f.emit(row(3));
  assert.equal(f.source.getSnapshot().requests[0].status, "approved"); stop();
});
test("a list refresh cannot discard a newer event or publish after disposal", async () => {
  const f = fixture(); const stop = f.source.retain();
  f.emit(row(1)); stop(); f.snapshot([]); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.source.getSnapshot().requests[0].status, "pending");
});

test("snapshot hydration is distinguished from live events even during refresh", async () => {
  const f = fixture(); const stop = f.source.retain();
  const live = { ...row(), requestId: "live" };
  f.emit(live); f.snapshot([row(), live]); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.source.isHydrated("s", "r"), true);
  assert.equal(f.source.isHydrated("s", "live"), false);
  f.emit(row(2));
  assert.equal(f.source.isHydrated("s", "r"), true);
  stop();
});

test("old request updates arriving before the initial list are hydration, not new arrivals", async () => {
  const f = fixture(); const stop = f.source.retain();
  f.emit({ ...row(2), createdAt: "2020-01-01T00:00:00.000Z" });
  const fresh = { ...row(), requestId: "fresh", createdAt: new Date(Date.now()).toISOString() };
  f.emit(fresh);
  assert.equal(f.source.isHydrated("s", "r"), true);
  assert.equal(f.source.isHydrated("s", "fresh"), false);
  f.snapshot([row(), fresh]); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.source.getSnapshot().requests.find(r => r.requestId === "r").revision, 2);
  stop();
});
