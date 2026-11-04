import i18n from "i18next";
import { useAppStore } from "../../stores/app-store";
import { sessionArchived, normalizeProjectPath } from "../../lib/sidebar-session-groups";
import { isRemoteSession } from "../../lib/remote-session-safety";
import type { SessionSummary } from "@pi-desktop/shared";

export type SessionOrganizationAction = "archive" | "unarchive" | "trash";

export function canTrashSession(session: SessionSummary) {
  return session.source !== "pi-native" && !isRemoteSession(session);
}

/** One batch uses a fixed identity snapshot; failures never discard other selections. */
export async function organizeSessions(ids: readonly string[], action: SessionOrganizationAction) {
  const initial = useAppStore.getState();
  const active = initial.sessions.find((session) => session.id === initial.activeSessionId);
  const completed: string[] = [];
  const failures: { id: string; title: string; error: unknown }[] = [];
  for (const id of new Set(ids)) {
    const state = useAppStore.getState();
    const session = state.sessions.find((item) => item.id === id);
    if (!session) continue;
    try {
      if (action === "trash") {
        if (!canTrashSession(session)) throw new Error(i18n.t("sessionOrganization.unsupported"));
        if (state.runningSessions[id]) throw new Error(i18n.t("sessionOrganization.running"));
        await state.trashSession(id);
      } else if (action === "archive") {
        state.archiveSession(id);
      } else {
        state.restoreSession(id);
      }
      completed.push(id);
    } catch (error) {
      failures.push({ id, title: session.title, error });
    }
  }

  if (active && completed.includes(active.id) && action !== "unarchive") {
    const current = useAppStore.getState();
    const stillOwnsView = current.page === initial.page
      && current.activeProjectPath === initial.activeProjectPath
      && !current.selectingSessionId
      && (action === "trash" ? !current.activeSessionId : current.activeSessionId === active.id);
    if (stillOwnsView) {
      const candidates = current.sessions.filter((session) => !sessionArchived(session, current.sessionMeta[session.id]));
      const next = candidates.find((session) => normalizeProjectPath(session.projectPath) === normalizeProjectPath(active.projectPath))
        ?? candidates[0];
      try {
        if (next) await current.selectSession(next.id);
        else await current.newSession({ projectPath: active.projectPath ?? null });
      } catch (error) {
        // A failed replacement must not leave an archived conversation active.
        if (action === "archive" && useAppStore.getState().activeSessionId === active.id) {
          current.restoreSession(active.id);
          completed.splice(completed.indexOf(active.id), 1);
        }
        failures.push({ id: active.id, title: active.title, error });
      }
    }
  }
  return { completed, failures };
}
