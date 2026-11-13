import { expect, it } from "vitest";
import { delegationPolicySnapshot } from "./delegation-boundary.js";

it("carries detached capacity limits through the Host snapshot without inventing legacy fields", () => {
  const settings = { version: 1, approvalTimeoutSeconds: 60, models: [], limits: { maxDefinitions: 24, maxConcurrent: 12 } };
  const snapshot = delegationPolicySnapshot({ revision: "r1", modelKeys: [], settings });
  expect(snapshot.settings?.limits).toEqual(settings.limits);
  settings.limits.maxConcurrent = 1;
  expect(snapshot.settings?.limits?.maxConcurrent).toBe(12);
  expect(delegationPolicySnapshot({ revision: "r2", modelKeys: [], settings: {
    version: 1, approvalTimeoutSeconds: 60, models: [],
  } }).settings).not.toHaveProperty("limits");
  for (const limits of [null, { maxConcurrent: 0 }, { maxDefinitions: 129 }, { typo: 10 }]) {
    expect(() => delegationPolicySnapshot({ revision: "bad", modelKeys: [], settings: { ...settings, limits } })).toThrow("Invalid delegation policy snapshot");
  }
});
