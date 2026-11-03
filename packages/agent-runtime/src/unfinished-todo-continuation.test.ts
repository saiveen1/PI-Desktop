import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEventEnvelope, SessionTodo, SessionTodoSnapshot } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";

type Step = { text: string; finish?: "stop" | "length" } | { tool: string; args: unknown };
const pending: SessionTodo[] = [{ content: "Finish the implementation", status: "pending", priority: "high" }];
const completed: SessionTodo[] = [{ ...pending[0]!, status: "completed" }];
const discover: Step = { tool: "ToolSearch", args: { query: "TodoWrite" } };
const write = (todos: SessionTodo[] = pending): Step => ({ tool: "TodoWrite", args: { todos } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function fixture(steps: Step[], options: { enabled?: boolean; mode?: "agent" | "plan"; failedWrite?: boolean } = {}) {
  const requests: Array<{ messages: Array<{ role: string; content?: unknown }> }> = [];
  const events: AgentEventEnvelope[] = [];
  const snapshot: SessionTodoSnapshot = { sessionId: "continuation-fixture", todos: pending, revision: 0, updatedAt: 1 };
  let readSnapshot = async (): Promise<SessionTodoSnapshot> => structuredClone(snapshot);
  const hostCall = vi.fn(async (method: string, params?: unknown) => {
    if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false };
    if (method === "todos.get") return readSnapshot();
    if (method === "tools.execute") {
      const input = params as { toolName: string; args: { todos: SessionTodo[] } };
      if (input.toolName === "TodoWrite") {
        if (options.failedWrite) return { ok: false, content: "Checklist write failed", error: { code: "INVALID_ARGUMENT", message: "Checklist write failed" } };
        snapshot.todos = input.args.todos;
        snapshot.revision++;
        return { ok: true, content: { content: [{ type: "text", text: "Checklist updated" }], details: { revision: snapshot.revision } } };
      }
      if (input.toolName === "Read") return { ok: false, content: "File read failed", error: { code: "NOT_FOUND", message: "File read failed" } };
      throw new Error(`Unexpected tool ${input.toolName}`);
    }
    if (method === "session.appendMessage" || method === "project.instructions.resolve") return undefined;
    throw new Error(`Unexpected host method ${method}`);
  });
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const step = steps[requests.length - 1];
    if (!step) throw new Error("Unexpected extra provider request");
    const delta = "tool" in step ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }
      : { role: "assistant", content: step.text };
    const finish = "tool" in step ? "tool_calls" : step.finish ?? "stop";
    const chunk = (value: unknown, reason: string | null) => `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, finish) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  }));
  const runtime = new DesktopAgentRuntime({
    sessionId: snapshot.sessionId, mode: options.mode ?? "agent", thinkingLevel: "off",
    autoContinueUnfinishedTodos: options.enabled,
    provider: { id: "fixture", name: "Fixture", modelId: "fixture-model", baseUrl: "http://provider.invalid/v1", apiKey: "fixture-only", apiStyle: "chat_completions", supportsReasoning: false, supportedThinkingLevels: ["off"] },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { async call<T>(method: string, params?: unknown): Promise<T> { return await hostCall(method, params) as T; } },
    onEvent: (event) => events.push(event),
  });
  return { runtime, requests, events, snapshot, hostCall, setReadSnapshot: (read: typeof readSnapshot) => { readSnapshot = read; } };
}

afterEach(() => vi.unstubAllGlobals());

describe("unfinished checklist continuation user path", () => {
  it("continues a premature final report once and completes the checklist in the same user turn", async () => {
    const f = fixture([discover, write(), { text: "本轮收束。下一轮继续完成。" }, write(completed), { text: "Implementation and checklist completed." }]);
    try {
      await f.runtime.prompt("Complete the implementation and track its steps.", "user-1", "turn-1");
      expect(f.requests).toHaveLength(5);
      expect(f.snapshot.todos).toEqual(completed);
      const reminderRequest = JSON.stringify(f.requests[3]);
      expect(reminderRequest).toContain("unfinished_todo_recovery");
      expect(reminderRequest).toContain("本轮收束");
      expect(f.requests.flatMap((request) => request.messages.filter((message) => message.role === "user"))).toHaveLength(5);
      expect(f.events.filter((event) => event.event.type === "agent_end")).toHaveLength(1);
      expect(f.events.some((event) => event.event.type === "error")).toBe(false);
      expect(f.runtime.getStatus().isRunning).toBe(false);
      expect(JSON.stringify(f.requests[4])).not.toContain("unfinished_todo_recovery");
    } finally { await f.runtime.dispose(); }
  });

  it("stops after one reminder even if the checklist remains unfinished", async () => {
    const f = fixture([discover, write(), { text: "Next round will finish." }, { text: "Still unfinished." }]);
    try {
      await f.runtime.prompt("Finish the work.");
      expect(f.requests).toHaveLength(4);
      expect(f.hostCall.mock.calls.filter(([method]) => method === "todos.get")).toHaveLength(1);
      expect(f.events.filter((event) => event.event.type === "agent_end")).toHaveLength(1);
    } finally { await f.runtime.dispose(); }
  });

  it.each([false, true])("honors the switch when enabled=%s", async (enabled) => {
    const f = fixture([discover, write(), { text: "Progress saved." }, { text: "Continued." }], { enabled });
    try {
      await f.runtime.prompt("Finish the work.");
      expect(f.requests).toHaveLength(enabled ? 4 : 3);
    } finally { await f.runtime.dispose(); }
  });

  it("continues an in-progress item", async () => {
    const f = fixture([discover, write([{ ...pending[0]!, status: "in_progress" }]), { text: "Checkpoint." }, { text: "Continued." }]);
    try {
      await f.runtime.prompt("Finish the work.");
      expect(f.requests).toHaveLength(4);
    } finally { await f.runtime.dispose(); }
  });

  it("does not continue when the latest tool batch failed", async () => {
    const f = fixture([discover, write(), { tool: "Read", args: { path: "missing.txt" } }, { text: "Blocked by a failed file read." }]);
    try {
      await f.runtime.prompt("Finish the work.");
      expect(f.requests).toHaveLength(4);
      expect(f.hostCall.mock.calls.some(([method]) => method === "todos.get")).toBe(false);
    } finally { await f.runtime.dispose(); }
  });

  it.each([[], completed, [{ ...pending[0]!, status: "cancelled" as const }]].map((todos) => ({ todos })))("does not continue a finished or cleared checklist: $todos", async ({ todos }) => {
    const f = fixture([discover, write(todos), { text: "Done." }]);
    try {
      await f.runtime.prompt("Finish the work.");
      expect(f.requests).toHaveLength(3);
    } finally { await f.runtime.dispose(); }
  });

  it("does not reactivate a checklist left over from an earlier user turn", async () => {
    const f = fixture([discover, write(), { text: "Saved." }, { text: "Continued once." }, { text: "The answer is 42." }]);
    try {
      await f.runtime.prompt("Track this work.");
      await f.runtime.prompt("What is the answer?");
      expect(f.requests).toHaveLength(5);
      expect(JSON.stringify(f.requests[4])).not.toContain("unfinished_todo_recovery");
      expect(f.events.filter((event) => event.event.type === "agent_end")).toHaveLength(2);
    } finally { await f.runtime.dispose(); }
  });

  it("resets the one-continuation allowance when a new user turn writes its own checklist", async () => {
    const f = fixture([discover, write(), { text: "First checkpoint." }, { text: "First continuation." }, discover, write(), { text: "Second checkpoint." }, { text: "Second continuation." }]);
    try {
      await f.runtime.prompt("Finish task one.");
      await f.runtime.prompt("Finish task two.");
      expect(f.requests).toHaveLength(8);
      expect(f.hostCall.mock.calls.filter(([method]) => method === "todos.get")).toHaveLength(2);
    } finally { await f.runtime.dispose(); }
  });

  it("applies a disabled preference to a reused runtime", async () => {
    const f = fixture([discover, write(), { text: "Checkpoint." }, { text: "Continued." }, discover, write(), { text: "Next task checkpoint." }]);
    try {
      await f.runtime.prompt("Finish task one.");
      f.runtime.setAutoContinueUnfinishedTodos(false);
      await f.runtime.prompt("Finish task two.");
      expect(f.requests).toHaveLength(7);
      expect(f.hostCall.mock.calls.filter(([method]) => method === "todos.get")).toHaveLength(1);
    } finally { await f.runtime.dispose(); }
  });

  it("preserves normal completion and logs a safe diagnostic when the Host read fails", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fixture([discover, write(), { text: "Progress saved." }]);
    f.setReadSnapshot(async () => { throw new Error("private fixture detail"); });
    try {
      await f.runtime.prompt("Finish the work.");
      expect(f.requests).toHaveLength(3);
      expect(f.events.filter((event) => event.event.type === "agent_end")).toHaveLength(1);
      expect(f.events.some((event) => event.event.type === "error")).toBe(false);
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("todos.get failed"));
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private fixture detail");
    } finally {
      diagnostic.mockRestore();
      await f.runtime.dispose();
    }
  });

  it("does not continue after a failed checklist write or truncated response", async () => {
    for (const failure of ["write", "length"] as const) {
      const f = fixture([discover, write(), { text: "Partial response.", finish: failure === "length" ? "length" : "stop" }], { failedWrite: failure === "write" });
      try {
        await f.runtime.prompt("Finish the work.");
        expect(f.requests).toHaveLength(3);
        expect(f.hostCall.mock.calls.some(([method]) => method === "todos.get")).toBe(false);
      } finally { await f.runtime.dispose(); }
    }
  });

  it.each(["abort", "graceful"] as const)("does not continue when %s is requested during the checklist lookup", async (kind) => {
    const f = fixture([discover, write(), { text: "Progress saved." }]);
    const started = deferred<void>();
    const released = deferred<SessionTodoSnapshot>();
    f.setReadSnapshot(() => { started.resolve(); return released.promise; });
    const running = f.runtime.prompt("Finish the work.").catch(() => undefined);
    try {
      await Promise.race([started.promise, running.then(() => { throw new Error("Turn ended without consulting the checklist"); })]);
      const stopping = kind === "abort" ? f.runtime.abort() : Promise.resolve(f.runtime.requestGracefulStop());
      released.resolve(f.snapshot);
      await Promise.all([running, stopping]);
      expect(f.requests).toHaveLength(3);
      expect(f.events.filter((event) => event.event.type === "agent_end")).toHaveLength(1);
    } finally {
      released.resolve(f.snapshot);
      await running;
      await f.runtime.dispose();
    }
  });

  it("uses the committed Host snapshot rather than the model's TodoWrite arguments", async () => {
    const f = fixture([discover, write(), { text: "Done." }]);
    f.setReadSnapshot(async () => ({ ...f.snapshot, todos: completed }));
    try {
      await f.runtime.prompt("Finish the work.");
      expect(f.requests).toHaveLength(3);
    } finally { await f.runtime.dispose(); }
  });
});
