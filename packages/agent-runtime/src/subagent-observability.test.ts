import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Models, type ToolCall } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { SubagentRun, type SubagentRunOptions } from "./subagent.js";

const transport = vi.hoisted(() => vi.fn<Models["streamSimple"]>());
vi.mock("./provider-binding.js", async original => {
  const actual = await original<typeof import("./provider-binding.js")>();
  return { ...actual, createProviderModels: (...args: Parameters<typeof actual.createProviderModels>) => {
    const models = actual.createProviderModels(...args);
    models.streamSimple = transport;
    return models;
  } };
});
const text = (value: string) => ({ type: "text" as const, text: value });
const call = (id: string, name: string, args: ToolCall["arguments"] = {}): ToolCall => ({ type: "toolCall", id, name, arguments: args });
function response(content: AssistantMessage["content"], stopReason: "stop" | "toolUse" | "length" | "error" | "aborted" = "stop") {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "fixture", model: "model", timestamp: Date.now(),
    content, stopReason, ...(stopReason === "error" ? { errorMessage: "401: invalid fixture credential" } : {}),
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    if (stopReason === "error" || stopReason === "aborted") stream.push({ type: "error", reason: stopReason, error: message });
    else stream.push({ type: "done", reason: stopReason, message });
    stream.end(message);
  });
  return stream;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
let scratchDir: string;
beforeEach(() => { transport.mockReset(); scratchDir = mkdtempSync(join(tmpdir(), "delegate-observation-")); });
afterEach(() => { vi.useRealTimers(); rmSync(scratchDir, { recursive: true, force: true }); });
function fixture(execute: AgentTool["execute"], extra: Partial<SubagentRunOptions> = {}) {
  return new SubagentRun({
    definition: { name: "worker", description: "Fixture", tools: ["Read", "Write"], prompt: "Report findings.", source: "builtin" },
    sessionId: "session", delegationId: "run", delegateSessionId: "chain", parentToolCallId: "task", scratchDir,
    task: "Inspect and change the fixture.", thinkingLevel: "off", systemPrompt: "Inspect and report.",
    provider: { id: "fixture", name: "Fixture", apiKey: "", authKind: "none", modelId: "model", supportsReasoning: false, supportedThinkingLevels: ["off"] },
    tools: ["Read", "Write"].map(name => ({ name, label: name, description: "Fixture tool", parameters: Type.Object({ path: Type.Optional(Type.String()) }), execute })),
    builtinToolNames: new Set(["Read", "Write"]),
    onEvent: () => undefined, ...extra,
  });
}
const checkpoint = () => JSON.parse(readFileSync(join(scratchDir, "delegations", "chain", "checkpoint.json"), "utf8"));

