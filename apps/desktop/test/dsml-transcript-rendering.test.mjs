import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const timeout = '<｜DSML｜ parameter name="timeout" string="false">200</｜DSML｜ parameter>';
const shortTail = `${timeout}\n</｜DSML｜ calls>`;
const fullTail = `${timeout}\n</｜DSML｜ invoke>\n</｜DSML｜ calls>`;
const literalTail = fullTail.replace('name="timeout" string="false">200', 'name="note" string="true"><b>[link](https://example.invalid)</b>');
const prose = "Keep **this answer**.";
const error = { code: "TOOL_CALL_NOT_EXECUTED", message: "Original diagnostic", retriable: true };

test("the transcript folds only a settled assistant's orphan tail and its matching diagnostic", async (t) => {
  const ssr = await slotSsr(t);
  const { AssistantTurnParts } = await ssr.load("/src/features/chat/transcript/AssistantTurnParts.tsx");
  const render = (content, extra = {}, earlierTool = false) => {
    const message = { id: "answer", role: "assistant", status: "complete", content, ...extra };
    const parts = earlierTool ? [{ kind: "activity", items: [{ kind: "tool", message: {
      id: "other-call", role: "tool", toolName: "Read", status: "complete", content: "earlier result",
    } }] }] : [];
    parts.push({ kind: "message", message });
    return ssr.render(createElement(AssistantTurnParts, {
      parts, isActive: message.status === "streaming", turnDelegationStatuses: new Map(), turnDelegationTimings: new Map(),
    }));
  };
  const termination = (messageId, stopReason = "toolUse") => ({ termination: { messageId, stopReason, reasonSource: "normalized" } });
  for (const [tail, extra, earlierTool, hasSibling] of [
    [shortTail, {}, false, false],
    [fullTail, { runDiagnostics: termination("answer") }, true, true],
    [fullTail, { runDiagnostics: termination("different-response") }, true, false],
    [literalTail, { runDiagnostics: termination("answer", "stop") }, true, false],
  ]) {
    const html = render(`${prose}\n\n${tail}`, extra, earlierTool);
    const details = html.match(/<details\b([^>]*)>(<summary\b[\s\S]*?)<\/details>/);
    assert.ok(details, "matched tail must render as a native disclosure");
    assert.doesNotMatch(details[1], /\bopen\b/);
    const summary = details[2].slice(0, details[2].indexOf("</summary>"));
    assert.match(summary, hasSibling ? /see tool activity/ : /Incomplete tool markup was not executed\./);
    if (!hasSibling) assert.match(summary, /Protocol details/);
    assert.doesNotMatch(details[2], /<a\b|<b>/);
    const escaped = tail.replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    assert.ok(details[2].includes(`>${escaped}</pre>`), "raw tail is exact escaped text, not Markdown");
    const outside = html.replace(details[0], "");
    assert.match(outside, /<strong[^>]*>this answer<\/strong>/);
    assert.doesNotMatch(outside, /DSML/);
  }
  const contents = `${prose}\n\n${fullTail}`;
  for (const code of [error.code, "NETWORK_ERROR"]) {
    const html = render(contents, { error: { ...error, code }, status: "error", outputTruncated: true });
    const details = html.match(/<details\b[\s\S]*?<\/details>/)[0];
    const outside = html.replace(details, "");
    const [errorOwner, other] = code === error.code ? [details, outside] : [outside, details];
    assert.match(errorOwner, /Original diagnostic/);
    assert.match(errorOwner, /message-error-dismiss/);
    assert.match(errorOwner, /class="copy-btn primary"/);
    assert.doesNotMatch(other, /class="message-error"/);
    assert.match(outside, /class="message-output-notice" role="status"/);
  }
  for (const html of [
    render(`${prose}\n\n${timeout}`, { error }),
    render(contents, { status: "streaming", error }),
    render(`\`\`\`text\n${fullTail}\n\`\`\``, { error }),
  ]) {
    assert.doesNotMatch(html, /<details\b/);
    assert.match(html, /DSML/);
    assert.match(html, /Original diagnostic/);
  }
});
