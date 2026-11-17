import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionDetail, UiMessage } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { buildSubagentTranscript } from "../../lib/subagent-transcript";
import { EMPTY_TRANSCRIPT, transcriptViewFromSession, TRANSCRIPT_CONTENT_LIMIT, TRANSCRIPT_SEARCH_PAGE_SIZE, type TranscriptView } from "../../lib/transcript-reading";
import { useAppStore } from "../../stores/app-store";
import { useSessionDelegations } from "./useSessionDelegations";
import { findSubagentHistoryPage, mergeSubagentHistory, subagentHistoryAddsContent } from "./subagent-history";

type ReadState = {
  view: TranscriptView | null;
  before: TranscriptView | null;
  after: TranscriptView | null;
  loading: boolean;
  error: boolean;
};
const EMPTY_READ: ReadState = { view: null, before: null, after: null, loading: false, error: false };

/** Page missing child history locally; never move the parent chat's reading window. */
export function useSubagentHistory(sessionId: string, delegationId: string, visible: UiMessage[], incomplete: boolean) {
  const history = useSessionDelegations(sessionId);
  const live = useAppStore(state => state.activeSessionId === sessionId ? state.messages : state.retainedTranscripts[sessionId] ?? EMPTY_TRANSCRIPT);
  const entry = history.entries.find(item => item.delegationId === delegationId);
  const messageId = entry?.messageId;
  const available = useMemo(() => Boolean(buildSubagentTranscript(live, delegationId) || buildSubagentTranscript(visible, delegationId)), [live, visible, delegationId]);
  const needsRead = Boolean(messageId && (!available || incomplete));
  const [attempt, setAttempt] = useState(0);
  const [probeAttempt, setProbeAttempt] = useState(0);
  const [read, setRead] = useState<ReadState>(EMPTY_READ);
  const current = useRef(read);
  const pages = useRef(new Map<number, Promise<SessionDetail | undefined>>());
  const publish = (next: ReadState) => { current.current = next; setRead(next); };
  useEffect(() => {
    let active = true;
    pages.current = new Map();
    if (!needsRead || !messageId) { publish(EMPTY_READ); return; }
    publish({ ...EMPTY_READ, loading: true });
    void api.getSession(sessionId, { messageAround: messageId, messageLimit: TRANSCRIPT_SEARCH_PAGE_SIZE, contentLimit: TRANSCRIPT_CONTENT_LIMIT })
      .then(({ session }) => {
        if (!active) return;
        if (!session || session.id !== sessionId || !session.messages.some(message => message.id === messageId)) {
          publish({ ...EMPTY_READ, error: true });
          return;
        }
        publish({ ...EMPTY_READ, view: transcriptViewFromSession(session), loading: true });
      }).catch(() => { if (active) publish({ ...EMPTY_READ, error: true }); });
    return () => { active = false; };
  }, [sessionId, messageId, needsRead, attempt]);

  const messages = useMemo(() => !read.view && visible === live ? visible
    : mergeSubagentHistory(read.view?.messages ?? [], visible, live), [read.view, visible, live]);
  const known = useRef(messages);
  known.current = messages;
  const hasMoreBefore = Boolean(read.before && subagentHistoryAddsContent(messages, mergeSubagentHistory(read.before.messages, messages), delegationId));
  const hasMoreAfter = Boolean(read.after && subagentHistoryAddsContent(messages, mergeSubagentHistory(read.after.messages, messages), delegationId));
  const obsolete = Boolean((read.before && !hasMoreBefore) || (read.after && !hasMoreAfter));
  useEffect(() => {
    // Live output can satisfy a prepared page before the user clicks it.
    if (obsolete) setProbeAttempt(value => value + 1);
  }, [obsolete]);

  useEffect(() => {
    const view = read.view;
    if (!view || !needsRead) return;
    let active = true;
    const cache = pages.current;
    publish({ view, before: null, after: null, loading: true, error: false });
    const readPage = (before: number) => {
      let page = cache.get(before);
      if (!page) {
        page = api.getSession(sessionId, { messageBefore: before, messageLimit: TRANSCRIPT_SEARCH_PAGE_SIZE, contentLimit: TRANSCRIPT_CONTENT_LIMIT })
          .then(({ session }) => {
            if (!session || session.id !== sessionId) throw new Error("Conversation unavailable");
            // Keep Task/lifecycle and attributed child rows, not unrelated parent prose.
            return { ...session, messages: session.messages.filter(message => message.role === "tool" || message.parentToolCallId) };
          });
        cache.set(before, page);
      }
      return page;
    };
    const find = (direction: "before" | "after") => findSubagentHistoryPage({
      view, direction, delegationId, knownMessages: () => known.current, readPage, isCurrent: () => active,
    });
    void Promise.all([find("before"), find("after")]).then(([before, after]) => {
      if (active) publish({ view, before, after, loading: false, error: false });
    }).catch(() => {
      if (active) {
        active = false;
        cache.clear();
        publish({ view, before: null, after: null, loading: false, error: true });
      }
    });
    return () => { active = false; };
  }, [read.view, sessionId, delegationId, needsRead, probeAttempt]);

  const loadMore = (direction: "before" | "after") => {
    const previous = current.current;
    const candidate = previous[direction];
    if (previous.loading || !candidate) return;
    if (!subagentHistoryAddsContent(known.current, mergeSubagentHistory(candidate.messages, known.current), delegationId)) {
      setProbeAttempt(value => value + 1);
      return;
    }
    publish({ ...EMPTY_READ, view: candidate, loading: true });
  };
  return { messages, entry, statuses: history.statuses, loading: (!available && history.loading) || read.loading,
    error: (!available && history.error) || read.error,
    hasMoreBefore, hasMoreAfter, loadMore,
    retry: () => {
      if (current.current.view) setProbeAttempt(value => value + 1);
      else { void history.reload(); setAttempt(value => value + 1); }
    } };
}
