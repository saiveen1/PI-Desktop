import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, type AssistantMessage, type Context, type Models } from "@earendil-works/pi-ai";
import type { SessionPersona, UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";
import { genericModelConfig } from "./model-capabilities.js";
import { delegationPersona, personaSystemPrompt, restoredDelegationPersona, withPersonaPrefix } from "./persona-prompt.js";

const transport = vi.hoisted(() => vi.fn<Models["streamSimple"]>());
vi.mock("./provider-binding.js", async original => {
  const actual = await original<typeof import("./provider-binding.js")>();
  return { ...actual, createProviderModels: (...args: Parameters<typeof actual.createProviderModels>) => {
    const models = actual.createProviderModels(...args);
    models.streamSimple = transport;
    return models;
  } };
});
const persona = (name: string, inheritToSubagents = false): SessionPersona => ({
  version: 1, definition: { id: name, name, prompt: `Act as the ${name} persona.` },
  revision: (name === "first" ? "a" : "b").repeat(64), inheritToSubagents,
});
function provider(modelId: string): RuntimeProviderConfig {
  return { id: "fixture", name: "Fixture", modelId, authKind: "none", apiKey: "",
    supportsReasoning: false, supportedThinkingLevels: ["off"],
    modelConfig: genericModelConfig(modelId, "http://persona.fixture.invalid/v1") };
}
function reply(content: AssistantMessage["content"]) {
  const stream = createAssistantMessageEventStream();
  const stopReason = content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
  const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
    timestamp: Date.now(), content, stopReason,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: stopReason, message }); stream.end(message); });
  return stream;
}
function fixture(options: { persona?: SessionPersona | null; history?: UiMessage[]; delegate?: boolean; resume?: string; scratchDir?: string; readChild?: boolean } = {}) {
  const rows = new Map<string, UiMessage>();
  const requests: Array<{ model: string; prompt: string; context: Context }> = [];
  const errors: unknown[] = [];
  let parentRequests = 0;
  let childRequests = 0;
  transport.mockImplementation((model, context) => {
    requests.push({ model: model.id, prompt: getCurrentSystemPrompt(context.messages), context: structuredClone(context) });
    if (model.id === "parent" && options.delegate) {
      parentRequests++;
      if (parentRequests <= 2) return reply([{ type: "toolCall", id: crypto.randomUUID(),
        name: parentRequests === 1 ? "Task" : "TaskWait",
        arguments: parentRequests === 1 ? { agent: "worker", task: "Read the delegated fixture and report.", ...(options.resume ? { resume: options.resume } : {}) } : {} }]);
    }
    if (model.id === "child" && options.readChild && childRequests++ === 0) {
      return reply([{ type: "toolCall", id: crypto.randomUUID(), name: "Read", arguments: { path: "nested/fixture.ts" } }]);
    }
    return reply([{ type: "text", text: model.id === "parent" ? "The fixture is complete." : "The child fixture is complete." }]);
  });
  const runtime = new DesktopAgentRuntime({
    sessionId: "persona-fixture", mode: "agent", provider: provider("parent"), thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    persona: options.persona, history: options.history, scratchDir: options.scratchDir,
    customSystemPrompt: { replace: "The file persona opening.", append: "The file appendix." },
    projectInstructions: { entries: [{ source: "AGENTS.md", content: "Keep the project test rules." }] },
    subagents: [{ name: "worker", description: "Read fixture evidence", source: "user", tools: ["Read"],
      model: { providerId: "fixture", modelId: "child" }, prompt: "Perform the specialist reading task." }],
    subagentProviders: { "fixture/child": provider("child") },
    host: { call: async <T>(method: string, params?: unknown): Promise<T> => {
      let result: unknown;
      if (method === "tools.fileBatchCapabilities") result = { version: 1, supported: false };
      else if (method === "provider.delegationSnapshot") result = undefined;
      else if (method === "session.appendMessage") { const { message } = params as { message: UiMessage }; rows.set(message.id, message); }
      else if (method === "todos.get") result = { sessionId: "persona-fixture", todos: [] };
      else if (method === "session.appendCompaction") result = undefined;
      else if (method === "project.instructions.resolve") result = { entries: [{ source: "nested/AGENTS.md", content: "Scoped nested fixture rules." }] };
      else if (method === "tools.execute") result = { ok: true, content: "Fixture source contents." };
      else throw new Error(`Unexpected Host call: ${method}`);
      return result as T;
    } },
    onEvent: ({ event }) => {
      if (event.type === "message_end") rows.set(event.message.id, event.message);
      if (event.type === "error") errors.push(event.error);
    },
  });
  return { runtime, requests, errors, history: () => structuredClone([...rows.values()]),
    prompt: () => runtime.prompt("Private main-conversation context: ROOT-ONLY-MARKER.", crypto.randomUUID(), crypto.randomUUID()) };
}
beforeEach(() => { transport.mockReset(); });

