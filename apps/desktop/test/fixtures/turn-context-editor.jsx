import { flushSync } from 'react-dom';
import { I18nextProvider } from 'react-i18next';
import { IPC } from '@pi-desktop/shared';
import { ChatTranscript } from '../../src/features/chat/transcript/ChatTranscript';
import { useTranscriptView } from '../../src/hooks/use-transcript-view';
import { useAppStore } from '../../src/stores/app-store';

export async function exerciseTurnContext({ root, i18n, message, frame, until }) {
  const id = 'context-edit';
  const answer = { ...message('answer'), role: 'assistant', content: 'Original final answer', thinking: 'Final thinking' };
  const middle = { ...message('middle'), role: 'assistant', content: 'Original intermediate text', thinking: 'Middle thinking' };
  const tool = { ...message('tool'), role: 'tool', content: 'Original tool result', toolCallId: 'call-1',
    toolName: 'Read', toolArgs: { path: 'notes.md' }, toolStatus: 'success', toolResult: { details: { path: 'notes.md', content: 'Original tool result' } } };
  const rows = [message('older-prompt'), { ...message('older-answer'), role: 'assistant' }, message('prompt'), middle, tool, answer];
  const snapshotRows = [middle, tool, answer].map(row => ({ messageId: row.id, role: row.role, final: row === answer,
    content: row.role === 'assistant' ? row.content : '', thinking: row.thinking, hasThinking: Boolean(row.thinking),
    toolName: row.toolName, toolArgs: row.toolArgs, toolResultText: row.role === 'tool' ? row.content : undefined }));
  const writes = [], reads = [], errors = [], persisted = new Map();
  let revision = 0, heldRead, heldWrite;
  const readSnapshot = () => ({ sessionId: id, anchorMessageId: answer.id, revision: String(revision), isLatestTurn: true,
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
  useAppStore.setState(state => ({ settings: { ...state.settings, transcriptDisplayMode: 'flat' } }));
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
  const processToggle = () => form().querySelector('button[aria-controls]');
  const expand = async () => { processToggle().click(); await frame(); };
  const open = async () => {
    document.querySelector('[data-message-id="answer"].message-bubble').closest('[role=article]')
      .querySelector('button[aria-label="Edit context"]').click();
    await until(form, 'context editor did not open');
  };
  const change = async (field, value) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await frame();
  };
  const actionCount = actions().length;
  const forkCount = document.querySelectorAll(`button[aria-label="${i18n.t('chat.forkResponse')}"]`).length;
  await open();
  const initialFocus = document.activeElement?.getAttribute('aria-label');
  const collapsed = { kinds: blocks().map(row => row.dataset.contextKind), expanded: processToggle().getAttribute('aria-expanded'),
    label: processToggle().textContent, focusedFinal: document.activeElement === input('final') };
  await expand();
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
  await press(i18n.t('turnContext.excludeThinking'));
  const noThinking = count();
  await press('Preview');
  const noThinkingKinds = blocks().map(row => row.dataset.contextKind);
  await press('Keep only final answer');
  const finalOnly = { count: count(), values: blocks().map(row => row.querySelector('pre').textContent) };
  await press('Cancel');
  const writesAfterCancel = writes.length;

  await open();
  await expand();
  await change(input('thinking'), 'Edited middle thinking');
  await change(input('final'), '**Edited final answer**');
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
  const bubble = () => document.querySelector('.message-bubble[data-message-id="answer"]');
  const confirmed = { body: bubble().querySelector('.prose-chat')?.textContent,
    bold: Boolean(bubble().querySelector('strong')), disclosure: bubble().querySelector('summary')?.textContent ?? null };
  const copy = () => bubble().closest('[role=article]').querySelector(`.message-actions button[aria-label="${i18n.t('chat.copy')}"]`);
  let copied;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { copied = text; } } });
  copy().click();
  const originalClosed = !bubble().querySelector('details').open;
  bubble().querySelector('summary').click();
  const revealed = bubble().querySelector('details[open] pre').innerText;
  const turn = bubble().closest('[role=article]');
  turn.querySelector('.turn-process > button[aria-expanded="false"]')?.click();
  await frame();
  const toolRow = turn.querySelector('.tool-row[data-message-id="tool"]');
  toolRow.querySelector('.tool-row-header').click();
  await until(() => toolRow.querySelector('.tool-row-body'), 'recorded tool result did not open');
  const receipt = { middle: turn.querySelector('[data-message-id="middle"].message-bubble .prose-chat')?.innerText,
    path: toolRow.querySelector('.tool-row-summary')?.textContent, result: toolRow.querySelector('.tool-row-body').innerText,
    hasOverlay: turn.innerText.includes('model-only.md') || turn.innerText.includes('Edited result') };
  const state = useAppStore.getState();
  const windows = [state.messages, state.retainedTranscripts[id], state.transcriptViews[id].messages].map(list => ({
    length: list.length, override: list.find(row => row.id === tool.id).contextOverride,
  }));
  const original = { final: state.messages.at(-1).content, tool: state.messages.find(row => row.id === tool.id).toolName,
    status: state.messages.find(row => row.id === tool.id).toolStatus, result: state.messages.find(row => row.id === tool.id).content };
  hydrate('other', [message('other-prompt')]);
  await frame();
  hydrate(id, [...reloaded(), message('later-prompt'), { ...message('later-answer'), role: 'assistant' }]);
  await until(bubble, 'historical answer did not mount');
  const historical = { body: bubble().querySelector('strong')?.textContent, closed: !bubble().querySelector('details').open,
    pencil: Boolean(bubble().closest('[role=article]').querySelector('button[aria-label="Edit context"]')) };
  hydrate('other', [message('other-prompt')]);
  await until(() => !bubble(), 'historical answer did not unmount');
  hydrate();
  await until(() => bubble()?.closest('[role=article]').querySelector('button[aria-label="Edit context"]'), 'latest answer did not reopen');
  const editedAfterReload = Boolean(notice());
  await open();
  await expand();
  const reopened = [input('final').value, input('text').value, input('tool', 1).value];
  block('text').querySelector('summary').click();
  const originalDetails = block('text').querySelector('details[open] pre').textContent;
  await press('Restore block', block('tool'));
  await press('Save');
  await until(() => !form(), 'one-block restore did not save');
  await open();
  await change(input('final'), '');
  block('final').querySelector('input').click();
  await frame();
  await press('Save');
  await until(() => !form(), 'empty excluded final did not save');
  const excluded = { label: bubble().querySelector('.turn-context-notice')?.innerText, copy: Boolean(copy()),
    originalHidden: !bubble().innerText.includes('Original final answer'), noProse: !bubble().querySelector('.prose-chat') };
  bubble().querySelector('summary').click();
  excluded.original = bubble().querySelector('details[open] pre').innerText;
  await open();
  await expand();
  await press('Restore originals');
  const restoration = { count: count(), text: input('text').value, writes: writes.length };
  await press('Save');
  await until(() => !form() && !notice(), 'whole-turn restore did not clear notice');
  hydrate();
  await frame();
  const clearAfterReload = !notice() && !bubble().querySelector('details') && bubble().querySelector('.prose-chat')?.innerText === 'Original final answer';

  heldRead = Promise.withResolvers();
  actions().at(-1).click();
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
  window.openKeyboardEditor = async () => {
    hydrate();
    await frame();
    await open();
  };
  window.previewTurnContextEditor = async () => {
    await window.openKeyboardEditor();
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
    initialFocus, confirmed, collapsed, copied, originalClosed, revealed, receipt, historical, excluded,
    blankFinalBlocked, finalExclusionAllowed, invalidArgs, preview, pending, afterFailure, windows, original, editedAfterReload, reopened, originalDetails,
    restoration, clearAfterReload, staleReadStarted, staleReadIgnored, staleSaveIgnored, busyDisabled, busyWrites, reads, writes, errors };
}

