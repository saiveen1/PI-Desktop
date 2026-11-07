import { describe, expect, it } from "vitest";
import { DEFAULT_DELEGATION_RUN_POLICY, DELEGATION_RUN_POLICY_LIMITS, resolveDelegationRunPolicy, isDelegationRunPolicySnapshot, isDelegationRunPolicy, describeDelegationModels, isDelegationSettings, legacyDelegationSettings, orderDelegationModels, type DelegationModel, type DelegationSettings } from "./delegation-policy.js";

const model = (modelId: string, priority = 1): DelegationModel => ({ providerId: "account", modelId, priority, approval: "auto", enabled: true, description: "Use for code review" });
const settings = (models: DelegationModel[]): DelegationSettings => ({ version: 1, approvalTimeoutSeconds: 60, models });

describe("delegation policy", () => {
  it("honors task fit in a custom session pool while preserving inherited priority", () => {
    const policy = settings([model("general", 1), model("specialist", 90)]);
    expect(orderDelegationModels(policy, { preferredKey: "account/specialist", selectionMode: "task-fit" })[0].modelId).toBe("specialist");
    expect(orderDelegationModels(policy, { preferredKey: "account/specialist" })[0].modelId).toBe("general");
    expect(orderDelegationModels(settings([]), { preferredKey: "account/specialist", selectionMode: "task-fit" })).toEqual([]);
    expect(orderDelegationModels(policy, { preferredKey: "account/missing", selection: "require", selectionMode: "task-fit" })).toEqual([]);
  });
  it("rejects malformed run policy instead of silently accepting it", () => {
    for (const runPolicy of [null, [], { maxToolCalls: -1 }, { checkpointInterval: 0 }, { maxDurationSeconds: "900" }]) {
      expect(isDelegationSettings({ ...settings([]), runPolicy })).toBe(false);
    }
  });
  it("selects a peer by fit and requires a reason to promote a lower tier", () => {
    const policy = settings([model("general"), model("search"), model("expert", 2)]);
    expect(orderDelegationModels(policy, { preferredKey: "account/search" }).map((row) => row.modelId)).toEqual(["search", "general", "expert"]);
    expect(orderDelegationModels(policy, { preferredKey: "account/expert" })[0].modelId).toBe("general");
    expect(orderDelegationModels(policy, { preferredKey: "account/expert", reason: "Independent concurrency review" })[0].modelId).toBe("expert");
  });
  it("keeps required models exact and excludes disabled models", () => {
    const policy = settings([model("general"), { ...model("expert"), enabled: false }]);
    expect(orderDelegationModels(policy, { preferredKey: "account/expert", selection: "require" })).toEqual([]);
    expect(orderDelegationModels(policy, { preferredKey: "account/general", selection: "require" })).toHaveLength(1);
    expect(orderDelegationModels(policy)).toHaveLength(1);
  });
  it("validates saved boundaries without treating malformed policy as legacy", () => {
    expect(isDelegationSettings(settings([]))).toBe(true);
    for (const value of [null, {}, { ...settings([]), version: 2 }, { ...settings([]), approvalTimeoutSeconds: -1 },
      settings([model("x"), model("x")]), settings([{ ...model("x"), approval: "always" } as unknown as DelegationModel]),
      settings([model(" x")]), settings([{ ...model("x"), priority: 1.5 }]), settings([{ ...model("x"), description: "x".repeat(1001) }])]) {
      expect(isDelegationSettings(value)).toBe(false);
    }
  });
  it("migrates only opted-in bindings and supplies descriptions with tool guidance", () => {
    const migrated = legacyDelegationSettings([{ id: "account", models: [{ id: "x", availableForSubagents: true }, { id: "y" }] }]);
    expect(migrated.models).toEqual([{ ...model("x"), description: "" }]);
    const text = describeDelegationModels(settings([{ ...model("x"), approval: "ask" }]));
    expect(text).toContain("Use for code review");
    expect(text).toContain("requires user approval");
    expect(text).toContain("same task on an authorized alternative");
  });
});


describe("subagent run policy", () => {
  it("keeps visible defaults without changing legacy saved settings", () => {
    const previous = settings([]);
    expect(isDelegationSettings(previous)).toBe(true);
    expect(resolveDelegationRunPolicy(previous.runPolicy)).toEqual(DEFAULT_DELEGATION_RUN_POLICY);
    expect(previous).not.toHaveProperty("runPolicy");
  });
  it("resolves a detached immutable snapshot and keeps explicit unlimited values", () => {
    const input = { maxToolCalls: 0, maxDurationSeconds: 0, finalReportTimeoutSeconds: 5 };
    const result = resolveDelegationRunPolicy(input);
    input.finalReportTimeoutSeconds = 8;
    expect(result).toEqual({ ...DEFAULT_DELEGATION_RUN_POLICY, maxToolCalls: 0, maxDurationSeconds: 0, finalReportTimeoutSeconds: 5 });
    expect(Object.isFrozen(result)).toBe(true);
  });
  it("accepts old trial metadata without restoring the retired report gate", () => {
    const legacy = { maxToolCalls: 128, maxDurationSeconds: 900, finalReportTimeoutSeconds: 30,
      checkpointInterval: 12, maxCheckpointRequests: 2 };
    expect(isDelegationSettings({ ...settings([]), runPolicy: legacy })).toBe(true);
    expect(isDelegationRunPolicySnapshot(legacy)).toBe(true);
    expect(resolveDelegationRunPolicy(legacy)).toEqual({ maxToolCalls: 128, maxDurationSeconds: 900, finalReportTimeoutSeconds: 30 });
    expect(resolveDelegationRunPolicy()).toEqual({ maxToolCalls: 0, maxDurationSeconds: 0, finalReportTimeoutSeconds: 60 });
  });
  it("validates every configured bound and rejects typos and non-integers", () => {
    for (const [key, { min, max }] of Object.entries(DELEGATION_RUN_POLICY_LIMITS)) {
      for (const value of [min, max]) expect(isDelegationRunPolicy({ [key]: value })).toBe(true);
      for (const value of [min - 1, max + 1, 1.5, NaN, Infinity, "1", null, true]) {
        expect(isDelegationSettings({ ...settings([]), runPolicy: { [key]: value } })).toBe(false);
      }
    }
    expect(isDelegationRunPolicy({ typo: 1 })).toBe(false);
    expect(() => resolveDelegationRunPolicy({ finalReportTimeoutSeconds: 0 })).toThrow("Invalid subagent run policy");
  });
});
