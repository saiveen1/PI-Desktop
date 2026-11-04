import { useTranslation } from "react-i18next";
import { delegationRunPolicyFields, delegationRunPolicySnapshot } from "../../lib/subagent-run-policy";

export function SubagentRunPolicySummary({ payload }: { payload: unknown }) {
  const { t } = useTranslation();
  const policy = delegationRunPolicySnapshot(payload);
  if (!policy) return null;
  return (
    <section className="p-4 text-xs text-text-secondary" aria-label={t("settings.delegationRunSnapshot")}>
      <p className="mb-2">{t("settings.delegationRunSnapshot")}</p>
      <dl className="space-y-1">
        {delegationRunPolicyFields.map(({ key, label, unit }) => (
          <div key={key} className="flex flex-wrap justify-between gap-x-4">
            <dt>{t(label)}</dt>
            <dd>{policy[key] === 0 ? t("settings.delegationRunUnlimited") : policy[key] + " " + t(unit)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
