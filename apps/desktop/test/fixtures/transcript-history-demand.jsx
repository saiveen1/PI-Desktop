import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { ChatTranscript } from "../../src/features/chat/transcript/ChatTranscript";
import { sessionReadingState } from "../../src/lib/transcript-reading-position";
import { api } from "../../src/lib/api";
import { useAppStore } from "../../src/stores/app-store";
import "../../src/styles/tokens.css";

await i18n.init({ lng: "en", resources: { en: { translation: en } } });
const root = createRoot(document.getElementById("root"));
const scroller = () => document.querySelector('[data-scroll-owner="transcript"]');
const message = (id) => ({ id, role: "user", status: "complete", content: id, createdAt: "2026-01-01T00:00:00Z" });
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
let sessionId, messages, calls, render, initialBookmark;

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
    messages = Array.from({ length: name === "underfilled" ? 1 : 8 }, (_, i) => message(`row-${i}`));
    if (name === "restored") {
      initialBookmark = { pinned: false, messageId: "row-0", offset: -8, scrollTop: 36, windowSize: 48 };
      sessionReadingState(name).position = initialBookmark;
    }
    const older = async () => {
      ++calls;
      messages = [message(`older-${calls}`), ...messages];
      render();
    };
    render = () => flushSync(() => root.render(<I18nextProvider i18n={i18n}>
      <ChatTranscript key={name} sessionId={sessionId} messages={messages} hasMoreBefore={calls < 5}
        isRunning={false} onLoadOlder={older} />
    </I18nextProvider>));
    render();
    await until(() => scroller()?.querySelector('[data-message-id="row-0"]') &&
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
  api.editAssistantReply = async (input) => {
    writes.push(input);
    if (writes.length === 1) throw Error("Reply changed");
    return { ok: true };
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
  const unchangedDisabled = formButton('Save').disabled;
  change("draft that should be cancelled");
  formButton('Cancel').click();
  await until(() => !textarea(), "Cancel did not close reply editor");
  const afterCancel = { writes: writes.length, content: useAppStore.getState().messages.at(-1).content };
  await open();
  change("  **Corrected reply**\n");
  await until(() => !formButton('Save')?.disabled, "Save did not accept the changed draft");
  formButton('Save').click();
  await until(() => errors.length === 1 && formButton('Save'), "Host refusal did not return to the editor");
  const afterFailure = textarea().value;
  formButton('Save').click();
  await until(() => !textarea() && document.querySelector('[data-message-id="answer"]')?.textContent.includes('Corrected reply'), "confirmed reply did not render");
  return { actionCount, source, focused, unchangedDisabled, afterCancel, afterFailure, errors, writes,
    ids: useAppStore.getState().messages.map(row => row.id) };
};
