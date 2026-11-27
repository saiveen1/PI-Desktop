import type { AssistantProviderReplayBlock, UiMessage } from "./types/messages.js";

/** Model-context overlays never rewrite the original transcript or execution receipts. */
export type MessageContextOverride = {
  version: 1;
  content?: string;
  thinking?: string;
  excludeContent?: boolean;
  excludeThinking?: boolean;
  toolArgs?: Record<string, unknown>;
  toolResultText?: string;
  excludeTool?: boolean;
  /** Valid only on the genuine top-level user prompt that starts a turn. */
  excludePreviousTurns?: boolean;
};

export type TurnContextMessage = {
  messageId: string;
  role: "assistant" | "tool";
  final: boolean;
  content: string;
  thinking?: string;
  hasThinking: boolean;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResultText?: string;
  override?: MessageContextOverride;
  legacyExcludeThinking?: boolean;
};

export type GetTurnContextRequest = { sessionId: string; anchorMessageId: string };
export type TurnContextSnapshot = GetTurnContextRequest & {
  revision: string;
  isLatestTurn: boolean;
  /** This turn's own user marker, independent of markers on other turns. */
  excludePreviousTurns: boolean;
  messages: TurnContextMessage[];
};
export type TurnContextEdit = { messageId: string; contextOverride: MessageContextOverride | null };
export type EditTurnContextRequest = GetTurnContextRequest & {
  expectedRevision: string;
  edits: TurnContextEdit[];
  restore?: boolean;
  /** Set or clear this turn's user marker; omitted preserves it. */
  excludePreviousTurns?: boolean;
  /** Save-time operation on existing history, not a policy for future turns. */
  excludeHistoryThinking?: boolean;
};
export type TurnContextUpdate = TurnContextEdit & { excludeThinkingFromContext?: boolean };
export type EditTurnContextResult = { snapshot: TurnContextSnapshot; updates: TurnContextUpdate[] };

/** Pure replay projection. Display, copy/export of originals and tool execution use the source row. */
export function messageForModelContext(message: UiMessage): UiMessage | null {
  const override = message.contextOverride;
  if (!override || override.version !== 1 || message.parentToolCallId || message.nestedParentToolCallId || message.agentName) return message;
  if (message.role === "tool") {
    if (override.excludeTool) return null;
    return {
      ...message,
      ...(override.toolArgs === undefined ? {} : { toolArgs: override.toolArgs }),
      ...(override.toolResultText === undefined ? {} : {
        toolResult: { content: [{ type: "text", text: override.toolResultText }] },
        content: override.toolResultText,
      }),
    };
  }
  if (message.role !== "assistant") return message;
  const content = override.excludeContent ? "" : override.content ?? message.content;
  const thinking = override.thinking ?? message.thinking;
  const excludeThinkingFromContext = override.excludeThinking ?? message.excludeThinkingFromContext;
  const contentChanged = content !== message.content;
  const thinkingChanged = thinking !== message.thinking;
  let providerReplay = message.providerReplay;
  if (providerReplay && (contentChanged || thinkingChanged)) {
    let wroteText = false;
    let wroteThinking = false;
    providerReplay = { ...providerReplay, blocks: providerReplay.blocks.flatMap<AssistantProviderReplayBlock>(block => {
      if (block.type === "text" && contentChanged) {
        if (wroteText) return [];
        wroteText = true;
        return content ? [{ type: "text" as const, length: content.length }] : [];
      }
      if (block.type === "thinking" && thinkingChanged) {
        if (wroteThinking) return [];
        wroteThinking = true;
        return thinking ? [{ type: "thinking" as const, length: thinking.length }] : [];
      }
      return [block];
    }) };
    if (contentChanged && content && !wroteText) providerReplay.blocks.push({ type: "text", length: content.length });
    if (thinkingChanged && thinking && !wroteThinking) providerReplay.blocks.push({ type: "thinking", length: thinking.length });
  }
  return { ...message, content, thinking, excludeThinkingFromContext, providerReplay,
    ...(override.excludeContent ? { hostedSearch: undefined } : {}),
  };
}

/** Never infer a boundary from a display annotation, turnId or message content. */
export function contextBoundaryIndex(messages: readonly UiMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.contextOverride?.version === 1 && m.contextOverride.excludePreviousTurns === true &&
        m.role === "user" && m.steering !== true && m.toolName == null && m.parentToolCallId == null &&
        m.nestedParentToolCallId == null && m.agentName == null && m.modelSystem == null && m.sessionMessage == null) return i;
  }
  return -1;
}

export function historyForModelContext(messages: readonly UiMessage[]): UiMessage[] {
  const boundary = contextBoundaryIndex(messages);
  return (boundary < 0 ? messages : messages.slice(boundary)).flatMap(message => {
    const projected = messageForModelContext(message);
    return projected ? [projected] : [];
  });
}
