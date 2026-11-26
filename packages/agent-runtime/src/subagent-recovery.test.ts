import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentTools, createAssistantMessageEventStream, type AssistantMessage, type Models, type TextContent, type ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { SubagentRun, type SubagentRunOptions } from "./subagent.js";
import { readSubagentCheckpoint } from "./subagent-checkpoint.js";
import { DesktopAgentRuntime, type AgentRuntimeOptions } from "./runtime.js";
import { isRecord } from "./agent-messages.js";
import type { UiMessage } from "@pi-desktop/shared";

const transport = vi.hoisted(() => vi.fn<Models["streamSimple"]>());
vi.mock("./provider-binding.js", async (original) => {
  const actual = await original<typeof import("./provider-binding.js")>();
  return { ...actual, createProviderModels: (...args: Parameters<typeof actual.createProviderModels>) => {
    const models = actual.createProviderModels(...args);
    models.streamSimple = transport;
    return models;
  } };
});

function response(content: AssistantMessage["content"], stopReason: "stop" | "toolUse" | "length" = "stop") {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", timestamp: Date.now(),
    stopReason, content, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: stopReason, message }); stream.end(message); });
  return stream;
}
const text = (value: string): TextContent => ({ type: "text", text: value });
const call = (id: string, name = "Read", args: ToolCall["arguments"] = {}): ToolCall => ({ type: "toolCall", id, name, arguments: args });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
let scratchDir: string;
beforeEach(() => { transport.mockReset(); scratchDir = mkdtempSync(join(tmpdir(), "delegate-recovery-")); });
afterEach(() => { vi.useRealTimers(); rmSync(scratchDir, { recursive: true, force: true }); });
const checkpointPath = () => join(scratchDir, "delegations", "chain", "checkpoint.json");
function fixture(execute: AgentTool["execute"], extra: Partial<SubagentRunOptions> = {}) {
  return new SubagentRun({
    definition: { name: "worker", description: "Fixture", tools: ["Read"], prompt: "Report findings.", source: "builtin" },
    sessionId: "session", delegationId: "run", delegateSessionId: "chain", parentToolCallId: "task",
    scratchDir, task: "Check two files.", thinkingLevel: "off", systemPrompt: "Check two files and report.",
    provider: { id: "fixture", name: "Fixture", apiKey: "", authKind: "none", modelId: "fixture", supportsReasoning: false, supportedThinkingLevels: ["off"] },
    tools: [{ name: "Read", label: "Read", description: "Read fixture", parameters: Type.Object({}), execute }],
    onEvent: () => undefined, ...extra,
  });
}

