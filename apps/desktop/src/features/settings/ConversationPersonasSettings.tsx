import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isPersonaDefinition, PERSONA_LIMITS, type PersonaDefinition } from "@pi-desktop/shared";
import { Button, Field, Input, Textarea } from "../../components/ui";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { useAppStore } from "../../stores/app-store";
import { SettingsCard } from "./primitives";
import { settingsWriter } from "./save-settings";

const EMPTY_CATALOG: readonly PersonaDefinition[] = [];
const NEW = "@new";

export function ConversationPersonasSettings() {
  const { t } = useTranslation();
  const settings = useAppStore((state) => state.settings);
  const catalog = settings?.personas ?? EMPTY_CATALOG;
  const [draft, setDraft] = useState<PersonaDefinition | null>(null);
  const [original, setOriginal] = useState<PersonaDefinition | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const [failed, setFailed] = useState(false);
  const validDraft = draft && { ...draft, name: draft.name.trim() };
  const valid = isPersonaDefinition(validDraft);
  const atLimit = catalog.length >= PERSONA_LIMITS.count;
  const dirty = Boolean(draft && (draft.name !== (original?.name ?? "") || draft.prompt !== (original?.prompt ?? "")));
  const resetEditor = () => { setDraft(null); setOriginal(null); setConfirmDelete(false); setFailed(false); };
  const edit = (id: string) => {
    if (writing.current || dirty) return;
    const row = catalog.find((item) => item.id === id);
    setOriginal(row ?? null);
    setDraft(row ?? (id === NEW ? { id: crypto.randomUUID(), name: "", prompt: "" } : null));
    setConfirmDelete(false);
    setFailed(false);
  };
  const persist = async (deleting: boolean) => {
    if (writing.current || (deleting ? !original || !confirmDelete : !valid)) return;
    writing.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await settingsWriter.personas((latest) => {
        if (original && !latest.some((item) => item.id === original.id && item.name === original.name && item.prompt === original.prompt)) {
          throw new Error("Persona template changed while it was being edited");
        }
        if (deleting) return latest.filter((item) => item.id !== original?.id);
        if (!valid) return [...latest];
        return original ? latest.map((item) => item.id === original.id ? validDraft : item) : [...latest, validDraft];
      });
      resetEditor();
    } catch {
      setFailed(true);
    } finally {
      writing.current = false;
      setBusy(false);
    }
  };
  const invalidLength = Boolean(draft && (Array.from(draft.name.trim()).length > PERSONA_LIMITS.name ||
    new TextEncoder().encode(draft.prompt).byteLength > PERSONA_LIMITS.promptBytes));
  return (
    <SettingsCard title={t("personas.title")} caption={t("personas.snapshotNote")}
      action={<Button variant="secondary" disabled={!settings || atLimit || busy || dirty} onClick={() => edit(NEW)}>
        {t("personas.add")}
      </Button>}>
      <div className="settings-form-grid">
        {catalog.length > 0 ? <SettingsMenuSelect fullWidth label={t("personas.templates")}
          value={original?.id ?? ""} disabled={busy || dirty}
          options={[{ id: "", label: t("personas.selectTemplate"), disabled: true }, ...catalog.map(({ id, name }) => ({ id, label: name }))]}
          onChange={edit} /> : <p className="text-sm text-text-secondary">{t("personas.empty")}</p>}
        {atLimit ? <p className="text-sm text-text-secondary">{t("personas.limit", { count: PERSONA_LIMITS.count })}</p> : null}
        {draft ? <>
          <Field label={t("personas.name")}>
            <Input value={draft.name} disabled={busy} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </Field>
          <Field label={t("personas.prompt")} hint={t("personas.promptHelp")}>
            <Textarea value={draft.prompt} rows={6} disabled={busy}
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} />
          </Field>
          {invalidLength ? <p role="status" className="text-sm text-text-secondary">
            {t("personas.fieldLimits", { name: PERSONA_LIMITS.name, bytes: PERSONA_LIMITS.promptBytes })}
          </p> : null}
        </> : <p className="text-sm text-text-secondary">{t("personas.promptHelp")}</p>}
        <p className="text-sm text-text-secondary">{t("personas.inheritanceHelp")}</p>
        {failed ? <p role="alert" className="text-sm text-text-secondary">{t("personas.templateSaveFailed")}</p> : null}
      </div>
      {draft ? <div className="settings-panel-actions flex-wrap">
        {original && !dirty ? <Button variant="ghost" disabled={busy} onClick={() => confirmDelete ? persist(true) : setConfirmDelete(true)}>
          {t(confirmDelete ? "personas.confirmDelete" : "personas.delete")}
        </Button> : null}
        <Button variant="secondary" disabled={busy} onClick={resetEditor}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={busy || !valid || !dirty || (!original && atLimit)} onClick={() => persist(false)}>
          {busy ? t("settings.saving") : t("common.save")}
        </Button>
      </div> : null}
    </SettingsCard>
  );
}