describe("runtime-owned delegation observations", () => {
  it("records actual attempts, usage and execution end without claiming parent report delivery", async () => {
    transport.mockImplementation(() => response([text("Confirmed fixture result.")]));
    const result = await fixture(async () => ({ content: [], details: {} })).run();
    expect(result).toMatchObject({ status: "completed", observation: {
      selectedModel: "fixture/model", attemptCount: 1, attemptsOmitted: 0, phase: "ended",
      executionStartedAt: expect.any(Number), executionEndedAt: expect.any(Number), reportProducedAt: expect.any(Number),
      attempts: [{ sequence: 1, model: "fixture/model", outcome: "completed", startedAt: expect.any(Number), finishedAt: expect.any(Number),
        providerDurationMs: expect.any(Number), usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }],
    } });
    expect(checkpoint().observation.reportDeliveredAt).toBeUndefined();
    expect(checkpoint().observation).toEqual(result.observation);
  });

  it("diagnoses repeated read-only activity without aborting or demanding model reports", async () => {
    vi.useFakeTimers();
    const entered = deferred();
    const release = deferred();
    let requests = 0;
    transport.mockImplementation(() => ++requests <= 3 ? response([call(`r${requests}`, "Read", { path: "src/a.ts" })], "toolUse")
      : response([text("Read-only analysis complete.")]));
    const run = fixture(async id => {
      if (id === "r3") { entered.resolve(); await release.promise; }
      return { content: [text("same evidence")], details: {} };
    });
    const running = run.run();
    try {
      await entered.promise;
      const before = checkpoint().observation;
      await vi.advanceTimersByTimeAsync(30_000);
      const observed = checkpoint().observation;
      expect(observed).toMatchObject({ phase: "tool", completedToolCalls: 2,
        diagnostic: { state: "waiting_tool", thresholdMs: 30_000 },
        lastMeaningfulProgressAt: before.lastMeaningfulProgressAt,
        pendingTools: [{ toolCallId: "r3", toolName: "Read", effects: "unknown" }],
      });
      expect(transport).toHaveBeenCalledTimes(3);
      release.resolve();
      expect((await running).status).toBe("completed");
      expect(vi.getTimerCount()).toBe(0);
    } finally { release.resolve(); await running; }
  });

  it("retains confirmed writes and unknown pending effects on cancellation without replay", async () => {
    const controller = new AbortController();
    const entered = deferred();
    let requests = 0;
    const executed: string[] = [];
    transport.mockImplementation(() => response([call(++requests === 1 ? "write" : "pending", "Write", { path: requests === 1 ? "src/done.ts" : "src/unknown.ts" })], "toolUse"));
    const running = fixture(async (id, _args, signal) => {
      executed.push(id);
      if (id === "pending") {
        entered.resolve();
        await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
        throw Object.assign(new Error("Write interrupted; outcome unknown"), { name: "AbortError" });
      }
      return { content: [text("written")], details: {} };
    }, { signal: controller.signal, runPolicy: { reportRecoveryAttempts: 1 } }).run();
    try {
      await entered.promise;
      expect(checkpoint()).toMatchObject({ observation: { confirmedWritePaths: ["src/done.ts"], pendingTools: [{ path: "src/unknown.ts", effects: "unknown" }] } });
      controller.abort();
      const result = await running;
      expect(result).toMatchObject({ status: "aborted", observation: { confirmedWritePaths: ["src/done.ts"], failedToolCalls: 1 } });
      expect(result.report).toContain("src/done.ts");
      expect(result.report).toContain("src/unknown.ts");
      expect(result.report).toContain("Do not replay");
      expect(result.terminal?.reportOutcome).toBe("cancelled");
      expect(executed).toEqual(["write", "pending"]);
      expect(requests).toBe(2);
    } finally { controller.abort(); await running; }
  });

  it("records terminal failures even without fallback and never produces a report from fragments", async () => {
    transport.mockImplementation(() => response([text("partial protocol fragment")], "error"));
    const result = await fixture(async () => ({ content: [], details: {} })).run();
    expect(result).toMatchObject({ status: "failed", observation: { attemptCount: 1,
      attempts: [{ outcome: "failed", error: { code: expect.any(String) } }], phase: "ended" } });
    expect(result.observation?.reportProducedAt).toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("publishes live tool counters and evidence before settlement", async () => {
    const entered = deferred();
    const release = deferred();
    const onProgress = vi.fn();
    let requests = 0;
    transport.mockImplementation(() => ++requests === 1 ? response([call("r", "Read", { path: "src/a.ts" })], "toolUse") : response([text("done")]));
    const running = fixture(async (_id, _args, _signal, update) => {
      update?.({ content: [text("heartbeat")], details: {} });
      entered.resolve(); await release.promise;
      return { content: [text("read")], details: { totalLines: 42 } };
    }, { onProgress }).run();
    try {
      await entered.promise;
      expect(onProgress).toHaveBeenLastCalledWith({ turns: 1, toolCalls: 1 });
      expect(checkpoint()).toMatchObject({ status: "running", observation: { pendingTools: [{ toolCallId: "r" }], completedToolCalls: 0 } });
      release.resolve();
      const result = await running;
      expect(result).toMatchObject({ turns: 2, toolCalls: 1, observation: { completedToolCalls: 1, recentTools: [{ path: "src/a.ts", totalLines: 42, outcome: "completed" }] } });
    } finally { release.resolve(); await running; }
  });
  it.each([false, true])("records fallback authorization separately from actual start (cancel=%s)", async cancel => {
    const controller = new AbortController();
    const entered = deferred();
    const approved = deferred();
    const snapshots: Parameters<NonNullable<SubagentRunOptions["onObservation"]>>[0][] = [];
    const alternative = { id: "fixture", name: "Fixture", apiKey: "", authKind: "none" as const, modelId: "alternative", supportsReasoning: false, supportedThinkingLevels: ["off" as const] };
    transport.mockImplementation(model => response(model.id === "alternative" ? [text("Fallback final report.")] : [], model.id === "alternative" ? "stop" : "error"));
    const running = fixture(async () => ({ content: [], details: {} }), {
      signal: controller.signal, onObservation: snapshot => snapshots.push(snapshot),
      fallbackModels: [{ key: "fixture/alternative", provider: alternative }],
      authorizeModel: async () => { entered.resolve(); await approved.promise; return !controller.signal.aborted; },
    }).run();
    try {
      await entered.promise;
      expect(checkpoint().observation).toMatchObject({ phase: "approval", attemptCount: 1,
        approvals: [{ model: "fixture/alternative", status: "pending" }], attempts: [{ model: "fixture/model", outcome: "failed" }] });
      expect(transport).toHaveBeenCalledTimes(1);
      if (cancel) controller.abort();
      approved.resolve();
      const result = await running;
      expect(result.status).toBe(cancel ? "aborted" : "completed");
      expect(result.observation?.attemptCount).toBe(cancel ? 1 : 2);
      expect(result.observation?.approvals.at(-1)?.status).toBe(cancel ? "cancelled" : "accepted");
      if (!cancel) expect(snapshots.some(snapshot => snapshot.approvals.at(-1)?.status === "accepted" && snapshot.attemptCount === 1)).toBe(true);
      expect(transport).toHaveBeenCalledTimes(cancel ? 1 : 2);
    } finally { controller.abort(); approved.resolve(); await running; }
  });

  it("retains a setup failure hidden by an authorized bounded provider retry", async () => {
    vi.useFakeTimers();
    const retrying = deferred();
    let requests = 0;
    transport.mockImplementation(() => { if (++requests === 1) throw new Error("502: fixture unavailable"); return response([text("Recovered report.")]); });
    const running = fixture(async () => ({ content: [], details: {} }), {
      failurePolicy: { mode: "retry", maxRetries: 1, maxFallbacks: 1 },
      onObservation: snapshot => { if (snapshot.phase === "retrying") retrying.resolve(); },
    }).run();
    await retrying.promise;
    expect(checkpoint().observation).toMatchObject({ attemptCount: 1, attempts: [{ outcome: "failed", error: { code: expect.any(String) } }] });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await running;
    expect(result).toMatchObject({ status: "completed", observation: { attemptCount: 2, attempts: [{ outcome: "failed" }, { outcome: "completed" }] } });
    expect(requests).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
