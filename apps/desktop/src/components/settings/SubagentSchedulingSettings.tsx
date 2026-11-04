import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  delegationModelKey,
  isDelegationSettings,
  resolveDelegationRunPolicy,
  legacyDelegationSettings,
  type AppSettings,
  type DelegationModel,
  type DelegationSettings,
} from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { Button, Field, Input, SettingsToggle, Textarea } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { SubagentRunPolicySettings } from "./SubagentRunPolicySettings";
import "../../styles/subagent-scheduling.css";

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
  const [activeId, setActiveId] = useState("");
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
      providerName: provider.name,
      available: provider.enabled !== false,
    }))), [providers]);
  const candidates = configured.filter((model) =>
    !value.models.some((row) => referenceId(row) === referenceId(model)));
  const choice = candidates.find((model) => referenceId(model) === selected)
    ?? candidates.find((model) => model.available);
  const valid = isDelegationSettings(value);
  const modelPolicyValid = isDelegationSettings({ ...value, runPolicy: undefined });
  const orderedModels = [...value.models].sort((a, b) =>
    (Number.isFinite(a.priority) ? a.priority : Infinity)
    - (Number.isFinite(b.priority) ? b.priority : Infinity));
  const activeModel = orderedModels.find((model) => referenceId(model) === activeId) ?? orderedModels[0];
  const configuredModel = activeModel && configured.find((row) => referenceId(row) === referenceId(activeModel));
  const name = configuredModel?.label ?? (activeModel ? delegationModelKey(activeModel) : "");
  const priorityValid = activeModel && Number.isInteger(activeModel.priority)
    && activeModel.priority >= 1 && activeModel.priority <= 100;

  const change = (next: DelegationSettings) => {
    setDraft(next);
    setError(null);
    setSaved(false);
  };
  const update = (model: DelegationModel, patch: Partial<DelegationModel>) => {
    const id = referenceId(model);
    setActiveId(id);
    change({ ...value, models: value.models.map((row) => referenceId(row) === id ? { ...row, ...patch } : row) });
  };
  const save = async () => {
    if (!settings || pending.current || !valid) return;
    pending.current = true;
    setDraft(value);
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await saveSettings({ delegation: value.runPolicy
        ? { ...value, runPolicy: resolveDelegationRunPolicy(value.runPolicy) } : value });
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
    <div className="delegation-settings space-y-4" aria-busy={saving}>
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
                setActiveId(referenceId(choice));
              }}
            >{t("settings.delegationAddModel")}</Button>
          </div>
        </SettingsRow>
      </SettingsCard>
      <SubagentRunPolicySettings policy={value.runPolicy} disabled={saving || !settings}
        onChange={(runPolicy) => change({ ...value, runPolicy })} />
      {value.models.length === 0 ? (
        <p className="text-sm text-text-secondary">{t("settings.delegationEmpty")}</p>
      ) : null}
      {activeModel ? (
        <div className="delegation-workbench">
          <aside className="delegation-model-sidebar">
            <SettingsCard title={t("settings.models")} description={t("settings.delegationPriorityHelp")}>
              <div className="delegation-model-list" role="group" aria-label={t("settings.models")}>
                {orderedModels.map((model) => {
                  const configuredRow = configured.find((row) => referenceId(row) === referenceId(model));
                  const modelName = configuredRow?.label ?? delegationModelKey(model);
                  return (
                    <Button key={referenceId(model)} variant="ghost"
                      className="delegation-model-item"
                      aria-label={modelName} title={modelName}
                      aria-pressed={referenceId(model) === referenceId(activeModel)}
                      onClick={() => setActiveId(referenceId(model))}>
                      <span className="delegation-model-priority" title={t("settings.delegationPriority")}>
                        {Number.isFinite(model.priority) ? model.priority : "—"}
                      </span>
                      <span className="delegation-model-summary">
                        <span className="delegation-model-name">{model.modelId}</span>
                        <span className="delegation-model-provider">{configuredRow?.providerName ?? model.providerId}</span>
                        <span className="delegation-model-status">
                          {t(!model.enabled || !configuredRow?.available ? "settings.providerDisabledBadge"
                            : model.approval === "ask" ? "settings.delegationAsk" : "settings.delegationAuto")}
                        </span>
                      </span>
                    </Button>
                  );
                })}
              </div>
            </SettingsCard>
          </aside>
          <div className="delegation-model-editor" role="region" aria-label={name}>
            <SettingsCard title={activeModel.modelId}
              action={<Button disabled={saving} onClick={() => change({
                ...value, models: value.models.filter((row) => referenceId(row) !== referenceId(activeModel)),
              })} aria-label={t("settings.delegationRemoveModel", { name })}>{t("extensions.subagents.remove")}</Button>}>
              <p className="delegation-model-reference">{configuredModel
                ? `${configuredModel.providerName} (${activeModel.providerId})` : activeModel.providerId}</p>
              {!configuredModel?.available ? (
                <p className="p-4 text-sm text-text-secondary">{t("settings.delegationUnavailable")}</p>
              ) : null}
              <SettingsRow title={t("settings.delegationEnabled")}>
                <SettingsToggle checked={activeModel.enabled} disabled={saving}
                  label={t("settings.delegationEnableModel", { name })}
                  onChange={() => update(activeModel, { enabled: !activeModel.enabled })} />
              </SettingsRow>
              <SettingsRow title={t("settings.delegationPriority")} description={t("settings.delegationPriorityHelp")}>
                <Input type="number" min={1} max={100} step={1} className="w-24"
                  aria-label={t("settings.delegationModelPriority", { name })}
                  aria-invalid={!priorityValid} disabled={saving}
                  value={Number.isNaN(activeModel.priority) ? "" : activeModel.priority}
                  onChange={(event) => update(activeModel, { priority: event.target.valueAsNumber })} />
              </SettingsRow>
              <SettingsRow title={t("settings.delegationApproval")} description={t("settings.delegationApprovalHelp")}>
                <SettingsMenuSelect label={t("settings.delegationModelApproval", { name })}
                  value={activeModel.approval} disabled={saving}
                  options={[
                    { id: "ask", label: t("settings.delegationAsk") },
                    { id: "auto", label: t("settings.delegationAuto") },
                  ]}
                  onChange={(approval) => {
                    if (approval === "auto" || approval === "ask") update(activeModel, { approval });
                  }} />
              </SettingsRow>
              <div className="p-4">
                <Field label={t("settings.delegationDescription")} hint={t("settings.delegationDescriptionHelp")}>
                  <Textarea rows={3} maxLength={1000} value={activeModel.description} disabled={saving}
                    aria-label={t("settings.delegationModelDescription", { name })}
                    onChange={(event) => update(activeModel, { description: event.target.value })} />
                </Field>
              </div>
            </SettingsCard>
          </div>
        </div>
      ) : null}
      {!modelPolicyValid ? <p role="alert" className="text-sm text-text-secondary">{t("settings.delegationInvalid")}</p> : null}
      {error ? <p role="alert" className="text-sm text-text-secondary">{error}</p> : null}
      {saved ? <p role="status" className="text-sm text-text-secondary">{t("settings.delegationSaved")}</p> : null}
      <Button variant="primary" disabled={saving || !settings || !valid} onClick={() => void save()}>
        {t(saving ? "common.saving" : "common.save")}
      </Button>
    </div>
  );
}
