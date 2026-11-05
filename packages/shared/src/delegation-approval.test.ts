import { describe, expect, it } from "vitest";
import {
  DEFAULT_DELEGATION_APPROVAL_TIMEOUT_SECONDS,
  DEFAULT_DELEGATION_RUN_POLICY,
  DELEGATION_APPROVAL_EXTENSION_SECONDS,
  DELEGATION_APPROVAL_STATUSES,
  isDelegationApprovalActionRequest,
  isDelegationApprovalExtendRequest,
  isDelegationApprovalModel,
  isDelegationApprovalPrompt,
  isDelegationApprovalSnapshot,
  isDelegationSettings,
  legacyDelegationSettings,
  resolveDelegationApprovalTimeoutSeconds,
  resolveDelegationRunPolicy,
  type DelegationApprovalActionRequest,
  type DelegationApprovalActionResult,
  type DelegationApprovalChangedEvent,
  type DelegationApprovalDecision,
  type DelegationApprovalModel,
  type DelegationApprovalPrompt,
  type DelegationApprovalRequest,
  type DelegationPolicySnapshot,
} from "./index.js";

const model: DelegationApprovalModel = {
  providerId: "account", providerName: "My account", modelId: "expert",
  modelLabel: "Expert", thinkingLevel: "high", priority: 2, approval: "ask",
};
const prompt: DelegationApprovalPrompt = {
  sessionId: "session-1", requestId: "request-1", revision: 1, status: "pending",
  createdAt: "2026-11-05T00:00:00.000Z", expiresAt: "2026-11-05T00:05:00.000Z",
  sessionTitle: "Review changes", projectTitle: "Desktop", projectPath: "D:/project",
  agentName: "reviewer", description: "Review concurrency", task: "Full task\nKeep all original context.",
  modelReason: "Specialized review", requestedModel: "account/expert",
  candidate: model, candidates: [model, { ...model, modelId: "general", priority: 1, approval: "auto" }],
  schedulingReason: "Requested specialist requires approval",
};
const identity = { sessionId: prompt.sessionId, requestId: prompt.requestId, revision: prompt.revision };

