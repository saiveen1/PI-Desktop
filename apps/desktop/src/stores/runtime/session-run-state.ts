import { clearSessionAsks, dropSessionAskDrafts } from "../../lib/pending-asks";
import { clearSessionPermissions } from "../../lib/pending-permissions";
import type { AppState } from "../app-state";

/** Clear live UI ownership without inferring a durable turn outcome. */
export function idleSessionRun(state: AppState, sessionId: string): Pick<
  AppState,
  | "isRunning"
  | "runningSessions"
  | "agentStatuses"
  | "pendingPermissions"
  | "pendingAsks"
  | "askDrafts"
> {
  const agentStatuses = { ...state.agentStatuses };
  delete agentStatuses[sessionId];
  return {
    isRunning: state.activeSessionId === sessionId ? false : state.isRunning,
    runningSessions: { ...state.runningSessions, [sessionId]: false },
    agentStatuses,
    pendingPermissions: clearSessionPermissions(state.pendingPermissions, sessionId),
    pendingAsks: clearSessionAsks(state.pendingAsks, sessionId),
    askDrafts: dropSessionAskDrafts(state.askDrafts, state.pendingAsks, sessionId),
  };
}
