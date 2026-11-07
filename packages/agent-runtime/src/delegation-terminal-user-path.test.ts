import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream, getCurrentTools,
  type AssistantMessage, type Models, type TextContent, type ToolCall,
} from "@earendil-works/pi-ai";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { isRecord } from "./agent-messages.js";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";

const transport = vi.hoisted(() => vi.fn<Models["streamSimple"]>());
vi.mock("./provider-binding.js", async original => {
  const actual = await original<typeof import("./provider-binding.js")>();
  return { ...actual, createProviderModels: (...args: Parameters<typeof actual.createProviderModels>) => {
    const models = actual.createProviderModels(...args);
    models.streamSimple = transport;
    return models;
  } };
});

const text = (value: string): TextContent => ({ type: "text", text: value });
const call = (id: string, name: string, args: ToolCall["arguments"] = {}): ToolCall =>
  ({ type: "toolCall", id, name, arguments: args });
const opening = "I will inspect the file and report the evidence.";
const finalReport = "Verified src/a.ts contains one exported fixture symbol.";
type Ending = "empty" | "thinking" | "length" | "empty-tool-call" | "report";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function response(model: string, content: AssistantMessage["content"], reason: "stop" | "toolUse" | "length",
  signal?: AbortSignal, gate?: Promise<void>) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant", api: "openai-completions", provider: "fixture", model,
    timestamp: Date.now(), content, stopReason: reason,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  let settled = false;
  const abort = () => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener("abort", abort);
    const aborted: AssistantMessage = { ...message, content: [], stopReason: "aborted" };
    stream.push({ type: "error", reason: "aborted", error: aborted });
    stream.end(aborted);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  queueMicrotask(async () => {
    if (gate) await gate;
    if (settled) return;
    settled = true;
    signal?.removeEventListener("abort", abort);
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason, message });
    stream.end(message);
  });
  return stream;
}

let scratchDir: string;
beforeEach(() => {
  transport.mockReset();
  scratchDir = mkdtempSync(join(tmpdir(), "delegation-terminal-path-"));
});
afterEach(() => { rmSync(scratchDir, { recursive: true, force: true }); });

