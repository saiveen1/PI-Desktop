import type { NotificationChannel, NotificationPolicy } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { SettingsRow } from "../../features/settings/primitives";
import { Input, SettingsToggle } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";

const channels: NotificationChannel[] = ["auto", "in-app", "system"];
export function NotificationPolicyEditor({ value, onChange, disabled, repeat = false }: {
  value: NotificationPolicy;
  onChange: (patch: Partial<NotificationPolicy>) => void;
  disabled?: boolean;
  repeat?: boolean;
}) {
  const { t } = useTranslation();
  return <>
    <SettingsRow title={t("notificationSettings.enabled")}>
      <SettingsToggle label={t("notificationSettings.enabled")} disabled={disabled}
        checked={value.enabled} onChange={() => onChange({ enabled: !value.enabled })} />
    </SettingsRow>
    <SettingsRow title={t("notificationSettings.channel")} description={t("notificationSettings.channelHelp")}>
      <SettingsMenuSelect label={t("notificationSettings.channel")} disabled={disabled} value={value.channel}
        options={channels.map(id => ({ id, label: t(`notificationSettings.${id}`) }))}
        onChange={channel => { if (channels.includes(channel as NotificationChannel)) onChange({ channel: channel as NotificationChannel }); }} />
    </SettingsRow>
    <SettingsRow title={t("notificationSettings.sound")}>
      <SettingsToggle label={t("notificationSettings.sound")} disabled={disabled}
        checked={value.sound} onChange={() => onChange({ sound: !value.sound })} />
    </SettingsRow>
    <SettingsRow title={t("notificationSettings.volume", { volume: value.volume })}>
      <Input type="range" min={0} max={100} step={1} value={value.volume} disabled={disabled}
        aria-label={t("notificationSettings.volumeLabel")}
        onChange={event => onChange({ volume: event.target.valueAsNumber })} />
    </SettingsRow>
    {repeat ? <SettingsRow title={t("notificationSettings.repeat")} description={t("notificationSettings.repeatHelp")}>
      <Input type="number" min={0} max={300} step={1} className="w-24" disabled={disabled}
        value={Number.isNaN(value.repeatIntervalSeconds) ? "" : value.repeatIntervalSeconds}
        aria-label={t("notificationSettings.repeat")}
        aria-invalid={value.repeatIntervalSeconds !== 0 && (!Number.isInteger(value.repeatIntervalSeconds) || value.repeatIntervalSeconds < 10 || value.repeatIntervalSeconds > 300)}
        onChange={event => onChange({ repeatIntervalSeconds: event.target.valueAsNumber })} />
    </SettingsRow> : null}
  </>;
}
