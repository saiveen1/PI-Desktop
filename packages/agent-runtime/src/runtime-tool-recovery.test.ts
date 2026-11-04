import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { AgentEventEnvelope, SubagentDefinition } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";

type Call = { name: string; args: ToolCall["arguments"] };
const command: Call = { name: "Bash", args: { command: "fixture-check --private-value" } };
const write: Call = { name: "Write", args: { path: "fixture.ts", content: "export {};" } };
const failure = { ok: false, isError: true, errorCode: "TOOL_FAILED", content: { exitCode: 2, stderr: "fixture failure" } };
const success = { ok: true, content: { tag: "ABCD", exitCode: 0 } };
type Result = { ok: boolean; isError?: boolean; denied?: boolean; errorCode?: string; content: unknown };

function fixture() {
  let result: Result = failure;
  const events: AgentEventEnvelope[] = [];
  const executed: string[] = [];
  const runtime = new DesktopAgentRuntime({
    sessionId: "tool-recovery-fixture", mode: "agent", thinkingLevel: "off",
    provider: { id: "fixture", name: "Fixture", modelId: "fixture", apiKey: "fixture",
      baseUrl: "http://localhost/v1", supportsReasoning: false, supportedThinkingLevels: ["off"] },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: vi.fn(async (method: string, params?: unknown) => {
      if (method === "tools.execute") {
        executed.push((params as { toolName: string }).toolName);
        return result;
      }
      return undefined;
    }) } as never,
    onEvent: (event) => events.push(event),
  });
  const tool = (name: string) => {
    const found = runtime["agent"].state.tools.find((entry) => entry.name === name);
    if (!found) throw new Error(`Missing tool ${name}`);
    return found;
  };
  let id = 0;
  const run = async (call: Call) => tool(call.name).execute(`call-${++id}`, call.args);
  const script = (calls: Call[]) => {
    let round = 0;
    vi.spyOn(runtime["models"], "streamSimple").mockImplementation(() => {
      if (round > calls.length) throw new Error("Unexpected provider retry");
      const call = calls[round++];
      const message: AssistantMessage = {
        role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
        content: call ? [{ type: "toolCall", id: `script-${++id}`, name: call.name, arguments: call.args }]
          : [{ type: "text", text: "Check finished." }],
        stopReason: call ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
        stream.end(message);
      });
      return stream;
    });
  };
  return { runtime, events, executed, tool, run, script, respond: (next: Result) => { result = next; } };
}

