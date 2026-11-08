import assert from "node:assert/strict";
import { createElement } from "react";
import test from "node:test";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const skipped = { id: "skipped", role: "tool", content: "", toolName: "Task", toolCallId: "skip-call",
  toolStatus: "error", isError: true, toolDurationMs: 0, toolArgs: { agent: "reviewer", task: "Review" },
  toolResult: { content: [{ type: "text", text: "Skipped because new user input is waiting." }], details: {} } };
const active = { ...skipped, id: "active", toolCallId: "active-call", isError: false, toolStatus: "success",
  toolResult: { details: { delegationId: "active-delegate", status: "running" } } };

test("preempted Task history says not started without a runtime or false coordination", async (t) => {
  const h = await slotSsr(t);
  const { SubagentTopology } = await h.load("/src/features/chat/transcript/SubagentDetail.tsx");
  const render = (messages) => h.render(createElement(SubagentTopology, {
    items: messages.map(message => ({ kind: "tool", message })),
  }));
  const html = render([skipped]);
  assert.match(html, /Not started · New input received/);
  assert.doesNotMatch(html, /Coordinating|0s/);
  const mixed = render([skipped, active]);
  assert.match(mixed, /Not started · New input received/);
  assert.match(mixed, /Coordinating 1 delegated task/);
  const settled = render([{ ...active, toolResult: { details: { delegationId: "active-delegate", status: "failed" } } }, skipped]);
  assert.doesNotMatch(settled, /Coordinating|0s/);
  assert.match(render([skipped, active]), /Coordinating 1 delegated task/);
  const { ActivityGroup } = await h.load("/src/features/chat/transcript/ActivityGroup.tsx");
  const group = h.render(createElement(ActivityGroup, { items: [{ kind: "tool", message: skipped }], isActive: false, turnActive: false }));
  assert.match(group, /Tasks not started · New input received/);
  assert.doesNotMatch(group, /0s|subagent-activity-metrics/);
  const { ToolRow, SubagentRunRows } = await h.load("/src/features/chat/transcript/ToolRow.tsx");
  const ordinary = h.render(createElement(ToolRow, { message: { ...skipped, toolName: "Read" } }));
  assert.match(ordinary, /Skipped/);
  assert.doesNotMatch(ordinary, /Not started/);
  const comment = { id: "inline-comment", role: "user", content: "Check tests first" };
  const inline = h.render(createElement(SubagentRunRows, { run: { items: [{ kind: "answer", message: comment }] }, agentName: "reviewer" }));
  assert.match(inline, /class="message-row user" data-message-id="inline-comment"/);
  assert.doesNotMatch(inline, /class="subagent-answer"/);
});

// Capture production JSX before SSR expands shared primitives. Actual event
// handlers run below, with React's real hook dispatcher and only IPC stubbed.
function nodes(tree) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return tree.props ? [tree, ...nodes(tree.props.children)] : [];
}
function capture(h, Component, props) {
  let tree;
  function Probe() { tree = Component(props); return tree; }
  const html = h.render(createElement(Probe));
  return { html, elements: nodes(tree) };
}

