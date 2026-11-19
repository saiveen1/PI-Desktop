import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type ToolCall } from "@earendil-works/pi-ai";
import type { AgentEventEnvelope, AgentOutputGuardSettings, SessionTodo } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";

const dsml = [
  "I will run the remaining check.",
  "</｜DSML｜ parameter>",
  '<｜DSML｜ parameter name="timeout" string="false">60</｜DSML｜ parameter>',
  "</｜DSML｜ invoke>",
  "</｜DSML｜ calls>",
].join("\n");
const xml = "<tool_call>\n<function=Bash>\n<parameter=command>\nprintf checked\n</parameter>\n</function>\n</tool_call>";
const compactDsml = '<｜DSML｜ calls><｜DSML｜ invoke name="Bash"><｜DSML｜ parameter name="command" string="true">printf checked</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>';
const text = (value: string): AssistantMessage["content"] => [{ type: "text", text: value }];
const tool = (id: string): AssistantMessage["content"] => [{ type: "toolCall", id, name: "Bash", arguments: { command: "printf checked" } }];
type Step = { content: AssistantMessage["content"]; stopReason?: Exclude<AssistantMessage["stopReason"], "pending"> };

function fixture(steps: Step[], options: {
  mode?: "agent" | "plan";
  settings?: AgentOutputGuardSettings;
  onReply?: (runtime: DesktopAgentRuntime, index: number) => void;
} = {}) {
  const requests: Context[] = [];
  const events: AgentEventEnvelope[] = [];
  let todos: SessionTodo[] = [];
  const hostCall = vi.fn(async (method: string, params?: unknown) => {
    if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false };
    if (method === "provider.delegationSnapshot" || method === "session.appendMessage" || method === "project.instructions.resolve" || method === "session.appendCompaction") return undefined;
    if (method === "todos.get") return { sessionId: "text-recovery-fixture", todos };
    if (method === "tools.execute") {
      const input = params as { toolName: string; args: { todos?: SessionTodo[] } };
      if (input.toolName === "TodoWrite") todos = input.args.todos ?? [];
      return { ok: true, content: { content: [{ type: "text", text: "checked once" }], details: {} } };
    }
    throw new Error(`Unexpected Host call: ${method}`);
  });
  const runtime = new DesktopAgentRuntime({
    sessionId: "text-recovery-fixture", mode: options.mode ?? "agent", thinkingLevel: "off",
    compactionStrategy: "summary",
    agentOutputGuard: options.settings,
    provider: { id: "fixture", name: "Fixture", modelId: "fixture-model", apiKey: "", authKind: "none", baseUrl: "http://provider.invalid/v1", supportsReasoning: false, supportedThinkingLevels: ["off"] },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { async call<T>(method: string, params?: unknown): Promise<T> { return await hostCall(method, params) as T; } },
    onEvent: (event) => events.push(event),
  });
  vi.spyOn(runtime["models"], "streamSimple").mockImplementation((_model, context) => {
    requests.push(structuredClone(context));
    const index = requests.length - 1;
    const step = steps[index] ?? { content: text("Unexpected additional request.") };
    const stopReason = step.stopReason ?? (step.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop");
    const message: AssistantMessage = {
      role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture-model", timestamp: index,
      content: step.content,
      stopReason,
      ...(step.stopReason === "error" ? { errorMessage: "401 Unauthorized" } : {}),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      options.onReply?.(runtime, index);
      stream.push({ type: "start", partial: message });
      if (stopReason === "error" || stopReason === "aborted") {
        stream.push({ type: "error", reason: stopReason, error: message });
      } else {
        stream.push({ type: "done", reason: stopReason, message });
      }
      stream.end(message);
    });
    return stream;
  });
  return { runtime, requests, events, hostCall };
}

const executions = (f: ReturnType<typeof fixture>) => f.hostCall.mock.calls.filter(([method]) => method === "tools.execute");

