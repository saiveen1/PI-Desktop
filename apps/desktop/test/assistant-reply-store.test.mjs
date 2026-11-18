import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { api } = await import("../src/lib/api.ts");
const { createTranscriptSlice } = await import("../src/stores/slices/transcript-slice.ts");
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
const { createSessionCoordination } = await import("../src/stores/runtime/session-coordination.ts");
const { createTranscriptReadingRuntime } = await import("../src/stores/runtime/transcript-reading-runtime.ts");
const { buildTranscriptEntries } = await import("../src/lib/assistant-turns.ts");
const { getAssistantTurnSummary } = await import("../src/lib/transcript-summary.ts");
const { withoutRecordKey } = await import("../src/stores/helpers/store-helpers.ts");

const id = "s";
const row = (id, role, content = id) => ({ id, role, content, status: "complete", createdAt: "2026-01-01T00:00:00Z" });
const answer = { ...row("answer", "assistant", "  **Original answer**\n"), thinking: "notes", modelId: "model", turnId: "root" };
const history = [row("old-user", "user"), row("old-reply", "assistant"), row("user", "user"),
  row("fragment", "assistant"), row("tool", "tool"), answer, row("system", "system")];
const window = { messageStart: 43, hasMoreBefore: true, contentLimited: true };
const session = { id, source: "desktop", mode: "agent", messageCount: 50 };
const replacement = "  **Updated**\n\n";
const signal = () => new AbortController().signal;

function setup(overrides = {}) {
  const toasts = [];
  let state = {
    page: "chat", activeSessionId: id, messages: history, sessions: [session],
    sessionHistory: { [id]: window }, transcriptViews: {}, retainedSessionIds: [id, "other"], retainedTranscripts: { [id]: history },
    runningSessions: {}, pendingPlans: {}, pendingPermissions: {}, pendingAsks: {}, queuedPrompts: {}, isRunning: false,
    sessionMeta: {}, planningStates: {}, navStack: [], navIndex: -1, settings: {}, providers: [], recentModels: [],
    acknowledgeSessionOutcome: async () => {}, restorePendingPlan() {}, restorePendingInteractive() {},
    showToast: (...args) => toasts.push(args), ...overrides,
    providerModels: {}, workPanelTabs: [], workPanelContexts: {},
  };
  const access = { get: () => state, set: (patch) => {
    const before = state;
    state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
    runtime.syncTranscriptProjection(state, before);
    reading.reconcile(state, before);
  } };
  const runtime = createSessionRuntime(access);
  const reading = createTranscriptReadingRuntime(access, (...args) => api.getSession(...args));
  const transcript = createTranscriptSlice({ ...access, runtime });
  const sessions = createSessionSlice({ ...access, runtime, ...createSessionCoordination({ ...access, runtime, withoutRecordKey }) });
  runtime.cacheSessionTranscript(id, state.messages, window);
  return { ...access, runtime, transcript, sessions, toasts };
}

test("edits the canonical action fragment, preserving window, rows and metadata", async t => {
  const turn = buildTranscriptEntries(history).entries.filter((entry) => entry.kind === "assistant-turn").at(-1);
  const action = getAssistantTurnSummary(turn).actionMessage;
  assert.equal(action, answer);
  const focus = { messageId: "answer", requestId: 1 };
  const reading = { messages: [row("earlier", "user"), ...history], messageStart: 42, messageEnd: 50,
    hasMoreBefore: true, hasMoreAfter: false, loading: null, focus };
  const h = setup({ transcriptViews: { [id]: reading } });
  t.mock.method(api, "getSession", () => assert.fail("complete author text needs no history hydration"));
  t.mock.method(api, "editAssistantReply", async (payload) => {
    assert.deepEqual(payload, { sessionId: id, messageId: answer.id, expectedContent: answer.content, content: replacement });
    assert.equal(h.get().messages, history, "do not optimistically mutate the transcript");
    return { ok: true };
  });
  const source = await h.transcript.prepareAssistantReplyEdit(id, action.id, signal());
  assert.equal(source, answer.content, "preserve whitespace and exclude pre-tool narration and tool output");
  assert.equal(await h.transcript.editAssistantReply(id, action.id, source, replacement), true);
  const state = h.get();
  assert.equal(state.messages.length, history.length);
  assert.equal(state.messages[4], history[4]);
  assert.deepEqual(state.messages[5], { ...answer, content: replacement, providerReplay: undefined });
  assert.equal(state.sessionHistory[id], window);
  assert.equal(h.runtime.sessionHistoryCache.get(id), window);
  assert.equal(state.transcriptViews[id].focus, focus);
  assert.equal(state.transcriptViews[id].messageStart, 42);
  assert.equal(state.transcriptViews[id].messages[6].content, replacement);
  assert.equal(state.retainedTranscripts[id], state.messages);
  assert.equal(state.isRunning, false);
  assert.deepEqual(h.toasts, []);
});

