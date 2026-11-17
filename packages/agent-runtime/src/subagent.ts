import { withToolImageCapability } from "./tool-image-context.js";
import { SubagentConversation } from "./subagent-conversation.js";
/**
 * Subagents: bounded delegate agent loops spawned by the `Task` tool (ADR 0062).
 *
 * A delegate is a second pi `Agent` inside the same sidecar process, with its
 * own system prompt, its own (possibly pinned) provider/model, and only the
 * tools its definition declares. It shares the session's host connection, so
 * every tool call it makes goes through the same host-core permission and
 * containment path as the parent's.
 *
 * Two boundaries define the design:
 * - The parent's model context only ever gains the delegate's final report
 *   (and a one-line heartbeat while it runs). Child messages and tool rows
 *   are emitted for the transcript and persisted for review, but the session
 *   runtime filters them out when it rebuilds model context.
 * - A delegate's lifecycle never reaches Electron main's turn handling. It
 *   runs in the background under the session runtime (ADR 0089 / D328):
 *   `Task` starts it and returns, `TaskWait` may converge early, and when it
 *   finishes the runtime delivers the report to the parent even if the parent
 *   already stopped calling tools. Cancellation and work budgets preserve partial reports.
 */

import { randomUUID } from "node:crypto";
import { toolExecutionMode, withDynamicTaskExecutionMode } from "./tool-execution-policy.js";
import { DESKTOP_AGENT_IDENTITY } from "./agent-identity.js";
import { initialSystemTranscript, replaceSystemPrompt } from "./system-transcript.js";
import {
  Agent,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type AgentEvent,
  type AgentLoopTurnUpdate,
  type AgentMessage,
  type AgentTool,
  type PrepareNextTurnContext,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  addUsage,
  DEFAULT_DELEGATION_FAILURE_POLICY,
  isDelegationFailurePolicy,
  type DelegationFailurePolicy,
  resolveDelegationRunPolicy,
  resolveUnknownUpstreamRetryLimit,
  describeDelegationRunPolicy,
  type DelegationRunPolicy,
  cumulativeDelta,
  isCertificateVerificationError,
  subagentCanMutate,
  subagentToolsLabel,
  type AgentEventEnvelope,
  type MessageUsage,
  type SubagentDefinition,
  type SubagentRunStatus as SharedSubagentRunStatus,
  type SubagentThinkingLevel,
  type UiMessage,
} from "@pi-desktop/shared";
import { classifyAgentError } from "./agent-errors.js";
import { readLocalRequestErrorDetails } from "./local-request-errors.js";
import { recoverMalformedToolCalls } from "./tool-call-recovery.js";
import { withProviderFetchFailure } from "./provider-transport-recovery.js";
import {
  assistantContent,
  nowIso,
  usageFromPi,
} from "./agent-messages.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import { clampThinkingLevel } from "./thinking-level.js";
import { subagentModelBinding, type SubagentProviderRetryState } from "./subagent-model-binding.js";
import { contextBudgetFor } from "./context-budget.js";
import { convertToLlm } from "./pi-runtime-messages.js";
import {
  delegateRetentionMode,
  delegateContextBudgetFor,
  delegateSummaryModels,
  prepareDelegateTurnContext,
  subagentContextOverflowError,
  type DelegateTurnUpdate,
} from "./subagent-context.js";
import { SubagentProgress, SUBAGENT_REPORT_TOOL, SUBAGENT_FINAL_REPORT_PROMPT } from "./subagent-progress.js";
import { SubagentObserver } from "./subagent-observability.js";
import type { SubagentObservation } from "@pi-desktop/shared";
import {
  readSubagentTerminalResponse,
  subagentReportOutcome,
  type SubagentTerminalDiagnostics,
  type SubagentTerminalResponse,
} from "./subagent-terminal.js";
import {
  dedupeToolCallMessages,
  createToolCallIdentity,
  reportDuplicateToolCallDrop,
} from "./tool-call-dedupe.js";
import { removeTrailingAssistantMessages } from "./system-transcript.js";
import {
  classifyProviderError,
  delayWithAbort,
  PROVIDER_RATE_LIMIT_MAX_RETRIES,
  PROVIDER_TRANSIENT_MAX_RETRIES,
  isTransientProviderRetryCode,
  isUnknownUpstreamBadRequest,
  providerRateLimitDelayMs,
  providerSetupRetryDelayMs,
} from "./provider-retry.js";

export const SUBAGENT_TOOL_NAME = "Task";
/** Converge on running delegations and read their reports (ADR 0089). */
export const SUBAGENT_WAIT_TOOL_NAME = "TaskWait";
/** Report on the session's delegations without waiting (ADR 0089). */
export const SUBAGENT_LIST_TOOL_NAME = "TaskList";
/** Stop running delegations (ADR 0089). */
export const SUBAGENT_STOP_TOOL_NAME = "TaskStop";

/** The report is the only thing that enters the parent's context; keep it
 * from becoming the context problem delegation was supposed to avoid. */
export const MAX_SUBAGENT_REPORT_CHARS = 12_000;

export type SubagentRunStatus = SharedSubagentRunStatus;
export type { SubagentTerminalDiagnostics } from "./subagent-terminal.js";

export type SubagentRunResult = {
  agentName: string;
  /** Provider/model used by this run after delegation resolution. */
  modelId: string;
  /** Thinking selection passed to the delegate after inheritance/clamping. */
  thinkingLevel: SubagentThinkingLevel;
  status: SubagentRunStatus;
  /** Text handed back to the parent model. */
  report: string;
  /** Provider requests the delegate spent. */
  turns: number;
  toolCalls: number;
  usage?: MessageUsage;
  modelFailures?: Array<{ model: string; code: string; message: string }>;
  /** In-memory context compactions the run needed (ADR 0299). */
  contextCompactions?: number;
  /** True when the run had to discard working history without a summary. */
  contextDegraded?: boolean;
  /** True when the delegate response hit the model's output token limit. */
  outputTruncated?: boolean;
  /** File path in session scratch where the complete report was preserved. */
  scratchReportPath?: string;
  /** Host-owned JSON checkpoint for resume/partial-result recovery. */
  checkpointPath?: string;
  /** Checkpoint persistence failure; the in-memory result remains available. */
  checkpointError?: string;
  partial?: boolean;
  terminal?: SubagentTerminalDiagnostics;
  runPolicy?: Readonly<DelegationRunPolicy>;
  observation?: SubagentObservation;
  error?: {
    code: string;
    message: string;
    resumeId?: string;
    charactersProduced?: number;
  };
};

export type SubagentToolOutcome = {
  isError?: boolean;
  terminate?: boolean;
  error?: { code: string; message: string };
};

