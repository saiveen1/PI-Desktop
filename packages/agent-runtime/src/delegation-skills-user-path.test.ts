import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import { parseSubagentDefinition, type AgentEventEnvelope, type SubagentDefinition } from "@pi-desktop/shared";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";
import { genericModelConfig } from "./model-capabilities.js";
import { BUILTIN_SUBAGENT_DOCUMENTS } from "./subagent-definitions.js";

const transport = vi.hoisted(() => vi.fn<Models["streamSimple"]>());
vi.mock("./provider-binding.js", async original => {
  const actual = await original<typeof import("./provider-binding.js")>();
  return { ...actual, createProviderModels: (...args: Parameters<typeof actual.createProviderModels>) => {
    const models = actual.createProviderModels(...args);
    models.streamSimple = transport;
    return models;
  } };
});

const skill = { id: "fixture/review", name: "Fixture review", description: "Review isolated fixture evidence." };
const otherSkill = { id: "fixture/test", name: "Fixture test", description: "Run isolated fixture checks." };
const skillBody = "# Fixture review\nReport only verified evidence.";
const deniedBody = "Skill: fixture/review is disabled.";
const definitions = BUILTIN_SUBAGENT_DOCUMENTS.map(document => {
  const parsed = parseSubagentDefinition(document, { source: "builtin" });
  if (!parsed.ok) throw new Error("Invalid builtin fixture definition");
  return parsed.definition;
});
const reader: SubagentDefinition = {
  name: "reader", description: "Read isolated evidence", tools: ["Read"],
  prompt: "Read evidence without modifying files.", source: "user",
};

function provider(modelId: string): RuntimeProviderConfig {
  return { id: "fixture", name: "Fixture", modelId, authKind: "none", apiKey: "",
    supportsReasoning: false, supportedThinkingLevels: ["off"],
    modelConfig: genericModelConfig(modelId, "http://fixture.invalid/v1") };
}

function reply(content: AssistantMessage["content"]) {
  const stream = createAssistantMessageEventStream();
  const stopReason = content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
  const message: AssistantMessage = {
    role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
    timestamp: Date.now(), content, stopReason,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: stopReason, message });
    stream.end(message);
  });
  return stream;
}

type ToolArgs = Extract<AssistantMessage["content"][number], { type: "toolCall" }>["arguments"];
function call(name: string, args: ToolArgs): AssistantMessage["content"] {
  return [{ type: "toolCall", id: crypto.randomUUID(), name, arguments: args }];
}

function fixture(definition: SubagentDefinition, options: { skills?: boolean; denied?: boolean; load?: string | false } = {}) {
  const sessionId = "delegation-skills-fixture";
  const events: AgentEventEnvelope[] = [];
  const taskDescriptions: string[] = [];
  const executions: unknown[] = [];
  const children: Array<{ tools: string[]; prompt: string; messages: string }> = [];
  let parentRequests = 0;
  transport.mockImplementation((model, context) => {
    if (model.id === "parent") {
      taskDescriptions.push(getCurrentTools(context.messages).find(tool => tool.name === "Task")?.description ?? "");
      parentRequests++;
      return reply(parentRequests === 1
        ? call("Task", { agent: definition.name, task: "Load fixture/review before reviewing evidence." })
        : parentRequests === 2 ? call("TaskWait", {})
          : [{ type: "text", text: "Review incorporated." }]);
    }
    children.push({ tools: getCurrentTools(context.messages).map(tool => tool.name),
      prompt: getCurrentSystemPrompt(context.messages), messages: JSON.stringify(context.messages) });
    return reply(children.length === 1 && options.skills !== false && options.load !== false
      ? call("Skill", { id: options.load ?? skill.id })
      : [{ type: "text", text: "Fixture review complete." }]);
  });
  const runtime = new DesktopAgentRuntime({
    sessionId, mode: "agent", provider: provider("parent"), thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    subagents: [{ ...definition, model: { providerId: "fixture", modelId: "child" } }],
    subagentProviders: { "fixture/child": provider("child") },
    pluginSkills: options.skills === false ? [] : [skill, otherSkill],
    pluginTools: [{ name: "plugin_fixture_mutate", description: "Must not be inherited implicitly", parameters: {} }],
    projectInstructions: { entries: [{ source: "AGENTS.md", content: "Follow the fixture review skill." }] },
    host: { call: async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
      if (method === "provider.delegationSnapshot" || method === "session.appendMessage") return undefined as T;
      if (method === "todos.get") return { sessionId, todos: [] } as T;
      if (method === "tools.execute") {
        executions.push(params);
        return (options.denied
          ? { ok: false, isError: true, content: deniedBody }
          : { ok: true, content: skillBody }) as T;
      }
      throw new Error(`Unexpected host method ${method}`);
    } },
    onEvent: event => events.push(event),
  });
  return { runtime, events, executions, children, taskDescriptions, sessionId,
    prompt: () => runtime.prompt("Delegate the isolated review.", crypto.randomUUID(), crypto.randomUUID()),
  };
}