export async function exerciseHistoricalTurnContext({ root, i18n, message, frame, until }) {
  await i18n.changeLanguage('en');
  const id = 'historical-context-edit';
  const reply = (id, extra = {}) => ({ ...message(id), role: 'assistant', ...extra });
  const old = reply('old-context-answer', { contextOverride: { version: 1, thinking: 'Edited old reasoning', excludeThinking: false } });
  const opaque = reply('opaque-context-answer', { providerReplay: { version: 1, blocks: [{ type: 'thinking', length: 0, signature: 'fixture' }] } });
  const nested = reply('nested-context-row', { thinking: 'Nested reasoning', parentToolCallId: 'old-task' });
  const tool = { ...message('old-tool-row'), role: 'tool', toolName: 'Task', toolCallId: 'old-task', thinking: 'Not assistant reasoning' };
  const plain = reply('plain-context-answer');
  const latest = reply('latest-context-answer', { thinking: 'Recent reasoning' });
  const future = reply('future-context-answer', { thinking: 'Future reasoning' });
  let rows = [message('old-context-prompt'), old, message('opaque-context-prompt'), tool, nested, opaque,
    message('plain-context-prompt'), plain, message('latest-context-prompt'), latest];
  let revision = 0;
  const writes = [], historyReads = [];
  const persisted = new Map([[old.id, old.contextOverride]]);
  const canonical = (row) => ({ ...row, contextOverride: persisted.get(row.id) });
  const snapshot = (row) => ({ sessionId: id, anchorMessageId: row.id, revision: String(revision),
    isLatestTurn: rows.at(-1) === row, messages: [{ messageId: row.id, role: row.role, final: true,
      content: row.content, thinking: row.thinking, hasThinking: Boolean(row.thinking), override: persisted.get(row.id) }] });
  const allowRefresh = Promise.withResolvers();
  window.piDesktop = { invoke: async (channel, input) => {
    if (channel === IPC.invoke.sessionGet) {
      historyReads.push(input);
      if (revision === 2) await allowRefresh.promise;
      const end = revision === 0 && input.messageAround === old.id ? rows.length - 2 : Math.min(input.messageBefore ?? rows.length, rows.length);
      const start = Math.max(0, end - input.messageLimit);
      return { ok: true, data: { session: { id, source: 'desktop', messages: rows.slice(start, end).map(canonical),
        messageStart: start, messageEnd: end, hasMoreBefore: start > 0, hasMoreAfter: end < rows.length } } };
    }
    const anchor = rows.find(row => row.id === input.anchorMessageId);
    if (channel === IPC.invoke.sessionGetTurnContext) return { ok: true, data: { snapshot: snapshot(anchor) } };
    if (channel !== IPC.invoke.sessionEditTurnContext) throw Error(`Unexpected ${channel}`);
    writes.push(input);
    if (input.expectedRevision !== String(revision) || (input.excludeHistoryThinking && anchor !== latest)) throw Error('Invalid fixture edit');
    for (const { messageId, contextOverride } of input.edits) persisted.set(messageId, contextOverride);
    if (input.excludeHistoryThinking) {
      for (const row of [old, opaque, latest]) persisted.set(row.id, { version: 1, ...persisted.get(row.id), excludeThinking: true });
    }
    // Like the real Host, never return older rows in a bulk mutation response.
    const updates = [{ messageId: anchor.id, contextOverride: persisted.get(anchor.id) }];
    revision++;
    return { ok: true, data: { updates, snapshot: snapshot(anchor) } };
  } };
  const tail = rows.slice(-2);
  useAppStore.setState({ page: 'chat', activeSessionId: id, isRunning: false, messages: tail,
    sessions: [{ id, source: 'desktop' }], retainedSessionIds: [id], retainedTranscripts: { [id]: tail }, transcriptViews: {},
    sessionHistory: { [id]: { messageStart: rows.length - tail.length, hasMoreBefore: true } } });
  function Conversation() {
    const view = useTranscriptView(id);
    return <ChatTranscript sessionId={id} messages={view.messages} searchTarget={view.focus} isRunning={false}
      hasMoreAfter={view.hasMoreAfter} readingWindow={view.historical} liveTail={view.liveTail} />;
  }
  flushSync(() => root.render(<I18nextProvider i18n={i18n}><Conversation /></I18nextProvider>));
  const state = () => useAppStore.getState();
  const bubble = (id) => document.querySelector(`.message-bubble[data-message-id="${id}"]`);
  const form = () => document.querySelector('.turn-context-editor');
  const button = (label) => [...form().querySelectorAll('button')].find(element => element.textContent === label);
  const press = async (label) => { button(label).click(); await frame(); };
  const checkbox = () => form().querySelector('header input[aria-describedby$="-history-thinking"]');
  const toggle = async () => { checkbox().click(); await frame(); };
  const count = () => form().querySelector('.turn-context-count').textContent;
  const open = async (id) => {
    await until(() => {
      const edit = bubble(id)?.closest('[role=article]').querySelector('button[aria-label="Edit context"]');
      if (!edit || edit.disabled) return false;
      edit.click();
      return true;
    }, `edit action for ${id} did not appear`);
    await until(form, `context editor for ${id} did not open`);
  };

  await state().navigateTranscript({ sessionId: id, messageId: old.id, query: old.content });
  const paged = state().transcriptViews[id].hasMoreAfter && !state().messages.some(row => row.id === old.id);
  await open(old.id);
  const historicalOption = Boolean(checkbox());
  const field = form().querySelector('[data-context-kind=final] textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'Edited historical answer');
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await frame();
  await press('Save');
  await until(() => !form() && bubble(old.id)?.querySelector('.prose-chat')?.textContent === 'Edited historical answer', 'historical edit did not render');
  const suffixIntact = state().messages === tail && state().activeSessionId === id;
  const sameFocus = state().transcriptViews[id].focus?.messageId === old.id;
  await state().loadTranscriptPage(id, 'after');
  // Returning from the search window moves the answer between transcript regions.
  // Commit that transition before opening an editor tied to the mounted row.
  flushSync(() => state().returnToLatestTranscript(id));
  await frame();
  await open(latest.id);
  const defaultOff = !checkbox().checked && button('Save').disabled;
  await toggle();
  await press('Preview');
  const preview = { blocks: [...form().querySelectorAll('[data-context-kind]')].map(row => row.dataset.contextKind), count: count(),
    scope: document.getElementById(checkbox().getAttribute('aria-describedby')).textContent };
  await toggle();
  const undone = { count: count(), disabled: button('Save').disabled, writes: writes.length };
  await toggle();
  await press('Restore originals');
  const restored = !checkbox().checked && button('Save').disabled;
  await toggle();
  await press('Cancel');
  const canceled = writes.length;
  await open(latest.id);
  const reopenedOff = !checkbox().checked;
  await toggle();
  await press('Save');
  await until(() => historyReads.length === 3, 'confirmed bulk save did not request a bounded history refresh');
  // A fresh turn can arrive once Host commits, even if the UI's read is still pending.
  const futurePrompt = message('future-context-prompt');
  rows = [...rows, futurePrompt, future];
  useAppStore.setState({ messages: [...state().messages, futurePrompt, future] });
  allowRefresh.resolve();
  const loaded = () => state().transcriptViews[id].messages;
  await until(() => loaded().find(row => row.id === opaque.id)?.contextOverride?.excludeThinking === true, 'older flags did not refresh');
  const visible = Object.fromEntries([old, opaque, nested, tool, plain].map(({ id }) => [id, loaded().find(row => row.id === id).contextOverride ?? null]));
  const followup = state().messages.at(-1) === future && !state().messages.at(-1).contextOverride;
  const savedLatest = state().messages.find(row => row.id === latest.id).contextOverride;
  return { paged, historicalOption, suffixIntact, sameFocus, defaultOff, preview, undone, restored, canceled, reopenedOff,
    visible, followup, savedLatest, writes, historyReads };
}

export async function exerciseContextBoundary({ root, i18n, message, frame, until }, restarting = false) {
  await i18n.changeLanguage('en');
  const id = 'boundary-edit';
  const answer = (id) => ({ ...message(id), role: 'assistant', thinking: 'Recorded reasoning' });
  const rows = [message('prefix'), message('first-prompt'),
    { ...message('first-tool'), role: 'tool', toolCallId: 'call-old', toolName: 'Read', toolStatus: 'success', toolArgs: { path: 'first.md' } },
    answer('first-answer'), message('prior-prompt'), answer('prior-answer'),
    message('cut-prompt'), answer('cut-answer'), message('suffix-prompt'), answer('suffix-answer')];
  const other = [message('unrelated-pane')];
  const journal = restarting ? JSON.parse(sessionStorage.getItem(id)) : { revision: 0, overrides: {} };
  const overrides = journal.overrides;
  const source = { id, title: 'Source conversation', source: 'desktop' };
  const reads = [], writes = [], forks = [];
  const canonical = (branch = rows) => {
    const cut = branch.findLastIndex(row => overrides[row.id]?.excludePreviousTurns === true);
    return branch.map((row, i) => ({ ...row, contextOverride: overrides[row.id], excludedByContextBoundary: i < cut || undefined }));
  };
  const snapshot = index => ({ sessionId: id, anchorMessageId: rows[index].id, revision: String(journal.revision),
    isLatestTurn: index === rows.length - 1, excludePreviousTurns: overrides[rows[index - 1].id]?.excludePreviousTurns === true,
    messages: [{ messageId: rows[index].id, role: 'assistant', final: true, content: rows[index].content,
      thinking: rows[index].thinking, hasThinking: true, override: overrides[rows[index].id] }] });
  const ok = data => ({ ok: true, data });
  let holdBefore;
  window.piDesktop = { invoke: async (channel, input) => {
    if (channel === IPC.invoke.sessionGet) {
      reads.push(input);
      if (input.messageLimit === undefined) throw Error('Unexpected full hydration');
      const oldPage = input.messageAround === 'first-answer' && input.messageLimit === 60;
      const start = oldPage ? 1 : input.messageAround === 'cut-answer' && input.messageLimit === 60 ? 1 : 0;
      const end = oldPage ? 5 : Math.min(input.messageBefore ?? rows.length, rows.length);
      const response = ok({ session: { ...source, messages: canonical().slice(start, end),
        messageStart: start, messageEnd: end, hasMoreBefore: start > 0, hasMoreAfter: end < rows.length } });
      if (holdBefore && input.messageBefore === 1) await holdBefore.promise;
      return response;
    }
    if (channel === IPC.invoke.sessionFork) {
      forks.push(input);
      return ok({ session: { ...source, id: 'excluded-fork', messages: canonical(rows.slice(0, 4)) } });
    }
    if (channel === IPC.invoke.plansPending) return ok({ plans: [] });
    if (channel === IPC.invoke.pendingInteractive) return ok({ asks: [], permissions: [] });
    const index = rows.findIndex(row => row.id === input.anchorMessageId);
    if (channel === IPC.invoke.sessionGetTurnContext) return ok({ snapshot: snapshot(index) });
    if (channel !== IPC.invoke.sessionEditTurnContext || input.expectedRevision !== String(journal.revision)) throw Error('Unexpected edit');
    writes.push(input);
    const updates = input.restore ? [{ messageId: rows[index].id, contextOverride: null }] : [...input.edits];
    if (input.excludePreviousTurns !== undefined) updates.push({ messageId: rows[index - 1].id,
      contextOverride: input.excludePreviousTurns ? { version: 1, excludePreviousTurns: true } : null });
    for (const { messageId, contextOverride } of updates) {
      if (contextOverride) overrides[messageId] = contextOverride;
      else delete overrides[messageId];
    }
    journal.revision++;
    return ok({ updates, snapshot: snapshot(index) });
  } };
  const state = useAppStore.getState;
  const tailStart = restarting ? 6 : 3;
  useAppStore.setState(state => ({ page: 'chat', activeSessionId: id, isRunning: false, messages: canonical().slice(tailStart),
    sessions: [source, { id: 'other-boundary-pane', source: 'desktop' }], retainedSessionIds: [id, 'other-boundary-pane'],
    sessionHistory: { [id]: { messageStart: tailStart, hasMoreBefore: true } }, transcriptViews: {},
    settings: { ...state.settings, transcriptDisplayMode: 'flat' } }));
  useAppStore.setState({ retainedTranscripts: { [id]: canonical().slice(0, 7), 'other-boundary-pane': other } });
  function Conversation() {
    const active = useAppStore(state => state.activeSessionId);
    const view = useTranscriptView(active);
    return <ChatTranscript key={active} sessionId={active} messages={view.messages} searchTarget={view.focus} isRunning={false}
      hasMoreAfter={view.hasMoreAfter} readingWindow={view.historical} liveTail={view.liveTail} />;
  }
  flushSync(() => root.render(<I18nextProvider i18n={i18n}><Conversation /></I18nextProvider>));
  const marked = '[data-excluded-by-context-boundary]';
  const row = messageId => document.querySelector(`[data-message-id="${messageId}"]`);
  const article = messageId => row(messageId)?.closest('[role=article]');
  const form = () => document.querySelector('.turn-context-editor');
  const boundary = () => form().querySelector('input[aria-describedby$="-previous-turns"]');
  const button = label => [...form().querySelectorAll('button')].find(element => element.textContent === label);
  const navigate = messageId => state().navigateTranscript({ sessionId: id, messageId, query: '' });
  const open = async messageId => {
    await until(() => article(messageId)?.querySelector('button[aria-label="Edit context"]'), `missing edit action for ${messageId}`);
    article(messageId).querySelector('button[aria-label="Edit context"]').click();
    await until(form, `missing editor for ${messageId}`);
  };
  const save = async () => {
    button('Save').click();
    await until(() => !form(), 'boundary save did not settle');
  };
  const toggle = async () => { boundary().click(); await frame(); };
  const flags = messages => messages.filter(row => row.excludedByContextBoundary).map(row => row.id);

  if (restarting) {
    await navigate('first-answer');
    await until(() => article('first-answer')?.matches(marked), 'old page did not show its host-derived exclusion after reload');
    const oldPage = { ids: state().transcriptViews[id].messages.map(row => row.id),
      marked: flags(state().transcriptViews[id].messages), labels: [...document.querySelectorAll('.context-boundary-label')].map(label => label.textContent) };
    await navigate('cut-answer');
    await open('cut-answer');
    const persisted = boundary().checked && button('Save').disabled;
    await toggle();
    await save();
    const earlierCut = { prior: row('prior-prompt').matches('[data-context-boundary-start]'),
      kept: !row('prior-prompt').matches(marked) && !article('prior-answer').matches(marked), old: article('first-answer').matches(marked) };
    await open('prior-answer');
    await toggle();
    await save();
    return { oldPage, persisted, earlierCut, writes, cleared: document.querySelectorAll(`${marked}, [data-context-boundary-start]`).length === 0 };
  }

  await navigate('cut-answer');
  await open('prior-answer');
  const initiallyOff = !boundary().checked && button('Save').disabled;
  await toggle();
  await save();
  await open('cut-answer');
  const historicalOption = [...form().querySelectorAll('header input')].length === 1 && !boundary().checked;
  await toggle();
  button(i18n.t('turnContext.excludeThinking')).click();
  await frame();
  const localThinkingIndependent = boundary().checked;
  button('Keep only final answer').click();
  await frame();
  const finalOnlyIndependent = boundary().checked;
  const focus = state().transcriptViews[id].focus;
  holdBefore = Promise.withResolvers();
  const stalePage = state().loadTranscriptPage(id, 'before');
  await save();
  holdBefore.resolve();
  await stalePage;
  const view = state().transcriptViews[id];
  const stalePageIgnored = !view.loading && view.focus === focus && view.messageStart === 1 && !view.messages.some(row => row.id === 'prefix');
  const windows = [state().messages, state().retainedTranscripts[id], view.messages].map(flags);
  const suffix = !article('suffix-answer').matches(marked) && !row('cut-prompt').matches(marked) &&
    row('cut-prompt').matches('[data-context-boundary-start]') && !article('cut-answer').matches(marked);
  const unrelatedUntouched = state().retainedTranscripts['other-boundary-pane'] === other;
  const earlier = article('first-answer');
  earlier.querySelector('.turn-process > button[aria-expanded="false"]')?.click();
  await until(() => row('first-tool'), 'excluded tool row did not render');
  const tool = row('first-tool');
  const marker = { tool: tool.matches(marked), oldPrompt: row('first-prompt').matches(marked), oldReply: earlier.matches(marked),
    toolLabel: tool.getAttribute('aria-description'), text: earlier.querySelector('.context-boundary-label')?.textContent,
    divider: getComputedStyle(row('cut-prompt')).borderBlockStartStyle, subdued: getComputedStyle(earlier).boxShadow !== 'none' };
  await open('cut-answer');
  const reopened = boundary().checked && button('Save').disabled;
  button('Restore originals').click();
  const restoreIndependent = boundary().checked;
  await frame();
  await save();
  const restoredStillExcluded = row('cut-prompt').matches('[data-context-boundary-start]') && article('prior-answer').matches(marked);
  earlier.querySelector(`button[aria-label="${i18n.t('chat.forkResponse')}"]`).click();
  await until(() => state().activeSessionId === 'excluded-fork', 'Fork from the excluded prefix did not open the branch');
  const forkMessages = state().messages;
  sessionStorage.setItem(id, JSON.stringify(journal));
  return { initiallyOff, historicalOption, localThinkingIndependent, finalOnlyIndependent, stalePageIgnored, windows, suffix, unrelatedUntouched,
    marker, reopened, restoreIndependent, restoredStillExcluded, writes, reads, forks,
    branch: { ids: forkMessages.map(row => row.id), marked: flags(forkMessages) } };
}