/** Real parent and child loops; only model transport and Host I/O are substitutes. */
function fixture(ending: Ending, reportRecoveryAttempts = 0, recoveryDelivers = true) {
  const readStarted = deferred();
  const releaseRead = deferred();
  const events: AgentEventEnvelope[] = [];
  const tools = new Map<string, string>();
  const results = new Map<string, unknown>();
  const parentRequests: string[] = [];
  const parentToolResultText: string[] = [];
  const childRequests: Array<{ messages: string; tools: string[] }> = [];
  const executions: unknown[] = [];
  let delegationId: string | undefined;
  const provider: RuntimeProviderConfig = {
    id: "fixture", name: "Fixture", modelId: "parent", authKind: "none", apiKey: "",
    supportsReasoning: false, supportedThinkingLevels: ["off"],
  };
  transport.mockImplementation((model, context, options) => {
    if (model.id === "parent") {
      parentRequests.push(JSON.stringify(context.messages));
      parentToolResultText.push(context.messages.flatMap(message => message.role === "toolResult"
        ? message.content.flatMap(block => block.type === "text" ? [block.text] : []) : []).join("\n"));
      switch (parentRequests.length) {
        case 1: return response(model.id, [call("parent-task", "Task", {
          agent: "worker", task: "Inspect src/a.ts and provide a final evidence report.",
        })], "toolUse", options?.signal);
        case 2: return response(model.id, [call("parent-list", "TaskList")], "toolUse", options?.signal, readStarted.promise);
        case 3:
          if (!delegationId) throw new Error("Task did not publish a delegation identity");
          releaseRead.resolve();
          return response(model.id, [call("parent-wait", "TaskWait", {
            delegationIds: [delegationId],
          })], "toolUse", options?.signal);
        case 4: return response(model.id, [text("The child outcome has been incorporated.")], "stop", options?.signal);
        default: throw new Error("The child result was delivered to the parent more than once");
      }
    }
    childRequests.push({ messages: JSON.stringify(context.messages), tools: getCurrentTools(context.messages).map(tool => tool.name) });
    if (childRequests.length === 1) {
      return response(model.id, [text(opening), call("child-read", "Read", { path: "src/a.ts" })], "toolUse", options?.signal);
    }
    if (childRequests.length === 2) {
      const content = ending === "thinking" ? [{ type: "thinking" as const, thinking: "The evidence still needs a report." }]
        : ending === "report" ? [text(finalReport)] : [];
      return response(model.id, content, ending === "length" ? "length" : ending === "empty-tool-call" ? "toolUse" : "stop", options?.signal);
    }
    if (childRequests.length === 3 && reportRecoveryAttempts === 1) {
      return response(model.id, recoveryDelivers ? [text(finalReport)] : [], "stop", options?.signal);
    }
    throw new Error("Unexpected extra child provider request");
  });
  const runtime = new DesktopAgentRuntime({
    sessionId: "terminal-path", provider, mode: "agent", thinkingLevel: "off", scratchDir,
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    subagents: [{ name: "worker", description: "Inspect fixture", tools: ["Read"], prompt: "Read and report evidence.", source: "builtin" }],
    subagentProviders: { "fixture/child": { ...provider, modelId: "child" } },
    subagentModelKeys: ["fixture/child"],
    delegationAuthorization: true,
    delegationSettings: {
      version: 1, approvalTimeoutSeconds: 0,
      runPolicy: { reportRecoveryAttempts },
      models: [{ providerId: "fixture", modelId: "child", enabled: true, priority: 1, approval: "auto", description: "Fixture" }],
    },
    host: { call: async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
      if (method === "provider.delegationSnapshot" || method === "session.appendMessage") return undefined as T;
      if (method === "todos.get") return { sessionId: "terminal-path", todos: [] } as T;
      if (method === "project.instructions.resolve") return { entries: [] } as T;
      if (method === "provider.authorizeDelegation") return { decision: "allow", code: "approved", reason: "Fixture automatic policy" } as T;
      if (method === "provider.cancelDelegationApproval") return undefined as T;
      if (method === "backgroundJobs.capabilities") return { version: 1, supported: false } as T;
      if (method === "tools.execute") {
        executions.push(params);
        readStarted.resolve();
        await releaseRead.promise;
        return { ok: true, content: "export const fixture = 1;" } as T;
      }
      throw new Error(`Unexpected Host method ${method}`);
    } },
    onEvent: envelope => {
      events.push(envelope);
      if (envelope.parentToolCallId) return;
      const event = envelope.event;
      if (event.type === "tool_start") tools.set(event.toolCallId, event.toolName);
      if (event.type !== "tool_end") return;
      const name = tools.get(event.toolCallId);
      if (!name) return;
      results.set(name, event.result);
      if (name === "Task" && isRecord(event.result) && isRecord(event.result.details)
        && typeof event.result.details.delegationId === "string") delegationId = event.result.details.delegationId;
    },
  });
  return {
    runtime, events, results, parentRequests, parentToolResultText, childRequests, executions,
    run: () => runtime.prompt("Delegate the fixture review and report its outcome.", "user-message", "parent-turn"),
    close: async () => { readStarted.resolve(); releaseRead.resolve(); await runtime.abort(); await runtime.dispose(); },
  };
}

function firstDelegation(result: unknown): Record<string, unknown> {
  if (!isRecord(result) || !isRecord(result.details) || !Array.isArray(result.details.delegations)
    || !isRecord(result.details.delegations[0])) throw new Error("Missing public delegation result");
  expect(result.details.delegations).toHaveLength(1);
  return result.details.delegations[0];
}