export type SubagentRunOptions = {
  definition: SubagentDefinition;
  sessionId: string;
  /** Parent durable turn; child rows are attributed to the same turn. */
  turnId?: string;
  /** `Task` call that owns this delegate. */
  parentToolCallId: string;
  /** Delegation identifier issued by the runtime for this task run (ADR 0279). */
  delegationId?: string;
  /** Session scratch workspace root for persistent spillover artifacts (ADR 0062). */
  scratchDir?: string;
  /** Stable chain identity used for checkpoint files across Task(resume) runs. */
  delegateSessionId?: string;
  /** Scheduling policy captured for this run; legacy definition watchdogs stay ignored. */
  runPolicy?: Partial<DelegationRunPolicy>;
  /** Immutable starting policy; absent/inherit retains session retry behavior. */
  failurePolicy?: DelegationFailurePolicy;
  /** Latest validated report from this chain, kept when transcript seeding is trimmed. */
  initialReport?: string;
  /** Publish live checkpoint locations through the owning Task record. */
  onCheckpoint?: (paths: { checkpointPath?: string; reportPath?: string; error?: string }) => void;
  /** Live child counters; never forwarded as parent turn lifecycle events. */
  onProgress?: (progress: { turns: number; toolCalls: number }) => void;
  /** Observable request/tool facts; never a request for parent supervision. */
  onObservation?: (observation: SubagentObservation) => void;
  /** The delegated instruction, written by the parent model. */
  task: string;
  /** Provider resolved by Electron main (the definition's pin, or the
   * session's provider when the definition pins nothing). */
  provider: RuntimeProviderConfig;
  /** Inherited session policy for retrying transient provider failures. */
  infiniteProviderRetry?: boolean;
  unknownUpstreamRetryLimit?: number;
  agentOutputGuard?: import("@pi-desktop/shared").AgentOutputGuardSettings;
  thinkingLevel: SubagentThinkingLevel;
  /** User-owned definition pins only, in configured order. Missing bindings fail visibly. */
  fallbackModels?: Array<{ key: string; provider?: RuntimeProviderConfig }>;
  /** Refresh candidates only at a provider-failure switch boundary. */
  refreshFallbackModels?: () => Promise<Array<{ key: string; provider?: RuntimeProviderConfig }>>;
  /** Authorization may return the exact selected provider rather than a boolean. */
  authorizeModel?: (provider: RuntimeProviderConfig, signal: AbortSignal) => Promise<boolean | RuntimeProviderConfig>;
  /** Original parent thinking selection, before primary-model clamping. */
  inheritedThinkingLevel?: SubagentThinkingLevel;
  onModelChange?: (provider: RuntimeProviderConfig, thinkingLevel: SubagentThinkingLevel) => void;
  /** Fully composed child system prompt (see `composeSubagentSystemPrompt`). */
  systemPrompt: string;
  /** Host-backed tools, built by the session runtime so a delegate's calls
   * take the exact same path as the parent's. */
  tools: AgentTool[];
  /** Provenance from the runtime registry, not inferred from a dynamic tool's name. */
  builtinToolNames?: ReadonlySet<string>;
  /** Ordered preparation owned by this delegate, never the parent's prompt state. */
  beforeToolCall?: (context: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined>;
  /** After pi ends one turn of this delegate, its tool batch included. */
  onTurnEnd?: (message: AgentMessage) => void;
  onEvent: (envelope: AgentEventEnvelope) => void;
  /**
   * Result of the parent's own `afterToolCall` bookkeeping for one call, so a
   * host failure reaches the delegate's tool-error channel the same way it
   * reaches the parent's.
   */
  resolveToolOutcome?: (
    context: AfterToolCallContext,
  ) => SubagentToolOutcome | undefined;
  signal?: AbortSignal;
  /**
   * Prior chain messages that seed this run (ADR 0279). Omitted for a cold
   * start. The original `task` is still passed to `prompt()` as the new user
   * turn; these messages are everything that came before it.
   */
  initialMessages?: AgentMessage[];
};

/**
 * Compose the delegate's system prompt.
 *
 * The session runtime owns the shared parts (shell dialect, scratch
 * directory, project instruction chain) because it is the only place that
 * knows them; this function only decides the framing and the ordering, with
 * the definition body ahead of the workspace guidance so a project's own
 * instructions still have the last word.
 */
export function composeSubagentSystemPrompt(options: {
  definition: SubagentDefinition;
  /** Guidance blocks inherited from the session (shell, scratch, rules). */
  guidance?: string[];
  /** Spawn-time tool names after inherit resolution. */
  toolNames?: readonly string[];
}): string {
  const { definition } = options;
  const resolved = options.toolNames;
  const toolList =
    resolved && resolved.length > 0
      ? resolved.join(", ")
      : subagentToolsLabel(definition);
  const framing = [
    `You are the \"${definition.name}\" subagent inside PI-Desktop, working on one task delegated by the main agent.`,
    `You may receive direct user follow-up messages in this task. You cannot ask questions or delegate further. Finish the task with the tools you have: ${toolList}.`,
    subagentCanMutate(definition, resolved)
      ? "You may change files, but only the ones the task is about; leave everything else untouched."
      : "You have no tools that change files or run commands, so never report an edit you could not have made.",
    "Your final message is the report the main agent receives when you finish. Make it self-contained: what you did, what you found with exact paths and line numbers, and anything you could not finish.",
    "Keep the report tight. Report findings, not narration, and never pad it with a summary of your own process.",
    "The runtime also provides TaskReport to save progress without granting workspace writes. Use it to record evidence and next steps when useful. Progress summaries are optional; state and final text are saved automatically.",
    "If you discover in the first few turns that you lack a tool essential to the task (e.g. no Bash when shell commands are needed), stop immediately with a one-sentence report naming the missing capability. Do not attempt workarounds or pad the report with unrelated reading.",
  ].join("\n");
  return [framing, definition.prompt, ...(options.guidance ?? [])]
    .filter((block) => block.trim().length > 0)
    .join("\n\n");
}

function boundedReport(value: string): string {
  const text = value.trim();
  if (text.length <= MAX_SUBAGENT_REPORT_CHARS) return text;
  const marker = "\n\n[subagent report truncated]\n\n";
  const available = MAX_SUBAGENT_REPORT_CHARS - marker.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

export { addUsage };

/** One delegate execution. A resumed run is still a new instance; it is
 * seeded with the prior chain's messages rather than kept warm in memory. */
export class SubagentRun {
  private readonly uniqueToolCalls: ReturnType<typeof createToolCallIdentity>;
  private readonly agent: Agent;
  private readonly conversation: SubagentConversation;
  private readonly opts: SubagentRunOptions;
  private currentAssistant?: UiMessage;
  /** Retained progress is useful on failure, never proof of terminal delivery. */
  private lastReportText = "";
  private terminalResponse?: SubagentTerminalResponse;
  private turns = 0;
  private toolCalls = 0;
  private usage?: MessageUsage;
  private streamError?: { code: string; message: string };
  private mutationTermination?: { code: string; message: string };
  /** Set when a settled message reads as a cancel — `stopReason: "aborted"`, or
   * a local marker whose preserved cause name is `AbortError`. pi-ai can wrap
   * an abort that fired before the parent signal flipped, so this is the only
   * trace of the Stop and the run has to report `aborted` from it. */
  private turnAborted = false;
  private contextCompactions = 0;
  private contextDegraded = false;
  /** Set when the turn-boundary guard throws because even the degraded
   * context does not fit; the synthetic stream error keeps this code. */
  private pendingContextOverflow?: { code: "SUBAGENT_CONTEXT_OVERFLOW"; message: string };
  private pendingProviderRetry?: ReturnType<typeof classifyAgentError>;
  private providerRetryInProgress = false;
  private providerTransientRetryAttempt = 0;
  private providerRateLimitRetryAttempt = 0;
  private providerUnknownRetryAttempt = 0;
  private readonly unknownUpstreamRetryLimit: number;
  private provider: RuntimeProviderConfig;
  private thinkingLevel: SubagentThinkingLevel;
  private readonly attemptedModels = new Set<string>();
  private readonly modelFailures: NonNullable<SubagentRunResult["modelFailures"]> = [];
  private readonly runPolicy: Readonly<DelegationRunPolicy>;
  private readonly failurePolicy: Readonly<DelegationFailurePolicy>;
  private fallbackSwitches = 0;
  private budgetTimer?: ReturnType<typeof setTimeout>;
  private budgetExceeded?: { code: "SUBAGENT_BUDGET_EXHAUSTED"; message: string };
  private readonly retryState: SubagentProviderRetryState = {
    claim: (error, phase) => this.claimProviderRetry(error, phase),
    // Explicit failure modes permit only classified retries, never a hidden repair request.
    allowOutputLimitRepair: () => !this.finalizing && this.failurePolicy.mode === "inherit",
    onRetry: ({ error, attempt, delayMs }) => this.publishProviderRetry(error, attempt, delayMs),
    onAttemptStart: () => this.emit({ type: "status", status: {
      sessionId: this.opts.sessionId, isRunning: true, pendingToolConfirmations: 0,
      ...(this.opts.turnId ? { currentTurnId: this.opts.turnId } : {}),
      activity: { phase: "waiting-model", since: Date.now() },
    } }),
  };
  private runAbortController = new AbortController();
  private readonly progress: SubagentProgress;
  private readonly observer: SubagentObserver;
  private admittedToolCalls = 0;
  private finalizing = false;
  private reportRecoveryAttempt = 0;
  private reportTimedOut = false;
  private providerRetries = 0;

  constructor(opts: SubagentRunOptions) {
    this.opts = opts;
    this.runPolicy = resolveDelegationRunPolicy(opts.runPolicy);
    if (opts.failurePolicy !== undefined && !isDelegationFailurePolicy(opts.failurePolicy)) {
      throw new Error("Invalid subagent failure policy");
    }
    this.failurePolicy = Object.freeze({ ...(opts.failurePolicy ?? DEFAULT_DELEGATION_FAILURE_POLICY) });
    this.unknownUpstreamRetryLimit = resolveUnknownUpstreamRetryLimit(opts.unknownUpstreamRetryLimit);
    const initialMessages = recoverMalformedToolCalls(opts.initialMessages ?? []);
    this.uniqueToolCalls = createToolCallIdentity(initialMessages);
    this.provider = opts.provider;
    this.thinkingLevel = opts.thinkingLevel;
    this.attemptedModels.add(`${opts.provider.id}/${opts.provider.modelId}`);
    this.observer = new SubagentObserver(`${opts.provider.id}/${opts.provider.modelId}`, () => this.saveProgress(),
      new Set(opts.builtinToolNames ?? []));
    this.progress = new SubagentProgress({
      scratchDir: opts.scratchDir, delegateSessionId: opts.delegateSessionId,
      parentToolCallId: opts.parentToolCallId, initialReport: opts.initialReport,
      observation: () => this.observer.snapshot(),
      metadata: () => ({
        version: 1, sessionId: opts.sessionId,
        delegateSessionId: opts.delegateSessionId ?? opts.parentToolCallId,
        delegationId: opts.delegationId ?? opts.parentToolCallId, task: opts.task,
        agentName: opts.definition.name, modelId: this.provider.modelId,
        thinkingLevel: this.thinkingLevel, turns: this.turns, toolCalls: this.toolCalls,
        updatedAt: Date.now(), contextCompactions: this.contextCompactions,
        contextDegraded: this.contextDegraded, runPolicy: this.runPolicy,
      }),
    });
    const binding = this.modelBinding();
    const systemPrompt = `${opts.systemPrompt}\n\n${describeDelegationRunPolicy(this.runPolicy)}`;
    const tools = [...opts.tools.filter(tool => tool.name !== SUBAGENT_REPORT_TOOL), this.progress.tool];
    this.agent = new Agent({
      identity: DESKTOP_AGENT_IDENTITY,
      streamFn: binding.streamFn,
      getApiKey: binding.getApiKey,
      convertToLlm: (messages) =>
        convertToLlm(
          this.dedupeToolCalls(messages),
          this.agent.state.model.input.includes("image"),
        ),
      // The same turn-boundary context protection the session has (ADR 0299):
      // re-estimate at each boundary, compact before the next request, degrade
      // before failing. The budget derives from this run's resolved model.
      prepareNextTurnWithContext: (context, signal) =>
        this.prepareNextTurn(context, signal),
      afterToolCall: async (context) => this.afterToolCall(context),
      beforeToolCall: async (context) => {
        if (this.finalizing || this.budgetExceeded) {
          return { block: true, reason: "The delegation is closing; no new work tools may run.", terminate: true };
        }
        if (this.runPolicy.maxToolCalls > 0 && this.admittedToolCalls >= this.runPolicy.maxToolCalls) {
          this.stopForBudget("tool_calls");
          return { block: true, reason: "The tool-call budget is exhausted.", terminate: true };
        }
        this.admittedToolCalls++;
        if (context.toolCall.name === SUBAGENT_REPORT_TOOL) return;
        return opts.beforeToolCall?.(context);
      },
      prepareRequest: ({ context }) => ({
        context: this.progress.prepareRequest(context, this.finalizing),
      }),
      finishTurn: (turn) => {
        if (this.finalizing || this.mutationTermination) return { action: "end" };
        if (this.runPolicy.maxToolCalls > 0 && this.admittedToolCalls >= this.runPolicy.maxToolCalls) this.stopForBudget("tool_calls");
        if (this.budgetExceeded) return { action: "end" };
        if (turn.message.stopReason === "stop") this.saveProgress();
        return undefined;
      },
      initialState: {
        systemPrompt,
        model: binding.model,
        // Preserve the parent's provenance decision; a same-name extension must
        // not inherit the builtin allowlist. Also reject unproven parallel hints.
        tools: tools.map((tool) =>
          withDynamicTaskExecutionMode(
            {
              ...withToolImageCapability(tool, () => this.agent.state.model.input.includes("image")),
              executionMode:
                tool.executionMode === "parallel"
                  ? toolExecutionMode(tool.name, true)
                  : "sequential",
            },
            () => this.agent?.state.messages.at(-1),
          ),
        ),
        thinkingLevel: binding.agentThinkingLevel,
        messages: initialSystemTranscript(systemPrompt, tools, [...initialMessages]),
      },
      toolExecution: "parallel",
    });
    this.conversation = new SubagentConversation(this.agent, message => {
      this.emit({ type: "message_start", message });
      this.emit({ type: "message_end", message });
      this.saveProgress();
    });
    this.agent.subscribe((event) => this.handleEvent(event));
  }

  sendMessage(message: UiMessage): boolean {
    if (this.runSignal().aborted || this.finalizing || this.budgetExceeded) return false;
    return this.conversation.send(message);
  }

  setSystemPrompt(prompt: string): void {
    this.agent.state.messages = replaceSystemPrompt(this.agent.state.messages, `${prompt}\n\n${describeDelegationRunPolicy(this.runPolicy)}`);
  }

  async run(): Promise<SubagentRunResult> {
    const { signal } = this.opts;
    if (signal?.aborted) return this.result("aborted", this.lastReportText);
    this.saveProgress();
    this.observer.start();
    this.startBudgetTimer();
    const onAbort = () => {
      this.runAbortController.abort();
      this.agent.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let caughtError: ReturnType<typeof classifyAgentError> | undefined;
    try {
      try {
        const initialTaskMessage: AgentMessage = {
          role: "user", content: this.opts.task, timestamp: Date.now(),
        };
        const agentState = this.agent.state;
        const preflightModel = agentState?.model ?? this.modelBinding().model;
        const initialContext = await prepareDelegateTurnContext({
          messages: (agentState?.messages ?? []).filter(message => message.role !== "system"),
          additionalMessages: [initialTaskMessage], model: preflightModel,
          taskBrief: this.opts.task, retentionMode: "active_turn",
          summaryModels: () => delegateSummaryModels(this.provider, preflightModel,
            this.opts.sessionId, usage => this.recordUsage(usage)),
          systemPrompt: agentState?.systemPrompt ?? this.opts.systemPrompt,
          tools: agentState?.tools ?? this.opts.tools,
          retainTaskBriefOnDegradation: false,
          thinkingLevel: agentState?.thinkingLevel ?? this.thinkingLevel,
          signal: this.runSignal(),
        });
        if (initialContext.kind === "overflow") {
          this.streamError = subagentContextOverflowError(this.provider.modelId);
        } else if (!this.runSignal().aborted) {
          if (initialContext.kind !== "unchanged") this.installContextOutcome(initialContext);
          await this.agent.prompt(this.opts.task);
          await this.agent.waitForIdle();
          while (!this.runSignal().aborted && !this.budgetExceeded) {
            if (this.pendingProviderRetry) await this.retryPendingProviderFailure();
            else if (this.streamError && await this.useNextModel()) {
              await this.agent.continue();
              await this.agent.waitForIdle();
            } else if (!this.streamError && !this.turnAborted && this.conversation.hasPending) {
              await this.agent.continue();
              await this.agent.waitForIdle();
            } else break;
          }
        }
      } catch (error) {
        caughtError = classifyAgentError(error);
      }
      this.finalizeCurrentAssistant();
      if (this.budgetExceeded && !signal?.aborted) await this.finalizeReport();
      else if (!signal?.aborted && !this.turnAborted && !caughtError && !this.streamError && !this.mutationTermination &&
          this.runPolicy.reportRecoveryAttempts === 1 && subagentReportOutcome(this.terminalResponse) !== "delivered") {
        this.reportRecoveryAttempt = 1;
        await this.finalizeReport();
      }
    } finally {
      this.conversation.close();
      signal?.removeEventListener("abort", onAbort);
      this.clearBudgetTimer();
      this.observer.stop();
      this.finalizeCurrentAssistant();
    }
    // User cancellation always wins over a simultaneous runtime limit.
    if (signal?.aborted) return this.result("aborted", this.lastReportText);
    if (this.budgetExceeded) return this.result("failed", this.lastReportText, this.budgetExceeded);
    if (!this.reportTimedOut && (this.turnAborted || caughtError?.code === "TURN_ABORTED")) return this.result("aborted", this.lastReportText);
    const error = this.mutationTermination ?? caughtError ?? this.streamError;
    if (error) return this.result("failed", this.lastReportText, this.terminalError(error));
    if (subagentReportOutcome(this.terminalResponse) === "truncated") {
      const produced = this.terminalResponse?.text.length ?? 0;
      const hint = this.opts.delegationId ? ` Resume this delegation with Task(resume: "${this.opts.delegationId}").` : "";
      return this.result("failed", this.lastReportText, {
        code: "SUBAGENT_OUTPUT_TRUNCATED",
        message: `The subagent response exceeded the model's output token limit and was truncated (${produced} characters produced before truncation).${hint}`,
        ...(this.opts.delegationId ? { resumeId: this.opts.delegationId } : {}),
        charactersProduced: produced,
      });
    }
    if (subagentReportOutcome(this.terminalResponse) !== "delivered") return this.result("failed", "", {
      code: "SUBAGENT_NO_REPORT", message: "The subagent finished without writing a final report.",
    });
    return this.result("completed", this.terminalResponse?.text ?? "");
  }

  /** One tool-free request, shared by budget closure and opt-in report recovery. */
  private async finalizeReport(): Promise<void> {
    if (this.opts.signal?.aborted) return;
    this.finalizing = true;
    this.clearBudgetTimer();
    this.runAbortController = new AbortController();
    this.pendingProviderRetry = undefined;
    this.streamError = undefined;
    this.turnAborted = false;
    this.budgetTimer = setTimeout(() => {
      this.reportTimedOut = true;
      this.streamError = { code: "SUBAGENT_REPORT_TIMEOUT", message: "The final report request reached its configured deadline; retained progress is available." };
      this.runAbortController.abort();
      this.agent.abort();
    }, this.runPolicy.finalReportTimeoutSeconds * 1000);
    this.budgetTimer.unref?.();
    try {
      await this.agent.prompt(SUBAGENT_FINAL_REPORT_PROMPT);
      await this.agent.waitForIdle();
    } catch (error) {
      // The pre-existing checkpoint remains the partial result if reporting fails.
      this.progress.error = { code: "SUBAGENT_FINAL_REPORT_FAILED", message: "The reserved report request did not finish; retained progress is available." };
      if (!this.streamError && !this.opts.signal?.aborted) this.streamError = classifyAgentError(error);
    } finally {
      this.clearBudgetTimer();
    }
  }

  private saveProgress(): void {
    const saved = this.progress.save("running", this.progress.partialText(this.lastReportText));
    this.opts.onCheckpoint?.(saved);
    this.opts.onObservation?.(this.observer.snapshot());
  }

  private modelBinding() {
    return this.bindingFor(this.provider, this.thinkingLevel);
  }
  private dedupeToolCalls(messages: AgentMessage[]): AgentMessage[] {
    const drop = dedupeToolCallMessages(messages);
    reportDuplicateToolCallDrop(this.opts.sessionId, drop);
    return drop.messages;
  }

  private recordUsage(usage: MessageUsage): void {
    this.usage = addUsage(this.usage, usage);
    this.emit({ type: "usage", usage });
  }

  private bindingFor(
    provider: RuntimeProviderConfig,
    thinkingLevel: SubagentThinkingLevel,
  ) {
    return subagentModelBinding({
      provider,
      thinkingLevel,
      sessionId: this.opts.sessionId,
      scratchDir: this.opts.scratchDir,
      maxTokens: this.opts.definition.maxTokens,
      agentOutputGuard: this.opts.agentOutputGuard,
      onUsage: usage => this.recordUsage(usage),
      observeStream: createStream => this.observer.observeStream(`${provider.id}/${provider.modelId}`, createStream),
      uniqueToolCalls: this.uniqueToolCalls,
    }, this.retryState);
  }

  private installContextOutcome(
    outcome: Extract<DelegateTurnUpdate, { kind: "compacted" | "degraded" }>,
  ): void {
    const systemMessage = this.agent.state.messages.find(
      (message) => message.role === "system",
    );
    this.agent.state.messages = [
      ...(systemMessage ? [systemMessage] : []),
      ...outcome.messages.filter((message) => message.role !== "system"),
    ];
    if (outcome.kind === "compacted") {
      this.contextCompactions += 1;
      const summary = outcome.messages.find(message => message.role === "compactionSummary");
      if (summary && "summary" in summary && typeof summary.summary === "string") {
        this.progress.recordContextSummary(summary.summary);
        this.saveProgress();
      }
    } else {
      this.contextDegraded = true;
    }
  }

  /**
   * Shape the delegate's next in-run turn, mirroring the session's
   * `prepareNextTurn` (ADR 0299, decisions 2-4). A compaction rewrites only
   * this agent's model context; its generated summary also joins the recovery report.
   */
  private async prepareNextTurn(
    turn: PrepareNextTurnContext,
    signal?: AbortSignal,
  ): Promise<AgentLoopTurnUpdate | undefined> {
    if (this.finalizing) {
      const budget = delegateContextBudgetFor(this.agent.state.model, this.agent.state.messages, [],
        `${this.agent.state.systemPrompt}\n${SUBAGENT_FINAL_REPORT_PROMPT}`, []);
      if (budget.tokens >= budget.hardLimit) {
        this.pendingContextOverflow = subagentContextOverflowError(this.provider.modelId);
        throw new Error(this.pendingContextOverflow.message);
      }
      return undefined;
    }
    const outcome = await prepareDelegateTurnContext({
      messages: this.agent.state.messages,
      systemPrompt: this.agent.state.systemPrompt,
      tools: this.agent.state.tools,
      model: this.agent.state.model,
      taskBrief: this.opts.task,
      retentionMode: delegateRetentionMode(turn),
      summaryModels: () =>
        delegateSummaryModels(
          this.provider,
          this.agent.state.model,
          this.opts.sessionId,
          usage => this.recordUsage(usage),
        ),
      thinkingLevel: this.agent.state.thinkingLevel,
      signal: signal ?? this.runSignal(),
    });
    if (outcome.kind === "unchanged") return undefined;
    if (outcome.kind === "overflow") {
      // The Agent wrapper converts this throw into the normal error/agent_end
      // sequence; `message_end` picks the pending overflow up so the run
      // surfaces SUBAGENT_CONTEXT_OVERFLOW instead of a classified provider
      // error, and `useNextModel` still gets its fallback pass first.
      this.pendingContextOverflow = subagentContextOverflowError(
        this.provider.modelId,
      );
      throw new Error(this.pendingContextOverflow.message);
    }
    this.installContextOutcome(outcome);
    return {
      context: {
        // The loop owns its context array: pi appends every streamed assistant
        // message and every tool result to the array it was handed, while its
        // own `message_end` listener appends the same message to
        // `state.messages`. Handing over the live array stores each message of
        // the run's later iterations twice, which doubles the estimate at the
        // next boundary and leaves `useNextModel` a trailing assistant row it
        // cannot resume from (D620).
        messages: [...this.agent.state.messages],
        tools: this.agent.state.tools,
      },
    };
  }

  /** Continue the same agent at the failed request; never replay completed tools. */
  private async useNextModel(): Promise<boolean> {
    if (this.finalizing || this.budgetExceeded || this.runSignal().aborted || this.turnAborted || !this.streamError || this.streamError.code === "TURN_ABORTED") return false;
    if (this.failurePolicy.mode === "stop" || this.failurePolicy.mode === "retry" ||
      (this.failurePolicy.mode === "fallback" && this.fallbackSwitches >= this.failurePolicy.maxFallbacks)) return false;
    const failed = this.agent.state.messages.at(-1);
    // Only terminal provider errors permit switching. Host/tool errors never do.
    if (failed?.role !== "assistant" || failed.stopReason !== "error" || readLocalRequestErrorDetails(failed)) return false;
    let fallbacks = this.opts.refreshFallbackModels ? await this.opts.refreshFallbackModels() : this.opts.fallbackModels ?? [];
    if (!fallbacks.length || this.runSignal().aborted) return false;
    this.recordModelFailure(`${this.provider.id}/${this.provider.modelId}`, this.streamError);
    const carried = this.agent.state.messages.slice(0, -1);
    while (this.attemptedModels.size < 128) {
      const next = fallbacks.find(row => !this.attemptedModels.has(row.provider ? `${row.provider.id}/${row.provider.modelId}` : row.key));
      if (!next || this.runSignal().aborted) return false;
      const identity = next.provider ? `${next.provider.id}/${next.provider.modelId}` : next.key;
      this.attemptedModels.add(identity);
      if (!next.provider) {
        this.recordModelFailure(next.key, { code: "MODEL_NOT_CONFIGURED", message: "The configured fallback model could not be resolved." });
        continue;
      }
      const requested = this.opts.definition.thinkingLevel ?? this.opts.inheritedThinkingLevel ?? this.opts.thinkingLevel;
      let provider = next.provider;
      let thinking = requested === "omit" ? "omit" : clampThinkingLevel(provider, requested);
      let binding = this.bindingFor(provider, thinking);
      const budget = contextBudgetFor(binding.model, carried);
      if (budget.tokens >= budget.hardLimit) {
        this.recordModelFailure(identity, { code: "SUBAGENT_CONTEXT_OVERFLOW",
          message: `The carried context (~${budget.tokens} tokens) does not fit this model's safe budget (${budget.hardLimit} tokens).` });
        continue;
      }
      let admitted: boolean | RuntimeProviderConfig;
      if (this.opts.authorizeModel) {
        this.observer.approval(identity, "pending");
        try {
          admitted = await this.opts.authorizeModel(provider, this.runSignal());
          this.observer.approval(typeof admitted === "object" ? `${admitted.id}/${admitted.modelId}` : identity,
            this.runSignal().aborted ? "cancelled" : admitted ? "accepted" : "rejected");
        } catch (error) {
          this.observer.approval(identity, this.runSignal().aborted ? "cancelled" : "rejected");
          throw error;
        }
      } else admitted = true;
      if (!admitted) {
        this.recordModelFailure(identity, { code: "MODEL_NOT_AUTHORIZED", message: "The alternative model was not authorized for this delegation." });
        fallbacks = this.opts.refreshFallbackModels ? await this.opts.refreshFallbackModels() : fallbacks;
        continue;
      }
      if (typeof admitted === "object") {
        provider = admitted;
        const selectedKey = `${provider.id}/${provider.modelId}`;
        if (selectedKey !== identity && this.attemptedModels.has(selectedKey)) throw new Error("The selected model was already attempted; no substitute was started.");
        this.attemptedModels.add(selectedKey);
        thinking = requested === "omit" ? "omit" : clampThinkingLevel(provider, requested);
        binding = this.bindingFor(provider, thinking);
        const selectedBudget = contextBudgetFor(binding.model, carried);
        if (selectedBudget.tokens >= selectedBudget.hardLimit) throw new Error("The selected model cannot hold the carried context; no substitute was started.");
      }
      if (this.runSignal().aborted) return false;
      this.provider = provider;
      this.fallbackSwitches++;
      this.thinkingLevel = thinking;
      this.agent.state.model = binding.model;
      this.agent.state.thinkingLevel = binding.agentThinkingLevel;
      this.agent.streamFunction = binding.streamFn;
      this.agent.getApiKey = binding.getApiKey;
      this.agent.state.messages = carried;
      this.streamError = undefined;
      this.providerTransientRetryAttempt = 0;
      this.providerRateLimitRetryAttempt = 0;
      this.providerUnknownRetryAttempt = 0;
      this.lastReportText = "";
      this.terminalResponse = undefined;
      this.opts.onModelChange?.(this.provider, this.thinkingLevel);
      this.observer.selected(`${this.provider.id}/${this.provider.modelId}`);
      return !this.runSignal().aborted;
    }
    return false;
  }

  private recordModelFailure(model: string, error: { code: string; message: string }): void {
    this.modelFailures.push({ model, ...error });
    this.emit({
      type: "message_end",
      message: {
        ...this.newAssistantRow(),
        content: `Model ${model} failed (${error.code}): ${error.message}`,
        status: "error",
        isError: true,
      },
    });
  }

  private claimProviderRetry(
    error: ReturnType<typeof classifyAgentError>,
    phase: "request" | "stream",
  ): number | undefined {
    if (this.finalizing || this.budgetExceeded || this.runSignal().aborted || error.details?.origin === "local") return undefined;
    const inherited = this.failurePolicy.mode === "inherit";
    if (!inherited && (this.failurePolicy.mode === "stop" ||
      this.providerTransientRetryAttempt + this.providerRateLimitRetryAttempt + this.providerUnknownRetryAttempt >= this.failurePolicy.maxRetries)) return undefined;
    if (isUnknownUpstreamBadRequest(error)) {
      if (this.providerUnknownRetryAttempt >= this.unknownUpstreamRetryLimit) return undefined;
      return ++this.providerUnknownRetryAttempt;
    }
    if (!error.retriable) return undefined;
    const infinite = inherited && this.opts.infiniteProviderRetry === true;
    if (error.code === "PROVIDER_RATE_LIMITED") {
      if (!infinite && this.providerRateLimitRetryAttempt >= PROVIDER_RATE_LIMIT_MAX_RETRIES) {
        return undefined;
      }
      return ++this.providerRateLimitRetryAttempt;
    }
    // Setup and stream failures share one bounded budget, exactly as the main
    // session does, so a delegate is not abandoned on a single gateway 502.
    void phase;
    if (!isTransientProviderRetryCode(error.code)) return undefined;
    if (!infinite && this.providerTransientRetryAttempt >= PROVIDER_TRANSIENT_MAX_RETRIES) {
      return undefined;
    }
    return ++this.providerTransientRetryAttempt;
  }

  private publishProviderRetry(error: ReturnType<typeof classifyAgentError>, attempt: number, delayMs: number): void {
    this.providerRetries++;
    this.observer.phase("retrying");
    const unknown = isUnknownUpstreamBadRequest(error);
    if (this.failurePolicy.mode !== "inherit") {
      attempt = this.providerTransientRetryAttempt + this.providerRateLimitRetryAttempt + this.providerUnknownRetryAttempt;
    }
    this.emit({ type: "status", status: {
      sessionId: this.opts.sessionId, isRunning: true, pendingToolConfirmations: 0,
      ...(this.opts.turnId ? { currentTurnId: this.opts.turnId } : {}),
      activity: { phase: "retrying", since: Date.now(), attempt, retryDelayMs: delayMs,
        ...(this.failurePolicy.mode !== "inherit" ? { maxAttempts: this.failurePolicy.maxRetries }
          : unknown ? { maxAttempts: this.unknownUpstreamRetryLimit }
          : this.opts.infiniteProviderRetry ? { infinite: true } : {}),
        error: { code: error.code, message: error.message,
          ...(typeof error.details?.providerStatus === "number" ? { providerStatus: error.details.providerStatus } : {}) },
      },
    } });
  }

  private async retryPendingProviderFailure(): Promise<void> {
    const retryError = this.pendingProviderRetry;
    if (!retryError) return;
    this.pendingProviderRetry = undefined;
    // A failed provider stream can leave more than one assistant row after a
    // tool round. Compaction may already have replaced the failed assistant
    // with a summary or retained user message, so an assistant tail is
    // optional. Remove any failed suffix before continuing.
    const messages = removeTrailingAssistantMessages(this.agent.state.messages);
    this.agent.state.messages = messages;
    this.providerRetryInProgress = true;
    try {
      const attempt = retryError.code === "PROVIDER_RATE_LIMITED" ? this.providerRateLimitRetryAttempt
        : isUnknownUpstreamBadRequest(retryError) ? this.providerUnknownRetryAttempt : this.providerTransientRetryAttempt;
      const delayMs =
        retryError.code === "PROVIDER_RATE_LIMITED"
          ? providerRateLimitDelayMs(
              this.providerRateLimitRetryAttempt,
              this.retryState.headers,
            )
          : providerSetupRetryDelayMs(
              attempt,
              undefined,
              this.retryState.headers,
            );
      this.publishProviderRetry(retryError, attempt, delayMs);
      await delayWithAbort(delayMs, this.runSignal());
      if (this.runSignal().aborted) return;
      await this.agent.continue();
      await this.agent.waitForIdle();
    } finally {
      this.providerRetryInProgress = false;
    }
  }

  /**
   * The failure the parent receives once no fallback can proceed. A provider
   * overflow is remapped to the actionable delegate code (ADR 0299, decision
   * 5) — but only here, after `useNextModel` had its chance, so a larger
   * fallback window still rescues the run.
   */
  private terminalError(error: { code: string; message: string }): { code: string; message: string } {
    if (error.code === "CONTEXT_TOO_LARGE" || error.code === "SUBAGENT_CONTEXT_OVERFLOW") {
      return subagentContextOverflowError(this.provider.modelId);
    }
    return error;
  }

  private result(
    status: SubagentRunStatus,
    report: string,
    error?: {
      code: string;
      message: string;
      resumeId?: string;
      charactersProduced?: number;
    },
  ): SubagentRunResult {
    const name = this.opts.definition.name;
    this.observer.end(status === "completed" && subagentReportOutcome(this.terminalResponse) === "delivered");
    const body = status === "completed" ? report.trim() : this.progress.partialText(report || this.lastReportText);
    const text =
      status === "completed"
        ? body
        : status === "aborted"
          ? [
              `The ${name} subagent was aborted after ${this.turns} turn(s).`,
              ...(body ? ["Its last output was:", body] : []),
            ].join("\n\n")
          : [
              `The ${name} subagent failed after ${this.turns} turn(s): ${error?.message ?? "unknown error"}.`,
              ...(body ? ["Its last output was:", body] : []),
            ].join("\n\n");
    const degradationNote = this.contextDegraded
      ? "Note: this subagent's context exceeded its model's window and older working history was discarded without a summary, so this report may be incomplete."
      : undefined;
    const preamble = [
      ...this.modelFailures.map(
        (failure) =>
          `Model ${failure.model} failed (${failure.code}): ${failure.message}`,
      ),
      ...(degradationNote ? [degradationNote] : []),
      ...(this.progress.error ? [`Reporting issue: ${this.progress.error.message}`] : []),
    ];
    const completeReport = [...preamble, text].filter(Boolean).join("\n\n");
    const response = this.terminalResponse;
    const reportOutcome = status === "aborted" ? "cancelled"
      : status === "completed" ? "delivered"
        : error?.code === "SUBAGENT_NO_REPORT" || error?.code === "SUBAGENT_OUTPUT_TRUNCATED"
          ? subagentReportOutcome(response) : "error";
    const terminal: SubagentTerminalDiagnostics = {
      stopReason: response?.stopReason ?? "unknown",
      ...(response?.rawStopReason ? { rawStopReason: response.rawStopReason } : {}),
      textBlocks: response?.textBlocks ?? 0,
      thinkingBlocks: response?.thinkingBlocks ?? 0,
      toolCalls: response?.toolCalls ?? 0,
      reportOutcome,
      reportRecoveryAttempt: this.reportRecoveryAttempt,
      providerRetries: this.providerRetries,
    };
    const persisted = this.progress.save(status, completeReport, error, terminal);
    this.opts.onCheckpoint?.(persisted);
    const finalReport = persisted.reportPath && completeReport.length > MAX_SUBAGENT_REPORT_CHARS
      ? `${preamble.length > 0 ? `${preamble.join("\n\n")}\n\n` : ""}Complete subagent report (${completeReport.length} characters) was saved to: ${persisted.reportPath}`
      : boundedReport(completeReport);
    return {
      agentName: name,
      modelId: this.provider.modelId,
      thinkingLevel: this.thinkingLevel,
      status,
      report: finalReport,
      runPolicy: this.runPolicy,
      turns: this.turns,
      toolCalls: this.toolCalls,
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.modelFailures.length ? { modelFailures: [...this.modelFailures] } : {}),
      ...(this.contextCompactions > 0 ? { contextCompactions: this.contextCompactions } : {}),
      ...(this.contextDegraded ? { contextDegraded: true } : {}),
      ...(response?.stopReason === "length" ? { outputTruncated: true } : {}),
      ...(persisted.reportPath ? { scratchReportPath: persisted.reportPath } : {}),
      ...(persisted.checkpointPath ? { checkpointPath: persisted.checkpointPath } : {}),
      ...(persisted.error ? { checkpointError: persisted.error } : {}),
      ...(status !== "completed" ? { partial: true } : {}),
      terminal,
      observation: this.observer.snapshot(),
      ...(error ? { error } : {}),
    };
  }

  private startBudgetTimer(): void {
    if (this.runPolicy.maxDurationSeconds === 0) return;
    this.budgetTimer = setTimeout(() => this.stopForBudget("duration"), this.runPolicy.maxDurationSeconds * 1000);
    this.budgetTimer.unref?.();
  }

  private clearBudgetTimer(): void {
    if (this.budgetTimer !== undefined) clearTimeout(this.budgetTimer);
    this.budgetTimer = undefined;
  }

  private stopForBudget(kind: "tool_calls" | "duration"): void {
    if (this.budgetExceeded) return;
    const resumeId = this.opts.delegationId ?? "";
    this.budgetExceeded = {
      code: "SUBAGENT_BUDGET_EXHAUSTED",
      message: kind === "tool_calls"
        ? `The subagent reached its hard limit of ${this.runPolicy.maxToolCalls} tool calls. Continue it with Task(resume: "${resumeId}").`
        : `The subagent reached its hard runtime limit of ${this.runPolicy.maxDurationSeconds} seconds. Continue it with Task(resume: "${resumeId}").`,
    };
    this.saveProgress();
    if (kind === "duration") {
      this.runAbortController.abort();
      this.agent.abort();
    }
  }

  /** Parent bookkeeping: host failures and a mutation-failure terminate. */
  private async afterToolCall(
    context: AfterToolCallContext,
  ): Promise<AfterToolCallResult | undefined> {
    const parent = this.opts.resolveToolOutcome?.(context);
    const terminate = parent?.terminate === true;
    if (!parent?.isError && !terminate) return undefined;
    if (terminate && parent?.error) this.mutationTermination = parent.error;
    return {
      ...(parent?.isError ? { isError: true } : {}),
      ...(terminate ? { terminate: true } : {}),
    };
  }

  private emit(event: AgentEventEnvelope["event"]): void {
    this.opts.onEvent({
      sessionId: this.opts.sessionId,
      turnId: this.opts.turnId,
      ts: Date.now(),
      event,
      parentToolCallId: this.opts.parentToolCallId,
      agentName: this.opts.definition.name,
    });
  }

  /**
   * Parent cancellation also interrupts the reserved report phase. The run
   * controller is renewed only after budget-limited exploration retires.
   */
  private runSignal(): AbortSignal {
    return AbortSignal.any(
      this.opts.signal
        ? [this.opts.signal, this.runAbortController.signal]
        : [this.runAbortController.signal],
    );
  }

  private newAssistantRow(): UiMessage {
    return {
      id: randomUUID(),
      role: "assistant",
      content: "",
      createdAt: nowIso(),
      status: "streaming",
      modelId: this.provider.modelId,
      providerId: this.provider.id,
      parentToolCallId: this.opts.parentToolCallId,
      agentName: this.opts.definition.name,
    };
  }

  /**
   * Translate delegate events into transcript events.
   *
   * Only message and tool events are forwarded. `agent_end`, `turn_end` and
   * error events stay inside: Electron main ends the durable turn on those,
   * and a delegate finishing must never end the parent's turn.
   */
  private handleEvent(event: AgentEvent): void {
    if (event.type === "message_start" && event.message.role === "user") this.conversation.consumed(event.message);
    switch (event.type) {
      case "turn_start":
        this.turns += 1;
        this.opts.onProgress?.({ turns: this.turns, toolCalls: this.toolCalls });
        break;
      case "turn_end":
        this.opts.onTurnEnd?.(event.message);
        break;
      case "message_start": {
        if (event.message.role !== "assistant") break;
        this.terminalResponse = undefined;
        const content = assistantContent((event.message as AssistantMessage).content);
        const retryingAssistant = this.providerRetryInProgress
          ? this.currentAssistant
          : undefined;
        this.currentAssistant = {
          ...(retryingAssistant ?? this.newAssistantRow()),
          content: content.text,
          ...(content.hasThinking && content.thinking
            ? { thinking: content.thinking }
            : {}),
          status: "streaming",
        };
        if (retryingAssistant) {
          this.providerRetryInProgress = false;
          this.emit({ type: "message_update", message: this.currentAssistant });
        } else {
          this.emit({ type: "message_start", message: this.currentAssistant });
        }
        break;
      }
      case "message_update": {
        if (!this.currentAssistant || event.message.role !== "assistant") break;
        const content = assistantContent((event.message as AssistantMessage).content);
        const previousText = this.currentAssistant.content;
        const previousThinking = this.currentAssistant.thinking ?? "";
        const nextText = content.hasText ? content.text : previousText;
        const nextThinking = content.hasThinking
          ? content.thinking
          : previousThinking;
        const textDelta = content.hasText
          ? cumulativeDelta(previousText, content.text)
          : { delta: "", reset: false };
        const thinkingDelta = content.hasThinking
          ? cumulativeDelta(previousThinking, content.thinking)
          : { delta: "", reset: false };
        this.currentAssistant = {
          ...this.currentAssistant,
          content: nextText,
          ...(nextThinking ? { thinking: nextThinking } : {}),
          status: "streaming",
        };
        if (
          textDelta.delta ||
          thinkingDelta.delta ||
          textDelta.reset ||
          thinkingDelta.reset
        ) {
          this.emit({
            type: "message_update",
            message: this.currentAssistant,
            ...(textDelta.delta ? { deltaText: textDelta.delta } : {}),
            ...(thinkingDelta.delta ? { deltaThinking: thinkingDelta.delta } : {}),
            ...(textDelta.reset ? { resetText: true } : {}),
            ...(thinkingDelta.reset ? { resetThinking: true } : {}),
          });
        }
        break;
      }
      case "message_end": {
        if (event.message.role !== "assistant") break;
        const message = event.message as AssistantMessage;
        this.terminalResponse = readSubagentTerminalResponse(message);
        const content = assistantContent(message.content);
        const stopReason = message.stopReason as string | undefined;
        // Read the cancel off the settled message, the same way the session
        // runtime does: pi-ai wraps an AbortError that fired before the signal
        // flipped in a local marker whose preserved cause name is the only
        // trace of the Stop. An abort is not a failure, so it neither retries
        // nor produces an error row; other local errors stay terminal below.
        const localError = readLocalRequestErrorDetails(message);
        const aborted =
          stopReason === "aborted" || localError?.causeName === "AbortError";
        if (aborted) this.turnAborted = true;
        const failed = !aborted && stopReason === "error";
        let classifiedError: ReturnType<typeof classifyAgentError> | undefined;
        let retryAttempt: number | undefined;
        if (failed) {
          const overflow = this.pendingContextOverflow;
          this.pendingContextOverflow = undefined;
          if (overflow) {
            // The boundary guard threw after degradation still did not fit.
            // The synthetic failure message carries the thrown text; keep the
            // actionable code instead of classifying it as a provider error.
            this.streamError = overflow;
          } else {
            classifiedError = withProviderFetchFailure(
              classifyProviderError(message, this.retryState.status),
              this.retryState.failure,
            );
            retryAttempt = classifiedError.details?.origin === "local"
              ? undefined : this.claimProviderRetry(classifiedError, "stream");
            if (retryAttempt !== undefined) {
              this.pendingProviderRetry = classifiedError;
            } else {
              this.streamError = classifiedError.details?.origin === "local"
                ? classifiedError
                : { code: classifiedError.code, message: classifiedError.message };
            }
          }
        }
        if (!failed && !aborted) {
          this.providerTransientRetryAttempt = 0;
          this.providerRateLimitRetryAttempt = 0;
          this.providerUnknownRetryAttempt = 0;
        }
        const messageUsage = usageFromPi(message.usage);
        this.usage = addUsage(this.usage, messageUsage);
        // Empty terminal responses must not turn retained progress into delivery.
        if (content.hasText && content.text.trim() && !failed) {
          this.lastReportText = content.text;
        }
        if (retryAttempt !== undefined) {
          this.currentAssistant = {
            ...(this.currentAssistant ?? this.newAssistantRow()),
            content: content.hasText
              ? content.text
              : (this.currentAssistant?.content ?? ""),
            ...(content.hasThinking && content.thinking
              ? { thinking: content.thinking }
              : {}),
            status: "streaming",
            ...(messageUsage ? { usage: messageUsage } : {}),
          };
          this.emit({ type: "message_update", message: this.currentAssistant });
          break;
        }
        const row: UiMessage = {
          ...(this.currentAssistant ?? this.newAssistantRow()),
          content: content.hasText
            ? content.text
            : (this.currentAssistant?.content ?? ""),
          ...(content.hasThinking && content.thinking
            ? { thinking: content.thinking }
            : {}),
          status: failed ? "error" : aborted ? "aborted" : "complete",
          ...(messageUsage ? { usage: messageUsage } : {}),
          ...(failed ? { isError: true } : {}),
          ...(classifiedError?.details?.origin === "local" ||
              isCertificateVerificationError(classifiedError?.details?.networkCode)
            ? { error: classifiedError } : {}),
        };
        this.currentAssistant = undefined;
        this.emit({ type: "message_end", message: row });
        this.saveProgress();
        break;
      }
      case "tool_execution_start":
        this.toolCalls += 1;
        this.opts.onProgress?.({ turns: this.turns, toolCalls: this.toolCalls });
        this.emit({
          type: "tool_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        this.observer.toolStarted(event.toolCallId, event.toolName, event.args);
        break;
      case "tool_execution_update":
        this.observer.activity();
        this.emit({
          type: "tool_update",
          toolCallId: event.toolCallId,
          partialResult: event.partialResult,
        });
        break;
      case "tool_execution_end":
        this.observer.toolEnded(event.toolCallId, event.result, event.isError);
        this.emit({
          type: "tool_end",
          toolCallId: event.toolCallId,
          result: event.result,
          isError: event.isError,
        });
        break;
      default:
        break;
    }
  }

  /** Close a bubble left streaming when the run died without a message_end. */
  private finalizeCurrentAssistant(): void {
    if (!this.currentAssistant) return;
    if (this.currentAssistant.content.trim()) {
      this.lastReportText = this.currentAssistant.content;
    }
    const row: UiMessage = { ...this.currentAssistant, status: "aborted" };
    this.currentAssistant = undefined;
    this.emit({ type: "message_end", message: row });
    this.saveProgress();
  }
}
