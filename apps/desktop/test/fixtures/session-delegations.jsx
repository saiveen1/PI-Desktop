import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { ConversationTopbar } from "../../src/components/ConversationTopbar";
import { SubagentTranscriptTab } from "../../src/components/workpanel/SubagentTranscriptTab";
import { SessionDelegationsPanel } from "../../src/features/delegations/SessionDelegationsPanel";
import { sessionDelegationsSource } from "../../src/features/delegations/session-delegations-source";
import { delegationApprovalState } from "../../src/lib/delegation-approval-state";
import { SubagentTaskList } from "../../src/features/chat/transcript/SubagentTaskList";
import { ThinkingRow } from "../../src/features/chat/transcript/shared";
import { api } from "../../src/lib/api";
import { useAppStore } from "../../src/stores/app-store";
import { switchWorkPanelContextState } from "../../src/lib/work-panel-tabs";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/styles/ui-kit.css";
import "../../src/styles/chrome.css";
import "../../src/styles/messages.css";
import "../../src/styles/work-panel.css";

await i18n.use(initReactI18next).init({ lng: "en", resources: Object.fromEntries(Object.entries(catalogs).map(([locale, catalog]) => [locale, { translation: catalog }])) });
window.piDesktop = { platform: "win32", invoke: async () => ({ ok: true, data: {} }), on: () => () => {} };
const events = new Set(), approvalEvents = new Set(), calls = [];
let rows = [], messages = [], approvals = [], failure = false, detailFailure = false, pageFailure = false, delayed, delayedApproval;
let delayedDetail, delayedPage;
let attemptPages;
const stamp = "2026-11-12T10:00:00.000Z";
const task = (id, status = "running") => ({ id: `task-${id}`, role: "tool", content: "", createdAt: stamp,
  toolName: "Task", toolCallId: `call-${id}`, toolStatus: "success", status: "complete",
  toolArgs: { agent: "reviewer", description: `Review ${id}`, task: `Validate ${id}` },
  toolResult: { details: { delegationId: id, status, modelId: 'fixture/effective-model-with-long-name', ...(id === 'old' ? {} : { thinkingLevel: id === 'done' ? 'off' : id === 'stopped' ? 'omit' : 'high' }), ...(status === "failed" ? { error: { code: "FIXTURE", message: "Fixture failure" } } : {}) } },
});
const row = (id, status = "running", sessionId = "alpha") => ({ id, sessionId, sessionTitle: sessionId,
  messageId: `task-${id}`, delegationId: id, agentName: "reviewer", description: `Review ${id}`, task: `Validate ${id}`,
  report: id === "old" ? "Retained historical report" : undefined, createdAt: stamp, status,
  modelId: 'fixture/effective-model-with-long-name', ...(id === 'old' ? {} : { thinkingLevel: id === 'done' ? 'off' : id === 'stopped' ? 'omit' : 'high' }),
});
const approval = (sessionId, requestId) => ({ sessionId, requestId, revision: 2, status: "pending", createdAt: stamp,
  expiresAt: new Date(Date.now() + 3600000).toISOString(), description: `Approval ${sessionId}`,
  task: "Review the evidence", candidate: { providerId: "fixture", modelId: "fixture", priority: 1, approval: "ask" }, candidates: [],
});
api.listDelegationHistory = async query => {
  calls.push({ kind: "history", query });
  if (delayed && query.sessionId === "alpha") { const read = delayed; delayed = null; read.onRead?.(); return read.promise; }
  if (failure) throw Error("Fixture read failure");
  const selected = rows.filter(item => item.sessionId === query.sessionId);
  if (attemptPages && query.sessionId === "alpha") return query.offset === 0
    ? { entries: selected, attempts: attemptPages.slice(0, 2), nextOffset: 100 }
    : { entries: [], attempts: attemptPages.slice(1), nextOffset: null };
  return query.offset === 0 ? { entries: selected.filter(item => item.delegationId !== "old"), nextOffset: selected.some(item => item.delegationId === "old") ? 100 : null }
    : { entries: selected.filter(item => item.delegationId === "old"), nextOffset: null };
};
api.listDelegationApprovals = async () => {
  if (delayedApproval) { const read = delayedApproval; delayedApproval = null; read.onRead?.(); return read.promise; }
  return { requests: approvals };
};
api.onDelegationApprovalChanged = callback => { approvalEvents.add(callback); return () => approvalEvents.delete(callback); };
api.onAgentEvent = callback => { events.add(callback); return () => events.delete(callback); };
api.getSession = async (sessionId, options) => {
  calls.push({ kind: "detail", sessionId, options });
  const read = options.messageBefore === undefined ? delayedDetail : delayedPage;
  if (read) { read.onRead(); await read.promise; }
  if (detailFailure || (pageFailure && options.messageBefore !== undefined)) throw Error("Fixture detail page failure");
  if (options.messageBefore !== undefined) return { session: { id: sessionId,
    messages: options.messageBefore > 110 ? [{ id: "older-child-answer", role: "assistant", createdAt: stamp, content: "Child evidence beyond the first page", parentToolCallId: "call-old" }] : [],
    messageStart: options.messageBefore > 110 ? 110 : 0, messageEnd: options.messageBefore > 110 ? 170 : 50,
    hasMoreBefore: options.messageBefore > 110, hasMoreAfter: options.messageBefore <= 110,
  } };
  return { session: { id: sessionId, messages: [task("old", "completed")], messageStart: 50, messageEnd: 110, hasMoreBefore: true, hasMoreAfter: true } };
};
api.stopSubagents = async request => { calls.push({ kind: "stop", request }); return { pending: request.delegationIds ?? [] }; };
api.retrySubagent = async request => { calls.push({ kind: "retry", request }); return { accepted: true }; };
api.sendSubagentMessage = async request => { calls.push({ kind: "send", request }); return { accepted: true }; };
let approvalTarget, globalHistory = 0;
window.addEventListener("pi-desktop:notification-target", event => { approvalTarget = event.detail; });
useAppStore.setState({ activeSessionId: "alpha", sessions: [{ id: "alpha", title: "Verify current-session delegation visibility", source: "local" }, { id: "beta", title: "Other session", source: "local" }],
  retainedSessionIds: ["alpha", "beta"], retainedTranscripts: {}, transcriptViews: {}, sessionHistory: {}, messages: [],
  runningSessions: {}, settings: {}, workPanelTabs: [], activeWorkPanelTabId: null, workPanelOpen: false,
  workPanelContexts: {}, workspace: null,
});
function Panel() {
  const tab = useAppStore(state => state.workPanelTabs.find(item => item.id === state.activeWorkPanelTabId));
  if (tab?.kind === "subagents") return <SessionDelegationsPanel />;
  if (tab?.kind === "subagent") return <SubagentTranscriptTab delegationId={tab.resource} />;
  return null;
}
function Harness() {
  const open = useAppStore(state => state.workPanelOpen);
  return <main className="fixture-shell">
    <section className="fixture-main"><ConversationTopbar sidebarCollapsed={false} workPanelOpen={open}
      onToggleSidebar={() => {}} onNewTask={() => {}} onOpenSearch={() => {}} onOpenDelegations={() => { globalHistory++; }} />
      <div className="fixture-chat">
        <ThinkingRow message={{ id: 'fixture-thought', role: 'assistant', content: '', thinking: 'Fixture reasoning', status: 'complete' }} streaming={false} />
        <SubagentTaskList items={[task('live'), task('done', 'completed')].map(message => ({ kind: 'tool', message: { ...message, id: `inline-${message.id}` } }))} />
        <div style={{ height: 1500 }}>Parent conversation stays in place.</div>
      </div>
    </section><aside className="fixture-panel"><Panel /></aside>
  </main>;
}
const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(<Harness />));
const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const check = (value, text) => { if (!value) throw Error(text); };
const query = selector => { const node = document.querySelector(selector); check(node, `Missing ${selector}`); return node; };
const click = async selector => { flushSync(() => query(selector).click()); await settle(); };
const publishApprovals = next => { approvals = next; for (const request of next) for (const listener of approvalEvents) listener({ request }); };
const switchSession = (id, nextMessages = []) => {
  const state = useAppStore.getState();
  const result = switchWorkPanelContextState(state.workPanelContexts, state.activeSessionId,
    { tabs: state.workPanelTabs, activeTabId: state.activeWorkPanelTabId, open: state.workPanelOpen, fileRequest: null }, id);
  flushSync(() => useAppStore.setState({ activeSessionId: id, messages: nextMessages,
    retainedTranscripts: { ...state.retainedTranscripts, [state.activeSessionId]: state.messages },
    workPanelContexts: result.contexts, workPanelTabs: result.visible.tabs, activeWorkPanelTabId: result.visible.activeTabId, workPanelOpen: result.visible.open,
  }));
};
async function populate() {
  messages = [task("live"), task("failed", "failed"), task("done", "completed"), task("stopped", "stopped"),
    { ...task("starting"), toolStatus: "running", toolResult: undefined },
    { ...task("poll"), toolName: "TaskWait" }, { ...task("nested"), parentToolCallId: "call-live" },
    { id: "child-answer", role: "assistant", content: "Live child evidence", createdAt: stamp, parentToolCallId: "call-live" }];
  rows = [row("live"), row("failed", "failed"), row("done", "completed"), row("stopped", "stopped"), row("old", "completed"), row("foreign", "running", "beta")];
  flushSync(() => useAppStore.setState({ messages, runningSessions: { alpha: true, beta: true } }));
  const revision = Math.max(1, ...approvals.map(request => request.revision)) + 1;
  publishApprovals([approval("alpha", "own"), approval("beta", "foreign")].map(request => ({ ...request, revision })));
  await sessionDelegationsSource(api, "alpha").reload(); await settle();
}
function heldRead() {
  let resolve, onRead;
  const promise = new Promise(done => { resolve = done; });
  const started = new Promise(done => { onRead = done; });
  return { promise, resolve, onRead, started };
}
async function attemptIndex() {
  const runs = [...Array(67).fill("completed"), "running", "running", ...Array(5).fill("stopped")];
  rows = runs.map((status, index) => row(`run-${index}`, status));
  const skipReason = "Skipped because new user input is waiting.";
  attemptPages = Array.from({ length: 5 }, (_, i) => ({
    messageId: `attempt-${i}`, ...(i === 4 ? {} : { toolCallId: `attempt-call-${i}` }), createdAt: stamp,
    description: `Attempt ${i}`, task: `Follow-up ${i}`, ...(i === 4 ? {} : { resume: `run-${i}` }), outcome: i === 4 ? 'skipped' : 'rejected',
    reason: i === 4 ? skipReason : 'Unknown delegation.',
  }));
  const attempts = attemptPages.map(entry => ({ id: entry.messageId, role: 'tool', toolName: 'Task',
    toolCallId: entry.toolCallId, status: 'complete', toolStatus: 'error', content: '', createdAt: stamp,
    toolArgs: { task: entry.task, description: entry.description, resume: entry.resume, model: 'request-only-model', thinkingLevel: 'max' },
    toolResult: entry.outcome === 'rejected' ? { details: { error: `Unknown delegation "${entry.resume}". Reusable: private-list.` } } : { content: [{ type: 'text', text: skipReason }], details: {} },
  }));
  await click('.session-subagents-button');
  const recorded = attemptPages;
  for (const mode of ['legacy-live', 'merged', 'history-only']) {
    const full = mode !== 'history-only';
    attemptPages = mode === 'legacy-live' ? undefined : recorded;
    flushSync(() => useAppStore.setState({ messages: full ? [...runs.map((status, i) => task(`run-${i}`, status)), ...attempts] : [], runningSessions: { alpha: true } }));
    await sessionDelegationsSource(api, 'alpha').reload(); await settle();
    const panel = query('.session-subagents-panel');
    const groupSize = label => panel.querySelector(`section[aria-label="${label}"]`)?.querySelectorAll('[role=listitem]').length ?? 0;
    const header = query('.session-subagents-button').getAttribute('aria-label');
    check(header.includes('Needs attention 4') && groupSize('Needs attention') === 4,
      `${full ? 'full' : 'history-only'}: header ${header}; index attention ${groupSize('Needs attention')}; expected 4/4`);
    check(header.includes('2 running') && groupSize('Active') === 2 && groupSize('Completed') === 67 && groupSize(i18n.t('subagentControls.inactiveHistory')) === 6, 'Wrong outcome groups');
    check(panel.querySelectorAll('[role=listitem]').length === 79, 'Duplicate or missing original Task message');
    for (const [index, entry] of recorded.entries()) {
      const row = query(`[data-message-id="${entry.messageId}"]`);
      check(!row.querySelector('.subagent-task-actions, .subagent-model-info'), 'No-handle row offers runtime metadata/actions');
      const mutations = () => calls.filter(call => ['stop', 'retry', 'send'].includes(call.kind)).length;
      const before = mutations();
      await click(`[data-message-id="${entry.messageId}"] .subagent-task-open`);
      const detail = query('.subagent-transcript-tab');
      const reason = index === 4 ? i18n.t('chat.toolSkippedReason') : `${i18n.t('subagentControls.unknownResume')} · ${entry.resume}`;
      check(detail.querySelector('.subagent-attempt-reason')?.textContent === reason && detail.textContent.includes(entry.task), `Missing attempt-specific reason/brief ${index}`);
      check(!detail.textContent.includes('private-list'), 'Attempt exposed another reusable chain');
      check(detail.querySelector('.subagent-task-status')?.textContent === i18n.t(index === 4 ? 'subagentControls.notStarted' : 'subagentControls.rejected'), 'Attempt called a run failure');
      check(!detail.querySelector('.subagent-model-info, .stop-btn, .subagent-transcript-composer, [aria-label="Retry"]') && !detail.textContent.includes('request-only-model'), 'Non-run detail offers runtime metadata/actions');
      await click('[aria-label="All tasks"]');
      check(mutations() === before, 'Navigating a non-run sent a mutation');
    }
    if (full) {
      await click('[data-message-id="task-run-0"] .subagent-task-open');
      check(query('.subagent-transcript-heading .subagent-task-status').textContent === 'Completed' && !query('.subagent-transcript-tab').textContent.includes('Follow-up'), 'Rejected resume contaminated its target');
      await click('[aria-label="All tasks"]');
    }
    if (mode === 'history-only') {
      await click('.session-subagents-panel section[aria-label="Active"] h3 .stop-btn');
      check(calls.at(-1)?.kind === 'stop' && calls.at(-1).request.delegationIds?.sort().join(',') === 'run-67,run-68', 'Group stop did not target exactly the two recorded runs');
    }
  }
  attemptPages = undefined;
}
window.sessionDelegationsProbe = async stage => {
  if (stage === "prepare") {
    await settle();
    check(query(".session-subagents-button").textContent.trim() === "Subagents", "Empty session entry must remain discoverable");
    check(useAppStore.getState().workPanelTabs.length === 0, "Entry must not auto-open a panel");
    query(".session-subagents-button").focus();
  } else if (stage === "navigate") {
    await settle();
    check(document.querySelector(".session-subagents-empty"), `Keyboard entry did not open the empty index: ${JSON.stringify({ focus: document.activeElement?.outerHTML, tabs: useAppStore.getState().workPanelTabs, active: useAppStore.getState().activeWorkPanelTabId, panel: document.querySelector(".fixture-panel")?.textContent })}`);
    const emptyRead = heldRead(); delayed = emptyRead;
    await click('.session-subagents-heading button');
    check(query('.session-subagents-empty'), 'Hydrated empty state disappeared during manual refresh');
    check(!query('.session-subagents-scroll').textContent.includes(i18n.t('delegationHistory.loading')), 'Empty refresh flashed first-load text');
    check(!query('.session-subagents-button').textContent.includes(i18n.t('subagentControls.loading')), 'Empty topbar flashed loading');
    check(query('.session-subagents-heading button').disabled && query('.session-subagents-heading button').getAttribute('aria-busy') === 'true', 'Manual refresh has no bounded button feedback');
    emptyRead.resolve({ entries: [], nextOffset: null }); await settle();
    check(!query('.session-subagents-heading button').disabled, 'Manual refresh stayed disabled');
    await populate();
    const label = query(".session-subagents-button").getAttribute("aria-label");
    check(label.includes("1 running") && label.includes("1 awaiting approval") && !label.includes("2 running"), "Counts mix approvals, creation or other sessions");
    check(document.querySelectorAll('.session-subagents-panel [data-message-id="task-live"]').length === 1, "History/live snapshots duplicated");
    check(query('.session-subagents-panel [data-message-id="task-old"]'), "Index omitted history outside the chat window");
    check(!document.querySelector('[data-message-id="task-poll"], [data-message-id="task-nested"], [data-message-id="task-foreign"]'), "Index contains lifecycle or foreign tasks");
    check(query('[data-message-id="task-live"] .subagent-task-kind').textContent === i18n.t('subagentControls.taskLabel'), 'Task identity is missing');
    check(query('[data-message-id="task-live"] .subagent-task-icon .lucide-bot'), 'Delegation still looks like a thinking row');
    check(query('[data-message-id="task-live"] .subagent-model-info').textContent.includes('fixture/effective-model-with-long-name'), 'Index hides effective model');
    check(query('[data-message-id="task-live"] .subagent-model-effort').textContent.includes('high'), 'Index hides effective effort');
    check(query('[data-message-id="task-old"] .subagent-model-effort').textContent.includes(i18n.t('subagentControls.notRecorded')), 'Legacy effort was guessed');
    check(query('[data-message-id="task-done"] .subagent-model-effort').textContent.includes('off'), 'Explicit off was lost');
    check(query('[data-message-id="task-stopped"] .subagent-model-effort').textContent.includes('omit'), 'Explicit omit was lost');
    for (const trigger of ['history', 'lifecycle', 'approval']) {
      const liveRow = query('[data-message-id="task-live"]');
      const liveButton = liveRow.querySelector('.subagent-task-open');
      liveButton.focus();
      const beforeRefresh = liveRow.getBoundingClientRect().top;
      const scrollBefore = query('.session-subagents-scroll').scrollTop;
      const read = heldRead();
      if (trigger === 'approval') { delayedApproval = read; void delegationApprovalState(api).reload(); }
      else {
        delayed = read;
        if (trigger === 'history') void sessionDelegationsSource(api, 'alpha').reload();
        else for (const listener of events) listener({ sessionId: 'alpha', event: { type: 'tool_end', toolCallId: 'poll-refresh', result: { details: { delegationId: 'live' } } } });
      }
      await read.started; await settle();
      check(!query('.session-subagents-scroll').textContent.includes(i18n.t('delegationHistory.loading')), `${trigger}: background refresh inserted a loading paragraph`);
      check(liveRow === query('[data-message-id="task-live"]') && document.activeElement === liveButton, `${trigger}: refresh replaced the task or lost focus`);
      check(Math.abs(liveRow.getBoundingClientRect().top - beforeRefresh) < 1 && query('.session-subagents-scroll').scrollTop === scrollBefore, `${trigger}: refresh shifted reading position`);
      read.resolve(trigger === 'approval' ? { requests: approvals } : { entries: rows.filter(item => item.sessionId === 'alpha'), nextOffset: null });
      await settle();
      check(document.activeElement === liveButton, `${trigger}: settlement lost keyboard focus`);
    }
    const creatingRow = query('[data-message-id="task-starting"]');
    const creatingButton = creatingRow.querySelector('.subagent-task-open');
    const creatingTone = creatingRow.dataset.tone;
    creatingButton.focus();
    messages = messages.map(message => message.id === 'task-starting' ? task('starting') : message);
    flushSync(() => useAppStore.setState({ messages })); await settle();
    check(creatingRow === query('[data-message-id="task-starting"]') && document.activeElement === creatingButton, 'Receiving a delegation handle replaced the row or lost focus');
    check(creatingRow.dataset.tone === creatingTone, 'Result arrival changed task identity color');
    await click(".session-subagents-button");
    check(useAppStore.getState().workPanelTabs.filter(tab => tab.kind === "subagents").length === 1, "Repeated entry duplicated the index");
    await click(".session-subagents-approval button");
    check(approvalTarget?.sessionId === "alpha" && approvalTarget.requestId === "own" && approvalTarget.revision === approvals[0].revision, "Approval lost its identity");
    const chat = query(".fixture-chat"); chat.scrollTop = 200;
    flushSync(() => useAppStore.setState({ messages: [...messages, task("old", "completed"),
      { id: "older-child-answer", role: "assistant", createdAt: stamp, content: "Child evidence beyond the first page", parentToolCallId: "call-old" }],
      sessionHistory: { alpha: { messageStart: 50, hasMoreBefore: true } } }));
    const lookahead = heldRead(); delayedPage = lookahead;
    await click('[data-message-id="task-old"] .subagent-task-open');
    await lookahead.started;
    const detailBody = () => query(".subagent-transcript-scroll").textContent;
    const loading = i18n.t("delegationHistory.loading");
    check(detailBody().includes("Child evidence beyond the first page"), "Lookahead hid the visible child transcript");
    check(!detailBody().includes(loading), "Background lookahead inserted a loading paragraph above the visible child transcript");
    delayedPage = null; lookahead.resolve(); await settle();
    check(![...document.querySelectorAll(".subagent-transcript-scroll button")].some(button =>
      [i18n.t("chat.showEarlierMessages"), i18n.t("chat.loadLaterMessages")].includes(button.textContent)), "Complete live child transcript showed phantom pagination");
    await click('[aria-label="All tasks"]');
    flushSync(() => useAppStore.setState({ messages, sessionHistory: {} }));
    detailFailure = true;
    const initial = heldRead(); delayedDetail = initial;
    await click('[data-message-id="task-old"] .subagent-task-open');
    await initial.started;
    check(detailBody().includes("Retained historical report"), "Initial read hid the retained report");
    check(!detailBody().includes(loading), "Initial read inserted a loading paragraph alongside a retained report");
    delayedDetail = null; initial.resolve(); await settle();
    check(query(".subagent-transcript-list [role=alert]"), "Detail failure was hidden");
    detailFailure = false; pageFailure = true;
    await click(".subagent-transcript-list [role=alert] button");
    check(query(".subagent-transcript-list [role=alert]"), "Lookahead failure was hidden");
    pageFailure = false; await click(".subagent-transcript-list [role=alert] button");
    check(query(".subagent-transcript-tab").textContent.includes("Retained historical report"), "Historical report was inaccessible");
    check(calls.some(call => call.kind === "detail" && call.options.messageAround === "task-old"), "Historical detail was not bounded by task identity");
    check(chat.scrollTop === 200 && !useAppStore.getState().transcriptViews.alpha, "Opening detail moved the parent conversation");
    const later = [...document.querySelectorAll(".subagent-transcript-scroll button")].find(button => button.textContent === i18n.t("chat.loadLaterMessages"));
    check(later, "Missing later-history control for real child evidence");
    const readsBeforeClick = calls.filter(call => call.kind === "detail").length;
    flushSync(() => later.click()); await settle();
    check(query(".subagent-transcript-tab").textContent.includes("Child evidence beyond the first page"), "Later child messages remain inaccessible");
    const pagers = [...document.querySelectorAll(".subagent-transcript-scroll button")].filter(button => [i18n.t("chat.showEarlierMessages"), i18n.t("chat.loadLaterMessages")].includes(button.textContent));
    check(pagers.length === 0, "Parent history advertised nonexistent child content");
    check(calls.filter(call => call.kind === "detail").length === readsBeforeClick, "Click refetched already prepared pages");
    check(calls.some(call => call.kind === "detail" && call.options.messageBefore === 50), "Earlier lookahead did not use the original cursor");
    check(chat.scrollTop === 200 && !useAppStore.getState().transcriptViews.alpha, "Child paging moved the parent conversation");
    await click('[aria-label="All tasks"]');
    await click('[data-message-id="task-failed"] .subagent-task-open');
    check(query('.subagent-transcript-tab [role="alert"]').textContent.includes("Fixture failure"), "Failure details hidden");
    await click(`.subagent-transcript-heading [aria-label="${i18n.t("chat.retry")}"]`);
    check(calls.some(call => call.kind === "retry" && call.request.sessionId === "alpha" && call.request.delegationId === "failed"), "Retry lost session/task identity");
    await click('[aria-label="All tasks"]');
    await click('[data-message-id="task-live"] .subagent-task-open');
    check(query(".subagent-transcript-tab").textContent.includes("Live child evidence"), "Existing child transcript is not reused");
    check(query('.subagent-transcript-heading .subagent-model-info').textContent.includes('fixture/effective-model-with-long-name'), 'Detail model differs from the list');
    await click('.subagent-transcript-heading .stop-btn');
    check(calls.some(call => call.kind === "stop" && call.request.sessionId === "alpha" && call.request.delegationIds[0] === "live"), "Stop lost session/task identity");
    rows = rows.map(item => item.delegationId === "live" ? { ...item, status: "completed" } : item);
    messages = [...messages, { ...task("stale-poll"), toolName: "TaskList", toolResult: { details: { delegations: [{ delegationId: "live", status: "running" }] } } }];
    flushSync(() => useAppStore.setState({ messages }));
    await sessionDelegationsSource(api, "alpha").reload(); await settle();
    check(query(".subagent-transcript-heading .subagent-task-status").textContent === "Completed", "Old poll overrode durable terminal state");
    check(!document.querySelector(".subagent-transcript-heading .stop-btn"), "Completed task retained Stop");
    await click('[aria-label="All tasks"]');
    let resolve;
    delayed = { promise: new Promise(done => { resolve = done; }) };
    const stale = sessionDelegationsSource(api, "alpha").reload();
    switchSession("beta", [task("foreign")]); await settle();
    await click(".session-subagents-button");
    resolve({ entries: [row("stale")], nextOffset: null }); await stale; await settle();
    check(!query(".session-subagents-panel").textContent.includes("Review live") && !document.querySelector('[data-message-id="task-stale"]'), "Late response leaked across sessions");
    check(query(".session-subagents-button").getAttribute("aria-label").includes("1 running"), "Other session count is wrong");
    switchSession("alpha", messages); await settle();
    failure = true; await sessionDelegationsSource(api, "alpha").reload(); await settle();
    check(query(".session-subagents-panel [role=alert]") && query(".session-subagents-button").textContent.includes("Status unavailable"), "Read error pretends success");
    failure = false;
    const recovery = heldRead(); delayed = recovery;
    await click('.session-subagents-heading button');
    check(query('.session-subagents-panel [role=alert]'), 'Retry cleared stale warning before success');
    check(document.querySelector('[data-message-id="task-old"]'), 'Refresh failure discarded existing history');
    recovery.resolve({ entries: rows.filter(item => item.sessionId === 'alpha'), nextOffset: null }); await settle();
    check(!document.querySelector(".session-subagents-panel [role=alert]"), "Refresh did not recover");
    rows = rows.filter(item => item.sessionId === "alpha").map(item => ({ ...item, status: "completed" }));
    publishApprovals(approvals.map(item => ({ ...item, status: "approved" })));
    flushSync(() => useAppStore.setState({ messages: [task("live", "completed"), task("failed", "completed"), task("done", "completed"), task("stopped", "completed")], runningSessions: {} }));
    await sessionDelegationsSource(api, "alpha").reload(); await settle();
    check(query(".session-subagents-button").textContent.includes("History 5"), "Settled entry vanished or history count is wrong");
    const settledRead = heldRead(); delayed = settledRead;
    const settling = sessionDelegationsSource(api, 'alpha').reload(); await settle();
    check(query('.session-subagents-button').textContent.includes('History 5'), 'Background refresh replaced settled count with loading');
    settledRead.resolve({ entries: rows, nextOffset: null }); await settling; await settle();
    await click('.ct-actions [aria-label="Global delegations"]'); check(globalHistory === 1, "Global history is no longer reachable");
  } else if (stage === 'attempts') {
    await attemptIndex();
  }
  return { stage, passed: true };
};
window.sessionDelegationsLayout = async (theme, language) => {
  document.documentElement.dataset.theme = theme;
  await i18n.changeLanguage(language);
  await populate();
  await click(".session-subagents-button");
  query('.fixture-chat').scrollTop = 0;
  for (const element of document.querySelectorAll('.subagent-task-row, .subagent-model-info')) {
    check(element.scrollWidth <= element.clientWidth + 1, `${element.className} overflows at ${innerWidth}px`);
  }
  check(query('.fixture-chat .thinking .lucide-sparkles'), 'Thinking icon changed');
  check(query('.fixture-chat .subagent-task-icon .lucide-bot'), 'Inline task still uses a thinking icon');
  for (const selector of [".conversation-topbar", ".session-subagents-panel", ".session-subagents-heading"]) {
    const element = query(selector);
    check(element.scrollWidth <= element.clientWidth + 1, `${selector} overflows`);
    const bounds = element.getBoundingClientRect();
    check(bounds.height > 20 && bounds.top >= 0 && bounds.bottom <= innerHeight + 1, `${selector} is outside the viewport`);
  }
  const entry = query(".session-subagents-button");
  check(query(".session-subagents-label").getBoundingClientRect().width > 30 && entry.getBoundingClientRect().width > 90, "Topbar entry collapsed to an undiscoverable icon");
  check(getComputedStyle(entry).webkitAppRegion === "no-drag", "Entry is swallowed by window dragging");
  return { theme, language, width: innerWidth, passed: true };
};
window.fixtureReady = true;
