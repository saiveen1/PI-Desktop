import { useTranslation } from "react-i18next";
import {
  DEFAULT_DELEGATION_LIMITS,
  DELEGATION_LIMIT_RANGES,
  isDelegationLimits,
  type DelegationLimits,
} from "@pi-desktop/shared";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { Button, Input } from "../ui";

const fields = [
  { key: "maxDefinitions", label: "settings.delegationMaxDefinitions", help: "settings.delegationMaxDefinitionsHelp" },
  { key: "maxConcurrent", label: "settings.delegationMaxConcurrent", help: "settings.delegationMaxConcurrentHelp" },
] as const;

export function SubagentLimitSettings({ limits, disabled, onChange }: {
  limits?: Partial<DelegationLimits>;
  disabled: boolean;
  onChange: (limits: Partial<DelegationLimits>) => void;
}) {
  const { t } = useTranslation();
  const value = { ...DEFAULT_DELEGATION_LIMITS, ...limits };
  return (
    <SettingsCard title={t("settings.delegationLimitsTitle")}
      action={<Button disabled={disabled} onClick={() => onChange({ ...DEFAULT_DELEGATION_LIMITS })}>
        {t("settings.delegationLimitsReset")}
      </Button>}>
      {fields.map(({ key, label, help }) => {
        const range = DELEGATION_LIMIT_RANGES[key];
        return (
          <SettingsRow key={key} title={t(label)} description={t(help)}
            detail={t("settings.delegationLimitsRange", { ...range, default: DEFAULT_DELEGATION_LIMITS[key] })}>
            <Input type="number" min={range.min} max={range.max} step={1} className="w-24"
              aria-label={t(label)} aria-invalid={!isDelegationLimits({ [key]: value[key] })} disabled={disabled}
              value={Number.isNaN(value[key]) ? "" : value[key]}
              onChange={(event) => onChange({ ...value, [key]: event.target.valueAsNumber })} />
          </SettingsRow>
        );
      })}
      {!isDelegationLimits(value) ? (
        <p role="alert" className="p-4 text-sm text-text-secondary">{t("settings.delegationRunInvalid")}</p>
      ) : null}
    </SettingsCard>
  );
}