function skillResult(events: AgentEventEnvelope[]) {
  const start = events.find(({ event }) => event.type === "tool_start" && event.toolName === "Skill");
  if (start?.event.type !== "tool_start") return undefined;
  const callId = start.event.toolCallId;
  return events.find(({ event }) => event.type === "tool_end" && event.toolCallId === callId);
}

beforeEach(() => { transport.mockReset(); });

describe("delegated skills through real parent and child agent loops", () => {
  it.each([...definitions, reader])("loads a skill on the first $name turn without inheriting other parent tools", async definition => {
    const f = fixture(definition);
    try {
      await f.prompt();
      expect(f.events.filter(({ event }) => event.type === "error")).toEqual([]);
      expect(f.taskDescriptions[0]).toContain("restricted by each role's skills selection");
      expect(f.children).toHaveLength(2);
      const first = f.children[0];
      expect(first.tools.filter(name => name !== "TaskReport")).toEqual([...definition.tools, "Skill"]);
      expect(first.prompt).toContain("# Skills");
      expect(first.prompt).toContain(skill.id);
      expect(first.prompt).toContain(otherSkill.id);
      expect(first.prompt).not.toContain(skillBody);
      expect(first.prompt.indexOf("# Skills")).toBeLessThan(first.prompt.indexOf("# Project instructions"));
      if (definition.name === "code-reviewer" || definition.name === "reader") {
        expect(first.prompt).toContain("You have no tools that change files or run commands");
      }
      expect(f.executions).toEqual([expect.objectContaining({
        sessionId: f.sessionId, toolName: "Skill", args: { id: skill.id },
      })]);
      expect(f.children[1].messages).toContain("Report only verified evidence.");
      expect(skillResult(f.events)).toMatchObject({ agentName: definition.name, parentToolCallId: expect.any(String), event: { isError: false } });
    } finally { await f.runtime.dispose(); }
  });

  it("omits both the loader and catalog when the parent has no skills", async () => {
    const f = fixture(reader, { skills: false });
    try {
      await f.prompt();
      expect(f.children).toHaveLength(1);
      expect(f.children[0].tools.filter(name => name !== "TaskReport")).toEqual(["Read"]);
      expect(f.children[0].prompt).not.toContain("# Skills");
      expect(f.executions).toEqual([]);
    } finally { await f.runtime.dispose(); }
  });

  it("preserves a host denial as an attributed child tool error", async () => {
    const f = fixture(reader, { denied: true });
    try {
      await f.prompt();
      expect(f.executions).toHaveLength(1);
      expect(f.children[1].messages).toContain(deniedBody);
      expect(f.children[1].messages).not.toContain(skillBody);
      expect(skillResult(f.events)).toMatchObject({ agentName: "reader", parentToolCallId: expect.any(String), event: { isError: true } });
    } finally { await f.runtime.dispose(); }
  });

  it("restricts a selected subset and ignores unknown IDs without inheriting executable tools", async () => {
    const f = fixture({ ...reader, skills: [skill.id, "missing", skill.id] });
    try {
      await f.prompt();
      expect(f.children[0].tools.filter(name => name !== "TaskReport")).toEqual(["Read", "Skill"]);
      expect(f.children[0].prompt).toContain(skill.id);
      expect(f.children[0].prompt).not.toContain(otherSkill.id);
      expect(f.children[0].prompt).not.toContain("`missing`");
      expect(f.executions).toEqual([expect.objectContaining({ toolName: "Skill", args: { id: skill.id } })]);
    } finally { await f.runtime.dispose(); }
  });

  it.each([{ skills: [] }, { skills: ["missing"] }])("omits the loader and catalog for an empty effective selection $skills", async ({ skills }) => {
    const f = fixture({ ...reader, skills }, { load: false });
    try {
      await f.prompt();
      expect(f.children).toHaveLength(1);
      expect(f.children[0].tools.filter(name => name !== "TaskReport")).toEqual(["Read"]);
      expect(f.children[0].prompt).not.toContain("# Skills");
      expect(f.executions).toEqual([]);
    } finally { await f.runtime.dispose(); }
  });

  it("rejects a forged out-of-selection Skill load before reaching the Host", async () => {
    const f = fixture({ ...reader, skills: [skill.id] }, { load: otherSkill.id });
    try {
      await f.prompt();
      expect(f.children[0].prompt).not.toContain(otherSkill.id);
      expect(f.executions).toEqual([]);
      expect(f.children[1].messages).toContain("Skill is not available to this subagent.");
      expect(skillResult(f.events)).toMatchObject({ agentName: "reader", event: { isError: true } });
    } finally { await f.runtime.dispose(); }
  });

  it("keeps the existing tools: inherit deny rules while disabling skills", async () => {
    const f = fixture({ ...reader, tools: [], inheritTools: true, skills: [] }, { load: false });
    try {
      await f.prompt();
      expect(f.children[0].tools).toContain("plugin_fixture_mutate");
      for (const denied of ["Skill", "Task", "TaskWait", "TaskList", "TaskStop", "ToolSearch", "asktool", "new_context"]) {
        expect(f.children[0].tools).not.toContain(denied);
      }
      expect(f.children[0].prompt).not.toContain("# Skills");
      expect(f.executions).toEqual([]);
    } finally { await f.runtime.dispose(); }
  });

});
