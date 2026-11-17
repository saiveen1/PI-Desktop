import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const assessment = {
  messageId: "candidate", mode: "guard", status: "assessed", startedAt: 1000, endedAt: 2000,
  modelKey: "provider/judge", verdict: "incomplete", confidence: "high", reason: "The requested verification is missing.",
  continued: false, continuationBlocked: "unsafe", continuationReason: "tool_effects_unknown",
  blockingTool: { toolCallId: "delegate", toolName: "Task" }, evidenceIds: ["candidate"],
};
const reply = (id, observer) => ({ id, role: "assistant", content: `${id} answer`, status: "complete", createdAt: "2026-01-01T00:00:00Z", runDiagnostics: { turnId: "turn", ...(observer ? { observer } : {}) } });

test("an earlier response's assessment stays outside the collapsed process after continuation and history reload", async t => {
  const ssr = await slotSsr(t);
  const { AssistantTurn } = await ssr.load("/src/features/chat/transcript/AssistantTurn.tsx");
  const entry = { id: "turn", anchorId: "candidate", parts: [
    { kind: "message", message: reply("candidate", { ...assessment, continued: true, continuationBlocked: undefined, continuationReason: undefined }) },
    { kind: "message", message: reply("final") },
  ] };
  const html = ssr.render(createElement(AssistantTurn, { entry: JSON.parse(JSON.stringify(entry)), isActive: false }));
  assert.equal((html.match(/data-testid="observer-guard-assessment"/g) ?? []).length, 1);
  assert.ok(html.indexOf('data-testid="observer-guard-assessment"') > html.indexOf('data-message-id="final"'), "assessment belongs after the answer, not inside the folded process");
  assert.match(html, /not reassessed/i);
});

test("assessment summary explains no continuation, skipped evidence and legacy uncertainty", async t => {
  const ssr = await slotSsr(t);
  const { ObserverGuardDisclosure } = await ssr.load("/src/features/chat/transcript/ObserverGuardDisclosure.tsx");
  const render = value => ssr.render(createElement(ObserverGuardDisclosure, { message: reply("candidate", value) }));
  const html = render(assessment);
  assert.match(html, /No continuation/);
  assert.match(html, /effects.*not.*confirmed|unconfirmed.*effects/i);
  assert.match(html, /Task/);
  assert.doesNotMatch(html, /class="message-output-notice"/);
  const skipped = render({ ...assessment, status: "skipped", verdict: undefined, reason: undefined, continuationReason: undefined, skipReason: "response_length" });
  assert.match(skipped, /output limit/i);
  const legacy = render({ ...assessment, continuationReason: undefined, blockingTool: undefined });
  assert.match(legacy, /specific reason.*not recorded/i);
});
