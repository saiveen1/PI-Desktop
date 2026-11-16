import { describe, expect, it } from "vitest";
import { AGENT_OUTPUT_GUARD_LIMITS, DEFAULT_AGENT_OUTPUT_GUARD_SETTINGS, isAgentOutputGuardSettings, resolveAgentOutputGuardSettings } from "./agent-output-guard.js";

describe("agent output guard settings", () => {
  it("normalizes absent and legacy settings without mutating shared defaults", () => {
    for (const input of [undefined, null, false, [], "invalid", {}]) {
      expect(resolveAgentOutputGuardSettings(input)).toEqual(DEFAULT_AGENT_OUTPUT_GUARD_SETTINGS);
    }
    const result = resolveAgentOutputGuardSettings({ earlyEndMode: "continue", recoveryLimit: 0, repetitiveOutputEnabled: false });
    expect(result).toMatchObject({ earlyEndMode: "continue", recoveryLimit: 0, repetitiveOutputEnabled: false });
    expect(DEFAULT_AGENT_OUTPUT_GUARD_SETTINGS.earlyEndMode).toBe("warn");
    expect(DEFAULT_AGENT_OUTPUT_GUARD_SETTINGS.repetitiveOutputEnabled).toBe(true);
  });

  it("accepts partial objects and rejects invalid writes and unknown properties", () => {
    for (const mode of ["off", "warn", "continue"]) expect(isAgentOutputGuardSettings({ earlyEndMode: mode })).toBe(true);
    expect(isAgentOutputGuardSettings({})).toBe(true);
    expect(isAgentOutputGuardSettings({ repeatedParagraphsEnabled: false })).toBe(true);
    for (const value of [null, [], false, "continue", { earlyEndMode: "auto" }, { recoveryLimit: "1" },
      { repetitiveOutputEnabled: 0 }, { unknown: true }, { recoveryLimit: undefined }]) {
      expect(isAgentOutputGuardSettings(value)).toBe(false);
    }
  });

  it.each(Object.entries(AGENT_OUTPUT_GUARD_LIMITS))("enforces finite integer bounds for %s", (key, range) => {
    for (const value of [range.min, range.max]) expect(isAgentOutputGuardSettings({ [key]: value })).toBe(true);
    for (const value of [range.min - 1, range.max + 1, NaN, Infinity, 1.5, "2"]) {
      expect(isAgentOutputGuardSettings({ [key]: value })).toBe(false);
    }
  });

  it("ignores malformed persisted fields independently and never copies foreign keys", () => {
    expect(resolveAgentOutputGuardSettings({ earlyEndMode: "off", recoveryLimit: -1, symbolMinChars: Infinity,
      repeatedParagraphsEnabled: false, arbitrary: "ignored" })).toEqual({
      ...DEFAULT_AGENT_OUTPUT_GUARD_SETTINGS, earlyEndMode: "off", repeatedParagraphsEnabled: false,
    });
    expect(resolveAgentOutputGuardSettings(Object.create({ earlyEndMode: "continue" })).earlyEndMode).toBe("warn");
  });
});
