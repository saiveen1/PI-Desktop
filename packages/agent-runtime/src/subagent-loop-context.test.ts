import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDelegateTurnContext } from "./subagent-context.js";
import { createCompactionSummaryMessage } from "./pi-runtime-messages.js";
import type { SubagentDefinition } from "@pi-desktop/shared";
import { SubagentRun } from "./subagent.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

/**
 * What a turn boundary decides — compact, degrade, or report an overflow — is
 * covered by `subagent-context.test.ts`. This file pins the update the delegate
 * hands the agent loop instead, because that array is the context every later
 * iteration of a run appends to (D620).
 */
vi.mock("./subagent-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-context.js")>();
  return {
    ...actual,
    prepareDelegateTurnContext: vi.fn(async () => ({
      kind: "degraded" as const,
      messages: [],
      tokensBefore: 1,
    })),
  };
});

const provider: RuntimeProviderConfig = {
  id: "local",
  name: "Local",
  baseUrl: "http://127.0.0.1:11434/v1",
  modelId: "local-model",
  apiKey: "",
  authKind: "none",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
};

function definition(): SubagentDefinition {
  return {
    name: "explorer",
    description: "Search the workspace and report findings.",
    tools: ["Read"],
    prompt: "Find the answer and report it.",
    source: "builtin",
  };
}

/** The agent-loop surface the delegate wires a run through. */
type DelegateAgent = {
  state: { messages: unknown[] };
  prepareNextTurnWithContext?: (
    turn: { toolResults: unknown[]; context: { messages: unknown[] } },
    signal: AbortSignal,
  ) => Promise<{ context?: { messages: unknown[] } } | undefined>;
};

function createDelegate(scratchDir?: string): DelegateAgent {
  const run = new SubagentRun({
    definition: definition(),
    sessionId: "session-1",
    scratchDir,
    turnId: "turn-1",
    parentToolCallId: "task-1",
    task: "Find where the permission dialog is rendered.",
    provider,
    thinkingLevel: "off",
    systemPrompt: "system",
    tools: [],
    onEvent: () => undefined,
  });
  return (run as unknown as { agent: DelegateAgent }).agent;
}

/** Minimal pi-ai assistant message, shaped like the ones the loop appends. */
function assistantMessage(text: string) {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "local",
    model: "local-model",
    stopReason: "stop",
    timestamp: 2,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [{ type: "text", text }],
  };
}

describe("SubagentRun loop context ownership (D620)", () => {
  it("hands the loop its own context array at a protected turn boundary", async () => {
    const agent = createDelegate();
    agent.state.messages = [
      { role: "system", content: "system", timestamp: 0 },
      { role: "user", content: "Find the permission dialog.", timestamp: 1 },
    ];

    const update = await agent.prepareNextTurnWithContext!(
      { toolResults: [], context: { messages: [...agent.state.messages] } },
      new AbortController().signal,
    );

    // The boundary protected the request, so it did hand the loop a context.
    expect(update?.context?.messages).toBeDefined();
    const carried = update!.context!.messages;
    // pi's loop appends every streamed assistant message and tool result to the
    // array it was handed, while its `message_end` listener appends the same
    // message to the agent state. Handing over the state's live array would
    // store every message of the run's later iterations twice, and the trailing
    // row `useNextModel` slices off before a fallback would then leave an
    // assistant row at the head of what `continue()` refuses to resume from
    // (D620).
    expect(carried).not.toBe(agent.state.messages);
    const streamed = assistantMessage("round 2");
    carried.push(streamed);
    expect(agent.state.messages).not.toContain(streamed);
  });

  it("persists the existing context summary without requiring a TaskReport call", async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "pi-delegate-summary-"));
    try {
      vi.mocked(prepareDelegateTurnContext).mockResolvedValueOnce({
        kind: "compacted", tokensBefore: 1000,
        messages: [createCompactionSummaryMessage("Confirmed a.ts:12; next inspect b.ts.", 1000, 1)],
      });
      const agent = createDelegate(scratchDir);
      await agent.prepareNextTurnWithContext!(
        { toolResults: [], context: { messages: [...agent.state.messages] } },
        new AbortController().signal,
      );
      const stored = JSON.parse(readFileSync(join(scratchDir, "delegations", "task-1", "checkpoint.json"), "utf8"));
      expect(stored).toMatchObject({ status: "running", contextCompactions: 1 });
      expect(stored.report).toContain("Confirmed a.ts:12; next inspect b.ts.");
    } finally { rmSync(scratchDir, { recursive: true, force: true }); }
  });
});
