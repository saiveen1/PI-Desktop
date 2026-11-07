import assert from "node:assert/strict";
import test from "node:test";
import { sidebarSessionClock } from "../src/lib/sidebar-session-clock.ts";

function clockEnvironment(t, initiallyHidden = false) {
  let now = Date.parse("2026-11-02T05:30:00.000Z");
  t.mock.method(Date, "now", () => now);
  const intervals = new Map();
  const delays = [];
  let nextId = 0;
  class TrackedTarget extends EventTarget {
    registrations = new Set();
    addEventListener(type, listener) {
      this.registrations.add(listener);
      super.addEventListener(type, listener);
    }
    removeEventListener(type, listener) {
      this.registrations.delete(listener);
      super.removeEventListener(type, listener);
    }
  }
  const document = new TrackedTarget();
  document.hidden = initiallyHidden;
  const window = new TrackedTarget();
  window.setInterval = (callback, delay) => {
    delays.push(delay);
    intervals.set(++nextId, callback);
    return nextId;
  };
  window.clearInterval = (id) => intervals.delete(id);
  const restores = [];
  for (const [key, value] of Object.entries({ window, document })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    restores.push(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    });
  }
  const cleanups = [];
  t.after(() => {
    try {
      cleanups.forEach((cleanup) => cleanup());
    } finally {
      restores.forEach((restore) => restore());
    }
  });
  return {
    window, document, intervals, delays,
    now: () => now,
    advance: (milliseconds) => { now += milliseconds; },
    subscribe: (listener) => {
      const cleanup = sidebarSessionClock.subscribe(listener);
      cleanups.push(cleanup);
      return cleanup;
    },
    tick: () => { for (const callback of intervals.values()) callback(); },
    visibility: (hidden) => {
      document.hidden = hidden;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    focus: () => window.dispatchEvent(new Event("focus")),
  };
}

test("hundreds of time subscribers share one minute interval and a stable snapshot", (t) => {
  const env = clockEnvironment(t);
  assert.equal(env.intervals.size, 0);
  const notifications = Array.from({ length: 200 }, () => []);
  for (const entries of notifications) {
    env.subscribe(() => entries.push(sidebarSessionClock.getSnapshot()));
  }
  assert.deepEqual(env.delays, [60_000]);
  assert.equal(env.window.registrations.size, 1);
  assert.equal(env.document.registrations.size, 1);
  const before = sidebarSessionClock.getSnapshot();
  env.advance(59_000);
  assert.equal(sidebarSessionClock.getSnapshot(), before);
  env.advance(1_000);
  env.tick();
  assert.equal(sidebarSessionClock.getSnapshot(), env.now());
  for (const entries of notifications) assert.equal(entries.at(-1), env.now());
});

test("hiding stops the interval; visibility and focus refresh immediately without duplicate timers", (t) => {
  const env = clockEnvironment(t);
  const notifications = [];
  env.subscribe(() => notifications.push(sidebarSessionClock.getSnapshot()));
  const before = sidebarSessionClock.getSnapshot();
  env.visibility(true);
  assert.equal(env.intervals.size, 0);
  env.advance(10 * 60_000);
  env.focus();
  assert.equal(env.intervals.size, 0);
  assert.equal(sidebarSessionClock.getSnapshot(), before);
  env.visibility(false);
  assert.equal(env.intervals.size, 1);
  assert.equal(notifications.at(-1), env.now());
  env.advance(17_000);
  env.focus();
  assert.equal(notifications.at(-1), env.now());
  assert.equal(env.intervals.size, 1);
  assert.deepEqual(env.delays, [60_000, 60_000]);
});

test("an initially hidden window stays unscheduled until it becomes visible", (t) => {
  const env = clockEnvironment(t, true);
  const notifications = [];
  env.subscribe(() => notifications.push(sidebarSessionClock.getSnapshot()));
  assert.equal(env.intervals.size, 0);
  assert.equal(notifications.length, 0);
  env.advance(5 * 60_000);
  env.visibility(false);
  assert.equal(env.intervals.size, 1);
  assert.deepEqual(notifications, [env.now()]);
});

test("only the last unsubscribe disposes interval and events, and remount refreshes immediately", (t) => {
  const env = clockEnvironment(t);
  const first = env.subscribe(() => {});
  const second = env.subscribe(() => {});
  first();
  assert.equal(env.intervals.size, 1);
  assert.equal(env.window.registrations.size, 1);
  second();
  assert.equal(env.intervals.size, 0);
  assert.equal(env.window.registrations.size, 0);
  assert.equal(env.document.registrations.size, 0);
  const before = sidebarSessionClock.getSnapshot();
  env.advance(120_000);
  env.visibility(false);
  env.focus();
  assert.equal(env.intervals.size, 0);
  assert.equal(sidebarSessionClock.getSnapshot(), before);
  const remount = env.subscribe(() => {});
  assert.equal(env.intervals.size, 1);
  assert.equal(sidebarSessionClock.getSnapshot(), env.now());
  env.visibility(true);
  remount();
  assert.equal(env.window.registrations.size, 0);
  assert.equal(env.document.registrations.size, 0);
  env.visibility(false);
  assert.equal(env.intervals.size, 0);
});
