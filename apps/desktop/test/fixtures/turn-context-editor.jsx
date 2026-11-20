import { flushSync } from 'react-dom';
import { I18nextProvider } from 'react-i18next';
import { IPC } from '@pi-desktop/shared';
import { ChatTranscript } from '../../src/features/chat/transcript/ChatTranscript';
import { useAppStore } from '../../src/stores/app-store';

export async function exerciseTurnContext({ root, i18n, message, frame, until }) {
  const id = 'context-edit';
  const answer = { ...message('answer'), role: 'assistant', content: 'Original final answer', thinking: 'Final thinking' };
  const middle = { ...message('middle'), role: 'assistant', content: 'Original intermediate text', thinking: 'Middle thinking' };
  const tool = { ...message('tool'), role: 'tool', content: 'Original tool result', toolCallId: 'call-1',
    toolName: 'Read', toolArgs: { path: 'notes.md' }, toolStatus: 'success' };
  const rows = [message('older-prompt'), { ...message('older-answer'), role: 'assistant' }, message('prompt'), middle, tool, answer];
  const snapshotRows = [middle, tool, answer].map(row => ({ messageId: row.id, role: row.role, final: row === answer,
    content: row.role === 'assistant' ? row.content : '', thinking: row.thinking, hasThinking: Boolean(row.thinking),
    toolName: row.toolName, toolArgs: row.toolArgs, toolResultText: row.role === 'tool' ? row.content : undefined }));
  const writes = [], reads = [], errors = [], persisted = new Map();
  let revision = 0, heldRead, heldWrite;
  const readSnapshot = () => ({ sessionId: id, anchorMessageId: answer.id, revision: String(revision),
    messages: snapshotRows.map(row => ({ ...row, override: persisted.get(row.messageId) })) });
  const reloaded = () => rows.map(row => ({ ...row, contextOverride: persisted.get(row.id) }));
  window.piDesktop = { invoke: async (channel, input) => {
    if (channel === IPC.invoke.sessionGetTurnContext) {
      reads.push(input);
      if (heldRead) await heldRead.promise;
      return { ok: true, data: { snapshot: readSnapshot() } };
    }
    if (channel === IPC.invoke.sessionEditTurnContext) {
      writes.push(input);
      if (heldWrite && await heldWrite.promise === 'reject') {
        return { ok: false, error: { code: 'LIMIT_EXCEEDED', message: 'Synthetic refusal' } };
      }
      if (input.expectedRevision !== String(revision)) throw Error('Revision not forwarded');
      const updates = input.restore ? [...persisted.keys()].map(messageId => ({ messageId, contextOverride: null })) : input.edits;
      for (const { messageId, contextOverride } of updates) {
        if (contextOverride) persisted.set(messageId, contextOverride);
        else persisted.delete(messageId);
      }
      revision++;
      return { ok: true, data: { snapshot: readSnapshot(), updates } };
    }
    throw Error(`Unexpected ${channel}`);
  } };
  const hydrate = (activeSessionId = id, messages = reloaded()) => useAppStore.setState({ page: 'chat', activeSessionId, messages,
    isRunning: false, sessions: [{ id, source: 'desktop' }, { id: 'other', source: 'desktop' }],
    showToast: (text) => errors.push(text) });
  const seeded = reloaded();
  hydrate(id, seeded);
  useAppStore.setState({ retainedSessionIds: [id], retainedTranscripts: { [id]: seeded.slice(2) }, transcriptViews: {
    [id]: { messages: seeded.slice(1), messageStart: 1, messageEnd: seeded.length, hasMoreBefore: true, hasMoreAfter: false, loading: null },
  } });
  function Conversation() {
    const active = useAppStore((state) => state.activeSessionId);
    const live = useAppStore((state) => state.messages);
    return <ChatTranscript key={active} sessionId={active} messages={live} isRunning={false} />;
  }
  flushSync(() => root.render(<I18nextProvider i18n={i18n}><Conversation /></I18nextProvider>));
  const actions = () => [...document.querySelectorAll('button[aria-label="Edit context"]')];
  const form = () => document.querySelector('.turn-context-editor');
  const notice = () => document.querySelector('.turn-context-notice');
  const count = () => form().querySelector('.turn-context-count').textContent;
  const blocks = () => [...form().querySelectorAll('[data-context-kind]')];
  const block = kind => blocks().find(row => row.dataset.contextKind === kind);
  const input = (kind, index = 0) => block(kind).querySelectorAll('textarea')[index];
  const button = (text, parent = form()) => [...parent.querySelectorAll('button')].find(b => b.textContent === text);
  const press = async (text, parent) => { button(text, parent).click(); await frame(); };
  const open = async () => { actions()[0].click(); await until(form, 'context editor did not open'); };
  const change = async (field, value) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await frame();
  };
  const actionCount = actions().length;
  const forkCount = document.querySelectorAll(`button[aria-label="${i18n.t('chat.forkResponse')}"]`).length;
  await open();
  const defaults = { kinds: blocks().map(row => row.dataset.contextKind),
    checked: blocks().map(row => row.querySelector('input').checked), saveDisabled: button('Save').disabled, count: count() };
  const layout = [500, 230].map(width => {
    form().style.width = `${width}px`;
    const bounds = form().getBoundingClientRect();
    const bar = [...form().querySelectorAll('.turn-context-header button')].map(node => node.getBoundingClientRect());
    const scroll = form().querySelector('.turn-context-scroll');
    return { wraps: bar.at(-1).top > bar[0].top, fits: bar.every(pos => pos.right <= bounds.right),
      bounded: scroll.scrollHeight > scroll.clientHeight, noHorizontalScroll: scroll.scrollWidth === scroll.clientWidth };
  });
  form().style.width = '';
  await change(input('final'), '   ');
  const blankFinalBlocked = button('Save').disabled && button('Preview').disabled;
  block('final').querySelector('input').click();
  await frame();
  const finalExclusionAllowed = !button('Save').disabled && !button('Preview').disabled;
  await press('Restore block', block('final'));
  await press('Exclude all thinking');
  const noThinking = count();
  await press('Preview');
  const noThinkingKinds = blocks().map(row => row.dataset.contextKind);
  await press('Keep only final answer');
  const finalOnly = { count: count(), values: blocks().map(row => row.querySelector('pre').textContent) };
  await press('Cancel');
  const writesAfterCancel = writes.length;

  await open();
  await change(input('thinking'), 'Edited middle thinking');
  await change(input('text'), 'Edited middle text');
  await change(input('tool'), '[]');
  const invalidArgs = { save: button('Save').disabled, preview: button('Preview').disabled, alert: block('tool').querySelector('[role=alert]').textContent };
  await change(input('tool'), '{"path":"model-only.md"}');
  await change(input('tool', 1), 'Edited result');
  block('text').querySelector('input').click();
  await frame();
  await press('Preview');
  const preview = blocks().map(row => [...row.querySelectorAll('pre')].map(item => item.textContent));
  await press('Preview');
  heldWrite = Promise.withResolvers();
  form().requestSubmit();
  form().requestSubmit();
  await until(() => form()?.getAttribute('aria-busy'), 'save did not lock');
  const pending = { writes: writes.length, readOnly: input('tool').readOnly, cancelDisabled: button('Cancel').disabled };
  heldWrite.resolve('reject');
  await until(() => form()?.querySelector('footer [role=alert]'), 'save failure did not render');
  heldWrite = null;
  const afterFailure = { text: input('text').value, excluded: !block('text').querySelector('input').checked,
    message: form().querySelector('footer [role=alert]').textContent };
  await press('Save');
  await until(() => !form() && notice(), 'confirmed edit did not render the notice');
  const state = useAppStore.getState();
  const windows = [state.messages, state.retainedTranscripts[id], state.transcriptViews[id].messages].map(list => ({
    length: list.length, override: list.find(row => row.id === tool.id).contextOverride,
  }));
  const original = { final: state.messages.at(-1).content, tool: state.messages.find(row => row.id === tool.id).toolName,
    status: state.messages.find(row => row.id === tool.id).toolStatus, result: state.messages.find(row => row.id === tool.id).content };
  hydrate();
  await frame();
  const editedAfterReload = Boolean(notice());
  await open();
  const reopened = [input('text').value, input('tool', 1).value];
  block('text').querySelector('summary').click();
  const originalDetails = block('text').querySelector('details[open] pre').textContent;
  await press('Restore block', block('tool'));
  await press('Save');
  await until(() => !form(), 'one-block restore did not save');
  await open();
  await press('Restore originals');
  const restoration = { count: count(), text: input('text').value, writes: writes.length };
  await press('Save');
  await until(() => !form() && !notice(), 'whole-turn restore did not clear notice');
  hydrate();
  await frame();
  const clearAfterReload = !notice();

  heldRead = Promise.withResolvers();
  actions()[0].click();
  const staleReadStarted = reads.length;
  hydrate('other', [message('other-prompt')]);
  hydrate();
  heldRead.resolve();
  heldRead = null;
  await frame();
  const staleReadIgnored = !form();
  await open();
  await change(input('final'), 'Edited final answer');
  useAppStore.setState({ isRunning: true });
  await frame();
  const busyDisabled = button('Save').disabled;
  form().requestSubmit();
  const busyWrites = writes.length;
  useAppStore.setState({ isRunning: false });
  await until(() => !button('Save').disabled, 'idle did not unlock save');
  heldWrite = Promise.withResolvers();
  await press('Save');
  hydrate('other', [message('other-prompt')]);
  await frame();
  heldWrite.resolve();
  heldWrite = null;
  await until(() => persisted.has(answer.id), 'stale save did not settle');
  await frame();
  const staleSaveIgnored = !form() && useAppStore.getState().messages[0].id === 'other-prompt' && !notice();
  window.previewTurnContextEditor = async () => {
    hydrate();
    await frame();
    await open();
    await i18n.changeLanguage('zh-CN');
    const style = document.createElement('style');
    style.textContent = '.thread-scroll{width:780px;height:800px}[data-message-id]{height:auto;overflow:visible}';
    document.head.append(style);
    await frame();
    form().scrollIntoView({ block: 'center' });
    await frame();
    const { x, y, width, height } = form().getBoundingClientRect();
    return { x: x + window.scrollX, y: y + window.scrollY, width, height };
  };
  return { actionCount, forkCount, defaults, layout, noThinking, noThinkingKinds, finalOnly, writesAfterCancel,
    blankFinalBlocked, finalExclusionAllowed, invalidArgs, preview, pending, afterFailure, windows, original, editedAfterReload, reopened, originalDetails,
    restoration, clearAfterReload, staleReadStarted, staleReadIgnored, staleSaveIgnored, busyDisabled, busyWrites, reads, writes, errors };
}
