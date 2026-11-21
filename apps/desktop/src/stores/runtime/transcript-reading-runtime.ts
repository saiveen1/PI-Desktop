import type { SessionDetail } from "@pi-desktop/shared";
import { buildTranscriptEntries } from "../../lib/assistant-turns";
import { getAssistantTurnSummary, messageContentFacts } from "../../lib/transcript-summary";
import type { SessionHistoryReadOptions } from "../../lib/api";
import { isRemoteSession } from "../../lib/remote-session-safety";
import {
  EMPTY_TRANSCRIPT,
  extendTranscriptView,
  TRANSCRIPT_CONTENT_LIMIT,
  TRANSCRIPT_PAGE_SIZE,
  TRANSCRIPT_SEARCH_PAGE_SIZE,
  transcriptViewFromSession,
  transcriptWasRewritten,
  type TranscriptSearchTarget,
  type TranscriptView,
} from "../../lib/transcript-reading";
import type { AppState } from "../app-state";
import type { StoreAccess } from "../slices/types";

type ReadSession = (
  id: string,
  options: SessionHistoryReadOptions,
) => Promise<{ session: SessionDetail | null }>;
type ReadingActions = Pick<
  AppState,
  | "navigateTranscript"
  | "loadTranscriptPage"
  | "returnToLatestTranscript"
  | "prepareReturnToLatestTranscript"
  | "restoreTranscriptReading"
>;

// A deep reading excursion is not an idle cache. Keep small, contiguous
// revisits cheap without retaining an arbitrarily long prefix at the live tail.
const MAX_RETAINED_OLDER_MESSAGES = 2 * TRANSCRIPT_PAGE_SIZE;

