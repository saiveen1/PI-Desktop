import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { IconFolder, IconPalette } from "../../components/icons";
import { SESSION_COLORS, type SessionColor, type SessionLabel } from "../../lib/session-labels";
import { sidebarMenuAction, sidebarMenuSubmenu } from "../../lib/sidebar-menu";
import type { SessionMeta } from "../../lib/sidebar-preferences";
import type { SessionGroup } from "../../lib/session-organization";
import { useAppStore } from "../../stores/app-store";
import "../../styles/session-labels.css";

export { SessionColorPicker } from "./SessionColorPicker";
export const sessionLabelName = (label: SessionLabel, t: TFunction) =>
  label.defaultName ? t(`sessionLabels.${label.defaultName}`) : label.name;

export function ColorSwatch({ color, label }: { color: SessionColor; label?: string }) {
  const custom = color.startsWith("#");
  return <span className={`session-color-swatch${custom ? "" : ` session-color-${color}`}`}
    style={custom ? { backgroundColor: color } : undefined} role={label ? "img" : undefined}
    title={label} aria-label={label} aria-hidden={label ? undefined : true} />;
}

export function SessionLabelChips({ labels, meta }: { labels: SessionLabel[]; meta: SessionMeta }) {
  const { t } = useTranslation();
  const selected = labels.filter(label => meta.labelIds?.includes(label.id));
  if (!selected.length) return null;
  const names = selected.map(label => sessionLabelName(label, t)).join(", ");
  return <span className="session-row-labels" role="img" title={names} aria-label={`${t("sessionLabels.title")}: ${names}`}>
    {selected.slice(0, 2).map(label => <ColorSwatch key={label.id} color={label.color} />)}
    {selected.length > 2 ? <span className="session-label-overflow" aria-hidden="true">+{selected.length - 2}</span> : null}
  </span>;
}

export function sessionGroupMenu(id: string, groups: SessionGroup[], meta: SessionMeta, t: TFunction, manage: () => void) {
  const move = (groupId: string | null) => useAppStore.getState().moveSessionToGroup(id, groupId);
  return sidebarMenuSubmenu({ id: "session-group", label: t("sessionGroups.moveTo"), icon: <IconFolder size={14} />, items: [
    sidebarMenuAction({ id: "session-group-none", label: t("sessionGroups.ungrouped"), checked: !groups.some(group => group.id === meta.groupId), onSelect: () => move(null) }),
    ...groups.map(group => sidebarMenuAction({ id: `session-group-${group.id}`, label: group.name, icon: <ColorSwatch color={group.color} />,
      checked: meta.groupId === group.id, onSelect: () => move(group.id) })),
    sidebarMenuAction({ id: "manage-session-groups", label: t("sessionGroups.manage"), separatorBefore: true, onSelect: manage }),
  ] });
}

export function sessionMarkMenu(id: string, labels: SessionLabel[], meta: SessionMeta, t: TFunction, manage: () => void) {
  const mark = useAppStore.getState().markSession;
  return [
    sidebarMenuSubmenu({ id: "session-labels", label: t("sessionLabels.title"), icon: <IconPalette size={14} />, items: [
      ...labels.map(label => sidebarMenuAction({ id: `session-label-${label.id}`, label: sessionLabelName(label, t), icon: <ColorSwatch color={label.color} />,
        checked: meta.labelIds?.includes(label.id) ?? false, onSelect: () => {
          const current = useAppStore.getState().sessionMeta[id]?.labelIds ?? [];
          mark(id, { labelIds: current.includes(label.id) ? current.filter(key => key !== label.id) : [...current, label.id] });
        } })),
      sidebarMenuAction({ id: "manage-session-labels", label: t("sessionLabels.manage"), separatorBefore: true, onSelect: manage }),
    ] }),
    sidebarMenuSubmenu({ id: "session-color", label: t("sessionLabels.colorMark"), icon: <IconPalette size={14} />, items: [
      sidebarMenuAction({ id: "session-color-clear", label: t("sessionLabels.clearColor"), checked: !meta.color, onSelect: () => mark(id, { color: null }) }),
      ...SESSION_COLORS.map(color => sidebarMenuAction({ id: `session-color-${color}`, label: t(`sessionLabels.colors.${color}`),
        icon: <ColorSwatch color={color} />, checked: meta.color === color, onSelect: () => mark(id, { color }) })),
    ] }),
  ];
}
