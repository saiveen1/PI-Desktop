import type { AgentContext, AgentTurnContext } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import {
  isObserverGuardMode, isObserverGuardSettings, resolveObserverGuardSettings,
  type ObserverGuardAssessment, type ObserverGuardError, type ObserverGuardMode, type ObserverGuardSettings,
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
  private task = "";
  private userId?: string;
  private controller?: AbortController;
  private pending = false;
  private readonly evidence = new ObserverEvidenceWindow();

  constructor(private readonly sessionId?: string) {}

  get pendingCorrection(): boolean { return this.pending; }

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
    this.task = "";
    this.userId = undefined;
    this.evidence.reset();
  }

  setTask(task: string): void { this.task = task; }
  userMessage(id: string, steering: boolean): void {
    if (steering) { this.invalidated = true; this.cancel(); }
    else if (this.task) this.userId = id;
  }
  cancel(): void { this.pending = false; this.controller?.abort(); }

  observeTools(turn: AgentTurnContext): void {
    if (this.active?.mode !== "off" && this.active) this.evidence.observe(turn, resolveObserverGuardSettings(this.active.settings), this.secrets());
  }

  private secrets(): string[] {
    const provider = this.active?.provider;
    return [provider?.apiKey ?? "", ...Object.values(provider?.headers ?? {})];
  }

  async assess(turn: AgentTurnContext, sink: AssessmentSink | undefined, canContinue: () => boolean, budget: CorrectiveBudget, signal?: AbortSignal): Promise<{ action: "continue" } | undefined> {
    const config = this.active;
    const { message } = turn;
    const answer = message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
    if (!config || !isObserverGuardMode(config.mode) || config.mode === "off" || this.attempted || this.invalidated || !this.task || !this.userId || !sink ||
      signal?.aborted || message.stopReason !== "stop" || !answer.trim() || message.content.some(block => block.type === "toolCall")) return;
    this.attempted = true;
    const generation = this.generation;
    const settings = resolveObserverGuardSettings(config.settings);
    let assessment: ObserverGuardAssessment = {
      messageId: sink.messageId, mode: config.mode, status: "checking", startedAt: Date.now(), thinkingLevel: settings.thinkingLevel,
      ...(settings.providerId && settings.modelId ? { modelKey: `${settings.providerId}/${settings.modelId}` } : {}),
    };
    const publish = () => { if (generation === this.generation) sink.publish({ ...assessment }); };
    const fail = (errorCode: ObserverGuardError) => { assessment = { ...assessment, status: "error", errorCode, endedAt: Date.now() }; publish(); };
    publish();
    if (config.errorCode) { fail(ERRORS.includes(config.errorCode) ? config.errorCode : "MODEL_UNAVAILABLE"); return; }
    if (!settings.providerId || !settings.modelId) { fail("MODEL_NOT_CONFIGURED"); return; }
    const provider = config.provider;
    if (!provider || provider.id !== settings.providerId || provider.modelId !== settings.modelId) { fail("MODEL_UNAVAILABLE"); return; }
    if (!provider.supportedThinkingLevels.includes(settings.thinkingLevel)) { fail("EFFORT_UNAVAILABLE"); return; }
    if (!provider.apiKey && provider.authKind !== "none" && !provider.resolveAuth) { fail("PROVIDER_UNAVAILABLE"); return; }
    const input = this.evidence.build(this.task, this.userId, answer, sink.messageId,
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
      assessment = { ...assessment, ...verdict, reason: redactObserverText(verdict.reason, this.secrets()).slice(0, 300), status: "assessed", endedAt: Date.now() };
      if (config.mode === "observe") assessment.continuationBlocked = "observe_only";
      else if (verdict.verdict === "incomplete" && verdict.confidence === "high") {
        if (this.invalidated || !canContinue() || signal?.aborted || this.evidence.unsafe) assessment.continuationBlocked = "unsafe";
        else if (input.truncated || !actionableUserTask(this.task, this.evidence.hasToolProgress) || !observerResponseAllowsAction(answer)) assessment.continuationBlocked = "not_actionable";
        else if (!budget.claim()) assessment.continuationBlocked = "budget";
        else { this.pending = true; assessment.continued = true; }
      }
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
