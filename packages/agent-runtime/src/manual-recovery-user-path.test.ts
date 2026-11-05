import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import { isRecord } from "./agent-messages.js";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";

const transport = vi.hoisted(() => vi.fn<Models["streamSimple"]>());
vi.mock("./provider-binding.js", async (original) => {
  const actual = await original<typeof import("./provider-binding.js")>();
  return { ...actual, createProviderModels: (...args: Parameters<typeof actual.createProviderModels>) => {
    const models = actual.createProviderModels(...args);
    models.streamSimple = transport;
    return models;
  } };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function response(content: AssistantMessage["content"], failed = false) {
  const stream = createAssistantMessageEventStream();
  const reason = failed ? "error" : content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
  const message: AssistantMessage = {
    role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
    timestamp: Date.now(), content, stopReason: reason,
    ...(failed ? { errorMessage: "Invalid API key" } : {}),
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    if (failed) stream.push({ type: "error", reason: "error", error: message });
    else stream.push({ type: "done", reason: reason === "toolUse" ? "toolUse" : "stop", message });
    stream.end(message);
  });
  return stream;
}
const provider: RuntimeProviderConfig = {
  id: "fixture", name: "Fixture", modelId: "parent", authKind: "none", apiKey: "",
  supportsReasoning: false, supportedThinkingLevels: ["off"],
};
let scratchDir: string;
beforeEach(() => { transport.mockReset(); scratchDir = mkdtempSync(join(tmpdir(), "manual-recovery-")); });
afterEach(() => { rmSync(scratchDir, { recursive: true, force: true }); });

function fixture(options: {
  early?: boolean;
  childFailure?: boolean;
  parentFailure?: boolean;
  parentSilent?: boolean;
  steerOnSettlement?: boolean;
  approval?: "deny" | "pending";
} = {}) {
  const history: UiMessage[] = [{
    id: "task-original", role: "tool", content: "", createdAt: "2026-11-04T00:00:00.000Z",
    toolCallId: "task-original", toolName: "Task", toolArgs: { agent: "worker", task: "Verify A and B." },
    toolStatus: "error", toolResult: { details: { delegationId: "original", agent: "worker", status: "failed", modelId: "fixture" } },
  }, {
    id: "read-original", role: "tool", content: "", createdAt: "2026-11-04T00:00:01.000Z",
    parentToolCallId: "task-original", agentName: "worker", toolCallId: "read-a", toolName: "Read",
    toolArgs: { path: "a.ts" }, toolStatus: "success",
    toolResult: { content: [{ type: "text", text: "Exact retained evidence from a.ts." }] },
  }];
  const read = deferred<unknown>();
  const readStarted = deferred<void>();
  const handled = deferred<void>();
  const recovered = deferred<void>();
  const finished = deferred<void>();
  const approvalStarted = deferred<void>();
  const approval = deferred<unknown>();
  const events: AgentEventEnvelope[] = [];
  const parentRequests: string[] = [];
  const childRequests: string[] = [];
  const executions: unknown[] = [];
  let steeredOnSettlement = false;
  transport.mockImplementation((model, context) => {
    if (model.id === "parent") {
      parentRequests.push(JSON.stringify(context.messages));
      if (parentRequests.length === 2) recovered.resolve();
      if (options.parentSilent && parentRequests.length === 1) return response([]);
      return response([{ type: "text", text: parentRequests.length === 1 ? "Correction handled." : "Child result incorporated." }], options.parentFailure);
    }
    childRequests.push(JSON.stringify(context.messages));
    return response(childRequests.length === 1 && !options.early
      ? [{ type: "toolCall", id: "read-b", name: "Read", arguments: { path: "b.ts" } }]
      : [{ type: "text", text: "B verified; unique child result." }],
    options.childFailure && childRequests.length > 1);
  });
  const steer = () => runtime.steer({ text: "Handle this correction now." }, "manual-turn", {
    id: "correction", role: "user", content: "Handle this correction now.",
    createdAt: "2026-11-05T00:00:00.000Z", steering: true,
  });
  const runtime = new DesktopAgentRuntime({
    sessionId: "session", provider, mode: "agent", thinkingLevel: "off", scratchDir, history,
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    subagents: [{ name: "worker", description: "Fixture", tools: ["Read"], prompt: "Check files.", source: "builtin", model: { providerId: "fixture", modelId: "fixture" } }],
    subagentProviders: { "fixture/fixture": { ...provider, modelId: "fixture" } },
    ...(options.approval ? { delegationAuthorization: true, delegationSettings: {
      version: 1 as const, approvalTimeoutSeconds: 60,
      models: [{ providerId: "fixture", modelId: "fixture", enabled: true, priority: 1, approval: "auto" as const, description: "Fixture" }],
    } } : {}),
    host: { call: async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "provider.authorizeDelegation") {
        approvalStarted.resolve();
        return options.approval === "pending" ? await approval.promise as T : { decision: "deny", reason: "Fixture rejection" } as T;
      }
      if (method === "provider.cancelDelegationApproval") return undefined as T;
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
      if (method === "project.instructions.resolve") return { entries: [] } as T;
      if (method === "tools.execute") { executions.push(params); readStarted.resolve(); return await read.promise as T; }
      if (method === "session.appendMessage") return undefined as T;
      throw new Error(`Unexpected host call ${method}`);
    } },
    onEvent: (envelope) => {
      events.push(envelope);
      const event = envelope.event;
      if (!envelope.parentToolCallId && event.type === "message_end" && event.message.content === "Correction handled.") handled.resolve();
      if (!envelope.parentToolCallId && event.type === "agent_end") finished.resolve();
      if (options.steerOnSettlement && !steeredOnSettlement && event.type === "message_end" && event.message.toolName === "Task") {
        const result = event.message.toolResult;
        if (isRecord(result) && isRecord(result.details) && result.details.status === "completed") {
          steeredOnSettlement = true;
          steer();
        }
      }
    },
  });
  const terminalEvents = (type: "agent_start" | "turn_end" | "agent_end") =>
    events.filter(envelope => !envelope.parentToolCallId && envelope.turnId === "manual-turn" && envelope.event.type === type);
  return { runtime, steer, read, readStarted, handled, recovered, finished, approvalStarted, approval, events, parentRequests, childRequests, executions, terminalEvents };
}

