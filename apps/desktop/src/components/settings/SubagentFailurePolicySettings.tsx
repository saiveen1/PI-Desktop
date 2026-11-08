import { useTranslation } from "react-i18next";
import {
  DEFAULT_DELEGATION_FAILURE_POLICY, DELEGATION_FAILURE_POLICY_LIMITS, isDelegationFailurePolicy,
  type DelegationFailurePolicy,
} from "@pi-desktop/shared";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { Input } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";

import { failurePolicyFields, failurePolicyModes } from "./subagent-failure-policy";

export function SubagentFailurePolicySettings({ policy, disabled, onChange }: {
  policy?: DelegationFailurePolicy;
  disabled: boolean;
  onChange: (policy: DelegationFailurePolicy | undefined) => void;
}) {
  const { t } = useTranslation();
  const value = policy ?? DEFAULT_DELEGATION_FAILURE_POLICY;
  return (
    <SettingsCard title={t("subagentControls.failureTitle")}>
      <div className="p-4 space-y-3 text-sm text-text-secondary">
        <p>{t("subagentControls.help")}</p>
        <p>{t("subagentControls.timing")}</p>
      </div>
      <SettingsRow title={t("subagentControls.mode")}>
        <SettingsMenuSelect label={t("subagentControls.mode")} value={value.mode} disabled={disabled}
          options={failurePolicyModes.map(id => ({ id, label: t(`subagentControls.${id}`) }))}
          onChange={mode => {
            if (!failurePolicyModes.some(item => item === mode)) return;
            const next = { ...value, mode };
            // Hidden invalid counters must not trap the Stop/Follow modes.
            for (const key of ["maxRetries", "maxFallbacks"] as const) {
              const { min, max } = DELEGATION_FAILURE_POLICY_LIMITS[key];
              if (!Number.isInteger(next[key]) || next[key] < min || next[key] > max) next[key] = DEFAULT_DELEGATION_FAILURE_POLICY[key];
            }
            if (isDelegationFailurePolicy(next)) onChange(mode === "inherit" ? undefined : next);
          }} />
      </SettingsRow>
      {failurePolicyFields(value.mode).map(key => {
        const { min, max } = DELEGATION_FAILURE_POLICY_LIMITS[key];
        const valid = Number.isInteger(value[key]) && value[key] >= min && value[key] <= max;
        return <SettingsRow key={key} title={t(`subagentControls.${key}`)} detail={`${min}–${max}`}>
          <Input type="number" min={min} max={max} step={1} className="w-24" disabled={disabled}
            aria-label={t(`subagentControls.${key}`)} aria-invalid={!valid}
            value={Number.isNaN(value[key]) ? "" : value[key]}
            onChange={event => onChange({ ...value, [key]: event.target.valueAsNumber })} />
        </SettingsRow>;
      })}
      {!isDelegationFailurePolicy(value) ? <p role="alert" className="p-4 text-sm text-text-secondary">
        {t("subagentControls.invalid")}
      </p> : null}
    </SettingsCard>
  );
}
