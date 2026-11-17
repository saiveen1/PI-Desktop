import type { SessionSummary } from "@pi-desktop/shared";
import type { AppState } from "../stores/app-state";
import { sessionOrganizationCatalog, sessionOrganizationScope } from "./session-organization";
import { sessionArchived, sessionPinned } from "./sidebar-session-groups";
import { isAutomationSession } from "./session-origin";

export type SessionCreationGroup = { scope: string; id: string | null };

type SessionCreationOrganization = Pick<AppState, "sessionOrganization" | "sessionLabels" | "sessionMeta" | "sidebarProjectGroups">;

export function sessionCreationGroupExists(state: SessionCreationOrganization, group: SessionCreationGroup): boolean {
  return group.id === null || sessionOrganizationCatalog(state.sessionOrganization, group.scope, state.sessionLabels)
    .groups.some(entry => entry.id === group.id);
}

export function sessionMatchesCreationGroup(
  state: SessionCreationOrganization,
  session: SessionSummary,
  group: SessionCreationGroup,
): boolean {
  if (sessionOrganizationScope(session, state.sidebarProjectGroups ?? []) !== group.scope) return false;
  const meta = state.sessionMeta[session.id];
  if (sessionPinned(session, meta) || sessionArchived(session, meta)) return false;
  const id = meta?.groupId ?? null;
  const effectiveId = sessionCreationGroupExists(state, { scope: group.scope, id }) ? id : null;
  return effectiveId === group.id;
}

/**
 * New Task empty-slot reuse (ADR 0113) and first-frame empty reveal (ADR 0154).
 *
 * Host `messageCount` is the durable empty predicate, but the renderer may
 * already know the latest session is no longer empty: a prompt can be
 * streaming, live in the transcript cache, or sitting in the submitted-draft
 * map before `session.list` refreshes. Those in-memory signals replace a
 * blocking list round-trip on New Task.
 */

export const EMPTY_SESSION_WINDOW = {
  messageStart: 0,
  hasMoreBefore: false,
} as const;

export function sessionIsReusableEmpty(
  session: { messageCount: number; worktree?: unknown; scheduledRun?: boolean },
  options: {
    running?: boolean;
    liveMessageCount?: number;
    submitted?: boolean;
    /** The request asks for an isolated session (ADR 0329). */
    isolated?: boolean;
  } = {},
): boolean {
  // An isolated request always gets its own worktree, and an empty isolated
  // session is never handed out for an ordinary request (ADR 0329).
  if (options.isolated === true || session.worktree) return false;
  // Automation transcripts (scheduled runs) are entered only from their
  // task view and must never be reused as an interactive empty slot (#1684).
  if (isAutomationSession(session)) return false;
  if (session.messageCount > 0) return false;
  if (options.running === true) return false;
  if ((options.liveMessageCount ?? 0) > 0) return false;
  if (options.submitted === true) return false;
  return true;
}
