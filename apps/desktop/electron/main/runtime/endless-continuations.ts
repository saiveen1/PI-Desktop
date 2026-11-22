import { TRUSTED_ENDLESS_CONTINUATION } from "@pi-desktop/agent-host";
import type { ObserverGuardRuntimeConfig } from "@pi-desktop/agent-runtime";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import { OBSERVER_GUARD_LIMITS, type AgentPromptRequest, type AgentStatus, type SessionDetail } from "@pi-desktop/shared";
import type { AgentHostBridge } from "../agent-host-bridge";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";

// Only live explicit prompts establish a generation. Nothing reconstructs it from history.
const chains = new Map<string, ContinuationChain>();
const excludedRoots = new WeakSet<object>();
export function excludeEndlessRoot(request: object): void { excludedRoots.add(request); }

/** Synchronous revocation, including while admission/settlement is awaiting IO. Never aborts a run. */
export function cancelEndlessContinuation(sessionId: string, expectedTurnId?: string): void {
  const chain = chains.get(sessionId);
  if (chain && (!expectedTurnId || chain.owner === expectedTurnId)) chain.cancel();
}

type Environment = {
  host: HostProcess; sidecar: AgentSidecar; bridge: AgentHostBridge;
  available: () => boolean; flush: () => Promise<void>; locale: () => string;
};
type ActiveMode = "guard" | "endless";
function eligibleSession(session: SessionDetail | undefined, id: string, mode: ActiveMode | undefined): session is SessionDetail {
  return mode !== undefined && session?.id === id && session.mode === "agent" && session.observerMode === mode &&
    !session.scheduledRun && !session.remoteWorkspace && (!session.source || session.source === "desktop");
}
function validLimit(limit: unknown): limit is number {
  const range = OBSERVER_GUARD_LIMITS.maxContinuations;
  return typeof limit === "number" && Number.isInteger(limit) && limit >= range.min && limit <= range.max;
}

class ContinuationChain {
  private mode?: ActiveMode;
  private reviewerKey?: string;
  owner?: string;
  private count = 0;
  private limit: number = OBSERVER_GUARD_LIMITS.maxContinuations.max;
  private replyId?: string;
  private workspace?: string;
  private permission?: string;
  private claimed = false;
  private quitting = () => false;
  private readonly id: string;
  private readonly env: Environment;
  constructor(id: string, env: Environment) { this.id = id; this.env = env; }

