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
let rows = [], messages = [], approvals = [], failure = false, detailFailure = false, delayed;
const stamp = "2026-11-12T10:00:00.000Z";
const task = (id, status = "running") => ({ id: `task-${id}`, role: "tool", content: "", createdAt: stamp,
  toolName: "Task", toolCallId: `call-${id}`, toolStatus: "success", status: "complete",
  toolArgs: { agent: "reviewer", description: `Review ${id}`, task: `Validate ${id}` },
  toolResult: { details: { delegationId: id, status, ...(status === "failed" ? { error: { code: "FIXTURE", message: "Fixture failure" } } : {}) } },
});
const row = (id, status = "running", sessionId = "alpha") => ({ id, sessionId, sessionTitle: sessionId,
  messageId: `task-${id}`, delegationId: id, agentName: "reviewer", description: `Review ${id}`, task: `Validate ${id}`,
  report: id === "old" ? "Retained historical report" : undefined, createdAt: stamp, status,
});
const approval = (sessionId, requestId) => ({ sessionId, requestId, revision: 2, status: "pending", createdAt: stamp,
  expiresAt: new Date(Date.now() + 3600000).toISOString(), description: `Approval ${sessionId}`,
  task: "Review the evidence", candidate: { providerId: "fixture", modelId: "fixture", priority: 1, approval: "ask" }, candidates: [],
});
api.listDelegationHistory = async query => {
  calls.push({ kind: "history", query });
  if (delayed && query.sessionId === "alpha") { const promise = delayed.promise; delayed = null; return promise; }
  if (failure) throw Error("Fixture read failure");
  const selected = rows.filter(item => item.sessionId === query.sessionId);
  return query.offset === 0 ? { entries: selected.filter(item => item.delegationId !== "old"), nextOffset: selected.some(item => item.delegationId === "old") ? 100 : null }
    : { entries: selected.filter(item => item.delegationId === "old"), nextOffset: null };
};
api.listDelegationApprovals = async () => ({ requests: approvals });
api.onDelegationApprovalChanged = callback => { approvalEvents.add(callback); return () => approvalEvents.delete(callback); };
api.onAgentEvent = callback => { events.add(callback); return () => events.delete(callback); };
api.getSession = async (sessionId, options) => {
  calls.push({ kind: "detail", sessionId, options });
  if (detailFailure) throw Error("Fixture detail page failure");
  if (options.messageBefore !== undefined) return { session: { id: sessionId,
    messages: options.messageBefore > 110 ? [{ id: "older-child-answer", role: "assistant", createdAt: stamp, content: "Child evidence beyond the first page", parentToolCallId: "call-old" }] : [],
    messageStart: options.messageBefore > 110 ? 110 : 0, messageEnd: options.messageBefore > 110 ? 170 : 50,
    hasMoreBefore: options.messageBefore > 110, hasMoreAfter: options.messageBefore <= 110,
  } };
  return { session: { id: sessionId, messages: [task("old", "completed")], messageStart: 50, messageEnd: 110, hasMoreBefore: true, hasMoreAfter: true } };
};
api.stopSubagents = async request => { calls.push({ kind: "stop", request }); return { pending: request.delegationIds ?? [] }; };
api.retrySubagent = async request => { calls.push({ kind: "retry", request }); return { accepted: true }; };
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
      <div className="fixture-chat"><div style={{ height: 1500 }}>Parent conversation stays in place.</div></div>
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
window.sessionDelegationsProbe = async stage => {
  if (stage === "prepare") {
    await settle();
    check(query(".session-subagents-button").textContent.trim() === "Subagents", "Empty session entry must remain discoverable");
    check(useAppStore.getState().workPanelTabs.length === 0, "Entry must not auto-open a panel");
    query(".session-subagents-button").focus();
  } else if (stage === "navigate") {
    await settle();
    check(document.querySelector(".session-subagents-empty"), `Keyboard entry did not open the empty index: ${JSON.stringify({ focus: document.activeElement?.outerHTML, tabs: useAppStore.getState().workPanelTabs, active: useAppStore.getState().activeWorkPanelTabId, panel: document.querySelector(".fixture-panel")?.textContent })}`);
    await populate();
    const label = query(".session-subagents-button").getAttribute("aria-label");
    check(label.includes("1 running") && label.includes("1 awaiting approval") && !label.includes("2 running"), "Counts mix approvals, creation or other sessions");
    check(document.querySelectorAll('.session-subagents-panel [data-message-id="task-live"]').length === 1, "History/live snapshots duplicated");
    check(query('.session-subagents-panel [data-message-id="task-old"]'), "Index omitted history outside the chat window");
    check(!document.querySelector('[data-message-id="task-poll"], [data-message-id="task-nested"], [data-message-id="task-foreign"]'), "Index contains lifecycle or foreign tasks");
    await click(".session-subagents-button");
    check(useAppStore.getState().workPanelTabs.filter(tab => tab.kind === "subagents").length === 1, "Repeated entry duplicated the index");
    await click(".session-subagents-approval button");
    check(approvalTarget?.sessionId === "alpha" && approvalTarget.requestId === "own" && approvalTarget.revision === approvals[0].revision, "Approval lost its identity");
    const chat = query(".fixture-chat"); chat.scrollTop = 200;
    await click('[data-message-id="task-old"] .subagent-task-open');
    check(query(".subagent-transcript-tab").textContent.includes("Retained historical report"), "Historical report was inaccessible");
    check(calls.some(call => call.kind === "detail" && call.options.messageAround === "task-old"), "Historical detail was not bounded by task identity");
    check(chat.scrollTop === 200 && !useAppStore.getState().transcriptViews.alpha, "Opening detail moved the parent conversation");
    const later = [...document.querySelectorAll(".subagent-transcript-scroll button")].find(button => button.textContent === i18n.t("chat.loadLaterMessages"));
    check(later, "Missing later-history control");
    detailFailure = true; flushSync(() => later.click()); await settle();
    check(query(".subagent-transcript-list [role=alert]"), "Page failure was hidden");
    detailFailure = false; await click(".subagent-transcript-list [role=alert] button");
    check(query(".subagent-transcript-tab").textContent.includes("Child evidence beyond the first page"), "Later child messages remain inaccessible");
    const earlier = [...document.querySelectorAll(".subagent-transcript-scroll button")].find(button => button.textContent === i18n.t("chat.showEarlierMessages"));
    check(earlier, "Missing earlier-history control"); flushSync(() => earlier.click()); await settle();
    check(calls.some(call => call.kind === "detail" && call.options.messageBefore === 50), "Earlier page did not use the original cursor");
    check(chat.scrollTop === 200 && !useAppStore.getState().transcriptViews.alpha, "Child paging moved the parent conversation");
    await click('[aria-label="All tasks"]');
    await click('[data-message-id="task-failed"] .subagent-task-open');
    check(query('.subagent-transcript-tab [role="alert"]').textContent.includes("Fixture failure"), "Failure details hidden");
    await click(`.subagent-transcript-heading [aria-label="${i18n.t("chat.retry")}"]`);
    check(calls.some(call => call.kind === "retry" && call.request.sessionId === "alpha" && call.request.delegationId === "failed"), "Retry lost session/task identity");
    await click('[aria-label="All tasks"]');
    await click('[data-message-id="task-live"] .subagent-task-open');
    check(query(".subagent-transcript-tab").textContent.includes("Live child evidence"), "Existing child transcript is not reused");
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
    failure = false; await click(".session-subagents-heading button");
    check(!document.querySelector(".session-subagents-panel [role=alert]"), "Refresh did not recover");
    rows = rows.filter(item => item.sessionId === "alpha").map(item => ({ ...item, status: "completed" }));
    publishApprovals(approvals.map(item => ({ ...item, status: "approved" })));
    flushSync(() => useAppStore.setState({ messages: [task("live", "completed"), task("failed", "completed"), task("done", "completed"), task("stopped", "completed")], runningSessions: {} }));
    await sessionDelegationsSource(api, "alpha").reload(); await settle();
    check(query(".session-subagents-button").textContent.includes("History 5"), "Settled entry vanished or history count is wrong");
    await click('.ct-actions [aria-label="Global delegations"]'); check(globalHistory === 1, "Global history is no longer reachable");
  }
  return { stage, passed: true };
};
window.sessionDelegationsLayout = async (theme, language) => {
  document.documentElement.dataset.theme = theme;
  await i18n.changeLanguage(language);
  await populate();
  await click(".session-subagents-button");
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