describe("text tool-call recovery user path", () => {
  it("retains the active task when compaction precedes the correction", async () => {
    const f = fixture([{ content: text(dsml) }, { content: text("Check complete.") }], {
      onReply: (runtime, index) => {
        if (index === 0) runtime["createExtensionBridge"]().compact();
      },
    });
    vi.spyOn(f.runtime["models"], "completeSimple").mockResolvedValue({
      role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture-model", timestamp: 1,
      content: text("The remaining acceptance check is still pending; protocol text executed nothing."), stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    try {
      await f.runtime.prompt("Run the remaining acceptance check.", "user-1", "turn-1");
      expect(f.requests).toHaveLength(2);
      expect(f.events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: "compaction_end", ok: true }) }));
      expect(f.hostCall).toHaveBeenCalledWith("session.appendCompaction", expect.objectContaining({
        compaction: expect.objectContaining({ details: expect.objectContaining({ retainedTailMode: "active_turn" }) }),
      }));
      expect(JSON.stringify(f.requests[1])).toContain("Run the remaining acceptance check.");
      expect(JSON.stringify(f.requests[1])).toContain("text_tool_call_recovery");
    } finally { await f.runtime.dispose(); }
  });

  it("does not let an unfinished checklist prolong repeated protocol leakage", async () => {
    const call = (id: string, name: string, args: ToolCall["arguments"]): Step => ({ content: [{ type: "toolCall", id, name, arguments: args }] });
    const f = fixture([
      call("discover", "ToolSearch", { query: "TodoWrite" }),
      call("checklist", "TodoWrite", { todos: [{ content: "Run the remaining check", status: "pending" }] }),
      { content: text(dsml) }, { content: text(dsml) },
    ]);
    try {
      await f.runtime.prompt("Run the checks and track the work.");
      expect(f.requests).toHaveLength(4);
      expect(JSON.stringify(f.requests)).not.toContain("unfinished_todo_recovery");
      expect(executions(f)).toHaveLength(1);
    } finally { await f.runtime.dispose(); }
  });

  it("prioritizes steering without a recovery reminder or resetting the allowance", async () => {
    const f = fixture([{ content: text(dsml) }, { content: tool("corrected") }, { content: text(dsml) }, { content: text(dsml) }], {
      onReply: (runtime, index) => {
        if (index === 2) runtime.steer({ text: "Report the current state only." }, "turn-1", {
          id: "steering-1", role: "user", content: "Report the current state only.", createdAt: new Date().toISOString(), status: "complete",
        });
      },
    });
    try {
      await f.runtime.prompt("Run the check.", "user-1", "turn-1");
      expect(f.requests).toHaveLength(4);
      expect(JSON.stringify(f.requests[3])).toContain("Report the current state only.");
      expect(JSON.stringify(f.requests[3])).not.toContain("text_tool_call_recovery");
      expect(executions(f)).toHaveLength(1);
    } finally { await f.runtime.dispose(); }
  });

  it("uses only the protocol correction during approved Plan execution", async () => {
    const f = fixture([{ content: text(dsml) }, { content: text(dsml) }]);
    try {
      await f.runtime.executeApprovedPlan({
        id: "execution-1", proposalId: "proposal-1", sessionId: "text-recovery-fixture", kind: "plan",
        plan: "Run the check.", title: "Approved plan", question: "Proceed?", state: "running", targetPermissionMode: "auto",
        artifact: { relativePath: ".pi/plan/proposal-1.md", sha256: "fixture-only", sizeBytes: 14 },
      }, "turn-1");
      expect(f.requests).toHaveLength(2);
      expect(JSON.stringify(f.requests[1])).toContain("text_tool_call_recovery");
      expect(JSON.stringify(f.requests)).not.toContain("progress_only_recovery");
      expect(f.events.filter(({ event }) => event.type === "agent_end")).toHaveLength(1);
    } finally { await f.runtime.dispose(); }
  });

  it.each([dsml, compactDsml, xml])("corrects a leaked call once in the original turn without replaying completed tools", async (leak) => {
    const f = fixture([{ content: tool("completed") }, { content: text(leak) }, { content: tool("corrected") }, { content: text("Both checks are complete.") }]);
    try {
      await f.runtime.prompt("Run both checks.", "user-1", "turn-1");
      expect(f.requests).toHaveLength(4);
      expect(f.requests[2]?.messages).toContainEqual(expect.objectContaining({ role: "assistant", content: text(leak) }));
      expect(f.requests[2]?.messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolCallId: "completed", isError: false }));
      expect(JSON.stringify(f.requests[2])).toContain("text_tool_call_recovery");
      expect(executions(f)).toHaveLength(2);
      expect(JSON.stringify(f.requests[3])).not.toContain("text_tool_call_recovery");
      expect(f.requests.every((request) => request.messages.filter((message) => message.role === "user").length === 1)).toBe(true);
      expect(f.events.filter((event) => event.event.type === "agent_end")).toHaveLength(1);
      expect(f.events.every((event) => event.turnId === "turn-1")).toBe(true);
      expect(f.events.some((event) => event.event.type === "error")).toBe(false);
      expect(f.runtime.getStatus().isRunning).toBe(false);
    } finally { await f.runtime.dispose(); }
  });

  it("bounds repeated leakage and preserves a retriable diagnostic with the original text", async () => {
    const f = fixture([{ content: text(dsml) }, { content: text(dsml) }]);
    try {
      await f.runtime.prompt("Run the check.");
      expect(f.requests).toHaveLength(2);
      expect(executions(f)).toHaveLength(0);
      const ended = f.events.flatMap(({ event }) => event.type === "message_end" ? [event.message] : []);
      expect(ended.at(-1)).toMatchObject({ content: dsml, status: "error", error: { code: "TOOL_CALL_NOT_EXECUTED", retriable: true } });
      expect(f.events.filter(({ event }) => event.type === "agent_end")).toHaveLength(1);
    } finally { await f.runtime.dispose(); }
  });

  it("does not replenish recovery after a successful tool batch in the same turn", async () => {
    const f = fixture([{ content: text(dsml) }, { content: tool("corrected") }, { content: text(dsml) }]);
    try {
      await f.runtime.prompt("Run the check.");
      expect(f.requests).toHaveLength(3);
      expect(executions(f)).toHaveLength(1);
    } finally { await f.runtime.dispose(); }
  });

  it("resets recovery only for a new user turn and expires the reminder", async () => {
    const f = fixture([{ content: text(dsml) }, { content: text("First check complete.") }, { content: text(dsml) }, { content: text("Second check complete.") }]);
    try {
      await f.runtime.prompt("Run the first check.");
      await f.runtime.prompt("Run the second check.");
      expect(f.requests).toHaveLength(4);
      expect(JSON.stringify(f.requests[2])).not.toContain("text_tool_call_recovery");
      expect(JSON.stringify(f.requests[3])).toContain("text_tool_call_recovery");
      expect(f.events.filter(({ event }) => event.type === "agent_end")).toHaveLength(2);
    } finally { await f.runtime.dispose(); }
  });

  it("does not interrupt or replay valid sibling calls", async () => {
    const f = fixture([{ content: [...text(dsml), ...tool("sibling")] }, { content: text("Check complete.") }]);
    try {
      await f.runtime.prompt("Run the check.");
      expect(f.requests).toHaveLength(2);
      expect(executions(f)).toHaveLength(1);
      expect(JSON.stringify(f.requests[1])).not.toContain("text_tool_call_recovery");
    } finally { await f.runtime.dispose(); }
  });

  it.each(["stop", "abort"] as const)("honors a user %s before the recovery boundary", async (action) => {
    let stopping: Promise<unknown> | undefined;
    const f = fixture([{ content: text(dsml) }], { onReply: (runtime) => {
      if (action === "stop") runtime.requestGracefulStop();
      else stopping = runtime.abort();
    } });
    try {
      await f.runtime.prompt("Run the check.");
      await stopping;
      expect(f.requests).toHaveLength(1);
      expect(executions(f)).toHaveLength(0);
    } finally { await f.runtime.dispose(); }
  });

  it.each(["length", "error", "aborted"] as const)("does not recover a %s response as a successful stop", async (stopReason) => {
    const f = fixture([{ content: text(dsml), stopReason }]);
    try {
      await f.runtime.prompt("Run the check.");
      expect(f.requests).toHaveLength(1);
      expect(executions(f)).toHaveLength(0);
    } finally { await f.runtime.dispose(); }
  });

  it.each(["The task is complete.", `\`\`\`xml\n${dsml}\n\`\`\``, dsml.split("\n").map((line) => `> ${line}`).join("\n")])("leaves normal answers and quoted examples terminal", async (answer) => {
    const f = fixture([{ content: text(answer) }]);
    try {
      await f.runtime.prompt("Explain the format.");
      expect(f.requests).toHaveLength(1);
      expect(executions(f)).toHaveLength(0);
      expect(f.events.some(({ event }) => event.type === "message_end" && event.message.status === "error")).toBe(false);
    } finally { await f.runtime.dispose(); }
  });

  it("does not extend Plan mode into autonomous work", async () => {
    const f = fixture([{ content: text(dsml) }], { mode: "plan" });
    try {
      await f.runtime.prompt("Propose a plan.");
      expect(f.requests).toHaveLength(1);
      expect(executions(f)).toHaveLength(0);
    } finally { await f.runtime.dispose(); }
  });

  it.each([0, 1, 2])("shares recoveryLimit=%s between protocol and ordinary progress even after successful tools", async recoveryLimit => {
    const f = fixture([
      { content: text(dsml) }, { content: tool("first") },
      { content: text("I will run the remaining check.") }, { content: tool("second") },
      { content: text(dsml) },
    ], { settings: { earlyEndMode: "continue", recoveryLimit } });
    try {
      await f.runtime.prompt("Run both checks.");
      expect(f.requests).toHaveLength(recoveryLimit === 0 ? 1 : recoveryLimit === 1 ? 3 : 5);
      expect(executions(f)).toHaveLength(recoveryLimit);
      if (recoveryLimit > 0) expect(JSON.stringify(f.requests[1])).toContain("text_tool_call_recovery");
      if (recoveryLimit === 2) expect(JSON.stringify(f.requests[3])).toContain("early_end_recovery");
      const messages = f.events.flatMap(({ event }) =>
        (event.type === "message_end" || event.type === "message_update") && event.message.status !== "streaming" ? [event.message] : []);
      expect(messages.at(-1)?.runDiagnostics?.termination?.recoveryAttempts).toBe(recoveryLimit);
      if (recoveryLimit === 1) expect(messages.at(-1)?.runDiagnostics?.termination?.earlyEnd).toBe("exhausted");
      else expect(messages.at(-1)?.error?.code).toBe("TOOL_CALL_NOT_EXECUTED");
    } finally { await f.runtime.dispose(); }
  });
});