test("does not open or submit for old, wrong-source, busy, stale or non-text targets", async t => {
  const invoke = t.mock.method(api, "editAssistantReply", () => assert.fail("ineligible write"));
  for (const overrides of [
    { sessions: [{ ...session, source: "pi-native" }] },
    { sessions: [{ ...session, source: "remote", capabilities: { canEditMessages: true } }] },
    { sessions: [{ ...session, capabilities: { canEditMessages: false } }] },
    { sessions: [{ ...session, scheduledRun: true }] },
    { selectingSessionId: "other" }, { runningSessions: { [id]: true } },
    { pendingPlans: { [id]: { status: "pending" } } },
    { messages: [...history, row("later-user", "user")] },
    { messages: [...history, row("later-tool", "tool")] },
    { messages: [...history, { ...answer, status: "aborted" }] },
    { messages: [...history.slice(0, -2), { ...answer, attachments: [{}] }] },
    { messages: [...history.slice(0, -2), { ...answer, parentToolCallId: "child" }] },
  ]) {
    const h = setup(overrides);
    assert.equal(await h.transcript.prepareAssistantReplyEdit(id, answer.id, signal()), null);
    assert.equal(await h.transcript.editAssistantReply(id, answer.id, answer.content, replacement), false);
  }
  const h = setup();
  assert.equal(await h.transcript.prepareAssistantReplyEdit(id, "old-reply", signal()), null);
  assert.equal(await h.transcript.editAssistantReply(id, answer.id, "stale text", replacement), false);
  assert.equal(await h.transcript.editAssistantReply(id, answer.id, answer.content, " \n"), false);
  assert.equal(invoke.mock.callCount(), 0);
});

test("opens a clipped reply from a focused one-row read and discards an aborted completion", async t => {
  const suffix = "\n\n[truncated for display; the full content remains in the transcript]";
  const prefix = "a".repeat(65536 - suffix.length);
  const canonical = prefix + "complete text beyond the preview";
  const messages = [...history.slice(0, -2), { ...answer, content: prefix + suffix }];
  const h = setup({ messages });
  const read = t.mock.method(api, "getSession", async (...args) => {
    assert.deepEqual(args, [id, { messageAround: answer.id, messageLimit: 1, contentLimit: 65536 }]);
    return { session: { messages: [{ ...answer, content: canonical }] } };
  });
  assert.equal(await h.transcript.prepareAssistantReplyEdit(id, answer.id, signal()), canonical);
  assert.equal(h.get().messages, messages);
  assert.equal(h.get().sessionHistory[id], window);
  const controller = new AbortController();
  const pending = h.transcript.prepareAssistantReplyEdit(id, answer.id, controller.signal);
  controller.abort();
  assert.equal(await pending, null);
  assert.equal(read.mock.callCount(), 2);
});

test("keeps a Host failure scoped, leaves the original projection, and prevents duplicate writes", async t => {
  const h = setup();
  const { promise, reject } = Promise.withResolvers();
  const invoke = t.mock.method(api, "editAssistantReply", () => promise);
  const first = h.transcript.editAssistantReply(id, answer.id, answer.content, replacement);
  assert.equal(await h.transcript.editAssistantReply(id, answer.id, answer.content, "duplicate"), false);
  assert.equal(invoke.mock.callCount(), 1);
  reject(new Error("Host refused stale reply"));
  assert.equal(await first, false);
  assert.equal(h.get().messages, history);
  assert.deepEqual(h.toasts, [["Host refused stale reply", { variant: "error" }]]);
});

test("a confirmed save never touches the other pane or joins a stale detail prefetch", async t => {
  const h = setup();
  h.runtime.liveSessionTranscripts.add(id);
  const mutation = Promise.withResolvers();
  const detail = Promise.withResolvers();
  t.mock.method(api, "editAssistantReply", () => mutation.promise);
  const read = t.mock.method(api, "getSession", () => detail.promise);
  const controller = new AbortController();
  const saving = h.transcript.editAssistantReply(id, answer.id, answer.content, replacement, controller.signal);
  const otherMessages = [row("other", "user")];
  h.set({ activeSessionId: "other", messages: otherMessages });
  controller.abort();
  // Warm this session's normal bounded detail read while the write is pending.
  void h.runtime.loadSessionDetail(id, { messageLimit: 100, contentLimit: 65536 });
  mutation.resolve({ ok: true });
  assert.equal(await saving, true);
  assert.equal(h.get().messages, otherMessages);
  assert.equal(h.get().retainedTranscripts[id][5].content, replacement);
  read.mock.mockImplementationOnce(async () => ({ session: { ...session, messages: history.map((row) =>
    row === answer ? { ...answer, content: replacement } : row), messageStart: 43, hasMoreBefore: true } }));
  const selecting = h.sessions.selectSession(id);
  detail.resolve({ session: { ...session, messages: history, messageStart: 43, hasMoreBefore: true } });
  await selecting;
  assert.equal(h.get().messages[5].content, replacement);
  assert.equal(h.runtime.sessionTranscriptCache.get(id)[5].content, replacement);
  assert.deepEqual(h.get().sessionHistory[id], window);
  assert.equal(read.mock.callCount(), 2);
});

test("a pre-save selection result cannot restore the old reply over a live-origin cache", async t => {
  const h = setup();
  h.runtime.liveSessionTranscripts.add(id);
  const mutation = Promise.withResolvers();
  const detail = Promise.withResolvers();
  t.mock.method(api, "editAssistantReply", () => mutation.promise);
  t.mock.method(api, "getSession", () => detail.promise);
  const saving = h.transcript.editAssistantReply(id, answer.id, answer.content, replacement);
  const selecting = h.sessions.selectSession(id);
  mutation.resolve({ ok: true });
  assert.equal(await saving, true);
  detail.resolve({ session: { ...session, messages: history, messageStart: 43, hasMoreBefore: true } });
  await selecting;
  assert.equal(h.get().messages[5].content, replacement);
  assert.equal(h.runtime.sessionTranscriptCache.get(id)[5].content, replacement);
  assert.equal(h.get().sessionHistory[id], window);
});
