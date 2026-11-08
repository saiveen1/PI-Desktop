import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { OverlayBackdrop, SegmentedControl, TooltipButton } from "../../components/ui";
import { IconClose } from "../../components/icons";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { portalToBody } from "../../lib/portal-visibility";
import { SessionCatalogEditor, type SessionCatalogKind } from "./SessionCatalogEditor";
import "../../styles/session-organization.css";

export type SessionOrganizationTarget = { scope: string; name: string; tab?: SessionCatalogKind };

export function SessionOrganizationDialog({ target, onClose }: { target: SessionOrganizationTarget; onClose: () => void }) {
  useBlockingOverlay();
  const { t } = useTranslation();
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [tab, setTab] = useState<SessionCatalogKind>(target.tab ?? "groups");
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>("input, button")?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]') ?? [])
        .filter(element => element.getClientRects().length > 0);
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("keydown", onKeyDown); document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus(); };
  }, []);
  const dialog = <OverlayBackdrop className="overlay session-organization-overlay" role="presentation"
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} className="dialog session-organization-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
      <div className="session-organization-heading">
        <div><h2 id={`${id}-title`}>{t("sessionGroups.manage")}</h2><p>{target.name}</p></div>
        <TooltipButton onClick={onClose} tooltip={t("sessionLabels.cancel")} ariaLabel={t("sessionLabels.cancel")}><IconClose size={16} /></TooltipButton>
      </div>
      <SegmentedControl value={tab} onChange={setTab} label={t("sessionGroups.manage")}
        options={[{ value: "groups", label: t("sessionGroups.title") }, { value: "labels", label: t("sessionLabels.title") }]} />
      <SessionCatalogEditor key={`${target.scope}:${tab}`} scope={target.scope} kind={tab} />
    </div>
  </OverlayBackdrop>;
  return typeof document === "undefined" ? dialog : portalToBody(dialog);
}
