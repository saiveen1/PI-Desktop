import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";

const transport = vi.hoisted(() => vi.fn<Models["streamSimple"]>());
vi.mock("./provider-binding.js", async original => {
  const actual = await original<typeof import("./provider-binding.js")>();
  return { ...actual, createProviderModels: (...args: Parameters<typeof actual.createProviderModels>) => {
    const models = actual.createProviderModels(...args); models.streamSimple = transport; return models;
  } };
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function response(content: AssistantMessage["content"], ready: Promise<void> = Promise.resolve()) {
  const stream = createAssistantMessageEventStream();
  const reason = content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
  const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
    timestamp: Date.now(), content, stopReason: reason, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  void ready.then(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason, message }); stream.end(message); });
  return stream;
}
const provider: RuntimeProviderConfig = { id: "fixture", name: "Fixture", modelId: "parent", authKind: "none", apiKey: "",
  supportsReasoning: false, supportedThinkingLevels: ["off"] };
let scratch: string;
beforeEach(() => { transport.mockReset(); scratch = mkdtempSync(join(tmpdir(), "child-chat-")); });
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });
function fixture(options: { status?: string; holdChild?: boolean; holdParent?: boolean; history?: UiMessage[]; approval?: boolean; approveSecond?: boolean; worktreeRace?: boolean } = {}) {
  const history: UiMessage[] = options.history ?? [{
    id: "task-original", role: "tool", content: "", createdAt: "2026-11-08T00:00:00.000Z",
    toolCallId: "task-original", toolName: "Task", toolArgs: { agent: "worker", task: "Inspect original scope." },
    toolStatus: "success", toolResult: { details: { delegationId: "original", agent: "worker", status: options.status ?? "failed", modelId: "fixture" } },
  }, { id: "prior-read", role: "tool", content: "", createdAt: "2026-11-08T00:00:01.000Z",
    parentToolCallId: "task-original", agentName: "worker", toolCallId: "prior-read", toolName: "Read", toolArgs: { path: "prior.ts" },
    toolStatus: "success", toolResult: { content: [{ type: "text", text: "Retained original evidence." }] } }];
  const read = deferred<unknown>(), readStarted = deferred<void>(), finished = deferred<void>();
  const authorization = deferred<unknown>(), authorizationStarted = deferred<void>();
  const parentStarted = deferred<void>(), parentGate = deferred<void>();
  const worktreeGate = deferred<void>(), firstWorktree = deferred<void>(), competingResume = deferred<boolean>();
  let worktreeCalls = 0, authorizationCalls = 0;
  const childRequests: string[] = [], parentRequests: string[] = [], tools: unknown[] = [], events: AgentEventEnvelope[] = [];
  transport.mockImplementation((model, context) => {
    if (model.id === "parent") {
      parentRequests.push(JSON.stringify(context.messages)); parentStarted.resolve();
      if (options.worktreeRace && parentRequests.length === 1) return response([{ type: "toolCall", id: "parent-resume", name: "Task",
        arguments: { agent: "worker", resume: "original", task: "Concurrent parent follow-up." } }], parentGate.promise);
      return response([{ type: "text", text: "Child result incorporated." }], options.holdParent && parentRequests.length === 1 ? parentGate.promise : undefined);
    }
    childRequests.push(JSON.stringify(context.messages));
    if (options.holdChild && childRequests.length === 1) return response([{ type: "toolCall", id: "read-current", name: "Read", arguments: { path: "current.ts" } }]);
    return response([{ type: "text", text: "Child completed the requested check." }]);
  });
  const runtime = new DesktopAgentRuntime({ sessionId: "session", provider, mode: "agent", thinkingLevel: "off", scratchDir: scratch, history,
    ...(options.worktreeRace ? { workspaceRoot: scratch } : {}),
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    subagents: [{ name: "worker", description: "Fixture", tools: options.worktreeRace ? ["Read", "Write"] : ["Read"], prompt: "Check files.", source: "builtin", model: { providerId: "fixture", modelId: "fixture" } }],
    subagentProviders: { "fixture/fixture": { ...provider, modelId: "fixture" } },
    ...(options.approval ? { delegationAuthorization: true, delegationSettings: { version: 1 as const, approvalTimeoutSeconds: 60,
      models: [{ providerId: "fixture", modelId: "fixture", enabled: true, priority: 1, approval: "auto" as const, description: "Fixture" }] } } : {}),
    host: { call: async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
      if (method === "provider.delegationSnapshot" || method === "session.appendMessage" || method === "provider.cancelDelegationApproval") return undefined as T;
      if (method === "todos.get") return { sessionId: "session", todos: [] } as T;
      if (method === "project.instructions.resolve") return { entries: [] } as T;
      if (method === "provider.authorizeDelegation") {
        authorizationStarted.resolve();
        if (options.approveSecond && ++authorizationCalls > 1) return { decision: "allow", reason: "Fixture second" } as T;
        return await authorization.promise as T;
      }
      if (method === "worktree.delegate.create") {
        firstWorktree.resolve();
        worktreeCalls++;
        await worktreeGate.promise; return {} as T;
      }
      if (method === "worktree.delegate.settle") return { settlement: { status: "kept" } } as T;
      if (method === "tools.execute") { tools.push(params); readStarted.resolve(); return await read.promise as T; }
      throw new Error(`Unexpected Host call ${method}`);
    } },
    onEvent: event => {
      events.push(event);
      if (!event.parentToolCallId && event.event.type === "tool_end" && event.event.toolCallId === "parent-resume") competingResume.resolve(event.event.isError === true);
      if (!event.parentToolCallId && event.event.type === "agent_end") finished.resolve();
    },
  });
  const send = (content: string, messageId = "input-1", turnId = "chat-turn", active = false) =>
    runtime.sendSubagentMessage({ sessionId: "session", delegationId: "original", messageId, content }, turnId, active);
  const dispose = async () => { worktreeGate.resolve(); parentGate.resolve(); authorization.resolve({ decision: "deny" }); read.resolve({ ok: true, content: "Current evidence" }); await runtime.abort(); await runtime.dispose(); };
  return { runtime, send, history, read, readStarted, finished, authorization, authorizationStarted, childRequests, parentRequests, tools, events, dispose, parentStarted, parentGate, worktreeGate, firstWorktree, competingResume, worktreeCalls: () => worktreeCalls };
}

