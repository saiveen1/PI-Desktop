import assert from "node:assert/strict";
import test from "node:test";
import { notificationHistoryRows, notificationPopoverPosition, notificationTone, notificationToastVariant, formatNotificationTime } from "../src/lib/notification-presentation.ts";

const task = { id: "done", kind: "task.completed", createdAt: "2026-11-01T10:00:00Z", readAt: null };
const receipt = { request: { sessionId: "s", requestId: "r", status: "approved" }, settledAt: "2026-11-01T11:00:00Z" };

test("task outcomes and approval receipts retain separate identities and read history", () => {
  const read = { ...receipt, readAt: "2026-11-01T12:00:00Z" };
  const rows = notificationHistoryRows([task], [read]);
  assert.deepEqual(rows.map(row => row.kind), ["approval", "task"]);
  assert.equal(rows[0].read, true);
  assert.deepEqual(notificationHistoryRows([task], [read], true).map(row => row.id), ["task:done"]);
  assert.notEqual(notificationHistoryRows([], [receipt, { ...receipt, request: { ...receipt.request, sessionId: "other" } }])[0].id, rows[0].id);
  assert.equal(task.readAt, null);
});

test("semantic colors distinguish pending, execution, success, failure, and neutral receipts", () => {
  for (const kind of ["ask", "permission", "plan", "delegation-approval"]) {
    assert.equal(notificationTone(kind), "pending");
    assert.equal(notificationToastVariant(kind), "warning");
  }
  assert.equal(notificationTone("delegation", "running"), "running");
  assert.equal(notificationTone("delegation-approval", "approved"), "success");
  for (const status of ["rejected", "expired", "cancelled"]) assert.equal(notificationTone("delegation-approval", status), "neutral");
  assert.equal(notificationToastVariant("task.completed"), "success");
  for (const kind of ["task.failed", "delegation.failed"]) assert.equal(notificationToastVariant(kind), "error");
  assert.equal(notificationTone("delegation", "timed_out"), "failed");
  assert.equal(notificationToastVariant("test"), "info");
});

test("popover geometry uses actual anchor and stays within short, narrow, or moved viewports", () => {
  for (const [width, height] of [[1280, 900], [360, 640], [360, 320], [240, 200], [0, 0]]) {
    for (const top of [-100, 0, height / 2, height - 16, height + 100]) {
      const pos = notificationPopoverPosition(top, width - 5, width, height);
      assert.ok(pos.bottom >= 0 && pos.maxHeight >= 0);
      assert.ok(pos.bottom + pos.maxHeight <= height);
      assert.ok(pos.left >= 0 && pos.left <= width);
    }
  }
  assert.equal(notificationPopoverPosition(500, 16, 1280, 900).bottom, 408);
  assert.equal(notificationPopoverPosition(500, 16, 1280, 900).maxHeight, 480);
});

test("relative timestamps preserve invalid-date fallback and locale formatting", () => {
  assert.equal(formatNotificationTime("invalid", "en", "Just now"), "Just now");
  assert.equal(formatNotificationTime(new Date().toISOString(), "en", "Just now"), "Just now");
  assert.match(formatNotificationTime(new Date(Date.now() - 120_000).toISOString(), "en", "Just now"), /2 minutes ago/);
});
