import React from "react";
import { flushSync } from "react-dom";
import { I18nextProvider } from "react-i18next";
import { api } from "../../src/lib/api";
import { useAppStore } from "../../src/stores/app-store";
import { NotificationPreferences } from "../../src/components/settings/NotificationPreferences";
import { NotificationCenter } from "../../src/components/NotificationCenter";
import { AskToolCard } from "../../src/components/AskToolCard";
import { startCoreNotifications } from "../../src/stores/runtime/notification-runtime";
import { resolveNotificationPolicy } from "@pi-desktop/shared";
import "../../src/styles/chrome.css";
import "../../src/styles/settings.css";

export async function notificationUserPath({ root, i18next, until, paint }) {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const t = key => i18next.t("notificationSettings." + key);
  const button = (label, scope = document) => [...scope.querySelectorAll("button")].find(node => node.getAttribute("aria-label") === label || node.textContent.trim() === label);
  const click = (label, scope) => { const node = button(label, scope); check(node && !node.disabled, "Missing enabled control: " + label); flushSync(() => node.click()); };
  const choose = async (label, option) => { click(label); await until(() => button(option)?.getAttribute("role") === "option"); click(option); };
  const input = (label, value) => {
    const node = document.querySelector(`input[aria-label="${CSS.escape(label)}"]`);
    check(node, "Missing input: " + label);
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(node, String(value));
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  let saved = { theme: "dark", delegation: { version: 1, approvalTimeoutSeconds: 0, models: [] } };
  const originalPolicy = JSON.stringify(saved.delegation);
  let fail = false, writes = 0;
  api.getSettings = async () => structuredClone(saved);
  api.setSettings = async value => { if (fail) throw new Error("Fixture disk failure"); saved = structuredClone(value); writes++; return { ok: true }; };
  let nativeResult = { shown: true, reason: "requested" };
  api.showNativeNotification = async () => nativeResult;
  api.dismissNativeNotification = async () => ({ ok: true });
  flushSync(() => useAppStore.setState({ settings: saved, toasts: [], page: "settings" }));
  let mount = 0;
  const renderSettings = scope => flushSync(() => root.render(<I18nextProvider i18n={i18next}><NotificationPreferences key={++mount} scope={scope} /></I18nextProvider>));
  const save = async scope => {
    const before = writes;
    click(i18next.t("common.save") + " " + t(scope === "global" ? "title" : "delegation"));
    await until(() => writes > before && document.querySelector('section[aria-busy="false"]'));
  };
  renderSettings("global");
  check(writes === 0, "Opening preferences never persists defaults");
  await choose(t("channel"), t("in-app")); click(t("sound")); input(t("volumeLabel"), 35); click(t("failures"));
  await save("global"); renderSettings("global");
  check(saved.notifications.channel === "in-app" && saved.notifications.volume === 35 && saved.notifications.sound === false && saved.notifications.categories.failures === false, "Global fields persist together");
  click(t("sound")); fail = true; click(i18next.t("common.save") + " " + t("title"));
  await until(() => document.querySelector('[role="alert"]')?.textContent === t("saveFailed"));
  check(saved.notifications.sound === false && button(t("sound")).getAttribute("aria-checked") === "true", "Failed saves retain editable drafts without changing persisted values");
  fail = false; await save("global");
  renderSettings("delegation"); check(button(t("mode")).textContent.includes(t("inherit")), "Delegation inherits by default");
  await choose(t("mode"), t("custom")); click(t("sound")); input(t("repeat"), 5);
  check(button(t("preview")).disabled, "Muted delegation preview is disabled");
  check(button(i18next.t("common.save") + " " + t("delegation")).disabled, "Invalid repeat cannot save");
  click(t("sound")); input(t("volumeLabel"), 40);
  const AudioContext = window.AudioContext; const gains = [];
  window.AudioContext = class {
    state = "running"; currentTime = 0; destination = {};
    createOscillator() { return { frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime(value) { gains.push(value); }, exponentialRampToValueAtTime() {} }, connect() {} }; }
    close() { return Promise.resolve(); }
  };
  try { click(t("preview")); } finally { window.AudioContext = AudioContext; }
  check(Math.abs(gains[0] - 0.0088) < 1e-9, "Delegation preview uses draft volume and existing chime");
  click(t("sound")); input(t("repeat"), 10); await save("delegation");
  renderSettings("global"); await choose(t("channel"), t("system")); await save("global");
  check(saved.notifications.delegation.sound === false && saved.notifications.delegation.repeatIntervalSeconds === 10, "Global save preserves latest override");
  click(t("test")); await until(() => document.querySelector('[role="status"]')?.textContent === t("requested"));
  nativeResult = { shown: false, reason: "unavailable" };
  click(t("test")); await until(() => document.querySelector('[role="alert"]')?.textContent === t("failedResult"));
  renderSettings("delegation"); await choose(t("mode"), t("inherit")); await save("delegation");
  check(!Object.hasOwn(saved.notifications, "delegation") && resolveNotificationPolicy(saved.notifications, "delegation-approval").channel === "system", "Returning to inheritance follows current global settings");
  check(JSON.stringify(saved.delegation) === originalPolicy, "Notification saves never alter model scheduling");
  click(t("openGlobal")); check(useAppStore.getState().settingsTab === "notifications", "Shortcut reaches global Notifications");
  renderSettings("global");
  for (const locale of Object.keys(i18next.options.resources)) {
    await i18next.changeLanguage(locale); await paint();
    check(document.documentElement.scrollWidth <= innerWidth + 1, "Settings remain usable in narrow layout: " + locale + " " + JSON.stringify([...document.querySelectorAll("button, input, section")].filter(node => node.getBoundingClientRect().right > innerWidth + 1).map(node => ({ text: node.textContent.slice(0, 80), class: node.className, width: node.getBoundingClientRect().width }))));
    check(!document.body.textContent.includes("notificationSettings."), "Notification settings translated: " + locale);
  }
  await i18next.changeLanguage("en");
  flushSync(() => root.render(null));

  const subscriptions = new Map();
  const subscribe = kind => listener => { const set = subscriptions.get(kind) ?? new Set(); set.add(listener); subscriptions.set(kind, set); return () => set.delete(listener); };
  api.onNotificationChanged = subscribe("outcome"); api.onAgentEvent = subscribe("agent");
  api.onNotificationActivated = subscribe("activate"); api.onNotificationDeliveryFailed = subscribe("failed");
  api.onDelegationApprovalChanged = subscribe("approval"); api.listDelegationApprovals = async () => ({ requests: [] });
  api.listNotifications = async () => ({ notifications: [], unreadCount: 0 });
  api.clearNotifications = async () => ({ ok: true }); api.markAllNotificationsRead = async () => ({ ok: true });
  api.listDelegationApprovalHistory = async () => ({ entries: [] });
  api.markDelegationApprovalHistoryRead = async () => ({ ok: true });
  api.clearDelegationApprovalHistory = async () => ({ ok: true });
  api.getSession = async id => ({ session: { id, title: "Source session", source: "desktop", mode: "agent", providerId: "fixture", modelId: "fixture", messages: [] } });
  api.pendingPlans = async () => ({ plans: [] });
  api.pendingInteractive = async id => ({ asks: useAppStore.getState().pendingAsks[id] ?? [], permissions: [] });
  const hasFocus = document.hasFocus;
  document.hasFocus = () => true;
  flushSync(() => useAppStore.setState({
    settings: { ...saved, notifications: { version: 1, channel: "in-app", sound: false } }, page: "settings", activeSessionId: "b",
    pendingAsks: {}, pendingPermissions: {}, pendingPlans: {}, notifications: [], unreadNotificationCount: 0, toasts: [],
    sessions: ["a", "b"].map(id => ({ id, title: "Source " + id, source: "desktop", mode: "agent", providerId: "fixture", modelId: "fixture", messageCount: 0 })),
  }));
  function Surface() {
    const state = useAppStore();
    const current = state.pendingAsks[state.activeSessionId]?.[0];
    return <><div style={{ position: "fixed", bottom: 16, left: 16 }}><NotificationCenter /></div><main>
      <h1>{state.page}</h1>{state.page === "chat" && current ? <AskToolCard key={current.requestId} request={current} /> : null}
    </main></>;
  }
  const stop = startCoreNotifications();
  try {
    flushSync(() => root.render(<I18nextProvider i18n={i18next}><Surface /></I18nextProvider>));
    for (const requestId of ["first-question", "exact-question"]) flushSync(() => useAppStore.getState().handleAgentEvent({ sessionId: "a", ts: 1, event: {
      type: "asktool_request", request: { sessionId: "a", requestId, questions: [{ question: "Private question body", options: ["Continue", "Stop"], multiSelect: false }] },
    } }));
    const target = useAppStore.getState().toasts.find(item => item.notificationTarget?.requestId === "exact-question").notificationTarget;
    check(useAppStore.getState().toasts.find(item => item.notificationTarget?.requestId === "exact-question").variant === "warning", "Pending reminders are warning-colored, never successful");
    check(useAppStore.getState().page === "settings", "Arrival never steals navigation");
    flushSync(() => document.querySelector(".notification-trigger").click());
    await until(() => document.querySelectorAll(".notification-pending .notification-item").length === 2);
    check(!document.querySelector(".notification-pending").textContent.includes("Private question body"), "Reminder summaries exclude private question content");
    const entry = document.querySelectorAll(".notification-pending .notification-item")[1];
    flushSync(() => entry.click());
    await until(() => document.querySelector('[data-notification-request-id="exact-question"]'));
    await paint();
    check(document.activeElement?.dataset.notificationRequestId === "exact-question", "Exact question receives focus, not the bell trigger: " + document.activeElement?.outerHTML.slice(0, 200));
    check(useAppStore.getState().activeSessionId === "a" && document.querySelector('[data-notification-request-id="exact-question"]'), "Bell click opens the exact real question card");
    flushSync(() => useAppStore.setState({ pendingAsks: {} }));
    await paint();
    flushSync(() => document.querySelector(".notification-trigger").click());
    await until(() => document.querySelector(".notification-popover"));
    check(!document.querySelector(".notification-pending"), "Settlement removes live pending entries");
    useAppStore.getState().setPage("settings");
    for (const listener of subscriptions.get("activate")) listener({ id: "late", sessionId: "a", target });
    await paint();
    check(useAppStore.getState().page === "settings", "A late activation cannot reopen a settled question");
  } finally {
    flushSync(() => root.render(null)); stop(); document.hasFocus = hasFocus;
  }
  check([...subscriptions.values()].every(set => set.size === 0), "Core subscriptions are disposed");
  return { settings: true, failureRecovery: true, inheritance: true, exactCard: true, lateClick: true, locales: 9 };
}
