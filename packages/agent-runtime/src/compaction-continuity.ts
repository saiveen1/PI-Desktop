import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { isRecord, truncateMessageText, truncateTextWithMarker, usageToPi } from "./agent-messages.js";
import { CHECKPOINT_TRUNCATION_MARKER } from "./compaction-tail.js";
import { ESTIMATED_TEXT_CHARS_PER_TOKEN, estimateTokens } from "./pi-runtime-estimates.js";
import { estimateOutputCapInputTokens } from "./output-cap.js";
import { dedupeToolCallMessages } from "./tool-call-dedupe.js";

// Leave ample room for the summary/system journal in the Host's 64 MiB frame.
const MAX_RETAINED_TAIL_BYTES = 16 * 1024 * 1024;
const droppedStops = new Set(["error", "aborted", "deferred"]);
const tokens = (messages: AgentMessage[]) => messages.reduce(
  (sum, message) => sum + Math.max(Math.ceil(estimateTokens(message)),
    estimateOutputCapInputTokens({ messages: [{ role: message.role,
      content: (message as { content?: unknown }).content }] })), 0,
);
const bytes = (messages: AgentMessage[]) => Buffer.byteLength(JSON.stringify(messages), "utf8");

/** Tool details often duplicate image data; only activation markers affect context restore. */
function providerResult(message: ToolResultMessage): ToolResultMessage {
  const { details, ...provider } = message;
  if (message.toolName !== "ToolSearch" || !isRecord(details)) return provider;
  const activation: Record<string, string[]> = {};
  for (const key of ["addedToolNames", "activated"]) {
    const value = details[key];
    if (Array.isArray(value)) activation[key] = value.filter((name): name is string => typeof name === "string");
  }
  return Object.keys(activation).length ? { ...provider, details: activation } : provider;
}

/** Retain answered batches atomically; same-turn steering follows its completed batch. */
function executionGroups(messages: AgentMessage[]): AgentMessage[][] {
  const groups: AgentMessage[][] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "user") { groups.push([message]); continue; }
    if (message.role !== "assistant" || droppedStops.has(message.stopReason)) continue;
    const results: ToolResultMessage[] = [];
    const steering: UserMessage[] = [];
    let next = index + 1;
    while (next < messages.length) {
      const candidate = messages[next]!;
      if (candidate.role === "assistant") break;
      if (candidate.role === "toolResult") results.push(candidate);
      if (candidate.role === "user") steering.push(candidate);
      next++;
    }
    const answered = new Set(results.map(result => result.toolCallId));
    const calls = new Set(message.content.flatMap(block =>
      block.type === "toolCall" && answered.has(block.id) ? [block.id] : [],
    ));
    const content = message.content.filter(block => block.type !== "toolCall" || calls.has(block.id));
    if (content.length) {
      const seen = new Set<string>();
      groups.push([
        { ...message, content, usage: usageToPi(undefined) },
        ...results.filter(result => {
          if (!calls.has(result.toolCallId) || seen.has(result.toolCallId)) return false;
          seen.add(result.toolCallId);
          return true;
        }).map(providerResult),
      ]);
    }
    groups.push(...steering.map(user => [user]));
    index = next - 1;
  }
  return groups;
}

/** Bound text, never opaque arguments or images, against both budgets. */
function fitGroup(group: AgentMessage[], budget: number, byteBudget: number): AgentMessage[] | undefined {
  const fits = (candidate: AgentMessage[]) => tokens(candidate) <= budget && bytes(candidate) <= byteBudget;
  if (fits(group)) return group;
  const bound = (chars: number) => group.map(message =>
    truncateMessageText(message, chars, CHECKPOINT_TRUNCATION_MARKER),
  );
  let fitted = bound(0);
  if (!fits(fitted)) return undefined;
  let low = 0;
  let high = Math.floor(budget * ESTIMATED_TEXT_CHARS_PER_TOKEN);
  // Bounded search, not a retry: text caps are monotone and opaque blocks never change.
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = bound(middle);
    if (fits(candidate)) {
      low = middle;
      fitted = candidate;
    } else {
      high = middle - 1;
    }
  }
  return fitted;
}

function retainGoal(message: UserMessage, budget: number, byteBudget: number): AgentMessage[] {
  const fitted = fitGroup([message], budget, byteBudget);
  if (fitted) return fitted;
  // Images are omitted only if keeping them cannot fit even with all text removed.
  const text = typeof message.content === "string" ? message.content : message.content.map(block =>
    block.type === "text" ? block.text : `[${block.type} content omitted from checkpoint]`,
  ).join("\n");
  const bounded = { ...message, content: truncateTextWithMarker(text,
    Math.floor(budget * ESTIMATED_TEXT_CHARS_PER_TOKEN), CHECKPOINT_TRUNCATION_MARKER) };
  return fitGroup([bounded], budget, byteBudget) ?? [];
}

/**
 * Keep the active run's goal, steering and recent execution evidence. Without a
 * live run boundary, legacy/restored preparations conservatively use the latest
 * user. The caller still checks the complete request before checkpoint install.
 */
export function selectActiveTurnTail(
  messages: AgentMessage[],
  maxTokens: number,
  userMaxTokens: number,
  activeTurnStartedAt?: number,
): AgentMessage[] {
  const budget = Math.max(1, Math.floor(maxTokens));
  let userIndex = activeTurnStartedAt === undefined ? -1 : messages.findIndex(message =>
    message.role === "user" && message.timestamp >= activeTurnStartedAt,
  );
  if (userIndex < 0) {
    userIndex = messages.length - 1;
    while (userIndex >= 0 && messages[userIndex]!.role !== "user") userIndex--;
  }
  const user = messages[userIndex];
  const goal = user?.role === "user"
    ? retainGoal(user, Math.max(1, Math.min(userMaxTokens, Math.floor(budget / 2))), MAX_RETAINED_TAIL_BYTES - 1_024)
    : [];
  let remaining = Math.max(0, budget - tokens(goal));
  let remainingBytes = MAX_RETAINED_TAIL_BYTES - bytes(goal);
  const repaired = dedupeToolCallMessages(messages.slice(userIndex + 1)).messages;
  const groups = executionGroups(repaired);
  const tail: AgentMessage[][] = [];
  for (let index = groups.length - 1; index >= 0 && remaining > 0 && remainingBytes > 0; index--) {
    const group = groups[index]!;
    const single = group[0];
    const fitted = group.length === 1 && single?.role === "user"
      ? retainGoal(single, remaining, remainingBytes)
      : fitGroup(group, remaining, remainingBytes);
    if (!fitted?.length) break;
    tail.unshift(fitted);
    remaining -= tokens(fitted);
    remainingBytes -= bytes(fitted);
    if (tokens(group) > tokens(fitted) || bytes(group) > bytes(fitted)) break;
  }
  return [...goal, ...tail.flat()];
}
