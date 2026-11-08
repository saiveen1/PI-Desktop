import type { AgentSendSubagentMessageRequest, AgentSendSubagentMessageResponse, UiMessage } from "@pi-desktop/shared";
import { isRecord } from "./agent-messages.js";
import type { DelegationChain } from "./delegation-history.js";

export const subagentUserMessageId = (id: string) => `subagent-user:${id}`;
export const subagentMessageTaskId = (id: string) => `subagent-message:${id}`;

/** Receipt identities live in existing child rows and synthetic Task call ids. */
export function subagentMessageReceipt(
  rows: readonly UiMessage[], chain: DelegationChain,
  request: AgentSendSubagentMessageRequest, turnId: string,
): AgentSendSubagentMessageResponse | undefined {
  const row = [...rows].reverse().find(row => row.id === subagentUserMessageId(request.messageId) ||
    (row.toolCallId === subagentMessageTaskId(request.messageId) && isRecord(row.toolResult) &&
      isRecord(row.toolResult.details) && typeof row.toolResult.details.delegationId === "string"));
  if (!row) return undefined;
  const childRow = row.id === subagentUserMessageId(request.messageId);
  const content = childRow ? row.content : isRecord(row.toolArgs) ? row.toolArgs.task : undefined;
  const owner = childRow ? row.parentToolCallId : row.toolCallId;
  if (!owner || !chain.toolCallIds.includes(owner) || content !== request.content) {
    throw Object.assign(new Error("Message identity already belongs to different content or another delegation"), { errorCode: "INVALID_ARGUMENT" });
  }
  const details = isRecord(row.toolResult) && isRecord(row.toolResult.details) ? row.toolResult.details : undefined;
  const delegationId = typeof details?.delegationId === "string" ? details.delegationId : chain.latestDelegationId;
  if (!delegationId) return undefined;
  return { accepted: true, turnId, delegationId, resumedFrom: request.delegationId, delivery: "duplicate" };
}

/** Serializes distinct inputs per chain and coalesces transport retries by message id. */
export class DelegationMessages {
  private readonly pending = new Map<string, { identity: string; result: Promise<AgentSendSubagentMessageResponse> }>();
  private readonly tails = new Map<string, Promise<unknown>>();

  get busy(): boolean { return this.pending.size > 0; }

  send(chainId: string, request: AgentSendSubagentMessageRequest,
    deliver: () => Promise<AgentSendSubagentMessageResponse>): Promise<AgentSendSubagentMessageResponse> {
    const identity = JSON.stringify([chainId, request.content]);
    const existing = this.pending.get(request.messageId);
    if (existing) {
      if (existing.identity !== identity) throw Object.assign(new Error("Message identity is already in use"), { errorCode: "INVALID_ARGUMENT" });
      return existing.result.then(result => result.accepted ? { ...result, delivery: "duplicate" } : result);
    }
    const previous = this.tails.get(chainId);
    const result = Promise.resolve(previous).catch(() => undefined).then(deliver).finally(() => {
      if (this.pending.get(request.messageId)?.result === result) this.pending.delete(request.messageId);
      if (this.tails.get(chainId) === result) this.tails.delete(chainId);
    });
    this.pending.set(request.messageId, { identity, result });
    this.tails.set(chainId, result);
    return result;
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending.values()].map(entry => entry.result));
  }
}
