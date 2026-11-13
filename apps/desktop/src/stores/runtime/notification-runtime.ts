import i18n from "i18next";
import { useSyncExternalStore } from "react";
import { isNotificationTarget, resolveNotificationPolicy, type AgentEventEnvelope, type CoreNotificationSource, type NotificationDeliveryResult, type NotificationTarget } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../app-store";
import { createNotificationDelivery, type NotificationEntry } from "../../lib/notification-delivery";
import { delegationApprovalState } from "../../lib/delegation-approval-state";
import { notificationIdentity, pendingNotificationTargets, type PendingNotification } from "../../lib/notification-pending";
import { playNotificationChime } from "../../lib/notification-sound";
import { notificationToastVariant } from "../../lib/notification-presentation";

const seen = new Set<string>();
const listeners = new Set<() => void>();
let pendingSnapshot: NotificationEntry[] = [];
let active: ReturnType<typeof createNotificationDelivery> | undefined;
const source = () => delegationApprovalState(api);
const report = () => console.warn("Core notification delivery failed; source state is unchanged");

function copy(kind: CoreNotificationSource, sessionId: string): { title: string; body: string } {
  const session = useAppStore.getState().sessions.find(item => item.id === sessionId);
  const sessionTitle = (session?.title || i18n.t("chat.untitledTask")).replace(/[\r\n\t]/g, " ").slice(0, 100);
  switch (kind) {
    case "ask": return { title: i18n.t("notifications.askTitle"), body: i18n.t("notifications.askBodyFallback") };
    case "permission": return { title: i18n.t("notifications.permissionTitle", { sessionTitle }), body: sessionTitle };
    case "plan": return { title: i18n.t("notifications.planApprovalTitle", { sessionTitle }), body: i18n.t("notifications.planApprovalBody") };
    case "delegation-approval": return { title: i18n.t("delegationApproval.center"), body: sessionTitle };
    case "delegation.failed": return { title: i18n.t("notifications.failedTitle", { sessionTitle }), body: i18n.t("notifications.delegationFailedBody") };
    case "task.failed": return { title: i18n.t("notifications.failedTitle", { sessionTitle }), body: i18n.t("notifications.failedBody") };
    case "task.completed": return { title: i18n.t("notifications.completedTitle", { sessionTitle }), body: i18n.t("notifications.completedBody") };
    case "test": return { title: i18n.t("notifications.testTitle"), body: i18n.t("notifications.testBody") };
  }
}
function entryFor(item: PendingNotification): NotificationEntry {
  return { ...item, id: notificationIdentity(item.target), ...copy(item.target.kind, item.target.sessionId),
    hydrated: item.target.kind === "delegation-approval" && source().isHydrated(item.target.sessionId, item.target.requestId) };
}
function publishPending() {
  const next = active?.pending() ?? [];
  if (JSON.stringify(next) === JSON.stringify(pendingSnapshot)) return;
  pendingSnapshot = next;
  for (const listener of listeners) listener();
}
export function usePendingNotifications() {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => pendingSnapshot,
  );
}
function targets() {
  return pendingNotificationTargets(useAppStore.getState(), source().getSnapshot().requests);
}

function prioritize<T extends { requestId: string }>(queues: Record<string, T[]>, target: NotificationTarget): Record<string, T[]> {
  const queue = queues[target.sessionId] ?? [];
  const selected = queue.find(item => item.requestId === target.requestId);
  return !selected || queue[0] === selected ? queues
    : { ...queues, [target.sessionId]: [selected, ...queue.filter(item => item !== selected)] };
}
/** Clicking locates current source state; it never approves or restarts a request. */
export async function activateNotificationTarget(target: NotificationTarget): Promise<boolean> {
  if (target.kind === "test") return false;
  const needsAction = ["ask", "permission", "plan", "delegation-approval"].includes(target.kind);
  const live = () => targets().some(item => notificationIdentity(item.target) === notificationIdentity(target));
  if (needsAction && !live()) return false;
  await useAppStore.getState().selectSession(target.sessionId);
  const selected = useAppStore.getState();
  if (selected.page !== "chat" || selected.activeSessionId !== target.sessionId) return false;
  if (needsAction && !live()) return false;
  // This changes presentation order only; request identities and consent are untouched.
  if (target.kind === "ask") {
    useAppStore.setState(state => ({ pendingAsks: prioritize(state.pendingAsks, target) }));
  } else if (target.kind === "permission") {
    useAppStore.setState(state => ({ pendingPermissions: prioritize(state.pendingPermissions, target) }));
  }
  window.dispatchEvent(new CustomEvent("pi-desktop:notification-target", { detail: target }));
  requestAnimationFrame(() => {
    const current = useAppStore.getState();
    if (current.page !== "chat" || current.activeSessionId !== target.sessionId) return;
    if (needsAction && !live()) return;
    const element = document.querySelector<HTMLElement>(`[data-notification-request-id="${CSS.escape(target.requestId ?? "")}"]`);
    element?.scrollIntoView({ block: "nearest" }); element?.focus({ preventScroll: true });
  });
  return true;
}
function inApp(entry: NotificationEntry) {
  useAppStore.getState().showToast(`${entry.title}: ${entry.body}`, {
    variant: notificationToastVariant(entry.target.kind),
    sound: false, duration: 8000,
    sessionId: entry.target.kind === "test" ? undefined : entry.target.sessionId,
    notificationTarget: entry.target,
    notificationId: entry.id,
  });
}
function createDriver() {
  return createNotificationDelivery({
    settings: () => useAppStore.getState().settings?.notifications,
    foreground: () => document.visibilityState === "visible" && document.hasFocus(),
    native: entry => api.showNativeNotification({
      id: entry.id, sessionId: entry.target.sessionId,
      kind: entry.target.kind.startsWith("task.") ? "task" : "interactive",
      title: entry.title, body: entry.body, createdAt: entry.createdAt, target: entry.target,
    }),
    dismiss: async (id, retire) => {
      useAppStore.setState(state => ({ toasts: state.toasts.filter(item => item.notificationId !== id) }));
      return api.dismissNativeNotification({ id, retire });
    },
    inApp, sound: playNotificationChime, seen, onError: report, onPendingChanged: publishPending,
  });
}
export async function testNotificationDelivery(): Promise<NotificationDeliveryResult> {
  const driver = active ?? createDriver();
  try {
    const target: NotificationTarget = { kind: "test", sessionId: "notification-test", requestId: crypto.randomUUID() };
    return await driver.once({ target, id: notificationIdentity(target), ...copy("test", target.sessionId) });
  } finally { if (!active) driver.dispose(); }
}