test("real child composer sends through the API edge and preserves transport retries", async (t) => {
  const h = await slotSsr(t);
  const { SubagentChildComposer } = await h.load("/src/components/workpanel/SubagentChildComposer.tsx");
  const { childMessages, childMessageOwner } = await h.load("/src/components/workpanel/child-message-controller.ts");
  const { useAppStore } = await h.load("/src/stores/app-store.ts");
  const session = { id: "local", source: "desktop" };
  Object.assign(useAppStore.getInitialState(), { sessions: [session], activeSessionId: "local" });
  useAppStore.setState({ sessions: [session], activeSessionId: "local" });
  const previousWindow = globalThis.window;
  t.after(() => { globalThis.window = previousWindow; });
  const requests = [];
  let fail = true;
  globalThis.window = { piDesktop: { invoke: async (_channel, request) => {
    requests.push(request);
    if (fail) throw new Error("fixture transport failure");
    return { ok: true, data: { accepted: true, turnId: "turn", delegationId: "new-child", resumedFrom: "current-child", delivery: "resumed" } };
  } } };
  const props = { sessionId: "local", chainId: "root-call", delegationId: "current-child", outcome: "running", children: null };
  const render = () => capture(h, SubagentChildComposer, props);
  const field = view => view.elements.find(item => item.props["aria-label"] === "Message this subagent");
  const send = view => view.elements.find(item => item.props.variant === "primary");
  assert.equal(send(render()).props.disabled, true);
  field(render()).props.onChange({ target: { value: "Review tests\nnot docs" } });
  assert.equal(send(render()).props.disabled, false);
  assert.equal(field(render()).props.onKeyDown, undefined);
  const owner = childMessageOwner("local", "root-call");
  const idle = () => childMessages.get(owner).pending ? new Promise(resolve => {
    const off = childMessages.subscribe(() => { if (!childMessages.get(owner).pending) { off(); resolve(); } });
  }) : Promise.resolve();
  send(render()).props.onClick();
  send(render()).props.onClick();
  assert.equal(requests.length, 1);
  assert.match(render().html, /Sending…/);
  await idle();
  assert.match(render().html, /Message not confirmed: fixture transport failure/);
  assert.equal(field(render()).props.value, "Review tests\nnot docs");
  fail = false;
  props.delegationId = "new-child";
  send(render()).props.onClick();
  await idle();
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].delegationId, "current-child");
  assert.match(requests[0].messageId, /^[0-9a-f-]{36}$/);
  assert.equal(field(render()).props.value, "");
  for (const [outcome, label] of [["running", "Send"], ["completed", "Continue"], ["failed", "Send and resume"], ["stopped", "Send and resume"], ["aborted", "Send and resume"]]) {
    props.outcome = outcome;
    assert.equal(send(render()).props.children, label);
  }
  for (const source of ["remote", "pi-native"]) {
    Object.assign(session, { source });
    const view = render();
    assert.equal(field(view).props.disabled, true);
    assert.equal(send(view).props.disabled, true);
    assert.match(view.html, /only in local Desktop sessions/);
    send(view).props.onClick();
  }
  assert.equal(requests.length, 2);
});

test("failure settings render conditional limits and recorded task snapshots", async (t) => {
  const h = await slotSsr(t);
  const { SubagentFailurePolicySettings } = await h.load("/src/components/settings/SubagentFailurePolicySettings.tsx");
  const { SubagentFailurePolicySummary } = await h.load("/src/components/workpanel/SubagentFailurePolicySummary.tsx");
  let policy;
  const render = () => capture(h, SubagentFailurePolicySettings, { policy, disabled: false, onChange: next => { policy = next; } });
  const mode = view => view.elements.find(item => item.props.label === "On child failure");
  const input = (view, label) => view.elements.find(item => item.props["aria-label"] === label);
  assert.match(render().html, /Follow existing \/ session behavior/);
  assert.equal(policy, undefined);
  assert.equal(input(render(), "Same-model retries"), undefined);
  mode(render()).props.onChange("stop");
  assert.equal(policy.mode, "stop");
  assert.equal(input(render(), "Same-model retries"), undefined);
  mode(render()).props.onChange("retry");
  assert.equal(input(render(), "Same-model retries").props.min, 0);
  assert.equal(input(render(), "Model switches"), undefined);
  mode(render()).props.onChange("fallback");
  assert.equal(input(render(), "Model switches").props.min, 1);
  assert.equal(input(render(), "Model switches").props.max, 10);
  for (const invalid of [NaN, -1, 11, 1.5]) {
    input(render(), "Same-model retries").props.onChange({ target: { valueAsNumber: invalid } });
    assert.equal(input(render(), "Same-model retries").props["aria-invalid"], true);
    assert.match(render().html, /role="alert"/);
  }
  mode(render()).props.onChange("stop");
  assert.doesNotMatch(render().html, /role="alert"/);
  mode(render()).props.onChange("inherit");
  assert.equal(policy, undefined);
  assert.equal(h.render(createElement(SubagentFailurePolicySummary, { payload: {} })), "");
  const snapshot = h.render(createElement(SubagentFailurePolicySummary, { payload: { failurePolicy: { mode: "fallback", maxRetries: 3, maxFallbacks: 4 } } }));
  assert.match(snapshot, /Retry then switch model/);
  assert.match(snapshot, /<dd>3<\/dd>/);
  assert.match(snapshot, /<dd>4<\/dd>/);
});

