import i18n from "i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { sessionAllows } from "../../lib/remote-session-safety";
import { getSessionMessageSnapshot, registerSessionMessageReplacements } from "../../lib/session-transcript-updates";
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
  ...[sessionId, messageId, expectedContent, content, signal, thinkingContext]: Parameters<AppState["editAssistantReply"]>
): Promise<boolean> {
  const source = getEditableAssistantReply(get(), sessionId);
  const bodyChanged = content !== expectedContent;
  if (signal?.aborted || saving.has(sessionId) || !content.trim() || (!bodyChanged && thinkingContext === undefined)) return false;
  if (source?.id !== messageId || !matchesReplySource(source.content, expectedContent)) {
    reportReplyEditError(get(), sessionId);
    return false;
  }
  saving.add(sessionId);
  try {
    const { thinkingContextUpdates } = await api.editAssistantReply({
      sessionId, messageId, expectedContent, content,
      ...(thinkingContext === undefined ? {} : { thinkingContext }),
    });
    if (thinkingContext !== undefined && !Array.isArray(thinkingContextUpdates)) {
      throw new Error(i18n.t("chat.editReplyThinkingContext.unconfirmed"));
    }
    const flags = new Map(thinkingContextUpdates?.map((update) => [update.messageId, update.excludeThinkingFromContext]));
    if (!bodyChanged && !flags.size) return true;
    const changedIds = new Set(flags.keys());
    if (bodyChanged) changedIds.add(messageId);
    patchConfirmedTranscriptEdit({ get, set }, runtime, sessionId, changedIds, (message) => {
      const body = bodyChanged && message.id === messageId && isEditableReply(message) &&
        matchesReplySource(message.content, expectedContent);
      const flag = flags.get(message.id);
      if (!body && (flag === undefined || flag === message.excludeThinkingFromContext)) return message;
      return {
        ...message,
        ...(body ? { content, providerReplay: undefined } : {}),
        ...(flag === undefined ? {} : { excludeThinkingFromContext: flag }),
      };
    });
    return true;
  } catch (error) {
    if (!signal?.aborted) reportReplyEditError(get(), sessionId, error);
    return false;
  } finally {
    saving.delete(sessionId);
  }
}

export async function editTurnContext(
  store: StoreAccess,
  runtime: SessionRuntime,
  saving: Set<string>,
  ...[input, signal]: Parameters<AppState["editTurnContext"]>
): Promise<boolean> {
  const { sessionId, anchorMessageId } = input;
  if (signal.aborted || saving.has(sessionId) || getEditableAssistantReply(store.get(), sessionId)?.id !== anchorMessageId) return false;
  saving.add(sessionId);
  try {
    const { updates } = await api.editTurnContext(input);
    const confirmed = new Map(updates.map((update) => [update.messageId, update]));
    if (confirmed.size) patchConfirmedTranscriptEdit(store, runtime, sessionId, confirmed.keys(), (message) => {
      const update = confirmed.get(message.id);
      if (!update) return message;
      const { contextOverride, excludeThinkingFromContext } = update;
      return {
        ...message,
        contextOverride: contextOverride ?? undefined,
        ...(excludeThinkingFromContext === undefined ? {} : { excludeThinkingFromContext }),
      };
    });
    return true;
  } finally {
    saving.delete(sessionId);
  }
}

function patchConfirmedTranscriptEdit(
  { get, set }: StoreAccess,
  runtime: SessionRuntime,
  sessionId: string,
  changedIds: Iterable<string>,
  patch: (message: UiMessage) => UiMessage,
) {
  const current = get();
  const ids = [...changedIds];
  const replace = (messages: UiMessage[]) => {
    const { positions } = getSessionMessageSnapshot(messages);
    const changed: number[] = [];
    let next: UiMessage[] | undefined;
    for (const id of ids) {
      const index = positions.get(id);
      if (index === undefined) continue;
      const message = messages[index];
      const updated = patch(message);
      if (updated === message) continue;
      next ??= messages.slice();
      next[index] = updated;
      changed.push(index);
    }
    return next ? registerSessionMessageReplacements(messages, next, changed) : messages;
  };
  // Preserve each window, including after navigation, and invalidate reads issued before the save.
  const active = current.activeSessionId === sessionId ? current.messages : undefined;
  const retained = current.retainedTranscripts[sessionId];
  const cached = runtime.sessionTranscriptCache.get(sessionId) ?? retained;
  const view = current.transcriptViews[sessionId];
  const updatedActive = active && replace(active);
  const updatedCache = cached && (cached === active ? updatedActive : replace(cached));
  const reading = view && replace(view.messages);
  const updatedRetained = retained && (retained === active ? updatedActive : retained === cached ? updatedCache : replace(retained));
  const distinctWindow = (cached && cached !== active) || (retained && retained !== active);
  runtime.recordConfirmedReplyEdit(sessionId, distinctWindow && updatedActive !== active ? updatedActive : undefined);
  if (updatedCache && updatedCache !== cached) runtime.cacheSessionTranscript(sessionId, updatedCache);
  set({
    ...(updatedActive && updatedActive !== active ? { messages: updatedActive } : {}),
    ...(updatedRetained && updatedRetained !== retained ? { retainedTranscripts: { ...current.retainedTranscripts, [sessionId]: updatedRetained } } : {}),
    ...(view && reading && (reading !== view.messages || updatedActive !== active || view.loading) ? {
      transcriptViews: { ...current.transcriptViews, [sessionId]: { ...view, messages: reading, loading: null } },
    } : {}),
  });
}
