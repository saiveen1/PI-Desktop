import type { AgentContext, AgentTurnContext } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import {
  isObserverGuardSettings, resolveObserverGuardSettings,
  type ObserverGuardAssessment, type ObserverGuardContinuationReason, type ObserverGuardError, type ObserverGuardMode,
  type ObserverGuardSettings, type ObserverGuardSkipReason,
} from "@pi-desktop/shared";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import { completeOneShot } from "./one-shot-complete.js";
import { actionableUserTask } from "./early-end.js";
import type { CorrectiveBudget } from "./corrective-budget.js";
import { OBSERVER_REVIEW_INSTRUCTIONS, ObserverEvidenceWindow, observerResponseAllowsAction, parseObserverVerdict, redactObserverText } from "./observer-guard-evidence.js";

export type ObserverGuardRuntimeConfig = {
  mode: ObserverGuardMode;
  settings: ObserverGuardSettings;
  provider?: RuntimeProviderConfig;
  errorCode?: ObserverGuardError;
};

type AssessmentSink = { messageId: string; publish: (assessment: ObserverGuardAssessment) => void };
export type ObserverRuntimeBlock = Extract<ObserverGuardContinuationReason,
  "stop_requested" | "plan_mode" | "pending_work" | "task_changed" | "runtime_unavailable">;
const VERDICT_REASONS = { complete: "verdict_complete", blocked: "verdict_blocked", needs_input: "verdict_needs_input", unknown: "verdict_unknown" } as const;
const SECTION = "observer_guard_correction";
const REMINDER = "Recheck the user's existing task against the retained results. Continue only remaining authorized work within the original scope and permissions. Do not replay completed actions or assume unknown effects failed. If complete, blocked, refused, or awaiting input or approval, report that accurately and stop. This one-request reminder is not a new user request.";
const ERRORS: readonly ObserverGuardError[] = ["MODEL_NOT_CONFIGURED", "MODEL_UNAVAILABLE", "EFFORT_UNAVAILABLE", "PROVIDER_UNAVAILABLE", "TIMEOUT", "INVALID_RESPONSE", "CANCELLED", "INSUFFICIENT_EVIDENCE"];

/** One independent assessment per explicit user turn, never an execution authority. */
export class ObserverGuard {
  private next?: ObserverGuardRuntimeConfig;
  private active?: ObserverGuardRuntimeConfig;
  private generation = 0;
  private attempted = false;
  private invalidated = false;
  private task?: string;
  private userId?: string;
  private controller?: AbortController;
  private pending = false;
  private pendingSkip?: { messageId: string; reason: ObserverGuardSkipReason };
  private readonly evidence = new ObserverEvidenceWindow();

  constructor(private readonly sessionId?: string) {}

  get pendingCorrection(): boolean { return this.pending; }
  get canRecord(): boolean {
    return !this.attempted && this.task !== undefined && (this.active?.mode === "observe" || this.active?.mode === "guard");
  }

  setConfig(value?: ObserverGuardRuntimeConfig): void {
    this.next = value && { ...value, settings: { ...value.settings }, provider: value.provider && {
      ...value.provider, supportedThinkingLevels: Array.isArray(value.provider.supportedThinkingLevels) ? [...value.provider.supportedThinkingLevels] : [], headers: { ...value.provider.headers },
      modelConfig: value.provider.modelConfig && { ...value.provider.modelConfig },
    } };
    if (this.next && !isObserverGuardSettings(value?.settings)) this.next.errorCode = "MODEL_NOT_CONFIGURED";
  }

  reset(): void {
    this.cancel();
    this.generation++;
    this.active = this.next;
    this.attempted = false;
    this.invalidated = false;
    this.task = undefined;
    this.userId = undefined;
    this.pendingSkip = undefined;
    this.evidence.reset();
  }

  setTask(task: string | undefined): void { this.task = task; }
  userMessage(id: string, steering: boolean): void {
    if (steering) { this.invalidated = true; this.cancel(); }
    else if (this.task !== undefined) this.userId = id;
  }
  cancel(): void { this.pending = false; this.controller?.abort(); }

  observeTools(turn: AgentTurnContext): void {
    if (this.active?.mode !== "off" && this.active) this.evidence.observe(turn, resolveObserverGuardSettings(this.active.settings), this.secrets());
  }

