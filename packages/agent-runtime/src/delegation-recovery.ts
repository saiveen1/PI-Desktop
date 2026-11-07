import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AgentRetrySubagentResponse, UiMessage } from "@pi-desktop/shared";
import { isRecord } from "./agent-messages.js";

type EndEvent = Extract<AgentEvent, { type: "turn_end" | "agent_end" }>;

/** Only the latest failed parent turn supplies automatic recovery candidates. */
export function parentInterruptedDelegations(history: readonly UiMessage[]): string[] {
  const parentRows = history.filter(row => !row.parentToolCallId);
  const latest: UiMessage[] = [];
  for (const row of parentRows) {
    if (row.role === "user" && !row.steering) latest.length = 0;
    else latest.push(row);
  }
  if (latest.filter(row => row.role === "assistant").at(-1)?.status !== "error") return [];
  return latest.flatMap(row => {
    if (row.toolName !== "Task" || !isRecord(row.toolResult) || !isRecord(row.toolResult.details)) return [];
    const details = row.toolResult.details;
    return details.status === "failed" && isRecord(details.error) && details.error.code === "SUBAGENT_PARENT_FAILED" &&
      typeof details.delegationId === "string" ? [details.delegationId] : [];
  });
}

/** Turn-owned admissions shared by automatic recovery and the retry control. */
export class DelegationRecovery {
  private interrupted: Set<string>;
  private failedTurn?: string;
  private readonly admissions = new Map<string, {
    turnId: string;
    controller: AbortController;
    result: Promise<AgentRetrySubagentResponse>;
  }>();
  private readonly deferredEnds = new Map<string, Map<EndEvent["type"], EndEvent>>();

  constructor(history: readonly UiMessage[]) {
    this.interrupted = new Set(parentInterruptedDelegations(history));
  }

  noteParentFailure(turnId: string | undefined, ids: string[]): void {
    if (this.failedTurn !== turnId) this.interrupted.clear();
    this.failedTurn = turnId;
    for (const id of ids) this.interrupted.add(id);
  }

  takeInterrupted(): string[] {
    const ids = [...this.interrupted];
    this.interrupted.clear();
    return ids;
  }

  pending(turnId: string | undefined): boolean {
    return [...this.admissions.values()].some(entry => entry.turnId === turnId);
  }

  admit(chainId: string, turnId: string, start: (signal: AbortSignal) => Promise<AgentRetrySubagentResponse>): Promise<AgentRetrySubagentResponse> {
    const previous = this.admissions.get(chainId);
    if (previous) {
      if (previous.turnId !== turnId) throw new Error("The previous recovery is still retiring.");
      return previous.result;
    }
    const controller = new AbortController();
    // Reserve before invoking code that can yield for authorization or emit UI events.
    const result = Promise.resolve().then(() => start(controller.signal)).finally(() => {
      if (this.admissions.get(chainId)?.result === result) this.admissions.delete(chainId);
    });
    this.admissions.set(chainId, { turnId, controller, result });
    return result;
  }

  async drain(turnId: string | undefined): Promise<void> {
    while (this.pending(turnId)) {
      await Promise.allSettled([...this.admissions.values()].filter(entry => entry.turnId === turnId).map(entry => entry.result));
    }
  }

  cancel(clearInterrupted = false): void {
    if (clearInterrupted) this.interrupted.clear();
    for (const entry of this.admissions.values()) entry.controller.abort();
  }

  deferEnd(turnId: string | undefined, event: EndEvent): boolean {
    if (!turnId || !this.pending(turnId)) return false;
    const ends = this.deferredEnds.get(turnId) ?? new Map<EndEvent["type"], EndEvent>();
    ends.set(event.type, event);
    this.deferredEnds.set(turnId, ends);
    return true;
  }

  takeDeferredEnds(turnId: string | undefined): EndEvent[] {
    if (!turnId) return [];
    const ends = [...(this.deferredEnds.get(turnId)?.values() ?? [])];
    this.deferredEnds.delete(turnId);
    return ends;
  }
}
