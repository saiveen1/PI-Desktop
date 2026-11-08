import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";

type Step = { name: string; args: ToolCall["arguments"] };
type HostResult = { ok: boolean; errorCode?: string; content: unknown };
const write: Step = { name: "Write", args: { path: "fixture.ts", content: "export {};" } };
const edit: Step = { name: "Edit", args: { path: "fixture.ts", tag: "ABCD", ops: "PUT 1.=1:\n+export {};" } };
const success: HostResult = { ok: true, content: { tag: "ABCD" } };
const overloaded: HostResult = { ok: false, errorCode: "HOST_OVERLOADED", content: { code: "HOST_OVERLOADED" } };

function fixture(results: HostResult[] = []) {
  const events: AgentEventEnvelope[] = [];
  const dispatch = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false };
    if (method === "todos.get") return { sessionId: "harness-fixture", todos: [] };
    if (method === "backgroundJobs.capabilities") return { version: 1, supported: true };
    if (method === "backgroundJobs.wait" || method === "backgroundJobs.stop") {
      return { job: { kind: "bash", id: "process" }, state: "exited", exitCode: 0, stdout: "done", stderr: "", truncated: false };
    }
    if (method === "tools.execute") return results.shift() ?? success;
    return undefined;
  });
  const runtime = new DesktopAgentRuntime({
    sessionId: "harness-fixture", mode: "agent", thinkingLevel: "off",
    provider: { id: "fixture", name: "Fixture", modelId: "fixture", apiKey: "fixture",
      baseUrl: "http://localhost/v1", supportsReasoning: false, supportedThinkingLevels: ["off"] },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: async <T>(method: string, params?: unknown) => await dispatch(method, params) as T },
    onEvent: event => events.push(event),
  });
  let id = 0;
  const script = (steps: Step[]) => {
    let round = 0;
    vi.spyOn(runtime["models"], "streamSimple").mockImplementation(() => {
      if (round > steps.length) throw new Error("Unexpected provider retry");
      const step = steps[round++];
      const message: AssistantMessage = {
        role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
        content: step ? [{ type: "toolCall", id: `call-${++id}`, name: step.name, arguments: step.args }]
          : [{ type: "text", text: "Done." }],
        stopReason: step ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: step ? "toolUse" : "stop", message });
        stream.end(message);
      });
      return stream;
    });
  };
  return { runtime, dispatch, events, script };
}

describe("harness recovery through the production Agent loop", () => {
  it("normalizes Bash-only job arguments before schema validation and preserves invalid job/timeout rejection", async () => {
    const f = fixture();
    const job = { kind: "bash", id: "process" };
    const original = { job, delegationIds: [], mode: "all", minCompleted: 0, timeoutSeconds: 1 };
    try {
      f.script([
        { name: "TaskWait", args: original },
        { name: "TaskStop", args: { ...original, minCompleted: "unused" } },
        { name: "TaskWait", args: { ...original, job: { kind: "bash", id: "" } } },
        { name: "TaskWait", args: { ...original, timeoutSeconds: 0 } },
        { name: "TaskWait", args: { ...original, job: { kind: "delegation", id: "delegate" } } },
      ]);
      await f.runtime.prompt("Observe and stop only the selected fixture job.");
      const ended = f.events.flatMap(({ event }) => event.type === "tool_end" ? [event] : []);
      expect(ended).toHaveLength(5);
      expect(ended.map(row => Boolean(row.isError))).toEqual([false, false, true, true, true]);
      expect(f.dispatch.mock.calls.filter(([method]) => method === "backgroundJobs.wait")).toEqual([
        ["backgroundJobs.wait", { sessionId: "harness-fixture", id: "process", timeoutMs: 0 }],
      ]);
      expect(f.dispatch.mock.calls.filter(([method]) => method === "backgroundJobs.stop")).toHaveLength(1);
      expect(original.minCompleted).toBe(0);
      expect(original).toHaveProperty("delegationIds", []);
    } finally { await f.runtime.dispose(); }
  });

  it.each([write, { name: "Read", args: { path: "fixture.ts" } }])("bounds Host admission failures separately and accepts a follow-up ($name)", async step => {
    const f = fixture([overloaded, overloaded, overloaded]);
    try {
      f.script([step, step, step, step]);
      await f.runtime.prompt("Run the fixture operation.");
      expect(f.dispatch.mock.calls.filter(([method]) => method === "tools.execute")).toHaveLength(3);
      const errors = f.events.flatMap(({ event }) => event.type === "error" ? [event.error] : []);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ code: "HOST_OVERLOADED", retriable: true, details: { kind: "host-admission" } });
      expect(errors[0]?.message).not.toContain("failed file mutations");
      expect(JSON.stringify(errors[0])).not.toContain("narrower Edit");
      f.script([step]);
      await f.runtime.prompt("Continue after capacity is available.");
      expect(f.dispatch.mock.calls.filter(([method]) => method === "tools.execute")).toHaveLength(4);
    } finally { await f.runtime.dispose(); }
  });

  it("does not spend file recovery budget on intervening admission failures", async () => {
    const invalid: HostResult = { ok: false, errorCode: "EDIT_PARSE_FAILED", content: { code: "EDIT_PARSE_FAILED" } };
    const f = fixture([invalid, overloaded, invalid, success]);
    try {
      f.script([edit, edit, edit, edit]);
      await f.runtime.prompt("Correct the fixture edit.");
      expect(f.dispatch.mock.calls.filter(([method]) => method === "tools.execute")).toHaveLength(4);
      expect(f.events.filter(({ event }) => event.type === "error")).toEqual([]);
    } finally { await f.runtime.dispose(); }
  });

  it("allows bounded new complete line reveals without spending the mutation budget", async () => {
    const reveal = (line: number): HostResult => ({ ok: false, errorCode: "EDIT_LINES_UNSEEN",
      content: { code: "EDIT_LINES_UNSEEN", merged: true, revealTruncated: false, unseenCount: 1,
        unseenLines: [{ line, text: `fixture ${line}`, clipped: false }] } });
    const f = fixture([reveal(1), reveal(2), reveal(3), reveal(4), success]);
    try {
      f.script([edit, edit, edit, edit, edit]);
      await f.runtime.prompt("Review newly revealed lines before retrying the edit.");
      expect(f.dispatch.mock.calls.filter(([method]) => method === "tools.execute")).toHaveLength(5);
      expect(f.events.filter(({ event }) => event.type === "error")).toEqual([]);
    } finally { await f.runtime.dispose(); }
  });
});