describe("delegation approval input boundaries", () => {
  it.each(["allow", "skip", "cancel"] as const)("accepts the independent %s action", action => {
    expect(isDelegationApprovalActionRequest({ ...identity, action })).toBe(true);
  });

  it("requires both exact model IDs for select and rejects targets on other actions", () => {
    const target = { providerId: model.providerId, modelId: model.modelId };
    expect(isDelegationApprovalActionRequest({ ...identity, action: "select", ...target })).toBe(true);
    for (const selected of [{}, { providerId: "account" }, { modelId: "expert" },
      { ...target, providerId: " " }, { ...target, modelId: " expert" },
      { ...target, providerId: "p".repeat(129) }, { ...target, modelId: "m".repeat(257) }]) {
      expect(isDelegationApprovalActionRequest({ ...identity, action: "select", ...selected })).toBe(false);
    }
    for (const action of ["allow", "skip", "cancel"]) {
      expect(isDelegationApprovalActionRequest({ ...identity, action, ...target })).toBe(false);
      expect(isDelegationApprovalActionRequest({ ...identity, action, model: target })).toBe(false);
    }
    expect(isDelegationApprovalActionRequest({ ...identity, action: "select", providerId: "p".repeat(128), modelId: "m".repeat(256) })).toBe(true);
  });

  it("validates identity and numeric revision equally for actions, extensions and prompts", () => {
    for (const invalid of [
      { sessionId: "" }, { sessionId: " s" }, { sessionId: 1 }, { sessionId: "s".repeat(257) },
      { requestId: "\t" }, { requestId: "r " }, { requestId: null }, { requestId: "r".repeat(257) },
      ...[undefined, null, "1", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(revision => ({ revision })),
    ]) {
      expect(isDelegationApprovalActionRequest({ ...identity, action: "allow", ...invalid })).toBe(false);
      expect(isDelegationApprovalExtendRequest({ ...identity, ...invalid })).toBe(false);
      expect(isDelegationApprovalPrompt({ ...prompt, ...invalid })).toBe(false);
    }
    for (const revision of [0, Number.MAX_SAFE_INTEGER]) {
      expect(isDelegationApprovalActionRequest({ ...identity, action: "allow", revision })).toBe(true);
      expect(isDelegationApprovalExtendRequest({ ...identity, revision })).toBe(true);
      expect(isDelegationApprovalPrompt({ ...prompt, revision })).toBe(true);
    }
    const longestIds = { ...identity, sessionId: "s".repeat(256), requestId: "r".repeat(256) };
    expect(isDelegationApprovalActionRequest({ ...longestIds, action: "allow" })).toBe(true);
    expect(isDelegationApprovalExtendRequest(longestIds)).toBe(true);
  });

  it("accepts fixed extensions but no caller-authored deadlines or batch/approve-all actions", () => {
    expect(DELEGATION_APPROVAL_EXTENSION_SECONDS).toBe(300);
    expect(isDelegationApprovalExtendRequest(identity)).toBe(true);
    for (const extra of [{ expiresAt: prompt.expiresAt }, { seconds: 300 }, { extensionSeconds: 300 },
      { approvalTimeoutSeconds: 300 }, { action: "allow" }, { actions: [] }]) {
      expect(isDelegationApprovalExtendRequest({ ...identity, ...extra })).toBe(false);
    }
    for (const value of [{ ...identity, action: "approve-all" }, { ...identity, action: "extend" },
      { ...identity, action: "allow", reason: "The user approved" },
      { actions: [{ ...identity, action: "allow" }] }, [{ ...identity, action: "allow" }]]) {
      expect(isDelegationApprovalActionRequest(value)).toBe(false);
    }
  });

  it("fails closed on non-object and missing input values", () => {
    for (const value of [undefined, null, true, 1, "allow", [], {}, identity]) {
      expect(isDelegationApprovalActionRequest(value)).toBe(false);
    }
    for (const value of [undefined, null, true, 1, "extend", [], {}]) {
      expect(isDelegationApprovalExtendRequest(value)).toBe(false);
    }
  });
});

describe("delegation approval host DTOs", () => {
  it("round-trips list, per-row selection and terminal event through the public contract", () => {
    const wire: unknown = JSON.parse(JSON.stringify({ requests: [prompt] }));
    expect(isDelegationApprovalSnapshot(wire)).toBe(true);
    if (!isDelegationApprovalSnapshot(wire)) throw new Error("Invalid list fixture");
    const row = wire.requests[0];
    const target = row.candidates[1];
    const selection: DelegationApprovalActionRequest = {
      sessionId: row.sessionId, requestId: row.requestId, revision: row.revision,
      action: "select", providerId: target.providerId, modelId: target.modelId,
    };
    expect(isDelegationApprovalActionRequest(JSON.parse(JSON.stringify(selection)))).toBe(true);
    const result: DelegationApprovalActionResult = {
      accepted: true, request: { ...row, revision: 2, status: "approved", candidate: target },
    };
    const event: DelegationApprovalChangedEvent = { request: result.request! };
    expect(isDelegationApprovalPrompt(JSON.parse(JSON.stringify(event)).request)).toBe(true);
    expect(event.request).toMatchObject({ requestId: selection.requestId, status: "approved", task: prompt.task });
    expect(isDelegationApprovalSnapshot({ requests: [] })).toBe(true);
    // Shape validation is not authority: host must still reject a stale revision.
    expect(isDelegationApprovalActionRequest(selection)).toBe(true);
  });

  it.each(DELEGATION_APPROVAL_STATUSES)("accepts %s status without using a wall clock", status => {
    expect(isDelegationApprovalPrompt({ ...prompt, status })).toBe(true);
  });

  it("keeps labels and thinking optional while validating model identities and policy rows", () => {
    const { modelLabel: _label, thinkingLevel: _thinking, ...minimal } = model;
    expect(isDelegationApprovalModel(minimal)).toBe(true);
    expect(isDelegationApprovalModel({ ...model, thinkingLevel: "omit", priority: 100, approval: "auto" })).toBe(true);
    for (const value of [null, [], {}, { ...model, providerId: " " }, { ...model, modelId: "x " },
      { ...model, providerName: " " }, { ...model, modelLabel: 1 }, { ...model, thinkingLevel: "turbo" },
      ...[0, 101, 1.5, NaN, Infinity, "1"].map(priority => ({ ...model, priority })),
      { ...model, approval: "always" }]) expect(isDelegationApprovalModel(value)).toBe(false);
  });

  it("rejects malformed timestamps, status, task and optional metadata", () => {
    for (const timestamp of [undefined, null, 0, "not a date", "2026-11-05", "2026-11-05T00:00:00Z",
      "2026-02-30T00:00:00.000Z", "2026-11-05T00:00:00.000+00:00"]) {
      expect(isDelegationApprovalPrompt({ ...prompt, createdAt: timestamp })).toBe(false);
      expect(isDelegationApprovalPrompt({ ...prompt, expiresAt: timestamp })).toBe(false);
    }
    for (const invalid of [{ expiresAt: prompt.createdAt }, { createdAt: prompt.expiresAt },
      { status: "unknown" }, { task: " " }, { task: undefined }, { candidate: null }]) {
      expect(isDelegationApprovalPrompt({ ...prompt, ...invalid })).toBe(false);
    }
    for (const field of ["sessionTitle", "projectTitle", "projectPath", "agentName", "description",
      "modelReason", "requestedModel", "schedulingReason"]) {
      expect(isDelegationApprovalPrompt({ ...prompt, [field]: 1 })).toBe(false);
      expect(isDelegationApprovalPrompt({ ...prompt, [field]: undefined })).toBe(true);
    }
  });

  it("requires bounded distinct candidates that include the current exact identity", () => {
    for (const candidates of [null, [], [null], [model, model], [{ ...model, providerId: "other" }],
      Array.from({ length: 129 }, (_, index) => ({ ...model, modelId: `model-${index}` }))]) {
      expect(isDelegationApprovalPrompt({ ...prompt, candidates })).toBe(false);
    }
    const candidates = Array.from({ length: 128 }, (_, index) => ({ ...model, modelId: `model-${index}` }));
    expect(isDelegationApprovalPrompt({ ...prompt, candidate: candidates[0], candidates })).toBe(true);
  });

  it("rejects malformed snapshots and duplicates while keeping request IDs session-scoped", () => {
    for (const value of [null, [], {}, { requests: null }, { requests: [null] }, { requests: [prompt, prompt] }]) {
      expect(isDelegationApprovalSnapshot(value)).toBe(false);
    }
    expect(isDelegationApprovalSnapshot({ requests: [prompt, { ...prompt, sessionId: "session-2" }] })).toBe(true);
  });
});

describe("additive delegation policy compatibility", () => {
  it("uses five minutes only for new/legacy-seeded settings and preserves saved values", () => {
    expect(DEFAULT_DELEGATION_APPROVAL_TIMEOUT_SECONDS).toBe(300);
    expect(resolveDelegationApprovalTimeoutSeconds()).toBe(300);
    const legacy = legacyDelegationSettings([{ id: "account", models: [{ id: "expert", availableForSubagents: true }] }]);
    expect(legacy.approvalTimeoutSeconds).toBe(300);
    expect(isDelegationSettings(legacy)).toBe(true);
    for (const approvalTimeoutSeconds of [0, 1, 60, 299, 300]) {
      const saved = { ...legacy, approvalTimeoutSeconds };
      expect(resolveDelegationApprovalTimeoutSeconds(saved)).toBe(approvalTimeoutSeconds);
      expect(saved.approvalTimeoutSeconds).toBe(approvalTimeoutSeconds);
      expect(isDelegationSettings(saved)).toBe(true);
    }
    for (const approvalTimeoutSeconds of [-1, 301, 1.5, NaN, Infinity]) {
      expect(isDelegationSettings({ ...legacy, approvalTimeoutSeconds })).toBe(false);
      expect(() => resolveDelegationApprovalTimeoutSeconds({ approvalTimeoutSeconds })).toThrow("Invalid delegation approval timeout");
    }
  });

  it("keeps legacy request/decision producers and additive structured results wire-compatible", () => {
    const request: DelegationApprovalRequest = {
      sessionId: "session-1", requestId: "request-1", providerId: "account", modelId: "expert", task: "Review",
    };
    const enriched: DelegationApprovalRequest = {
      ...request, agentName: "reviewer", description: "Review code", requestedModel: "account/expert",
      thinkingLevel: "high", requiresImages: true, minContextWindow: 100_000, selection: "prefer", automaticOnly: true,
    };
    const oldDecisions: DelegationApprovalDecision[] = ["allow", "skip", "cancel"].map(decision => ({
      decision: decision as DelegationApprovalDecision["decision"], reason: "Legacy host",
    }));
    const selected: DelegationApprovalDecision = {
      decision: "allow", reason: "Explicit selection", code: "selected",
      selectedModel: { providerId: "account", modelId: "general" },
    };
    const timeout: DelegationApprovalDecision = { decision: "skip", reason: "Expired", code: "timeout" };
    const snapshot: DelegationPolicySnapshot = { revision: "host-policy-1", modelKeys: ["account/expert"] };
    expect(JSON.parse(JSON.stringify(enriched))).toMatchObject(request);
    expect(oldDecisions.map(result => result.decision)).toEqual(["allow", "skip", "cancel"]);
    expect(JSON.parse(JSON.stringify(selected)).selectedModel.modelId).toBe("general");
    expect(timeout.code).toBe("timeout");
    expect(snapshot).not.toHaveProperty("settings");
  });

  it("preserves the three-field run policy and accepted legacy checkpoint validation", () => {
    const legacy = { ...DEFAULT_DELEGATION_RUN_POLICY, checkpointInterval: 12, maxCheckpointRequests: 2 };
    const settings = { ...legacyDelegationSettings([]), runPolicy: legacy };
    expect(isDelegationSettings(settings)).toBe(true);
    expect(resolveDelegationRunPolicy(legacy)).toEqual({ maxToolCalls: 0, maxDurationSeconds: 0, finalReportTimeoutSeconds: 60 });
    expect(Object.keys(DEFAULT_DELEGATION_RUN_POLICY)).toEqual(["maxToolCalls", "maxDurationSeconds", "finalReportTimeoutSeconds"]);
  });
});