describe("manual child recovery user path", () => {
  it("handles steering once while the resumed child runs, then incorporates its result and finalizes once", async () => {
    const f = fixture();
    try {
      expect(await f.runtime.retryFailedSubagent("original", "manual-turn")).toMatchObject({ accepted: true, resumedFrom: "original" });
      await f.readStarted.promise;
      expect(f.childRequests[0]).toContain("Exact retained evidence from a.ts");
      expect(f.childRequests[0]).toContain("Verify A and B");
      expect(f.parentRequests).toEqual([]);
      expect(f.steer()).toEqual({ accepted: true, turnId: "manual-turn" });
      await f.handled.promise;
      expect(f.parentRequests).toHaveLength(1);
      expect(f.parentRequests[0].match(/Handle this correction now\./g)).toHaveLength(1);
      expect(f.runtime.getStatus().isRunning).toBe(true);
      expect(f.childRequests).toHaveLength(1);
      expect(f.terminalEvents("agent_end")).toHaveLength(0);
      f.read.resolve({ ok: true, content: "B evidence" });
      await f.finished.promise;
      expect(f.parentRequests).toHaveLength(2);
      expect(f.parentRequests[1].match(/B verified; unique child result\./g)).toHaveLength(1);
      expect(f.executions).toHaveLength(1);
      expect(JSON.stringify(f.executions)).not.toContain('"path":"a.ts"');
      expect(f.childRequests).toHaveLength(2);
      expect(f.terminalEvents("agent_start")).toHaveLength(1);
      expect(f.terminalEvents("turn_end")).toHaveLength(1);
      expect(f.terminalEvents("agent_end")).toHaveLength(1);
      expect(f.runtime.getStatus().isRunning).toBe(false);
    } finally { f.read.resolve({ ok: true }); await f.runtime.abort(); await f.runtime.dispose(); }
  });

  it("retains steering admitted during child settlement and consumes the result once", async () => {
    const f = fixture({ steerOnSettlement: true });
    try {
      await f.runtime.retryFailedSubagent("original", "manual-turn");
      await f.readStarted.promise;
      f.read.resolve({ ok: true, content: "B evidence" });
      await f.finished.promise;
      expect(f.parentRequests[0]).toContain("Handle this correction now.");
      expect(f.parentRequests.at(-1)).toContain("B verified; unique child result.");
      expect(f.events.filter(({ event, parentToolCallId }) => !parentToolCallId && event.type === "message_end" && event.message.id === "correction")).toHaveLength(1);
      expect(f.terminalEvents("turn_end")).toHaveLength(1);
      expect(f.terminalEvents("agent_end")).toHaveLength(1);
    } finally { f.read.resolve({ ok: true }); await f.runtime.abort(); await f.runtime.dispose(); }
  });

  it("recovers a silent parent response without closing the retried child or duplicating terminal events", async () => {
    const f = fixture({ parentSilent: true });
    try {
      await f.runtime.retryFailedSubagent("original", "manual-turn");
      await f.readStarted.promise;
      f.steer();
      // The recovery request is a real second parent request on the same Agent.
      await f.recovered.promise;
      expect(f.runtime.getStatus().isRunning).toBe(true);
      expect(f.childRequests).toHaveLength(1);
      expect(f.terminalEvents("agent_end")).toHaveLength(0);
      f.read.resolve({ ok: true, content: "B evidence" });
      await f.finished.promise;
      expect(f.parentRequests).toHaveLength(3);
      expect(f.parentRequests.at(-1)).toContain("B verified; unique child result.");
      expect(f.terminalEvents("turn_end")).toHaveLength(1);
      expect(f.terminalEvents("agent_end")).toHaveLength(1);
    } finally { f.read.resolve({ ok: true }); await f.runtime.abort(); await f.runtime.dispose(); }
  });

  it.each([false, true])("continues after child settlement, including early=%s", async early => {
    const f = fixture({ early });
    try {
      expect(await f.runtime.retryFailedSubagent("original", "manual-turn")).toMatchObject({ accepted: true });
      if (!early) { await f.readStarted.promise; f.read.resolve({ ok: true, content: "B evidence" }); }
      await f.finished.promise;
      expect(f.parentRequests).toHaveLength(1);
      expect(f.parentRequests[0]).toContain("B verified; unique child result.");
      expect(f.terminalEvents("agent_start")).toHaveLength(1);
      expect(f.terminalEvents("turn_end")).toHaveLength(1);
      expect(f.terminalEvents("agent_end")).toHaveLength(1);
      expect(f.runtime.getStatus().isRunning).toBe(false);
    } finally { f.read.resolve({ ok: true }); await f.runtime.abort(); await f.runtime.dispose(); }
  });

  it("delivers child failure to the parent and releases the session", async () => {
    const f = fixture({ childFailure: true });
    try {
      await f.runtime.retryFailedSubagent("original", "manual-turn");
      await f.readStarted.promise;
      f.read.resolve({ ok: true, content: "B evidence" });
      await f.finished.promise;
      expect(f.parentRequests).toHaveLength(1);
      expect(f.parentRequests[0]).toContain("failed");
      expect(f.terminalEvents("agent_end")).toHaveLength(1);
      expect(f.runtime.getStatus().isRunning).toBe(false);
    } finally { f.read.resolve({ ok: true }); await f.runtime.abort(); await f.runtime.dispose(); }
  });

  it("Stop cancels the child and releases the turn without prompting the parent", async () => {
    const f = fixture();
    try {
      await f.runtime.retryFailedSubagent("original", "manual-turn");
      await f.readStarted.promise;
      await f.runtime.abort();
      expect(f.parentRequests).toEqual([]);
      expect(f.runtime.getStatus().isRunning).toBe(false);
      expect(f.terminalEvents("turn_end")).toHaveLength(1);
      expect(f.terminalEvents("agent_end")).toHaveLength(1);
    } finally { f.read.resolve({ ok: true }); await f.runtime.dispose(); }
  });

  it("retains accepted input on Stop and admits the next user turn without replaying queued steering", async () => {
    const f = fixture();
    try {
      await f.runtime.retryFailedSubagent("original", "manual-turn");
      await f.readStarted.promise;
      f.steer();
      await f.runtime.abort();
      expect(f.parentRequests).toEqual([]);
      expect(() => f.steer()).toThrow("no longer accepting input");
      await f.runtime.prompt("Continue after cancellation.", "follow-up", "follow-up-turn");
      expect(f.parentRequests).toHaveLength(1);
      expect(f.parentRequests[0].match(/Handle this correction now\./g)).toHaveLength(1);
      expect(f.parentRequests[0]).toContain("Continue after cancellation.");
      expect(f.childRequests).toHaveLength(1);
      expect(f.terminalEvents("agent_end")).toHaveLength(1);
      expect(f.runtime.getStatus().isRunning).toBe(false);
    } finally { f.read.resolve({ ok: true }); await f.runtime.abort(); await f.runtime.dispose(); }
  });

  it("releases a rejected manual retry without starting either Agent", async () => {
    const f = fixture({ approval: "deny" });
    try {
      expect(await f.runtime.retryFailedSubagent("original", "manual-turn")).toMatchObject({ accepted: false });
      await f.finished.promise;
      expect(f.parentRequests).toEqual([]);
      expect(f.childRequests).toEqual([]);
      expect(f.runtime.getStatus().isRunning).toBe(false);
      expect(f.terminalEvents("agent_end")).toHaveLength(1);
    } finally { await f.runtime.abort(); await f.runtime.dispose(); }
  });

  it("Stop during retry authorization joins cleanup and never starts a child", async () => {
    const f = fixture({ approval: "pending" });
    const starting = f.runtime.retryFailedSubagent("original", "manual-turn");
    try {
      await f.approvalStarted.promise;
      await f.runtime.abort();
      expect(await starting).toMatchObject({ accepted: false });
      expect(f.parentRequests).toEqual([]);
      expect(f.childRequests).toEqual([]);
      expect(f.runtime.getStatus().isRunning).toBe(false);
      expect(f.terminalEvents("turn_end")).toHaveLength(1);
      expect(f.terminalEvents("agent_end")).toHaveLength(1);
    } finally {
      f.approval.resolve({ decision: "allow", reason: "Late fixture approval" });
      await starting;
      await f.runtime.abort();
      await f.runtime.dispose();
    }
  });

  it("a fatal parent response during steering retires the child and closes once", async () => {
    const f = fixture({ parentFailure: true });
    try {
      await f.runtime.retryFailedSubagent("original", "manual-turn");
      await f.readStarted.promise;
      f.steer();
      await f.finished.promise;
      await f.runtime.abort();
      expect(f.parentRequests).toHaveLength(1);
      expect(f.childRequests).toHaveLength(1);
      expect(f.terminalEvents("turn_end")).toHaveLength(1);
      expect(f.terminalEvents("agent_end")).toHaveLength(1);
      expect(f.runtime.getStatus().isRunning).toBe(false);
    } finally { f.read.resolve({ ok: true }); await f.runtime.abort(); await f.runtime.dispose(); }
  });
});
