import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import type { AgentEventEnvelope, DelegationApprovalDecision, DelegationApprovalRequest, DelegationPolicySnapshot, DelegationSettings, UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";
import { genericModelConfig } from "./model-capabilities.js";
import { isRecord } from "./agent-messages.js";

const transport = vi.hoisted(() => vi.fn<Models["streamSimple"]>());
vi.mock("./provider-binding.js", async original => {
  const actual = await original<typeof import("./provider-binding.js")>();
  return { ...actual, createProviderModels: (...args: Parameters<typeof actual.createProviderModels>) => {
    const models = actual.createProviderModels(...args);
    models.streamSimple = transport;
    models.stream = (model, context) => transport(model, context);
    return models;
  } };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function reply(content: AssistantMessage["content"]) {
  const stream = createAssistantMessageEventStream();
  const finish = (blocks = content) => {
    const stopReason = blocks.some(block => block.type === "toolCall") ? "toolUse" : "stop";
    const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
      timestamp: Date.now(), content: blocks, stopReason,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: stopReason, message });
    stream.end(message);
  };
  return { stream, finish };
}
const text = (value: string): AssistantMessage["content"] => [{ type: "text", text: value }];
type ToolArgs = Extract<AssistantMessage["content"][number], { type: "toolCall" }>["arguments"];
const call = (name: string, args: ToolArgs): AssistantMessage["content"] => [{ type: "toolCall", id: crypto.randomUUID(), name, arguments: args }];
function provider(modelId: string): RuntimeProviderConfig {
  const reasoning = modelId !== "old";
  return { id: "fixture", name: "Fixture", modelId, authKind: "none", apiKey: "",
    supportsReasoning: reasoning, supportedThinkingLevels: reasoning ? ["off", "high"] : ["off"],
    modelConfig: { ...genericModelConfig(modelId, "http://fixture.invalid/v1"), reasoning,
      input: reasoning ? ["text", "image"] : ["text"], supportedThinkingLevels: reasoning ? ["off", "high"] : ["off"] } };
}
const policy = (modelIds = ["old", "new"], limit = 0): DelegationSettings => ({ version: 1, approvalTimeoutSeconds: 60,
  runPolicy: { maxToolCalls: limit }, models: modelIds.map((modelId, index) => ({ providerId: "fixture", modelId,
    enabled: true, priority: index + 1, approval: "auto", description: `${modelId} scheduling guidance` })) });
beforeEach(() => { transport.mockReset(); });

function fixture(options: { parent: (index: number) => ReturnType<typeof reply>; oldRead?: boolean;
  roleLevel?: "off" | "omit"; parentLevel?: "off" | "high";
  history?: UiMessage[]; sessionId?: string;
  authorize?: (request: DelegationApprovalRequest) => Promise<DelegationApprovalDecision>; selectionMode?: "task-fit" } ) {
  const events: AgentEventEnvelope[] = [];
  const parentRequests: string[] = [];
  const childRequests: string[] = [];
  const approvals: DelegationApprovalRequest[] = [];
  const resolved: string[] = [];
  const readStarted = deferred<void>();
  const read = deferred<unknown>();
  const newStarted = deferred<void>();
  const afterSecondTask = deferred<void>();
  let snapshot: DelegationPolicySnapshot = { settings: policy(), modelKeys: ["fixture/old", "fixture/new"], revision: "initial", selectionMode: options.selectionMode };
  let oldRequests = 0;
  transport.mockImplementation((model, context) => {
    if (model.id === "parent") {
      parentRequests.push(JSON.stringify(context));
      if (parentRequests.length === 3) afterSecondTask.resolve();
      return options.parent(parentRequests.length).stream;
    }
    childRequests.push(model.id);
    if (model.id === "new") newStarted.resolve();
    const result = reply(model.id === "old" && options.oldRead && ++oldRequests === 1
      ? call("Read", { path: "fixture.ts" }) : text(`${model.id} completed`));
    queueMicrotask(() => result.finish());
    return result.stream;
  });
  const config = {
    sessionId: options.sessionId ?? "hot-policy", history: options.history, mode: "agent" as const, provider: provider("parent"), thinkingLevel: options.parentLevel ?? "high" as const,
    commandShell: { id: "bash" as const, label: "Bash", dialect: "posix" as const, available: true, isDefault: true },
    subagents: [{ name: "worker", description: "Independent check", tools: ["Read"], prompt: "Check fixture.", source: "user" as const, thinkingLevel: options.roleLevel }],
    subagentProviders: { "fixture/old": provider("old"), "fixture/new": provider("new") },
    subagentModelKeys: ["fixture/old", "fixture/new"], delegationSettings: policy(), delegationAuthorization: true,
  };
  const runtime = new DesktopAgentRuntime({ ...config,
    host: { call: async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "provider.delegationSnapshot") return structuredClone(snapshot) as T;
      if (method === "provider.resolveSubagentModel") {
        const key = (params as { key: string }).key;
        resolved.push(key);
        return (snapshot.modelKeys.includes(key) ? provider(key.slice(key.indexOf("/") + 1)) : undefined) as T;
      }
      if (method === "provider.authorizeDelegation") {
        const request = params as DelegationApprovalRequest;
        approvals.push(request);
        return (options.authorize ? await options.authorize(request) : { decision: "allow", reason: "Auto policy" }) as T;
      }
      if (method === "provider.cancelDelegationApproval" || method === "session.appendMessage") return undefined as T;
      if (method === "todos.get") return { sessionId: config.sessionId, todos: [] } as T;
      if (method === "tools.fileBatchCapabilities" || method === "backgroundJobs.capabilities") return { version: 1, supported: false } as T;
      if (method === "project.instructions.resolve") return { entries: [] } as T;
      if (method === "tools.execute") { readStarted.resolve(); return await read.promise as T; }
      throw new Error(`Unexpected host call ${method}`);
    } }, onEvent: event => events.push(event),
  });
  return { runtime, config, events, parentRequests, childRequests, approvals, resolved, read, readStarted, newStarted, afterSecondTask,
    save: async (settings: DelegationSettings, modelKeys = settings.models.map(row => `${row.providerId}/${row.modelId}`)) => {
      snapshot = { settings, modelKeys, revision: crypto.randomUUID(), selectionMode: options.selectionMode };
      await runtime.refreshDelegationPolicy();
    },
    prompt: () => runtime.prompt("Delegate independent checks.", crypto.randomUUID(), "same-turn"),
    close: async () => { read.resolve({ ok: true }); await runtime.abort(); await runtime.dispose(); },
  };
}
function immediate(blocks: AssistantMessage["content"]) { const result = reply(blocks); queueMicrotask(() => result.finish()); return result; }
const task = (extra: ToolArgs = {}) => call("Task", { agent: "worker", task: "Check fixture carefully.", description: "Independent fixture check", ...extra });
function details(events: AgentEventEnvelope[]) {
  const taskIds = new Set(events.flatMap(({ event, parentToolCallId }) =>
    !parentToolCallId && event.type === "tool_start" && event.toolName === "Task" ? [event.toolCallId] : []));
  return events.flatMap(({ event, parentToolCallId }) => {
    if (parentToolCallId || event.type !== "tool_end" || !taskIds.has(event.toolCallId) || !isRecord(event.result) || !isRecord(event.result.details)) return [];
    return [event.result.details];
  });
}

