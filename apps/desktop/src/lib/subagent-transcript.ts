import type { UiMessage } from "@pi-desktop/shared";
import {
  delegationChainMaps,
  messageThinking,
  type SubagentRunItem,
} from "./assistant-turns";
import { isDelegationStartTool } from "./tool-display";
import { delegationAttempt, delegationIdForMessage, taskMessageKey } from "./subagent-panel";

/** One user/assistant exchange of a delegate session. */
export type SubagentTranscriptTurn = {
  task: string;
  rows: (SubagentRunItem | { kind: "user"; message: UiMessage })[];
};

/**
 * A delegate's conversation as alternating turns: each Task call of the
 * delegation chain opens a turn with its `task` argument, followed by the
 * rows the delegate produced under that call.
 */
export type SubagentTranscript = {
  agentName?: string;
  /** Original Task rows in the resolved resume chain, in session order. */
  calls: UiMessage[];
  /** Latest call in the connected resume chain, including its effective handle. */
  latestCall: UiMessage;
  turns: SubagentTranscriptTurn[];
  chainId: string;
};

export function delegateTaskDescription(call: UiMessage): string {
  const args = call.toolArgs;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const task = (args as { task?: unknown }).task;
  return typeof task === "string" ? task.trim() : "";
}

function requestedAgentName(call: UiMessage): string {
  const args = call.toolArgs;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const agent = (args as { agent?: unknown }).agent;
  return typeof agent === "string" ? agent : "";
}

/**
 * Build the delegate's transcript from the session messages.
 *
 * A Task call belongs to the delegation of `delegationId` when the call
 * identifies itself by its recorded handle or original message identity, or
 * when it returned a handle while resuming a call in that chain. Old call-id
 * selections still resolve. Turns appear in session order; their rows are the messages
 * whose `parentToolCallId` names that call, mapped exactly like the
 * delegation card's run grouping. Returns null when no Task call matches, so
 * the tab can show its unavailable state instead of an empty conversation.
 */
export function buildSubagentTranscript(
  messages: readonly UiMessage[],
  delegationId: string,
): SubagentTranscript | null {
  const target = delegationId.trim();
  const { parentOf } = delegationChainMaps(messages);
  const calls = messages.filter(
    (message) =>
      message.role === "tool" &&
      isDelegationStartTool(message.toolName) &&
      !delegationAttempt(message) &&
      Boolean(message.toolCallId),
  );
  // The chain is the connected component of resumed calls around the call
  // this delegation id names; forward and backward walks share that set.
  const matches = calls.filter(call => delegationIdForMessage(call) === target || taskMessageKey(call.id) === target);
  const selected = matches.length ? matches : calls.filter(call => call.toolCallId === target);
  const chain = new Set(selected.map(call => call.toolCallId as string));
  if (chain.size === 0) return null;
  for (;;) {
    const size = chain.size;
    for (const [child, parent] of parentOf) {
      if (chain.has(child)) chain.add(parent);
      if (chain.has(parent)) chain.add(child);
    }
    if (chain.size === size) break;
  }

  // Attribution prefers what the delegate's own rows carried; a chain whose
  // delegate has not produced a row yet falls back to the requested agent.
  const runAgentName = messages.find(
    (message) =>
      message.parentToolCallId &&
      chain.has(message.parentToolCallId) &&
      message.agentName,
  )?.agentName;
  const requestedName = calls
    .filter((call) => chain.has(call.toolCallId as string))
    .map(requestedAgentName)
    .find(Boolean);
  const agentName = runAgentName || requestedName;

  const turns: SubagentTranscriptTurn[] = [];
  const chainCalls = calls.filter((call) => chain.has(call.toolCallId as string));
  for (const call of calls) {
    const callId = call.toolCallId as string;
    if (!chain.has(callId)) continue;
    const rows: SubagentTranscriptTurn["rows"] = [];
    for (const message of messages) {
      if (message.parentToolCallId !== callId) continue;
      if (message.role === "user") {
        rows.push({ kind: "user", message });
        continue;
      }
      if (message.role === "tool") {
        rows.push({ kind: "tool", message });
        continue;
      }
      // A delegate turn can carry reasoning and text at once, and both are
      // worth showing: the text is the only place its narration and report
      // exist.
      if (messageThinking(message)) rows.push({ kind: "thinking", message });
      if ((message.content || "").trim() || message.error) {
        rows.push({ kind: "answer", message });
      }
    }
    turns.push({ task: delegateTaskDescription(call), rows });
  }

  return {
    calls: chainCalls,
    chainId: chainCalls[0].toolCallId as string,
    latestCall: chainCalls[chainCalls.length - 1],
    ...(agentName ? { agentName } : {}),
    turns,
  };
}