describe("runtime tool recovery", () => {
  it.each([[write, "write"], [command, "command"]] as const)("ends repeated failures visibly and accepts a follow-up (%s)", async (call, kind) => {
    const f = fixture();
    try {
      f.script([call, call, call, call]);
      await f.runtime.prompt("Run the fixture check.");
      expect(f.executed).toEqual([call.name, call.name, call.name]);
      const errors = f.events.filter((entry) => entry.event.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.event).toMatchObject({ type: "error", error: {
        code: "MUTATION_RETRY_BUDGET_EXHAUSTED", retriable: true, details: { kind, recovery: expect.any(String) },
      } });
      expect(f.events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({
        type: "message_end", message: expect.objectContaining({ status: "error", isError: true }),
      }) }));
      expect(JSON.stringify(errors)).not.toContain("--private-value");
      f.respond(success);
      f.script([call]);
      await f.runtime.prompt("Continue with the corrected check.");
      expect(f.executed).toHaveLength(4);
      expect(f.runtime["agent"].state.messages.at(-1)).toMatchObject({ stopReason: "stop" });
    } finally { await f.runtime.dispose(); }
  });

  it("keeps different commands independent and resets the successful command", async () => {
    const f = fixture();
    const other: Call = { name: "Bash", args: { command: "other-fixture" } };
    try {
      for (const call of [command, command, other, other]) expect(await f.run(call)).not.toHaveProperty("terminate", true);
      f.respond(success);
      await f.run(command);
      f.respond(failure);
      for (let i = 0; i < 2; i++) expect(await f.run(command)).not.toHaveProperty("terminate", true);
      expect(await f.run(other)).toHaveProperty("terminate", true);
    } finally { await f.runtime.dispose(); }
  });

  it.each(["Write", "Edit"])("restarts command recovery after successful %s before retesting", async (name) => {
    const f = fixture();
    try {
      for (let i = 0; i < 2; i++) await f.run(command);
      f.respond(success);
      await f.run({ name, args: { ...write.args, tag: "ABCD", ops: "PUT 1.=1:\n+export {};" } });
      f.respond(failure);
      for (let i = 0; i < 2; i++) expect(await f.run(command)).not.toHaveProperty("terminate", true);
      expect(await f.run(command)).toHaveProperty("terminate", true);
    } finally { await f.runtime.dispose(); }
  });

  it("restarts command recovery when the failure diagnostic changes", async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 2; i++) await f.run(command);
      f.respond({ ...failure, content: { ...failure.content, stderr: "a different failure" } });
      for (let i = 0; i < 2; i++) expect(await f.run(command)).not.toHaveProperty("terminate", true);
      expect(await f.run(command)).toHaveProperty("terminate", true);
    } finally { await f.runtime.dispose(); }
  });

  it.each(["Write", "Bash"])("ignores cancellation and permission refusals for %s", async (name) => {
    const f = fixture();
    const call = name === "Write" ? write : command;
    try {
      for (const result of [
        { ...failure, denied: true },
        { ...failure, errorCode: "TOOL_ABORTED" },
      ]) {
        f.respond(result);
        for (let i = 0; i < 4; i++) expect(await f.run(call)).not.toHaveProperty("terminate", true);
      }
      f.respond(failure);
      for (let i = 0; i < 2; i++) expect(await f.run(call)).not.toHaveProperty("terminate", true);
      expect(await f.run(call)).toHaveProperty("terminate", true);
    } finally { await f.runtime.dispose(); }
  });

  it("shares the canonical file budget across Write and Edit and resets it after success", async () => {
    const f = fixture();
    const edit: Call = { name: "Edit", args: { path: "./fixture.ts", tag: "ABCD", ops: "PUT 1.=1:\n+export {};" } };
    try {
      await f.run(write);
      await f.run(edit);
      f.respond(success);
      await f.run(write);
      f.respond(failure);
      for (const call of [write, edit]) expect(await f.run(call)).not.toHaveProperty("terminate", true);
      expect(await f.run(write)).toHaveProperty("terminate", true);
    } finally { await f.runtime.dispose(); }
  });

  it("does not reset command failures for a successful Read", async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 2; i++) await f.run(command);
      f.respond(success);
      await f.run({ name: "Read", args: { path: "fixture.ts" } });
      f.respond(failure);
      expect(await f.run(command)).toHaveProperty("terminate", true);
    } finally { await f.runtime.dispose(); }
  });

  it("isolates failure and progress budgets across parent and delegates", async () => {
    const f = fixture();
    const definition: SubagentDefinition = { name: "writer", description: "Fixture writer",
      prompt: "Write", source: "user", tools: ["Write", "Bash"] };
    const [a] = f.runtime["scopeDelegateTools"]([f.tool("Bash")], definition, "delegate-a");
    const [b] = f.runtime["scopeDelegateTools"]([f.tool("Bash")], definition, "delegate-b");
    try {
      for (let i = 0; i < 2; i++) await a!.execute(`a-${i}`, command.args);
      for (let i = 0; i < 2; i++) expect(await b!.execute(`b-${i}`, command.args)).not.toHaveProperty("terminate", true);
      f.respond(success);
      await f.run(write);
      f.runtime["resetRunRecoveryState"]();
      f.respond(failure);
      expect(await a!.execute("a-final", command.args)).toHaveProperty("terminate", true);
      expect(f.runtime["resolveOwnToolOutcome"]({ toolCall: { id: "a-final" } } as never)).toMatchObject({
        isError: true, terminate: true, error: { code: "MUTATION_RETRY_BUDGET_EXHAUSTED" },
      });
      expect(f.runtime["pendingMutationTermination"]).toBeUndefined();
      expect(await f.run(command)).not.toHaveProperty("terminate", true);
    } finally { await f.runtime.dispose(); }
  });
});
