import assert from "node:assert/strict";
import test from "node:test";
import { pendingNotificationTargets, notificationIdentity } from "../src/lib/notification-pending.ts";

const empty = () => ({ pendingAsks: {}, pendingPermissions: {}, pendingPlans: {} });
test("pending projection combines sessions without persisting or modifying consent", () => {
  const state = empty();
  state.pendingAsks.a = [{ sessionId: "a", requestId: "q", toolCallId: "q-tool", questions: [{ question: "private", options: [] }] }];
  state.pendingPermissions.b = [{ sessionId: "b", requestId: "p", toolCallId: "p-tool", argsPreview: "private" }];
  const before = structuredClone(state);
  const rows = pendingNotificationTargets(state, [], 1000);
  assert.deepEqual(rows.map(row => row.target.kind), ["ask", "permission"]);
  assert.deepEqual(rows.map(row => row.target.sessionId), ["a", "b"]);
  assert.ok(!JSON.stringify(rows).includes("private"));
  assert.deepEqual(state, before);
});
test("expired, invalid and settled plans/delegation requests are not actionable", () => {
  const state = empty();
  state.pendingPlans.a = { id: "plan", sessionId: "a", status: "pending", expiresAt: new Date(1000).toISOString() };
  const request = { sessionId: "b", requestId: "r", status: "pending", revision: 1, expiresAt: new Date(2000).toISOString() };
  assert.equal(pendingNotificationTargets(state, [request], 1000).length, 1);
  assert.equal(pendingNotificationTargets(state, [request], 2000).length, 0);
  assert.equal(pendingNotificationTargets(state, [{ ...request, status: "approved" }], 1000).length, 0);
});
test("request identities survive revisions and distinguish remote hosts and source kinds", () => {
  const target = { kind: "ask", sessionId: "remote:host-a:session", requestId: "r" };
  assert.equal(notificationIdentity(target), notificationIdentity({ ...target, revision: 2 }));
  assert.notEqual(notificationIdentity(target), notificationIdentity({ ...target, sessionId: "remote:host-b:session" }));
  assert.notEqual(notificationIdentity(target), notificationIdentity({ ...target, kind: "permission" }));
});
