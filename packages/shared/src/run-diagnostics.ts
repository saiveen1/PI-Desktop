/**
 * Bounded, prompt-free evidence for one main assistant turn. Values are absent
 * from historical rows created before runtime diagnostics existed.
 */
export type AgentRunDiagnostics = {
  turnId: string;
  startedAt: number;
  endedAt?: number;
  /** Logical model requests, not individual transport attempts. */
  requestCount: number;
  /** Actual provider attempts across every logical request in the turn. */
  attemptCount: number;
  /** Attempts for the current logical request, including its first attempt. */
  requestAttempt: number;
  /** Whole-turn retry count; this does not reset after a successful response. */
  retryCount: number;
  rateLimitRetries: number;
  transientRetries: number;
  /** Elapsed backoff, including the portion of an active retry wait. */
  retryWaitMs: number;
  requestStartedAt?: number;
  attemptStartedAt?: number;
  lastEventAt?: number;
  lastTextAt?: number;
  lastEventKind?: "thinking" | "text" | "search" | "other";
  phase?: "waiting-model" | "thinking" | "generating" | "searching" | "tool";
  /** Estimated input tokens in the currently projected provider request. */
  inputTokens?: number;
  contextWindow?: number;
  infiniteRetry?: boolean;
  /** Sanitized retry identity only; never provider prose, prompt text, or headers. */
  lastRetry?: {
    at: number;
    code: string;
    providerStatus?: number;
    networkCode?: string;
  };
};