describe("direct child conversation user path", () => {
  it.each(["completed", "failed", "stopped", "aborted", "interrupted"])("continues a %s chain with its history and the user's message", async status => {
    const f = fixture({ status });
    try {
      expect(await f.send("Check the additional edge case.")).toMatchObject({ accepted: true, delivery: "resumed" });
      await f.finished.promise;
      expect(f.childRequests).toHaveLength(1);
      expect(f.childRequests[0]).toContain("Retained original evidence.");
      expect(f.childRequests[0]).toContain("Check the additional edge case.");
      expect(f.tools).toHaveLength(0);
      expect(f.parentRequests.at(-1)).toContain("Child completed the requested check.");
      expect(f.events.filter(e => !e.parentToolCallId && e.event.type === "agent_end")).toHaveLength(1);
    } finally { await f.dispose(); }
  });

  it("steers the running child without cancelling tools or sending its conversation to the parent", async () => {
    const f = fixture({ holdChild: true });
    try {
      const started = await f.runtime.retryFailedSubagent("original", "chat-turn");
      await f.readStarted.promise;
      const sent = await f.send("Direct private child correction.");
      expect(sent).toMatchObject({ accepted: true, delivery: "steered", delegationId: started.accepted ? started.delegationId : "missing" });
      expect(f.childRequests).toHaveLength(1);
      expect(await f.send("Direct private child correction.")).toMatchObject({ accepted: true, delivery: "duplicate" });
      f.read.resolve({ ok: true, content: "Current evidence" });
      await f.finished.promise;
      expect(f.childRequests.at(-1)).toContain("Direct private child correction.");
      expect(f.parentRequests.at(-1)).not.toContain("Direct private child correction.");
      expect(f.tools).toHaveLength(1);
      expect(f.events.filter(e => e.event.type === "message_end" && e.event.message.id === "subagent-user:input-1")).toHaveLength(1);
    } finally { await f.dispose(); }
  });

  it("coalesces duplicate submissions and preserves two distinct messages during resume authorization", async () => {
    const f = fixture({ holdChild: true, approval: true });
    try {
      const first = f.send("First correction.");
      await f.authorizationStarted.promise;
      const duplicate = f.send("First correction.");
      const second = f.send("Second correction.", "input-2");
      f.authorization.resolve({ decision: "allow", reason: "Fixture" });
      const results = await Promise.all([first, duplicate, second]);
      expect(results.every(r => r.accepted)).toBe(true);
      expect(results[1]).toMatchObject({ delivery: "duplicate" });
      await f.readStarted.promise;
      f.read.resolve({ ok: true, content: "Current evidence" });
      await f.finished.promise;
      expect(f.childRequests.at(-1)).toContain("First correction.");
      expect(f.childRequests.at(-1)).toContain("Second correction.");
      expect(f.events.filter(e => e.event.type === "tool_start" && e.event.toolName === "Task" && !e.parentToolCallId)).toHaveLength(1);
    } finally { await f.dispose(); }
  });

  it("rejects stale turns and mismatched message reuse without mutating another chain", async () => {
    const f = fixture({ holdChild: true });
    try {
      await f.runtime.retryFailedSubagent("original", "chat-turn"); await f.readStarted.promise;
      await expect(f.send("Wrong turn.", "wrong", "old-turn", true)).rejects.toMatchObject({ errorCode: "TURN_NOT_FOUND" });
      await f.send("Original content.");
      await expect(f.send("Changed content.")).rejects.toMatchObject({ errorCode: "INVALID_ARGUMENT" });
      await expect(f.runtime.sendSubagentMessage({ sessionId: "other", delegationId: "original", messageId: "new", content: "No" }, "chat-turn", true))
        .rejects.toMatchObject({ errorCode: "INVALID_ARGUMENT" });
      expect(f.childRequests).toHaveLength(1);
    } finally { await f.dispose(); }
  });

  it("keeps accepted input in child history when Stop races its delivery boundary", async () => {
    const f = fixture({ holdChild: true });
    try {
      await f.runtime.retryFailedSubagent("original", "chat-turn"); await f.readStarted.promise;
      await f.send("Retain this correction.");
      await f.runtime.abort();
      expect(f.childRequests).toHaveLength(1);
      await f.send("Continue after Stop.", "input-2", "next-turn");
      // A new child request sees both retained accepted input and the new prompt.
      expect(f.childRequests.at(-1)).toContain("Retain this correction.");
      expect(f.childRequests.at(-1)).toContain("Continue after Stop.");
    } finally { await f.dispose(); }
  });

  it("restores accepted message receipts and retains follow-up prompts across another resume", async () => {
    const f = fixture({ status: "completed" });
    const saved = new Map(f.history.map(row => [row.id, row]));
    try {
      await f.send("First retained follow-up."); await f.finished.promise;
      for (const { event } of f.events) if (event.type === "message_end") saved.set(event.message.id, event.message);
    } finally { await f.dispose(); }
    const restored = fixture({ history: [...saved.values()] });
    try {
      expect(await restored.send("First retained follow-up.")).toMatchObject({ accepted: true, delivery: "duplicate" });
      await restored.finished.promise;
      expect(restored.childRequests).toHaveLength(0);
      await restored.send("Second retained follow-up.", "input-2", "next-turn");
      expect(restored.childRequests[0]).toContain("First retained follow-up.");
      expect(restored.childRequests[0]).toContain("Second retained follow-up.");
    } finally { await restored.dispose(); }
  });

  it("can retry a restored rejected message because it never admitted a worker", async () => {
    const seed = fixture();
    const history = [...seed.history, { id: "subagent-message:input-1", role: "tool" as const, content: "", createdAt: "2026-11-08T00:00:02.000Z",
      toolCallId: "subagent-message:input-1", toolName: "Task", toolStatus: "error" as const,
      toolArgs: { agent: "worker", resume: "original", task: "Try after denied authorization." },
      toolResult: { details: { error: "Model authorization denied" } } }];
    await seed.dispose();
    const f = fixture({ history });
    try {
      expect(await f.send("Try after denied authorization.")).toMatchObject({ accepted: true, delivery: "resumed" });
      await f.finished.promise;
      expect(f.childRequests).toHaveLength(1);
    } finally { await f.dispose(); }
  });
});

