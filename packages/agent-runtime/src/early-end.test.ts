import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type ToolCall } from "@earendil-works/pi-ai";
import type { AgentEventEnvelope, AgentOutputGuardSettings, SessionTodo } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";

const progress = "我用更宽的定位器重试。";
const text = (value: string): AssistantMessage["content"] => [{ type: "text", text: value }];
const call = (name: string, args: ToolCall["arguments"] = {}): AssistantMessage["content"] => [{ type: "toolCall", id: `call-${name}`, name, arguments: args }];
type Step = { content: AssistantMessage["content"]; stopReason?: Exclude<AssistantMessage["stopReason"], "pending"> };

function fixture(steps: Step[], options: {
  settings?: AgentOutputGuardSettings;
  failedTools?: boolean;
  onReply?: (runtime: DesktopAgentRuntime, index: number) => void;
} = {}) {
  const requests: Context[] = [];
  const events: AgentEventEnvelope[] = [];
  let todos: SessionTodo[] = [];
  const hostCall = vi.fn(async (method: string, params?: unknown) => {
    if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false };
    if (["provider.delegationSnapshot", "session.appendMessage", "project.instructions.resolve", "session.appendCompaction"].includes(method)) return undefined;
    if (method === "todos.get") return { sessionId: "early-end-fixture", todos };
    if (method === "tools.execute") {
      const input = params as { toolName: string; args: { todos?: SessionTodo[] } };
      if (options.failedTools) return { ok: false, content: "Failed", error: { code: "NOT_FOUND", message: "Failed" } };
      if (input.toolName === "TodoWrite") todos = input.args.todos ?? [];
      return { ok: true, content: { content: [{ type: "text", text: "checked once" }], details: {} } };
    }
    throw new Error(`Unexpected Host call: ${method}`);
  });
  const runtime = new DesktopAgentRuntime({
    sessionId: "early-end-fixture", mode: "agent", thinkingLevel: "off",
    agentOutputGuard: options.settings,
    provider: { id: "fixture", name: "Fixture", modelId: "fixture-model", apiKey: "", authKind: "none", baseUrl: "http://provider.invalid/v1", supportsReasoning: false, supportedThinkingLevels: ["off"] },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { async call<T>(method: string, params?: unknown): Promise<T> { return await hostCall(method, params) as T; } },
    onEvent: event => events.push(event),
  });
  vi.spyOn(runtime["models"], "streamSimple").mockImplementation((_model, context) => {
    requests.push(structuredClone(context));
    const index = requests.length - 1;
    const step = steps[index] ?? { content: text("Unexpected additional request.") };
    const stopReason = step.stopReason ?? (step.content.some(block => block.type === "toolCall") ? "toolUse" : "stop");
    const message: AssistantMessage = {
      role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture-model", timestamp: index,
      content: step.content, stopReason,
      ...(stopReason === "error" ? { errorMessage: "401 Unauthorized" } : {}),
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      options.onReply?.(runtime, index);
      stream.push({ type: "start", partial: message });
      if (stopReason === "error" || stopReason === "aborted") stream.push({ type: "error", reason: stopReason, error: message });
      else stream.push({ type: "done", reason: stopReason, message });
      stream.end(message);
    });
    return stream;
  });
  return { runtime, requests, events, hostCall };
}

const settled = (f: ReturnType<typeof fixture>) => f.events.flatMap(({ event }) =>
  (event.type === "message_end" || event.type === "message_update") && event.message.status !== "streaming" ? [event.message] : []);

