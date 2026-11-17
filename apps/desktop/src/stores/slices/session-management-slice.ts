import type { StoreAccess } from "./types";
import type { AppState } from "../app-state";
import { labelIds, sessionColor, type SessionColor, type SessionFilter, type SessionLabel } from "../../lib/session-labels";
import { activityOrder, orderedSessionMeta, reorderSession } from "../../lib/session-activity-order";
import { sessionOrganizationCatalog, sessionOrganizationScope } from "../../lib/session-organization";
import { createSessionOrganizationActions, type SessionOrganizationState } from "./session-organization-actions";

export type SessionManagementState = SessionOrganizationState & {
  sessionLabels: SessionLabel[];
  sessionFilter: SessionFilter;
  markSession: (id: string, patch: { labelIds?: string[]; color?: SessionColor | null }) => void;
  setSessionUnread: (id: string, unread: boolean) => void;
  ensureSessionOrder: () => void;
  raiseSession: (id: string) => void;
  reorderSession: (id: string, targetId: string, after?: boolean) => void;
};
export function createSessionManagementSlice({ get, set, persist }: StoreAccess & {
  persist: (get: () => AppState) => void;
}): Omit<SessionManagementState, "sessionLabels" | "sessionFilter" | "sessionOrganization" | "sidebarProjectGroups"> {
  return {
    ...createSessionOrganizationActions({ get, set, persist }),
    markSession: (id, patch) => {
      const state = get();
      const session = state.sessions.find(row => row.id === id);
      if (!session) return;
      const scope = sessionOrganizationScope(session, state.sidebarProjectGroups ?? []);
      const catalog = sessionOrganizationCatalog(state.sessionOrganization, scope, state.sessionLabels);
      const next = { ...state.sessionMeta[id], organizationScope: scope };
      if (patch.labelIds !== undefined) next.labelIds = labelIds(patch.labelIds).filter(key => catalog.labels.some(row => row.id === key));
      if (patch.color !== undefined) {
        const color = sessionColor(patch.color);
        if (color) next.color = color; else delete next.color;
      }
      set({ sessionMeta: { ...state.sessionMeta, [id]: next } });
      persist(get);
    },
    setSessionUnread: (id, unread) => {
      const { sessionMeta, sessions } = get();
      const current = sessionMeta[id];
      if (Boolean(current?.unread) === unread || (unread && !sessions.some(row => row.id === id))) return;
      const next = { ...current };
      if (unread) next.unread = true; else delete next.unread;
      const updated = { ...sessionMeta };
      if (Object.keys(next).length) updated[id] = next; else delete updated[id];
      set({ sessionMeta: updated });
      persist(get);
    },
    ensureSessionOrder: () => {
      const state = get();
      if (!state.sessions.some(row => state.sessionMeta[row.id]?.order === undefined)) return;
      set({ sessionMeta: orderedSessionMeta(activityOrder(state.sessions, state.sessionMeta), state.sessionMeta) });
      persist(get);
    },
    raiseSession: (id) => {
      get().ensureSessionOrder();
      const state = get();
      if (!state.sessions.some(row => row.id === id) || state.sessionMeta[id]?.pinned || state.sessionMeta[id]?.archived) return;
      const order = activityOrder(state.sessions, state.sessionMeta).filter(key => key !== id);
      set({ sessionMeta: orderedSessionMeta([id, ...order], state.sessionMeta) });
      persist(get);
    },
    reorderSession: (id, targetId, after) => {
      const state = get();
      const sessionMeta = reorderSession(state.sessions, state.sessionMeta, id, targetId, after, state.sidebarProjectGroups ?? []);
      if (!sessionMeta) return;
      set({ sessionMeta, sessionView: { ...state.sessionView, sort: "recent", sortBy: "recent" } });
      persist(get);
    },
  };
}