/** One app-shell owner, independent of the current page or active session. */
export function startCoreNotifications(): () => void {
  if (active) throw new Error("Core notification runtime already has an owner");
  const driver = createDriver(); active = driver;
  const approvalSource = source();
  const sync = () => { driver.sync(targets().map(entryFor)); publishPending(); };
  const offApprovals = approvalSource.subscribe(sync);
  const releaseApprovals = approvalSource.retain();
  const offStore = useAppStore.subscribe((state, previous) => {
    if (JSON.stringify(state.settings?.notifications) !== JSON.stringify(previous.settings?.notifications)) driver.refresh();
    if (state.pendingAsks !== previous.pendingAsks || state.pendingPermissions !== previous.pendingPermissions
      || state.pendingPlans !== previous.pendingPlans || state.sessions !== previous.sessions) sync();
  });
  const offOutcomes = api.onNotificationChanged(notification => {
    if (!useAppStore.getState().receiveNotification(notification)) return;
    const state = useAppStore.getState();
    if (state.page === "chat" && state.activeSessionId === notification.sessionId
      && document.visibilityState === "visible" && document.hasFocus()) return;
    const target: NotificationTarget = { kind: notification.kind, sessionId: notification.sessionId, requestId: notification.turnId };
    void driver.once({ target, id: notification.id, createdAt: notification.createdAt, ...copy(target.kind, target.sessionId) });
  });
  const offFailures = api.onAgentEvent((envelope: AgentEventEnvelope) => {
    const event = envelope.event;
    if (event.type !== "tool_end" || !event.result || typeof event.result !== "object") return;
    const details = (event.result as { details?: { code?: unknown } }).details;
    if (details?.code !== "DELEGATION_NO_AUTHORIZED_MODEL") return;
    const target: NotificationTarget = { kind: "delegation.failed", sessionId: envelope.sessionId, requestId: event.toolCallId };
    void driver.once({ target, id: notificationIdentity(target), ...copy(target.kind, target.sessionId) });
  });
  const failedNative = new Set<string>();
  const offNativeFailed = api.onNotificationDeliveryFailed(({ id, target }) => {
    if (!isNotificationTarget(target) || failedNative.has(id) || !seen.has(id)
      || !resolveNotificationPolicy(useAppStore.getState().settings?.notifications, target.kind).enabled) return;
    if (["ask", "permission", "plan", "delegation-approval"].includes(target.kind)
      && !targets().some(item => notificationIdentity(item.target) === notificationIdentity(target))) return;
    if (target.kind.startsWith("task.") && !useAppStore.getState().notifications.some(item => item.id === id && !item.readAt)) return;
    failedNative.add(id);
    if (failedNative.size > 2048) { const oldest = failedNative.values().next().value; if (oldest) failedNative.delete(oldest); }
    inApp({ id, target, ...copy(target.kind, target.sessionId) });
  });
  const offActivation = api.onNotificationActivated(({ id, sessionId, target }) => {
    const store = useAppStore.getState();
    const action = target && !target.kind.startsWith("task.")
      ? activateNotificationTarget(target)
      : store.notifications.some(item => item.id === id) ? store.openNotification(id) : store.selectSession(sessionId);
    void action.catch(report);
  });
  const onLanguage = () => sync();
  i18n.on("languageChanged", onLanguage);
  sync();
  return () => {
    offStore(); offOutcomes(); offFailures(); offActivation(); offNativeFailed(); offApprovals(); releaseApprovals();
    i18n.off("languageChanged", onLanguage);
    driver.dispose(); active = undefined; publishPending();
  };
}
