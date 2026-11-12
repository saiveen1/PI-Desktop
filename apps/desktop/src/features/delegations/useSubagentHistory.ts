import { useEffect, useMemo, useRef, useState } from "react";
import type { UiMessage } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { buildSubagentTranscript } from "../../lib/subagent-transcript";
import { EMPTY_TRANSCRIPT, extendTranscriptView, transcriptViewFromSession, TRANSCRIPT_CONTENT_LIMIT, TRANSCRIPT_SEARCH_PAGE_SIZE, type TranscriptView } from "../../lib/transcript-reading";
import { useAppStore } from "../../stores/app-store";
import { useSessionDelegations } from "./useSessionDelegations";
import { preferRecordedTask } from "./session-delegation-tasks";

type ReadState = { view: TranscriptView | null; loading: boolean; error: boolean; failedDirection?: "before" | "after" };
const EMPTY_READ: ReadState = { view: null, loading: false, error: false };

/** Page missing child history locally; never move the parent chat's reading window. */
export function useSubagentHistory(sessionId: string, delegationId: string, visible: UiMessage[], incomplete: boolean) {
  const history = useSessionDelegations(sessionId);
  const live = useAppStore(state => state.activeSessionId === sessionId ? state.messages : state.retainedTranscripts[sessionId] ?? EMPTY_TRANSCRIPT);
  const entry = history.entries.find(item => item.delegationId === delegationId);
  const messageId = entry?.messageId;
  const available = useMemo(() => Boolean(buildSubagentTranscript(live, delegationId) || buildSubagentTranscript(visible, delegationId)), [live, visible, delegationId]);
  const needsRead = Boolean(messageId && (!available || incomplete));
  const [attempt, setAttempt] = useState(0);
  const [read, setRead] = useState<ReadState>(EMPTY_READ);
  const current = useRef(read);
  const generation = useRef(0);
  const publish = (next: ReadState) => { current.current = next; setRead(next); };
  useEffect(() => {
    const request = ++generation.current;
    if (!needsRead || !messageId) { publish(EMPTY_READ); return; }
    publish({ view: null, loading: true, error: false });
    void api.getSession(sessionId, { messageAround: messageId, messageLimit: TRANSCRIPT_SEARCH_PAGE_SIZE, contentLimit: TRANSCRIPT_CONTENT_LIMIT })
      .then(({ session }) => {
        if (request !== generation.current) return;
        if (!session || session.id !== sessionId || !session.messages.some(message => message.id === messageId)) {
          publish({ view: null, loading: false, error: true });
          return;
        }
        publish({ view: transcriptViewFromSession(session), loading: false, error: false });
      }).catch(() => { if (request === generation.current) publish({ view: null, loading: false, error: true }); });
    return () => { ++generation.current; };
  }, [sessionId, messageId, needsRead, attempt]);

  const loadMore = async (direction: "before" | "after") => {
    const previous = current.current;
    const view = previous.view;
    if (!view || previous.loading || !(direction === "before" ? view.hasMoreBefore : view.hasMoreAfter)) return;
    const request = ++generation.current;
    publish({ ...previous, loading: true, error: false, failedDirection: undefined });
    try {
      const { session } = await api.getSession(sessionId, {
        messageBefore: direction === "before" ? view.messageStart : (view.messageEnd ?? 0) + TRANSCRIPT_SEARCH_PAGE_SIZE,
        messageLimit: TRANSCRIPT_SEARCH_PAGE_SIZE, contentLimit: TRANSCRIPT_CONTENT_LIMIT,
      });
      if (request !== generation.current) return;
      if (!session || session.id !== sessionId) throw new Error("Conversation unavailable");
      if (direction === "before" ? session.hasMoreBefore && (session.messageStart ?? 0) >= view.messageStart
        : session.hasMoreAfter && (session.messageEnd ?? 0) <= (view.messageEnd ?? 0)) throw new Error("History cursor did not advance");
      publish({ view: extendTranscriptView(view, session, direction), loading: false, error: false });
    } catch {
      if (request === generation.current) publish({ ...previous, loading: false, error: true, failedDirection: direction });
    }
  };
  const messages = useMemo(() => {
    if (!read.view && visible === live) return visible;
    const merged = new Map((read.view?.messages ?? []).map(message => [message.id, message]));
    for (const message of [...visible, ...live]) merged.set(message.id, preferRecordedTask(merged.get(message.id), message));
    return [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [read.view, visible, live]);
  return { messages, entry, statuses: history.statuses, loading: (!available && history.loading) || read.loading,
    error: (!available && history.error) || read.error,
    hasMoreBefore: read.view?.hasMoreBefore, hasMoreAfter: read.view?.hasMoreAfter, loadMore,
    retry: () => {
      if (current.current.failedDirection) void loadMore(current.current.failedDirection);
      else { void history.reload(); setAttempt(value => value + 1); }
    } };
}
