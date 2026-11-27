import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en, zhCN } from "@pi-desktop/i18n";
import { ChatTranscript } from "../../src/features/chat/transcript/ChatTranscript";
import { SessionPane } from "../../src/components/SessionPane";
import { sessionReadingState } from "../../src/lib/transcript-reading-position";
import { exerciseContextBoundary, exerciseHistoricalTurnContext, exerciseTurnContext } from "./turn-context-editor.jsx";
import { useAppStore } from "../../src/stores/app-store";
import "../../src/styles/tokens.css";
import "../../src/styles/ui-kit.css";
import "../../src/styles/messages.css";

await i18n.init({ lng: "en", resources: { en: { translation: en }, "zh-CN": { translation: zhCN } } });
const root = createRoot(document.getElementById("root"));
const scroller = () => document.querySelector('[data-scroll-owner="transcript"]');
const message = (id) => ({ id, role: "user", status: "complete", content: id, createdAt: "2026-01-01T00:00:00Z" });
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
let sessionId, messages, calls, render, initialBookmark, pageGate;
let foldedReads = [];

async function until(condition, label) {
  const deadline = performance.now() + 4000;
  while (!condition()) {
    if (performance.now() > deadline) throw Error(label);
    await frame();
  }
}

// Include the prepend commit, the paging hold's three stable frames, and subsequent
// observer deliveries. A short successful page intentionally leaves the edge in range.
async function settle() {
  for (let i = 0; i < 12; ++i) await frame();
  return { calls, rows: scroller().querySelectorAll('[data-message-id]').length,
    top: scroller().scrollTop, maxTop: scroller().scrollHeight - scroller().clientHeight };
}

