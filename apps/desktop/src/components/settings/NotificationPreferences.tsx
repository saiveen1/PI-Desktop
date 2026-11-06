import { useEffect, useRef, useState } from "react";
import { isNotificationSettings, resolveNotificationPolicy, type NotificationCategory,
  type NotificationPolicy, type NotificationSettings } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import { testNotificationDelivery } from "../../stores/runtime/notification-runtime";
import { playNotificationChime } from "../../lib/notification-sound";
import { settingsWriter } from "../../features/settings/save-settings";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { Button, SettingsToggle } from "../ui";
import { NotificationPolicyEditor } from "./NotificationPolicyEditor";
import { SettingsMenuSelect } from "./SettingsMenuSelect";

const defaults: NotificationSettings = { version: 1 };
const categories: NotificationCategory[] = ["needsAction", "failures", "completions"];
export function NotificationPreferences({ scope }: { scope: "global" | "delegation" }) {
  const { t } = useTranslation();
  const settings = useAppStore(state => state.settings);
  const [draft, setDraft] = useState<NotificationSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const value = draft ?? settings?.notifications ?? defaults;
  const delegation = scope === "delegation";
  const effective = resolveNotificationPolicy(value, delegation ? "delegation-approval" : "test");
  const editable: NotificationPolicy = delegation
    ? { ...effective, enabled: value.delegation?.enabled ?? value.categories?.needsAction ?? true }
    : { ...effective, enabled: value.enabled !== false };
  const title = t(delegation ? "notificationSettings.delegation" : "notificationSettings.title");
  const change = (next: NotificationSettings) => { setDraft(next); setFeedback(""); setError(false); };
  const changePolicy = (patch: Partial<NotificationPolicy>) => change(delegation
    ? { ...value, delegation: { ...value.delegation, ...patch } }
    : { ...value, ...patch });
  const save = async () => {
    if (!settings || pending.current || !isNotificationSettings(value)) return;
    pending.current = true; setSaving(true); setDraft(value); setFeedback(""); setError(false);
    try {
      await settingsWriter.notifications(value, scope);
      if (mounted.current) { setDraft(null); setFeedback(t("notificationSettings.saved")); }
    } catch {
      if (mounted.current) { setError(true); setFeedback(t("notificationSettings.saveFailed")); }
    } finally { pending.current = false; if (mounted.current) setSaving(false); }
  };
  const test = async () => {
    if (pending.current) return;
    pending.current = true; setSaving(true); setFeedback(""); setError(false);
    try {
      const result = await testNotificationDelivery();
      if (!mounted.current) return;
      const key = result.reason === "requested" ? "requested" : result.reason === "in-app" ? "inAppResult"
        : result.reason === "disabled" ? "disabledResult" : "failedResult";
      setFeedback(t(`notificationSettings.${key}`)); setError(key === "failedResult");
    } catch { if (mounted.current) { setError(true); setFeedback(t("notificationSettings.failedResult")); } }
    finally { pending.current = false; if (mounted.current) setSaving(false); }
  };
  return <section className="settings-stack" aria-label={title} aria-busy={saving}>
    <SettingsCard title={title} description={t(delegation ? "notificationSettings.delegationHelp" : "notificationSettings.help")}>
      {delegation ? <>
        <SettingsRow title={t("notificationSettings.mode")}>
          <SettingsMenuSelect label={t("notificationSettings.mode")} disabled={saving || !settings}
            value={value.delegation ? "custom" : "inherit"}
            options={[{ id: "inherit", label: t("notificationSettings.inherit") }, { id: "custom", label: t("notificationSettings.custom") }]}
            onChange={mode => {
              const next = { ...value };
              if (mode === "custom") next.delegation = {}; else delete next.delegation;
              change(next);
            }} />
        </SettingsRow>
        <p className="p-4 text-sm text-text-secondary">{t("notificationSettings.effective", {
          channel: t(`notificationSettings.${effective.channel}`), sound: t(effective.sound ? "notificationSettings.soundOn" : "notificationSettings.soundOff"), volume: effective.volume,
        })}</p>
      </> : null}
      {!delegation || value.delegation ? <NotificationPolicyEditor value={editable} onChange={changePolicy}
        repeat={delegation} disabled={saving || !settings} /> : null}
      {!delegation ? categories.map(category => <SettingsRow key={category} title={t(`notificationSettings.${category}`)}>
        <SettingsToggle label={t(`notificationSettings.${category}`)} checked={value.categories?.[category] !== false}
          disabled={saving || !settings} onChange={() => change({ ...value, categories: { ...value.categories, [category]: value.categories?.[category] === false } })} />
      </SettingsRow>) : null}
    </SettingsCard>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" aria-label={`${t("common.save")} ${title}`}
        disabled={saving || !settings || !draft || !isNotificationSettings(value)} onClick={() => void save()}>{t(saving ? "common.saving" : "common.save")}</Button>
      {delegation ? <Button onClick={() => {
        useAppStore.getState().setSettingsTab("notifications"); useAppStore.getState().setPage("settings");
      }}>{t("notificationSettings.openGlobal")}</Button> : <>
        <Button disabled={saving || !effective.sound || effective.volume <= 0} onClick={() => playNotificationChime(effective.volume)}>{t("notificationSettings.preview")}</Button>
        <Button disabled={saving || Boolean(draft)} onClick={() => void test()}>{t("notificationSettings.test")}</Button>
      </>}
    </div>
    {feedback ? <p role={error ? "alert" : "status"} className="text-sm text-text-secondary">{feedback}</p> : null}
  </section>;
}
