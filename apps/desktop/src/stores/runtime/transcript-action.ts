import i18n from "i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { sessionAllows } from "../../lib/remote-session-safety";
import { registerSessionMessageReplacement } from "../../lib/session-transcript-updates";
import { TRANSCRIPT_CONTENT_LIMIT } from "../../lib/transcript-reading";
import type { AppState } from "../app-state";
import type { SessionRuntime } from "./session-runtime";
import type { StoreAccess } from "../slices/types";

/** Load canonical action input only when an explicit action targets old history. */
export async function prepareTranscriptAction(
  { get, set }: StoreAccess,
  runtime: Pick<SessionRuntime, "loadFullSessionMessages" | "cacheSessionTranscript">,
  messageId: string,
  signal?: AbortSignal,
) {
  const state = get();
  const id = state.activeSessionId;
  if (signal?.aborted || !id || state.isRunning) return null;
  const history = state.sessionHistory[id];
  if (!history?.hasMoreBefore && !history?.contentLimited &&
    state.messages.some((message) => message.id === messageId)) return state;
  let messages;
  try {
    // Cache ownership is checked after this asynchronous read, too: a new
    // turn may have already appended a live tail while the read was pending.
    messages = await runtime.loadFullSessionMessages(id, false);
  } catch (error) {
    if (!signal?.aborted && get().activeSessionId === id)
      get().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    return null;
  }
  const current = get();
  if (signal?.aborted || !messages || current.activeSessionId !== id || current.isRunning || current.selectingSessionId ||
    current.messages !== state.messages) return null;
  if (!messages.some((message) => message.id === messageId)) return null;
  runtime.cacheSessionTranscript(id, messages, { messageStart: 0, hasMoreBefore: false });
  set({ messages, sessionHistory: {
    ...current.sessionHistory, [id]: { messageStart: 0, hasMoreBefore: false },
  } });
  return get();
}

function isEditableReply(message: UiMessage) {
  return message.role === "assistant" && !message.parentToolCallId && !message.nestedParentToolCallId &&
    !message.agentName && !message.modelSystem && !message.toolName &&
    (message.status === undefined || message.status === "complete") &&
    !message.error && !message.isError && !message.sessionMessage &&
    !message.attachments?.length && Boolean(message.content.trim());
}

export function getEditableAssistantReply(state: AppState, sessionId: string): UiMessage | undefined {
  if (!sessionId || sessionId.startsWith("native-pi:") || state.activeSessionId !== sessionId ||
    state.selectingSessionId || state.page !== "chat" || state.isRunning || state.runningSessions[sessionId] ||
    state.pendingPlans[sessionId]?.status === "pending" || state.pendingPermissions[sessionId]?.length ||
    state.pendingAsks[sessionId]?.length || state.queuedPrompts[sessionId]?.length) return;
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session || session.source === "pi-native" || session.scheduledRun || session.readOnlyReason ||
    !sessionAllows(session, "canEditMessages")) return;
  const latest = state.messages.findLast((message) => message.role !== "system");
  return latest && isEditableReply(latest) ? latest : undefined;
}

// A display-capped answer may be a preview; the one-row focused read is
// lossless and must not replace the active (or historical reading) window.
const DISPLAY_CLIP_SUFFIX = "\n\n[truncated for display; the full content remains in the transcript]";

function isCappedReply(content: string) {
  return content.length >= TRANSCRIPT_CONTENT_LIMIT && content.endsWith(DISPLAY_CLIP_SUFFIX);
}

function matchesReplySource(displayed: string, canonical: string) {
  return displayed === canonical || (isCappedReply(displayed) &&
    canonical.startsWith(displayed.slice(0, -DISPLAY_CLIP_SUFFIX.length)));
}

function reportReplyEditError(state: AppState, sessionId: string, error?: unknown) {
  if (state.activeSessionId !== sessionId || state.selectingSessionId || state.page !== "chat") return;
  state.showToast(error instanceof Error ? error.message : i18n.t("chat.editReplyUnavailable"), { variant: "error" });
}

export async function prepareAssistantReplyEdit(
  { get }: StoreAccess, sessionId: string, messageId: string, signal: AbortSignal,
): Promise<string | null> {
  const source = getEditableAssistantReply(get(), sessionId);
  if (signal.aborted || source?.id !== messageId) return null;
  if (!isCappedReply(source.content)) return source.content;
  try {
    const detail = await api.getSession(sessionId, {
      messageAround: messageId, messageLimit: 1, contentLimit: TRANSCRIPT_CONTENT_LIMIT,
    });
    if (signal.aborted || getEditableAssistantReply(get(), sessionId) !== source) return null;
    const canonical = detail.session?.messages.find((message) => message.id === messageId);
    if (canonical && isEditableReply(canonical) && matchesReplySource(source.content, canonical.content)) {
      return canonical.content;
    }
    reportReplyEditError(get(), sessionId);
  } catch (error) {
    if (!signal.aborted && getEditableAssistantReply(get(), sessionId) === source) reportReplyEditError(get(), sessionId, error);
  }
  return null;
}

export async function editAssistantReply(
  { get, set }: StoreAccess,
  runtime: SessionRuntime,
  saving: Set<string>,
  ...[sessionId, messageId, expectedContent, content, signal]: Parameters<AppState["editAssistantReply"]>
): Promise<boolean> {
  const source = getEditableAssistantReply(get(), sessionId);
  if (signal?.aborted || saving.has(sessionId) || !content.trim() || content === expectedContent) return false;
  if (source?.id !== messageId || !matchesReplySource(source.content, expectedContent)) {
    reportReplyEditError(get(), sessionId);
    return false;
  }
  saving.add(sessionId);
  try {
    await api.editAssistantReply({ sessionId, messageId, expectedContent, content });
    const current = get();
    const replace = (messages: UiMessage[]) => {
      const index = messages.findIndex((message) => message.id === messageId);
      const message = messages[index];
      if (!message || !isEditableReply(message) || !matchesReplySource(message.content, expectedContent)) return messages;
      const next = messages.slice();
      next[index] = { ...message, content, providerReplay: undefined };
      return registerSessionMessageReplacement(messages, next, index);
    };
    // Patch only the confirmed row in the latest projections. A read/turn
    // started during the write can have added rows or changed the window.
    const active = current.activeSessionId === sessionId;
    const retained = current.retainedTranscripts[sessionId];
    const cached = active ? current.messages : runtime.sessionTranscriptCache.get(sessionId) ?? retained;
    const updated = cached && replace(cached);
    if (updated && updated !== cached) {
      runtime.recordConfirmedReplyEdit(sessionId);
      runtime.cacheSessionTranscript(sessionId, updated);
    }
    const view = current.transcriptViews[sessionId];
    const reading = view && replace(view.messages);
    const updatedRetained = retained && (retained === cached ? updated : replace(retained));
    set({
      ...(active && updated && updated !== cached ? { messages: updated } : {}),
      ...(updatedRetained && updatedRetained !== retained ? { retainedTranscripts: { ...current.retainedTranscripts, [sessionId]: updatedRetained } } : {}),
      ...(view && reading && (reading !== view.messages || (active && updated !== cached)) ? {
        transcriptViews: { ...current.transcriptViews, [sessionId]: { ...view, messages: reading, loading: null } },
      } : {}),
    });
    return true;
  } catch (error) {
    if (!signal?.aborted) reportReplyEditError(get(), sessionId, error);
    return false;
  } finally {
    saving.delete(sessionId);
  }
}
