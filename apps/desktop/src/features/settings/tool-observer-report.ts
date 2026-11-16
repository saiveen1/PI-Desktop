import type { ToolObservationQuery, ToolObservationReport } from "@pi-desktop/shared";

export const TOOL_OBSERVER_OUTCOMES = [
  "success", "command_nonzero", "tool_error", "timeout", "cancelled",
  "interrupted", "background_started", "unknown",
] as const;

export type ToolObserverState = {
  scope: string;
  status: "loading" | "ready" | "error";
  report: ToolObservationReport | null;
  selectedId: string;
};

export type ToolObserverAction =
  | { type: "loading"; scope: string }
  | { type: "loaded"; scope: string; report: ToolObservationReport }
  | { type: "error"; scope: string }
  | { type: "select"; scope: string; id: string };

export function initialToolObserverState(scope: string): ToolObserverState {
  return { scope, status: "loading", report: null, selectedId: "" };
}

export function toolObserverReducer(state: ToolObserverState, action: ToolObserverAction): ToolObserverState {
  if (action.type === "loading") return initialToolObserverState(action.scope);
  if (action.scope !== state.scope) return state;
  if (action.type === "loaded") {
    return { ...state, status: "ready", report: action.report, selectedId: "" };
  }
  if (action.type === "error") return { ...state, status: "error", report: null, selectedId: "" };
  if (!state.report?.groups.some((group) => group.id === action.id && group.outcome !== "success")) return state;
  return { ...state, selectedId: action.id };
}

/** Disposing a read also suppresses late failures; there is no background retry. */
export function readToolObserverReport(
  load: (query: ToolObservationQuery) => Promise<ToolObservationReport>,
  query: ToolObservationQuery,
  scope: string,
  dispatch: (action: ToolObserverAction) => void,
): () => void {
  let disposed = false;
  dispatch({ type: "loading", scope });
  void Promise.resolve().then(() => disposed ? undefined : load(query)).then((report) => {
    if (!disposed && report) dispatch({ type: "loaded", scope, report });
  }).catch(() => {
    if (!disposed) dispatch({ type: "error", scope });
  });
  return () => { disposed = true; };
}
