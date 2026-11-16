import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AGENT_OUTPUT_GUARD_LIMITS, isAgentOutputGuardSettings, resolveAgentOutputGuardSettings,
  type AgentOutputGuardSettings as GuardSettings, type AppSettings } from "@pi-desktop/shared";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { Input, SegmentedControl, SettingsToggle } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";

type NumericKey = Exclude<keyof typeof AGENT_OUTPUT_GUARD_LIMITS, "recoveryLimit">;
const thresholds: NumericKey[] = ["symbolMinChars", "symbolMinLines", "symbolSingleLineChars", "repeatedParagraphMinChars", "repeatedParagraphMinRepeats"];

function Threshold({ name, value, save, disabled }: { name: NumericKey; value: number; save: (patch: GuardSettings) => void; disabled: boolean }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(String(value)); setInvalid(false); }, [value]);
  const range = AGENT_OUTPUT_GUARD_LIMITS[name];
  const label = t(`outputGuard.${name}`);
  return <SettingsRow title={label} description={t("outputGuard.range", range)}>
    <Input aria-label={label} aria-invalid={invalid || undefined} disabled={disabled} type="number" min={range.min} max={range.max} step={1}
      value={draft} onChange={event => { setDraft(event.target.value); setInvalid(false); }}
      onBlur={() => {
        const number = Number(draft);
        if (!draft.trim() || !isAgentOutputGuardSettings({ [name]: number })) { setInvalid(true); return; }
        if (number !== value) save({ [name]: number });
      }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
  </SettingsRow>;
}

export function AgentOutputGuardSettings({ settings, saveSettings }: {
  settings: AppSettings; saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const value = resolveAgentOutputGuardSettings(settings.agentOutputGuard);
  const save = (patch: GuardSettings) => { void saveSettings({ agentOutputGuard: patch }); };
  const range = AGENT_OUTPUT_GUARD_LIMITS.recoveryLimit;
  return <SettingsCard title={t("outputGuard.title")} description={t("outputGuard.description")}>
    <SettingsRow title={t("outputGuard.mode")} description={t("outputGuard.modeDesc")}>
      <SegmentedControl label={t("outputGuard.mode")} value={value.earlyEndMode} onChange={earlyEndMode => save({ earlyEndMode })}
        options={(["off", "warn", "continue"] as const).map(mode => ({ value: mode, label: t(`outputGuard.${mode}`) }))} />
    </SettingsRow>
    <SettingsRow title={t("outputGuard.recoveryLimit")} description={t("outputGuard.recoveryDesc")}>
      <SettingsMenuSelect label={t("outputGuard.recoveryLimit")} value={String(value.recoveryLimit)}
        onChange={next => save({ recoveryLimit: Number(next) })}
        options={Array.from({ length: range.max - range.min + 1 }, (_, index) => ({ id: String(index + range.min), label: String(index + range.min) }))} />
    </SettingsRow>
    <SettingsRow title={t("outputGuard.symbolGuard")}>
      <SettingsToggle label={t("outputGuard.symbolGuard")} checked={value.repetitiveOutputEnabled}
        onChange={() => save({ repetitiveOutputEnabled: !value.repetitiveOutputEnabled })} />
    </SettingsRow>
    <SettingsRow title={t("outputGuard.paragraphGuard")}>
      <SettingsToggle label={t("outputGuard.paragraphGuard")} checked={value.repeatedParagraphsEnabled} disabled={!value.repetitiveOutputEnabled}
        onChange={() => save({ repeatedParagraphsEnabled: !value.repeatedParagraphsEnabled })} />
    </SettingsRow>
    {thresholds.map(name => <Threshold key={name} name={name} value={value[name]} save={save}
      disabled={!value.repetitiveOutputEnabled || (name.startsWith("repeatedParagraph") && !value.repeatedParagraphsEnabled)} />)}
  </SettingsCard>;
}
