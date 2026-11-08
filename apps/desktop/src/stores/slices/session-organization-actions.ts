import type { ProjectGroupRecord } from "@pi-desktop/shared";
import type { AppState } from "../app-state";
import type { StoreAccess } from "./types";
import { cleanSessionGroups, sessionOrganizationCatalog, sessionOrganizationScope,
  type SessionGroup, type SessionOrganization } from "../../lib/session-organization";
import { cleanSessionLabels, type SessionLabel } from "../../lib/session-labels";

export type SessionOrganizationState = {
  sessionOrganization: SessionOrganization;
  sidebarProjectGroups: ProjectGroupRecord[];
  setSidebarProjectGroups: (projects: ProjectGroupRecord[]) => void;
  setSessionGroups: (scope: string, groups: SessionGroup[]) => void;
  setProjectSessionLabels: (scope: string, labels: SessionLabel[]) => void;
  moveSessionToGroup: (id: string, groupId: string | null) => void;
};


export function createSessionOrganizationActions({ get, set, persist }: StoreAccess & {
  persist: (get: () => AppState) => void;
}): Pick<SessionOrganizationState, "setSidebarProjectGroups" | "setSessionGroups" | "setProjectSessionLabels" | "moveSessionToGroup"> {
  const updateCatalog = (scope: string, patch: { groups?: SessionGroup[]; labels?: SessionLabel[] }) => {
    if (!scope || scope.length > 2048) return;
    const state = get();
    const catalog = { ...sessionOrganizationCatalog(state.sessionOrganization, scope, state.sessionLabels), ...patch };
    const groupIds = new Set(catalog.groups.map(row => row.id));
    const knownLabels = new Set(catalog.labels.map(row => row.id));
    const sessionMeta = { ...state.sessionMeta };
    const scopes = new Map(state.sessions.map(session => [session.id, sessionOrganizationScope(session, state.sidebarProjectGroups ?? [])]));
    for (const [id, meta] of Object.entries(sessionMeta)) {
      if ((scopes.get(id) ?? meta.organizationScope) !== scope) continue;
      const next = { ...meta, organizationScope: scope };
      if (patch.groups && next.groupId && !groupIds.has(next.groupId)) delete next.groupId;
      if (patch.labels && next.labelIds) next.labelIds = next.labelIds.filter(key => knownLabels.has(key));
      sessionMeta[id] = next;
    }
    set({ sessionOrganization: { version: 1, scopes: { ...state.sessionOrganization?.scopes, [scope]: catalog } }, sessionMeta });
    persist(get);
  };
  return {
    setSidebarProjectGroups: sidebarProjectGroups => set({ sidebarProjectGroups }),
    setSessionGroups: (scope, groups) => updateCatalog(scope, { groups: cleanSessionGroups(groups) }),
    setProjectSessionLabels: (scope, labels) => updateCatalog(scope, { labels: cleanSessionLabels(labels) }),
    moveSessionToGroup: (id, groupId) => {
      const state = get();
      const session = state.sessions.find(row => row.id === id);
      if (!session) return;
      const scope = sessionOrganizationScope(session, state.sidebarProjectGroups ?? []);
      const catalog = sessionOrganizationCatalog(state.sessionOrganization, scope, state.sessionLabels);
      if (groupId !== null && !catalog.groups.some(group => group.id === groupId)) return;
      const next = { ...state.sessionMeta[id], organizationScope: scope };
      if (groupId === null) delete next.groupId; else next.groupId = groupId;
      set({ sessionMeta: { ...state.sessionMeta, [id]: next } });
      persist(get);
    },
  };
}