describe("session personas through actual main and child agent loops", () => {
  it("preserves the existing file-based identity when no persona is selected", async () => {
    const f = fixture();
    try { await f.prompt(); expect(f.errors).toEqual([]); expect(f.requests[0].prompt).toMatch(/^The file persona opening\./); expect(f.requests[0].prompt).not.toContain("Session persona precedence"); }
    finally { await f.runtime.dispose(); }
  });

  it("replaces only the identity opening and keeps operating/project instructions", async () => {
    const selected = persona("first"); const f = fixture({ persona: selected });
    try {
      await f.prompt(); expect(f.errors).toEqual([]);
      const prompt = f.requests[0].prompt;
      expect(prompt.startsWith(personaSystemPrompt(selected)!)).toBe(true);
      expect(prompt).not.toContain("The file persona opening.");
      for (const text of ["Complete the requested work", "Keep the project test rules.", "The file appendix.", "You are operating in Agent mode."]) expect(prompt).toContain(text);
    } finally { await f.runtime.dispose(); }
  });

  it.each([false, true])("includes a child persona only when inheritance is %s", async inherit => {
    const selected = persona("first", inherit); const f = fixture({ persona: selected, delegate: true });
    try {
      await f.prompt(); expect(f.errors).toEqual([]);
      const child = f.requests.find(request => request.model === "child"); expect(child).toBeDefined();
      expect(child!.prompt.startsWith(selected.definition.prompt)).toBe(inherit);
      expect(child!.prompt).toContain("Perform the specialist reading task.");
      expect(child!.prompt).toContain("Keep the project test rules.");
      expect(child!.prompt).toContain("Subagent work budget");
      expect(child!.prompt).not.toContain("The file appendix.");
      expect(JSON.stringify(child!.context.messages)).not.toContain("ROOT-ONLY-MARKER");
    } finally { await f.runtime.dispose(); }
  });

  it.each([false, true])("restart and resume retain the original inheritance decision (%s)", async inherit => {
    const first = fixture({ persona: persona("first", inherit), delegate: true });
    let history: UiMessage[] = []; let delegationId = "";
    try {
      await first.prompt(); expect(first.errors).toEqual([]); history = first.history();
      const task = history.find(row => row.toolName === "Task");
      const result = task?.toolResult as { details: { delegationId: string; persona?: SessionPersona } };
      delegationId = result.details.delegationId;
      expect(result.details.persona?.definition.id).toBe(inherit ? "first" : undefined);
    } finally { await first.runtime.dispose(); }
    const before = JSON.stringify(history);
    const second = fixture({ persona: persona("second", true), delegate: true, resume: delegationId, history });
    try {
      await second.prompt(); expect(second.errors).toEqual([]);
      expect(second.requests[0].prompt.startsWith("Act as the second persona.")).toBe(true);
      const child = second.requests.find(request => request.model === "child"); expect(child).toBeDefined();
      expect(child!.prompt).not.toContain("Act as the second persona.");
      expect(child!.prompt.startsWith("Act as the first persona.")).toBe(inherit);
      expect(JSON.stringify(history)).toBe(before);
    } finally { await second.runtime.dispose(); }
  });

  it("clearing a persona replaces its effective prompt without rewriting history", async () => {
    const first = fixture({ persona: persona("first") }); let history: UiMessage[] = [];
    try { await first.prompt(); history = first.history(); } finally { await first.runtime.dispose(); }
    const before = JSON.stringify(history); const next = fixture({ persona: null, history });
    try { await next.prompt(); expect(next.requests[0].prompt.startsWith("The file persona opening.")).toBe(true); expect(next.requests[0].prompt).not.toContain("Act as the first persona."); expect(JSON.stringify(history)).toBe(before); }
    finally { await next.runtime.dispose(); }
  });

  it("retains the persona through manual context compaction", async () => {
    const selected = persona("first"), f = fixture({ persona: selected });
    const summary = vi.spyOn(f.runtime["models"], "completeSimple").mockResolvedValue({ role: "assistant", api: "openai-completions", provider: "fixture", model: "parent", content: [{ type: "text", text: "The fixture task is complete." }], stopReason: "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    try { await f.prompt(); await f.runtime.compactManually(); expect(summary).toHaveBeenCalled(); await f.prompt(); expect(f.requests.at(-1)!.prompt.startsWith(personaSystemPrompt(selected)!)).toBe(true); }
    finally { await f.runtime.dispose(); }
  });

  it("keeps the captured child persona when a Read refreshes path-specific instructions", async () => {
    const selected = persona("first", true), f = fixture({ persona: selected, delegate: true, readChild: true });
    try {
      await f.prompt(); expect(f.errors).toEqual([]);
      const requests = f.requests.filter(request => request.model === "child");
      expect(requests).toHaveLength(2);
      expect(requests[1].prompt, JSON.stringify(requests[1].context.messages.filter(row => row.role === "toolResult"))).toContain("Scoped nested fixture rules.");
      expect(requests.every(request => request.prompt.startsWith(personaSystemPrompt(selected)!))).toBe(true);
      expect(f.runtime.personaConfigurationBlocked()).toBe(false);
    } finally { await f.runtime.dispose(); }
  });

  it("writes the exact child snapshot into the durable checkpoint", async () => {
    const scratchDir = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "persona-checkpoint-"));
    const selected = persona("first", true), f = fixture({ persona: selected, delegate: true, scratchDir });
    try {
      await f.prompt(); expect(f.errors).toEqual([]);
      const task = f.history().find(row => row.toolName === "Task");
      const result = task?.toolResult as { details: { checkpointPath: string; delegationId: string } };
      const checkpoint = JSON.parse(await readFile(result.details.checkpointPath, "utf8"));
      expect(checkpoint.persona).toEqual(selected);
      const { readSubagentCheckpoint } = await import("./subagent-checkpoint.js");
      const location = { scratchDir, sessionId: "persona-fixture", agentName: "worker", delegateSessionId: result.details.delegationId, parentToolCallId: task!.toolCallId! };
      expect(readSubagentCheckpoint(location).checkpoint?.persona).toEqual(selected);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(result.details.checkpointPath, JSON.stringify({ ...checkpoint, persona: { ...selected, version: 2 } }));
      expect(readSubagentCheckpoint(location).error).toBe("checkpoint-invalid-persona");
    } finally { await f.runtime.dispose(); await rm(scratchDir, { recursive: true, force: true }); }
  });
});

describe("persona precedence and restore boundaries", () => {
  it("preserves an unchanged prefix and restores it after an extension replacement", () => {
    const selected = persona("first"), prefixed = withPersonaPrefix("Extension text.", selected);
    expect(prefixed.startsWith(selected.definition.prompt)).toBe(true);
    expect(withPersonaPrefix(prefixed, selected)).toBe(prefixed);
    expect(withPersonaPrefix("Legacy prompt.")).toBe("Legacy prompt.");
  });
  it("does not treat a resolved historical plan ID as a pending approval", async () => {
    const f = fixture();
    try {
      f.runtime["pendingPlanId"] = "historical-plan-already-rejected-by-host";
      expect(f.runtime.personaConfigurationBlocked()).toBe(false);
    } finally { await f.runtime.dispose(); }
  });

  it("does not grant a persona to a legacy chain and rejects corrupted snapshots", () => {
    expect(delegationPersona(persona("second", true), {})).toBeUndefined();
    expect(() => delegationPersona(persona("second", true), restoredDelegationPersona({ version: 9 }))).toThrow("invalid persona snapshot");
    expect(() => delegationPersona(persona("second", true), restoredDelegationPersona(null))).toThrow("invalid persona snapshot");
  });
});
