import { useTranslation } from "react-i18next";
import type { ObserverGuardAssessment, UiMessage } from "@pi-desktop/shared";
import { useAppStore } from "../../../stores/app-store";

export function matchingObserver(message: UiMessage, live?: ObserverGuardAssessment): ObserverGuardAssessment | undefined {
  if (live?.messageId === message.id) return live;
  const persisted = message.runDiagnostics?.observer;
  return persisted?.messageId === message.id ? persisted : undefined;
}

export function ObserverGuardDisclosure({ message, sessionId }: { message: UiMessage; sessionId?: string | null }) {
  const { t } = useTranslation();
  const runtime = useAppStore(state => sessionId ? state.agentStatuses[sessionId] : undefined);
  const live = runtime?.isRunning ? runtime.runDiagnostics?.observer : undefined;
  const assessment = matchingObserver(message, live);
  if (!assessment) return null;
  const status = ["checking", "assessed", "error", "skipped"].includes(assessment.status) ? assessment.status : "error";
  const interrupted = status === "checking" && !(runtime?.isRunning &&
    (live?.messageId === message.id || (message.runDiagnostics?.turnId && runtime.currentTurnId === message.runDiagnostics.turnId)));
  const errors = ["MODEL_NOT_CONFIGURED", "MODEL_UNAVAILABLE", "EFFORT_UNAVAILABLE", "PROVIDER_UNAVAILABLE", "TIMEOUT", "INVALID_RESPONSE", "CANCELLED", "INSUFFICIENT_EVIDENCE"];
  const verdict = ["complete", "incomplete", "blocked", "needs_input", "unknown"].includes(assessment.verdict ?? "") ? assessment.verdict : "unknown";
  const blocked = ["observe_only", "budget", "unsafe", "not_actionable"].includes(assessment.continuationBlocked ?? "") ? assessment.continuationBlocked : undefined;
  return <details className="message-output-notice" data-testid="observer-guard-assessment">
    <summary>{t("observerGuard.title")} — {t(interrupted ? "observerGuard.interrupted" : `observerGuard.status.${status}`)}</summary>
    <p>{t("observerGuard.advisory")}</p>
    <dl>
      <div><dt>{t("observerGuard.mode")}</dt><dd>{t(`observerGuard.${assessment.mode}`)}</dd></div>
      {assessment.modelKey ? <div><dt>{t("observerGuard.model")}</dt><dd>{assessment.modelKey}</dd></div> : null}
      {assessment.thinkingLevel ? <div><dt>{t("observerGuard.effort")}</dt><dd>{t(`observerGuard.level.${assessment.thinkingLevel}`)}</dd></div> : null}
      <div><dt>{t("observerGuard.started")}</dt><dd>{new Date(assessment.startedAt).toLocaleString()}</dd></div>
      {assessment.endedAt !== undefined ? <div><dt>{t("observerGuard.duration")}</dt><dd>{Math.max(0, assessment.endedAt - assessment.startedAt)} ms</dd></div> : null}
      {status === "assessed" ? <div><dt>{t("observerGuard.verdict")}</dt><dd>{t(`observerGuard.verdicts.${verdict}`)}{assessment.confidence ? ` (${t(`observerGuard.confidence.${assessment.confidence}`)})` : ""}</dd></div> : null}
      {status === "assessed" && assessment.reason ? <div><dt>{t("observerGuard.reason")}</dt><dd>{assessment.reason}</dd></div> : null}
      {assessment.evidenceIds?.length ? <div><dt>{t("observerGuard.evidence")}</dt><dd>{assessment.evidenceIds.join(", ")}</dd></div> : null}
      {assessment.errorCode ? <div><dt>{t("observerGuard.error")}</dt><dd>{t(`observerGuard.errors.${errors.includes(assessment.errorCode) ? assessment.errorCode : "unknown"}`)}</dd></div> : null}
      {assessment.continued !== undefined ? <div><dt>{t("observerGuard.continuation")}</dt><dd>{t(assessment.continued ? "observerGuard.yes" : "observerGuard.no")}</dd></div> : null}
      {blocked ? <div><dt>{t("observerGuard.blocked")}</dt><dd>{t(`observerGuard.blockedReasons.${blocked}`)}</dd></div> : null}
      {assessment.inputTruncated ? <div><dt>{t("observerGuard.input")}</dt><dd>{t("observerGuard.truncated")}</dd></div> : null}
      {assessment.usage ? <div><dt>{t("observerGuard.usage")}</dt><dd>{t("observerGuard.tokens", { input: assessment.usage.inputTokens, output: assessment.usage.outputTokens })}</dd></div> : null}
    </dl>
  </details>;
}