window.historyDemand = {
  async open(name) {
    sessionId = name;
    calls = 0;
    pageGate = name.startsWith("delayed") ? Promise.withResolvers() : null;
    messages = Array.from({ length: name === "underfilled" ? 1 : name === "deep" ? 101 : 8 }, (_, i) => message(`row-${i}`));
    if (name === "restored") {
      initialBookmark = { pinned: false, messageId: "row-0", offset: -8, scrollTop: 36, windowSize: 48 };
      sessionReadingState(name).position = initialBookmark;
    }
    const older = async () => {
      ++calls;
      if (calls === 1 && pageGate) await pageGate.promise;
      if (name === "delayed-empty" && calls === 1) return;
      messages = [message(`older-${calls}`), ...messages];
      render();
    };
    render = () => flushSync(() => root.render(<I18nextProvider i18n={i18n}>
      <ChatTranscript key={name} sessionId={sessionId} messages={messages} hasMoreBefore={calls < 5}
        isRunning={false} onLoadOlder={older} />
    </I18nextProvider>));
    render();
    const firstVisible = name === "deep" ? "row-100" : "row-0";
    await until(() => scroller()?.querySelector(`[data-message-id="${firstVisible}"]`) &&
      !document.querySelector('[data-transcript-settling="true"]'), "transcript did not mount and settle");
    return settle();
  },
  async layoutAfterRestore() {
    // Wait until the recorded anchor was actually applied and its alignment owner
    // retired (it publishes a fresh bookmark). Only then exercise an unowned scroll.
    await until(() => sessionReadingState(sessionId).position !== initialBookmark, "bookmark alignment did not settle");
    const offset = scroller().querySelector('[data-message-id="row-0"]').getBoundingClientRect().top - scroller().getBoundingClientRect().top;
    scroller().style.height = '260px';
    scroller().scrollTop = 2;
    return { offset, ...await settle() };
  },
  async click(which) {
    const button = which === "top" ? [...scroller().querySelectorAll('button')].find(b => b.textContent.trim() === i18n.t('chat.showEarlierMessages'))
      : document.querySelector('.minimap-marker.history');
    if (!button || button.disabled || !button.getClientRects().length || getComputedStyle(button).visibility !== 'visible') throw Error(`No available ${which} Show earlier control`);
    button.click();
  },
  async afterPage(expected) {
    await until(() => scroller().querySelector(`[data-message-id="older-${expected}"]`), `Page ${expected} did not render`);
    return settle();
  },
  async atBlockedTop() {
    await until(() => calls === 1 && scroller().scrollTop <= 1, "first page did not stall at the top");
    return settle();
  },
  releasePage() { pageGate.resolve(); },
  state: settle,
  async jumpLatest() {
    const button = document.querySelector('.jump-latest-btn');
    if (!button) throw Error('No jump-to-latest control');
    button.click();
    await until(() => Math.abs(scroller().scrollTop + scroller().clientHeight - scroller().scrollHeight) <= 1,
      'jump did not reach latest');
    return settle();
  },
  wheelPoint() {
    const { x, y, width, height } = scroller().getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2 };
  },
  async openLongThinking() {
    const style = document.createElement('style');
    style.textContent = '.thread-scroll[data-long-thinking] [data-message-id]{height:auto;overflow:visible}';
    document.head.append(style);
    const id = 'long-thinking';
    const rows = [message('previous-prompt'), { ...message('previous-answer'), role: 'assistant' }, message('prompt'),
      { ...message('thinking'), role: 'assistant', thinking: Array.from({ length: 80 }, (_, i) => `Reasoning step ${i}.`).join('\n\n'), content: '' },
      { ...message('answer'), role: 'assistant', content: 'The answer after the thinking.' }];
    flushSync(() => root.render(<I18nextProvider i18n={i18n}>
      <ChatTranscript key={id} sessionId={id} messages={rows} isRunning={false} />
    </I18nextProvider>));
    const el = scroller();
    el.dataset.longThinking = '';
    el.querySelector('.turn-process > button[aria-expanded="false"]')?.click();
    const thinkingTitle = () => el.querySelector('.thinking .tool-row-header');
    await until(thinkingTitle, 'thinking title did not open');
    const title = thinkingTitle();
    title.scrollIntoView({ block: 'center' });
    await settle();
    const offset = () => title.getBoundingClientRect().top - el.getBoundingClientRect().top;
    const beforeOpen = offset();
    title.click();
    await until(() => el.querySelectorAll('.thinking-prose p').length === 80, 'thinking text did not open');
    await settle();
    const openDrift = offset() - beforeOpen;
    const answer = el.querySelector('[data-message-id="answer"]');
    el.scrollTop += answer.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientHeight + 30;
    await settle();
    return { top: el.scrollTop, openDrift };
  },
  async moveDuringLateThinkingLayout() {
    const el = scroller();
    const before = el.scrollTop;
    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    el.scrollTop = before - 200;
    const wheelTop = el.scrollTop;
    // Reproduce a layout delivery below the new viewport in the same scroll frame.
    const lastParagraph = [...el.querySelectorAll('.thinking-prose p')].at(-1);
    const belowViewport = lastParagraph.getBoundingClientRect().top >= el.getBoundingClientRect().bottom;
    const initialHeight = el.scrollHeight;
    lastParagraph.style.paddingBottom = '260px';
    el.dispatchEvent(new Event('scroll'));
    await settle();
    return { before, wheelTop, finalTop: el.scrollTop, belowViewport, heightDelta: el.scrollHeight - initialHeight };
  },
  async openFoldedHistory(name = 'folded-history') {
    const turn = (prompt, answer, count) => [message(prompt),
      ...Array.from({ length: count }, (_, i) => ({
        ...message(`${prompt}-tool-${i}`), role: 'tool', turnId: prompt,
        toolCallId: `${prompt}-call-${i}`, toolName: 'Read', toolStatus: 'success',
      })), { ...message(answer), role: 'assistant', turnId: prompt }];
    const rows = name === 'single-reply' ? turn('earlier-user', 'folded-answer', 664)
      : [...(name === 'previous-reply' ? turn('previous-user', 'previous-answer', 2) : []),
        ...turn('earlier-user', 'earlier-answer', 795), ...turn('follow-up', 'follow-up-answer', 9),
        ...turn('another-prompt', 'another-answer', 64), ...turn('latest-prompt', 'folded-answer', 7)];
    const start = rows.length - 100;
    const tail = rows.slice(start);
    foldedReads = [];
    window.piDesktop = { invoke: async (channel, options) => {
      if (!channel.endsWith('/session/get') || options.id !== name) throw Error(`Unexpected fixture call: ${channel}`);
      const before = options.previousUserMessage
        ? rows.findLastIndex((row, index) => row.role === 'user' && index < options.messageBefore) + 1
        : Math.min(options.messageBefore ?? rows.length, rows.length);
      foldedReads.push(options.previousUserMessage ? 'previous-prompt' : 'raw-page');
      const pageStart = Math.max(0, before - options.messageLimit);
      return { ok: true, data: { session: { id: name, source: 'desktop', messages: rows.slice(pageStart, before),
        messageStart: pageStart, messageEnd: before, hasMoreBefore: pageStart > 0, hasMoreAfter: before < rows.length } } };
    } };
    useAppStore.setState({ activeSessionId: name, messages: tail, retainedTranscripts: { [name]: tail },
      retainedSessionIds: [name], transcriptViews: {}, sessionHistory: { [name]: { messageStart: start, hasMoreBefore: true } },
      sessions: [{ id: name, source: 'desktop' }] });
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><SessionPane key={name} sessionId={name} visible /></I18nextProvider>));
    await until(() => scroller()?.querySelector('.turn-process > button[aria-expanded="false"]'), 'tool activity did not fold');
    await settle();
    return { calls: [...foldedReads], latestAnswer: !!scroller().querySelector('[data-message-id="folded-answer"]') };
  },
  async openBoundedTurn(name) {
    const progress = { ...message('progress'), role: 'assistant', turnId: 'bounded-turn', modelId: 'test-model' };
    const startedAt = Date.parse(progress.createdAt);
    const runDiagnostics = { turnId: progress.turnId, startedAt, lastEventAt: startedAt + 2000,
      requestStartedAt: startedAt + 1000, requestCount: 1, attemptCount: 1, requestAttempt: 1,
      retryCount: 0, rateLimitRetries: 0, transientRetries: 0, retryWaitMs: 0 };
    const answer = { ...progress, id: 'final-answer', content: 'The persisted final answer.',
      createdAt: new Date(startedAt + 12000).toISOString(), runDiagnostics: { ...runDiagnostics, endedAt: startedAt + 12000 } };
    const rows = [message('prompt'), { ...progress, runDiagnostics }, ...Array.from({ length: 63 }, (_, i) => ({
      ...message(`tool-${i}`), role: 'tool', turnId: progress.turnId, toolCallId: `tool-${i}`, toolName: 'Read', toolStatus: 'success',
    })), answer];
    const tail = rows.slice(-10);
    calls = 0;
    window.piDesktop = { invoke: async (channel, options) => {
      if (!channel.endsWith('/session/get') || options.id !== name) throw Error(`Unexpected fixture call: ${channel}`);
      ++calls;
      const end = options.messageAround ? 60 : Math.min(options.messageBefore, rows.length);
      const start = Math.max(0, end - options.messageLimit);
      return { ok: true, data: { session: { id: name, source: 'desktop', messages: rows.slice(start, end),
        messageStart: start, messageEnd: end, hasMoreBefore: start > 0, hasMoreAfter: end < rows.length } } };
    } };
    useAppStore.setState({ activeSessionId: name, messages: tail, retainedTranscripts: { [name]: tail },
      retainedSessionIds: [name], transcriptViews: {}, sessionHistory: { [name]: { messageStart: rows.length - tail.length, hasMoreBefore: true } },
      sessions: [{ id: name, source: 'desktop' }] });
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><SessionPane key={name} sessionId={name} visible /></I18nextProvider>));
    await useAppStore.getState().navigateTranscript({ sessionId: name, messageId: 'prompt', query: 'prompt' });
    await until(() => scroller()?.querySelector('.transcript-load-later'), 'bounded search page did not open');
    const details = scroller().querySelector('[data-testid="run-status-summary"] button');
    details.click();
    await until(() => document.querySelector('.run-status-popover'), 'run diagnostics did not open');
    const partial = { phase: scroller().querySelector('.turn-process .tool-activity-label').textContent,
      elapsed: details.querySelector('.working-elapsed')?.textContent ?? null,
      total: [...document.querySelectorAll('.run-status-popover dt')].some(row => row.textContent === 'Whole turn'),
      actions: !!scroller().querySelector('.assistant-turn .message-actions'), calls };
    details.click();
    return partial;
  },
  async finishBoundedTurn(action) {
    const button = action === 'later' ? scroller().querySelector('.transcript-load-later')
      : [...scroller().querySelectorAll('button')].find(button => button.textContent.trim() === i18n.t('chat.scrollToBottom'));
    if (!button) throw Error(`No ${action} action at the page boundary`);
    button.click();
    const getAnswer = () => scroller().querySelector('.message-bubble[data-message-id="final-answer"]');
    await until(() => getAnswer() && !scroller().querySelector('.transcript-load-later'), `settled answer did not render after ${action}`);
    return { answer: getAnswer().textContent, calls,
      phase: scroller().querySelector('.turn-process .tool-activity-label')?.textContent,
      elapsed: scroller().querySelector('[data-testid="run-status-summary"] .working-elapsed')?.textContent };
  },
  async foldedHistoryResult(expected = 1, target = 'earlier-user') {
    await until(() => foldedReads.length >= expected, `history read ${expected} did not start`);
    await settle();
    const el = scroller();
    const rect = el.querySelector(`[data-message-id="${target}"]`)?.getBoundingClientRect();
    const bounds = el.getBoundingClientRect();
    const view = useAppStore.getState().transcriptViews[useAppStore.getState().activeSessionId];
    return { calls: foldedReads, promptVisible: !!rect && rect.bottom > bounds.top && rect.top < bounds.bottom,
      rows: view?.messages.length, latestAnswer: !!el.querySelector('[data-message-id="folded-answer"]'),
      later: !!el.querySelector('.transcript-load-later'), top: el.scrollTop, targetTop: rect ? rect.top - bounds.top : null,
      rendered: [...el.querySelectorAll('.message-row [data-message-id], .message-row[data-message-id]')].slice(0, 12).map(row => row.dataset.messageId),
      head: view?.messages.slice(0, 6).map(row => `${row.id}:${row.turnId ?? ''}`) };
  },
};

window.exerciseTurnContext = () => exerciseTurnContext({ root, i18n, message, frame, until });
window.exerciseHistoricalTurnContext = () => exerciseHistoricalTurnContext({ root, i18n, message, frame, until });
window.exerciseContextBoundary = (restarting) => exerciseContextBoundary({ root, i18n, message, frame, until }, restarting);
