import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { OBSERVER_GUARD_LIMITS, THINKING_LEVELS, isObserverGuardSettings, type AppSettings, type ObserverGuardSettings as GuardSettings, type ThinkingLevel } from "@pi-desktop/shared";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { observerSelection } from "../../lib/observer-guard-models";
import { useAppStore } from "../../stores/app-store";
import { Input, SettingsToggle } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { SettingsDisclosure } from "./SettingsDisclosure";

type NumericKey = keyof typeof OBSERVER_GUARD_LIMITS;
const numericKeys: NumericKey[] = ["timeoutSeconds", "maxInputChars", "recentToolCount"];
function NumberSetting({ name, value, save }: { name: NumericKey; value: number; save: (patch: GuardSettings) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(String(value)); setInvalid(false); }, [value]);
  const range = OBSERVER_GUARD_LIMITS[name];
  const label = t(`observerGuard.${name}`);
  return <SettingsRow title={label} description={t("observerGuard.range", range)}>
    <Input type="number" min={range.min} max={range.max} step={1} aria-label={label} aria-invalid={invalid || undefined}
      value={draft} onChange={event => { setDraft(event.target.value); setInvalid(false); }}
      onBlur={() => { const number = Number(draft); if (!draft.trim() || !isObserverGuardSettings({ [name]: number })) { setInvalid(true); return; } if (number !== value) save({ [name]: number }); }}
      onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
  </SettingsRow>;
}

const modelKey = (provider: string, model: string) => JSON.stringify([provider, model]);
export function ObserverGuardSettings({ settings, saveSettings }: { settings: AppSettings; saveSettings: (patch: Partial<AppSettings>) => Promise<void> }) {
  const { t } = useTranslation();
  const providers = useAppStore(state => state.providers);
  const catalog = useAppStore(state => state.providerModels);
  const { value, models, selected } = observerSelection(settings, providers, catalog);
  const save = (patch: GuardSettings) => { void saveSettings({ observerGuard: patch }); };
  const current = value.providerId || value.modelId ? modelKey(value.providerId, value.modelId) : "";
  const options = [{ id: "", label: t("observerGuard.noModel") }, ...models.map(model => ({ id: modelKey(model.providerId, model.modelId), label: model.label }))];
  if (current && !selected) options.push({ id: current, label: `${value.providerId} / ${value.modelId} — ${t("observerGuard.unavailable")}` });
  const levels = THINKING_LEVELS.filter(level => selected?.levels.includes(level));
  const effortOptions = levels.map(level => ({ id: level, label: t(`observerGuard.level.${level}`) }));
  if (!levels.includes(value.thinkingLevel)) effortOptions.push({ id: value.thinkingLevel, label: `${t(`observerGuard.level.${value.thinkingLevel}`)} — ${t("observerGuard.unavailable")}` });
  return <SettingsCard title={t("observerGuard.title")} caption={`${t("observerGuard.description")} ${t("observerGuard.privacy")}`}>
    <SettingsRow title={t("observerGuard.model")} description={t("observerGuard.modelHint")}>
      <SettingsMenuSelect label={t("observerGuard.model")} value={current} options={options} onChange={id => {
        if (!id) { save({ providerId: "", modelId: "" }); return; }
        const model = models.find(row => modelKey(row.providerId, row.modelId) === id);
        if (model) save({ providerId: model.providerId, modelId: model.modelId });
      }} />
    </SettingsRow>
    <SettingsRow title={t("observerGuard.effort")} detail={selected && !levels.includes(value.thinkingLevel) ? t("observerGuard.unavailable") : undefined}>
      <SettingsMenuSelect label={t("observerGuard.effort")} value={value.thinkingLevel} options={effortOptions}
        onChange={level => { if (levels.includes(level as ThinkingLevel)) save({ thinkingLevel: level as ThinkingLevel }); }} />
    </SettingsRow>
    <SettingsDisclosure title={t("observerGuard.advanced")}>
      {numericKeys.map(name => <NumberSetting key={name} name={name} value={value[name]} save={save} />)}
      <SettingsRow title={t("observerGuard.includeToolOutput")} description={t("observerGuard.privacy")}>
        <SettingsToggle label={t("observerGuard.includeToolOutput")} checked={value.includeToolOutput} onChange={() => save({ includeToolOutput: !value.includeToolOutput })} />
      </SettingsRow>
    </SettingsDisclosure>
  </SettingsCard>;
}
