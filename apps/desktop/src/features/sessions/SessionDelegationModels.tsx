import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { delegationModelKey, legacyDelegationSettings, type DelegationModelApprovals, type SessionSummary } from "@pi-desktop/shared";
import { IconClose, IconWorkflow } from "../../components/icons";
import { Button, Checkbox, Input, OverlayBackdrop, SegmentedControl, Select, TooltipButton, portalOverlay } from "../../components/ui";
import { api } from "../../lib/api";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { useAppStore } from "../../stores/app-store";
import "../../styles/session-delegation.css";

export function SessionDelegationModels({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation();
  const session = useAppStore(state => state.sessions.find(row => row.id === sessionId));
  const running = useAppStore(state => sessionId ? Boolean(state.runningSessions[sessionId]) : false);
  const pendingPlan = useAppStore(state => sessionId ? state.pendingPlans[sessionId]?.status === "pending" : false);
  const [openedId, setOpenedId] = useState<string | null>(null);
  const close = useCallback(() => setOpenedId(null), []);
  useEffect(() => setOpenedId(null), [sessionId]);
  if (!session || (session.source && session.source !== "desktop")) return null;
  const custom = session.delegationModelKeys !== undefined;
  const label = custom
    ? t("sessionDelegation.customCount", { count: session.delegationModelKeys?.length ?? 0 })
    : t("sessionDelegation.title");
  return <>
    <TooltipButton type="button" className={`icon-btn icon-btn-square session-delegation-trigger${custom ? " is-custom" : ""}`}
      tooltip={label} ariaLabel={label} aria-haspopup="dialog" aria-expanded={openedId === session.id}
      onClick={() => setOpenedId(session.id)}>
      <IconWorkflow size={15} aria-hidden />
    </TooltipButton>
    {openedId === session.id ? <SessionDelegationDialog key={session.id} session={session}
      blocked={running || pendingPlan} onClose={close} /> : null}
  </>;
}

function SessionDelegationDialog({ session, blocked, onClose }: {
  session: SessionSummary; blocked: boolean; onClose: () => void;
}) {
  useBlockingOverlay();
  const { t } = useTranslation();
  const titleId = useId();
  const settings = useAppStore(state => state.settings);
  const providers = useAppStore(state => state.providers);
  const policy = useMemo(() => settings?.delegation ?? legacyDelegationSettings(providers), [settings?.delegation, providers]);
  const availableKeys = useMemo(() => new Set(policy.models.filter(row => row.enabled &&
    providers.some(provider => provider.id === row.providerId && provider.enabled !== false &&
      (provider.hasSecret || provider.hasOauth || provider.authKind === "none") &&
      provider.models.some(model => model.id === row.modelId))).map(delegationModelKey)), [policy, providers]);
  const [mode, setMode] = useState<"inherit" | "custom">(session.delegationModelKeys === undefined ? "inherit" : "custom");
  const [selected, setSelected] = useState<string[]>(() => [...(session.delegationModelKeys ?? availableKeys)]);
  const [approvals, setApprovals] = useState<DelegationModelApprovals>(() => ({ ...session.delegationModelApprovals }));
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const savingRef = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>("button")?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!savingRef.current) onClose();
      }
      if (event.key !== "Tab") return;
      const elements = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]');
      if (!elements?.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      mounted.current = false;
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [onClose]);
  const rows = useMemo(() => {
    const entries = policy.models.filter(row => row.enabled || selected.includes(delegationModelKey(row)))
      .map(row => ({ key: delegationModelKey(row), modelId: row.modelId,
        provider: providers.find(provider => provider.id === row.providerId)?.name ?? row.providerId,
        description: row.description, approval: row.approval, available: availableKeys.has(delegationModelKey(row)) }));
    for (const key of selected) {
      if (!entries.some(row => row.key === key)) entries.push({ key, modelId: key, provider: "", description: "", approval: "ask", available: false });
    }
    return entries;
  }, [policy, providers, selected, availableKeys]);
  const needle = query.trim().toLocaleLowerCase();
  const visibleRows = rows.filter(row => `${row.key} ${row.provider} ${row.description}`.toLocaleLowerCase().includes(needle));
  const invalidSelection = mode === "custom" && selected.some(key => !availableKeys.has(key));
  const save = async () => {
    if (savingRef.current || blocked || invalidSelection || !settings) return;
    const state = useAppStore.getState();
    const current = state.sessions.find(row => row.id === session.id);
    if (!current || state.runningSessions[session.id] || state.pendingPlans[session.id]?.status === "pending") return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await api.configureSession(session.id, {
        mode: current.mode,
        delegationModelKeys: mode === "inherit" ? null : selected,
        delegationModelApprovals: mode === "inherit" ? null : Object.fromEntries(selected.map(key => [key,
          approvals[key] ?? policy.models.find(row => delegationModelKey(row) === key)?.approval ?? "ask"])),
      });
      useAppStore.setState(latest => ({ sessions: latest.sessions.map(row => {
        if (row.id !== session.id) return row;
        const { delegationModelKeys: _previousPool, delegationModelApprovals: _previousApprovals, ...existing } = row;
        return { ...existing, ...result.session };
      }) }));
      if (mounted.current) onClose();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  return portalOverlay(<OverlayBackdrop className="overlay session-delegation-overlay" role="presentation"
    onClick={() => { if (!savingRef.current) onClose(); }}>
    <div ref={dialogRef} className="dialog session-delegation-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={saving}>
      <header className="session-delegation-header">
        <div><h2 id={titleId}>{t("sessionDelegation.title")}</h2><p>{session.title}</p></div>
        <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={t("sessionDelegation.cancel")}
          ariaLabel={t("sessionDelegation.cancel")} disabled={saving} onClick={onClose}><IconClose size={16} /></TooltipButton>
      </header>
      <SegmentedControl label={t("sessionDelegation.scope")} value={mode} disabled={saving || blocked}
        options={[{ value: "inherit", label: t("sessionDelegation.inherit") }, { value: "custom", label: t("sessionDelegation.custom") }]}
        onChange={setMode} />
      <p className="session-delegation-hint">{t(mode === "custom" ? "sessionDelegation.taskFitHint" : "sessionDelegation.inheritHint")}</p>
      {mode === "custom" ? <>
        <Input type="search" value={query} onChange={event => setQuery(event.target.value)}
          placeholder={t("sessionDelegation.search")} aria-label={t("sessionDelegation.search")} />
        <div className="session-delegation-models" role="group" aria-label={t("sessionDelegation.models")}>
          {visibleRows.map(row => <div key={row.key} className="session-delegation-model">
            <Checkbox className="session-delegation-model-choice" checked={selected.includes(row.key)}
              disabled={saving || blocked || (!row.available && !selected.includes(row.key))} aria-label={row.key}
              onChange={event => { setSelected(current => event.target.checked ? [...current, row.key] : current.filter(key => key !== row.key)); setError(null); }}
              label={<span className="session-delegation-model-copy"><strong>{row.modelId}</strong>
                {row.provider ? <span>{row.provider}</span> : null}
              </span>} />
            {row.available ? <Select className="session-delegation-model-approval"
              aria-label={t("sessionDelegation.approvalFor", { model: row.key })}
              value={approvals[row.key] ?? row.approval} disabled={saving || blocked || !selected.includes(row.key)}
              onChange={event => {
                const approval = event.target.value;
                if (approval === "auto" || approval === "ask") setApprovals(current => ({ ...current, [row.key]: approval }));
                setError(null);
              }}>
              <option value="auto">{t("sessionDelegation.autoAllowed")}</option>
              <option value="ask">{t("sessionDelegation.approvalRequired")}</option>
            </Select> : <span className="session-delegation-model-state">{t("sessionDelegation.unavailable")}</span>}
            {row.description ? <p className="session-delegation-description">{row.description}</p> : null}
          </div>)}
          {visibleRows.length === 0 ? <p className="session-delegation-empty">{t("sessionDelegation.noModels")}</p> : null}
        </div>
        <p className="session-delegation-hint" role="status">{t(selected.length ? "sessionDelegation.selectedCount" : "sessionDelegation.disabled", { count: selected.length })}</p>
      </> : null}
      {blocked ? <p role="status" className="session-delegation-hint">{t("sessionDelegation.busy")}</p> : null}
      {invalidSelection ? <p role="alert" className="session-delegation-error">{t("sessionDelegation.invalidSelection")}</p> : null}
      {error ? <p role="alert" className="session-delegation-error">{error}</p> : null}
      <footer className="session-delegation-actions">
        <Button variant="ghost" disabled={saving} onClick={onClose}>{t("sessionDelegation.cancel")}</Button>
        <Button variant="primary" disabled={saving || blocked || invalidSelection || !settings} onClick={() => void save()}>
          {t(saving ? "sessionDelegation.saving" : "sessionDelegation.save")}
        </Button>
      </footer>
    </div>
  </OverlayBackdrop>);
}
