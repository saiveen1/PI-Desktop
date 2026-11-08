import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui";
import { IconChevronRight, IconSettings } from "../../components/icons";
import { sessionGroupKey, type SidebarSessionGroup } from "../../lib/session-organization";
import { ColorSwatch } from "./SessionLabelControls";

export function SidebarSessionGroups<T extends { id: string }>({ groups, scope, collapsed, onToggle, onManage, renderSessions }: {
  groups: readonly SidebarSessionGroup<T>[]; scope: string; collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void; onManage: () => void; renderSessions: (sessions: T[]) => ReactNode;
}) {
  const { t } = useTranslation();
  const prefix = useId();
  return <>
    <Button variant="ghost" className="sidebar-organization-manage" onClick={onManage}>
      <IconSettings size={12} aria-hidden />{t("sessionGroups.manage")}
    </Button>
    {groups.map((row, index) => {
      const key = sessionGroupKey(scope, row.group?.id ?? null);
      const folded = collapsed.has(key);
      const name = row.group?.name ?? t("sessionGroups.ungrouped");
      const bodyId = `${prefix}-${index}`;
      return <div key={key} className="sidebar-conversation-group" data-sidebar-session-group={row.group?.id ?? ""} data-group-scope={scope}>
        <Button variant="ghost" className="sidebar-conversation-group-title" aria-expanded={!folded} aria-controls={bodyId}
          title={name} onClick={() => onToggle(key)}>
          <IconChevronRight size={12} className={folded ? "" : "is-expanded"} aria-hidden />
          {row.group ? <ColorSwatch color={row.group.color} /> : null}
          <span className="sidebar-conversation-group-name">{name}</span>
          <span className="sidebar-conversation-group-count">{row.sessions.length}</span>
        </Button>
        <div id={bodyId} className="sidebar-conversation-group-body" hidden={folded}>
          {!folded && renderSessions(row.sessions)}
        </div>
      </div>;
    })}
  </>;
}
