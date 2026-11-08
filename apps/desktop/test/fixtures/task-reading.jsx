import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { AssistantTurn } from "../../src/features/chat/transcript/AssistantTurn";
import { SubagentTranscriptTab } from "../../src/components/workpanel/SubagentTranscriptTab";
import { TranscriptDisclosureProvider } from "../../src/features/chat/transcript/disclosure";
import { SlotSessionProvider } from "../../src/plugins/renderer-slots/use-slots";
import { buildTranscriptEntries } from "../../src/lib/assistant-turns";
import { currentReviewFocusRequest } from "../../src/lib/review-focus-request";
import { useAppStore } from "../../src/stores/app-store";

await i18n.use(initReactI18next).init({ lng: "en", resources: { en: { translation: catalogs.en }, "zh-CN": { translation: catalogs["zh-CN"] } } });
const calls = [];
window.piDesktop = { platform: "win32", channels: IPC, invoke: async (channel, request) => {
  calls.push({ channel, request }); return { ok: true, data: { pending: [], accepted: true } };
}, on: () => () => {} };
const base = { createdAt: "2026-11-08T09:00:00Z", status: "complete", content: "" };
const thinking = { ...base, id: "thinking", role: "assistant", thinking: "Compare recorded response bytes before changing the converter.", status: "streaming" };
const task = (id, description, status) => ({ ...base, id: `task-${id}`, role: "tool", toolCallId: `task-call-${id}`, toolName: "Task", toolStatus: "success",
  toolArgs: { agent: "explorer", description, task: "Validate the local fixture and report observable results." },
  toolResult: { details: { delegationId: id, status, modelId: "Fixture model", thinkingLevel: "high", ...(status === "failed" ? { error: { code: "FIXTURE_FAILURE", message: "Fixture interrupted before validation finished." } } : {}) } },
});
const edit = { ...base, id: "edit", role: "tool", toolName: "Edit", toolCallId: "edit-call", toolStatus: "success", toolArgs: { path: "src/capture.ts" },
  toolResult: { details: { root: "workspace", review: { version: 1, snapshotId: "snapshot-edit", messageId: "edit", path: "src/capture.ts", operation: "edit", status: "modified", state: "active", additions: 18, deletions: 3, hunks: [], reversible: true } } },
};
let active = true;
let messages = [
  { ...base, id: "user", role: "user", content: "Preserve response evidence and validate the archive." },
  thinking,
  { ...base, id: "read", role: "tool", toolName: "Read", toolStatus: "success", toolArgs: { path: "src/capture.ts" } },
  { ...base, id: "progress", role: "assistant", content: "The converter currently treats missing response bodies as empty. I will preserve those states separately and validate the result locally." },
  task("a", "Protocol integration", "running"), task("b", "Browser response capture", "completed"), task("c", "Archive verification", "failed"),
  edit,
  { ...base, id: "child-read", role: "tool", toolName: "Read", toolStatus: "success", parentToolCallId: "task-call-a", toolArgs: { path: "tests/capture.test.ts" } },
  { ...base, id: "child-think", role: "assistant", thinking: "Compare four response states.", parentToolCallId: "task-call-a" },
  { ...base, id: "child-report", role: "assistant", content: "The local fixture distinguishes empty, binary, missing and unreadable bodies. The archive remains available after a non-zero exit.", parentToolCallId: "task-call-a" },
  { ...base, id: "answer", role: "assistant", content: "Response evidence is preserved. The remaining step is to check the archive metadata." },
];
useAppStore.setState({ activeSessionId: "fixture", sessions: [{ id: "fixture", source: "local", title: "Fixture" }],
  settings: { showThinking: true, smoothStreaming: false }, messages, runningSessions: { fixture: true },
  workPanelTabs: [], activeWorkPanelTabId: null, retainedTranscripts: {}, transcriptViews: {}, sessionHistory: {},
});
const root = createRoot(document.getElementById("root"));
function Panel() {
  const tab = useAppStore(state => state.workPanelTabs.find(tab => tab.id === state.activeWorkPanelTabId));
  return <SubagentTranscriptTab delegationId={tab?.kind === "subagent" ? tab.resource : "a"} />;
}
function render() {
  flushSync(() => {
    useAppStore.setState({ messages, runningSessions: { fixture: active } });
    const entry = buildTranscriptEntries(messages).entries.find(entry => entry.kind === "assistant-turn");
    root.render(<main className="fixture-grid">
      <section className="fixture-chat"><SlotSessionProvider sessionId="fixture"><TranscriptDisclosureProvider sessionId="fixture">
        <AssistantTurn entry={entry} isActive={active} />
      </TranscriptDisclosureProvider></SlotSessionProvider></section>
      <aside className="fixture-panel"><Panel /></aside>
    </main>);
  });
}
const frame = () => new Promise(requestAnimationFrame);
const settle = async () => { await frame(); await frame(); };
const check = (condition, message) => { if (!condition) throw new Error(message); };
const query = selector => { const element = document.querySelector(selector); check(element, `Missing ${selector}`); return element; };
const click = async selector => { const target = query(selector); check(target.getClientRects().length, `Hidden ${selector}`); flushSync(() => target.click()); await settle(); };
render();
window.taskReadingProbe = async stage => {
  if (stage === "initial") {
    await settle();
    check(query(".fixture-chat .turn-process > button").getAttribute("aria-expanded") === "true", "Live process is not visible");
    check(query(".fixture-chat .process-activity-group.grouped > button").getAttribute("aria-expanded") === "false", "Activity auto-expanded");
    check(!document.querySelector(".fixture-chat .thinking-prose"), "Thinking body auto-expanded");
    check(query(".fixture-chat .turn-changes-card").getClientRects().length, "Live changes are hidden");
    check(document.querySelectorAll(".subagent-topology-root, .subagent-transcript-composer, textarea:disabled").length === 0, "Old topology/composer remains");
    await click(".fixture-chat .process-activity-group.grouped > button");
    query(".fixture-chat .thinking > button").focus();
  } else if (stage === "keyboard-open") {
    await settle();
    check(query(".fixture-chat .thinking > button").getAttribute("aria-expanded") === "true", "Keyboard did not open thinking");
    messages = messages.map(message => message.id === "thinking" ? { ...message, status: "complete", thinking: `${message.thinking} Recorded work remains intact.` } : message);
    render(); await settle();
    check(query(".fixture-chat .thinking > button").getAttribute("aria-expanded") === "true", "Completion discarded manual choice");
    check(query(".fixture-chat .thinking-prose").textContent.includes("Recorded work"), "Thinking did not update");
    query(".fixture-chat .thinking > button").focus();
  } else if (stage === "keyboard-close") {
    await settle();
    check(query(".fixture-chat .thinking > button").getAttribute("aria-expanded") === "false", "Keyboard did not close thinking");
    document.activeElement.blur();
    active = false;
    messages = messages.map(message => message.id === "answer" ? { ...message, error: { code: "FIXTURE", message: "Connection interrupted" } } : message);
    render(); await settle();
    check(query(".fixture-chat .turn-changes-card").getClientRects().length, "Failure removed recorded changes");
    check(!document.querySelector(".fixture-panel header .stop-btn"), "Ended parent left a running task control");
    check(query(".fixture-panel header .subagent-task-status").textContent === i18n.t("chat.subagentStatus.aborted"), "Detail retained stale running status");
    await click(".fixture-chat .turn-changes-head");
    await click(".fixture-chat .turn-changes-row");
    check(currentReviewFocusRequest().snapshotIds.includes("snapshot-edit"), "Review focus lost snapshot attribution");
    active = true;
    render(); await settle();
  } else if (stage === "tasks") {
    if (query(".fixture-chat .turn-process > button").getAttribute("aria-expanded") !== "true") await click(".fixture-chat .turn-process > button");
    await click('.fixture-chat [data-message-id="task-a"] .subagent-task-open');
    check(query(".fixture-panel .subagent-task-title").textContent === "Protocol integration", "Task detail has wrong title");
    check(!query(".fixture-panel").querySelector("textarea"), "Detail has a fake composer");
    await click('.fixture-panel [aria-label="All tasks"]');
    check(query('.fixture-panel .subagent-task-group[aria-label="Completed"]').textContent.includes("Browser response"), "Task list lost completed work");
    await click('.fixture-panel [data-message-id="task-c"] .subagent-task-open');
    check(query(".fixture-panel [role=alert]").textContent.includes("Fixture interrupted"), "Failure reason hidden");
    const retry = query(`.fixture-panel header [aria-label="${i18n.t("chat.retry")}"]`);
    flushSync(() => retry.click()); await settle();
    check(calls.some(call => call.request?.delegationId === "c"), "Retry lost delegation identity");
    await click('.fixture-panel [aria-label="All tasks"]');
    await click('.fixture-panel [data-message-id="task-a"] .subagent-task-open');
    flushSync(() => query(".fixture-panel header .stop-btn").click()); await settle();
    check(calls.some(call => call.request?.delegationIds?.includes("a")), "Stop lost delegation identity");
  } else if (stage === "search") {
    flushSync(() => useAppStore.setState({ transcriptViews: { fixture: { messages, messageStart: 0, hasMoreBefore: false, hasMoreAfter: false, loading: null, focus: { sessionId: "fixture", requestId: 1, messageId: "child-read", query: "capture" } } } }));
    await settle();
    check(query(".fixture-panel .turn-process > button").getAttribute("aria-expanded") === "true", "Search did not reveal process");
  }
  return { stage, passed: true };
};
window.taskReadingLayout = async (theme, panelWidth, language = "en") => {
  await i18n.changeLanguage(language);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty("--fixture-panel-width", `${panelWidth}px`);
  active = true;
  messages = messages.map(message => message.id === "answer" ? { ...message, error: undefined } : message);
  render(); await settle();
  const outer = query(".fixture-chat .turn-process > button");
  if (outer.getAttribute("aria-expanded") !== "true") { flushSync(() => outer.click()); await settle(); }
  const back = document.querySelector('.fixture-panel header button');
  if (back && !document.querySelector('.fixture-panel .subagent-task-list')) { flushSync(() => back.click()); await settle(); }
  for (const selector of [".fixture-chat", ".fixture-panel", ".fixture-panel .subagent-task-list"]) {
    const element = query(selector);
    check(element.scrollWidth <= element.clientWidth + 1, `${selector} overflows at ${panelWidth}px`);
  }
  const icons = [...document.querySelectorAll(".fixture-chat .subagent-task-icon")];
  check(new Set(icons.map(icon => getComputedStyle(icon).color)).size > 1, "Task identities have no color distinction");
  return { theme, panelWidth, language, passed: true };
};