it("distinguishes observation intervals from execution deadlines without rewriting explicit Bash options", async () => {
  const f = fixture();
  try {
    const bash = f.runtime["agent"].state.tools.find(tool => tool.name === "Bash");
    expect(bash?.description).toContain("execution deadline, not a progress-check interval");
    expect(bash?.description).toContain("do not replay side-effecting commands automatically");
    f.script([
      { name: "Bash", args: { command: "fixture-default" } },
      { name: "Bash", args: { command: "fixture-explicit", timeout: 30 } },
      { name: "Bash", args: { command: "fixture-background", runInBackground: true } },
    ]);
    await f.runtime.prompt("Run the synthetic budget checks.");
    const calls = f.dispatch.mock.calls.filter(([method]) => method === "tools.execute");
    expect(calls).toHaveLength(3);
    expect(calls[0]?.[1]).toMatchObject({ timeoutMs: 60_000 });
    expect(calls[1]?.[1]).toMatchObject({ timeoutMs: 30_000 });
    expect(calls[2]?.[1]).toMatchObject({ runInBackground: true });
  } finally { await f.runtime.dispose(); }
});

it("attributes a delegate's read admission exhaustion to that delegate, not its parent", async () => {
  const f = fixture([overloaded, overloaded, overloaded]);
  try {
    const read = f.runtime["agent"].state.tools.find(tool => tool.name === "Read");
    if (!read) throw new Error("Missing Read tool");
    const [scoped] = f.runtime["scopeDelegateTools"]([read], {
      name: "reader", description: "Fixture", prompt: "Read", tools: ["Read"], source: "builtin",
    }, "reader-owner");
    if (!scoped) throw new Error("Missing scoped Read tool");
    for (let i = 0; i < 2; i++) expect(await scoped.execute(`read-${i}`, { path: "fixture.ts" })).not.toHaveProperty("terminate", true);
    expect(await scoped.execute("read-final", { path: "fixture.ts" })).toHaveProperty("terminate", true);
    expect(f.runtime["delegateMutationTerminations"].get("read-final")).toMatchObject({ code: "HOST_OVERLOADED" });
    expect(f.runtime["pendingMutationTermination"]).toBeUndefined();
    f.script([write]);
    await f.runtime.prompt("Continue independent parent work.");
    expect(f.events.filter(({ event }) => event.type === "error")).toEqual([]);
  } finally { await f.runtime.dispose(); }
});
