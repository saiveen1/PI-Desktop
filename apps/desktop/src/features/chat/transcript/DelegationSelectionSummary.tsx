import { useTranslation } from "react-i18next";
import { delegationSelectionSummary } from "../../../lib/delegation-selection-summary";
import "../../../styles/session-delegation.css";

export function DelegationSelectionSummary({ payload }: { payload: unknown }) {
  const { t } = useTranslation();
  const summary = delegationSelectionSummary(payload);
  if (!summary) return null;
  return <section className="delegation-selection-summary" aria-label={t("delegationDetails.title")}>
    <dl>
      {summary.requestedModel ? <><dt>{t("delegationDetails.requested")}</dt><dd>{summary.requestedModel}</dd></> : null}
      {summary.modelReason ? <><dt>{t("delegationDetails.reason")}</dt><dd>{summary.modelReason}</dd></> : null}
      {summary.actualModel ? <><dt>{t("delegationDetails.actual")}</dt><dd>{summary.actualModel}</dd></> : null}
      {summary.decisions.length ? <>
        <dt>{t("delegationDetails.scheduling")}</dt>
        <dd><ul>{summary.decisions.map((decision, index) => <li key={`${decision.model}-${index}`}>
          {t(`delegationDetails.${decision.decision}`)}: {decision.model}. {decision.reason}
        </li>)}</ul></dd>
      </> : null}
    </dl>
  </section>;
}