// These cases drive the real subagent loop through 130 tool calls and budget
// deadlines. Vitest's default 5 s per-test limit is shorter than that work under
// a loaded machine (for example the full suite), where they timed out while
// passing in isolation. Declare a budget consistent with the loop they run.
describe("subagent recovery through the real loop", { timeout: 60_000 }, () => {
  it.each([
    { name: "empty stop", content: [], stopReason: "stop", code: "SUBAGENT_NO_REPORT" },
    { name: "thinking-only stop", content: [{ type: "thinking", thinking: "Unpublished reasoning." }], stopReason: "stop", code: "SUBAGENT_NO_REPORT" },
    { name: "empty length", content: [], stopReason: "length", code: "SUBAGENT_OUTPUT_TRUNCATED" },
    { name: "empty tool ending", content: [], stopReason: "toolUse", code: "SUBAGENT_NO_REPORT" },
  ] satisfies Array<{ name: string; content: AssistantMessage["content"]; stopReason: "stop" | "toolUse" | "length"; code: string }>)(
    "does not deliver retained progress after $name", async ({ content, stopReason, code }) => {
      let requests = 0;
      const execute = vi.fn(async () => ({ content: [text("A evidence")], details: {} }));
      transport.mockImplementation((_model, context) => {
        if (++requests === 1) return response([text("Confirmed A at src/a.ts:12; still checking."), call("read-a")], "toolUse");
        expect(context.messages.some(message => message.role === "toolResult" && message.toolCallId === "read-a")).toBe(true);
        return response(content, stopReason);
      });

      const result = await fixture(execute).run();

      expect(result).toMatchObject({ status: "failed", partial: true, error: { code } });
      expect(result.report).toContain("Confirmed A");
      expect(result.outputTruncated).toBe(stopReason === "length" ? true : undefined);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(requests).toBe(2);
      expect(JSON.parse(readFileSync(result.checkpointPath!, "utf8"))).toMatchObject({
        status: "failed", partial: true, report: expect.stringContaining("Confirmed A"),
      });
    },
  );

  it("delivers a new terminal report instead of tool preamble", async () => {
    let requests = 0;
    const execute = vi.fn(async () => ({ content: [text("A evidence")], details: {} }));
    transport.mockImplementation(() => ++requests === 1
      ? response([text("I will start inspecting."), call("read-a")], "toolUse")
      : response([text("Confirmed src/a.ts:12 is missing its null check.")]));

    const result = await fixture(execute).run();

    expect(result).toMatchObject({ status: "completed", report: "Confirmed src/a.ts:12 is missing its null check." });
    expect(result.partial).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests).toBe(2);
  });

  it("saves findings while a tool is running and retains them after cancellation", async () => {
    const controller = new AbortController();
    const entered = deferred();
    transport.mockImplementation(() => response([text("Confirmed A at src/a.ts:12; B remains unchecked."), call("read-a")], "toolUse"));
    const run = fixture(async (_id, _args, signal) => {
      entered.resolve();
      await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return { content: [text("interrupted")], details: {} };
    }, { signal: controller.signal });
    const running = run.run();
    try {
      await entered.promise;
      expect(existsSync(checkpointPath())).toBe(true);
      expect(JSON.parse(readFileSync(checkpointPath(), "utf8"))).toMatchObject({ status: "running", report: expect.stringContaining("Confirmed A") });
      controller.abort();
      const result = await running;
      expect(result.status).toBe("aborted");
      expect(result.report).toContain("Confirmed A");
      expect(readFileSync(result.checkpointPath!, "utf8")).toContain("B remains unchecked");
      expect(transport).toHaveBeenCalledTimes(1);
    } finally { controller.abort(); await running; }
  });

  it.each(["failed", "aborted"] as const)("retains a write-scoped child's report on disk when %s", async status => {
    const location = { scratchDir, sessionId: "session", agentName: "worker", delegateSessionId: "chain", parentToolCallId: "task" };
    const report = "Checked the first file; the second is still pending.";
    const forbidden = join(scratchDir, "not-a-report.md");
    const controller = new AbortController();
    let runningCheckpoint: ReturnType<typeof readSubagentCheckpoint> | undefined;
    let rejectedWrite = false;
    transport.mockImplementationOnce(() => response([
      call("progress", "TaskReport", { report, path: forbidden }),
      call("outside", "Write", { path: forbidden, content: "must not be written" }),
    ], "toolUse")).mockImplementationOnce((_model, context) => {
      runningCheckpoint = readSubagentCheckpoint(location);
      rejectedWrite = context.messages.some(m => m.role === "toolResult" && m.toolCallId === "outside" && m.isError);
      if (status === "aborted") controller.abort();
      return response([]);
    });

    const result = await fixture(async () => { throw new Error("Unexpected work tool"); }, {
      writeScope: status === "aborted" ? [] : ["allowed/"], signal: controller.signal,
    }).run();
    expect(runningCheckpoint?.checkpoint).toMatchObject({ status: "running", partial: true, report: expect.stringContaining(report) });
    expect(result).toMatchObject({ status, partial: true, checkpointPath: checkpointPath(),
      scratchReportPath: join(scratchDir, "delegations", "chain", "report.md") });
    const restored = readSubagentCheckpoint(location);
    expect(restored.checkpoint).toMatchObject({ sessionId: "session", delegateSessionId: "chain", delegationId: "run",
      task: "Check two files.", status, partial: true, report: expect.stringContaining(report) });
    expect(readFileSync(result.scratchReportPath!, "utf8")).toBe(restored.checkpoint?.report);
    expect(readSubagentCheckpoint({ ...location, sessionId: "other" })).toEqual({ error: "checkpoint-identity-mismatch" });
    expect(rejectedWrite).toBe(true);
    expect(existsSync(forbidden)).toBe(false);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each(["TaskWait", "Task"] as const)("recovers a scoped child's findings on cold %s without replaying its tools", async command => {
    const task = { agent: "worker", task: "Check the first file.", scope: { write: [] } };
    const report = "Verified the first file; remaining work is incomplete.";
    const forbidden = join(scratchDir, "forbidden.md");
    const receipts: UiMessage[] = [];
    const executions: unknown[] = [];
    const waits: unknown[] = [];
    let id = "";
    const options: AgentRuntimeOptions = {
      sessionId: "session", scratchDir, mode: "agent", thinkingLevel: "off",
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      provider: { id: "fixture", name: "Fixture", modelId: "fixture", authKind: "none", apiKey: "", supportsReasoning: false, supportedThinkingLevels: ["off"] },
      subagents: [{ name: "worker", description: "Fixture", source: "builtin", prompt: "Check files.", tools: ["Read", "Write"] }],
      host: { call: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "tools.execute") { executions.push(params); return { ok: true, content: "First file evidence." } as T; }
        if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
        if (method === "todos.get") return { sessionId: "session", todos: [] } as T;
        if (method === "project.instructions.resolve") return { entries: [] } as T;
        if (method === "provider.delegationSnapshot" || method === "session.appendMessage") return undefined as T;
        throw new Error(`Unexpected host call ${method}`);
      } },
      onEvent: ({ event, ts }) => {
        if (event.type !== "tool_end" || !isRecord(event.result) || !isRecord(event.result.details)) return;
        if (event.toolCallId === "launch" && typeof event.result.details.delegationId === "string") {
          id = event.result.details.delegationId;
          receipts.push({ id: "launch", role: "tool", content: "", toolName: "Task", toolCallId: "launch",
            toolArgs: task, toolResult: structuredClone(event.result), toolStatus: "success", createdAt: new Date(ts).toISOString() });
        }
        if (event.toolCallId === "recover") waits.push(event.result.details.delegations);
      },
    };
    let parentRequests = 0, childRequests = 0;
    transport.mockImplementation((_model, context) => {
      if (getCurrentTools(context.messages).some(t => t.name === "TaskReport")) {
        if (++childRequests === 1) return response([call("read", "Read", { path: "first.md" })], "toolUse");
        if (childRequests === 2) return response([call("findings", "TaskReport", { report }),
          call("forbidden", "Write", { path: forbidden, content: "denied" })], "toolUse");
        return response([]); // An empty terminal response cannot promote the findings to a final report.
      }
      if (++parentRequests === 1) return response([call("launch", "Task", task)], "toolUse");
      if (parentRequests === 2) return response([call("wait", "TaskWait", { delegationIds: [id] })], "toolUse");
      return response([text("Done.")]);
    });
    const live = new DesktopAgentRuntime(options);
    try { await live.prompt("Delegate the check."); } finally { await live.dispose(); }
    expect(receipts).toHaveLength(1);
    expect(executions).toEqual([expect.objectContaining({ toolName: "Read" })]);
    expect(childRequests).toBe(3);
    expect(existsSync(forbidden)).toBe(false);
    expect(JSON.stringify(receipts)).not.toContain(report);

    // Restart with just the persisted launch receipt, before any report reached the parent journal.
    const resumed: string[] = [];
    let coldParentRequests = 0;
    transport.mockReset().mockImplementation((_model, context) => {
      if (getCurrentTools(context.messages).some(t => t.name === "TaskReport")) {
        resumed.push(JSON.stringify(context.messages));
        return response([text("Finished the remaining work.")]);
      }
      if (++coldParentRequests === 1) return response([call("recover", command, command === "TaskWait"
        ? { delegationIds: [id] } : { agent: task.agent, task: "Finish remaining work.", resume: id })], "toolUse");
      if (command === "Task" && coldParentRequests === 2) return response([call("join", "TaskWait", {})], "toolUse");
      return response([text("Result received.")]);
    });
    const cold = new DesktopAgentRuntime({ ...options, history: receipts });
    try { await cold.prompt("Recover the partial result."); } finally { await cold.dispose(); }
    if (command === "TaskWait") {
      expect(resumed).toEqual([]);
      expect(waits).toEqual([[expect.objectContaining({ delegationId: id, agent: "worker", status: "interrupted", partial: true,
        report: expect.stringContaining(report) })]]);
    } else {
      expect(resumed).toHaveLength(1);
      expect(resumed[0]).toContain(task.task);
      expect(resumed[0]).toContain(report);
      expect(readSubagentCheckpoint({ scratchDir, sessionId: "session", agentName: task.agent, delegateSessionId: id,
        parentToolCallId: "launch" }).checkpoint).toMatchObject({ status: "completed", report: "Finished the remaining work." });
    }
    expect(executions).toHaveLength(1);
  });

  it("finishes the admitted tool then requests one report-only turn at the call budget", async () => {
    const executed: string[] = [];
    let requests = 0;
    transport.mockImplementation((_model, context) => {
      if (++requests === 1) return response([call("read-a"), call("read-b")], "toolUse");
      expect(getCurrentTools(context.messages)).toHaveLength(0);
      return response([text("Partial report: A checked; B remains.")]);
    });
    const run = fixture(async id => { executed.push(id); return { content: [text("A evidence")], details: {} }; }, { runPolicy: { maxToolCalls: 1 } });
    const result = await run.run();
    expect(executed).toEqual(["read-a"]);
    expect(requests).toBe(2);
    expect(result).toMatchObject({ status: "failed", error: { code: "SUBAGENT_BUDGET_EXHAUSTED" } });
    expect(result.report).toContain("A checked; B remains");
    expect(JSON.parse(readFileSync(result.checkpointPath!, "utf8"))).toMatchObject({ partial: true, terminationReason: "budget_exhausted" });
  });

  it("accepts an optional summary without restricting the work tools", async () => {
    let requests = 0;
    const executed: string[] = [];
    const declared: string[][] = [];
    transport.mockImplementation((_model, context) => {
      declared.push(getCurrentTools(context.messages).map(tool => tool.name));
      switch (++requests) {
        case 1: return response(Array.from({ length: 12 }, (_, index) => call(`read-${index}`)), "toolUse");
        case 2:
          return response([call("report-1", "TaskReport", { report: "A is confirmed. Next check B; no writes performed." })], "toolUse");
        case 3:
          return response([call("read-b")], "toolUse");
        default: return response([text("A and B checked.")]);
      }
    });
    const toolErrors: unknown[] = [];
    const result = await fixture(async id => { executed.push(id); return { content: [text("evidence")], details: {} }; }, { onEvent: ({event}) => { if (event.type === "tool_end" && event.isError) toolErrors.push(event.result); } }).run();
    expect(declared.map(names => names.sort())).toEqual([["Read", "TaskReport"], ["Read", "TaskReport"], ["Read", "TaskReport"], ["Read", "TaskReport"]]);
    expect(toolErrors).toEqual([]);
    expect(result.error, result.report).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(executed).toHaveLength(13);
    expect(requests).toBe(4);
  });

  it.each([false, true])("bounds report finalization after duration expiry (user cancels=%s)", async userCancels => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const firstStarted = deferred();
    const reportStarted = deferred();
    let requests = 0;
    const declared: string[][] = [];
    transport.mockImplementation((_model, context, options) => {
      requests++;
      declared.push(getCurrentTools(context.messages).map(tool => tool.name));
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", timestamp: Date.now(),
        stopReason: "aborted", content: [text("Retained evidence: A checked, B pending.")],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      // Recovery may retain only output observed before cancellation, not text first invented by an abort result.
      queueMicrotask(() => stream.push({ type: "start", partial: message }));
      const finish = () => { stream.push({ type: "error", reason: "aborted", error: message }); stream.end(message); };
      if (options?.signal?.aborted) queueMicrotask(finish);
      else options?.signal?.addEventListener("abort", finish, { once: true });
      (requests === 1 ? firstStarted : reportStarted).resolve();
      return stream;
    });
    const execute = vi.fn(async () => ({ content: [text("unused")], details: {} }));
    const running = fixture(execute, { signal: controller.signal, runPolicy: { maxDurationSeconds: 1, finalReportTimeoutSeconds: 3 } }).run();
    try {
      await firstStarted.promise;
      await vi.advanceTimersByTimeAsync(1000);
      await reportStarted.promise;
      expect(requests).toBe(2);
      expect(declared[1]).toEqual([]);
      if (userCancels) controller.abort();
      else await vi.advanceTimersByTimeAsync(3000);
      const result = await running;
      expect(result.status).toBe(userCancels ? "aborted" : "failed");
      expect(result.report).toContain("Retained evidence");
      expect(result.error?.code).toBe(userCancels ? undefined : "SUBAGENT_BUDGET_EXHAUSTED");
      expect(execute).not.toHaveBeenCalled();
      expect(transport).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { controller.abort(); await running; }
  });

  it("does not execute tools requested by a report-only response", async () => {
    let requests = 0;
    const executed: string[] = [];
    transport.mockImplementation(() => response([call(++requests === 1 ? "allowed" : "forbidden")], "toolUse"));
    const result = await fixture(async id => { executed.push(id); return { content: [text("evidence")], details: {} }; }, { runPolicy: { maxToolCalls: 1 } }).run();
    expect(requests).toBe(2);
    expect(executed).toEqual(["allowed"]);
    expect(result.error?.code).toBe("SUBAGENT_BUDGET_EXHAUSTED");
  });

  it("retains findings when a fallback model ends without new output", async () => {
    let requests = 0;
    transport.mockImplementation(() => {
      if (++requests === 1) return response([text("Confirmed before fallback: a.ts:12."), call("read-a")], "toolUse");
      if (requests !== 2) return response([]);
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", timestamp: Date.now(),
        stopReason: "error", errorMessage: "401: fixture authentication failure", content: [],
        usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(() => { stream.push({ type: "error", reason: "error", error: message }); stream.end(message); });
      return stream;
    });
    const result = await fixture(async () => ({ content: [text("evidence")], details: {} }), {
      fallbackModels: [{ key: "fixture/alternative", provider: { id: "fixture", name: "Fixture", apiKey: "", authKind: "none", modelId: "alternative", supportsReasoning: false, supportedThinkingLevels: ["off"] } }],
    }).run();
    expect(requests).toBe(3);
    expect(result).toMatchObject({ status: "failed", modelId: "alternative", error: { code: "SUBAGENT_NO_REPORT" } });
    expect(result.report).toContain("Confirmed before fallback");
    expect(readFileSync(result.checkpointPath!, "utf8")).toContain("a.ts:12");
  });

  it("keeps explicit unlimited work budgets and an immutable starting snapshot", async () => {
    const input = { maxToolCalls: 0, maxDurationSeconds: 0, finalReportTimeoutSeconds: 7 };
    let requests = 0;
    const executed: string[] = [];
    transport.mockImplementation(() => ++requests === 1
      ? response(Array.from({ length: 130 }, (_, i) => call(`unlimited-${i}`)), "toolUse")
      : response([text("Completed beyond the default call budget.")]));
    const run = fixture(async id => { executed.push(id); return { content: [text("evidence")], details: {} }; }, { runPolicy: input });
    input.maxToolCalls = 1;
    input.finalReportTimeoutSeconds = 1;
    const result = await run.run();
    expect(result.status).toBe("completed");
    expect(executed).toHaveLength(130);
    expect(requests).toBe(2);
    expect(result.runPolicy).toMatchObject({ maxToolCalls: 0, maxDurationSeconds: 0, finalReportTimeoutSeconds: 7 });
    expect(JSON.parse(readFileSync(result.checkpointPath!, "utf8")).runPolicy).toEqual(result.runPolicy);
  });

  it.each([1, 3])("ignores retired reporting controls in old settings (%s)", async maxCheckpointRequests => {
    const legacy = { maxToolCalls: 0, maxDurationSeconds: 0, finalReportTimeoutSeconds: 3,
      checkpointInterval: 1, maxCheckpointRequests };
    let requests = 0;
    const executed: string[] = [];
    transport.mockImplementation(() => ++requests <= 2
      ? response([call(`work-${requests}`)], "toolUse") : response([text("Completed without a periodic report.")]));
    const result = await fixture(async id => { executed.push(id); return { content: [text("evidence")], details: {} }; }, { runPolicy: legacy }).run();
    expect(requests).toBe(3);
    expect(executed).toHaveLength(2);
    expect(result.status).toBe("completed");
    expect(result.runPolicy).toEqual({ maxToolCalls: 0, maxDurationSeconds: 0, finalReportTimeoutSeconds: 3, reportRecoveryAttempts: 0 });
  });

  it.each([false, true])("keeps the deadline off by default or explicit zero (explicit=%s)", async explicit => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const entered = deferred();
    const release = deferred();
    let signal: AbortSignal | undefined;
    let requests = 0;
    transport.mockImplementation(() => ++requests === 1 ? response([call("long-read")], "toolUse") : response([text("Finished after the old default deadline.")]));
    const running = fixture(async (_id, _args, receivedSignal) => {
      signal = receivedSignal;
      entered.resolve();
      await release.promise;
      return { content: [text("evidence")], details: {} };
    }, { signal: controller.signal, ...(explicit ? { runPolicy: { maxDurationSeconds: 0 } } : {}) }).run();
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(901_000);
      expect(signal?.aborted).toBe(false);
      expect(requests).toBe(1);
      release.resolve();
      const result = await running;
      expect(result.status).toBe("completed");
      expect(result.runPolicy?.maxDurationSeconds).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { controller.abort(); release.resolve(); await running; }
  });

  it("generic policy runs ordinary work without model-authored checkpoints", async () => {
    let requests = 0;
    const executed: string[] = [];
    const declarations: string[][] = [];
    transport.mockImplementation((_model, context) => {
      declarations.push(getCurrentTools(context.messages).map(tool => tool.name));
      return ++requests === 1
        ? response(Array.from({ length: 130 }, (_, i) => call(`work-${i}`)), "toolUse")
        : response([text("Work completed without a progress-report request.")]);
    });
    const result = await fixture(async id => {
      executed.push(id);
      return { content: [text("evidence")], details: {} };
    }).run();
    expect(result.status).toBe("completed");
    expect(executed).toHaveLength(130);
    expect(requests).toBe(2);
    expect(declarations.every(names => names.includes("Read"))).toBe(true);
    expect(result.runPolicy).toEqual({ maxToolCalls: 0, maxDurationSeconds: 0, finalReportTimeoutSeconds: 60, reportRecoveryAttempts: 0 });
    expect(readFileSync(result.checkpointPath!, "utf8")).toContain("Work completed");
  });

  it("generic policy continues work when an optional report cannot be written to scratch", async () => {
    const blocked = join(scratchDir, "blocked");
    writeFileSync(blocked, "not a directory");
    let requests = 0;
    const executed: string[] = [];
    transport.mockImplementation(() => {
      if (++requests === 1) return response([call("optional-report", "TaskReport", { report: "A found; checking B next." })], "toolUse");
      if (requests === 2) return response([call("read-b")], "toolUse");
      return response([text("Work completed; A and B verified.")]);
    });
    const result = await fixture(async id => {
      executed.push(id);
      return { content: [text("B evidence")], details: {} };
    }, { scratchDir: blocked }).run();
    expect(result.status).toBe("completed");
    expect(result.error).toBeUndefined();
    expect(result.checkpointError).toBeTruthy();
    expect(result.report).toContain("Reporting issue");
    expect(executed).toEqual(["read-b"]);
    expect(requests).toBe(3);
  });

  it("counts voluntary report calls against an explicitly configured tool budget", async () => {
    let requests = 0;
    const executed: string[] = [];
    transport.mockImplementation(() => ++requests === 1
      ? response([call("summary", "TaskReport", { report: "Known evidence retained; further work pending." }), call("not-admitted")], "toolUse")
      : response([text("Partial report: further work remains.")]));
    const result = await fixture(async id => { executed.push(id); return { content: [text("unexpected")], details: {} }; }, { runPolicy: { maxToolCalls: 1 } }).run();
    expect(executed).toEqual([]);
    expect(requests).toBe(2);
    expect(result.error?.code).toBe("SUBAGENT_BUDGET_EXHAUSTED");
    expect(result.report).toContain("Known evidence retained");
  });
});
