import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { OBSERVER_GUARD_MODES, resolveObserverGuardMode, type ObserverGuardMode } from "@pi-desktop/shared";
import { IconCheck, IconEye } from "../../components/icons";
import { AnchoredMenu } from "../../components/settings/AnchoredMenu";
import { TooltipButton } from "../../components/ui";
import { isRemoteSession } from "../../lib/remote-session-safety";
import { observerSelection } from "../../lib/observer-guard-models";
import { useAppStore } from "../../stores/app-store";

export function ObserverGuardPicker({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation();
  const session = useAppStore(state => state.sessions.find(row => row.id === sessionId));
  const running = useAppStore(state => sessionId ? Boolean(state.runningSessions[sessionId]) : false);
  const pending = useAppStore(state => sessionId ? state.pendingPlans[sessionId]?.status === "pending" : false);
  const settings = useAppStore(state => state.settings);
  const providers = useAppStore(state => state.providers);
  const catalog = useAppStore(state => state.providerModels);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => setOpen(false), [sessionId]);
  if (session && (session.scheduledRun || session.id.startsWith("native-pi:") || isRemoteSession(session) || (session.source && session.source !== "desktop"))) return null;
  const mode = resolveObserverGuardMode(session?.observerMode);
  const ready = observerSelection(settings, providers, catalog).available;
  const blocked = !session || running || pending || saving;
  const label = `${t("observerGuard.title")}: ${t(`observerGuard.${mode}`)}`;
  const hint = !session ? t("observerGuard.draft") : running || pending ? t("observerGuard.busy") : label;
  const choose = async (next: ObserverGuardMode) => {
    const state = useAppStore.getState();
    const target = state.sessions.find(row => row.id === sessionId);
    if (!target || target.scheduledRun || target.id.startsWith("native-pi:") || isRemoteSession(target) || (target.source && target.source !== "desktop") || state.runningSessions[target.id] || state.pendingPlans[target.id]?.status === "pending") return;
    if (next !== "off" && !observerSelection(state.settings, state.providers, state.providerModels).available) return;
    setOpen(false); setSaving(true);
    try {
      await state.configureActiveSession({ mode: target.mode, observerMode: next }, target.id);
    } catch {
      state.showToast(t("observerGuard.saveFailed"), { variant: "error" });
    } finally { setSaving(false); }
  };
  return <AnchoredMenu className="composer-mode" open={open && !blocked} onClose={() => setOpen(false)}
    menuClassName="composer-mode-menu" label={t("observerGuard.title")} role="menu" align="start" side="top"
    trigger={ref => <TooltipButton ref={ref} type="button" className={`icon-btn mode-chip composer-mode-chip ${mode !== "off" ? "active" : ""}`}
      tooltip={hint} ariaLabel={blocked ? `${label}. ${hint}` : label} aria-haspopup="menu" aria-expanded={open && !blocked} disabled={blocked}
      onClick={() => setOpen(current => !current)}><IconEye size={15} aria-hidden /><span className="composer-mode-chip-label text-sm">{t(`observerGuard.${mode}`)}</span></TooltipButton>}>
    {OBSERVER_GUARD_MODES.map(candidate => <button key={candidate} type="button" role="menuitemradio"
      aria-checked={mode === candidate} disabled={candidate !== "off" && !ready}
      className={`composer-plus-item ${mode === candidate ? "active" : ""}`} onClick={() => void choose(candidate)}>
      <span className="flex-1 text-left">{t(`observerGuard.${candidate}`)}</span>{mode === candidate ? <IconCheck size={13} /> : null}
    </button>)}
    <p className="session-delegation-hint">{t("observerGuard.modeHint")}</p>
    {!ready ? <button type="button" role="menuitem" className="composer-plus-item" onClick={() => { setOpen(false); useAppStore.getState().setSettingsTab("behavior"); }}>{t("observerGuard.configure")}</button> : null}
  </AnchoredMenu>;
}
