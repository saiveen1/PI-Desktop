import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createCoreNativeNotifications } from "../electron/main/core-native-notifications.ts";

const IPC = {
  invoke: {
    notificationList: "notification.list",
    notificationMarkRead: "notification.markRead",
    notificationMarkAllRead: "notification.markAllRead",
    notificationClear: "notification.clear",
    notificationSetViewingSession: "notification.setViewingSession",
    notificationShowNative: "notification.showNative",
    notificationDismissNative: "notification.dismissNative",
  },
  event: { notificationActivated: "notification.activated", notificationDeliveryFailed: "notification.deliveryFailed" },
};

class FakeNotification extends EventEmitter {
  static instances = [];
  static isSupported() {
    return true;
  }

  constructor(options) {
    super();
    this.options = options;
    this.closed = false;
    FakeNotification.instances.push(this);
  }

  show() {
    this.shown = true;
  }

  close() {
    this.closed = true;
    this.emit("close");
  }
}

function loadNotificationIpc() {
  const file = new URL("../electron/main/ipc/notification-ipc.ts", import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      if (id === "electron") return { Notification: FakeNotification };
      if (id === "@pi-desktop/shared") return { IPC };
      if (id === "../core-native-notifications") return { createCoreNativeNotifications };
      if (id === "../notification-policy") {
        return { shouldShowNativeNotification: () => true };
      }
      throw new Error(`unexpected dependency: ${id}`);
    },
    module.exports,
    module,
  );
  return module.exports;
}

function harness({ hostCall } = {}) {
  FakeNotification.instances = [];
  const handlers = new Map();
  const calls = [];
  const events = [];
  const windowEvents = new Map();
  const host = {
    call: async (method, input) => {
      calls.push({ method, input });
      return hostCall ? hostCall(method, input) : { ok: true };
    },
  };
  const mainWindow = {
    once: (event, listener) => { windowEvents.set(event, listener); },
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => false,
    isMinimized: () => false,
    show: () => {},
    focus: () => {},
    restore: () => {},
  };
  const { registerNotificationIpc } = loadNotificationIpc();
  registerNotificationIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getMainWindow: () => mainWindow,
    getViewingSessionId: () => "session-current",
    setViewingSessionId: () => {},
    sendToRenderer: (channel, payload) => events.push({ channel, payload }),
  });
  return {
    handlers,
    mainWindow,
    closeWindow: () => windowEvents.get("closed")?.(),
    dismiss: (id, retire = true) => handlers.get(IPC.invoke.notificationDismissNative)({ id, retire }),
    calls,
    events,
    show: (input) => handlers.get(IPC.invoke.notificationShowNative)(input),
    markRead: (id) => handlers.get(IPC.invoke.notificationMarkRead)({ id }),
    markAllRead: () => handlers.get(IPC.invoke.notificationMarkAllRead)(),
    clear: () => handlers.get(IPC.invoke.notificationClear)(),
  };
}

test("duplicate task delivery is idempotent and read dismissal leaves a tombstone", async () => {
  const h = harness();
  const input = {
    id: "durable-1",
    sessionId: "session-1",
    kind: "task",
    title: "Task finished",
    body: "Done",
  };

  assert.deepEqual(await h.show(input), { shown: true });
  assert.deepEqual(await h.show(input), { shown: false });
  assert.equal(FakeNotification.instances.length, 1);
  assert.equal(FakeNotification.instances[0].closed, false);

  await h.markRead(input.id);
  assert.equal(FakeNotification.instances[0].closed, true);
  assert.deepEqual(await h.show(input), { shown: false });
  assert.deepEqual(h.calls.map(({ method }) => method), [
    "notification.markRead",
  ]);
});

test("clear and mark-all-read close every task object, while interactive prompts stay independent", async () => {
  const h = harness();
  const task = (id) => ({
    id,
    sessionId: "session-1",
    kind: "task",
    title: "Task finished",
    body: "Done",
  });
  const interactive = {
    id: "same-id",
    sessionId: "session-1",
    kind: "interactive",
    title: "Approval",
    body: "Please choose",
  };

  await h.show(task("task-1"));
  await h.show(task("task-2"));
  await h.markAllRead();
  assert.deepEqual(FakeNotification.instances.map((item) => item.closed), [true, true]);

  // An interactive prompt may reuse an id without colliding with task rows.
  await h.show(interactive);
  await h.show(interactive);
  assert.equal(FakeNotification.instances.length, 4);
  assert.equal(FakeNotification.instances[2].closed, false);
  assert.equal(FakeNotification.instances[3].closed, false);

  await h.clear();
  assert.equal(FakeNotification.instances[2].closed, false);
  assert.equal(FakeNotification.instances[3].closed, false);
  assert.deepEqual(h.calls.map(({ method }) => method), [
    "notification.markAllRead",
    "notification.clear",
  ]);
});

