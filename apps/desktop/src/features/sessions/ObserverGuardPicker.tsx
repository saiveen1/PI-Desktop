import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { OBSERVER_GUARD_MODES, resolveObserverGuardMode, type ObserverGuardMode } from "@pi-desktop/shared";
import { IconCheck, IconEye } from "../../components/icons";
import { AnchoredMenu } from "../../components/settings/AnchoredMenu";
import { Button, TooltipButton } from "../../components/ui";
import { isRemoteSession } from "../../lib/remote-session-safety";
import { observerModelLabel, observerSelection } from "../../lib/observer-guard-models";
import { observerDecisionKey, observerSummaryKey } from "../../lib/observer-guard-presentation";
import { useAppStore } from "../../stores/app-store";

export function ObserverGuardPicker({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation();
  const session = useAppStore(state => state.sessions.find(row => row.id === sessionId));
  const running = useAppStore(state => sessionId ? Boolean(state.runningSessions[sessionId]) : false);
  const pending = useAppStore(state => sessionId ? state.pendingPlans[sessionId]?.status === "pending" : false);
  const runtime = useAppStore(state => sessionId ? state.agentStatuses[sessionId] : undefined);
  const settings = useAppStore(state => state.settings);
  const providers = useAppStore(state => state.providers);
  const catalog = useAppStore(state => state.providerModels);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => setOpen(false), [sessionId]);
  if (session && (session.scheduledRun || session.id.startsWith("native-pi:") || isRemoteSession(session) || (session.source && session.source !== "desktop"))) return null;
  const mode = resolveObserverGuardMode(session?.observerMode);
  const selection = observerSelection(settings, providers, catalog);
  const ready = selection.available;
  const blocked = !session || running || pending || saving;
  const diagnostics = runtime?.runDiagnostics;
  const assessment = running && runtime?.isRunning && diagnostics?.turnId === runtime.currentTurnId ? diagnostics?.observer : undefined;
  const statusKey = mode === "off" ? "observerGuard.off" : assessment ? observerSummaryKey(assessment)
    : running ? "observerGuard.waiting" : !ready ? "observerGuard.unavailable" : "observerGuard.ready";
  const label = `${t("observerGuard.title")}: ${t(`observerGuard.${mode}`)}. ${t(statusKey)}`;
  const hint = !session ? t("observerGuard.draft") : `${label}${running || pending ? `. ${t("observerGuard.busy")}` : ""}`;
  const actualModel = assessment?.modelKey ? observerModelLabel(assessment.modelKey, providers) : undefined;
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
  return <AnchoredMenu className="composer-mode" open={open && Boolean(session)} onClose={() => setOpen(false)}
    menuClassName="composer-mode-menu" label={t("observerGuard.title")} role="menu" align="start" side="top"
    trigger={ref => <TooltipButton ref={ref} type="button" className={`icon-btn mode-chip composer-mode-chip ${mode !== "off" ? "active" : ""}`}
      tooltip={hint} ariaLabel={hint} aria-haspopup="menu" aria-expanded={open && Boolean(session)} disabled={!session || saving}
      onClick={() => setOpen(current => !current)}><IconEye size={15} aria-hidden /><span className="composer-mode-chip-label text-sm">{t(`observerGuard.${mode}`)}{mode !== "off" && (!ready || running) ? ` · ${t(statusKey)}` : ""}</span></TooltipButton>}>
    {OBSERVER_GUARD_MODES.map(candidate => <Button key={candidate} variant="ghost" type="button" role="menuitemradio"
      aria-checked={mode === candidate} disabled={blocked || (candidate !== "off" && !ready)}
      className={`composer-plus-item ${mode === candidate ? "active" : ""}`} onClick={() => void choose(candidate)}>
      <span className="flex-1 text-left">{t(`observerGuard.${candidate}`)}</span>{mode === candidate ? <IconCheck size={13} /> : null}
    </Button>)}
    <p className="session-delegation-hint" role="status">{t(statusKey)}</p>
    <p className="session-delegation-hint">{assessment ? t(observerDecisionKey(assessment)) : t("observerGuard.triggerHint")}</p>
    <p className="session-delegation-hint">{t(actualModel ? "observerGuard.model" : "observerGuard.configuredModel")}: {actualModel ?? selection.selected?.label ?? (selection.value.modelId || t("observerGuard.noModel"))}</p>
    <p className="session-delegation-hint">{t("observerGuard.modeHint")}</p>
    {running || pending ? <p className="session-delegation-hint">{t("observerGuard.busy")}</p> : null}
    <Button variant="ghost" type="button" role="menuitem" className="composer-plus-item" onClick={() => { setOpen(false); useAppStore.getState().setSettingsTab("behavior"); }}>{t("observerGuard.configure")}</Button>
  </AnchoredMenu>;
}
