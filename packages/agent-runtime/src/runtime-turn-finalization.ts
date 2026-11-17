import type { AgentTurnContext } from "@earendil-works/pi-agent-core";
import type { ObserverGuardAssessment, ObserverGuardSkipReason, UiMessage } from "@pi-desktop/shared";
import type { ObserverRuntimeBlock } from "./observer-guard.js";
import type { RunDiagnosticsTracker } from "./run-diagnostics-tracker.js";
import type { TurnCorrectionPolicy } from "./turn-correction-policy.js";

type TurnFinalization = {
  turn: AgentTurnContext;
  signal?: AbortSignal;
  corrections: TurnCorrectionPolicy;
  toolNames: ReadonlyMap<string, unknown>;
  runtimeBlock: () => ObserverRuntimeBlock | undefined;
  stopReason?: Extract<ObserverGuardSkipReason, "stop_requested" | "mode_closeout">;
  autonomous: boolean;
  turnId?: string;
  tracker?: RunDiagnosticsTracker;
  response?: UiMessage;
  publish: (message: UiMessage) => void;
};

function observerSink(tracker: RunDiagnosticsTracker | undefined, turnId: string | undefined, messageId: string, publish?: () => void) {
  const current = tracker?.snapshot(Date.now());
  if (!tracker || !current || current.turnId !== turnId || current.endedAt !== undefined || current.termination?.messageId !== messageId) return;
  return { messageId, publish: (assessment: ObserverGuardAssessment) => { if (tracker.setObserver(assessment)) publish?.(); } };
}

export function recordRuntimeObserverSkip(corrections: TurnCorrectionPolicy, tracker: RunDiagnosticsTracker | undefined, turnId: string | undefined, messageId: string, skipReason: ObserverGuardSkipReason) {
  corrections.observer.skip(observerSink(tracker, turnId, messageId), skipReason);
}

/** message_end settled usage already; these updates annotate only that exact response. */
export function finishRuntimeTurn({ turn, signal, corrections, toolNames, runtimeBlock, stopReason, autonomous, turnId, tracker, response, publish }: TurnFinalization) {
  const sink = response && response.status !== "streaming" ? observerSink(tracker, turnId, response.id, () => publish(response)) : undefined;
  if (stopReason) {
    corrections.observer.skip(sink, stopReason);
    return { action: "end" } as const;
  }
  return corrections.finishTurn(turn, toolNames, runtimeBlock, (state, attempts) => {
    if (response && tracker?.annotateEarlyEnd(response.id, state, attempts)) publish(response);
  }, signal, autonomous, sink);
}

export function finishDiagnosticMessage(corrections: TurnCorrectionPolicy, tracker: RunDiagnosticsTracker | undefined, turnId: string | undefined, now: number, message: UiMessage | undefined, publish: (message: UiMessage) => void, stopped: boolean): void {
  const current = tracker?.snapshot(now);
  if (!tracker || !current || current.turnId !== turnId || current.endedAt !== undefined) return;
  const settled = message && message.status !== "streaming" ? message : undefined;
  if (settled && corrections.observer.canRecord) {
    const sink = observerSink(tracker, turnId, settled.id);
    if (stopped) corrections.observer.skip(sink, "stop_requested");
    else corrections.observer.finish(sink);
  }
  const final = tracker.finish(now);
  if (settled) publish({ ...settled, runDiagnostics: final });
}