  private secrets(): string[] {
    const provider = this.active?.provider;
    return [provider?.apiKey ?? "", ...Object.values(provider?.headers ?? {})];
  }

  private begin(sink: AssessmentSink) {
    const config = this.active;
    if (!config || !this.canRecord || config.mode === "off") return;
    this.attempted = true;
    const settings = resolveObserverGuardSettings(config.settings);
    const assessment: ObserverGuardAssessment = {
      messageId: sink.messageId, mode: config.mode, status: "checking", startedAt: Date.now(), thinkingLevel: settings.thinkingLevel,
      ...(settings.providerId && settings.modelId ? { modelKey: `${settings.providerId}/${settings.modelId}` } : {}),
    };
    return { config, settings, assessment };
  }

  skip(sink: AssessmentSink | undefined, skipReason: ObserverGuardSkipReason): undefined {
    if (!sink) return;
    const started = this.begin(sink);
    if (started) sink.publish({ ...started.assessment, status: "skipped", skipReason, endedAt: started.assessment.startedAt });
  }

  private deferSkip(sink: AssessmentSink, reason: ObserverGuardSkipReason): undefined {
    // Another request can still follow this reply (e.g. pending delegate results).
    this.pendingSkip = { messageId: sink.messageId, reason };
  }

  finish(sink: AssessmentSink | undefined): void {
    if (sink && this.pendingSkip?.messageId === sink.messageId) this.skip(sink, this.pendingSkip.reason);
  }

