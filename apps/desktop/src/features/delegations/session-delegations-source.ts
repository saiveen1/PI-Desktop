import type { AgentEventEnvelope, DelegationAttemptHistoryEntry, DelegationRunHistoryEntry, DelegationRunHistoryPage, DelegationRunHistoryQuery } from "@pi-desktop/shared";
import { delegationLifecycleKind, isDelegationStartTool } from "../../lib/tool-display";

export type SessionDelegationsClient = {
  listDelegationHistory: (query: DelegationRunHistoryQuery) => Promise<DelegationRunHistoryPage>;
  onAgentEvent: (listener: (event: AgentEventEnvelope) => void) => () => void;
};
type Snapshot = { entries: readonly DelegationRunHistoryEntry[]; attempts: readonly DelegationAttemptHistoryEntry[]; loading: boolean; loaded: boolean; error: boolean };
const EMPTY: Snapshot = { entries: [], attempts: [], loading: true, loaded: false, error: false };

/** Shared by the session header and index, independent of the chat reading window. */
export function createSessionDelegationsSource(client: SessionDelegationsClient, sessionId: string) {
  let snapshot = EMPTY;
  let references = 0;
  let generation = 0;
  let off: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const calls = new Set<string>();
  const publish = (next: Snapshot) => { snapshot = next; for (const listener of listeners) listener(); };
  const reload = async () => {
    const request = ++generation;
    // Keep the last successful snapshot and any stale-state warning while syncing.
    publish({ ...snapshot, loading: true });
    const entries = new Map<string, DelegationRunHistoryEntry>();
    const attempts = new Map<string, DelegationAttemptHistoryEntry>();
    let offset = 0;
    try {
      for (;;) {
        const page = await client.listDelegationHistory({ sessionId, offset, limit: 100 });
        if (!references || request !== generation) return;
        for (const entry of page.entries) {
          if (entry.sessionId === sessionId) entries.set(entry.messageId, entry);
        }
        for (const attempt of page.attempts ?? []) attempts.set(attempt.messageId, attempt);
        if (page.nextOffset === null) break;
        if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error("Invalid delegation history cursor");
        offset = page.nextOffset;
      }
      publish({ entries: [...entries.values()], attempts: [...attempts.values()], loading: false, loaded: true, error: false });
    } catch {
      if (references && request === generation) publish({ ...snapshot, loading: false, error: true });
    }
  };
  return {
    isRetained: () => references > 0,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reload,
    retain() {
      if (++references === 1) {
        off = client.onAgentEvent(({ sessionId: sourceSessionId, event }) => {
          if (sourceSessionId !== sessionId) return;
          if (event.type === "tool_start") {
            if (isDelegationStartTool(event.toolName) || delegationLifecycleKind(event.toolName)) calls.add(event.toolCallId);
            return;
          }
          if (event.type !== "agent_end" &&
            !(event.type === "message_end" && event.message.role === "tool" && isDelegationStartTool(event.message.toolName)) &&
            !(event.type === "tool_end" && (calls.delete(event.toolCallId) || isDelegationResult(event.result)))) return;
          // Invalidate an in-flight page before its old status can overwrite a terminal event.
          ++generation;
          if (timer !== undefined) return;
          timer = setTimeout(() => { timer = undefined; void reload(); }, 100);
        });
        void reload();
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--references === 0) {
          ++generation;
          off?.(); off = undefined;
          if (timer !== undefined) clearTimeout(timer);
          calls.clear();
          snapshot = EMPTY;
          timer = undefined;
        }
      };
    },
  };
}

const sources = new WeakMap<SessionDelegationsClient, Map<string, ReturnType<typeof createSessionDelegationsSource>>>();
export function sessionDelegationsSource(client: SessionDelegationsClient, sessionId: string) {
  let sessions = sources.get(client);
  // Keep only a small set of inactive sources; released sources retain no reports.
  if (sessions && sessions.size >= 24) {
    for (const [id, existing] of sessions) {
      if (!existing.isRetained() && id !== sessionId) { sessions.delete(id); break; }
    }
  }
  if (!sessions) { sessions = new Map(); sources.set(client, sessions); }
  let source = sessions.get(sessionId);
  if (!source) {
    source = createSessionDelegationsSource(client, sessionId);
    sessions.set(sessionId, source);
  }
  return source;
}

function isDelegationResult(result: unknown): boolean {
  if (!result || typeof result !== "object" || !("details" in result)) return false;
  const details = result.details;
  return Boolean(details && typeof details === "object" &&
    ("delegationId" in details || "delegations" in details || "stopped" in details));
}
