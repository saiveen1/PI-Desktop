import { describe, expect, it } from "vitest";
import { DEFAULT_DELEGATION_LIMITS, DELEGATION_LIMIT_RANGES, isDelegationLimits, resolveDelegationLimits } from "./delegation-limits.js";
import { isDelegationSettings, legacyDelegationSettings } from "./delegation-policy.js";
import { mergeSubagentDefinitions, type SubagentDefinition } from "./subagent-definition.js";

describe("delegation capacity limits", () => {
  it("preserves legacy defaults without rewriting saved settings", () => {
    const settings = legacyDelegationSettings([]);
    expect(isDelegationSettings(settings)).toBe(true);
    expect(settings).not.toHaveProperty("limits");
    expect(resolveDelegationLimits(settings.limits)).toEqual({ maxDefinitions: 16, maxConcurrent: 10 });
    expect(resolveDelegationLimits({ maxConcurrent: 12 })).toEqual({ maxDefinitions: 16, maxConcurrent: 12 });
    expect(resolveDelegationLimits({ maxDefinitions: 24 })).toEqual({ maxDefinitions: 24, maxConcurrent: 10 });
  });

  it("resolves a detached immutable value", () => {
    const input = { maxDefinitions: 32, maxConcurrent: 12 };
    const resolved = resolveDelegationLimits(input);
    input.maxConcurrent = 1;
    expect(resolved).toEqual({ maxDefinitions: 32, maxConcurrent: 12 });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(DEFAULT_DELEGATION_LIMITS)).toBe(true);
  });

  it("validates both settings and resolver boundaries without clamping", () => {
    const invalid: unknown[] = [null, [], true, 1, "10", { typo: 1 }];
    for (const [key, { min, max }] of Object.entries(DELEGATION_LIMIT_RANGES)) {
      for (const number of [min, max]) {
        expect(isDelegationLimits({ [key]: number })).toBe(true);
        expect(isDelegationSettings({ ...legacyDelegationSettings([]), limits: { [key]: number } })).toBe(true);
      }
      for (const number of [min - 1, max + 1, 1.5, NaN, Infinity, "1", null, true]) {
        invalid.push({ [key]: number });
      }
    }
    for (const limits of invalid) {
      expect(isDelegationLimits(limits)).toBe(false);
      expect(isDelegationSettings({ ...legacyDelegationSettings([]), limits })).toBe(false);
      expect(() => resolveDelegationLimits(limits as Partial<typeof DEFAULT_DELEGATION_LIMITS>)).toThrow("Invalid subagent limits");
    }
  });

  it.each([1, 24, 128])("caps each loaded catalog at %s unique roles, not launches", (maxDefinitions) => {
    const definitions: SubagentDefinition[] = Array.from({ length: 130 }, (_, index) => ({
      name: `worker-${index}`, description: "Inspect", tools: ["Read"], prompt: "Report", source: "builtin",
    }));
    definitions.push({ ...definitions[0], source: "user", prompt: "Custom worker" });
    const before = structuredClone(definitions);
    for (let launch = 0; launch < 2; launch++) {
      const catalog = mergeSubagentDefinitions(definitions, { maxDefinitions });
      expect(catalog.definitions).toHaveLength(maxDefinitions);
      expect(catalog.definitions[0]).toMatchObject({ name: "worker-0", source: "user", prompt: "Custom worker" });
      expect(catalog.dropped).toHaveLength(130 - maxDefinitions);
      expect(catalog.dropped[0]).toBe(`worker-${maxDefinitions}`);
    }
    expect(definitions).toEqual(before);
  });
});
