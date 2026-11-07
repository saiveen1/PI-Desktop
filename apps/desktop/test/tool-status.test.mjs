import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const skipped = "Skipped because new user input is waiting.";
const interrupted = "Interrupted by new user input. The background command keeps running; handle the user's message before waiting again.";
const envelope = (details, text = JSON.stringify(details)) => ({
  content: [{ type: "text", text }], details,
});
const message = (overrides = {}) => ({
  id: "tool-status", role: "tool", content: "", status: "complete",
  createdAt: "2026-11-07T00:00:00.000Z", toolCallId: "status-call",
  toolName: "Read", toolArgs: { path: "api/actions.py" }, toolStatus: "error",
  toolResult: envelope({}, skipped), ...overrides,
});

// Enter through the real row used by live events and restored transcripts.
test("tool rows distinguish skipped, interrupted and failed calls without opening output", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const { activitySummary } = await ssr.load("/src/lib/activity-summary.ts");
  const render = (row) => ssr.render(createElement(ToolRow, { message: row }));

  for (const toolName of ["Read", "Grep", "Bash", "TaskWait"]) {
    const row = message({ toolName });
    const html = render(row);
    assert.match(html, /Skipped/, toolName);
    assert.doesNotMatch(html, /tool-row-status error|is-error|status-error|>Failed</, toolName);
    assert.match(html, /aria-expanded="false"/, toolName);
    assert.equal(activitySummary([{ kind: "tool", message: row }]).issues, 0, toolName);
  }

  const stopped = message({ status: "aborted", toolResult: undefined });
  assert.match(render(stopped), /Interrupted/);
  assert.doesNotMatch(render(stopped), /status-error|>Failed</);

  const wait = message({
    toolName: "TaskWait", toolStatus: "success",
    toolResult: envelope({ status: "interrupted" }, interrupted),
  });
  assert.match(render(wait), /Interrupted/);
  assert.doesNotMatch(render(wait), />Done</);

  for (const row of [
    message({ toolResult: envelope({ code: "TOOL_TIMEOUT", error: "The command timed out." }) }),
    message({ toolName: "Bash", toolStatus: "success", toolResult: envelope({ exitCode: 1, stderr: "test failed" }) }),
  ]) {
    const html = render(row);
    assert.match(html, /Failed/);
    assert.match(html, /is-error|tool-row-status error/);
    assert.equal(activitySummary([{ kind: "tool", message: row }]).issues, 1);
  }

  // Successive renders follow the same user path: active tool, new input,
  // skipped old call, then a later successful call. No execution is replayed.
  assert.match(render(message({ toolStatus: "running", toolResult: undefined })), /tool-spinner/);
  assert.match(render(message()), /Skipped/);
  const done = message({ toolStatus: "success", toolResult: envelope({ content: "ok" }) });
  assert.doesNotMatch(render(done), /Skipped|Interrupted|>Failed</);
});

test("status classification preserves execution evidence and handles historical result shapes", async (t) => {
  const ssr = await slotSsr(t);
  const { getToolStatus } = await ssr.load("/src/lib/tool-status.ts");
  const cases = [
    [message({ toolResult: skipped }), "skipped"],
    [message({ toolResult: undefined, content: skipped }), "skipped"],
    [message({ toolStatus: "success", toolResult: envelope({}, skipped) }), "success"],
    [message({ toolName: "Bash", toolStatus: "success", toolResult: envelope({ exitCode: 0, stdout: skipped }) }), "success"],
    [message({ toolResult: envelope({ code: "TOOL_ABORTED", error: "search was cancelled" }) }), "interrupted"],
    [message({ toolResult: envelope({ errorCode: "TOOL_ABORTED" }) }), "interrupted"],
    [message({ status: "aborted", toolResult: envelope({ code: "TOOL_TIMEOUT", error: "timed out" }) }), "failed"],
    [message({ toolName: "Bash", status: "aborted", toolResult: envelope({ exitCode: 2 }) }), "failed"],
    [message({ toolName: "Bash", toolStatus: "success", toolResult: envelope({ exitCode: null }) }), "failed"],
    [message({ toolStatus: "denied", toolResult: envelope({ error: "Permission declined" }) }), "denied"],
    [message({ toolName: "TaskWait", toolStatus: "success", toolResult: envelope({ status: "interrupted" }, interrupted) }), "interrupted"],
    [message({ toolName: "TaskWait", toolStatus: "success", toolResult: envelope({ delegations: [] }, "Interrupted by new user input. Unfinished subagents keep working; handle the user's message before waiting again.") }), "interrupted"],
    [message({ toolName: "TaskWait", toolResult: envelope({ code: "INVALID_ARGUMENT", status: "interrupted", error: "Invalid job selector" }) }), "failed"],
  ];
  for (const [row, kind] of cases) assert.equal(getToolStatus(row).kind, kind, JSON.stringify(row));

  const detail = getToolStatus(message({ toolResult: envelope({ code: "TOOL_FAILED", error: "x".repeat(2000), stdout: "private output" }) })).detail;
  assert.ok(detail.length <= 600);
  assert.match(detail, /^TOOL_FAILED:/);
  assert.doesNotMatch(detail, /private output/);
});

test("status reasons are localized and accessible before output is expanded", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const render = (row) => ssr.render(createElement(ToolRow, { message: row }));
  const skippedHtml = render(message());
  assert.match(skippedHtml, /aria-label="Skipped: New user input arrived\. This tool call was not executed\."/);
  assert.match(skippedHtml, /class="tool-row-status" tabindex="0"/);
  assert.equal((skippedHtml.match(/role="status"/g) ?? []).length, 1);
  const errorHtml = render(message({ toolResult: envelope({ code: "TOOL_TIMEOUT", error: "Command timed out" }) }));
  assert.match(errorHtml, /aria-label="Failed: TOOL_TIMEOUT: Command timed out"/);
  const deniedHtml = render(message({ toolStatus: "denied", toolResult: envelope({ error: "Permission declined" }) }));
  assert.match(deniedHtml, /aria-label="Denied: Permission declined"/);
});
