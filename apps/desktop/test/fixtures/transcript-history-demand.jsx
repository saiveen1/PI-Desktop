import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en, zhCN } from "@pi-desktop/i18n";
import { ChatTranscript } from "../../src/features/chat/transcript/ChatTranscript";
import { sessionReadingState } from "../../src/lib/transcript-reading-position";
import { api } from "../../src/lib/api";
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
};

window.exerciseReplyEdit = async () => {
  const id = "reply-edit";
  const answer = { ...message("answer"), role: "assistant", content: "  **Final reply**\n" };
  const rows = [message("older-prompt"), { ...message("older-answer"), role: "assistant" }, message("prompt"),
    { ...message("narration"), role: "assistant" }, { ...message("tool"), role: "tool", toolName: "read" }, answer];
  const writes = [];
  const errors = [];
  const failure = Promise.withResolvers();
  api.editAssistantReply = async (input) => {
    writes.push(input);
    if (writes.length === 2) return failure.promise;
    return {
      ok: true,
      thinkingContextUpdates: [{ messageId: answer.id, excludeThinkingFromContext: input.thinkingContext !== "keep" }],
    };
  };
  for (const operation of ["prompt", "forkSession", "getSession"]) {
    api[operation] = () => { throw Error(`Unexpected ${operation}`); };
  }
  useAppStore.setState({ page: "chat", activeSessionId: id, messages: rows,
    sessions: [{ id, source: "desktop" }], showToast: (text) => errors.push(text) });
  function Conversation() {
    const live = useAppStore((state) => state.messages);
    return <ChatTranscript sessionId={id} messages={live} isRunning={false} />;
  }
  flushSync(() => root.render(<I18nextProvider i18n={i18n}><Conversation /></I18nextProvider>));
  const actions = () => [...document.querySelectorAll('button[aria-label="Edit reply"]')];
  const textarea = () => document.querySelector('textarea[aria-label="Edit reply"]');
  const chooser = () => document.querySelector('.message-edit select');
  const choose = async mode => {
    chooser().value = mode;
    chooser().dispatchEvent(new Event('change', { bubbles: true }));
    await frame();
  };
  const formButton = text => [...document.querySelectorAll('.message-edit button')].find(b => b.textContent === text);
  const open = async () => { actions()[0].click(); await until(textarea, "reply editor did not open"); };
  const change = value => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea(), value);
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
  };
  const actionCount = actions().length;
  await open();
  const source = textarea().value;
  const focused = textarea() === document.activeElement;
  const dropdown = { value: chooser().value, options: [...chooser().options].map(o => [o.value, o.textContent]),
    label: chooser().labels[0]?.firstElementChild.textContent,
    hint: document.getElementById(chooser().getAttribute('aria-describedby'))?.textContent };
  const form = textarea().form;
  const footerLayout = (width) => {
    form.style.width = `${width}px`;
    const field = chooser().closest('.message-edit-thinking-context').getBoundingClientRect();
    const buttons = formButton('Save').parentElement.getBoundingClientRect();
    const footer = chooser().closest('.message-edit-actions').getBoundingClientRect();
    return { wrapped: buttons.top >= field.bottom, right: footer.right - buttons.right <= 9,
      left: field.left - footer.left <= 9, fits: field.right <= footer.right && buttons.right <= footer.right };
  };
  const layout = [footerLayout(500), footerLayout(230)];
  form.style.width = '';
  const unchangedCanSave = !formButton('Save').disabled;
  await choose('turn');
  change('   ');
  await until(() => formButton('Save')?.disabled, "blank text allowed a save");
  formButton('Cancel').click();
  await until(() => !textarea(), "Cancel did not close reply editor");
  const afterCancel = { writes: writes.length, content: useAppStore.getState().messages.at(-1).content };
  await open();
  formButton('Save').click();
  await until(() => !textarea() && useAppStore.getState().messages.at(-1).excludeThinkingFromContext,
    "saving the same text must apply the default context selection");
  await open();
  await choose('turn');
  const beforeExplicitSave = writes.length;
  change("  **Corrected reply**\n");
  await until(() => !formButton('Save')?.disabled && textarea().value.includes('Corrected reply'), "Save did not accept the changed draft");
  textarea().form.requestSubmit();
  textarea().form.requestSubmit();
  await until(() => chooser()?.disabled, "Save did not lock the chooser");
  const pending = { writes: writes.length, readOnly: textarea().readOnly, cancelDisabled: formButton('Cancel').disabled,
    saveDisabled: textarea().form.querySelector('[type="submit"]').disabled };
  failure.reject(Error("Reply changed"));
  await until(() => errors.length === 1 && formButton('Save'), "Host refusal did not return to the editor");
  const afterFailure = { text: textarea().value, mode: chooser().value, enabled: !chooser().disabled };
  formButton('Save').click();
  await until(() => !textarea() && document.querySelector('[data-message-id="answer"]')?.textContent.includes('Corrected reply'), "confirmed reply did not render");
  await open();
  await choose('keep');
  formButton('Save').click();
  await until(() => !textarea() && useAppStore.getState().messages.at(-1).excludeThinkingFromContext === false,
    "saving the same text must also restore thinking");
  window.previewReplyEditor = async () => {
    const style = document.createElement('style');
    style.textContent = '.thread-scroll{width:760px;height:700px}[data-message-id]{height:auto;overflow:visible}';
    document.head.append(style);
    await open();
    await i18n.changeLanguage('zh-CN');
    await frame();
    const form = document.querySelector('.message-edit');
    form.scrollIntoView({ block: 'center' });
    await frame();
    const { x, y, width, height } = form.getBoundingClientRect();
    return { x: x + window.scrollX, y: y + window.scrollY, width, height };
  };
  return { actionCount, source, focused, unchangedCanSave, dropdown, layout, afterCancel, beforeExplicitSave,
    pending, afterFailure, errors, writes, ids: useAppStore.getState().messages.map(row => row.id) };
};