  async assess(turn: AgentTurnContext, sink: AssessmentSink | undefined, runtimeBlock: () => ObserverRuntimeBlock | undefined, budget: CorrectiveBudget, signal?: AbortSignal): Promise<{ action: "continue" } | undefined> {
    const { message } = turn;
    const task = this.task, userId = this.userId;
    if (!sink || !this.canRecord || task === undefined || message.content.some(block => block.type === "toolCall")) return;
    if (signal?.aborted) return this.skip(sink, "stop_requested");
    if (message.stopReason === "length") return this.deferSkip(sink, "response_length");
    if (message.stopReason !== "stop") return;
    if (this.invalidated) return this.deferSkip(sink, "task_changed");
    const answer = message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
    if (!answer.trim()) return this.deferSkip(sink, "empty_response");
    if (!task.trim() || !userId) return this.deferSkip(sink, "no_user_task");
    const started = this.begin(sink);
    if (!started) return;
    const generation = this.generation;
    const { config, settings } = started;
    let { assessment } = started;
    const publish = () => { if (generation === this.generation) sink.publish({ ...assessment }); };
    const fail = (errorCode: ObserverGuardError) => { assessment = { ...assessment, status: "error", errorCode, endedAt: Date.now() }; publish(); };
    publish();
    if (config.errorCode) { fail(ERRORS.includes(config.errorCode) ? config.errorCode : "MODEL_UNAVAILABLE"); return; }
    if (!settings.providerId || !settings.modelId) { fail("MODEL_NOT_CONFIGURED"); return; }
    const provider = config.provider;
    if (!provider || provider.id !== settings.providerId || provider.modelId !== settings.modelId) { fail("MODEL_UNAVAILABLE"); return; }
    if (!provider.supportedThinkingLevels.includes(settings.thinkingLevel)) { fail("EFFORT_UNAVAILABLE"); return; }
    if (!provider.apiKey && provider.authKind !== "none" && !provider.resolveAuth) { fail("PROVIDER_UNAVAILABLE"); return; }
    const input = this.evidence.build(task, userId, answer, sink.messageId,
      { ...settings, maxInputChars: settings.maxInputChars - OBSERVER_REVIEW_INSTRUCTIONS.length }, this.secrets());
    assessment.inputTruncated = input.truncated;
    if (input.text.length + OBSERVER_REVIEW_INSTRUCTIONS.length > settings.maxInputChars || input.evidence.some(row => !row.id || row.id.length > 256) || new Set(input.evidence.map(row => row.id)).size !== input.evidence.length) {
      fail("INSUFFICIENT_EVIDENCE"); return;
    }
    const controller = new AbortController();
    this.controller = controller;
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, settings.timeoutSeconds * 1000);
    let rejectAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(new Error("observer cancelled"));
        controller.signal.addEventListener("abort", rejectAbort, { once: true });
      });
      if (signal?.aborted || this.invalidated) controller.abort();
      if (!controller.signal.aborted) {
        assessment.reviewedToolCount = input.evidence.length - 2;
        assessment.toolOutputIncluded = input.evidence.some(row => row.kind === "tool" && Boolean(row.text));
      }
      const result = await Promise.race([aborted, controller.signal.aborted ? aborted : completeOneShot(provider, {
        messages: [
          { role: "system", content: OBSERVER_REVIEW_INSTRUCTIONS, timestamp: Date.now() },
          { role: "user", content: input.text, timestamp: Date.now() },
        ],
      }, settings.thinkingLevel, {
        signal: controller.signal, disableRetries: true, requireComplete: true, sessionId: this.sessionId,
        // Some adapters count reasoning inside the output cap; preserve the selected effort.
        maxOutputTokens: settings.thinkingLevel === "off" ? 512 : 8192,
        onUsage: usage => { if (generation === this.generation && !controller.signal.aborted) assessment.usage = usage; },
      })]);
      if (generation !== this.generation) return;
      if (controller.signal.aborted) { fail(timedOut ? "TIMEOUT" : "CANCELLED"); return; }
      // Usage belongs to the independent reviewer, never the main request ledger.
      assessment.usage = result.usage ?? assessment.usage;
      const verdict = parseObserverVerdict(result.text, input.evidence);
      if (!verdict) { fail("INVALID_RESPONSE"); return; }
      const toolBlock = this.evidence.blockingTool;
      let continuationReason: ObserverGuardContinuationReason | undefined;
      let continuationBlocked: ObserverGuardAssessment["continuationBlocked"];
      if (config.mode === "observe") continuationReason = continuationBlocked = "observe_only";
      else if (verdict.verdict !== "incomplete") continuationReason = VERDICT_REASONS[verdict.verdict];
      else if (verdict.confidence !== "high") continuationReason = "low_confidence";
      else {
        const lifecycle = runtimeBlock();
        const unsafe = this.invalidated ? "task_changed" : signal?.aborted ? "stop_requested" :
          lifecycle === "stop_requested" || lifecycle === "task_changed" ? lifecycle : toolBlock?.reason ?? lifecycle;
        if (unsafe) { continuationReason = unsafe; continuationBlocked = "unsafe"; }
        else if (input.truncated) { continuationReason = "input_truncated"; continuationBlocked = "not_actionable"; }
        else if (!actionableUserTask(task, this.evidence.hasToolProgress)) { continuationReason = "task_not_actionable"; continuationBlocked = "not_actionable"; }
        else if (!observerResponseAllowsAction(answer)) { continuationReason = "answer_needs_input"; continuationBlocked = "not_actionable"; }
        else if (!budget.claim()) { continuationReason = "correction_budget"; continuationBlocked = "budget"; }
        else this.pending = true;
      }
      assessment = {
        ...assessment, ...verdict, reason: redactObserverText(verdict.reason, this.secrets(), 300),
        status: "assessed", endedAt: Date.now(), continued: this.pending,
        ...(continuationReason ? { continuationReason } : {}),
        ...(continuationBlocked ? { continuationBlocked } : {}),
        ...(toolBlock && continuationReason === toolBlock.reason && toolBlock.tool ? { blockingTool: toolBlock.tool } : {}),
      };
      publish();
      if (this.pending) return { action: "continue" };
    } catch (error) {
      const invalid = error instanceof Error && "errorCode" in error && ["INCOMPLETE_COMPLETION", "EMPTY_COMPLETION"].includes(String(error.errorCode));
      if (generation === this.generation) fail(controller.signal.aborted ? timedOut ? "TIMEOUT" : "CANCELLED" : invalid ? "INVALID_RESPONSE" : "PROVIDER_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
      if (this.controller === controller) this.controller = undefined;
    }
  }

  prepareRequest(context: AgentContext): AgentContext {
    const reminder = this.pending ? REMINDER : null;
    this.pending = false;
    if (!reminder && !getCurrentSystemMessage(context.messages)?.sections?.[SECTION]) return context;
    return { ...context, messages: [...context.messages, { role: "system", content: "", sections: { [SECTION]: reminder }, timestamp: Date.now() }] };
  }
}
