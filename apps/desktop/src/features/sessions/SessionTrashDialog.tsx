import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Checkbox, OverlayBackdrop, TooltipButton } from "../../components/ui";
import { IconClose } from "../../components/icons";
import { api } from "../../lib/api";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { portalToBody } from "../../lib/portal-visibility";
import { useAppStore } from "../../stores/app-store";
import { useSessionSelection } from "./useSessionSelection";
import "./session-organization.css";

type TrashedSession = Awaited<ReturnType<typeof api.listTrashedSessions>>["sessions"][number];

export function SessionTrashDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  useBlockingOverlay();
  const [sessions, setSessions] = useState<TrashedSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<string[] | null>(null);
  const ids = useMemo(() => sessions.map((session) => session.id), [sessions]);
  const selection = useSessionSelection(ids);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  const mounted = useRef(false);
  const request = useRef(0);
  const closeRef = useRef(onClose);
  const confirmationRef = useRef(confirmation);
  closeRef.current = onClose;
  confirmationRef.current = confirmation;

  const load = useCallback(async () => {
    const generation = ++request.current;
    setLoading(true);
    setError("");
    try {
      const result = await api.listTrashedSessions();
      if (mounted.current && generation === request.current) setSessions(result.sessions);
    } catch (cause) {
      if (mounted.current && generation === request.current) setError(String(cause));
    } finally {
      if (mounted.current && generation === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => dialogRef.current?.focus());
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (busyRef.current) return;
        if (confirmationRef.current) setConfirmation(null);
        else closeRef.current();
      }
      if (event.key !== "Tab") return;
      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])");
      if (!nodes?.length) { event.preventDefault(); return; }
      const index = Array.from(nodes).indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) {
        event.preventDefault(); nodes[nodes.length - 1].focus();
      } else if (!event.shiftKey && (index < 0 || index === nodes.length - 1)) {
        event.preventDefault(); nodes[0].focus();
      }
    };
    window.addEventListener("keydown", keyDown, true);
    return () => {
      mounted.current = false;
      request.current += 1;
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", keyDown, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [load]);

  useEffect(() => {
    if (confirmation) cancelRef.current?.focus();
  }, [confirmation]);

  const run = async (action: "restore" | "delete", selected: readonly string[]) => {
    if (busyRef.current || loading || selected.length === 0) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    const targets = sessions.filter((session) => selected.includes(session.id));
    const completed: string[] = [];
    const failures: string[] = [];
    try {
      for (const session of targets) {
        try {
          const store = useAppStore.getState();
          if (action === "restore") await store.restoreTrashedSession(session.id);
          else await store.deleteTrashedSession(session.id);
          completed.push(session.id);
          if (mounted.current) {
            setSessions((current) => current.filter((item) => item.id !== session.id));
            selection.remove([session.id]);
          }
        } catch (cause) {
          failures.push(t("sessionOrganization.failed", {
            title: session.title, reason: cause instanceof Error ? cause.message : String(cause),
          }));
        }
      }
      if (action === "restore" && completed.length) {
        try { await useAppStore.getState().refreshSessions(); }
        catch (cause) { failures.push(String(cause)); }
      }
      if (completed.length) useAppStore.getState().showToast(t(
        action === "restore" ? "sessionOrganization.restored" : "sessionOrganization.permanentlyDeleted",
        { count: completed.length },
      ));
      if (mounted.current) setError(failures.join("\n"));
    } finally {
      busyRef.current = false;
      if (mounted.current) {
        setBusy(false);
        setConfirmation(null);
      }
    }
  };
  const locked = busy || loading || confirmation !== null;
  const count = selection.selectedIds.size;
  const dismiss = () => { if (!busyRef.current) onClose(); };

  return portalToBody(
    <OverlayBackdrop className="overlay" role="presentation" onClick={(event) => {
      if (event.target === event.currentTarget) dismiss();
    }}>
      <div ref={dialogRef} className="dialog session-trash-dialog" role="dialog" aria-modal="true"
        aria-labelledby="session-trash-title" aria-describedby="session-trash-description" aria-busy={busy || loading}
        tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <div className="session-trash-heading">
          <h2 id="session-trash-title">{t("sessionOrganization.trashTitle")}</h2>
          <TooltipButton tooltip={t("common.close")} ariaLabel={t("common.close")} disabled={busy} onClick={dismiss}>
            <IconClose size={16} />
          </TooltipButton>
        </div>
        <p id="session-trash-description" className="session-trash-description">{t("sessionOrganization.trashDescription")}</p>
        {error && <div role="alert" className="session-trash-error">{error}
          <Button size="sm" disabled={locked} onClick={() => void load()}>{t("sessionOrganization.retry")}</Button>
        </div>}
        {loading ? <p role="status">{t("sessionOrganization.loading")}</p> : sessions.length === 0
          ? <p className="session-trash-empty">{t("sessionOrganization.empty")}</p>
          : <>
            <div className="session-trash-heading">
              <Checkbox label={t("sessionOrganization.selectVisible")} checked={count === sessions.length}
                indeterminate={count > 0 && count < sessions.length} disabled={locked} onChange={selection.selectAll} />
              <span role="status">{t("sessionOrganization.selected", { count })}</span>
            </div>
            <div className="session-trash-list">
              {sessions.map((session) => <div key={session.id} className="session-trash-row">
                <Checkbox checked={selection.selectedIds.has(session.id)} disabled={locked}
                  onChange={() => selection.toggle(session.id)} label={<>
                    {session.title || t("chat.untitledTask")}
                    <span className="session-trash-details">{session.projectPath || t("nav.hoverCardTemporarySpace")}</span>
                    <span className="session-trash-details">{t("sessionOrganization.deletedAt", {
                      date: new Date(session.deletedAt).toLocaleString(i18n.resolvedLanguage ?? i18n.language),
                    })}</span>
                  </>} />
              </div>)}
            </div>
            <div className="session-trash-actions">
              <Button disabled={locked || count === 0} onClick={() => void run("restore", [...selection.selectedIds])}>{t("sessionOrganization.restore")}</Button>
              <Button className="session-trash-danger" disabled={locked || count === 0}
                onClick={() => setConfirmation([...selection.selectedIds])}>{t("sessionOrganization.deletePermanently")}</Button>
            </div>
          </>}
        {confirmation && <div className="session-trash-confirmation" role="group" aria-label={t("sessionOrganization.deletePermanently")}>
          <p>{t("sessionOrganization.confirmDelete", { count: confirmation.length })}</p>
          <div className="session-trash-actions">
            <Button ref={cancelRef} disabled={busy} onClick={() => setConfirmation(null)}>{t("common.cancel")}</Button>
            <Button className="session-trash-danger" disabled={busy} onClick={() => void run("delete", confirmation)}>
              {t("sessionOrganization.deletePermanently")}
            </Button>
          </div>
        </div>}
      </div>
    </OverlayBackdrop>,
  );
}