describe("ordinary Agent early-end protection", () => {
  it("warns on a current task's next-action-only response without a checklist or another request", async () => {
    const f = fixture([{ content: text(progress) }]);
    try {
      await f.runtime.prompt("修复页面的定位器并验证结果。", "user-1", "turn-1");
      expect(f.requests).toHaveLength(1);
      const message = settled(f).at(-1)!;
      expect(message.content).toBe(progress);
      expect(message.runDiagnostics?.termination).toMatchObject({
        messageId: message.id, stopReason: "stop", reasonSource: "normalized", earlyEnd: "suspected", recoveryAttempts: 0,
      });
      expect(f.runtime.getStatus().runDiagnostics?.termination).toEqual(message.runDiagnostics?.termination);
    } finally { await f.runtime.dispose(); }
  });

  it.each(["off", "warn"] as const)("%s makes no corrective request or normal-context additions", async mode => {
    const f = fixture([{ content: text(progress) }], { settings: { earlyEndMode: mode } });
    try {
      await f.runtime.prompt("Fix the locator and verify it.");
      expect(f.requests).toHaveLength(1);
      expect(JSON.stringify(f.requests)).not.toMatch(/early_end_recovery|unfinished_todo_recovery|text_tool_call_recovery/);
      expect(settled(f).at(-1)?.runDiagnostics?.termination?.earlyEnd).toBe(mode === "warn" ? "suspected" : undefined);
    } finally { await f.runtime.dispose(); }
  });

  it("continues the existing loop, retains receipts, advances real tools once, and expires the reminder", async () => {
    const f = fixture([
      { content: call("Bash", { command: "printf first" }) }, { content: text(progress) },
      { content: call("Bash", { command: "printf second" }) }, { content: text("Completed. Both checks passed.") },
    ], { settings: { earlyEndMode: "continue" } });
    try {
      await f.runtime.prompt("Run both checks.", "user-1", "turn-1");
      expect(f.requests).toHaveLength(4);
      expect(f.requests[2]?.messages).toContainEqual(expect.objectContaining({ role: "toolResult", isError: false }));
      expect(f.requests[2]?.messages).toContainEqual(expect.objectContaining({ role: "assistant", content: text(progress) }));
      expect(JSON.stringify(f.requests[2])).toContain("early_end_recovery");
      expect(JSON.stringify(f.requests[0])).not.toContain("early_end_recovery");
      expect(JSON.stringify(f.requests[3])).not.toContain("early_end_recovery");
      expect(f.requests.every(request => request.messages.filter(message => message.role === "user").length === 1)).toBe(true);
      expect(f.hostCall.mock.calls.filter(([method]) => method === "tools.execute")).toHaveLength(2);
      expect(f.events.filter(({ event }) => event.type === "agent_end")).toHaveLength(1);
      const final = settled(f).at(-1)!;
      expect(final.runDiagnostics?.termination).toMatchObject({ messageId: final.id, stopReason: "stop", recoveryAttempts: 1 });
      expect(final.runDiagnostics?.termination?.earlyEnd).toBeUndefined();
      for (const message of settled(f)) expect(message.runDiagnostics?.termination?.messageId).toBe(message.id);
    } finally { await f.runtime.dispose(); }
  });

  it.each([0, 1, 2])("bounds repeated progress with shared recoveryLimit=%s", async recoveryLimit => {
    const f = fixture(Array.from({ length: 4 }, () => ({ content: text(progress) })), { settings: { earlyEndMode: "continue", recoveryLimit } });
    try {
      await f.runtime.prompt("修复页面定位器。");
      expect(f.requests).toHaveLength(1 + recoveryLimit);
      expect(settled(f).at(-1)?.runDiagnostics?.termination).toMatchObject({ earlyEnd: "exhausted", recoveryAttempts: recoveryLimit });
    } finally { await f.runtime.dispose(); }
  });

  it.each([
    ["Explain how to fix a locator.", progress],
    ["Should I retry the locator?", progress],
    ["要不要修复这个定位器？", progress],
    ["Discuss locator advice only; do not execute anything.", "I will retry with a broader locator."],
    ["Fix the locator.", "Completed. Tests passed. Next I will check optional improvements."],
    ["Fix the locator.", "The task is complete. I will check the extra scenario."],
    ["Fix the locator.", "I have fixed the requested issue. I will check the next scenario."],
    ["Fix the locator.", "问题已经解决。我用更宽的定位器重试。"],
    ["Fix the locator.", "I will check optional improvements."],
    ["Fix the locator.", "I will retry if you want."],
    ["Fix the locator.", "I will retry. Please confirm the target first?"],
    ["Fix the locator.", "I will retry, but I am blocked awaiting approval."],
    ["Fix the locator.", "I will retry, but I need your input."],
    ["Fix the locator.", `> ${progress}`],
    ["Fix the locator.", `\`\`\`text\n${progress}\n\`\`\``],
    ["Fix the locator.", `“${progress}”`],
    ["Fix the locator.", "The next steps could include checking the locator."],
  ])("leaves discussion, reports, quotes and user boundaries terminal: %s / %s", async (task, reply) => {
    const f = fixture([{ content: text(reply) }], { settings: { earlyEndMode: "continue" } });
    try {
      await f.runtime.prompt(task);
      expect(f.requests).toHaveLength(1);
      expect(settled(f).at(-1)?.runDiagnostics?.termination?.earlyEnd).toBeUndefined();
    } finally { await f.runtime.dispose(); }
  });

  it("does not infer success or replay after a failed latest tool", async () => {
    const f = fixture([{ content: call("Read", { path: "missing.txt" }) }, { content: text(progress) }], { settings: { earlyEndMode: "continue" }, failedTools: true });
    try {
      await f.runtime.prompt("Fix the locator.");
      expect(f.requests).toHaveLength(2);
      expect(settled(f).at(-1)?.runDiagnostics?.termination?.earlyEnd).toBeUndefined();
    } finally { await f.runtime.dispose(); }
  });

  it.each(["length", "error", "aborted"] as const)("persists normalized %s rather than an early-end warning", async stopReason => {
    const f = fixture([{ content: text(progress), stopReason }], { settings: { earlyEndMode: "continue" } });
    try {
      await f.runtime.prompt("Fix the locator.");
      expect(f.requests).toHaveLength(1);
      const message = settled(f).at(-1)!;
      expect(message.runDiagnostics?.termination).toMatchObject({ messageId: message.id, stopReason, reasonSource: "normalized", outputTokens: 2 });
      expect(message.runDiagnostics?.termination?.earlyEnd).toBeUndefined();
      expect(message.runDiagnostics?.termination).not.toHaveProperty("rawStopReason");
    } finally { await f.runtime.dispose(); }
  });

  it.each(["stop", "abort"] as const)("honors %s before the correction boundary", async action => {
    let stopping: Promise<unknown> | undefined;
    const f = fixture([{ content: text(progress) }], { settings: { earlyEndMode: "continue" }, onReply: runtime => {
      if (action === "stop") runtime.requestGracefulStop();
      else stopping = runtime.abort();
    } });
    try {
      await f.runtime.prompt("Fix the locator.");
      await stopping;
      expect(f.requests).toHaveLength(1);
      expect(settled(f).at(-1)?.runDiagnostics?.termination?.earlyEnd).toBeUndefined();
    } finally { await f.runtime.dispose(); }
  });

  it("takes settings changes only on the next user turn and resets that turn's budget", async () => {
    const f = fixture([{ content: text(progress) }, { content: text(progress) }, { content: text(progress) }, { content: text("Completed.") }], {
      settings: { earlyEndMode: "off" }, onReply: (runtime, index) => {
        if (index === 0) runtime.setAgentOutputGuard({ earlyEndMode: "warn" });
        if (index === 1) runtime.setAgentOutputGuard({ earlyEndMode: "continue" });
        if (index === 2) runtime.setAgentOutputGuard({ earlyEndMode: "off" });
      },
    });
    try {
      await f.runtime.prompt("Fix task one.");
      expect(f.requests).toHaveLength(1);
      expect(settled(f).at(-1)?.runDiagnostics?.termination?.earlyEnd).toBeUndefined();
      await f.runtime.prompt("Fix task two.");
      expect(f.requests).toHaveLength(2);
      expect(settled(f).at(-1)?.runDiagnostics?.termination?.earlyEnd).toBe("suspected");
      await f.runtime.prompt("Fix task three.");
      expect(f.requests).toHaveLength(4);
      expect(JSON.stringify(f.requests[2])).not.toContain("early_end_recovery");
      expect(settled(f).at(-1)?.runDiagnostics?.termination?.recoveryAttempts).toBe(1);
    } finally { await f.runtime.dispose(); }
  });

  it("prioritizes steering without spending or replenishing the correction budget", async () => {
    const f = fixture([{ content: text(progress) }, { content: text(progress) }], {
      settings: { earlyEndMode: "continue" }, onReply: (runtime, index) => {
        if (index === 0) runtime.steer({ text: "Explain the result only. Do not execute." }, "turn-1", {
          id: "steering-1", role: "user", content: "Explain the result only. Do not execute.", createdAt: new Date().toISOString(), status: "complete",
        });
      },
    });
    try {
      await f.runtime.prompt("Fix the locator.", "user-1", "turn-1");
      expect(f.requests).toHaveLength(2);
      expect(JSON.stringify(f.requests)).not.toContain("early_end_recovery");
      expect(settled(f).at(-1)?.runDiagnostics?.termination?.recoveryAttempts).toBe(0);
    } finally { await f.runtime.dispose(); }
  });

  it("shares the budget across checklist, early-end and protocol correction without executing printed markup", async () => {
    const leak = '<tool_call>\n<function=Bash>\n<parameter=command>\nprintf never\n</parameter>\n</function>\n</tool_call>';
    for (const recoveryLimit of [0, 1, 2]) {
      const f = fixture([
        { content: call("ToolSearch", { query: "TodoWrite" }) },
        { content: call("TodoWrite", { todos: [{ content: "Finish locator", status: "pending" }] }) },
        { content: text("Progress saved.") }, { content: text(progress) }, { content: text(leak) },
      ], { settings: { earlyEndMode: "continue", recoveryLimit } });
      try {
        await f.runtime.prompt("Fix the locator and track the work.");
        expect(f.requests).toHaveLength(3 + recoveryLimit);
        expect(f.hostCall.mock.calls.filter(([method]) => method === "tools.execute")).toHaveLength(1);
        expect(JSON.stringify(f.requests)).not.toContain("text_tool_call_recovery");
        if (recoveryLimit === 2) expect(settled(f).at(-1)).toMatchObject({ error: { code: "TOOL_CALL_NOT_EXECUTED" } });
      } finally { await f.runtime.dispose(); }
    }
  });

  it("does not carry a cancelled recovery reminder or spent budget into the next user turn", async () => {
    let stopping: Promise<unknown> | undefined;
    const f = fixture([{ content: text(progress) }, { content: text(progress) }, { content: text(progress) }, { content: text("Completed.") }], {
      settings: { earlyEndMode: "continue" }, onReply: (runtime, index) => { if (index === 1) stopping = runtime.abort(); },
    });
    try {
      await f.runtime.prompt("Fix task one.");
      await stopping;
      expect(f.requests).toHaveLength(2);
      await f.runtime.prompt("Fix task two.");
      expect(f.requests).toHaveLength(4);
      expect(JSON.stringify(f.requests[2])).not.toContain("early_end_recovery");
      expect(settled(f).at(-1)?.runDiagnostics?.termination?.recoveryAttempts).toBe(1);
    } finally { await f.runtime.dispose(); }
  });

  it.each([0, 1])("includes legacy approved progress in recoveryLimit=%s", async recoveryLimit => {
    const leak = '<tool_call>\n<function=Bash>\n<parameter=command>\nprintf never\n</parameter>\n</function>\n</tool_call>';
    const f = fixture([{ content: text("Writing the remaining note.") }, { content: call("Bash", { command: "printf actual" }) }, { content: text(leak) }], {
      settings: { earlyEndMode: "continue", recoveryLimit },
    });
    try {
      await f.runtime.executeApprovedPlan({
        id: "execution-1", proposalId: "proposal-1", sessionId: "early-end-fixture", kind: "plan",
        plan: "Write the remaining note.", title: "Approved plan", question: "Proceed?", state: "running", targetPermissionMode: "auto",
        artifact: { relativePath: ".pi/plan/proposal-1.md", sha256: "fixture-only", sizeBytes: 14 },
      }, "turn-1");
      expect(f.requests).toHaveLength(recoveryLimit === 0 ? 1 : 3);
      expect(JSON.stringify(f.requests)).not.toContain("text_tool_call_recovery");
      expect(settled(f).at(-1)?.runDiagnostics?.termination?.recoveryAttempts).toBe(recoveryLimit);
      if (recoveryLimit === 0) expect(settled(f).at(-1)?.runDiagnostics?.termination?.earlyEnd).toBe("exhausted");
      else expect(settled(f).at(-1)?.error?.code).toBe("TOOL_CALL_NOT_EXECUTED");
    } finally { await f.runtime.dispose(); }
  });

  it("does not treat a Host completion notice as a new current-user task", async () => {
    const f = fixture([{ content: text(progress) }], { settings: { earlyEndMode: "continue" } });
    try {
      await f.runtime.prompt({ text: "Fix the locator.", sessionMessage: {
        kind: "completion", messageId: "notice-1", replyToMessageId: "request-1",
        sourceSessionId: "source", sourceTitle: "Source", targetSessionId: "early-end-fixture",
      } });
      expect(f.requests).toHaveLength(1);
      expect(settled(f).at(-1)?.runDiagnostics?.termination?.earlyEnd).toBeUndefined();
    } finally { await f.runtime.dispose(); }
  });
});