/** Read workflows publish renderer views and never write the runtime/model cache. */
export function createTranscriptReadingRuntime({ get, set }: StoreAccess, read: ReadSession) {
  let nextRequestId = 0;

  function currentView(sessionId: string): TranscriptView {
    const state = get();
    return (
      state.transcriptViews[sessionId] ?? {
        messages:
          state.activeSessionId === sessionId
            ? state.messages
            : (state.retainedTranscripts[sessionId] ?? EMPTY_TRANSCRIPT),
        messageStart: state.sessionHistory[sessionId]?.messageStart ?? 0,
        hasMoreBefore: state.sessionHistory[sessionId]?.hasMoreBefore === true,
        hasMoreAfter: false,
        focus: null,
        loading: null,
      }
    );
  }

  function publish(sessionId: string, view: TranscriptView) {
    set((state) => ({ transcriptViews: { ...state.transcriptViews, [sessionId]: view } }));
  }

  function clearTranscriptView(sessionId: string) {
    set((state) => {
      if (!state.transcriptViews[sessionId]) return {};
      const { [sessionId]: _released, ...transcriptViews } = state.transcriptViews;
      return { transcriptViews };
    });
  }

  function returnToLatestTranscript(sessionId: string) {
    const state = get();
    const view = state.transcriptViews[sessionId];
    if (!view) return;
    const live = state.activeSessionId === sessionId
      ? state.messages : (state.retainedTranscripts[sessionId] ?? EMPTY_TRANSCRIPT);
    const olderCount = view.messages.findIndex(row => row.id === live[0]?.id);
    // Never join across an unread gap or invent a cursor by slicing messages:
    // the Host cursor counts physical records, not rendered message identities.
    if (!view.hasMoreAfter && olderCount > 0 && olderCount <= MAX_RETAINED_OLDER_MESSAGES) {
      publish(sessionId, { ...view, focus: null, restored: false, loading: null });
    } else clearTranscriptView(sessionId);
  }

  function prepareReturnToLatestTranscript(sessionId: string): () => void {
    const current = get().transcriptViews[sessionId];
    if (!current) return () => {};
    const prepared: TranscriptView = { ...current, loading: null };
    publish(sessionId, prepared);
    return () => {
      if (get().transcriptViews[sessionId] === prepared) returnToLatestTranscript(sessionId);
    };
  }

  function reportError(sessionId: string, pending: TranscriptView, error: unknown) {
    if (get().transcriptViews[sessionId] !== pending) return;
    publish(sessionId, { ...pending, loading: null });
    if (get().activeSessionId === sessionId)
      get().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
  }

  const actions: ReadingActions = {
    returnToLatestTranscript,
    prepareReturnToLatestTranscript,
    restoreTranscriptReading: async (sessionId, position, signal) => {
      if (signal.aborted || get().activeSessionId !== sessionId) return "superseded";
      if (!position.messageId) return "missing";
      const previous = get().transcriptViews[sessionId];
      const range = currentView(sessionId);
      if (range.focus || range.loading === "target") return "superseded";
      if (range.loading) return "pending";
      if (range.messages.some((message) => message.id === position.messageId)) {
        // Keep the loaded reading range across the selection's bounded revalidation.
        if (get().selectingSessionId === sessionId && !previous?.restored)
          publish(sessionId, { ...range, restored: true });
        return "restored";
      }
      const pending: TranscriptView = { ...range, restored: true, loading: "target" };
      const rollback = () => {
        if (get().transcriptViews[sessionId] !== pending) return;
        if (previous) publish(sessionId, previous);
        else returnToLatestTranscript(sessionId);
      };
      publish(sessionId, pending);
      signal.addEventListener("abort", rollback, { once: true });
      try {
        const { session } = await read(sessionId, {
          messageAround: position.messageId,
          messageLimit: TRANSCRIPT_SEARCH_PAGE_SIZE,
          contentLimit: TRANSCRIPT_CONTENT_LIMIT,
        });
        if (signal.aborted || get().transcriptViews[sessionId] !== pending) return "superseded";
        if (get().activeSessionId !== sessionId) {
          rollback();
          return "superseded";
        }
        const message = session?.messages.find((row) => row.id === position.messageId);
        if (!session || !message || (message.parentToolCallId && !session.navigationParent)) {
          rollback();
          return "missing";
        }
        publish(sessionId, { ...transcriptViewFromSession(session), restored: true });
        return "restored";
      } catch (error) {
        if (signal.aborted || get().transcriptViews[sessionId] !== pending) return "superseded";
        rollback();
        if (get().activeSessionId === sessionId)
          get().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
        return "failed";
      } finally {
        signal.removeEventListener("abort", rollback);
      }
    },
    navigateTranscript: async (input) => {
      const { sessionId } = input;
      if (get().activeSessionId !== sessionId) return;
      const focus: TranscriptSearchTarget = { ...input, requestId: ++nextRequestId };
      const previous: TranscriptView = { ...currentView(sessionId), loading: null };
      const pending: TranscriptView = { ...previous, loading: "target" };
      publish(sessionId, pending);
      try {
        const { session } = await read(sessionId, {
          messageAround: focus.messageId,
          messageLimit: TRANSCRIPT_SEARCH_PAGE_SIZE,
          contentLimit: TRANSCRIPT_CONTENT_LIMIT,
        });
        if (get().transcriptViews[sessionId] !== pending) return;
        if (get().activeSessionId !== sessionId) {
          returnToLatestTranscript(sessionId);
          return;
        }
        const message = session?.messages.find((candidate) => candidate.id === focus.messageId);
        if (!session || !message) throw new Error("Message no longer exists in this conversation.");
        if (message.parentToolCallId && !session.navigationParent)
          throw new Error("The task for this message no longer exists in this conversation.");
        set((state) => ({
          transcriptViews: {
            ...state.transcriptViews,
            [sessionId]: transcriptViewFromSession(session, focus),
          },
        }));
      } catch (error) {
        if (get().transcriptViews[sessionId] !== pending) return;
        publish(sessionId, previous);
        if (get().activeSessionId === sessionId)
          get().showToast(error instanceof Error ? error.message : String(error), {
            variant: "error",
          });
      }
    },
    loadTranscriptPage: async (sessionId, direction, options) => {
      const previous = get().transcriptViews[sessionId];
      const view = currentView(sessionId);
      const remote = isRemoteSession({ id: sessionId });
      // Remote history exposes older-item cursors only; never synthesize a
      // forward cursor by applying local physical-offset arithmetic.
      if (remote && direction === "after") return;
      if (view.loading || !(direction === "before" ? view.hasMoreBefore : view.hasMoreAfter))
        return;
      if (options?.signal?.aborted) return;
      const limit = view.focus ? TRANSCRIPT_SEARCH_PAGE_SIZE : TRANSCRIPT_PAGE_SIZE;
      const pending: TranscriptView = { ...view, loading: options?.revealPrevious ? "target" : direction };
      const restorePrevious = () => {
        if (get().transcriptViews[sessionId] !== pending) return;
        if (previous) publish(sessionId, previous);
        else clearTranscriptView(sessionId);
      };
      publish(sessionId, pending);
      options?.signal?.addEventListener("abort", restorePrevious, { once: true });
      try {
        if (direction === "before" && options?.revealPrevious && !remote && !sessionId.startsWith("native-pi:") &&
          !view.focus && !view.hasMoreAfter && get().activeSessionId === sessionId && !get().runningSessions[sessionId]) {
          const ownsRead = () => {
            if (get().transcriptViews[sessionId] !== pending) return false;
            if (get().activeSessionId === sessionId && !get().runningSessions[sessionId] && !options.signal?.aborted) return true;
            restorePrevious();
            return false;
          };
          const { session: boundary } = await read(sessionId, { messageBefore: view.messageStart,
            messageLimit: limit, contentLimit: TRANSCRIPT_CONTENT_LIMIT, previousUserMessage: true });
          if (!ownsRead()) return;
          const prompt = boundary?.messages.at(-1);
          const end = boundary?.messageEnd;
          if (boundary && prompt?.role === "user" && !prompt.parentToolCallId && !prompt.nestedParentToolCallId &&
            end !== undefined && end > 0 && end <= view.messageStart) {
            const pages = [];
            // Read the gap in bounded pages, then publish it once, in order. The
            // folded work stays expandable and the live answer never disappears.
            for (let cursor = view.messageStart; cursor > end;) {
              const { session: page } = await read(sessionId, { messageBefore: cursor,
                messageLimit: Math.min(limit, cursor - end), contentLimit: TRANSCRIPT_CONTENT_LIMIT });
              if (!ownsRead()) return;
              if (!page || page.messageEnd !== cursor || page.messageStart === undefined ||
                page.messageStart < end || page.messageStart >= cursor) throw new Error("Conversation history is no longer contiguous.");
              pages.push(page.messages);
              cursor = page.messageStart;
            }
            const earlier = buildTranscriptEntries(boundary.messages.slice(0, -1)).entries.findLast((entry) =>
              entry.kind === "assistant-turn" || (entry.kind === "message" && entry.message.role === "user"));
            const reply = earlier?.kind === "assistant-turn" ? getAssistantTurnSummary(earlier).responses.findLast(({ message }) =>
              !message.error && messageContentFacts(message).hasContent)?.message : undefined;
            publish(sessionId, extendTranscriptView(pending, {
              ...boundary, messages: [...boundary.messages, ...pages.reverse().flat()], messageEnd: view.messageStart,
            }, "before"));
            options.revealPrevious(reply?.id ?? prompt.id);
            return;
          }
        }
        const { session } = await read(sessionId, {
          messageBefore:
            direction === "before" ? view.messageStart : (view.messageEnd ?? 0) + limit,
          messageLimit: limit,
          contentLimit: TRANSCRIPT_CONTENT_LIMIT,
        });
        if (get().transcriptViews[sessionId] !== pending) return;
        if (options?.signal?.aborted) { restorePrevious(); return; }
        if (!session) throw new Error("Conversation no longer exists.");
        const extended = extendTranscriptView(pending, session, direction);
        // Remote numeric values represent opaque Host item cursors. Preserve
        // the returned cursor rather than depending on its ordering. Local
        // transcripts continue merging physical message offsets unchanged.
        publish(sessionId, remote ? {
          ...extended,
          messageStart: session.messageStart ?? 0,
          messageEnd: undefined,
          hasMoreAfter: false,
        } : extended);
      } catch (error) {
        if (options?.signal?.aborted) {
          restorePrevious();
          return;
        }
        reportError(sessionId, pending, error);
      } finally {
        options?.signal?.removeEventListener("abort", restorePrevious);
      }
    },
  };

  /** One lifecycle boundary for pane eviction, new turns, and authoritative edits. */
  function reconcile(state: AppState, previous: AppState) {
    for (const [id, view] of Object.entries(state.transcriptViews)) {
      const evicted = !state.retainedSessionIds.includes(id);
      const started =
        (view.focus || view.restored || view.loading === "target") &&
        state.runningSessions[id] &&
        !previous.runningSessions[id];
      const rewritten =
        // An in-place edit updates the loaded window atomically with the tail.
        state.transcriptViews[id] === previous.transcriptViews[id] &&
        state.activeSessionId === id &&
        previous.activeSessionId === id &&
        !state.runningSessions[id] &&
        !previous.runningSessions[id] &&
        previous.selectingSessionId !== id &&
        state.messages !== previous.messages &&
        transcriptWasRewritten(previous.messages, state.messages);
      if (evicted || rewritten) clearTranscriptView(id);
      else if (started) returnToLatestTranscript(id);
    }
  }

  return { actions, reconcile };
}
