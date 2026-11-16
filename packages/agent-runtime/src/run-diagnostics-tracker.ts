import type { AgentResponseTermination, AgentRunDiagnostics } from "@pi-desktop/shared";
import { normalizedStopReason } from "./run-diagnostics.js";

export type RunDiagnosticsProviderEvent = {
  kind: "thinking" | "text" | "search" | "tool" | "other";
  hasNewText?: boolean;
};

export type RunDiagnosticsRetry = {
  at: number;
  code: string;
  providerStatus?: number;
  networkCode?: string;
};

type TrackerOptions = {
  turnId: string;
  startedAt: number;
  infiniteRetry?: boolean;
};

type RequestStart = {
  at: number;
  inputTokens?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
};

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const SAFE_NETWORK_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;

function nonNegativeInt(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || value === undefined || value < 0) return undefined;
  return Math.round(value);
}

function safeStatus(value: number | undefined): number | undefined {
  return Number.isInteger(value) && value! >= 100 && value! <= 599 ? value : undefined;
}

function sanitizeCode(value: string): string {
  return SAFE_CODE.test(value) ? value : "UNKNOWN";
}

function sanitizeNetworkCode(value: string | undefined): string | undefined {
  return value && SAFE_NETWORK_CODE.test(value) ? value : undefined;
}

/**
 * Owns bounded, per-main-turn model diagnostics. It deliberately has no timers:
 * callers pass a clock at observed lifecycle transitions, while `snapshot(now)`
 * includes the elapsed part of the current retry wait.
 */
export class RunDiagnosticsTracker {
  private readonly diagnostics: AgentRunDiagnostics;
  private retryWaitStartedAt?: number;
  private settledRetryWaitMs = 0;
  private activeAttempt = 0;
  private maxOutputTokens?: number;

  constructor({ turnId, startedAt, infiniteRetry }: TrackerOptions) {
    this.diagnostics = {
      turnId,
      startedAt,
      requestCount: 0,
      attemptCount: 0,
      requestAttempt: 0,
      retryCount: 0,
      rateLimitRetries: 0,
      transientRetries: 0,
      retryWaitMs: 0,
      ...(infiniteRetry ? { infiniteRetry: true } : {}),
    };
  }

  startRequest({ at, inputTokens, contextWindow, maxOutputTokens }: RequestStart): void {
    if (this.diagnostics.endedAt !== undefined) return;
    this.maxOutputTokens = nonNegativeInt(maxOutputTokens);
    delete this.diagnostics.termination;
    this.activeAttempt += 1;
    this.settleRetryWait(at);
    this.diagnostics.requestCount += 1;
    this.diagnostics.requestAttempt = 0;
    this.diagnostics.requestStartedAt = at;
    this.diagnostics.attemptStartedAt = undefined;
    this.diagnostics.lastEventAt = undefined;
    this.diagnostics.lastEventKind = undefined;
    this.diagnostics.phase = "waiting-model";
    const estimatedInput = nonNegativeInt(inputTokens);
    if (estimatedInput === undefined) delete this.diagnostics.inputTokens;
    else this.diagnostics.inputTokens = estimatedInput;
    const window = nonNegativeInt(contextWindow);
    if (window === undefined || window === 0) delete this.diagnostics.contextWindow;
    else this.diagnostics.contextWindow = window;
  }

  /** Starts one actual provider attempt and returns its stale-event guard. */
  startAttempt(at: number): number {
    if (this.diagnostics.endedAt !== undefined) return this.activeAttempt;
    this.settleRetryWait(at);
    this.activeAttempt += 1;
    this.diagnostics.attemptCount += 1;
    this.diagnostics.requestAttempt += 1;
    this.diagnostics.attemptStartedAt = at;
    this.diagnostics.lastEventAt = undefined;
    this.diagnostics.lastEventKind = undefined;
    this.diagnostics.phase = "waiting-model";
    return this.activeAttempt;
  }

