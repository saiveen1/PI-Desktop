import { useTranslation } from "react-i18next";
import {
  DEFAULT_DELEGATION_RUN_POLICY,
  DELEGATION_RUN_POLICY_LIMITS,
  isDelegationRunPolicy,
  type DelegationRunPolicy,
} from "@pi-desktop/shared";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { delegationRunPolicyFields } from "../../lib/subagent-run-policy";
import { Button, Input, SettingsToggle } from "../ui";

export function SubagentRunPolicySettings({ policy, disabled, onChange }: {
  policy?: Partial<DelegationRunPolicy>;
  disabled: boolean;
  onChange: (policy: Partial<DelegationRunPolicy>) => void;
}) {
  const { t } = useTranslation();
  const value = { ...DEFAULT_DELEGATION_RUN_POLICY, ...policy };
  return (
    <SettingsCard title={t("settings.delegationRunTitle")}
      action={<Button disabled={disabled} onClick={() => onChange({ ...DEFAULT_DELEGATION_RUN_POLICY })}>
        {t("settings.delegationRunReset")}
      </Button>}>
      <div className="p-4 space-y-3 text-sm text-text-secondary">
        <p>{t("settings.delegationRunScopeHelp")}</p>
        <p>{t("settings.delegationRunTimingHelp")}</p>
        <p>{t("settings.delegationRunRecoveryHelp")}</p>
      </div>
      {delegationRunPolicyFields.map(({ key, label, unit }) => {
        const limits = DELEGATION_RUN_POLICY_LIMITS[key];
        const valid = isDelegationRunPolicy({ [key]: value[key] });
        return (
          <SettingsRow key={key} title={t(label)} detail={
            <span>{t("settings.delegationRunRange", { ...limits, unit: t(unit) })}
              {limits.min === 0 ? "; " + t("settings.delegationRunZeroUnlimited") : ""}</span>
          }>
            <Input type="number" min={limits.min} max={limits.max} step={1} className="w-24"
              aria-label={t(label)} aria-invalid={!valid} disabled={disabled}
              value={Number.isNaN(value[key]) ? "" : value[key]}
              onChange={(event) => onChange({ ...value, [key]: event.target.valueAsNumber })} />
          </SettingsRow>
        );
      })}
      <SettingsRow title={t("settings.delegationRunReportRecovery")}
        description={t("settings.delegationRunReportRecoveryDesc")}>
        <SettingsToggle disabled={disabled} checked={value.reportRecoveryAttempts === 1}
          label={t("settings.delegationRunReportRecovery")}
          onChange={() => onChange({ ...value, reportRecoveryAttempts: value.reportRecoveryAttempts === 1 ? 0 : 1 })} />
      </SettingsRow>
      {!isDelegationRunPolicy(value) ? (
        <p role="alert" className="p-4 text-sm text-text-secondary">{t("settings.delegationRunInvalid")}</p>
      ) : null}
    </SettingsCard>
  );
}
