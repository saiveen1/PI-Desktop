import { useTranslation } from "react-i18next";
import { isDelegationFailurePolicy } from "@pi-desktop/shared";
import { failurePolicyFields } from "../settings/subagent-failure-policy";

/** Only recorded task metadata, never mutable global settings. */
export function SubagentFailurePolicySummary({ payload }: { payload: unknown }) {
  const { t } = useTranslation();
  const policy = payload && typeof payload === "object" && "failurePolicy" in payload ? payload.failurePolicy : undefined;
  if (!isDelegationFailurePolicy(policy)) return null;
  return (
    <section className="p-4 text-xs text-text-secondary" aria-label={t("subagentControls.snapshot")}>
      <p className="mb-2">{t("subagentControls.snapshot")}</p>
      <dl className="space-y-1">
        <div className="flex flex-wrap justify-between gap-x-4">
          <dt>{t("subagentControls.mode")}</dt><dd>{t(`subagentControls.${policy.mode}`)}</dd>
        </div>
        {failurePolicyFields(policy.mode).map(key => <div key={key} className="flex flex-wrap justify-between gap-x-4">
          <dt>{t(`subagentControls.${key}`)}</dt><dd>{policy[key]}</dd>
        </div>)}
      </dl>
    </section>
  );
}
