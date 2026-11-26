/**
 * In-memory chain registry for resumable delegations (ADR 0279).
 *
 * The registry is rebuilt from the session transcript at launch, then updated
 * as `Task` calls settle. It never appears in a tool parameter: the parent
 * only ever passes a `delegationId`, and the reverse map finds the chain.
 */

import {
  MAX_RESUMABLE_CHAINS_PER_AGENT,
} from "@pi-desktop/shared";
import {
  formatResumableList,
  type DelegationChain,
  type ResumableChain,
} from "./delegation-history.js";

const RESUMABLE_STATUSES = new Set([
  "completed",
  "failed",
  "timed_out",
  "aborted",
  "stopped",
  "interrupted",
]);

export type ChainLookupError =
  | { kind: "unknown" }
  | { kind: "running"; delegationId: string }
  | { kind: "not-resumable"; status: string }
  | { kind: "agent-mismatch"; expected: string; actual: string };

export class DelegationChainRegistry {
  private readonly chains = new Map<string, DelegationChain>();
  /** Every live `delegationId` on a chain, pointing at that chain's session id. */
  private readonly byDelegationId = new Map<string, string>();

  hydrate(chains: DelegationChain[]): void {
    this.chains.clear();
    this.byDelegationId.clear();
    for (const chain of chains) this.install(chain);
    this.evictOverflow();
  }

  lookup(delegationId: string): DelegationChain | undefined {
    const sessionId = this.byDelegationId.get(delegationId);
    if (!sessionId) return undefined;
    return this.chains.get(sessionId);
  }

  resolveResume(options: {
    resume: string;
    agentName: string;
    runningDelegationIds: ReadonlySet<string>;
  }): { ok: true; chain: DelegationChain } | { ok: false; error: ChainLookupError } {
    const chain = this.lookup(options.resume);
    if (!chain) return { ok: false, error: { kind: "unknown" } };
    if (chain.agentName !== options.agentName) {
      return {
        ok: false,
        error: {
          kind: "agent-mismatch",
          expected: chain.agentName,
          actual: options.agentName,
        },
      };
    }
    const latest = chain.latestDelegationId;
    if (latest && options.runningDelegationIds.has(latest)) {
      return { ok: false, error: { kind: "running", delegationId: latest } };
    }
    // An unknown status only happens for a chain rebuilt from the transcript
    // at launch, where live records are gone: its last run is settled by
    // definition. A settled chain carries its own status, which survives
    // `pruneFinishedDelegations` deleting the runtime's records.
    if (chain.latestStatus && !RESUMABLE_STATUSES.has(chain.latestStatus)) {
      return {
        ok: false,
        error: { kind: "not-resumable", status: chain.latestStatus },
      };
    }
    return { ok: true, chain };
  }

  start(options: {
    delegateSessionId: string;
    delegationId: string;
    toolCallId: string;
    agentName: string;
    originalTask: string;
    objective: string;
    latestModelId?: string;
    /** `providerId/modelId` key that resolved, so a resume can re-resolve it. */
    latestModelKey?: string;
    requestedModel?: string;
    modelReason?: string;
    requestedThinkingLevel?: DelegationChain["latestRequestedThinkingLevel"];
    resumedFrom?: DelegationChain;
    persona?: import("@pi-desktop/shared").SessionPersona;
  }): DelegationChain {
    const existing = options.resumedFrom
      ? this.chains.get(options.resumedFrom.delegateSessionId)
      : undefined;
    const chain: DelegationChain = existing
      ? {
          ...existing,
          toolCallIds: [...existing.toolCallIds, options.toolCallId],
          delegationIds: [...existing.delegationIds, options.delegationId],
          latestDelegationId: options.delegationId,
          latestObjective: options.objective || existing.latestObjective,
          latestModelId: options.latestModelId ?? existing.latestModelId,
          latestModelKey: options.latestModelKey ?? existing.latestModelKey,
          latestRequestedModel: options.requestedModel ?? existing.latestRequestedModel,
          latestModelReason: options.modelReason ?? existing.latestModelReason,
          latestRequestedThinkingLevel: options.requestedThinkingLevel ?? existing.latestRequestedThinkingLevel,
          latestStatus: "running",
          lastActivityAt: Date.now(),
        }
      : {
          delegateSessionId: options.delegateSessionId,
          toolCallIds: [options.toolCallId],
          delegationIds: [options.delegationId],
          agentName: options.agentName,
          readFiles: [],
          readLineCount: 0,
          originalTask: options.originalTask,
          latestDelegationId: options.delegationId,
          latestObjective: options.objective,
          latestModelId: options.latestModelId,
          latestModelKey: options.latestModelKey,
          latestRequestedModel: options.requestedModel,
          latestModelReason: options.modelReason,
          latestRequestedThinkingLevel: options.requestedThinkingLevel,
          ...(options.persona ? { persona: structuredClone(options.persona) } : {}),
          latestStatus: "running",
          lastActivityAt: Date.now(),
        };
    this.install(chain);
    return chain;
  }

  noteReads(
    delegateSessionId: string,
    files: readonly string[],
    lineCount: number,
  ): void {
    const chain = this.chains.get(delegateSessionId);
    if (!chain) return;
    const merged = [...chain.readFiles];
    for (const file of files) {
      if (!merged.includes(file)) merged.push(file);
    }
    this.chains.set(delegateSessionId, {
      ...chain,
      readFiles: merged,
      readLineCount: chain.readLineCount + lineCount,
      lastActivityAt: Date.now(),
    });
  }

