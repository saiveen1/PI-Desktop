import type { SidebarSessionGroup } from "./session-organization";

export const DEFAULT_VISIBLE_PROJECT_SESSION_COUNT = 10;
export type SessionGroupExpansion = Record<string, Record<string, boolean>>;

export function expandSessionGroup(
  expanded: SessionGroupExpansion,
  scope: string,
  groupId: string,
): SessionGroupExpansion {
  return { ...expanded, [scope]: { ...expanded[scope], [groupId]: true } };
}

export function resetSessionGroupExpansion(
  expanded: SessionGroupExpansion,
  scope: string,
): SessionGroupExpansion {
  const next = { ...expanded };
  delete next[scope];
  return next;
}

/** Keep complete membership for counts; only the rendered/selected rows are paged. */
export function paginateSessionGroups<T extends { id: string }>(
  groups: readonly SidebarSessionGroup<T>[],
  expanded: Readonly<Record<string, boolean>> = {},
): SidebarSessionGroup<T>[] {
  return groups.map(row => ({
    ...row,
    visibleSessions: expanded[row.group?.id ?? ""] === true
      ? row.sessions
      : row.sessions.slice(0, DEFAULT_VISIBLE_PROJECT_SESSION_COUNT),
  }));
}
