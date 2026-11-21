import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_RUNTIME_SYSTEM_PROMPT, isPersonaDefinition, PERSONA_LIMITS, type PersonaDefinition } from "@pi-desktop/shared";
import { Button, Field, Input, Textarea } from "../../components/ui";
import { useAppStore } from "../../stores/app-store";
import { SettingsCard, SettingsRow } from "./primitives";
import { settingsWriter } from "./save-settings";

const EMPTY_CATALOG: readonly PersonaDefinition[] = [];

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
  const edit = (row: PersonaDefinition | null) => {
    if (writing.current || dirty) return;
    if (row && row.id === original?.id) {
      resetEditor();
      return;
    }
    setOriginal(row);
    setDraft(row ?? { id: crypto.randomUUID(), name: "", prompt: "" });
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
  const editor = draft ? (
    <div className="grid gap-3">
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
      {failed ? <p role="alert" className="text-sm text-text-secondary">{t("personas.templateSaveFailed")}</p> : null}
      <div className="flex flex-wrap gap-2">
        {original && !dirty ? <Button variant="ghost" disabled={busy} onClick={() => confirmDelete ? persist(true) : setConfirmDelete(true)}>
          {t(confirmDelete ? "personas.confirmDelete" : "personas.delete")}
        </Button> : null}
        <Button variant="secondary" disabled={busy} onClick={resetEditor}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={busy || !valid || !dirty || (!original && atLimit)} onClick={() => persist(false)}>
          {busy ? t("settings.saving") : t("common.save")}
        </Button>
      </div>
    </div>
  ) : null;

  return (
    <SettingsCard title={t("personas.title")} caption={t("personas.snapshotNote")}
      action={<Button variant="secondary" disabled={!settings || atLimit || busy || dirty} onClick={() => edit(null)}>
        {t("personas.add")}
      </Button>}>
      <div className="settings-form-grid">
        <Field label={t("personas.builtInOpening")}>
          <Textarea readOnly value={DEFAULT_RUNTIME_SYSTEM_PROMPT} rows={2} className="font-mono" />
        </Field>
        <p className="text-sm text-text-secondary">{t("personas.defaultHelp")}</p>
        <h4 className="text-sm font-medium">{t("personas.templates")}</h4>
        {atLimit ? <p className="text-sm text-text-secondary">{t("personas.limit", { count: PERSONA_LIMITS.count })}</p> : null}
        {!catalog.some(({ id }) => id === original?.id) ? editor : null}
        {catalog.length > 0 ? (
          <ul className="space-y-1 [overflow-wrap:anywhere]">
            {catalog.map((row) => {
              const expanded = original?.id === row.id;
              return (
                <li key={row.id}>
                  <SettingsRow title={row.name}>
                    <Button size="sm" disabled={busy || dirty} aria-expanded={expanded}
                      aria-label={t("personas.editTemplate", { name: row.name })} onClick={() => edit(row)}>
                      {t("menu.edit")}
                    </Button>
                  </SettingsRow>
                  {expanded ? editor : null}
                </li>
              );
            })}
          </ul>
        ) : <p className="text-sm text-text-secondary">{t("personas.empty")}</p>}
        <p className="text-sm text-text-secondary">{t("personas.inheritanceHelp")}</p>
      </div>
    </SettingsCard>
  );
}