  cancel(): void { if (chains.get(this.id) === this) chains.delete(this.id); }
  current(): boolean {
    return chains.get(this.id) === this && !this.quitting() && this.env.available() && !this.env.bridge.queue.list(this.id).length;
  }
  configure(session: SessionDetail, config: ObserverGuardRuntimeConfig | undefined, workspace: string | undefined, permission: string): boolean {
    if (!config || (config.mode !== "endless" && config.mode !== "guard") || !eligibleSession(session, this.id, config.mode)) return false;
    const limit = config.settings?.maxContinuations;
    if (!validLimit(limit) || !this.current()) return false;
    let reviewerKey: string | undefined;
    if (config.mode === "guard") {
      const { providerId, modelId } = config.settings;
      if (config.errorCode || !providerId || !modelId || config.provider?.id !== providerId || config.provider.modelId !== modelId) return false;
      reviewerKey = `${providerId}/${modelId}`;
    }
    if (this.claimed && (config.mode !== this.mode || reviewerKey !== this.reviewerKey || limit < this.limit ||
      workspace !== this.workspace || permission !== this.permission)) return false;
    this.mode = config.mode;
    this.reviewerKey = reviewerKey;
    this.workspace = workspace;
    this.permission = permission;
    this.limit = Math.min(this.limit, limit);
    return !this.claimed || this.count < this.limit;
  }
  remainingForPrompt(automatic: boolean): number {
    return this.current() ? Math.max(0, this.limit - this.count - Number(automatic)) : 0;
  }
  async verifyHead(turnId = this.owner, messageId = this.replyId): Promise<void> {
    const { session } = await this.env.host.call<{ session?: SessionDetail }>("session.get", { id: this.id, messageLimit: 1 });
    const head = session?.messages.at(-1);
    if (!this.current() || !eligibleSession(session, this.id, this.mode) || !head || head.turnId !== turnId || head.id !== messageId) {
      throw new Error("Automatic continuation no longer owns this conversation");
    }
  }
  accepted(turnId: string, automatic: boolean): void {
    if (automatic) this.count++;
    this.owner = turnId;
    this.claimed = false;
    if (this.count >= this.limit) this.cancel();
  }
  async settle(turnId: string, eligible: boolean, isQuitting: () => boolean): Promise<void> {
    if (this.owner !== turnId || this.claimed) return;
    this.claimed = true;
    this.quitting = isQuitting;
    const { host, sidecar, bridge } = this.env;
    try {
      if (!eligible || !this.current()) return;
      await this.env.flush();
      const [{ session }, runtime, permissions, plans, jobs] = await Promise.all([
        host.call<{ session?: SessionDetail }>("session.get", { id: this.id, messageLimit: 1 }),
        sidecar.call<{ status: AgentStatus; personaConfigurationBlocked: boolean }>("agent.getStatus", { sessionId: this.id }),
        host.call<{ requests: unknown[] }>("permissions.pending", { sessionId: this.id }),
        host.call<{ plans: unknown[] }>("plans.pending", { sessionId: this.id }),
        host.call<{ tasks: { sessionId: string; state: string; continuation?: string }[] }>("backgroundTasks.list"),
      ]);
      const { status } = runtime;
      if (!eligibleSession(session, this.id, this.mode) || runtime.personaConfigurationBlocked !== false ||
          status.sessionId !== this.id || status.currentTurnId !== turnId || status.isRunning !== false ||
          status.pendingToolConfirmations !== 0 || status.pendingPlanId || status.planningState !== "inactive" ||
          permissions.requests?.length !== 0 || plans.plans?.length !== 0 || !Array.isArray(jobs.tasks) ||
          jobs.tasks.some(job => job.sessionId === this.id && (job.state === "running" || job.continuation === "pending"))) return;
      const reply = session.messages.at(-1);
      const diagnostics = status.runDiagnostics;
      const assessment = diagnostics?.observer;
      if (!reply || reply.turnId !== turnId || reply.role !== "assistant" || reply.status !== "complete" ||
          !reply.content?.trim() || reply.error || reply.parentToolCallId || reply.nestedParentToolCallId ||
          !diagnostics || diagnostics.turnId !== turnId || diagnostics.endedAt === undefined ||
          diagnostics.termination?.messageId !== reply.id || diagnostics.termination.stopReason !== "stop" ||
          assessment?.messageId !== reply.id || assessment.mode !== this.mode || assessment.modelKey !== this.reviewerKey || assessment.status !== "assessed" ||
          assessment.decision !== "continue" || assessment.continued !== false || assessment.continuationCount !== 0 ||
          assessment.skipReason || assessment.errorCode || assessment.continuationReason || assessment.continuationBlocked ||
          !validLimit(assessment.maxContinuations)) return;
      this.replyId = reply.id;
      this.limit = Math.min(this.limit, assessment.maxContinuations);
      const recovery = assessment.endlessRecoveriesUsed;
      if (recovery !== undefined) {
        if (!Number.isSafeInteger(recovery) || recovery < 1 || recovery > this.limit - this.count) return;
        this.count += recovery;
      }
      if (this.count >= this.limit || !this.current()) return;
      const locale = resolveLocale(this.env.locale());
      const labels = catalogs[locale];
      const suffix = `${labels.notificationSettings.auto} ${this.count + 1}/${this.limit}`;
      const text = labels.subagentControls.continue + (locale.startsWith("zh") ? `（${suffix}）` : ` (${suffix})`);
      await bridge.startEndlessContinuation(this.id, this, text);
    } finally {
      // Only an actually accepted new turn can hand this generation forward.
      if (this.owner === turnId) this.cancel();
    }
  }
}

export function beginEndlessPrompt(request: AgentPromptRequest & { [TRUSTED_ENDLESS_CONTINUATION]?: object }, root: boolean, env?: Environment) {
  const origin = request[TRUSTED_ENDLESS_CONTINUATION];
  if (origin) {
    const chain = chains.get(request.sessionId);
    if (!chain || origin !== chain || !chain.current()) throw new Error("Automatic continuation expired");
    return chain;
  }
  cancelEndlessContinuation(request.sessionId);
  if (!root || !env || excludedRoots.has(request)) return;
  const chain = new ContinuationChain(request.sessionId, env);
  chains.set(request.sessionId, chain);
  return chain;
}

export async function settleEndlessTurn(sessionId: string, turnId: string, eligible: boolean, isQuitting: () => boolean): Promise<void> {
  await chains.get(sessionId)?.settle(turnId, eligible, isQuitting);
}