describe("hot delegation policy through the real parent and child agent loops", () => {
  it("distinguishes retired chains from unknown resume ids without executing a delegate", async () => {
    const ids = ["old-a", "old-b", "old-c", "old-stopped", "recent-a", "recent-b"];
    const history: UiMessage[] = ids.map((id, i) => ({
      id, role: "tool", toolName: "Task", toolCallId: `task-${id}`, content: "", createdAt: new Date(1000 * (i + 1)).toISOString(),
      toolArgs: { agent: "worker", task: "Prior check." }, toolStatus: "success",
      toolResult: { details: { delegationId: id, agent: "worker", status: i === 3 ? "stopped" : "completed" } },
    }));
    history.push({ ...history[0], id: "rejected", toolCallId: "rejected", toolStatus: "error",
      toolArgs: { agent: "worker", task: "Continue.", resume: "guessed" }, toolResult: { details: { error: "Unknown delegation guessed" } } });
    const f = fixture({ history, parent: index => immediate(index === 1 ? call("TaskList", {}) : index === 2
      ? [...ids.slice(0, 4), "guessed"].flatMap(resume => task({ resume })) : text("Use previous reports.")) });
    try {
      await f.prompt();
      const list = f.events.flatMap(({ event }) => event.type === "tool_end" && isRecord(event.result) && isRecord(event.result.details)
        && Array.isArray(event.result.details.resumable) ? event.result.details.resumable.filter(isRecord) : []);
      expect(list.map(row => row.delegationId)).toEqual(["recent-b", "recent-a"]);
      const errors = details(f.events);
      expect(errors).toHaveLength(5);
      const retired = errors.filter(row => row.code === "DELEGATION_RESUME_NOT_RETAINED");
      expect(retired).toHaveLength(4);
      for (const row of retired) expect(row.error).toMatch(/was recorded in this session.*no longer retained/);
      expect(f.parentRequests.at(-1)).toContain("no longer retained for resume");
      expect(errors).toContainEqual(expect.objectContaining({ code: "DELEGATION_RESUME_UNKNOWN", error: expect.stringContaining("Unknown delegation") }));
      for (const row of errors) {
        expect(row.error).toContain("TaskList");
        expect(row).not.toHaveProperty("delegationId");
      }
      expect(f.approvals).toEqual([]);
      expect(f.childRequests).toEqual([]);
    } finally { await f.close(); }

    const other = fixture({ sessionId: "another-session", parent: index => immediate(index === 1 ? task({ resume: ids[0] }) : text("Not in this session.")) });
    try {
      await other.prompt();
      expect(details(other.events)).toMatchObject([{ code: "DELEGATION_RESUME_UNKNOWN" }]);
      expect(details(other.events)[0]?.error).not.toContain("recent-a");
      expect(other.approvals).toEqual([]);
      expect(other.childRequests).toEqual([]);
    } finally { await other.close(); }
  });

  it.each([
    { parentLevel: "off", effort: "high", expected: "high" },
    { parentLevel: "high", effort: "off", expected: "off" },
    { parentLevel: "off", effort: "max", expected: "high" },
    { parentLevel: "high", effort: "high", roleLevel: "off", expected: "off" },
    { parentLevel: "high", effort: "high", roleLevel: "omit", expected: "omit" },
  ] as const)("resolves Task effort $effort with parent $parentLevel to $expected", async row => {
    const roleLevel = "roleLevel" in row ? row.roleLevel : undefined;
    const f = fixture({ parentLevel: row.parentLevel, roleLevel, parent: index => immediate(index === 1
      ? task({ effort: row.effort }) : text("Checked.")) });
    try {
      await f.save(policy(["new"]));
      await f.prompt();
      expect(f.childRequests).toEqual(["new"]);
      expect(f.parentRequests[0]).toContain('"effort":{');
      expect(details(f.events)[0]?.thinkingLevel).toBe(row.expected);
      expect(f.approvals[0]?.thinkingLevel).toBe(roleLevel === "omit" ? undefined : roleLevel ?? row.effort);
    } finally { await f.close(); }
  });

  it("rejects an invalid Task effort before approval or execution", async () => {
    const f = fixture({ parent: index => immediate(index === 1 ? task({ model: "fixture/old", modelReason: "A text-only check.", effort: "turbo" }) : text("Rejected.")) });
    try {
      await f.prompt();
      expect(f.approvals).toEqual([]);
      expect(f.childRequests).toEqual([]);
    } finally { await f.close(); }
  });

  it("requires explicit model selection and rationale for a new Task with multiple global candidates", async () => {
    const reason = "The new model fits this review.";
    const steps = [call("TaskModels", {}), task(), task({ modelReason: reason }), task({ model: "fixture/old", modelReason: " " }),
      task({ model: "fixture/new", modelReason: reason }), call("TaskWait", {})];
    const f = fixture({ parent: index => immediate(steps[index - 1] ?? text("Checked.")) });
    try {
      await f.prompt();
      const rows = details(f.events);
      expect(rows).toHaveLength(4);
      for (const row of rows.slice(0, 3)) expect(row.error).toMatch(/model.*modelReason/);
      expect(rows[3]).toMatchObject({ modelId: "new", scheduling: { requestedModel: "fixture/new", modelReason: reason } });
      expect(f.approvals).toHaveLength(1);
      expect(f.childRequests).toEqual(["new"]);
    } finally { await f.close(); }
  });

  it("queries descriptions on demand, chooses a specialist and retains its rationale", async () => {
    const reason = "The new model fits the independent review.";
    const f = fixture({ selectionMode: "task-fit", parent: index => immediate(
      index === 1 ? call("TaskModels", {}) :
      index === 2 ? task({ model: "fixture/new", modelReason: reason }) :
      index === 3 ? call("TaskWait", {}) : text("Review incorporated."),
    ) });
    try {
      await f.prompt();
      expect(f.parentRequests[0]).not.toContain("new scheduling guidance");
      expect(f.parentRequests[1]).toContain("new scheduling guidance");
      expect(f.childRequests).toEqual(["new"]);
      expect(details(f.events)[0]).toMatchObject({
        modelId: "new", scheduling: { requestedModel: "fixture/new", modelReason: reason },
      });
    } finally { await f.close(); }
  });
  it("applies a save to a later Task and catalog in one parent turn while an active child keeps its model and policy", async () => {
    const waitingParent = deferred<void>();
    const held = reply(task());
    const f = fixture({ oldRead: true, parent: index => {
      if (index === 1) return immediate(task({ model: "fixture/old", modelReason: "Use the text reader for the first check." }));
      if (index === 2) { waitingParent.resolve(); return held; }
      return immediate(index === 3 ? call("TaskWait", {}) : text("All checks incorporated."));
    } });
    try {
      const pending = f.prompt();
      await Promise.all([waitingParent.promise, f.readStarted.promise]);
      const inFlight = f.parentRequests[1];
      const agent = Reflect.get(f.runtime, "agent");
      await f.save(policy(["new"], 1));
      expect(Reflect.get(f.runtime, "agent")).toBe(agent);
      expect(f.runtime.firstMismatch({ ...f.config, delegationSettings: policy(["new"], 1), subagentProviders: {}, subagentModelKeys: ["fixture/new"] })).toBeNull();
      expect(f.parentRequests[1]).toBe(inFlight);
      expect(f.childRequests).toEqual(["old"]);
      held.finish();
      await Promise.all([f.newStarted.promise, f.afterSecondTask.promise]);
      expect(f.parentRequests[2]).not.toContain("new scheduling guidance");
      expect(f.parentRequests[2]).not.toContain("old scheduling guidance");
      expect(details(f.events)).toEqual([
        expect.objectContaining({ modelId: "old", thinkingLevel: "off", runPolicy: expect.objectContaining({ maxToolCalls: 0 }) }),
        expect.objectContaining({ modelId: "new", thinkingLevel: "high", runPolicy: expect.objectContaining({ maxToolCalls: 1 }) }),
      ]);
      f.read.resolve({ ok: true, content: "Retained evidence" });
      await pending;
      expect(f.childRequests).toEqual(["old", "new", "old"]);
      expect(f.events.filter(({ event }) => event.type === "error")).toEqual([]);
    } finally { held.finish(); await f.close(); }
  });

  it("uses a host-selected alternate once and publishes the exact model and clamped thinking", async () => {
    const f = fixture({ parent: index => immediate(index === 1 ? task({ model: "fixture/old", modelReason: "A text-only check.", requiresImages: false, minContextWindow: 4096 }) : text("Checked.")),
      authorize: async () => ({ decision: "allow", reason: "User chose alternate", code: "selected", selectedModel: { providerId: "fixture", modelId: "new" } }) });
    try {
      await f.prompt();
      expect(f.approvals).toHaveLength(1);
      expect(f.approvals[0]).toMatchObject({ agentName: "worker", description: "Independent fixture check", requestedModel: "fixture/old", thinkingLevel: "high", requiresImages: false, minContextWindow: 4096, selection: "prefer" });
      expect(f.resolved).toContain("fixture/new");
      expect(f.childRequests).toEqual(["new"]);
      expect(details(f.events)[0]).toMatchObject({ modelId: "new", thinkingLevel: "high" });
    } finally { await f.close(); }
  });

  it.each([{ modelIds: [] }, { modelIds: ["new"] }])("fails closed for an authoritative empty available pool or saved pool ($modelIds)", async ({ modelIds }) => {
    const f = fixture({ parent: index => immediate(index === 1 ? task() : text("No delegate could start.")) });
    try {
      await f.save(policy(modelIds), []);
      await f.prompt();
      expect(f.childRequests).toEqual([]);
      expect(f.approvals).toEqual([]);
      expect(details(f.events)[0]?.error).toContain("No authorized compatible delegation model");
    } finally { await f.close(); }
  });

  it.each([undefined, "fixture/old"])("uses fresh runPolicy and model membership on an explicit resumed Task in the same turn: model=%s", async model => {
    let f: ReturnType<typeof fixture>;
    let resumed = false;
    f = fixture({ parent: index => {
      if (index === 1) return immediate(task({ model: "fixture/old", modelReason: "Use the original text reviewer." }));
      const started = details(f.events)[0];
      const settled = f.events.some(({ event }) => event.type === "message_end" && event.message.toolName === "Task" &&
        isRecord(event.message.toolResult) && isRecord(event.message.toolResult.details) && event.message.toolResult.details.status === "completed");
      if (settled && !resumed) {
        resumed = true;
        if (typeof started?.delegationId !== "string") throw new Error("Missing initial delegation ID");
        return immediate(task({ resume: started.delegationId, ...(model === undefined ? {} : { model }) }));
      }
      return immediate(settled ? text("Resume incorporated.") : call("TaskWait", {}));
    } });
    // Save exactly after the first child's successful provider response, before
    // the parent issues resume. Admission reads the host even without a push.
    const base = transport.getMockImplementation()!;
    transport.mockImplementation((...args) => {
      const stream = base(...args);
      if (args[0].id === "old") void f.save(policy(["new"], 2));
      return stream;
    });
    try {
      await f.prompt();
      expect(f.childRequests).toEqual(["old", "new"]);
      expect(f.approvals).toHaveLength(2);
      expect(details(f.events).at(-1)).toMatchObject({ modelId: "new", runPolicy: expect.objectContaining({ maxToolCalls: 2 }), resumedFrom: expect.any(String) });
    } finally { await f.close(); }

  });

  it("preserves requested effort and selection rationale across a resumed Task", async () => {
    let resumed = false;
    const f = fixture({ parentLevel: "high", parent: index => {
      if (index === 1) return immediate(task({ model: "fixture/old", modelReason: "The existing review binding remains authoritative.", effort: "off" }));
      const first = details(f.events)[0];
      const settled = f.events.some(({ event }) => event.type === "message_end" && event.message.toolName === "Task" &&
        isRecord(event.message.toolResult) && isRecord(event.message.toolResult.details) && event.message.toolResult.details.status === "completed");
      if (settled && !resumed) {
        resumed = true;
        if (typeof first?.delegationId !== "string") throw new Error("Missing initial delegation ID");
        return immediate(task({ resume: first.delegationId }));
      }
      return immediate(settled && resumed ? text("Resume incorporated.") : call("TaskWait", {}));
    } });
    try {
      await f.prompt();
      const rows = details(f.events);
      expect(f.childRequests).toEqual(["old", "old"]);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ thinkingLevel: "off", requestedThinkingLevel: "off", scheduling: { requestedModel: "fixture/old", modelReason: "The existing review binding remains authoritative." } });
      expect(rows[1]).toMatchObject({ thinkingLevel: "off", requestedThinkingLevel: "off", resumedFrom: rows[0].delegationId, scheduling: { requestedModel: "fixture/old", modelReason: "The existing review binding remains authoritative." } });
    } finally { await f.close(); }
  });
  it.each([
    { model: undefined, accepted: true },
    { model: "", accepted: true },
    { model: "fixture/old", accepted: true },
    { model: " fixture/old ", accepted: true },
    { model: "fixture/new", accepted: false },
    { model: "other-account/old", accepted: false },
    { model: "old", accepted: false },
  ])("validates a redundant resume model without changing its binding: $model", async ({ model, accepted }) => {
    let args: ToolArgs = { model: "fixture/old", modelReason: "Use the old fixture for this check." };
    let taskPending = true;
    const f = fixture({ selectionMode: "task-fit", parent: index => {
      if (index === 1) return immediate(call("TaskModels", {}));
      if (taskPending) { taskPending = false; return immediate(task(args)); }
      return immediate(text("Check incorporated."));
    } });
    try {
      await f.prompt();
      const original = details(f.events)[0];
      if (typeof original?.delegationId !== "string") throw new Error("Missing initial delegation ID");
      args = { resume: original.delegationId, ...(model === undefined ? {} : { model }) };
      taskPending = true;
      await f.prompt();
      const result = details(f.events).at(-1);
      expect(f.childRequests).toEqual(accepted ? ["old", "old"] : ["old"]);
      expect(f.approvals).toHaveLength(accepted ? 2 : 1);
      if (accepted) {
        expect(result).toMatchObject({ resumedFrom: original.delegationId, modelId: "old" });
        expect(result?.delegationId).not.toBe(original.delegationId);
        expect(f.approvals[1]).toMatchObject({ providerId: "fixture", modelId: "old" });
        expect(f.approvals[1].requestId).not.toBe(f.approvals[0].requestId);
        const resumedRequest = transport.mock.calls.filter(([binding]) => binding.id === "old").at(-1);
        expect(JSON.stringify(resumedRequest?.[1])).toContain("old completed");
      } else {
        expect(result?.error).toContain("cannot change its model");
        expect(result?.delegationId).toBeUndefined();
      }
    } finally { await f.close(); }
  });

  it.each(["denied", "removed"] as const)("rechecks authorization for a redundant resume model: %s", async admission => {
    let resuming = false;
    let taskPending = true;
    let args: ToolArgs = { model: "fixture/old" };
    const f = fixture({ parent: () => {
      if (taskPending) { taskPending = false; return immediate(task(args)); }
      return immediate(text("Check incorporated."));
    }, authorize: async () => resuming
      ? { decision: "skip", reason: "Resume authorization revoked" }
      : { decision: "allow", reason: "Initial authorization" } });
    try {
      await f.save(policy(["old"]));
      await f.prompt();
      const original = details(f.events)[0];
      if (typeof original?.delegationId !== "string") throw new Error("Missing initial delegation ID");
      if (admission === "removed") await f.save(policy([]));
      args = { resume: original.delegationId, model: "fixture/old" };
      resuming = true;
      taskPending = true;
      await f.prompt();
      expect(f.childRequests).toEqual(["old"]);
      expect(f.approvals).toHaveLength(admission === "denied" ? 2 : 1);
      expect(details(f.events).at(-1)).toMatchObject({ code: "DELEGATION_NO_AUTHORIZED_MODEL" });
    } finally { await f.close(); }
  });

  it("refreshes a pending Task after settings save without restarting the parent", async () => {
    const entered = deferred<void>();
    const consent = deferred<DelegationApprovalDecision>();
    const f = fixture({ parent: index => immediate(index === 1 ? task({ model: "fixture/old", modelReason: "The text reviewer fits." }) : text("Checked.")), authorize: async request => {
      if (request.modelId === "old") { entered.resolve(); return consent.promise; }
      return { decision: "allow", reason: "Current automatic model" };
    } });
    try {
      const pending = f.prompt();
      await entered.promise;
      await f.save(policy(["new"], 3));
      expect(f.parentRequests).toHaveLength(1);
      consent.resolve({ decision: "allow", reason: "Old consent" });
      await pending;
      expect(f.childRequests).toEqual(["new"]);
      expect(details(f.events)[0]).toMatchObject({ runPolicy: expect.objectContaining({ maxToolCalls: 3 }) });
    } finally { consent.resolve({ decision: "cancel", reason: "Cleanup" }); await f.close(); }
  });

  it("turns a coded approval timeout into automatic fallback with no second ask in the real loop", async () => {
    const f = fixture({ parent: index => immediate(index === 1 ? task({ model: "fixture/old", modelReason: "The text reviewer fits." }) : text("Checked.")), authorize: async request => request.modelId === "old"
      ? { decision: "skip", reason: "Deadline elapsed", code: "timeout" } : { decision: "allow", reason: "Automatic policy" } });
    try {
      const settings = policy(["old", "another-ask", "new"]);
      settings.models[0].approval = "ask";
      settings.models[1].approval = "ask";
      await f.save(settings);
      await f.prompt();
      expect(f.childRequests).toEqual(["new"]);
      expect(f.approvals.map(request => [request.modelId, request.automaticOnly])).toEqual([["old", undefined], ["new", true]]);
    } finally { await f.close(); }
  });

  it.each(["require", "unavailable", "incompatible"])("starts no substitute for a %s selected target", async mode => {
    const f = fixture({ parent: index => immediate(index === 1 ? task({ model: "fixture/new", modelReason: "Use the multimodal reviewer.",
      ...(mode === "require" ? { modelSelection: "require" } : {}), ...(mode === "incompatible" ? { requiresImages: true } : {}) }) : text("No delegate started.")),
      authorize: async () => ({ decision: "allow", reason: "One exact selection", selectedModel: { providerId: "fixture", modelId: mode === "unavailable" ? "missing" : "old" } }) });
    try {
      await f.prompt();
      expect(f.childRequests).toEqual([]);
      expect(details(f.events)[0]?.error).toMatch(/selected model/i);
    } finally { await f.close(); }
  });
});
