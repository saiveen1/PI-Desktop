import type { SessionLabel } from "./session-labels";

export type SidebarLabelGroup<T extends { id: string } = { id: string }> = {
  label: SessionLabel | null;
  sessions: T[];
};

/** Stable presentation-only partition; never changes the persisted/manual order. */
export function prioritizeRunningSessions<T extends { id: string }>(
  sessions: readonly T[], running: Readonly<Record<string, boolean | undefined>>,
): T[] {
  return [...sessions.filter(session => running[session.id]), ...sessions.filter(session => !running[session.id])];
}

/** Presentation only: every group keeps references to the original conversations. */
export function groupSessionsByLabel<T extends { id: string }>(
  sessions: readonly T[],
  labels: readonly SessionLabel[],
  meta: Readonly<Record<string, { labelIds?: string[] }>>,
): SidebarLabelGroup<T>[] {
  const groups = new Map(labels.map(label => [label.id, { label, sessions: [] as T[] }]));
  const unclassified: SidebarLabelGroup<T> = { label: null, sessions: [] };
  for (const session of sessions) {
    let classified = false;
    for (const id of new Set(meta[session.id]?.labelIds)) {
      const group = groups.get(id);
      if (!group) continue;
      group.sessions.push(session);
      classified = true;
    }
    if (!classified) unclassified.sessions.push(session);
  }
  return [...groups.values(), unclassified].filter(group => group.sessions.length > 0);
}

export const sessionLabelGroupKey = (scope: string, labelId: string | null) =>
  JSON.stringify([scope, labelId]);

/** Visible selection is by conversation, not by the number of label shortcuts. */
export function visibleLabelSessionIds(
  groups: readonly SidebarLabelGroup[],
  scope: string,
  collapsed: ReadonlySet<string>,
): string[] {
  return [...new Set(groups.flatMap(group =>
    collapsed.has(sessionLabelGroupKey(scope, group.label?.id ?? null)) ? [] : group.sessions.map(session => session.id),
  ))];
}
