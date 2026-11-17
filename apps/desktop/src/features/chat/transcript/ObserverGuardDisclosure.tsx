import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import type { AssistantTurnPart } from "../../../lib/assistant-turns";
import { Button } from "../../../components/ui";
import { matchingObserver, observerDecisionKey, observerMessages, observerSummaryKey, observerVerdictKey } from "../../../lib/observer-guard-presentation";
import { observerModelLabel } from "../../../lib/observer-guard-models";
import { resolveObserverEvidenceMessageId } from "../../../lib/observer-guard-evidence-navigation";
import { useDisclosureAnchorNotifier } from "../../../lib/disclosure-anchor-context";
import { useAppStore } from "../../../stores/app-store";

export { matchingObserver } from "../../../lib/observer-guard-presentation";

/** Turn-level placement keeps an intermediate assessment outside folded execution details. */
export function ObserverGuardTurnSummary({ parts, sessionId }: { parts: readonly AssistantTurnPart[]; sessionId?: string | null }) {
  const runtime = useAppStore(state => sessionId ? state.agentStatuses[sessionId] : undefined);
  const live = runtime?.isRunning ? runtime.runDiagnostics?.observer : undefined;
  return <>{observerMessages(parts, live).map(message =>
    <ObserverGuardDisclosure key={message.id} message={message} sessionId={sessionId} />)}</>;
}

export function ObserverGuardDisclosure({ message, sessionId }: { message: UiMessage; sessionId?: string | null }) {
  const { t } = useTranslation();
  const runtime = useAppStore(state => sessionId ? state.agentStatuses[sessionId] : undefined);
  const providers = useAppStore(state => state.providers);
  const navigate = useAppStore(state => state.navigateTranscript);
  const notifyAnchor = useDisclosureAnchorNotifier();
  const navigation = useRef(0);
  useEffect(() => () => { navigation.current++; }, [sessionId]);
  const live = runtime?.isRunning ? runtime.runDiagnostics?.observer : undefined;
  const assessment = matchingObserver(message, live);
  if (!assessment) return null;
  const interrupted = assessment.status === "checking" && !(runtime?.isRunning &&
    (live?.messageId === message.id || (message.runDiagnostics?.turnId && runtime.currentTurnId === message.runDiagnostics.turnId)));
  const assessed = assessment.status === "assessed";
  const modelLabel = assessment.modelKey ? observerModelLabel(assessment.modelKey, providers) : undefined;
  const reveal = async (evidenceId: string) => {
    if (!sessionId || useAppStore.getState().activeSessionId !== sessionId) return;
    const request = ++navigation.current;
    const current = () => request === navigation.current && useAppStore.getState().activeSessionId === sessionId;
    try {
      const messageId = await resolveObserverEvidenceMessageId(sessionId, evidenceId);
      if (!current()) return;
      if (!messageId) throw new Error("Observer evidence is unavailable");
      await navigate({ sessionId, messageId, query: "" });
    } catch {
      if (current()) useAppStore.getState().showToast(t("observerGuard.evidenceUnavailable"), { variant: "error" });
    }
  };
  const evidenceButton = (id: string, label: string) => sessionId
    ? <Button variant="ghost" className="observer-evidence-link" title={id} onClick={() => reveal(id)}>{label}</Button>
    : <span title={id}>{label}</span>;
  const blocked = ["observe_only", "budget", "unsafe", "not_actionable"].includes(assessment.continuationBlocked ?? "") ? assessment.continuationBlocked : undefined;
  return <section className="observer-assessment" data-testid="observer-guard-assessment" data-state={interrupted ? "interrupted" : assessment.status}>
    <div className="observer-assessment-summary" role="status" aria-live="polite">
      <strong>{t("observerGuard.title")}</strong>
      <span>{t(observerSummaryKey(assessment, interrupted))}</span>
      {assessed ? <span>{t(observerVerdictKey(assessment))}</span> : null}
    </div>
    <p className="observer-assessment-decision">{t(observerDecisionKey(assessment, interrupted))}</p>
    {assessed && assessment.reason ? <p className="observer-assessment-reason">{assessment.reason}</p> : null}
    {assessment.blockingTool ? <p className="observer-assessment-tool">
      {t("observerGuard.relatedTool")}: {evidenceButton(assessment.blockingTool.toolCallId, assessment.blockingTool.toolName)}
    </p> : null}
    <details>
      <summary onClick={event => notifyAnchor?.(event.currentTarget)}>{t("observerGuard.details")}</summary>
      <p className="observer-assessment-advisory">{t("observerGuard.advisory")}</p>
      <dl>
        <div><dt>{t("observerGuard.mode")}</dt><dd>{t(`observerGuard.${assessment.mode}`)}</dd></div>
        {modelLabel ? <div><dt>{t("observerGuard.model")}</dt><dd>{modelLabel}</dd></div> : null}
        {assessment.thinkingLevel ? <div><dt>{t("observerGuard.effort")}</dt><dd>{t(`observerGuard.level.${assessment.thinkingLevel}`)}</dd></div> : null}
        <div><dt>{t("observerGuard.started")}</dt><dd>{new Date(assessment.startedAt).toLocaleString()}</dd></div>
        {assessment.endedAt !== undefined ? <div><dt>{t("observerGuard.duration")}</dt><dd>{Math.max(0, assessment.endedAt - assessment.startedAt)} ms</dd></div> : null}
        {assessed && assessment.confidence ? <div><dt>{t("observerGuard.verdict")}</dt><dd>{t(`observerGuard.confidence.${assessment.confidence}`)}</dd></div> : null}
        {blocked ? <div><dt>{t("observerGuard.blocked")}</dt><dd>{t(`observerGuard.blockedReasons.${blocked}`)}</dd></div> : null}
        {assessment.reviewedToolCount !== undefined ? <div><dt>{t("observerGuard.recentToolCount")}</dt><dd>{assessment.reviewedToolCount}</dd></div> : null}
        {assessment.toolOutputIncluded !== undefined ? <div><dt>{t("observerGuard.includeToolOutput")}</dt><dd>{t(assessment.toolOutputIncluded ? "observerGuard.yes" : "observerGuard.no")}</dd></div> : null}
        {assessment.inputTruncated ? <div><dt>{t("observerGuard.input")}</dt><dd>{t("observerGuard.truncated")}</dd></div> : null}
        {assessment.usage ? <div><dt>{t("observerGuard.usage")}</dt><dd>{t("observerGuard.tokens", { input: assessment.usage.inputTokens, output: assessment.usage.outputTokens })}</dd></div> : null}
        <div><dt>{t("observerGuard.reviewedResponse")}</dt><dd>{evidenceButton(message.id, t("observerGuard.openResponse"))}</dd></div>
        {assessment.evidenceIds?.length ? <div><dt>{t("observerGuard.evidence")}</dt><dd className="observer-assessment-evidence">
          {assessment.evidenceIds.map((id, index) => <span key={id}>{evidenceButton(id, t("observerGuard.openEvidence", { index: index + 1 }))}<code>{id}</code></span>)}
        </dd></div> : null}
      </dl>
    </details>
  </section>;
}
