import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import { DEFAULT_DELEGATION_RUN_POLICY, resolveDelegationRunPolicy, type DelegationRunPolicy, type UiMessage } from "@pi-desktop/shared";
import { isRecord } from "./agent-messages.js";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";
import { persistSubagentCheckpoint } from "./subagent-checkpoint.js";

const transport = vi.hoisted(() => vi.fn<Models["streamSimple"]>());
vi.mock("./provider-binding.js", async (original) => {
  const actual = await original<typeof import("./provider-binding.js")>();
  return { ...actual, createProviderModels: (...args: Parameters<typeof actual.createProviderModels>) => {
    const models = actual.createProviderModels(...args);
    models.streamSimple = transport;
    return models;
  } };
});
function response(content: AssistantMessage["content"]) {
  const stream = createAssistantMessageEventStream();
  const reason = content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
  const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
    timestamp: Date.now(), content, stopReason: reason,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason, message }); stream.end(message); });
  return stream;
}
const provider: RuntimeProviderConfig = { id: "fixture", name: "Fixture", modelId: "parent", authKind: "none", apiKey: "", supportsReasoning: false, supportedThinkingLevels: ["off"] };
let scratchDir: string;
beforeEach(() => { transport.mockReset(); scratchDir = mkdtempSync(join(tmpdir(), "delegate-restored-")); });
afterEach(() => { rmSync(scratchDir, { recursive: true, force: true }); });

function fixture(withChildRows: boolean, tool: "Task" | "TaskWait" = "Task", runPolicy?: Partial<DelegationRunPolicy>) {
  const history: UiMessage[] = [{
    id: "task-original", role: "tool", content: "", createdAt: "2026-11-04T00:00:00.000Z",
    toolCallId: "task-original", toolName: "Task", toolArgs: { agent: "worker", task: "Verify A and B." },
    toolStatus: "success", toolResult: { details: { delegationId: "original", agent: "worker", status: "running", modelId: "fixture" } },
  }];
  if (withChildRows) history.push({
    id: "read-original", role: "tool", content: "", createdAt: "2026-11-04T00:00:01.000Z",
    parentToolCallId: "task-original", agentName: "worker", toolCallId: "read-a", toolName: "Read",
    toolArgs: { path: "a.ts" }, toolStatus: "success", toolResult: { content: [{ type: "text", text: "A was checked; exact evidence from a.ts." }] },
  });
  const saved = persistSubagentCheckpoint({ scratchDir, delegateSessionId: "original", parentToolCallId: "task-original", checkpoint: {
    version: 1, sessionId: "session", delegateSessionId: "original", delegationId: "original", agentName: "worker",
    modelId: "fixture", thinkingLevel: "off", status: "running", report: "Confirmed finding at a.ts:12. B is still pending.",
    runPolicy: { ...DEFAULT_DELEGATION_RUN_POLICY, maxToolCalls: 999 },
    task: "Verify A and B.", turns: 3, toolCalls: 2, updatedAt: Date.now(),
  } });
  expect(saved.error).toBeUndefined();
  const parentRequests: string[] = [];
  const childRequests: string[] = [];
  const executions: unknown[] = [];
  const taskResults: Array<Record<string, unknown>> = [];
  const startErrors: unknown[] = [];
  const waitResults: Array<Record<string, unknown>> = [];
  let firstParent = true;
  transport.mockImplementation((model, context) => {
    if (model.id === "parent") {
      parentRequests.push(JSON.stringify(context.messages));
      if (firstParent) {
        firstParent = false;
        return response([{ type: "toolCall", id: "resume-call", name: tool, arguments: tool === "Task"
          ? { agent: "worker", task: "Continue the remaining checks.", resume: "original" }
          : { delegationIds: ["original"] } }]);
      }
      return response([{ type: "text", text: "Result received." }]);
    }
    childRequests.push(JSON.stringify(context.messages));
    return response(childRequests.length === 1 ? [{ type: "toolCall", id: "read-b", name: "Read", arguments: { path: "b.ts" } }]
      : [{ type: "text", text: "B verified; task complete." }]);
  });
  const runtime = new DesktopAgentRuntime({
    sessionId: "session", provider, mode: "agent", thinkingLevel: "off", scratchDir, history,
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    subagents: [{ name: "worker", description: "Fixture", tools: ["Read"], prompt: "Check files.", source: "builtin", model: { providerId: "fixture", modelId: "fixture" } }],
    subagentProviders: { "fixture/fixture": { ...provider, modelId: "fixture" } },
    ...(runPolicy ? { delegationAuthorization: true, delegationSettings: { version: 1 as const, approvalTimeoutSeconds: 60, runPolicy,
      models: [{ providerId: "fixture", modelId: "fixture", enabled: true, priority: 1, approval: "auto" as const, description: "Fixture" }],
    } } : {}),
    host: { call: async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "provider.authorizeDelegation") return { decision: "allow", reason: "Fixture authorization" } as T;
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
      if (method === "project.instructions.resolve") return { entries: [] } as T;
      if (method === "tools.execute") { executions.push(params); return { ok: true, content: "B evidence" } as T; }
      if (method === "session.appendMessage") return undefined as T;
      throw new Error(`Unexpected host call ${method}`);
    } },
    onEvent: ({ event }) => {
      const result = event.type === "tool_end" ? event.result
        : event.type === "message_end" && event.message.toolName === "Task" ? event.message.toolResult : undefined;
      if (event.type === "tool_end" && isRecord(result) && isRecord(result.details) && typeof result.details.error === "string") startErrors.push(result.details.error);
      if (isRecord(result) && isRecord(result.details)) {
        if ("runPolicy" in result.details) taskResults.push(result.details);
        if (Array.isArray(result.details.delegations)) waitResults.push(...result.details.delegations.filter(isRecord));
      }
    },
  });
  return { runtime, parentRequests, childRequests, executions, taskResults, waitResults, startErrors };
}

