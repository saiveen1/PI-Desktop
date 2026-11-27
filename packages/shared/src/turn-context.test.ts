import { describe, expect, it } from "vitest";
import { historyForModelContext, messageForModelContext, type MessageContextOverride } from "./turn-context.js";
import type { UiMessage } from "./types/messages.js";

const row: UiMessage = {
  id: "a", role: "assistant", content: "Original answer", thinking: "Original thinking", createdAt: "now",
  providerReplay: { version: 1, blocks: [
    { type: "thinking", length: 17, signature: "thinking-signature" },
    { type: "text", length: 15, signature: "answer-signature" },
  ], toolCalls: [{ id: "call", signature: "call-signature" }] },
};
const withOverride = (override: MessageContextOverride) => ({ ...structuredClone(row), contextOverride: override });
describe("human-authored model context overlays", () => {
  it("cuts at the latest marked genuine user, not nested, steering, system or display-only rows", () => {
    const prompt: UiMessage = { id: "prompt", role: "user", content: "keep", createdAt: "now",
      contextOverride: { version: 1, excludePreviousTurns: true } };
    const suffix = ([
      { ...prompt, role: "assistant" }, { ...prompt, role: "tool" }, { ...prompt, role: "system" },
      { ...prompt, parentToolCallId: "p" }, { ...prompt, nestedParentToolCallId: "n" },
      { ...prompt, agentName: "child" }, { ...prompt, steering: true }, { ...prompt, toolName: "Task" },
      { ...prompt, sessionMessage: { sourceSessionId: "other", sourceTitle: "other", targetSessionId: "here", messageId: "m", kind: "message" } },
      { ...prompt, modelSystem: { version: 1, messageJson: "{}" } },
      { ...prompt, contextOverride: undefined, excludedByContextBoundary: true },
    ] satisfies UiMessage[]).map((m, i) => ({ ...m, id: String(i) }));
    const before = [row, { ...prompt, id: "prior-cut" }, row];
    expect(historyForModelContext([...before, prompt, ...suffix]).map(m => m.id)).toEqual([prompt, ...suffix].map(m => m.id));
    expect(historyForModelContext(before).map(m => m.id)).toEqual(["prior-cut", row.id]);
    expect(historyForModelContext([row, ...suffix]).map(m => m.id)).toEqual([row, ...suffix].map(m => m.id));
  });
  it("preserves original history and untouched signed channels while changing answer context", () => {
    const original = withOverride({ version: 1, content: "Corrected" });
    const before = structuredClone(original);
    const projected = messageForModelContext(original)!;
    expect(projected.content).toBe("Corrected");
    expect(projected.thinking).toBe(row.thinking);
    expect(projected.providerReplay?.blocks).toEqual([
      row.providerReplay!.blocks[0], { type: "text", length: 9 },
    ]);
    expect(projected.providerReplay?.toolCalls).toEqual(row.providerReplay!.toolCalls);
    expect(original).toEqual(before);
  });
  it("edits thinking without reusing its old signature and permits inclusion over a legacy exclusion", () => {
    const projected = messageForModelContext({ ...withOverride({ version: 1, thinking: "New plan", excludeThinking: false }), excludeThinkingFromContext: true })!;
    expect(projected.thinking).toBe("New plan");
    expect(projected.excludeThinkingFromContext).toBe(false);
    expect(projected.providerReplay?.blocks).toEqual([{ type: "thinking", length: 8 }, row.providerReplay!.blocks[1]]);
  });
  it("excludes text and hosted-search replay without dropping the tool carrier identity", () => {
    const projected = messageForModelContext({ ...withOverride({ version: 1, excludeContent: true, excludeThinking: true }), hostedSearch: { status: "completed", rounds: [] } })!;
    expect(projected.content).toBe("");
    expect(projected.hostedSearch).toBeUndefined();
    expect(projected.id).toBe("a");
    expect(projected.excludeThinkingFromContext).toBe(true);
    expect(projected.providerReplay?.blocks.every(block => block.type !== "text")).toBe(true);
  });
  it("excludes a tool row as a pair or substitutes context-only arguments and result text", () => {
    const tool: UiMessage = { id: "t", role: "tool", content: "original receipt", toolName: "Read", toolCallId: "call", toolArgs: { path: "original" }, toolResult: { content: "original result" }, toolStatus: "error", isError: true, createdAt: "now" };
    const excluded = { ...tool, contextOverride: { version: 1 as const, excludeTool: true } };
    expect(historyForModelContext([row, excluded])).toEqual([row]);
    const edited = messageForModelContext({ ...tool, contextOverride: { version: 1, toolArgs: { path: "edited" }, toolResultText: "summary" } })!;
    expect(edited.toolArgs).toEqual({ path: "edited" });
    expect(edited.toolResult).toEqual({ content: [{ type: "text", text: "summary" }] });
    expect(edited.toolCallId).toBe("call");
    expect(edited.isError).toBe(true);
    expect(tool.toolArgs).toEqual({ path: "original" });
  });
  it("does not let context overrides change user, system or delegated messages", () => {
    for (const message of [
      { ...withOverride({ version: 1, content: "fake" }), role: "user" as const },
      { ...withOverride({ version: 1, content: "fake" }), role: "system" as const },
      { ...withOverride({ version: 1, content: "fake" }), parentToolCallId: "task" },
    ]) expect(messageForModelContext(message)).toBe(message);
  });
});