it("joins a normal streaming parent turn and delivers child results before that turn ends", async () => {
  const f = fixture({ status: "completed", holdParent: true, holdChild: true });
  const running = f.runtime.prompt("Parent task remains active.", "parent-user", "chat-turn");
  try {
    await f.parentStarted.promise;
    expect(await f.send("Child follow-up during parent work.", "input-1", "chat-turn", true)).toMatchObject({ accepted: true, delivery: "resumed" });
    await f.readStarted.promise;
    expect(f.events.filter(e => !e.parentToolCallId && e.event.type === "agent_end")).toHaveLength(0);
    f.parentGate.resolve();
    f.read.resolve({ ok: true, content: "Current evidence" });
    await running;
    expect(f.parentRequests.at(-1)).toContain("Parent task remains active.");
    expect(f.parentRequests.at(-1)).toContain("Child completed the requested check.");
    expect(f.events.filter(e => !e.parentToolCallId && e.event.type === "agent_end")).toHaveLength(1);
    expect(f.runtime.getStatus().isRunning).toBe(false);
  } finally { await f.dispose(); await running; }
});

it("admits one writable worker when direct input and parent resume race across worktree creation", async () => {
  const f = fixture({ worktreeRace: true, holdChild: true });
  const running = f.runtime.prompt("Parent remains active.", "parent-user", "chat-turn");
  let sending: ReturnType<typeof f.send> | undefined;
  try {
    await f.parentStarted.promise;
    sending = f.send("Direct follow-up.");
    await f.firstWorktree.promise;
    f.parentGate.resolve();
    // The same chain is reserved while the first create is still outstanding.
    expect(await f.competingResume.promise).toBe(true);
    expect(f.worktreeCalls()).toBe(1);
    f.worktreeGate.resolve();
    await sending;
    await f.readStarted.promise;
    f.read.resolve({ ok: true, content: "Current evidence" });
    await running;
    const starts = f.events.filter(e => e.event.type === "tool_end" && !e.parentToolCallId &&
      e.event.result && typeof e.event.result === "object" && "details" in e.event.result &&
      e.event.result.details && typeof e.event.result.details === "object" && "delegationId" in e.event.result.details);
    expect(starts).toHaveLength(1);
  } finally { await f.dispose(); await Promise.allSettled([running, ...(sending ? [sending] : [])]); }
});

