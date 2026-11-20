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

test("new outcomes show the latest per-turn decision rather than one card per continuation", async t => {
  const ssr = await slotSsr(t);
  const { AssistantTurn } = await ssr.load("/src/features/chat/transcript/AssistantTurn.tsx");
  const entry = { id: "turn", anchorId: "first", parts: [
    { kind: "message", message: reply("first", { messageId: "first", mode: "endless", status: "assessed", startedAt: 1, decision: "continue", continued: true, continuationCount: 1, maxContinuations: 2 }) },
    { kind: "message", message: reply("last", { messageId: "last", mode: "endless", status: "assessed", startedAt: 2, continued: false, continuationReason: "continuation_limit", continuationCount: 2, maxContinuations: 2 }) },
  ] };
  const html = ssr.render(createElement(AssistantTurn, { entry, isActive: false }));
  assert.equal((html.match(/data-testid="observer-guard-assessment"/g) ?? []).length, 1);
  assert.match(html, /Auto-continuations: 2 \/ 2/);
  assert.match(html, /No reviewer used/);
  assert.match(html, /turn limit was reached/);
  assert.doesNotMatch(html, /Assessed|Reviewed response|Reviewer effort|Reviewer model|Usage|not reassessed/);
});

test("guard decisions display dispatched continuations while old Observe rows keep their label", async t => {
  const ssr = await slotSsr(t);
  const { ObserverGuardDisclosure } = await ssr.load("/src/features/chat/transcript/ObserverGuardDisclosure.tsx");
  const render = value => ssr.render(createElement(ObserverGuardDisclosure, { message: reply("candidate", value) }));
  const decision = { messageId: "candidate", mode: "guard", status: "assessed", startedAt: 1, continued: true, decision: "continue", continuationCount: 1, maxContinuations: 3 };
  const html = render(decision);
  assert.match(html, /Guard decision: Continue/);
  assert.match(html, /Auto-continuations: 1 \/ 3/);
  assert.doesNotMatch(html, /Unknown|Evidence IDs|not reassessed/);
  assert.match(render({ ...decision, decision: "stop", continued: false, continuationReason: "decision_stop" }), /Guard decision: Stop/);
  assert.match(render({ ...assessment, mode: "observe", continuationReason: "observe_only" }), /<dd>Observe<\/dd>/);
});
