import type { StoreAccess } from "./types";
import type { AppState } from "../app-state";
import { cleanSessionFilter, cleanSessionLabels, labelIds, sessionColor, type SessionColor, type SessionFilter, type SessionLabel } from "../../lib/session-labels";
import { activityOrder, orderedSessionMeta, reorderSession } from "../../lib/session-activity-order";

export type SessionManagementState = {
  sessionLabels: SessionLabel[];
  sessionFilter: SessionFilter;
  setSessionLabels: (labels: SessionLabel[]) => void;
  setSessionFilter: (filter: SessionFilter) => void;
  markSession: (id: string, patch: { labelIds?: string[]; color?: SessionColor | null }) => void;
  ensureSessionOrder: () => void;
  raiseSession: (id: string) => void;
  reorderSession: (id: string, targetId: string, after?: boolean) => void;
};
export function createSessionManagementSlice({ get, set, persist }: StoreAccess & {
  persist: (get: () => AppState) => void;
}): Pick<SessionManagementState, "setSessionLabels" | "setSessionFilter" | "markSession" | "ensureSessionOrder" | "raiseSession" | "reorderSession"> {
  return {
    setSessionLabels: (input) => {
      const labels = cleanSessionLabels(input);
      const ids = new Set(labels.map(row => row.id));
      set(state => ({
        sessionLabels: labels,
        sessionMeta: Object.fromEntries(Object.entries(state.sessionMeta).map(([id, meta]) =>
          [id, meta.labelIds ? { ...meta, labelIds: meta.labelIds.filter(key => ids.has(key)) } : meta])),
        sessionFilter: { ...state.sessionFilter, labelIds: state.sessionFilter.labelIds.filter(id => ids.has(id)) },
      }));
      persist(get);
    },
    setSessionFilter: (filter) => { set({ sessionFilter: cleanSessionFilter(filter) }); persist(get); },
    markSession: (id, patch) => {
      const state = get();
      if (!state.sessions.some(row => row.id === id)) return;
      const next = { ...state.sessionMeta[id] };
      if (patch.labelIds !== undefined) next.labelIds = labelIds(patch.labelIds).filter(key => state.sessionLabels.some(row => row.id === key));
      if (patch.color !== undefined) {
        const color = sessionColor(patch.color);
        if (color) next.color = color; else delete next.color;
      }
      set({ sessionMeta: { ...state.sessionMeta, [id]: next } });
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
      const sessionMeta = reorderSession(state.sessions, state.sessionMeta, id, targetId, after);
      if (!sessionMeta) return;
      set({ sessionMeta, sessionView: { ...state.sessionView, sort: "recent", sortBy: "recent" } });
      persist(get);
    },
  };
}