function expectSingleDelivery(f: ReturnType<typeof fixture>) {
  expect(f.executions).toHaveLength(1);
  expect(f.childRequests[1]?.messages).toContain("export const fixture = 1;");
  expect(f.parentRequests).toHaveLength(4);
  expect(f.events.filter(({ event, parentToolCallId }) => !parentToolCallId
    && event.type === "tool_start" && event.toolName === "Task")).toHaveLength(1);
  expect(f.events.filter(({ event, parentToolCallId }) => !parentToolCallId && event.type === "agent_end")).toHaveLength(1);
  expect(f.events.filter(({ event, parentToolCallId }) => !parentToolCallId && event.type === "error")).toHaveLength(0);
  expect(f.runtime.getStatus().isRunning).toBe(false);
  expect(firstDelegation(f.results.get("TaskList"))).toMatchObject({ status: "running", turns: 1, toolCalls: 1 });
}

describe("terminal delegation delivery through Task, TaskList and TaskWait", () => {
  it.each([
    ["empty", "SUBAGENT_NO_REPORT", "missing"],
    ["thinking", "SUBAGENT_NO_REPORT", "missing"],
    ["length", "SUBAGENT_OUTPUT_TRUNCATED", "truncated"],
    ["empty-tool-call", "SUBAGENT_NO_REPORT", "invalid_tool_ending"],
  ] as const)("keeps %s termination failed while preserving prior progress", async (ending, code, outcome) => {
    const f = fixture(ending);
    try {
      await f.run();
      expectSingleDelivery(f);
      expect(f.childRequests).toHaveLength(2);
      const result = firstDelegation(f.results.get("TaskWait"));
      expect(result).toMatchObject({ status: "failed", turns: 2, toolCalls: 1,
        error: { code }, terminal: { reportOutcome: outcome, reportRecoveryAttempt: 0 } });
      expect(result.report).toContain(opening);
      expect(typeof result.checkpointPath).toBe("string");
      const checkpoint: unknown = JSON.parse(readFileSync(String(result.checkpointPath), "utf8"));
      expect(checkpoint).toMatchObject({ status: "failed", partial: true, terminal: { reportOutcome: outcome } });
    } finally { await f.close(); }
  });

  it("delivers a genuine terminal report exactly once", async () => {
    const f = fixture("report");
    try {
      await f.run();
      expectSingleDelivery(f);
      expect(f.childRequests).toHaveLength(2);
      expect(firstDelegation(f.results.get("TaskWait"))).toMatchObject({
        status: "completed", report: finalReport, terminal: { reportOutcome: "delivered", reportRecoveryAttempt: 0 },
      });
      // Structured report metadata repeats the text without delivering another message.
      expect(f.parentToolResultText[3]?.split(finalReport)).toHaveLength(2);
      const settlements = f.events.flatMap(({ event, parentToolCallId }) => !parentToolCallId
        && event.type === "message_end" && event.message.toolName === "Task"
        && isRecord(event.message.toolResult) && isRecord(event.message.toolResult.details)
        && event.message.toolResult.details.status === "completed" ? [event.message] : []);
      expect(settlements).toHaveLength(1);
      expect(settlements[0]?.toolResult).toMatchObject({ details: { report: finalReport } });
    } finally { await f.close(); }
  });

  it.each([true, false])("bounds opt-in tool-free recovery and preserves effects (delivered=%s)", async delivered => {
    const f = fixture("empty", 1, delivered);
    try {
      await f.run();
      expectSingleDelivery(f);
      expect(f.childRequests).toHaveLength(3);
      expect(f.childRequests[2]?.tools).toEqual([]);
      expect(f.childRequests[2]?.messages).toContain("export const fixture = 1;");
      expect(firstDelegation(f.results.get("TaskWait"))).toMatchObject({
        status: delivered ? "completed" : "failed", turns: 3, toolCalls: 1,
        terminal: { reportOutcome: delivered ? "delivered" : "missing", reportRecoveryAttempt: 1 },
      });
    } finally { await f.close(); }
  });
});
