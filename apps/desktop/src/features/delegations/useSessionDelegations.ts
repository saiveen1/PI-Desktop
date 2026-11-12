import { useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "../../lib/api";
import { EMPTY_TRANSCRIPT } from "../../lib/transcript-reading";
import { useAppStore } from "../../stores/app-store";
import { sessionDelegationsSource } from "./session-delegations-source";
import { sessionDelegationTasks } from "./session-delegation-tasks";

export function useSessionDelegations(sessionId: string) {
  const source = useMemo(() => sessionDelegationsSource(api, sessionId), [sessionId]);
  const history = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  useEffect(() => source.retain(), [source]);
  const messages = useAppStore(state => state.activeSessionId === sessionId
    ? state.messages : state.retainedTranscripts[sessionId] ?? EMPTY_TRANSCRIPT);
  const running = useAppStore(state => state.runningSessions[sessionId] === true);
  const projection = useMemo(() => sessionDelegationTasks(sessionId, history.entries, messages, running),
    [sessionId, history.entries, messages, running]);
  return { ...history, ...projection, reload: source.reload };
}