describe("restored delegation user path", () => {
  it.each([true, false])("continues from checkpoint with child transcript present=%s without replaying completed tools", async withChildRows => {
    const f = fixture(withChildRows);
    try {
      await f.runtime.prompt("Continue the interrupted delegation.");
      expect(f.childRequests).toHaveLength(2);
      expect(f.childRequests[0]).toContain("Confirmed finding at a.ts:12");
      expect(f.childRequests[0]).toContain("B is still pending");
      expect(f.childRequests[0]).toContain("Verify A and B");
      if (withChildRows) expect(f.childRequests[0]).toContain("exact evidence from a.ts");
      expect(f.executions).toHaveLength(1);
      expect(JSON.stringify(f.executions)).toContain("b.ts");
      expect(JSON.stringify(f.executions)).not.toContain('"path":"a.ts"');
      expect(f.parentRequests.at(-1)).toContain("B verified; task complete");
    } finally { await f.runtime.dispose(); }
  });

  it("reads a partial report after restart without launching a child", async () => {
    const f = fixture(false, "TaskWait");
    try {
      await f.runtime.prompt("Read the partial result.");
      expect(f.childRequests).toHaveLength(0);
      expect(f.parentRequests.at(-1)).toContain("Confirmed finding at a.ts:12");
      expect(f.parentRequests.at(-1)).toContain("interrupted");
      expect(f.executions).toHaveLength(0);
      expect(f.waitResults[0]?.runPolicy).toEqual({ ...DEFAULT_DELEGATION_RUN_POLICY, maxToolCalls: 999 });
    } finally { await f.runtime.dispose(); }
  });

  it("applies current scheduling policy to a resumed Task and records every effective value", async () => {
    const runPolicy = { maxToolCalls: 1, maxDurationSeconds: 17, finalReportTimeoutSeconds: 7 };
    const f = fixture(false, "Task", runPolicy);
    try {
      await f.runtime.prompt("Resume with the newly saved scheduling policy.");
      expect(f.startErrors).toEqual([]);
      expect(f.executions).toHaveLength(1);
      expect(f.childRequests[0]).toContain("Subagent work budget: 1 tool calls; 17 seconds");
      expect(f.taskResults.length).toBeGreaterThan(1);
      for (const result of f.taskResults) expect(result.runPolicy).toEqual(resolveDelegationRunPolicy(runPolicy));
      expect(f.taskResults.at(-1)).toMatchObject({ status: "failed", error: { code: "SUBAGENT_BUDGET_EXHAUSTED" } });
    } finally { await f.runtime.dispose(); }
  });
});
