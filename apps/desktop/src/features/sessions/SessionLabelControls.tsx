import { useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Filter } from "lucide-react";
import { IconClose, IconPalette } from "../../components/icons";
import { Button, Checkbox, TooltipButton } from "../../components/ui";
import { AnchoredMenu } from "../../components/settings/AnchoredMenu";
import { SESSION_COLORS, type SessionColor, type SessionLabel } from "../../lib/session-labels";
import { sidebarMenuAction, sidebarMenuSubmenu } from "../../lib/sidebar-menu";
import type { SessionMeta } from "../../lib/sidebar-preferences";
import { useAppStore } from "../../stores/app-store";
import "../../styles/session-labels.css";

export const sessionLabelName = (label: SessionLabel, t: TFunction) =>
  label.defaultName ? t(`sessionLabels.${label.defaultName}`) : label.name;

export function ColorSwatch({ color, label }: { color: SessionColor; label?: string }) {
  return <span className={`session-color-swatch session-color-${color}`} role={label ? "img" : undefined}
    title={label} aria-label={label} aria-hidden={label ? undefined : true} />;
}
export function SessionColorPicker({ value, onChange, allowClear = false, clearLabel }: {
  value?: SessionColor; onChange: (value: SessionColor | undefined) => void; allowClear?: boolean; clearLabel?: string;
}) {
  const { t } = useTranslation();
  return <div className="session-color-picker" role="group" aria-label={t("sessionLabels.color")}>
    {allowClear ? <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={clearLabel ?? t("sessionLabels.clearColor")}
      ariaLabel={clearLabel ?? t("sessionLabels.clearColor")} aria-pressed={!value} onClick={() => onChange(undefined)}>
      <IconClose size={13} />
    </TooltipButton> : null}
    {SESSION_COLORS.map(color => <TooltipButton type="button" key={color} className="icon-btn icon-btn-square"
      tooltip={t(`sessionLabels.colors.${color}`)} ariaLabel={t(`sessionLabels.colors.${color}`)}
      aria-pressed={color === value} onClick={() => onChange(color)}><ColorSwatch color={color} /></TooltipButton>)}
  </div>;
}

export function SessionRowLabels({ meta, labels }: { meta: SessionMeta; labels: SessionLabel[] }) {
  const { t } = useTranslation();
  const assigned = labels.filter(label => meta.labelIds?.includes(label.id));
  return <span className="session-row-labels">
    {assigned.slice(0, 2).map(label => <span key={label.id} className={`session-label-chip session-color-${label.color}`}
      title={sessionLabelName(label, t)}>{sessionLabelName(label, t)}</span>)}
    {assigned.length > 2 ? <span className="session-label-overflow"
      title={assigned.slice(2).map(label => sessionLabelName(label, t)).join(", ")}
      aria-label={t("sessionLabels.overflow", { count: assigned.length - 2 })}>+{assigned.length - 2}</span> : null}
  </span>;
}

export function sessionMarkMenu(id: string, labels: SessionLabel[], meta: SessionMeta,
  t: TFunction, manage: () => void) {
  const mark = useAppStore.getState().markSession;
  return [
    sidebarMenuSubmenu({ id: "session-labels", label: t("sessionLabels.title"), icon: <IconPalette size={14} />,
      items: [
        ...labels.map(label => sidebarMenuAction({ id: `session-label-${label.id}`,
          label: sessionLabelName(label, t), icon: <ColorSwatch color={label.color} />, checked: meta.labelIds?.includes(label.id) ?? false,
          onSelect: () => {
            const current = useAppStore.getState().sessionMeta[id]?.labelIds ?? [];
            mark(id, { labelIds: current.includes(label.id) ? current.filter(key => key !== label.id) : [...current, label.id] });
          } })),
        sidebarMenuAction({ id: "manage-session-labels", label: t("sessionLabels.manage"), separatorBefore: true, onSelect: manage }),
      ],
    }),
    sidebarMenuSubmenu({ id: "session-color", label: t("sessionLabels.colorMark"), icon: <IconPalette size={14} />,
      items: [
        sidebarMenuAction({ id: "session-color-clear", label: t("sessionLabels.clearColor"), checked: !meta.color,
          onSelect: () => mark(id, { color: null }) }),
        ...SESSION_COLORS.map(color => sidebarMenuAction({ id: `session-color-${color}`, label: t(`sessionLabels.colors.${color}`),
          icon: <ColorSwatch color={color} />, checked: meta.color === color, onSelect: () => mark(id, { color }) })),
      ],
    }),
  ];
}

export function SessionFilterControl() {
  const { t } = useTranslation();
  const labels = useAppStore(state => state.sessionLabels);
  const filter = useAppStore(state => state.sessionFilter);
  const setFilter = useAppStore(state => state.setSessionFilter);
  const [open, setOpen] = useState(false);
  const active = filter.labelIds.length > 0 || Boolean(filter.color);
  return <AnchoredMenu open={open} onClose={() => setOpen(false)} align="end" role="dialog"
    label={t("sessionLabels.filter")} menuClassName="session-filter-menu" initialFocus="input"
    trigger={ref => <TooltipButton ref={ref} className={`sidebar-toolbar-button ${active ? "active" : ""}`}
      tooltip={t("sessionLabels.filter")} ariaLabel={t("sessionLabels.filter")} aria-haspopup="dialog"
      aria-expanded={open} onClick={() => setOpen(!open)}><Filter size={14} /></TooltipButton>}>
    <strong>{t("sessionLabels.title")}</strong>
    <div className="session-filter-labels">{labels.map(label => <Checkbox key={label.id}
      label={<><ColorSwatch color={label.color} />{sessionLabelName(label, t)}</>}
      checked={filter.labelIds.includes(label.id)} onChange={event => setFilter({ ...filter, labelIds: event.target.checked
        ? [...filter.labelIds, label.id] : filter.labelIds.filter(id => id !== label.id) })} />)}</div>
    <strong>{t("sessionLabels.colorMark")}</strong>
    <SessionColorPicker value={filter.color} allowClear clearLabel={t("sessionLabels.allColors")} onChange={color => setFilter({ ...filter, color })} />
    <Button variant="ghost" disabled={!active} onClick={() => setFilter({ labelIds: [] })}>{t("sessionLabels.clearFilters")}</Button>
  </AnchoredMenu>;
}
