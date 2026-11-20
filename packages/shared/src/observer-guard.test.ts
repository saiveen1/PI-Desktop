import { describe, expect, it } from "vitest";
import { DEFAULT_OBSERVER_GUARD_PROMPT, DEFAULT_OBSERVER_GUARD_SETTINGS, OBSERVER_GUARD_LIMITS, OBSERVER_GUARD_PROMPT_MAX_CHARS, isObserverGuardMode, isObserverGuardSettings, resolveObserverGuardMode, resolveObserverGuardSettings } from "./observer-guard.js";

describe("Observer Guard opt-in contract", () => {
  it("keeps absent and malformed modes off and only accepts explicit modes", () => {
    for (const value of [undefined, null, true, 1, "enabled", "observe", {}, []]) {
      expect(isObserverGuardMode(value)).toBe(false);
      expect(resolveObserverGuardMode(value)).toBe("off");
    }
    for (const mode of ["off", "endless", "guard"] as const) expect(resolveObserverGuardMode(mode)).toBe(mode);
  });
  it("does not select a default model or mutate defaults", () => {
    expect(resolveObserverGuardSettings(undefined)).toEqual(DEFAULT_OBSERVER_GUARD_SETTINGS);
    expect(resolveObserverGuardSettings({ modelId: "chosen", thinkingLevel: "high" })).toMatchObject({ providerId: "", modelId: "chosen", thinkingLevel: "high" });
    expect(DEFAULT_OBSERVER_GUARD_SETTINGS.modelId).toBe("");
    expect(DEFAULT_OBSERVER_GUARD_SETTINGS.includeToolOutput).toBe(false);
  });
  it("accepts valid partial settings and rejects malformed writes", () => {
    expect(isObserverGuardSettings({})).toBe(true);
    expect(isObserverGuardSettings({ providerId: "provider", modelId: "model/variant", thinkingLevel: "low", includeToolOutput: true })).toBe(true);
    for (const value of [null, [], true, { providerId: " leading" }, { modelId: "x\n" }, { thinkingLevel: "invented" }, { includeToolOutput: 1 }, { other: true }]) expect(isObserverGuardSettings(value)).toBe(false);
  });
  it.each(Object.entries(OBSERVER_GUARD_LIMITS))("bounds %s", (key, limits) => {
    for (const value of [limits.min, limits.max]) expect(isObserverGuardSettings({ [key]: value })).toBe(true);
    for (const value of [limits.min - 1, limits.max + 1, 1.5, NaN, Infinity, "20"]) expect(isObserverGuardSettings({ [key]: value })).toBe(false);
  });
  it("normalizes persisted fields individually without copying unknown or inherited keys", () => {
    expect(resolveObserverGuardSettings({ providerId: "p", timeoutSeconds: -1, unknown: true })).toEqual({ ...DEFAULT_OBSERVER_GUARD_SETTINGS, providerId: "p" });
    expect(resolveObserverGuardSettings(Object.create({ modelId: "hidden" }))).toEqual(DEFAULT_OBSERVER_GUARD_SETTINGS);
  });
  it("bounds editable prompts and restores the default for blank or invalid saved values", () => {
    expect(isObserverGuardSettings({ prompt: "Only continue unfinished work.\nReturn continue or stop.", maxContinuations: 5 })).toBe(true);
    for (const prompt of [null, 7, "x".repeat(OBSERVER_GUARD_PROMPT_MAX_CHARS + 1), "bad\u0000text"]) expect(isObserverGuardSettings({ prompt })).toBe(false);
    for (const prompt of [undefined, "", " \n ", 7]) expect(resolveObserverGuardSettings({ prompt }).prompt).toBe(DEFAULT_OBSERVER_GUARD_PROMPT);
    expect(resolveObserverGuardSettings({ prompt: "Custom instructions" }).prompt).toBe("Custom instructions");
    expect(resolveObserverGuardSettings({}).maxContinuations).toBe(3);
  });
});

it("makes recovery after transient errors explicit and strictly boolean", () => {
  expect(resolveObserverGuardSettings({}).continueOnTransientError).toBe(false);
  for (const value of [true, false]) {
    expect(isObserverGuardSettings({ continueOnTransientError: value })).toBe(true);
    expect(resolveObserverGuardSettings({ continueOnTransientError: value }).continueOnTransientError).toBe(value);
  }
  for (const value of [null, 1, "true", []]) {
    expect(isObserverGuardSettings({ continueOnTransientError: value })).toBe(false);
    expect(resolveObserverGuardSettings({ continueOnTransientError: value }).continueOnTransientError).toBe(false);
  }
});
