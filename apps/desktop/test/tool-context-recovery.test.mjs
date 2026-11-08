import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const row = (overrides = {}) => ({
  id: "edit-reveal", role: "tool", content: "", status: "complete",
  createdAt: "2026-11-08T00:00:00Z", toolCallId: "edit", toolName: "Edit",
  toolStatus: "error", isError: true, toolArgs: { path: "fixture.ts" },
  toolResult: { details: { code: "EDIT_LINES_UNSEEN", merged: true, revealTruncated: false,
    unseenCount: 1, unseenLines: [{ line: 8, text: "private fixture", clipped: false }] }, isError: true },
  ...overrides,
});

test("Edit line reveals are context requests rather than successful writes or failed executions", async t => {
  const ssr = await slotSsr(t);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const { getToolStatus } = await ssr.load("/src/lib/tool-status.ts");
  const { activitySummary } = await ssr.load("/src/lib/activity-summary.ts");
  const message = row();
  const saved = JSON.stringify(message);
  assert.equal(getToolStatus(message).kind, "context-required");
  const html = ssr.render(createElement(ToolRow, { message }));
  assert.match(html, /Needs context/);
  assert.match(html, /No file change was applied/);
  assert.doesNotMatch(html, /tool-row-status error|status-error|>Failed<|>Done<|private fixture/);
  assert.equal(activitySummary([{ kind: "tool", message }]).issues, 0);
  assert.equal(JSON.stringify(message), saved);

  const truncated = row({ toolResult: { details: { code: "EDIT_LINES_UNSEEN", revealTruncated: true, unseenCount: 200 } } });
  assert.match(ssr.render(createElement(ToolRow, { message: truncated })), /Read the missing ranges/);
  for (const code of ["EDIT_RANGE_INVALID", "EDIT_PARSE_FAILED", "EDIT_TAG_MISMATCH", "HOST_OVERLOADED"]) {
    assert.equal(getToolStatus(row({ toolResult: { details: { code } } })).kind, "failed");
  }
  assert.equal(getToolStatus(row({ toolName: "plugin.Edit" })).kind, "failed");
  assert.equal(getToolStatus(row({ toolStatus: "running" })).kind, "running");
  assert.equal(getToolStatus(row({ toolStatus: "denied" })).kind, "denied");
  assert.equal(getToolStatus(row({ toolResult: { details: { code: "EDIT_LINES_UNSEEN" } } })).kind, "failed");
});
