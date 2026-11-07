import type { SessionSummary } from "@pi-desktop/shared";
import type { SessionMeta } from "./sidebar-preferences";
import { normalizeProjectPath } from "./sidebar-preferences.ts";

export function activityOrder(sessions: readonly SessionSummary[], meta: Record<string, SessionMeta>): string[] {
  return [...sessions].sort((a, b) => {
    const left = meta[a.id]?.order;
    const right = meta[b.id]?.order;
    if (left !== undefined && right !== undefined) return left - right || a.id.localeCompare(b.id);
    if (left !== undefined) return 1;
    if (right !== undefined) return -1;
    return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
  }).map(row => row.id);
}
export function orderedSessionMeta(order: readonly string[], meta: Record<string, SessionMeta>): Record<string, SessionMeta> {
  const next = { ...meta };
  order.forEach((id, index) => { next[id] = { ...meta[id], order: index }; });
  return next;
}
export function reorderSession(sessions: readonly SessionSummary[], meta: Record<string, SessionMeta>,
  id: string, targetId: string, after = false): Record<string, SessionMeta> | undefined {
  const source = sessions.find(row => row.id === id);
  const target = sessions.find(row => row.id === targetId);
  if (!source || !target || id === targetId || meta[id]?.pinned || meta[targetId]?.pinned ||
    Boolean(meta[id]?.archived) !== Boolean(meta[targetId]?.archived) ||
    normalizeProjectPath(source.projectPath) !== normalizeProjectPath(target.projectPath)) return undefined;
  const order = activityOrder(sessions, meta).filter(key => key !== id);
  order.splice(order.indexOf(targetId) + Number(after), 0, id);
  return orderedSessionMeta(order, meta);
}
