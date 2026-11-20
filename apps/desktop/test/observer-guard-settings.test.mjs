import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import * as shared from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { normalizeSettings, validateSettingsWrite } = await import("../src/lib/api.ts");
const { createSettingsWriter } = await import("../src/lib/settings-save.ts");
const base = { defaultMode: "agent", theme: "light", enterToSend: true };

test("observer settings normalize malformed persisted values and reject invalid writes", () => {
  globalThis.window = { piDesktop: { platform: "win32" } };
  try {
    assert.deepEqual(normalizeSettings(base).observerGuard, shared.DEFAULT_OBSERVER_GUARD_SETTINGS);
    const value = normalizeSettings({ ...base, observerGuard: { timeoutSeconds: 91, maxInputChars: 3500, includeToolOutput: "yes", maxContinuations: 101, prompt: " \t", continueOnTransientError: "true" } }).observerGuard;
    assert.equal(value.timeoutSeconds, 30);
    assert.equal(value.maxInputChars, 3500);
    assert.equal(value.includeToolOutput, false);
    assert.equal(value.maxContinuations, 3);
    assert.equal(value.prompt, shared.DEFAULT_OBSERVER_GUARD_PROMPT);
    assert.equal(value.continueOnTransientError, false);
    for (const bad of [null, [], { timeoutSeconds: 4 }, { recentToolCount: 2.5 }, { includeToolOutput: 1 }, { unknown: true }, { maxContinuations: 0 }, { maxContinuations: 1.5 }, { prompt: "x".repeat(8001) }, { continueOnTransientError: "true" }, { continueOnTransientError: 1 }, { continueOnTransientError: null }]) {
      assert.throws(() => validateSettingsWrite({ ...base, observerGuard: bad }), /observerGuard is invalid/);
    }
    assert.equal(validateSettingsWrite({ ...base, observerGuard: { recentToolCount: 0 } }).observerGuard.recentToolCount, 0);
    assert.equal(validateSettingsWrite({ ...base, observerGuard: { prompt: "" } }).observerGuard.prompt, "");
  } finally { delete globalThis.window; }
});

test("serialized observer partial saves preserve other observer and output-guard fields", async () => {
  let stored = { ...base, observerGuard: { providerId: "provider", modelId: "model", timeoutSeconds: 20 }, agentOutputGuard: { earlyEndMode: "warn" } };
  const writer = createSettingsWriter({ read: async () => structuredClone(stored), write: async value => { stored = structuredClone(value); }, publish() {} });
  await Promise.all([writer.save({ observerGuard: { maxInputChars: 5000 } }), writer.save({ observerGuard: { recentToolCount: 0, maxContinuations: 7 } }), writer.save({ observerGuard: { prompt: "Custom reviewer instructions" } }), writer.save({ observerGuard: { continueOnTransientError: true } }), writer.save({ agentOutputGuard: { recoveryLimit: 2 } })]);
  assert.equal(stored.observerGuard.providerId, "provider");
  assert.equal(stored.observerGuard.modelId, "model");
  assert.equal(stored.observerGuard.timeoutSeconds, 20);
  assert.equal(stored.observerGuard.maxInputChars, 5000);
  assert.equal(stored.observerGuard.recentToolCount, 0);
  assert.equal(stored.observerGuard.maxContinuations, 7);
  assert.equal(stored.observerGuard.prompt, "Custom reviewer instructions");
  assert.equal(stored.observerGuard.continueOnTransientError, true);
  await writer.save({ observerGuard: { prompt: "" } });
  assert.equal(stored.observerGuard.prompt, "");
  assert.equal(stored.observerGuard.maxContinuations, 7);
  assert.equal(stored.agentOutputGuard.earlyEndMode, "warn");
  assert.equal(stored.agentOutputGuard.recoveryLimit, 2);
  await assert.rejects(writer.save({ observerGuard: { timeoutSeconds: 0 } }), /observerGuard is invalid/);
  assert.equal(stored.observerGuard.timeoutSeconds, 20);
});
