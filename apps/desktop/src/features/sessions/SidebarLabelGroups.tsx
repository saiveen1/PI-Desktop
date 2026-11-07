import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui";
import { IconChevronRight } from "../../components/icons";
import { sessionLabelGroupKey, type SidebarLabelGroup } from "../../lib/sidebar-label-groups";
import { ColorSwatch, sessionLabelName } from "./SessionLabelControls";

/** Label headers resemble project rows, but never create a conversation. */
export function SidebarLabelGroups<T extends { id: string }>({
  groups, scope, collapsed, onToggle, renderSessions,
}: {
  groups: readonly SidebarLabelGroup<T>[];
  scope: string;
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  renderSessions: (sessions: T[]) => ReactNode;
}) {
  const { t } = useTranslation();
  const prefix = useId();
  return <>{groups.map((group, index) => {
    const key = sessionLabelGroupKey(scope, group.label?.id ?? null);
    const folded = collapsed.has(key);
    const name = group.label ? sessionLabelName(group.label, t) : t("sessionLabels.unclassified");
    const bodyId = `${prefix}-${index}`;
    return <div key={key} className="sidebar-label-group" data-sidebar-label-group={group.label?.id ?? ""} data-label-scope={scope}>
      <Button variant="ghost" type="button" className="sidebar-label-group-title"
        aria-expanded={!folded} aria-controls={bodyId} title={name}
        onClick={() => onToggle(key)}>
        <IconChevronRight size={12} className={folded ? "" : "is-expanded"} aria-hidden />
        {group.label ? <ColorSwatch color={group.label.color} /> : null}
        <span className="sidebar-label-group-name">{name}</span>
      </Button>
      <div id={bodyId} className="sidebar-label-group-body" hidden={folded}>
        {!folded && renderSessions(group.sessions)}
      </div>
    </div>;
  })}</>;
}