test("scheduling saves failure edits through the existing path and refuses invalid counters", async (t) => {
  const h = await slotSsr(t);
  const { SubagentSchedulingSettings } = await h.load("/src/components/settings/SubagentSchedulingSettings.tsx");
  const { SubagentFailurePolicySettings } = await h.load("/src/components/settings/SubagentFailurePolicySettings.tsx");
  const { useAppStore } = await h.load("/src/stores/app-store.ts");
  const original = { version: 1, approvalTimeoutSeconds: 17, models: [], runPolicy: { maxToolCalls: 64 } };
  Object.assign(useAppStore.getInitialState(), { providers: [], settings: { delegation: original } });
  for (const maxRetries of [0, 10, NaN, -1, 11, 0.5]) {
    const writes = [];
    let stage = 0;
    function Probe() {
      const tree = SubagentSchedulingSettings({ saveSettings: async patch => { writes.push(patch); } });
      const elements = nodes(tree);
      if (stage++ === 0) {
        elements.find(item => item.type === SubagentFailurePolicySettings).props.onChange({ mode: "fallback", maxRetries, maxFallbacks: 2 });
      } else if (stage === 2) {
        const save = elements.find(item => item.props.variant === "primary");
        assert.equal(save.props.disabled, !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10);
        save.props.onClick();
      }
      return tree;
    }
    h.render(createElement(Probe));
    if (Number.isInteger(maxRetries) && maxRetries >= 0 && maxRetries <= 10) {
      assert.equal(writes.length, 1);
      assert.equal(writes[0].delegation.failurePolicy.maxRetries, maxRetries);
      assert.deepEqual(writes[0].delegation.models, original.models);
      assert.equal(writes[0].delegation.approvalTimeoutSeconds, 17);
      assert.equal(writes[0].delegation.runPolicy.maxToolCalls, 64);
    } else assert.equal(writes.length, 0);
  }
});

test("the transcript renders child comments as user rows and follows newest chain metadata", async (t) => {
  const h = await slotSsr(t);
  const { SubagentTranscriptTab } = await h.load("/src/components/workpanel/SubagentTranscriptTab.tsx");
  const { useAppStore } = await h.load("/src/stores/app-store.ts");
  const messages = [{ id: "first", sessionId: "session", role: "tool", toolName: "Task", toolCallId: "first", toolArgs: { task: "First task" },
    toolResult: { details: { delegationId: "old", status: "completed" } } },
    { id: "latest", sessionId: "session", role: "tool", toolName: "Task", toolCallId: "latest", toolArgs: { task: "Resume", resume: "old" },
      toolResult: { details: { delegationId: "new", status: "running", failurePolicy: { mode: "stop", maxRetries: 2, maxFallbacks: 2 } } } },
    { id: "comment", sessionId: "session", role: "user", content: "Inspect tests, not docs", parentToolCallId: "latest" }];
  Object.assign(useAppStore.getInitialState(), { activeSessionId: "session", sessions: [{ id: "session", source: "desktop" }], messages });
  const html = h.render(createElement(SubagentTranscriptTab, { delegationId: "old" }));
  assert.match(html, /class="message-row user" data-message-id="comment"/);
  assert.match(html, /Inspect tests, not docs/);
  assert.match(html, /Task failure policy/);
  assert.match(html, /Stop and report/);
  assert.doesNotMatch(html, /subagentReadOnly/);
});

test("every locale has complete child-control translations and error interpolation", async () => {
  const { subagentControls: english } = await import("../../../packages/i18n/src/locales/en/subagent-controls.ts");
  for (const locale of ["de", "es", "fr", "ko", "pt-BR", "tr", "zh-CN", "zh-TW"]) {
    const { subagentControls: translated } = await import(`../../../packages/i18n/src/locales/${locale}/subagent-controls.ts`);
    assert.deepEqual(Object.keys(translated).sort(), Object.keys(english).sort(), locale);
    assert.match(translated.sendFailed, /\{\{error\}\}/, locale);
    for (const value of Object.values(translated)) assert.ok(value.trim(), locale);
    assert.notEqual(translated.notStarted, english.notStarted, locale);
  }
});
