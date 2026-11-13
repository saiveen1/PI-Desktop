import type { SubagentObservation } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";

/** These are observed events, not a judgment that a task has failed or succeeded. */
export function SubagentObservationSummary({ observation }: { observation: SubagentObservation }) {
  const { t, i18n } = useTranslation();
  const n = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 });
  const time = (value: number | undefined) => {
    if (value === undefined || !Number.isFinite(new Date(value).getTime())) return t("chat.delegationDiagnostics.unavailable");
    return <time dateTime={new Date(value).toISOString()}>{new Date(value).toLocaleString(i18n.language)}</time>;
  };
  const o = observation;
  return <section className="mt-3 space-y-2" aria-label={t("chat.delegationDiagnostics.observation.title")}>
    <h4>{t("chat.delegationDiagnostics.observation.title")}</h4>
    <dl className="space-y-1">
      <div><dt>{t("chat.delegationDiagnostics.observation.selectedModel")}</dt><dd className="break-all">{o.selectedModel}</dd></div>
      <div><dt>{t("chat.delegationDiagnostics.observation.observedAt")}</dt><dd>{time(o.diagnostic.observedAt)}</dd></div>
      <div><dt>{t("chat.delegationDiagnostics.observation.state")}</dt><dd>{t(`chat.delegationDiagnostics.observation.states.${o.diagnostic.state}`)}</dd></div>
      <div><dt>{t("chat.delegationDiagnostics.observation.executionStart")}</dt><dd>{time(o.executionStartedAt)}</dd></div>
      <div><dt>{t("chat.delegationDiagnostics.observation.executionEnd")}</dt><dd>{time(o.executionEndedAt)}</dd></div>
      <div><dt>{t("chat.delegationDiagnostics.observation.reportProduced")}</dt><dd>{time(o.reportProducedAt)}</dd></div>
      <div><dt>{t("chat.delegationDiagnostics.observation.reportDelivered")}</dt><dd>{time(o.reportDeliveredAt)}</dd></div>
      <div><dt>{t("chat.delegationDiagnostics.observation.toolCounts")}</dt><dd>{t("chat.delegationDiagnostics.observation.toolCountValues", { completed: n.format(o.completedToolCalls), failed: n.format(o.failedToolCalls) })}</dd></div>
    </dl>
    {o.approvals.length || o.approvalsOmitted ? <details open><summary>{t("chat.delegationDiagnostics.observation.approvals")}</summary>
      <ul>{o.approvals.map((a, index) => <li key={index}><span className="break-all">{a.model}</span> · {t(`chat.delegationDiagnostics.observation.approvalStates.${a.status}`)} · {time(a.at)}</li>)}</ul>
      {o.approvalsOmitted ? <p>{t("chat.delegationDiagnostics.observation.omitted", { value: n.format(o.approvalsOmitted) })}</p> : null}
    </details> : null}
    {o.attempts.length || o.attemptsOmitted ? <details open><summary>{t("chat.delegationDiagnostics.observation.attempts", { value: n.format(o.attemptCount) })}</summary>
      <ol>{o.attempts.map(a => {
        const measured = a.usage && a.usage.outputTokens > 0 && a.providerDurationMs !== undefined && a.providerDurationMs > 0
          ? a.usage.outputTokens / (a.providerDurationMs / 1000) : undefined;
        const rate = measured !== undefined && Number.isFinite(measured) ? measured : undefined;
        return <li key={a.sequence} className="mt-2 break-words"><span className="break-all">{a.model}</span> · {t(`chat.delegationDiagnostics.observation.attemptStates.${a.outcome}`)} · {time(a.startedAt)}
          {a.error ? <p><code>{a.error.code}</code></p> : null}
          <p>{t("chat.delegationDiagnostics.observation.requestThroughput")}: {rate !== undefined ? t("chat.delegationDiagnostics.tokensPerSecond", { value: n.format(rate) }) : t("chat.delegationDiagnostics.unavailable")}</p>
          {a.usage ? <p>{t("chat.delegationDiagnostics.outputTokens")}: {n.format(a.usage.outputTokens)}</p> : null}
        </li>;
      })}</ol>
      {o.attemptsOmitted ? <p>{t("chat.delegationDiagnostics.observation.omitted", { value: n.format(o.attemptsOmitted) })}</p> : null}
    </details> : null}
    {o.pendingTools.length || o.pendingToolsOmitted || o.recentTools.length ? <details open><summary>{t("chat.delegationDiagnostics.observation.tools")}</summary>
      <ul>{[...o.pendingTools, ...o.recentTools].map((tool, index) => <li key={`${tool.toolCallId}-${index}`} className="break-words">
        {tool.toolName} · {t(`chat.delegationDiagnostics.observation.toolStates.${tool.outcome}`)} · {t(`chat.delegationDiagnostics.observation.effects.${tool.effects}`)}
        {tool.path ? <span className="break-all"> · {tool.path}</span> : null}
      </li>)}</ul>
      {o.pendingToolsOmitted ? <p>{t("chat.delegationDiagnostics.observation.omitted", { value: n.format(o.pendingToolsOmitted) })}</p> : null}
    </details> : null}
    {o.confirmedWritePaths.length || o.confirmedWritePathsOmitted ? <details><summary>{t("chat.delegationDiagnostics.observation.writes")}</summary>
      <ul>{o.confirmedWritePaths.map((path, index) => <li key={index} className="break-all">{path}</li>)}</ul>
      {o.confirmedWritePathsOmitted ? <p>{t("chat.delegationDiagnostics.observation.omitted", { value: n.format(o.confirmedWritePathsOmitted) })}</p> : null}
    </details> : null}
  </section>;
}
