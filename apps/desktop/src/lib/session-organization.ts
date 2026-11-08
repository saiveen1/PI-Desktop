import type { ProjectGroupRecord, SessionSummary } from "@pi-desktop/shared";
import { cleanSessionLabels, type SessionLabel, type SessionColor } from "./session-labels.ts";

export type SessionGroup = { id: string; name: string; color: SessionColor };
export type SessionOrganizationCatalog = { groups: SessionGroup[]; labels: SessionLabel[] };
export type SessionOrganization = { version: 1; scopes: Record<string, SessionOrganizationCatalog> };
export type SidebarSessionGroup<T extends { id: string } = { id: string }> = { group: SessionGroup | null; sessions: T[] };

// Kept dependency-free to avoid a preferences/organization import cycle.
function pathKey(path?: string | null): string | null {
  const value = path?.trim().replace(/\\/g, "/").replace(/^\/\/\?\/(?=[A-Za-z]:\/)/, "").replace(/(?<![A-Za-z]:)\/+$/, "");
  return value || (path?.trim() ? "/" : null);
}

export function projectGroupForPath(path: string | undefined | null, projects: readonly ProjectGroupRecord[]) {
  const key = pathKey(path);
  return key ? projects.find(project => !project.remote && (
    pathKey(project.primaryPath) === key || project.roots.some(root => pathKey(root.path) === key)
  )) : undefined;
}

export function projectOrganizationScope(path: string | undefined | null, projects: readonly ProjectGroupRecord[]): string {
  const project = projectGroupForPath(path, projects);
  return project && !project.legacy ? `group:${project.id}` : pathKey(path) ? `project:${pathKey(path)}` : "temporary";
}

export function sessionOrganizationScope(session: Pick<SessionSummary, "id"> & Partial<SessionSummary>, projects: readonly ProjectGroupRecord[]): string {
  if (session.source === "remote" || session.id.startsWith("remote:")) {
    return `remote:${JSON.stringify([session.remoteHostKey ?? session.id, session.remoteProjectId ?? null])}`;
  }
  return projectOrganizationScope(session.projectPath, projects);
}

export function cleanSessionGroups(value: unknown): SessionGroup[] {
  return cleanSessionLabels(Array.isArray(value) ? value : []).map(({ id, name, color }) => ({ id, name, color }));
}

export function cleanSessionOrganization(value: unknown): SessionOrganization {
  const result: SessionOrganization = { version: 1, scopes: {} };
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("scopes" in value)) return result;
  const scopes = value.scopes;
  if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) return result;
  for (const [scope, raw] of Object.entries(scopes)) {
    if (!scope || scope.length > 2048 || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    Object.defineProperty(result.scopes, scope, { enumerable: true, configurable: true, writable: true,
      value: { groups: cleanSessionGroups(row.groups), labels: cleanSessionLabels(row.labels) } });
  }
  return result;
}

export function sessionOrganizationCatalog(organization: SessionOrganization | undefined, scope: string, legacyLabels: SessionLabel[]): SessionOrganizationCatalog {
  return organization && Object.hasOwn(organization.scopes, scope)
    ? organization.scopes[scope] : { groups: [], labels: legacyLabels };
}

/** Stable presentation-only partition; never changes the persisted/manual order. */
export function prioritizeRunningSessions<T extends { id: string }>(
  sessions: readonly T[], running: Readonly<Record<string, boolean | undefined>>,
): T[] {
  return [...sessions.filter(session => running[session.id]), ...sessions.filter(session => !running[session.id])];
}

/** Exclusive membership: labels never participate in conversation placement. */
export function groupSessionsByGroup<T extends { id: string }>(sessions: readonly T[], groups: readonly SessionGroup[],
  meta: Readonly<Record<string, { groupId?: string }>>): SidebarSessionGroup<T>[] {
  const buckets = new Map(groups.map(group => [group.id, { group, sessions: [] as T[] }]));
  const ungrouped: SidebarSessionGroup<T> = { group: null, sessions: [] };
  for (const session of sessions) (buckets.get(meta[session.id]?.groupId ?? "") ?? ungrouped).sessions.push(session);
  return [...buckets.values(), ...(ungrouped.sessions.length ? [ungrouped] : [])];
}

export const sessionGroupKey = (scope: string, groupId: string | null) => JSON.stringify([scope, groupId]);
export function visibleGroupedSessionIds(groups: readonly SidebarSessionGroup[], scope: string, collapsed: ReadonlySet<string>): string[] {
  return groups.flatMap(row => collapsed.has(sessionGroupKey(scope, row.group?.id ?? null)) ? [] : row.sessions.map(session => session.id));
}
