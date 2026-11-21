import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "@pi-desktop/shared";
import type {
  RemoteProjectEntry,
  RemoteProjectGroup,
} from "../../lib/remote-project-catalog";
import { remoteProjectCollapseKey } from "../../lib/remote-project-catalog";
import {
  projectRunSummaryIsLive,
  resolveSidebarRunningAffordances,
  summarizeProjectRuns,
} from "../../lib/sidebar-project-runs";
import { isRemoteSession } from "../../lib/remote-session-safety";
import { useAppStore } from "../../stores/app-store";
import {
  ProjectRunBadge,
  ProjectRunCount,
  ProjectRunRail,
} from "../ProjectRunIndicator";
import { IconChevronDown, IconFolder } from "../icons";
import { Button } from "../ui";
import { ProjectGroupCreateButton } from "../../features/sessions/ProjectGroupCreateButton";
import type { SessionGroup } from "../../lib/session-organization";

/** The same project/chat hierarchy, keyed by Host identity rather than local paths. */
export function RemoteProjectGroups({
  groups,
  renderSessions,
  catalogGroups,
  onCreate,
  eligibleSessions,
  pendingSessionIds,
  sessionOutcomes,
}: {
  groups: RemoteProjectGroup[];
  renderSessions: (key: string, create?: (groupId: string | null) => void) => ReactNode;
  catalogGroups: (key: string) => readonly SessionGroup[];
  onCreate?: (project: RemoteProjectEntry, groupId: string | null) => Promise<void>;
  eligibleSessions: SessionSummary[];
  pendingSessionIds: ReadonlySet<string>;
  sessionOutcomes: Readonly<Record<string, "completed" | "failed" | undefined>>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const settings = useAppStore((state) => state.settings);
  // Remote groups carry the same running affordances as local projects, so a
  // collapsed host group does not hide live work either.
  const runAffordances = resolveSidebarRunningAffordances(settings);
  const runningSessions = useAppStore((state) => state.runningSessions);
  const pendingPermissions = useAppStore((state) => state.pendingPermissions);
  // The same collapse state and persistence as local project groups; the
  // `remote::` prefix keeps these keys out of the local path namespace, and the
  // persisted fold survives a restart like a local one.
  const projectCollapsed = useAppStore((state) => state.projectCollapsed);
  const setProjectCollapsed = useAppStore((state) => state.setProjectCollapsed);
  const open = async (project: RemoteProjectEntry, groupId: string | null) => {
    if (busy || !onCreate) return;
    setBusy(project.key);
    try {
      await onCreate(project, groupId);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {groups.map(({ project }) => {
        const create = (groupId: string | null) => void open(project, groupId);
        const projectSessions = eligibleSessions.filter(
          (session) => isRemoteSession(session)
            && session.remoteHostKey === project.hostKey
            && session.remoteProjectId === project.projectId,
        );
        const runSummary = summarizeProjectRuns(projectSessions, runningSessions, pendingPermissions, pendingSessionIds, sessionOutcomes);
        const runIsLive = projectRunSummaryIsLive(runSummary);
        const showRunBadge = runAffordances.badge && runIsLive;
        const showRunRail = runAffordances.rail && runIsLive;
        // Same exclusivity rule as the local sidebar: one set of numbers, owned by
        // the badge while it is on and by the rail when it is off.
        const showRunCount = runAffordances.railCount && runIsLive;
        const collapseKey = remoteProjectCollapseKey(project.key);
        const collapsed = projectCollapsed[collapseKey] ?? false;
        return (
          <section
            className={`sidebar-session-group project-group ${runIsLive ? "has-running-sessions" : ""} ${showRunRail ? "has-run-rail" : ""} ${collapsed ? "is-collapsed" : ""}`}
            key={project.key}
            data-sidebar-project-group={project.key}
          >
            {showRunRail ? <ProjectRunRail summary={runSummary} /> : null}
            <div
              className="sidebar-session-group-header"
              onClick={(event) => {
                // Same one-target rule as a local project group: the header's own
                // controls stay the only spelled-out targets, so the gutter next to a
                // hidden control still activates and toggles the group.
                const target = event.target as HTMLElement | null;
                if (target?.closest("button, [data-action]")) return;
                setProjectCollapsed(collapseKey, !collapsed);
              }}
            >
              <Button
                variant="ghost"
                className="sidebar-session-group-title project-toggle"
                disabled={busy !== null}
                title={`${project.hostLabel} · ${project.label}`}
                aria-expanded={!collapsed}
                aria-controls={`${project.key}-sessions`}
                data-action="toggle-project-collapse"
                onClick={() => setProjectCollapsed(collapseKey, !collapsed)}
              >
                <IconChevronDown
                  size={13}
                  className={`sidebar-disclosure-icon ${collapsed ? "collapsed" : ""}`}
                  aria-hidden
                />
                <IconFolder size={13} aria-hidden />
                <span>
                  {project.label} · {project.hostLabel}
                </span>
                {showRunBadge ? <ProjectRunBadge summary={runSummary} /> : null}
                {showRunCount ? <ProjectRunCount summary={runSummary} /> : null}
              </Button>
              {onCreate && <ProjectGroupCreateButton groups={catalogGroups(project.key)} onCreate={create} disabled={busy !== null}
                label={`${t("nav.newTask")}: ${project.label} · ${project.hostLabel}`} />}
            </div>
            <div
              id={`${project.key}-sessions`}
              className={`sidebar-session-group-body project ${collapsed ? "collapsed" : ""}`}
              role="region"
              aria-hidden={collapsed}
              inert={collapsed ? true : undefined}
            >
              <div className="sidebar-session-group-clip">
                <div className="sidebar-session-group-list">
                  {renderSessions(project.key, onCreate && busy === null ? create : undefined)}
                </div>
              </div>
            </div>
          </section>
        );
      })}
    </>
  );
}
