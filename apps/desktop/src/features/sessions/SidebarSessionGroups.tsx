import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, TooltipButton } from "../../components/ui";
import { IconChevronRight, IconNewSession, IconSettings } from "../../components/icons";
import { GroupRunStatus } from "../../components/ProjectRunIndicator";
import type { ProjectRunSummary } from "../../lib/sidebar-project-runs";
import { isSessionGroupCollapsed, sessionGroupKey, type SidebarSessionGroup } from "../../lib/session-organization";
import { ColorSwatch } from "./SessionLabelControls";
import "../../styles/session-organization.css";

export function SidebarSessionGroups<T extends { id: string }>({ groups, scope, toggledGroups, onToggle, onManage, onLoadMore, renderSessions, summarize, onCreate }: {
  groups: readonly SidebarSessionGroup<T>[]; scope: string; toggledGroups: ReadonlySet<string>;
  summarize?: (sessions: readonly T[]) => ProjectRunSummary; onCreate?: (groupId: string | null) => void;
  onToggle: (key: string) => void; onManage: () => void; onLoadMore?: (groupId: string) => void; renderSessions: (sessions: T[]) => ReactNode;
}) {
  const { t } = useTranslation();
  const prefix = useId();
  return <>
    <Button variant="ghost" className="sidebar-organization-manage" onClick={onManage}>
      <IconSettings size={12} aria-hidden />{t("sessionGroups.manage")}
    </Button>
    {groups.map((row, index) => {
      const id = row.group?.id ?? null;
      const key = sessionGroupKey(scope, id);
      const folded = isSessionGroupCollapsed(key, id, toggledGroups);
      const name = row.group?.name ?? t("sessionGroups.ungrouped");
      const bodyId = `${prefix}-${index}`;
      const visibleSessions = row.visibleSessions ?? row.sessions;
      const hiddenCount = row.sessions.length - visibleSessions.length;
      return <div key={key} className="sidebar-conversation-group" data-sidebar-session-group={row.group?.id ?? ""} data-group-scope={scope}>
        <div className="sidebar-conversation-group-header">
        <Button variant="ghost" className="sidebar-conversation-group-title" aria-expanded={!folded} aria-controls={bodyId}
          title={name} onClick={() => onToggle(key)}>
          <IconChevronRight size={12} className={folded ? "" : "is-expanded"} aria-hidden />
          {row.group ? <ColorSwatch color={row.group.color} /> : null}
          <span className="sidebar-conversation-group-name">{name}</span>
          {summarize ? <GroupRunStatus summary={summarize(row.sessions)} /> : <span className="sidebar-conversation-group-count">{row.sessions.length}</span>}
        </Button>
        {onCreate ? <TooltipButton type="button" className="sidebar-session-group-add" tooltip={t("project.newTask")} ariaLabel={`${t("project.newTask")}: ${name}`}
          onClick={() => onCreate(id)}><IconNewSession size={13} aria-hidden /></TooltipButton> : null}
        </div>
        <div id={bodyId} className="sidebar-conversation-group-body" hidden={folded}>
          {!folded && <>
            {renderSessions(visibleSessions)}
            {hiddenCount > 0 && onLoadMore ? <Button variant="ghost" className="sidebar-load-more"
              aria-controls={bodyId} aria-label={`${name}: ${t("nav.loadMoreCount", { count: hiddenCount })}`}
              onClick={() => onLoadMore(row.group?.id ?? "")}>
              {t("nav.loadMoreCount", { count: hiddenCount })}
            </Button> : null}
          </>}
        </div>
      </div>;
    })}
  </>;
}
