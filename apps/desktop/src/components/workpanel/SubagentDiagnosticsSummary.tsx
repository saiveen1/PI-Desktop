import { useTranslation } from "react-i18next";
import { subagentDiagnostics } from "../../lib/subagent-diagnostics";

export function SubagentDiagnosticsSummary({ payload }: { payload: unknown }) {
  const { t, i18n } = useTranslation();
  const facts = subagentDiagnostics(payload);
  if (!facts) return null;
  const number = new Intl.NumberFormat(i18n.language);
  const terminal = facts.terminal;
  return <section className="px-4 pb-4 text-xs text-text-secondary" aria-label={t("chat.delegationDiagnostics.title")}>
    <p className="mb-2">{t("chat.delegationDiagnostics.title")}</p>
    <dl className="space-y-1">
      {facts.requestedModel ? <div className="flex flex-wrap justify-between gap-x-4">
        <dt>{t("chat.delegationDiagnostics.requestedModel")}</dt>
        <dd className="min-w-0 break-all">{facts.requestedModel}</dd>
      </div> : null}
      {facts.actualModel ? <div className="flex flex-wrap justify-between gap-x-4">
        <dt>{t("chat.delegationDiagnostics.actualModel")}</dt>
        <dd className="min-w-0 break-all">{facts.actualModel}</dd>
      </div> : null}
      {facts.turns !== undefined && facts.toolCalls !== undefined ? <div className="flex flex-wrap justify-between gap-x-4">
        <dt>{t("chat.delegationDiagnostics.activity")}</dt>
        <dd>{t("chat.delegationDiagnostics.activityCounts", { turns: number.format(facts.turns), tools: number.format(facts.toolCalls) })}</dd>
      </div> : null}
      {facts.retry ? <div className="space-y-1">
        <dt>{t("chat.delegationDiagnostics.retry")}</dt>
        <dd>{t("chat.delegationDiagnostics.retryAttempt", { attempt: number.format(facts.retry.attempt),
          limit: facts.retry.limit === "unlimited" ? t("settings.delegationRunUnlimited") : number.format(facts.retry.limit) })}</dd>
        {facts.retry.message ? <dd className="break-words">{facts.retry.message}</dd> : null}
      </div> : null}
      {terminal ? <>
        <div className="flex flex-wrap justify-between gap-x-4">
          <dt>{t("chat.delegationDiagnostics.stopReason")}</dt>
          <dd>{t(`chat.delegationDiagnostics.stopReasons.${terminal.stopReason}`)}{terminal.rawStopReason && terminal.rawStopReason !== terminal.stopReason ? ` (${terminal.rawStopReason})` : ""}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-x-4">
          <dt>{t("chat.delegationDiagnostics.reportOutcome")}</dt>
          <dd>{t(`chat.delegationDiagnostics.reportOutcomes.${terminal.reportOutcome}`)}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-x-4">
          <dt>{t("chat.delegationDiagnostics.responseStructure")}</dt>
          <dd>{t("chat.delegationDiagnostics.responseCounts", { text: number.format(terminal.textBlocks), thinking: number.format(terminal.thinkingBlocks), tools: number.format(terminal.toolCalls) })}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-x-4">
          <dt>{t("chat.delegationDiagnostics.recoveryAttempts")}</dt>
          <dd>{number.format(terminal.reportRecoveryAttempt)}</dd>
        </div>
        {terminal.providerRetries !== undefined ? <div className="flex flex-wrap justify-between gap-x-4">
          <dt>{t("chat.runDetails.retries")}</dt>
          <dd>{number.format(terminal.providerRetries)}</dd>
        </div> : null}
      </> : null}
      {facts.error ? <div className="space-y-1">
        <dt>{t("chat.delegationDiagnostics.failure")}</dt>
        <dd className="break-words"><code>{facts.error.code}</code>{" "}{facts.error.message}</dd>
      </div> : null}
    </dl>
    {facts.decisions.length ? <details className="mt-2">
      <summary>{t("chat.delegationDiagnostics.selection")}</summary>
      <ol className="mt-2 space-y-2">
        {facts.decisions.map((row, index) => <li key={`${index}-${row.model}`} className="break-words">
          <span className="break-all">{row.model}</span>{" · "}{t(`chat.delegationDiagnostics.${row.decision}`)}
          <p>{row.reason}</p>
        </li>)}
      </ol>
    </details> : null}
    {facts.modelFailures.length ? <details className="mt-2" open>
      <summary>{t("chat.delegationDiagnostics.modelFailures")}</summary>
      <ol className="mt-2 space-y-2">
        {facts.modelFailures.map((row, index) => <li key={`${index}-${row.model}`} className="break-words">
          <span className="break-all">{row.model}</span>{" · "}<code>{row.code}</code>
          <p>{row.message}</p>
        </li>)}
      </ol>
    </details> : null}
  </section>;
}
