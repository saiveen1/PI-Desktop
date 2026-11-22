import {
  OBSERVER_GUARD_CONTINUATION_REASONS, OBSERVER_GUARD_SKIP_REASONS,
  type ObserverGuardAssessment, type UiMessage,
} from "@pi-desktop/shared";
import type { AssistantTurnPart } from "./assistant-turns";

const errors = ["MODEL_NOT_CONFIGURED", "MODEL_UNAVAILABLE", "EFFORT_UNAVAILABLE", "PROVIDER_UNAVAILABLE", "TIMEOUT", "INVALID_RESPONSE", "CANCELLED", "INSUFFICIENT_EVIDENCE"];
const verdicts = ["complete", "incomplete", "blocked", "needs_input", "unknown"];

function isContinuationCandidate(assessment: ObserverGuardAssessment): boolean {
  return assessment.status === "assessed" && assessment.decision === "continue" &&
    assessment.continued === false && assessment.continuationCount === 0 &&
    !assessment.continuationReason && !assessment.continuationBlocked;
}

function hasGuardRecommendation(assessment: ObserverGuardAssessment): boolean {
  return assessment.mode === "guard" && Boolean(assessment.modelKey) && isContinuationCandidate(assessment);
}

export function visibleObserverAssessment(assessment?: ObserverGuardAssessment): ObserverGuardAssessment | undefined {
  // An eligible Endless reply is not a result; the automatic user turn shows the follow-up.
  return assessment?.mode === "endless" && isContinuationCandidate(assessment) ? undefined : assessment;
}

export function observerContinuationProgress(assessment?: ObserverGuardAssessment) {
  if (!assessment) return;
  const { continuationCount: current, maxContinuations: max, continuationReason } = assessment;
  if (current === undefined || max === undefined) return;
  // A zero on a candidate or shared-cap exhaustion is not cross-turn progress.
  if (current === 0 && (continuationReason === "continuation_limit" || hasGuardRecommendation(assessment))) return;
  return { current, max };
}

export function matchingObserver(message: UiMessage, live?: ObserverGuardAssessment): ObserverGuardAssessment | undefined {
  const saved = message.runDiagnostics?.observer;
  const persisted = saved?.messageId === message.id ? saved : undefined;
  if (live?.messageId !== message.id) return visibleObserverAssessment(persisted);
  // A delayed live snapshot cannot roll a durable terminal assessment back to checking.
  if (persisted && (persisted.startedAt > live.startedAt ||
    (persisted.startedAt === live.startedAt && persisted.status !== "checking" && live.status === "checking"))) return visibleObserverAssessment(persisted);
  return visibleObserverAssessment(live);
}

function isAutoContinuationAssessment(assessment: ObserverGuardAssessment): boolean {
  return assessment.mode === "endless" || assessment.decision !== undefined || assessment.continuationCount !== undefined || assessment.maxContinuations !== undefined;
}

export function observerMessages(parts: readonly AssistantTurnPart[], live?: ObserverGuardAssessment): UiMessage[] {
  const seen = new Set<string>();
  const messages: UiMessage[] = [];
  let latest: UiMessage | undefined;
  for (const part of parts) {
    for (const message of part.kind === "message" ? [part.message] : part.items.map(item => item.message)) {
      if (message.role !== "assistant" || message.parentToolCallId || seen.has(message.id)) continue;
      seen.add(message.id);
      const assessment = matchingObserver(message, live);
      if (!assessment) continue;
      if (isAutoContinuationAssessment(assessment)) latest = message;
      else messages.push(message);
    }
  }
  if (latest) messages.push(latest);
  return messages;
}

export function observerSummaryKey(assessment: ObserverGuardAssessment, interrupted = false): string {
  if (interrupted) return "observerGuard.interrupted";
  if (assessment.status === "assessed") {
    if (assessment.continued) return "observerGuard.summary.continued";
    if (hasGuardRecommendation(assessment)) return "observerGuard.status.assessed";
    if (assessment.continued === false || assessment.continuationBlocked || assessment.continuationReason || assessment.decision === "stop") return "observerGuard.summary.notContinued";
    if (assessment.mode === "endless") return "observerGuard.noReviewer";
    return "observerGuard.status.assessed";
  }
  return `observerGuard.status.${["checking", "error", "skipped"].includes(assessment.status) ? assessment.status : "error"}`;
}

export function observerVerdictKey(assessment: ObserverGuardAssessment): string {
  return `observerGuard.verdicts.${verdicts.includes(assessment.verdict ?? "") ? assessment.verdict : "unknown"}`;
}

export function observerDecisionKey(assessment: ObserverGuardAssessment, interrupted = false): string {
  if (interrupted) return "observerGuard.interruptedHint";
  if (assessment.status === "checking") return "observerGuard.checkingHint";
  if (assessment.status === "error") return `observerGuard.errors.${errors.includes(assessment.errorCode ?? "") ? assessment.errorCode : "unknown"}`;
  if (assessment.status === "skipped") {
    return assessment.skipReason && OBSERVER_GUARD_SKIP_REASONS.includes(assessment.skipReason)
      ? `observerGuard.skipReasons.${assessment.skipReason}` : "observerGuard.legacyReason";
  }
  if (assessment.continued) {
    if (!isAutoContinuationAssessment(assessment)) return "observerGuard.notReassessed";
    return assessment.mode === "endless" ? "observerGuard.noReviewer" : "observerGuard.decisions.continue";
  }
  if (assessment.continuationReason && OBSERVER_GUARD_CONTINUATION_REASONS.includes(assessment.continuationReason)) {
    return `observerGuard.continuationReasons.${assessment.continuationReason}`;
  }
  if (assessment.mode === "endless") return "observerGuard.noReviewer";
  if (assessment.decision === "continue" || assessment.decision === "stop") return `observerGuard.decisions.${assessment.decision}`;
  return "observerGuard.legacyReason";
}