it("delivers an admitted sibling report even if the first idle message authorization is denied", async () => {
  const seed = fixture();
  const history = [...seed.history, ...seed.history.map(row => row.role === "tool" && row.toolName === "Task"
    ? { ...row, id: "task-sibling", toolCallId: "task-sibling", toolResult: { details: { delegationId: "sibling", agent: "worker", status: "failed", modelId: "fixture" } } }
    : { ...row, id: "sibling-read", toolCallId: "sibling-read", parentToolCallId: "task-sibling" })];
  await seed.dispose();
  const f = fixture({ history, approval: true, approveSecond: true, holdChild: true });
  const first = f.send("First authorization denied.");
  try {
    await f.authorizationStarted.promise;
    const sibling = await f.runtime.sendSubagentMessage({ sessionId: "session", delegationId: "sibling", messageId: "sibling-input", content: "Sibling accepted." }, "chat-turn", true);
    expect(sibling.accepted).toBe(true);
    await f.readStarted.promise;
    f.authorization.resolve({ decision: "deny", reason: "Fixture first" });
    expect((await first).accepted).toBe(false);
    f.read.resolve({ ok: true, content: "Current evidence" });
    await f.finished.promise;
    expect(f.parentRequests.at(-1)).toContain("Child completed the requested check.");
    expect(f.events.filter(e => !e.parentToolCallId && e.event.type === "agent_end")).toHaveLength(1);
  } finally { await f.dispose(); await first; }
});