  /** Records only events from the current attempt, ignoring abandoned streams. */
  observeProviderEvent(
    attempt: number,
    event: RunDiagnosticsProviderEvent,
    at: number,
  ): boolean {
    if (this.diagnostics.endedAt !== undefined || attempt !== this.activeAttempt) return false;
    this.diagnostics.lastEventAt = at;
    switch (event.kind) {
      case "thinking":
        this.diagnostics.lastEventKind = "thinking";
        this.diagnostics.phase = "thinking";
        break;
      case "text":
        this.diagnostics.lastEventKind = "text";
        this.diagnostics.phase = "generating";
        if (event.hasNewText) this.diagnostics.lastTextAt = at;
        break;
      case "search":
        this.diagnostics.lastEventKind = "search";
        this.diagnostics.phase = "searching";
        break;
      case "tool":
        this.diagnostics.lastEventKind = "other";
        this.diagnostics.phase = "generating";
        break;
      default:
        this.diagnostics.lastEventKind = "other";
        break;
    }
    return true;
  }

  /** Claim one retry and begin measuring its actual backoff, not its planned delay. */
  recordRetry(retry: RunDiagnosticsRetry): void {
    if (this.diagnostics.endedAt !== undefined) return;
    this.activeAttempt += 1;
    this.settleRetryWait(retry.at);
    const code = sanitizeCode(retry.code);
    this.diagnostics.retryCount += 1;
    if (code === "PROVIDER_RATE_LIMITED") this.diagnostics.rateLimitRetries += 1;
    else this.diagnostics.transientRetries += 1;
    this.diagnostics.lastRetry = {
      at: retry.at,
      code,
      ...(safeStatus(retry.providerStatus) !== undefined
        ? { providerStatus: safeStatus(retry.providerStatus) }
        : {}),
      ...(sanitizeNetworkCode(retry.networkCode)
        ? { networkCode: sanitizeNetworkCode(retry.networkCode) }
        : {}),
    };
    this.retryWaitStartedAt = retry.at;
    this.diagnostics.phase = "waiting-model";
  }

  startTool(): void {
    if (this.diagnostics.endedAt === undefined) this.diagnostics.phase = "tool";
  }

  setOutputLimit(maxOutputTokens?: number): void {
    if (this.diagnostics.endedAt === undefined) this.maxOutputTokens = nonNegativeInt(maxOutputTokens);
  }
  settleResponse(messageId: string, message: { stopReason?: unknown; usage?: { output?: number } }, recoveryAttempts: number): void {
    if (this.diagnostics.endedAt !== undefined) return;
    const outputTokens = nonNegativeInt(message.usage?.output);
    this.diagnostics.termination = {
      messageId, stopReason: normalizedStopReason(message.stopReason), reasonSource: "normalized", recoveryAttempts,
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(this.maxOutputTokens !== undefined ? { maxOutputTokens: this.maxOutputTokens } : {}),
    };
  }

  annotateEarlyEnd(messageId: string, earlyEnd: NonNullable<AgentResponseTermination["earlyEnd"]>, recoveryAttempts: number): boolean {
    const termination = this.diagnostics.termination;
    if (this.diagnostics.endedAt !== undefined || termination?.messageId !== messageId || termination.stopReason !== "stop") return false;
    this.diagnostics.termination = { ...termination, earlyEnd, recoveryAttempts };
    return true;
  }

  stopRetryWait(at: number): void {
    this.settleRetryWait(at);
  }

  finish(at: number): AgentRunDiagnostics {
    if (this.diagnostics.endedAt === undefined) {
      this.settleRetryWait(at);
      this.diagnostics.endedAt = at;
    }
    return this.snapshot(at);
  }

  snapshot(now: number): AgentRunDiagnostics {
    const activeRetryWait = this.retryWaitStartedAt === undefined
      ? 0
      : Math.max(0, now - this.retryWaitStartedAt);
    return {
      ...this.diagnostics,
      retryWaitMs: this.settledRetryWaitMs + activeRetryWait,
      ...(this.diagnostics.lastRetry ? { lastRetry: { ...this.diagnostics.lastRetry } } : {}),
      ...(this.diagnostics.termination ? { termination: { ...this.diagnostics.termination } } : {}),
    };
  }

  private settleRetryWait(at: number): void {
    if (this.retryWaitStartedAt === undefined) return;
    this.settledRetryWaitMs += Math.max(0, at - this.retryWaitStartedAt);
    this.retryWaitStartedAt = undefined;
    this.diagnostics.retryWaitMs = this.settledRetryWaitMs;
  }
}
