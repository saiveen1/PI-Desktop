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
  return { ...access, runtime, transcript, sessions, reading: reading.actions, toasts };
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

test("does not report an unacknowledged thinking choice as saved by an older host", async t => {
  const h = setup();
  t.mock.method(api, "editAssistantReply", async () => ({ ok: true }));
  const before = h.get().messages;
  assert.equal(await h.transcript.editAssistantReply(id, answer.id, answer.content, answer.content, signal(), "turn"), false);
  assert.equal(h.get().messages, before);
  assert.equal(h.toasts.length, 1);
});

test("applies only Host-confirmed thinking flags and preserves raw thinking and replay for unchanged bodies", async t => {
  const signed = (message, thinking) => ({ ...message, thinking,
    providerReplay: { version: 1, blocks: [{ type: "thinking", length: thinking.length, signature: message.id }] } });
  const previousTurn = signed(history[1], "previous work");
  const earlier = signed(history[3], "pre-tool work");
  const selected = signed(answer, "final check");
  const tool = history[4];
  const full = [history[0], previousTurn, history[2], earlier, tool, selected];
  const messages = full.slice(-2);
  const focus = { messageId: earlier.id, requestId: 1 };
  const view = { messages: full, focus, loading: null, messageStart: 43, messageEnd: 49, hasMoreBefore: true };
  const h = setup({ messages, retainedTranscripts: { [id]: messages }, transcriptViews: { [id]: view } });
  const calls = [];
  const flag = (row, excludeThinkingFromContext) => ({ messageId: row.id, excludeThinkingFromContext });
  const results = [
    [flag(selected, true)], [flag(earlier, true)], [flag(earlier, false), flag(selected, false)], [],
  ];
  t.mock.method(api, "editAssistantReply", async (input) => {
    calls.push(input);
    return { ok: true, thinkingContextUpdates: results.shift() };
  });
  const save = (thinkingContext, content = selected.content, abortSignal) =>
    h.transcript.editAssistantReply(id, selected.id, selected.content, content, abortSignal, thinkingContext);
  assert.equal(await save(undefined), false, "legacy identical text remains a no-op");
  assert.equal(await save("reply", selected.content, AbortSignal.abort()), false);
  assert.deepEqual(calls, []);

  const reading = () => h.get().transcriptViews[id];
  const expectRows = (earlierFlag, selectedFlag) => {
    const state = h.get();
    const currentReply = { ...selected, excludeThinkingFromContext: selectedFlag };
    assert.deepEqual(state.messages, [tool, currentReply]);
    assert.equal(state.retainedTranscripts[id], state.messages);
    assert.equal(h.runtime.sessionTranscriptCache.get(id), state.messages);
    assert.deepEqual(reading().messages[3], earlierFlag === undefined ? earlier : { ...earlier, excludeThinkingFromContext: earlierFlag });
    assert.equal(reading().messages[3].providerReplay, earlier.providerReplay);
    assert.equal(reading().messages[5].providerReplay, selected.providerReplay);
    assert.equal(reading().messages[1], previousTurn);
    assert.equal(reading().messages[4], tool);
    assert.deepEqual(reading().messages[5], currentReply);
    assert.equal(reading().focus, focus);
    assert.equal(reading().messageStart, view.messageStart);
    assert.equal(h.runtime.sessionHistoryCache.get(id), window);
  };
  assert.equal(await save("reply"), true);
  expectRows(undefined, true);
  assert.equal(await save("turn"), true);
  expectRows(true, true);
  assert.equal(await save("keep"), true);
  expectRows(false, false);

  assert.equal(await save("keep", replacement), true);
  assert.deepEqual(h.get().messages.at(-1), { ...selected, content: replacement, excludeThinkingFromContext: false, providerReplay: undefined });
  assert.equal(reading().messages[3].providerReplay, earlier.providerReplay);
  assert.deepEqual(calls.map(({ thinkingContext, expectedContent, content }) => [thinkingContext, expectedContent === content]),
    [["reply", true], ["turn", true], ["keep", true], ["keep", false]]);
});

test("a context-only save invalidates a stale reading request outside the changed rows", async t => {
  const oldRows = history.slice(0, 2);
  const view = { messages: oldRows, focus: null, loading: null, messageStart: 43, messageEnd: 45, hasMoreAfter: true };
  const h = setup({ transcriptViews: { [id]: view } });
  const detail = Promise.withResolvers();
  t.mock.method(api, "getSession", () => detail.promise);
  t.mock.method(api, "editAssistantReply", async () => ({ ok: true, thinkingContextUpdates: [
    { messageId: answer.id, excludeThinkingFromContext: true },
  ] }));
  const paging = h.reading.loadTranscriptPage(id, "after");
  assert.equal(h.get().transcriptViews[id].loading, "after");
  assert.equal(await h.transcript.editAssistantReply(id, answer.id, answer.content, answer.content, undefined, "reply"), true);
  detail.resolve({ session: { ...session, messages: history, messageStart: 43, hasMoreBefore: true } });
  await paging;
  assert.deepEqual(h.get().transcriptViews[id], view);
  assert.equal(h.get().messages.find(row => row.id === answer.id).excludeThinkingFromContext, true);
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
  const saving = h.transcript.editAssistantReply(id, answer.id, answer.content, replacement, controller.signal, "turn");
  const otherMessages = [row("other", "user")];
  h.set({ activeSessionId: "other", messages: otherMessages });
  controller.abort();
  // Warm this session's normal bounded detail read while the write is pending.
  void h.runtime.loadSessionDetail(id, { messageLimit: 100, contentLimit: 65536 });
  mutation.resolve({ ok: true, thinkingContextUpdates: [{ messageId: answer.id, excludeThinkingFromContext: true }] });
  assert.equal(await saving, true);
  assert.equal(h.get().messages, otherMessages);
  assert.equal(h.get().retainedTranscripts[id][5].content, replacement);
  assert.equal(h.get().retainedTranscripts[id][5].excludeThinkingFromContext, true);
  assert.equal(h.runtime.sessionTranscriptCache.get(id)[5].excludeThinkingFromContext, true);
  read.mock.mockImplementationOnce(async () => ({ session: { ...session, messages: history.map((row) =>
    row === answer ? { ...answer, content: replacement, excludeThinkingFromContext: true } : row), messageStart: 43, hasMoreBefore: true } }));
  const selecting = h.sessions.selectSession(id);
  detail.resolve({ session: { ...session, messages: history, messageStart: 43, hasMoreBefore: true } });
  await selecting;
  assert.equal(h.get().messages[5].content, replacement);
  assert.equal(h.runtime.sessionTranscriptCache.get(id)[5].content, replacement);
  assert.equal(h.get().messages[5].excludeThinkingFromContext, true);
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
