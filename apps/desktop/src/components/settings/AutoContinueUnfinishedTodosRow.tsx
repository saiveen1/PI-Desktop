import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import { SettingsRow } from "../../features/settings/primitives";
import { SettingsToggle } from "../ui";

export function AutoContinueUnfinishedTodosRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const enabled = settings.autoContinueUnfinishedTodos !== false;
  return (
    <SettingsRow
      title={t("settings.autoContinueUnfinishedTodos")}
      description={t("settings.autoContinueUnfinishedTodosDesc")}
    >
      <SettingsToggle
        checked={enabled}
        label={t("settings.autoContinueUnfinishedTodos")}
        onChange={() => void saveSettings({ autoContinueUnfinishedTodos: !enabled })}
      />
    </SettingsRow>
  );
}
