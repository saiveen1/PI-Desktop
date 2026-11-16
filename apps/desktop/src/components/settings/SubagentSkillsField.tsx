import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { normalizeSubagentSkills, type ComposerCommand } from "@pi-desktop/shared";
import { commandsForSession, fetchComposerCommands } from "../../lib/composer-command-source";
import { useAppStore } from "../../stores/app-store";
import { CheckboxGroup, Field, SettingsToggle } from "../ui";

/** Keep unavailable saved IDs visible/removable without treating them as available skills. */
export function subagentSkillOptions(commands: ComposerCommand[], selected: readonly string[] = []) {
  const options = new Map<string, { value: string; name: string; available: boolean }>();
  for (const command of commands) {
    if (command.kind !== "skill" || !command.skillId) continue;
    try { normalizeSubagentSkills([command.skillId]); } catch { continue; }
    options.set(command.skillId, { value: command.skillId, name: command.title ?? command.skillId, available: true });
  }
  for (const id of selected) {
    if (!options.has(id)) options.set(id, { value: id, name: id, available: false });
  }
  return [...options.values()];
}

export function SubagentSkillsField({ value, onChange }: {
  value: string[] | undefined;
  onChange: (value: string[] | undefined) => void;
}) {
  const { t } = useTranslation();
  const workspaceKey = useAppStore((state) => state.workspace?.path ?? "");
  const remote = useAppStore((state) => Boolean(state.sessions.find((session) => session.id === state.activeSessionId)?.remoteWorkspace));
  const [catalog, setCatalog] = useState<{ key: string; commands: ComposerCommand[] } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const key = JSON.stringify([workspaceKey, remote]);
  useEffect(() => {
    let cancelled = false;
    void fetchComposerCommands(workspaceKey).then((commands) => {
      if (!cancelled) setCatalog({ key, commands: commandsForSession(commands, { remote }) });
    }).catch(() => {
      if (!cancelled) setFailedKey(key);
    });
    return () => { cancelled = true; };
  }, [workspaceKey, remote, key]);
  const options = subagentSkillOptions(catalog?.key === key ? catalog.commands : [], value);
  return (
    <Field label={t("extensions.subagents.skills")} hint={t("extensions.subagents.skillsHint")}>
      <SettingsToggle
        checked={value === undefined}
        label={t("extensions.subagents.skillsInherit")}
        onChange={() => onChange(value === undefined ? [] : undefined)}
      />
      {value !== undefined ? <>
        {catalog?.key !== key ? <p role="status">{t(failedKey === key ? "extensions.subagents.skillsLoadFailed" : "common.loading")}</p> : null}
        {catalog?.key === key && options.length === 0 ? <p>{t("extensions.subagents.skillsEmpty")}</p> : null}
        <CheckboxGroup
          label={t("extensions.subagents.skills")}
          values={value}
          onChange={onChange}
          options={options.map((option) => ({ value: option.value, label: option.available
            ? `${option.name} (${option.value})`
            : t("extensions.subagents.skillsUnavailable", { id: option.value }) }))}
        />
      </> : null}
    </Field>
  );
}
