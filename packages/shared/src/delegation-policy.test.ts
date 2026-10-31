import { describe, expect, it } from "vitest";
import { describeDelegationModels, isDelegationSettings, legacyDelegationSettings, orderDelegationModels, type DelegationModel, type DelegationSettings } from "./delegation-policy.js";

const model = (modelId: string, priority = 1): DelegationModel => ({ providerId: "account", modelId, priority, approval: "auto", enabled: true, description: "Use for code review" });
const settings = (models: DelegationModel[]): DelegationSettings => ({ version: 1, approvalTimeoutSeconds: 60, models });

describe("delegation policy", () => {
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