test("acknowledgement watermarks reject old task events but allow a later turn", async () => {
  const h = harness();
  const now = Date.now();
  const task = (id, createdAt) => ({
    id,
    sessionId: "session-1",
    kind: "task",
    title: "Task finished",
    body: "Done",
    createdAt,
  });

  await h.markAllRead();
  assert.deepEqual(
    await h.show(task("before-mark-all", new Date(now - 60_000).toISOString())),
    { shown: false },
  );
  assert.deepEqual(
    await h.show(task("after-mark-all", new Date(now + 60_000).toISOString())),
    { shown: true },
  );

  await h.clear();
  assert.deepEqual(
    await h.show(task("before-clear", new Date(now - 30_000).toISOString())),
    { shown: false },
  );
  assert.deepEqual(
    await h.show(task("after-clear", new Date(now + 120_000).toISOString())),
    { shown: true },
  );
});

test("a failed host acknowledgement does not dismiss a task banner prematurely", async () => {
  const h = harness({
    hostCall: async (method) => {
      if (method === "notification.markRead") throw new Error("host unavailable");
      return { ok: true };
    },
  });
  const input = {
    id: "durable-failure",
    sessionId: "session-1",
    kind: "task",
    title: "Task failed",
    body: "Retry",
  };
  await h.show(input);
  await assert.rejects(h.markRead(input.id), /host unavailable/);
  assert.equal(FakeNotification.instances[0].closed, false);
});

const coreRequest = (id = "core", source = "delegation-approval") => ({
  id, sessionId: "session-1", title: "Needs attention", body: "Source session",
  target: { kind: source, sessionId: "session-1", requestId: "request" },
});
test("typed core delivery validates targets and enforces current device preferences", async () => {
  let notifications = { version: 1, enabled: false };
  const h = harness({ hostCall: async () => ({ notifications }) });
  assert.equal((await h.show(coreRequest())).reason, "disabled");
  notifications = { version: 1, channel: "in-app" };
  assert.equal((await h.show(coreRequest())).reason, "in-app");
  notifications = { version: 1, channel: "system" };
  const malformed = coreRequest(); malformed.target.sessionId = "different";
  assert.equal((await h.show(malformed)).reason, "failed");
  assert.equal(FakeNotification.instances.length, 0);
  h.mainWindow.isFocused = () => true;
  assert.equal((await h.show(coreRequest())).reason, "requested");
  assert.equal(FakeNotification.instances[0].options.silent, true);
  assert.equal((await h.show(coreRequest())).reason, "duplicate");
});
test("typed reminders retire on settlement, allow opt-in repeats, and ignore late native clicks", async () => {
  const h = harness();
  await h.show(coreRequest());
  const first = FakeNotification.instances[0];
  await h.dismiss("core", false); assert.equal(first.closed, true);
  assert.equal((await h.show(coreRequest())).reason, "requested");
  const second = FakeNotification.instances[1];
  await h.dismiss("core"); second.emit("click");
  assert.equal(h.events.length, 0);
  assert.equal((await h.show(coreRequest())).reason, "stale");
});
test("dismissal while settings are loading blocks late native construction", async () => {
  let release;
  const h = harness({ hostCall: () => new Promise(resolve => { release = resolve; }) });
  const pending = h.show(coreRequest());
  await h.dismiss("core"); release({});
  assert.equal((await pending).reason, "stale");
  assert.equal(FakeNotification.instances.length, 0);
});
test("native failure is explicit and async failures report a typed fallback without activation", async () => {
  const h = harness(); await h.show(coreRequest());
  FakeNotification.instances[0].emit("failed");
  assert.equal(h.events[0].channel, IPC.event.notificationDeliveryFailed);
  assert.deepEqual(h.events[0].payload.target, coreRequest().target);
  const show = FakeNotification.prototype.show;
  FakeNotification.prototype.show = () => { throw new Error("native failure"); };
  try { assert.equal((await h.show(coreRequest("sync-failure"))).reason, "failed"); }
  finally { FakeNotification.prototype.show = show; }
});

test("closing the Main owner releases core objects and blocks late construction", async () => {
  const h = harness();
  await h.show(coreRequest()); h.closeWindow();
  assert.equal(FakeNotification.instances.at(-1).closed, true);
  assert.equal((await h.show(coreRequest("after-close"))).reason, "stale");
});