  /** Record the binding the running delegate switched to (fallback models). */
  retarget(
    delegateSessionId: string,
    binding: { modelKey?: string; modelId: string },
  ): void {
    const chain = this.chains.get(delegateSessionId);
    if (!chain) return;
    this.chains.set(delegateSessionId, {
      ...chain,
      ...(binding.modelKey ? { latestModelKey: binding.modelKey } : {}),
      latestModelId: binding.modelId,
      lastActivityAt: Date.now(),
    });
  }

  settle(delegateSessionId: string, status: string, checkpointPath?: string): void {
    const chain = this.chains.get(delegateSessionId);
    if (!chain) return;
    this.chains.set(delegateSessionId, {
      ...chain,
      latestStatus: status,
      ...(checkpointPath ? { checkpointPath } : {}),
      lastActivityAt: Date.now(),
    });
    this.evictOverflow();
  }

  drop(delegateSessionId: string): void {
    const chain = this.chains.get(delegateSessionId);
    if (!chain) return;
    this.chains.delete(delegateSessionId);
    for (const id of chain.delegationIds) this.byDelegationId.delete(id);
  }

  resumableList(options: {
    runningDelegationIds: ReadonlySet<string>;
  }): ResumableChain[] {
    const listed: ResumableChain[] = [];
    for (const chain of this.chains.values()) {
      const latest = chain.latestDelegationId;
      if (!latest) continue;
      if (options.runningDelegationIds.has(latest)) continue;
      if (chain.latestStatus && !RESUMABLE_STATUSES.has(chain.latestStatus)) {
        continue;
      }
      listed.push({
        ...chain,
        latestDelegationId: latest,
        latestObjective: chain.latestObjective ?? "",
      });
    }
    return listed.sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  }

  /**
   * The resumable chains as one text block. This rides in a `TaskList` result,
   * never in the system prompt: the list changes every time a delegation
   * settles, and a system-prompt change rewrites the request prefix that
   * provider prompt caches key on (ADR 0337).
   */
  resumableBlock(options: {
    runningDelegationIds: ReadonlySet<string>;
  }): string {
    return formatResumableList(this.resumableList(options));
  }

  missingResumeError(resume: string, list: readonly ResumableChain[], recorded: boolean) {
    const available = resumableSummary(list);
    // A result is diagnostic, not a receipt for a new run. Never echo an unbounded argument.
    const id = resume.length <= 128 ? resume : `${resume.slice(0, 127)}…`;
    const reason = recorded
      ? `Delegation "${id}" was recorded in this session but its chain is no longer retained for resume.`
      : `Unknown delegation "${id}". No matching Task record is available in this session.`;
    const hint = `At most ${MAX_RESUMABLE_CHAINS_PER_AGENT} settled chains per agent are retained. Check TaskList's resumable entries for the intended task, or use its recorded report; do not substitute another chain or repeat completed work.`;
    return {
      message: `${reason} ${hint} ${available ? `Reusable: ${available}.` : "No reusable subagent sessions in this conversation."}`,
      metadata: { code: recorded ? "DELEGATION_RESUME_NOT_RETAINED" : "DELEGATION_RESUME_UNKNOWN" },
    };
  }

  /**
   * A chain resolved but has nothing left to replay: its rows are gone from the
   * transcript (a truncated branch, or a delegation that died before writing
   * any). The caller drops the chain first, so the id in the error can never
   * also appear in its own "reusable" list (ADR 0279 §4).
   */
  noHistoryResumeError(resume: string, list: readonly ResumableChain[]): string {
    const available = resumableSummary(list);
    return available
      ? `Delegation "${resume}" has no recorded history in this conversation and cannot be continued. Reusable: ${available}.`
      : `Delegation "${resume}" has no recorded history in this conversation and cannot be continued. Start a new delegation.`;
  }

  private install(chain: DelegationChain): void {
    this.chains.set(chain.delegateSessionId, chain);
    for (const id of chain.delegationIds) {
      this.byDelegationId.set(id, chain.delegateSessionId);
    }
  }

  private evictOverflow(): void {
    const byAgent = new Map<string, DelegationChain[]>();
    for (const chain of this.chains.values()) {
      const group = byAgent.get(chain.agentName) ?? [];
      group.push(chain);
      byAgent.set(chain.agentName, group);
    }
    for (const group of byAgent.values()) {
      // A working chain is never evicted: dropping it would strand the delegate
      // still writing into it, and the bound counts reusable chains anyway. Any
      // overflow those chains caused is resolved the moment they settle,
      // because `settle` runs this again (ADR 0279 §7).
      const settled = group
        .filter((chain) => chain.latestStatus !== "running")
        .sort((left, right) => right.lastActivityAt - left.lastActivityAt);
      for (const stale of settled.slice(MAX_RESUMABLE_CHAINS_PER_AGENT)) {
        this.drop(stale.delegateSessionId);
      }
    }
  }
}

/** `<agent> / <delegationId>` pairs for an error message's hint. */
function resumableSummary(list: readonly ResumableChain[]): string {
  let summary = "";
  for (const { agentName, latestDelegationId } of list) {
    if (summary.length + agentName.length + latestDelegationId.length + 5 > 512) {
      return `${summary ? `${summary}, ` : ""}see TaskList for more`;
    }
    summary += `${summary ? ", " : ""}${agentName} / ${latestDelegationId}`;
  }
  return summary;
}
