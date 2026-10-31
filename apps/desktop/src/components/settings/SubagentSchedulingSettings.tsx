import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  delegationModelKey,
  isDelegationSettings,
  legacyDelegationSettings,
  type AppSettings,
  type DelegationModel,
  type DelegationSettings,
} from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { Button, Field, Input, SettingsToggle, Textarea } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";

const referenceId = (model: Pick<DelegationModel, "providerId" | "modelId">) =>
  JSON.stringify([model.providerId, model.modelId]);

export function SubagentSchedulingSettings({ saveSettings }: {
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const settings = useAppStore((state) => state.settings);
  const providers = useAppStore((state) => state.providers);
  const [draft, setDraft] = useState<DelegationSettings | null>(null);
  const [selected, setSelected] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const initial = useMemo(
    () => settings?.delegation ?? legacyDelegationSettings(providers),
    [settings?.delegation, providers],
  );
  const value = draft ?? initial;
  const configured = useMemo(() => providers.flatMap((provider) =>
    provider.models.map((model) => ({
      providerId: provider.id,
      modelId: model.id,
      label: `${provider.name} / ${model.id} (${provider.id})`,
      available: provider.enabled !== false,
    }))), [providers]);
  const candidates = configured.filter((model) =>
    !value.models.some((row) => referenceId(row) === referenceId(model)));
  const choice = candidates.find((model) => referenceId(model) === selected)
    ?? candidates.find((model) => model.available);
  const valid = isDelegationSettings(value);

  const change = (next: DelegationSettings) => {
    setDraft(next);
    setError(null);
    setSaved(false);
  };
  const update = (index: number, patch: Partial<DelegationModel>) => change({
    ...value,
    models: value.models.map((row, position) => position === index ? { ...row, ...patch } : row),
  });
  const save = async () => {
    if (!settings || pending.current || !valid) return;
    pending.current = true;
    setDraft(value);
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await saveSettings({ delegation: value });
      if (mounted.current) {
        setDraft(null);
        setSaved(true);
      }
    } catch (cause) {
      if (mounted.current) {
        setError(t("settings.delegationSaveFailed", {
          error: cause instanceof Error ? cause.message : String(cause),
        }));
      }
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <div className="space-y-4" aria-busy={saving}>
      <SettingsCard title={t("settings.delegationScheduling")}>
        <div className="p-4 space-y-3 text-sm text-text-secondary">
          <p>{t("settings.delegationScopeHelp")}</p>
          <p>{t(settings?.delegation ? "settings.delegationActiveHelp" : "settings.delegationLegacyHelp")}</p>
          <p>{t("settings.delegationSelectionHelp")}</p>
        </div>
        <SettingsRow title={t("settings.delegationWait")} description={t("settings.delegationWaitHelp")}>
          <Input
            type="number"
            min={0}
            max={300}
            step={1}
            className="w-24"
            aria-label={t("settings.delegationWait")}
            aria-invalid={!Number.isInteger(value.approvalTimeoutSeconds) || value.approvalTimeoutSeconds < 0 || value.approvalTimeoutSeconds > 300}
            disabled={saving || !settings}
            value={Number.isNaN(value.approvalTimeoutSeconds) ? "" : value.approvalTimeoutSeconds}
            onChange={(event) => change({ ...value, approvalTimeoutSeconds: event.target.valueAsNumber })}
          />
        </SettingsRow>
        <SettingsRow title={t("settings.delegationAddModel")}>
          <div className="flex flex-wrap items-center gap-2">
            <SettingsMenuSelect
              label={t("settings.delegationChooseModel")}
              value={choice ? referenceId(choice) : ""}
              options={candidates.map((model) => ({
                id: referenceId(model), label: model.label, disabled: !model.available,
              }))}
              onChange={setSelected}
              disabled={saving || !choice || !settings || value.models.length >= 128}
            />
            <Button
              disabled={saving || !choice?.available || !settings || value.models.length >= 128}
              onClick={() => {
                if (!choice?.available) return;
                change({ ...value, models: [...value.models, {
                  providerId: choice.providerId, modelId: choice.modelId,
                  enabled: true, priority: 1, approval: "ask", description: "",
                }] });
                setSelected("");
              }}
            >{t("settings.delegationAddModel")}</Button>
          </div>
        </SettingsRow>
      </SettingsCard>
      {value.models.length === 0 ? (
        <p className="text-sm text-text-secondary">{t("settings.delegationEmpty")}</p>
      ) : null}
      {value.models.map((model, index) => {
        const configuredModel = configured.find((row) => referenceId(row) === referenceId(model));
        const name = configuredModel?.label ?? delegationModelKey(model);
        const priorityValid = Number.isInteger(model.priority) && model.priority >= 1 && model.priority <= 100;
        return (
          <SettingsCard
            key={referenceId(model)}
            title={name}
            action={<Button disabled={saving} onClick={() => change({
              ...value, models: value.models.filter((_, position) => position !== index),
            })} aria-label={t("settings.delegationRemoveModel", { name })}>{t("extensions.subagents.remove")}</Button>}
          >
            {!configuredModel?.available ? (
              <p className="p-4 text-sm text-text-secondary">{t("settings.delegationUnavailable")}</p>
            ) : null}
            <SettingsRow title={t("settings.delegationEnabled")}>
              <SettingsToggle checked={model.enabled} disabled={saving}
                label={t("settings.delegationEnableModel", { name })}
                onChange={() => update(index, { enabled: !model.enabled })} />
            </SettingsRow>
            <SettingsRow title={t("settings.delegationPriority")} description={t("settings.delegationPriorityHelp")}>
              <Input type="number" min={1} max={100} step={1} className="w-24"
                aria-label={t("settings.delegationModelPriority", { name })}
                aria-invalid={!priorityValid} disabled={saving}
                value={Number.isNaN(model.priority) ? "" : model.priority}
                onChange={(event) => update(index, { priority: event.target.valueAsNumber })} />
            </SettingsRow>
            <SettingsRow title={t("settings.delegationApproval")} description={t("settings.delegationApprovalHelp")}>
              <SettingsMenuSelect label={t("settings.delegationModelApproval", { name })}
                value={model.approval} disabled={saving}
                options={[
                  { id: "ask", label: t("settings.delegationAsk") },
                  { id: "auto", label: t("settings.delegationAuto") },
                ]}
                onChange={(approval) => {
                  if (approval === "auto" || approval === "ask") update(index, { approval });
                }} />
            </SettingsRow>
            <div className="p-4">
              <Field label={t("settings.delegationDescription")} hint={t("settings.delegationDescriptionHelp")}>
                <Textarea rows={3} maxLength={1000} value={model.description} disabled={saving}
                  aria-label={t("settings.delegationModelDescription", { name })}
                  onChange={(event) => update(index, { description: event.target.value })} />
              </Field>
            </div>
          </SettingsCard>
        );
      })}
      {!valid ? <p role="alert" className="text-sm text-text-secondary">{t("settings.delegationInvalid")}</p> : null}
      {error ? <p role="alert" className="text-sm text-text-secondary">{error}</p> : null}
      {saved ? <p role="status" className="text-sm text-text-secondary">{t("settings.delegationSaved")}</p> : null}
      <Button variant="primary" disabled={saving || !settings || !valid} onClick={() => void save()}>
        {t(saving ? "common.saving" : "common.save")}
      </Button>
    </div>
  );
}
