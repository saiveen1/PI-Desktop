import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "pi-core-notification-"));
const entry = join(temp, "runtime.cjs");
await build({
  stdin: { contents: `
    export { useAppStore } from "./src/stores/app-store";
    export { api } from "./src/lib/api";
    export { startCoreNotifications, activateNotificationTarget } from "./src/stores/runtime/notification-runtime";
  `, resolveDir: join(root, "apps/desktop"), loader: "ts" },
  outfile: entry, bundle: true, platform: "node", format: "cjs", jsx: "automatic",
  define: { "import.meta.env.DEV": "false" },
});
after(() => rm(temp, { recursive: true, force: true }));
const require = createRequire(import.meta.url);
const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function harness() {
  delete require.cache[entry];
  const runtime = require(entry);
  const { api, useAppStore: store } = runtime;
  const events = {}, native = [], dismissed = [], focused = [], navigation = [];
  let foreground = true, snapshot = { requests: [] };
  const frames = [];
  globalThis.window = { dispatchEvent: event => { navigation.push(event.detail); }, AudioContext: undefined };
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
  globalThis.CSS = { escape: value => value };
  globalThis.requestAnimationFrame = callback => { frames.push(callback); };
  globalThis.document = {
    visibilityState: "visible", hasFocus: () => foreground,
    querySelector: selector => ({ scrollIntoView() {}, focus: () => focused.push(selector) }),
  };
  const subscribe = name => listener => {
    (events[name] ??= new Set()).add(listener);
    return () => events[name].delete(listener);
  };
  api.onNotificationChanged = subscribe("outcome");
  api.onAgentEvent = subscribe("agent");
  api.onNotificationDeliveryFailed = subscribe("nativeFailed");
  api.onNotificationActivated = subscribe("activation");
  api.onDelegationApprovalChanged = subscribe("approval");
  api.listDelegationApprovals = async () => snapshot;
  api.showNativeNotification = async request => { native.push(request); return { shown: true, reason: "requested" }; };
  api.listNotifications = async () => ({ notifications: [], unreadCount: 0 });
  api.dismissNativeNotification = async request => { dismissed.push(request); return { ok: true }; };
  api.markAllNotificationsRead = async () => ({ ok: true });
  api.clearNotifications = async () => ({ ok: true });
  api.markNotificationRead = async () => ({ ok: true });
  api.getSession = async id => ({ session: {
    id, title: `Session ${id}`, source: "desktop", mode: "agent", providerId: "provider", modelId: "model",
    messages: [{ id: "message", role: "assistant", content: "Working", createdAt: new Date().toISOString() }],
  } });
  api.pendingPlans = async () => ({ plans: [] });
  api.pendingInteractive = async id => ({ asks: store.getState().pendingAsks[id] ?? [], permissions: store.getState().pendingPermissions[id] ?? [] });
  store.setState({
    sessions: ["a", "b"].map(id => ({ id, title: `Session ${id}`, source: "desktop", mode: "agent", providerId: "provider", modelId: "model", messageCount: 1 })),
    activeSessionId: "b", page: "settings", settings: {}, toasts: [],
    pendingAsks: {}, pendingPermissions: {}, pendingPlans: {}, notifications: [], unreadNotificationCount: 0,
  });
  const emit = (name, value) => { for (const listener of events[name] ?? []) listener(value); };
  return { ...runtime, store, events, native, dismissed, focused, navigation,
    emit, background: () => { foreground = false; }, snapshot: value => { snapshot = value; },
    frame: () => { while (frames.length) frames.shift()(); },
  };
}
const ask = requestId => ({ sessionId: "a", requestId, questions: [{ question: "private question" }] });
const approval = (status = "pending", revision = 1) => ({
  sessionId: "a", requestId: "approval", revision, status,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
const outcome = (id = "outcome") => ({ id, kind: "task.failed", sessionId: "a", turnId: id,
  createdAt: new Date().toISOString(), title: "private title", body: "private error", readAt: null });

test("a Settings-visible request opens the exact action, then settlement withdraws it and late clicks do nothing", async () => {
  const h = harness(), stop = h.startCoreNotifications();
  h.store.setState({ pendingAsks: { a: [ask("first"), ask("second")] } });
  await drain();
  assert.equal(h.store.getState().activeSessionId, "b", "arrival never navigates");
  const toast = h.store.getState().toasts.find(item => item.notificationTarget.requestId === "second");
  assert.ok(toast); assert.doesNotMatch(toast.message, /private question/);
  assert.equal(await h.activateNotificationTarget(toast.notificationTarget), true);
  h.frame();
  assert.equal(h.store.getState().activeSessionId, "a");
  assert.equal(h.store.getState().pendingAsks.a[0].requestId, "second");
  assert.match(h.focused[0], /second/);
  h.store.setState({ pendingAsks: {} }); await drain();
  assert.equal(h.store.getState().toasts.length, 0);
  const count = h.navigation.length;
  assert.equal(await h.activateNotificationTarget(toast.notificationTarget), false);
  assert.equal(h.navigation.length, count);
  stop();
  assert.ok(Object.values(h.events).every(listeners => listeners.size === 0));
});

test("navigation rechecks a request settled while session hydration was in flight", async () => {
  const h = harness(), stop = h.startCoreNotifications();
  h.store.setState({ pendingAsks: { a: [ask("race")] } });
  const detail = await h.api.getSession("a");
  let release;
  h.api.getSession = () => new Promise(resolve => { release = resolve; });
  const navigation = h.activateNotificationTarget({ kind: "ask", sessionId: "a", requestId: "race" });
  h.store.setState({ pendingAsks: {} }); release(detail);
  assert.equal(await navigation, false); h.frame();
  assert.equal(h.focused.length, 0); assert.equal(h.navigation.length, 0);
  stop();
});

test("shared approval events, snapshot overlap, deadline extension and remount create only one initial reminder", async () => {
  const h = harness(); h.background(); h.snapshot({ requests: [approval()] });
  let stop = h.startCoreNotifications();
  h.emit("approval", { request: approval() }); await drain();
  assert.equal(h.native.length, 1);
  h.emit("approval", { request: approval("pending", 2) });
  h.store.setState({ page: "chat", activeSessionId: "a" }); await drain();
  assert.equal(h.native.length, 1);
  stop(); stop = h.startCoreNotifications(); await drain();
  assert.equal(h.native.length, 1);
  h.emit("approval", { request: approval("approved", 3) }); await drain();
  assert.ok(h.dismissed.some(item => item.retire));
  assert.equal(await h.activateNotificationTarget(h.native[0].target), false);
  stop();
});

test("native failure falls back safely; disabling delivery preserves source requests and task history", async () => {
  const h = harness(); h.background();
  h.api.showNativeNotification = async () => { throw new Error("unsupported"); };
  const stop = h.startCoreNotifications();
  h.store.setState({ pendingAsks: { a: [ask("fallback")] } }); await drain();
  assert.equal(h.store.getState().toasts.length, 1);
  h.store.setState({ settings: { notifications: { version: 1, enabled: false } } });
  h.store.setState({ pendingAsks: { a: [ask("fallback"), ask("disabled")] } });
  h.emit("outcome", outcome()); await drain();
  assert.equal(h.store.getState().toasts.length, 0);
  assert.equal(h.store.getState().pendingAsks.a.length, 2);
  assert.equal(h.store.getState().notifications.length, 1);
  await h.store.getState().markAllNotificationsRead();
  await h.store.getState().clearNotifications();
  assert.equal(h.store.getState().pendingAsks.a.length, 2);
  stop();
});

test("structured admission failures are delivered once, cancellation is ignored, and task results deduplicate", async () => {
  const h = harness(), stop = h.startCoreNotifications();
  const event = { sessionId: "a", event: { type: "tool_end", toolName: "Task", toolCallId: "admission", result: { details: { code: "DELEGATION_NO_AUTHORIZED_MODEL" } } } };
  h.emit("agent", event); h.emit("agent", event);
  h.emit("agent", { ...event, event: { ...event.event, toolCallId: "cancel", result: { details: { cancelled: true } } } });
  h.emit("outcome", outcome()); h.emit("outcome", outcome()); await drain();
  assert.equal(h.store.getState().toasts.length, 2);
  assert.equal(h.store.getState().notifications.length, 1);
  stop();
});

test("an outcome already visible in the exact focused chat is retained without a new reminder", async () => {
  const h = harness();
  h.store.setState({ page: "chat", activeSessionId: "a", settings: { notifications: { version: 1, channel: "system" } } });
  const stop = h.startCoreNotifications();
  h.emit("outcome", outcome()); await drain();
  assert.equal(h.store.getState().notifications.length, 1);
  assert.equal(h.store.getState().toasts.length, 0);
  assert.equal(h.native.length, 0);
  stop();
});

test("an explicit late native failure falls back once and cannot revive a settled request", async () => {
  const h = harness(); h.background(); const stop = h.startCoreNotifications();
  h.store.setState({ pendingAsks: { a: [ask("native-failure")] } }); await drain();
  const request = h.native[0];
  h.emit("nativeFailed", request); h.emit("nativeFailed", request); await drain();
  assert.equal(h.store.getState().toasts.length, 1);
  assert.equal(h.store.getState().toasts[0].sound, false);
  h.store.setState({ pendingAsks: {} });
  h.emit("nativeFailed", request); await drain();
  assert.equal(h.store.getState().toasts.length, 0);
  stop();
});

test("navigation does not steal focus after the user changes page before the next frame", async () => {
  const h = harness(), stop = h.startCoreNotifications();
  h.store.setState({ pendingAsks: { a: [ask("focus-race")] } });
  assert.equal(await h.activateNotificationTarget({ kind: "ask", sessionId: "a", requestId: "focus-race" }), true);
  h.store.getState().setPage("settings"); h.frame();
  assert.equal(h.focused.length, 0);
  assert.equal(h.store.getState().pendingAsks.a.length, 1);
  stop();
});

test("an unrelated settings save keeps active reminders; actual preference changes recompute them", async () => {
  const h = harness(); h.background();
  h.store.setState({ settings: { notifications: { version: 1, channel: "system", sound: false } } });
  const stop = h.startCoreNotifications();
  h.store.setState({ pendingAsks: { a: [ask("unchanged-policy")] } }); await drain();
  const current = h.store.getState().settings;
  h.store.setState({ settings: { ...current, theme: "light", notifications: { ...current.notifications } } });
  assert.equal(h.dismissed.length, 0);
  h.store.setState({ settings: { ...current, notifications: { ...current.notifications, volume: 40 } } });
  assert.equal(h.dismissed.length, 1);
  assert.equal(h.store.getState().pendingAsks.a.length, 1);
  stop();
});
