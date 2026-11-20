import { isConfigureSessionPersonaRequest, trustedExtensionAgentKeyFromProviderId, type DelegationRunHistoryEntry, type SessionSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { approvalIsLive, delegationApprovalState } from "../../lib/delegation-approval-state";
import { isActivePlanExecution } from "../../lib/plan-mode-state";
import { isRemoteSession, sessionAllows } from "../../lib/remote-session-safety";
import { sessionDelegationsSource } from "../../features/delegations/session-delegations-source";
import { openModeRun } from "../../features/modes/modes-store";
import type { AppState } from "../app-state";
import type { StoreAccess } from "../slices/types";

export function isExtensionPersonaProvider(providerId?: string): boolean {
  return Boolean(providerId && trustedExtensionAgentKeyFromProviderId(providerId));
}

export function sessionSupportsPersona(session: SessionSummary, defaultProviderId?: string): boolean {
  return !isRemoteSession(session) && !session.remoteWorkspace && !session.id.startsWith("native-pi:") &&
    !session.scheduledRun && (!session.source || session.source === "desktop") &&
    sessionAllows(session, "canConfigureModel") && !isExtensionPersonaProvider(session.providerId ?? defaultProviderId);
}

export function personaStoreBlock(state: AppState, id?: string) {
  if (state.selectingSessionId) return "loading";
  if (!id) return state.personaDraftCreationIntent !== undefined ? "loading" : undefined;
  if (state.personaWrites?.[id]) return "saving";
  if (state.pendingPlans[id]?.status === "pending" || state.planningStates?.[id] === "awaiting_approval" ||
      state.pendingPermissions?.[id]?.length || state.pendingAsks?.[id]?.length) return "approval";
  if (state.runningSessions[id] || (state.activeSessionId === id && state.isRunning) ||
      state.agentStatuses?.[id]?.isRunning || isActivePlanExecution(state.planCheckpoints?.[id])) return "running";
}

export function hasRunningPersonaChild(entries: readonly DelegationRunHistoryEntry[]): boolean {
  // Transcript presentation can mark a child aborted once the parent ends.
  // The live history state is the relevant signal for the edit guard.
  return entries.some((entry) => entry.status === "running");
}

export function createConfigureActivePersona({ get, set }: StoreAccess): AppState["configureActivePersona"] {
  return async (change, { sessionId, projectPath }) => {
    const state = get();
    if (state.page !== "chat" || state.activeSessionId !== sessionId ||
        (sessionId === undefined && state.activeProjectPath !== projectPath) ||
        personaStoreBlock(state, sessionId)) return;
    const request = { ...change, id: sessionId ?? "draft" };
    if (!isConfigureSessionPersonaRequest(request)) return;
    const catalog = state.settings?.personas ?? [];
    if (change.personaId && !catalog.some((item) => item.id === change.personaId)) return;
    if (!sessionId) {
      const previous = state.draftConfiguration;
      if (isExtensionPersonaProvider(previous?.providerId ?? state.settings?.defaultProviderId)) return;
      const personaId = change.personaId !== undefined ? change.personaId : previous?.personaId;
      if (change.personaId === undefined && !catalog.some((item) => item.id === personaId)) return;
      set({ draftConfiguration: { ...previous, personaId, inheritToSubagents: Boolean(personaId) &&
        (change.inheritToSubagents ?? previous?.inheritToSubagents ?? false) } });
      return;
    }
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session || !sessionSupportsPersona(session, state.settings?.defaultProviderId) || openModeRun(sessionId) ||
        (change.personaId === undefined && !session.persona)) return;
    if (delegationApprovalState(api).getSnapshot().requests.some((row) =>
      row.sessionId === sessionId && approvalIsLive(row, Date.now()))) return;
    if (hasRunningPersonaChild(sessionDelegationsSource(api, sessionId).getSnapshot().entries)) return;
    set({ personaWrites: { ...state.personaWrites, [sessionId]: true } });
    try {
      const { session: saved } = await api.configureSessionPersona(request);
      if (saved.id !== sessionId || (change.personaId === null ? saved.persona != null
        : !saved.persona || (change.personaId && saved.persona.definition.id !== change.personaId))) {
        throw new Error("Session persona response does not match the requested selection");
      }
      // The write belongs to its original row even if navigation moved elsewhere.
      // Merge only the changed field; a concurrent title/model update still wins.
      set((current) => ({ sessions: current.sessions.map((row) => row.id === sessionId
        ? { ...row, persona: saved.persona ?? null } : row) }));
    } finally {
      set((current) => {
        const personaWrites = { ...current.personaWrites };
        delete personaWrites[sessionId];
        return { personaWrites };
      });
    }
  };
}
