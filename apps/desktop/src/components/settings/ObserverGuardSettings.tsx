import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_OBSERVER_GUARD_PROMPT, OBSERVER_GUARD_LIMITS, OBSERVER_GUARD_PROMPT_MAX_CHARS, THINKING_LEVELS, isObserverGuardSettings, type AppSettings, type ObserverGuardSettings as GuardSettings, type ThinkingLevel } from "@pi-desktop/shared";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { observerSelection } from "../../lib/observer-guard-models";
import { useAppStore } from "../../stores/app-store";
import { Button, Field, Input, SettingsToggle, Textarea } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { SettingsDisclosure } from "./SettingsDisclosure";

const advancedNumbers = ["timeoutSeconds", "maxInputChars"] as const;
type NumericKey = "maxContinuations" | typeof advancedNumbers[number];
function NumberSetting({ name, value, save }: { name: NumericKey; value: number; save: (patch: GuardSettings) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(String(value)); setInvalid(false); }, [value]);
  const range = OBSERVER_GUARD_LIMITS[name];
  const label = t(`observerGuard.${name}`);
  const rangeHint = t("observerGuard.range", range);
  return <SettingsRow title={label} description={name === "maxContinuations" ? `${t("observerGuard.limitHint")} ${rangeHint}` : rangeHint}>
    <Input type="number" min={range.min} max={range.max} step={1} aria-label={label} aria-invalid={invalid || undefined}
      value={draft} onChange={event => { setDraft(event.target.value); setInvalid(false); }}
      onBlur={() => { const number = Number(draft); if (!draft.trim() || !isObserverGuardSettings({ [name]: number })) { setInvalid(true); return; } if (number !== value) save({ [name]: number }); }}
      onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
  </SettingsRow>;
}

function PromptSetting({ value, save }: { value: string; save: (patch: GuardSettings) => Promise<void> }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const writing = useRef(false);
  const valid = isObserverGuardSettings({ prompt: draft });
  const persist = async (prompt: string) => {
    if (writing.current || !isObserverGuardSettings({ prompt })) return;
    const effective = prompt.trim() ? prompt : DEFAULT_OBSERVER_GUARD_PROMPT;
    setFailed(false);
    if (effective === value) { setDraft(value); return; }
    writing.current = true;
    setSaving(true);
    try {
      await save({ prompt: prompt.trim() ? prompt : "" });
    } catch {
      setFailed(true);
    } finally {
      writing.current = false;
      setSaving(false);
    }
  };
  return <>
    <Field label={t("observerGuard.prompt")} hint={t("observerGuard.promptHint", { max: OBSERVER_GUARD_PROMPT_MAX_CHARS })}>
      <Textarea rows={6} value={draft} disabled={saving} aria-invalid={!valid || undefined}
        onChange={event => { setDraft(event.target.value); setFailed(false); }} />
    </Field>
    {!valid ? <p role="status" className="text-sm text-text-secondary">{t("observerGuard.promptInvalid", { max: OBSERVER_GUARD_PROMPT_MAX_CHARS })}</p> : null}
    {failed ? <p role="alert" className="text-sm text-text-secondary">{t("observerGuard.saveFailed")}</p> : null}
    <div className="settings-panel-actions flex-wrap">
      <Button variant="secondary" disabled={saving || (value === DEFAULT_OBSERVER_GUARD_PROMPT && draft === value)} onClick={() => void persist("")}>{t("observerGuard.resetPrompt")}</Button>
      <Button variant="primary" disabled={saving || !valid || draft === value} onClick={() => void persist(draft)}>{saving ? t("settings.saving") : t("common.save")}</Button>
    </div>
  </>;
}

const modelKey = (provider: string, model: string) => JSON.stringify([provider, model]);
export function ObserverGuardSettings({ settings, saveSettings }: { settings: AppSettings; saveSettings: (patch: Partial<AppSettings>) => Promise<void> }) {
  const { t } = useTranslation();
  const providers = useAppStore(state => state.providers);
  const catalog = useAppStore(state => state.providerModels);
  const { value, models, selected } = observerSelection(settings, providers, catalog);
  const save = (patch: GuardSettings) => saveSettings({ observerGuard: patch });
  const current = value.providerId || value.modelId ? modelKey(value.providerId, value.modelId) : "";
  const options = [{ id: "", label: t("observerGuard.noModel") }, ...models.map(model => ({ id: modelKey(model.providerId, model.modelId), label: model.label }))];
  if (current && !selected) options.push({ id: current, label: `${value.providerId} / ${value.modelId} — ${t("observerGuard.unavailable")}` });
  const levels = THINKING_LEVELS.filter(level => selected?.levels.includes(level));
  const effortOptions = levels.map(level => ({ id: level, label: t(`observerGuard.level.${level}`) }));
  if (!levels.includes(value.thinkingLevel)) effortOptions.push({ id: value.thinkingLevel, label: `${t(`observerGuard.level.${value.thinkingLevel}`)} — ${t("observerGuard.unavailable")}` });
  return <SettingsCard title={t("observerGuard.title")} caption={`${t("observerGuard.description")} ${t("observerGuard.endlessHint")} ${t("observerGuard.guardHint")} ${t("observerGuard.privacy")}`}>
    <NumberSetting name="maxContinuations" value={value.maxContinuations} save={save} />
    <SettingsRow title={t("observerGuard.model")} description={t("observerGuard.modelHint")}>
      <SettingsMenuSelect label={t("observerGuard.model")} value={current} options={options} onChange={id => {
        if (!id) { save({ providerId: "", modelId: "" }); return; }
        const model = models.find(row => modelKey(row.providerId, row.modelId) === id);
        if (model) save({ providerId: model.providerId, modelId: model.modelId });
      }} />
    </SettingsRow>
    <SettingsRow title={t("observerGuard.effort")} description={t("observerGuard.guardOnly")} detail={selected && !levels.includes(value.thinkingLevel) ? t("observerGuard.unavailable") : undefined}>
      <SettingsMenuSelect label={t("observerGuard.effort")} value={value.thinkingLevel} options={effortOptions}
        onChange={level => { if (levels.includes(level as ThinkingLevel)) save({ thinkingLevel: level as ThinkingLevel }); }} />
    </SettingsRow>
    <PromptSetting key={value.prompt} value={value.prompt} save={save} />
    <SettingsRow title={t("observerGuard.continueOnTransientError")} description={t("observerGuard.continueOnTransientErrorHint")}>
      <SettingsToggle label={t("observerGuard.continueOnTransientError")} checked={value.continueOnTransientError} onChange={() => void save({ continueOnTransientError: !value.continueOnTransientError })} />
    </SettingsRow>
    <SettingsDisclosure title={t("observerGuard.advanced")}>
      {advancedNumbers.map(name => <NumberSetting key={name} name={name} value={value[name]} save={save} />)}
    </SettingsDisclosure>
  </SettingsCard>;
}
