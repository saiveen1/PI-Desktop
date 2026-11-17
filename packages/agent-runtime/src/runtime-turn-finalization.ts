import type { AgentTurnContext } from "@earendil-works/pi-agent-core";
import type { UiMessage } from "@pi-desktop/shared";
import type { RunDiagnosticsTracker } from "./run-diagnostics-tracker.js";
import type { TurnCorrectionPolicy } from "./turn-correction-policy.js";

type TurnFinalization = {
  turn: AgentTurnContext;
  signal?: AbortSignal;
  corrections: TurnCorrectionPolicy;
  toolNames: ReadonlyMap<string, unknown>;
  canContinue: () => boolean;
  autonomous: boolean;
  tracker?: RunDiagnosticsTracker;
  response?: UiMessage;
  publish: (message: UiMessage) => void;
};

/** message_end settled usage already; these updates annotate only that exact response. */
export function finishRuntimeTurn({ turn, signal, corrections, toolNames, canContinue, autonomous, tracker, response, publish }: TurnFinalization) {
  return corrections.finishTurn(turn, toolNames, canContinue, (state, attempts) => {
    if (response && tracker?.annotateEarlyEnd(response.id, state, attempts)) publish(response);
  }, signal, autonomous, response && {
    messageId: response.id,
    publish: assessment => { if (tracker?.setObserver(assessment)) publish(response); },
  });
}

export function finishDiagnosticMessage(tracker: RunDiagnosticsTracker | undefined, turnId: string | undefined, now: number, message: UiMessage | undefined, publish: (message: UiMessage) => void): void {
  const current = tracker?.snapshot(now);
  if (!current || current.turnId !== turnId || current.endedAt !== undefined) return;
  const final = tracker!.finish(now);
  if (message && message.status !== "streaming") publish({ ...message, runDiagnostics: final });
}
