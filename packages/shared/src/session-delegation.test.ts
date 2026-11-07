import { describe, expect, it } from "vitest";
import { type DelegationSettings, orderDelegationModels } from "./delegation-policy.js";
import { isSessionDelegationPolicy, resolveSessionDelegationSettings } from "./session-delegation.js";

const settings: DelegationSettings = {
  version: 1, approvalTimeoutSeconds: 60, runPolicy: { maxToolCalls: 12 },
  models: [
    { providerId: "p", modelId: "review", enabled: true, priority: 2, approval: "ask", description: "Review" },
    { providerId: "p", modelId: "general", enabled: true, priority: 1, approval: "auto", description: "General" },
    { providerId: "p", modelId: "disabled", enabled: false, priority: 1, approval: "ask", description: "Disabled" },
  ],
};

describe("session delegation approval", () => {
  it("applies explicit session consent in both directions without modifying global settings", () => {
    const original = structuredClone(settings);
    const result = resolveSessionDelegationSettings(settings, [], {
      modelKeys: ["p/review", "p/general"], modelApprovals: { "p/review": "auto", "p/general": "ask" },
    });
    expect(result?.models.map(row => row.approval)).toEqual(["auto", "ask"]);
    expect(result?.approvalTimeoutSeconds).toBe(60);
    expect(result?.runPolicy).toEqual({ maxToolCalls: 12 });
    expect(result?.models[0]).toMatchObject({ priority: 2, description: "Review" });
    expect(settings).toEqual(original);
  });

  it("preserves legacy inheritance, empty custom pools and globally disabled models", () => {
    expect(resolveSessionDelegationSettings(settings, [], { modelKeys: null })).toBe(settings);
    expect(resolveSessionDelegationSettings(undefined, [], { modelKeys: null })).toBeUndefined();
    expect(resolveSessionDelegationSettings(settings, [], { modelKeys: ["p/review"] })?.models[0].approval).toBe("ask");
    expect(resolveSessionDelegationSettings(settings, [], { modelKeys: [] })?.models).toEqual([]);
    const policy = resolveSessionDelegationSettings(settings, [], {
      modelKeys: ["p/disabled"], modelApprovals: { "p/disabled": "auto" },
    });
    expect(orderDelegationModels(policy!)).toEqual([]);
    expect(resolveSessionDelegationSettings(settings, [], { modelKeys: ["p/missing"] })?.models).toEqual([]);
  });

  it("applies approval to legacy opted-in models but never expands legacy eligibility", () => {
    const policy = resolveSessionDelegationSettings(undefined, [{ id: "p", models: [
      { id: "review", availableForSubagents: true }, { id: "general" },
    ] }], { modelKeys: ["p/review", "p/general"], modelApprovals: { "p/review": "ask", "p/general": "auto" } });
    expect(policy?.models).toHaveLength(1);
    expect(policy?.models[0]).toMatchObject({ modelId: "review", approval: "ask" });
  });

  it("rejects malformed session policy and approval outside the custom pool", () => {
    for (const value of [undefined, null, [], {}, { modelKeys: ["p/m", "p/m"] }, { modelKeys: ["p/ m"] },
      { modelKeys: ["/m"] }, { modelKeys: ["p/m\n"] }, { modelKeys: ["p/" + "x".repeat(257)] },
      { modelKeys: null, modelApprovals: { "p/m": "auto" } }, { modelKeys: [], modelApprovals: { "p/m": "auto" } },
      { modelKeys: ["p/m"], modelApprovals: [] }, { modelKeys: ["p/m"], modelApprovals: { "p/m": "always" } }]) {
      expect(isSessionDelegationPolicy(value)).toBe(false);
    }
    for (const value of [{ modelKeys: null }, { modelKeys: [], modelApprovals: {} },
      { modelKeys: ["p/m"], modelApprovals: null }, { modelKeys: ["p/m"], modelApprovals: { "p/m": "ask" } }]) {
      expect(isSessionDelegationPolicy(value)).toBe(true);
    }
  });
});
