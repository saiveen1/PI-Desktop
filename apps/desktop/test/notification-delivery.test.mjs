import assert from "node:assert/strict";
import test from "node:test";
import { createNotificationDelivery } from "../src/lib/notification-delivery.ts";

function fixture() {
  let now = 1000, settings = { version: 1 }, foreground = true;
  const timers = new Map(); let next = 0;
  const native = [], banners = [], sounds = [], dismissed = [];
  let respond = async () => ({ shown: true, reason: "requested" });
  const driver = createNotificationDelivery({
    settings: () => settings, foreground: () => foreground, now: () => now,
    native: async entry => { native.push(entry); return respond(); },
    dismiss: async (id, retire) => { dismissed.push([id, retire]); },
    inApp: entry => { banners.push(entry); }, sound: volume => sounds.push(volume),
    setTimer: (fn, delay) => { const id = ++next; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimer: id => timers.delete(id),
  });
  const tick = async elapsed => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    now += elapsed;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  return { driver, native, banners, sounds, dismissed, timers, tick,
    settings: value => { settings = value; driver.refresh(); },
    background: () => { foreground = false; },
    respond: value => { respond = value; } };
}
const entry = (kind = "delegation-approval", requestId = "request") => ({
  id: JSON.stringify([kind, "session-a", requestId]),
  target: { kind, sessionId: "session-a", requestId }, title: "Needs attention", body: "Session A", expiresAt: 61_000,
});

test("automatic delivery is app-wide in foreground and native in background", async () => {
  const f = fixture();
  await f.driver.once(entry("ask"));
  assert.equal(f.banners.length, 1); assert.equal(f.native.length, 0);
  f.background(); await f.driver.once(entry("ask", "another"));
  assert.equal(f.native.length, 1); assert.equal(f.sounds.length, 2);
  f.driver.dispose();
});
test("in-app never invokes native and system may request native in foreground", async () => {
  const f = fixture(); f.background(); f.settings({ version: 1, channel: "in-app" });
  await f.driver.once(entry()); assert.equal(f.native.length, 0);
  f.settings({ version: 1, channel: "system" });
  await f.driver.once(entry("plan")); assert.equal(f.native.length, 1);
  f.driver.dispose();
});
test("deduplicates snapshots, request revisions and resumed views", async () => {
  const f = fixture(); const item = entry();
  f.driver.sync([item]); f.driver.sync([{ ...item, target: { ...item.target, revision: 2 } }]);
  await f.tick(0);
  assert.equal(f.banners.length, 1); assert.equal(f.sounds.length, 1);
  assert.equal((await f.driver.once(item)).reason, "duplicate");
  f.driver.dispose();
});
test("master/category/sound preferences do not remove pending actions", async () => {
  const f = fixture(); f.settings({ version: 1, enabled: false });
  f.driver.sync([entry()]); await f.tick(0);
  assert.equal(f.banners.length, 0); assert.equal(f.sounds.length, 0);
  assert.equal(f.driver.pending().length, 1);
  f.settings({ version: 1, sound: false, categories: { failures: false } });
  await f.driver.once(entry("task.failed")); assert.equal(f.banners.length, 0);
  await f.driver.once(entry("ask")); assert.equal(f.banners.length, 1); assert.equal(f.sounds.length, 0);
  f.driver.dispose();
});
test("repeat is opt-in and stops on expiry or settlement without resetting deadline", async () => {
  const f = fixture(); f.settings({ version: 1, delegation: { repeatIntervalSeconds: 10 } });
  const item = { ...entry(), expiresAt: 22_000 };
  f.driver.sync([item]); await f.tick(10_000); assert.equal(f.banners.length, 2);
  f.driver.sync([{ ...item, target: { ...item.target, revision: 3 } }]);
  await f.tick(10_000); assert.equal(f.banners.length, 3);
  await f.tick(1_000); assert.equal(f.driver.pending().length, 0);
  assert.equal(f.timers.size, 0);
  assert.ok(f.dismissed.some(([id, retire]) => id === item.id && retire));
  f.driver.dispose();
});
test("late native response after settlement produces no sound or in-app resurrection", async () => {
  const f = fixture(); f.background();
  let resolve; f.respond(() => new Promise(done => { resolve = done; }));
  f.driver.sync([entry()]); f.driver.sync([]);
  resolve({ shown: false, reason: "failed" }); await f.tick(0);
  assert.equal(f.sounds.length, 0); assert.equal(f.banners.length, 0);
  assert.equal(f.driver.pending().length, 0);
  f.driver.dispose();
});
test("explicit unavailable/failed native delivery falls back; suppressed requests do not", async () => {
  const f = fixture(); f.background(); f.respond(async () => ({ shown: false, reason: "unavailable" }));
  await f.driver.once(entry()); assert.equal(f.banners.length, 1);
  f.respond(async () => ({ shown: false, reason: "disabled" }));
  await f.driver.once(entry("ask")); assert.equal(f.banners.length, 1); assert.equal(f.sounds.length, 1);
  f.driver.dispose();
});
test("policy changes retire an outstanding native reminder and disposed drivers release timers", async () => {
  const f = fixture(); f.background(); f.settings({ version: 1, delegation: { repeatIntervalSeconds: 10 } });
  f.driver.sync([entry()]); await f.tick(0);
  f.settings({ version: 1, enabled: false });
  assert.ok(f.dismissed.length > 0);
  f.driver.dispose(); assert.equal(f.timers.size, 0);
});

test("slow native requests never overlap repeats and settings withdraw only the older attempt", async () => {
  const f = fixture(); f.background();
  f.settings({ version: 1, delegation: { repeatIntervalSeconds: 10 } });
  let resolve;
  f.respond(() => new Promise(done => { resolve = done; }));
  f.driver.sync([entry()]);
  await f.tick(10_000);
  assert.equal(f.native.length, 1, "a pending native request must not be duplicated by a timer");
  f.settings({ version: 1, channel: "in-app", delegation: { repeatIntervalSeconds: 10 } });
  resolve({ shown: true, reason: "requested" }); await f.tick(0);
  assert.equal(f.sounds.length, 0);
  await f.tick(10_000);
  assert.equal(f.banners.length, 1);
  f.driver.dispose();
});

test("audio failure is best effort and leaves the live request and in-app surface usable", async () => {
  const banners = [], errors = [];
  const driver = createNotificationDelivery({ settings: () => undefined, foreground: () => true, now: () => 1000,
    native: async () => { throw new Error("unexpected native delivery"); }, dismiss: async () => undefined,
    inApp: item => banners.push(item), sound: () => { throw new Error("audio unavailable"); }, onError: error => errors.push(error),
  });
  driver.sync([entry()]); await Promise.resolve(); await Promise.resolve();
  assert.equal(driver.pending().length, 1); assert.equal(banners.length, 1); assert.equal(errors.length, 1);
  driver.dispose();
});

test("approval audio plays once by default and stops repeating immediately on settlement", async () => {
  const f = fixture();
  f.settings({ version: 1, delegation: { sound: true, volume: 35, repeatIntervalSeconds: 0 } });
  const item = entry();
  f.driver.sync([item]); await f.tick(0);
  f.driver.sync([item]); await f.tick(20_000);
  assert.deepEqual(f.sounds, [35]);
  f.settings({ version: 1, delegation: { sound: true, volume: 35, repeatIntervalSeconds: 10 } });
  await f.tick(10_000); assert.deepEqual(f.sounds, [35, 35]);
  f.driver.sync([]); await f.tick(20_000);
  assert.deepEqual(f.sounds, [35, 35]); assert.equal(f.timers.size, 0);
  f.driver.dispose();
});

test("hydrated approvals are silent initially, repeat on schedule, and stop on fallback", async () => {
  const f = fixture(); f.settings({ version: 1, delegation: { volume: 40, repeatIntervalSeconds: 10 } });
  const item = { ...entry(), hydrated: true };
  f.driver.sync([item]); await f.tick(0);
  assert.equal(f.banners.length, 1); assert.deepEqual(f.sounds, []);
  f.driver.sync([{ ...item, target: { ...item.target, revision: 2 } }]);
  await f.tick(9_999); assert.deepEqual(f.sounds, []);
  await f.tick(1); assert.deepEqual(f.sounds, [40]);
  f.driver.sync([]); await f.tick(20_000);
  assert.deepEqual(f.sounds, [40]); assert.equal(f.timers.size, 0);
  f.driver.dispose();
});
