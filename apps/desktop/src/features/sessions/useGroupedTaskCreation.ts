import { useLayoutEffect, useState, type Dispatch, type SetStateAction } from "react";
import { sessionGroupKey, sessionOrganizationCatalog, type SidebarSessionGroup } from "../../lib/session-organization";
import { expandSessionGroup, type SessionGroupExpansion } from "../../lib/sidebar-project-sessions";
import type { RemoteProjectEntry } from "../../lib/remote-project-catalog";
import { remoteProjectCollapseKey } from "../../lib/remote-project-catalog";
import { useAppStore } from "../../stores/app-store";

type Destination = { projectPath: string | null } | { remoteProject: RemoteProjectEntry };
type Reveal = { id: string; scope: string; groupId: string | null };

/** Only an explicit create can reveal a group. Ordinary selection must never change disclosure. */
export function useGroupedTaskCreation(
  groups: ReadonlyMap<string, readonly SidebarSessionGroup[]>,
  setToggled: Dispatch<SetStateAction<ReadonlySet<string>>>,
  setExpanded: Dispatch<SetStateAction<SessionGroupExpansion>>,
  reportError: (error: unknown) => void,
) {
  const [reveal, setReveal] = useState<Reveal | null>(null);
  useLayoutEffect(() => {
    if (!reveal) return;
    const { scope, id, groupId } = reveal;
    const state = useAppStore.getState();
    if (state.page === "chat" && state.activeSessionId === id) {
      const group = groups.get(scope)?.find(item => (item.group?.id ?? null) === groupId);
      if (group?.visibleSessions && !group.visibleSessions.some(item => item.id === id) && group.sessions.some(item => item.id === id)) {
        setExpanded(previous => expandSessionGroup(previous, scope, groupId ?? ""));
        return;
      }
      document.querySelector<HTMLElement>(`[data-sidebar-session-row="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
      document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus({ preventScroll: true });
    }
    setReveal(null);
  }, [groups, reveal, setExpanded]);

  return async (scope: string, destination: Destination, requestedGroupId: string | null) => {
    try {
      const id = await useAppStore.getState().newSession({ ...destination, groupId: requestedGroupId });
      const state = useAppStore.getState();
      if (!id || state.activeSessionId !== id || state.page !== "chat") return;
      const collapseKey = "remoteProject" in destination ? remoteProjectCollapseKey(destination.remoteProject.key) : destination.projectPath;
      if (collapseKey) state.setProjectCollapsed(collapseKey, false);
      // Catalog edits may have changed placement while the Host created the row.
      const member = state.sessionMeta[id]?.groupId;
      const groupId = member && sessionOrganizationCatalog(state.sessionOrganization, scope, state.sessionLabels).groups.some(group => group.id === member) ? member : null;
      const key = sessionGroupKey(scope, groupId);
      setToggled(previous => {
        if (previous.has(key) === (groupId !== null)) return previous;
        const next = new Set(previous);
        if (groupId === null) next.delete(key); else next.add(key);
        return next;
      });
      setReveal({ scope, groupId, id });
    } catch (error) { reportError(error); }
  };
}
