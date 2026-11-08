import React from "react";
import { flushSync } from "react-dom";
import { I18nextProvider } from "react-i18next";
import { api } from "../../src/lib/api";
import { useAppStore } from "../../src/stores/app-store";
import { NotificationCenter } from "../../src/components/NotificationCenter";
import { startCoreNotifications } from "../../src/stores/runtime/notification-runtime";

export async function notificationHistoryPath({ root, i18next, until, paint }) {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const click = node => { check(node && !node.disabled, "Missing enabled notification control"); flushSync(() => node.click()); };
  const find = (label, scope = document) => [...scope.querySelectorAll("button")].find(node => node.getAttribute("aria-label") === label || node.textContent.trim() === label);
  const translate = key => i18next.t("notifications." + key);
  const subscriptions = new Map();
  const subscribe = kind => listener => { const set = subscriptions.get(kind) ?? new Set(); set.add(listener); subscriptions.set(kind, set); return () => set.delete(listener); };
  const emit = (kind, value) => { for (const listener of subscriptions.get(kind) ?? []) listener(value); };
  api.onNotificationChanged = subscribe("outcome"); api.onAgentEvent = subscribe("agent");
  api.onNotificationActivated = subscribe("activate"); api.onNotificationDeliveryFailed = subscribe("failed");
  api.onDelegationApprovalChanged = subscribe("approval");
  api.listDelegationApprovals = async () => ({ requests: [] });
  api.showNativeNotification = async () => ({ shown: false, reason: "unavailable" });
  api.dismissNativeNotification = async () => ({ ok: true });
  let settlements = 0, clears = 0, failRead = false;
  api.respondDelegationApproval = async () => { settlements++; throw new Error("History must never authorize"); };
  api.extendDelegationApproval = async () => { settlements++; throw new Error("History must never extend consent"); };
  const runId = crypto.randomUUID(), createdAt = Date.now() + 1;
  let notifications = Array.from({ length: 40 }, (_, i) => ({
    id: `history-${runId}-${i}`, kind: i % 2 ? "task.failed" : "task.completed", sessionId: "a", sessionTitle: "Source A " + i,
    turnId: `turn-${runId}-${i}`, createdAt: new Date(createdAt + i).toISOString(), readAt: null,
  }));
  const request = { sessionId: "a", requestId: "receipt", sessionTitle: "Source A", projectTitle: "Project A", agentName: "Reviewer", status: "approved", task: "Read-only task details\n".repeat(20) };
  let receipts = [{ request, settledAt: "2026-11-02T00:00:00Z" }];
  const listReceipts = async () => ({ entries: structuredClone(receipts) });
  api.listDelegationApprovalHistory = listReceipts;
  api.markDelegationApprovalHistoryRead = async input => {
    if (failRead) throw new Error("Fixture receipt write failure");
    receipts = receipts.map(entry => !input.requestId || entry.request.requestId === input.requestId ? { ...entry, readAt: "2026-11-03T00:00:00Z" } : entry);
    return { ok: true };
  };
  api.clearDelegationApprovalHistory = async () => { clears++; receipts = []; return { ok: true }; };
  api.listNotifications = async () => ({ notifications: structuredClone(notifications), unreadCount: notifications.filter(row => !row.readAt).length });
  api.markAllNotificationsRead = async () => { notifications = notifications.map(row => ({ ...row, readAt: "2026-11-03T00:00:00Z" })); return { ok: true }; };
  api.clearNotifications = async () => { clears++; notifications = []; return { ok: true }; };
  const asks = Array.from({ length: 12 }, (_, i) => ({ sessionId: "a", requestId: "pending-" + i, questions: [{ question: "Private question", options: ["Yes"], multiSelect: false }] }));
  const hasFocus = document.hasFocus;
  document.hasFocus = () => true;
  flushSync(() => useAppStore.setState({
    settings: { notifications: { version: 1, channel: "in-app", sound: false } }, page: "settings", activeSessionId: "b",
    pendingAsks: { a: asks }, pendingPermissions: {}, pendingPlans: {}, notifications: [], unreadNotificationCount: 0, toasts: [],
    sessions: ["a", "b"].map(id => ({ id, title: "Source " + id, source: "desktop", mode: "agent", messageCount: 0 })),
  }));
  const stop = startCoreNotifications();
  try {
    flushSync(() => root.render(<I18nextProvider i18n={i18next}><div style={{ position: "fixed", bottom: 16, left: 16 }}><NotificationCenter /></div></I18nextProvider>));
    click(document.querySelector(".notification-trigger"));
    await until(() => document.querySelectorAll(".notification-item").length === 53 && !document.querySelector(".notification-item:disabled"));
    await paint();
    const panel = document.querySelector(".notification-popover");
    const scroll = panel.querySelector(".notification-scroll");
    const bounds = panel.getBoundingClientRect();
    check(bounds.top >= 0 && bounds.bottom <= innerHeight + 1 && bounds.right <= innerWidth + 1, "Panel fits actual viewport");
    check(scroll.clientHeight > 30 && scroll.scrollHeight > scroll.clientHeight, "Long mixed history remains scrollable");
    const owners = [...panel.querySelectorAll("*")].filter(node => /auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1);
    check(owners.length === 1 && owners[0] === scroll, "Exactly one scrolling owner for pending and history");
    const key = value => flushSync(() => panel.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })));
    key("End"); await paint();
    check(document.activeElement === [...panel.querySelectorAll(".notification-item")].at(-1) && scroll.scrollTop > 0, "End reaches final history row");
    key("Home"); await paint();
    check(document.activeElement === panel.querySelector(".notification-item") && scroll.scrollTop < 40, "Home returns to first pending entry");
    scroll.scrollTop = Math.round((scroll.scrollHeight - scroll.clientHeight) / 2);
    const before = scroll.scrollTop;
    emit("approval", { request }); await paint();
    check(Math.abs(scroll.scrollTop - before) < 2, "History refresh preserves scroll position");
    check(panel.querySelector(".notification-kind-icon.success") && panel.querySelector(".notification-kind-icon.failed") && panel.querySelector(".notification-kind-icon.pending"), "All semantic history colors are present");

    // A late list response cannot overwrite a newer terminal-event refresh.
    let resolveOld;
    api.listDelegationApprovalHistory = () => new Promise(resolve => { resolveOld = resolve; });
    emit("approval", { request });
    await until(() => resolveOld);
    api.listDelegationApprovalHistory = listReceipts;
    emit("approval", { request }); await paint();
    resolveOld({ entries: [] }); await paint();
    check(panel.querySelector('[aria-expanded="false"][data-notification-history-id]'), "Late response cannot erase newer receipt history");

    click(find(translate("unread"), panel));
    click(panel.querySelector('[aria-expanded="false"][data-notification-history-id]'));
    await until(() => receipts[0].readAt && panel.querySelector(".notification-receipt-detail")); await paint();
    check(panel.querySelector(".notification-receipt-detail") && !panel.querySelector('[aria-expanded="true"]').classList.contains("unread"), "Read receipt stays expanded within unread filter");
    check(useAppStore.getState().activeSessionId === "b" && settlements === 0, "Receipt expansion neither navigates nor authorizes");
    click(find(translate("all"), panel));
    check(panel.querySelectorAll("[data-notification-history-id]").length === 41, "All history retains read receipt and successful tasks");

    failRead = true; click(find(translate("markAllRead"), panel));
    await until(() => panel.querySelector(".notification-history-error"));
    failRead = false; click(find(i18next.t("delegationApproval.retry"), panel));
    await until(() => !panel.querySelector(".notification-history-error"));
    click(find(translate("clearAll"), panel));
    check(clears === 0 && settlements === 0, "Clear requires confirmation");
    await paint();
    const confirmation = panel.querySelector(".notification-clear-confirm");
    check(confirmation.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom, "Clear confirmation fits short viewport");
    click(find(translate("clearAll"), confirmation));
    await until(() => clears === 2 && panel.querySelectorAll("[data-notification-history-id]").length === 0);
    check(panel.querySelectorAll(".notification-pending .notification-item").length === 12 && settlements === 0 && useAppStore.getState().pendingAsks.a.length === 12, "Clearing history never settles pending work");
    await paint();
    check(document.activeElement === panel.querySelector(".notification-filter.active"), "Toolbar focus recovers after bulk action");
    api.listDelegationApprovalHistory = async () => { throw new Error("Fixture unreadable history"); };
    emit("approval", { request });
    await until(() => panel.querySelector(".notification-history-error"));
    check(!find(translate("clearAll"), panel).disabled, "Unreadable history can be explicitly cleared even without visible rows");
    api.listDelegationApprovalHistory = listReceipts;
    click(find(translate("clearAll"), panel));
    click(find(translate("clearAll"), panel.querySelector(".notification-clear-confirm")));
    await until(() => clears === 4 && !panel.querySelector(".notification-history-error"));
    check(settlements === 0 && useAppStore.getState().pendingAsks.a.length === 12, "Recovery clear still cannot settle requests");
    return { width: innerWidth, height: innerHeight, singleScroll: true, keyboard: true, staleResponse: true, readRetention: true, clearSafety: true, retry: true };
  } finally {
    flushSync(() => root.render(null)); stop(); document.hasFocus = hasFocus;
    check([...subscriptions.values()].every(set => set.size === 0), "History subscriptions are cleaned up");
  }
}
