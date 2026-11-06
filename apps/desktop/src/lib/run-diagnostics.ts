import type { AgentRunDiagnostics, AgentStatus, UiMessage } from "@pi-desktop/shared";

/** Status transitions are sparse; streamed message snapshots carry newer event times. */
export function latestRunDiagnostics(
  status: AgentStatus | undefined,
  messages: readonly UiMessage[],
): AgentRunDiagnostics | undefined {
  const turnId = status?.currentTurnId;
  if (!turnId) return undefined;
  let latest = status?.runDiagnostics?.turnId === turnId ? status.runDiagnostics : undefined;
  const rank = (value: AgentRunDiagnostics) => Math.max(
    value.startedAt,
    value.endedAt ?? 0,
    value.requestStartedAt ?? 0,
    value.attemptStartedAt ?? 0,
    value.lastEventAt ?? 0,
    value.lastRetry?.at ?? 0,
  );
  for (const message of messages) {
    const next = message.parentToolCallId ? undefined : message.runDiagnostics;
    if (!next || next.turnId !== turnId || !Number.isFinite(next.startedAt)) continue;
    if (!latest || next.attemptCount > latest.attemptCount ||
      (next.attemptCount === latest.attemptCount && rank(next) >= rank(latest))) latest = next;
  }
  return latest;
}

export function runElapsedMs(diagnostics: AgentRunDiagnostics, now: number): number {
  return Math.max(0, (diagnostics.endedAt ?? now) - diagnostics.startedAt);
}

/** Relative ages stay unknown until an actual event has been observed. */
export function runEventAgeMs(at: number | undefined, diagnostics: AgentRunDiagnostics, now: number): number | undefined {
  return at !== undefined && Number.isFinite(at)
    ? Math.max(0, (diagnostics.endedAt ?? now) - at)
    : undefined;
}
