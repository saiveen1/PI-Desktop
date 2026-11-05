import { describe, expect, it, vi } from "vitest";
import type { DelegationApprovalDecision, DelegationSettings } from "@pi-desktop/shared";
import { DelegationScheduler } from "./delegation-scheduler.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

const provider = (modelId: string): RuntimeProviderConfig => ({ id: "account", name: "Fixture", modelId, apiKey: "", authKind: "none", supportsReasoning: false, supportedThinkingLevels: [] });
const policy: DelegationSettings = {
  version: 1, approvalTimeoutSeconds: 60,
  models: ["expensive", "cheap"].map((modelId, index) => ({ providerId: "account", modelId, priority: index + 1,
    approval: index ? "auto" : "ask", enabled: true, description: "" })),
};
const resolve = async (key: string) => provider(key.split("/")[1]);
const allow = async (): Promise<DelegationApprovalDecision> => ({ decision: "allow", reason: "Policy permits this model" });
const create = (options: Partial<ConstructorParameters<typeof DelegationScheduler>[0]> = {}) => new DelegationScheduler({
  settings: policy, sessionId: "session", task: "Review one change", resolve, authorize: allow, ...options,
});

describe("delegation scheduling", () => {
  it("starts the same delegation on an authorized alternate after approval expires", async () => {
    const authorize = vi.fn(async (request): Promise<DelegationApprovalDecision> => request.modelId === "expensive"
      ? { decision: "skip", reason: "Approval expired" } : allow());
    const scheduler = create({ authorize });
    const result = await scheduler.select();
    expect(result.provider.modelId).toBe("cheap");
    expect(authorize.mock.calls.map(([request]) => request.task)).toEqual(["Review one change", "Review one change"]);
    expect(scheduler.decisions).toEqual([
      { model: "account/expensive", decision: "skipped", reason: "Approval expired" },
      { model: "account/cheap", decision: "selected", reason: "Policy permits this model" },
    ]);
  });
  it("never replaces an exact model or turns a cancellation into fallback", async () => {
    const authorize = vi.fn(async (): Promise<DelegationApprovalDecision> => ({ decision: "skip", reason: "Not approved" }));
    await expect(create({ preferredKey: "account/expensive", selection: "require", authorize }).select()).rejects.toThrow("No authorized");
    expect(authorize).toHaveBeenCalledTimes(1);
    const cancel = vi.fn(async (): Promise<DelegationApprovalDecision> => ({ decision: "cancel", reason: "User cancelled" }));
    await expect(create({ authorize: cancel }).select()).rejects.toThrow("cancelled by the user");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("checks pinned and resumed bindings and reauthorizes on a later invocation", async () => {
    const authorize = vi.fn(allow);
    const options = { preferredProvider: provider("expensive"), authorize };
    const first = create(options);
    await first.select();
    await first.authorize(provider("expensive"));
    expect(authorize).toHaveBeenCalledTimes(1);
    await create(options).select();
    expect(authorize).toHaveBeenCalledTimes(2);
  });
  it("checks each fallback and refuses an unlisted binding", async () => {
    const authorize = vi.fn(allow);
    const scheduler = create({ authorize });
    const selected = await scheduler.select();
    expect(selected.fallbacks.map((row) => row.key)).toEqual(["account/cheap"]);
    expect(await scheduler.authorize(provider("cheap"))).toBe(true);
    expect(await scheduler.authorize(provider("hidden"))).toBe(false);
    expect(authorize).toHaveBeenCalledTimes(2);
  });
  it("fails closed without a supporting host but preserves legacy bindings", async () => {
    await expect(create({ authorize: undefined }).select()).rejects.toThrow("host does not support");
    const legacy = create({ settings: undefined, preferredProvider: provider("legacy"), authorize: undefined });
    expect((await legacy.select()).provider.modelId).toBe("legacy");
  });
  it("cancels an outstanding approval and ignores its late grant", async () => {
    let release!: (result: DelegationApprovalDecision) => void;
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const controller = new AbortController();
    const cancelApproval = vi.fn(async () => undefined);
    const scheduler = create({ cancelApproval, authorize: () => {
      enteredResolve();
      return new Promise((resolve) => { release = resolve; });
    } });
    const pending = scheduler.select(controller.signal);
    await entered;
    controller.abort();
    await expect(pending).rejects.toThrow();
    release({ decision: "allow", reason: "Late answer" });
    expect(cancelApproval).toHaveBeenCalledTimes(1);
    expect(scheduler.decisions.some((row) => row.decision === "selected")).toBe(false);
  });
  it("checks required capabilities before prompting for an incompatible model", async () => {
    const authorize = vi.fn(allow);
    const scheduler = create({ authorize, compatible: (candidate) => candidate.modelId === "expensive" ? "No image support" : undefined });
    expect((await scheduler.select()).provider.modelId).toBe("cheap");
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(scheduler.decisions[0].reason).toBe("No image support");
  });
  it("uses an exact host-selected alternative once, not the proposed candidate", async () => {
    const authorize = vi.fn(async (): Promise<DelegationApprovalDecision> => ({ decision: "allow", reason: "Selected once",
      selectedModel: { providerId: "account", modelId: "cheap" }, code: "selected" }));
    const scheduler = create({ authorize, agentName: "worker", description: "Review fixture", requestedModel: "requested alias",
      thinkingLevel: "high", requiresImages: true, minContextWindow: 4096 });
    expect((await scheduler.select()).provider.modelId).toBe("cheap");
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize.mock.calls[0]).toEqual([expect.objectContaining({ agentName: "worker", description: "Review fixture",
      requestedModel: "requested alias", thinkingLevel: "high", requiresImages: true, minContextWindow: 4096 })]);
  });
  it("never substitutes an invalid, incompatible or require-mismatched selected target", async () => {
    for (const options of [
      { target: "hidden" }, { target: "cheap", compatible: (candidate: RuntimeProviderConfig) => candidate.modelId === "cheap" ? "No images" : undefined },
      { target: "cheap", selection: "require" as const, preferredKey: "account/expensive" },
    ]) {
      const authorize = vi.fn(async (): Promise<DelegationApprovalDecision> => ({ decision: "allow", reason: "Selected",
        selectedModel: { providerId: "account", modelId: options.target } }));
      await expect(create({ ...options, authorize }).select()).rejects.toThrow(/selected model/i);
      expect(authorize).toHaveBeenCalledTimes(1);
    }
  });
  it("switches to automaticOnly after timeout and never waits on a second ask", async () => {
    const settings: DelegationSettings = { ...policy, models: [policy.models[0], { ...policy.models[0], modelId: "another-ask", priority: 2 },
      { ...policy.models[1], priority: 3 }] };
    const authorize = vi.fn(async (request): Promise<DelegationApprovalDecision> => request.modelId === "expensive"
      ? { decision: "skip", reason: "not a prose trigger", code: "timeout" } : allow());
    expect((await create({ settings, authorize }).select()).provider.modelId).toBe("cheap");
    expect(authorize.mock.calls.map(([request]) => [request.modelId, request.automaticOnly])).toEqual([["expensive", undefined], ["cheap", true]]);
  });
  it("re-reads current candidates after a policy change while keeping attempted identities spent", async () => {
    let settings = policy;
    const authorize = vi.fn(async (request): Promise<DelegationApprovalDecision> => {
      if (request.modelId === "expensive") {
        settings = { ...policy, models: [policy.models[0], { ...policy.models[1], modelId: "new" }] };
        return { decision: "skip", reason: "Expired", code: "timeout" };
      }
      return allow();
    });
    const scheduler = create({ authorize, currentPolicy: async () => ({ settings }) });
    expect((await scheduler.select()).provider.modelId).toBe("new");
    expect(authorize.mock.calls.map(([request]) => request.modelId)).toEqual(["expensive", "new"]);
  });
});
