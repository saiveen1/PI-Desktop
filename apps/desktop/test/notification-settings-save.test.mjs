import assert from "node:assert/strict";
import test from "node:test";
import { createSettingsWriter } from "../src/lib/settings-save.ts";
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("global, delegation override and model saves serialize against the latest host values", async () => {
  let saved = { theme: "dark", delegation: { models: [{ enabled: false, approval: "ask" }] }, notifications: { version: 1 } };
  const gate = deferred(); let writes = 0;
  const writer = createSettingsWriter({
    read: async () => structuredClone(saved),
    write: async value => { if (++writes === 1) await gate.promise; saved = structuredClone(value); },
    publish() {},
  });
  const first = writer.notifications({ version: 1, channel: "system" }, "global");
  const override = writer.notifications({ version: 1, delegation: { sound: false, repeatIntervalSeconds: 10 } }, "delegation");
  const other = writer.save({ theme: "light" });
  gate.resolve(); await Promise.all([first, override, other]);
  assert.equal(saved.theme, "light"); assert.equal(saved.notifications.channel, "system");
  assert.equal(saved.notifications.delegation.sound, false);
  assert.equal(saved.delegation.models[0].enabled, false);
  await writer.notifications({ version: 1, channel: "in-app" }, "global");
  assert.equal(saved.notifications.delegation.repeatIntervalSeconds, 10);
  await writer.notifications({ version: 1 }, "delegation");
  assert.equal(saved.notifications.channel, "in-app");
  assert.equal(Object.hasOwn(saved.notifications, "delegation"), false);
});
test("a failed write publishes nothing, does not poison the queue, and invalid input never writes", async () => {
  let saved = { notifications: { version: 1, sound: true }, language: "en" }, fail = true, published = 0;
  const writer = createSettingsWriter({ read: async () => saved, write: async value => {
    if (fail) throw new Error("disk unavailable"); saved = value;
  }, publish: () => published++ });
  const draft = { version: 1, sound: false };
  await assert.rejects(writer.notifications(draft, "global"), /disk unavailable/);
  assert.equal(saved.notifications.sound, true); assert.equal(published, 0); assert.equal(draft.sound, false);
  fail = false; await writer.notifications(draft, "global");
  assert.equal(saved.notifications.sound, false); assert.equal(published, 1);
  await assert.rejects(writer.notifications({ version: 1, volume: 101 }, "global"), /Invalid notification/);
  assert.equal(published, 1);
});
