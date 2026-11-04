import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { I18nextProvider } from "react-i18next";
import i18n from "i18next";
import { en } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared/protocol";
import type { Result, SessionSummary, UiMessage } from "@pi-desktop/shared";
import { ChatSurface } from "../../apps/desktop/src/components/ChatSurface";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { getTranscriptReadingPosition } from "../../apps/desktop/src/lib/transcript-reading-position";

const createdAt = "2026-09-01T00:00:00Z";
const messages: UiMessage[] = Array.from({ length: 400 }, (_, index) => ({
  id: `switch-m${index}`, role: "user", content: `Message ${index}. ${"Reading content. ".repeat(20)}`,
  createdAt, status: "complete",
}));
const sessions: SessionSummary[] = ["switch-A", "switch-B", "switch-empty"].map((id) => ({
  id, title: id, mode: "agent", permissionMode: "ask", thinkingLevel: "off",
  providerId: "fixture", modelId: "fixture", createdAt, updatedAt: createdAt, messageCount: id === "switch-empty" ? 0 : messages.length,
}));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}
async function until(predicate: () => boolean, label: string) {
  for (let index = 0; index < 180; index++) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(`Timed out: ${label}`);
}

declare global { var transcriptSwitchRestorationProbe: () => Promise<unknown>; }
globalThis.transcriptSwitchRestorationProbe = async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const initial = useAppStore.getState();
  const bridge = window.piDesktop;
  let firstRead = true;
  let releasePage: (() => void) | undefined;
  let heldPage: Promise<void> | undefined;
  let pageReads = 0;
  const unexpected: string[] = [];
  const holdPage = () => { heldPage = new Promise<void>((resolve) => { releasePage = resolve; }); };
  window.piDesktop = {
    channels: IPC, platform: "win32", on: () => () => {},
    invoke: async <T,>(channel: string, ...args: unknown[]): Promise<Result<T>> => {
      let data: unknown;
      if (channel === IPC.invoke.sessionGet) {
        const input = args[0];
        assert(input && typeof input === "object" && "id" in input, "invalid session read");
        const session = sessions.find((candidate) => candidate.id === input.id);
        assert(session, "unexpected session");
        let start = 350;
        let end = messages.length;
        if ("messageBefore" in input && typeof input.messageBefore === "number") {
          pageReads++;
          const waiting = heldPage;
          if (waiting) await waiting;
          end = input.messageBefore;
          start = Math.max(0, end - 100);
        } else if (input.id === "switch-A" && firstRead) {
          firstRead = false;
          start = 150;
        }
        if (input.id === "switch-empty") { start = 0; end = 0; }
        data = { session: { ...session, messages: messages.slice(start, end), messageStart: start,
          messageEnd: end, hasMoreBefore: start > 0, hasMoreAfter: false } };
      } else if (channel === IPC.invoke.plansPending) data = { plans: [], state: "inactive" };
      else if (channel === IPC.invoke.pendingInteractive) data = { permissions: [], asks: [] };
      else if (channel === IPC.invoke.agentQueueList) data = { entries: [] };
      else if (channel === IPC.invoke.settingsGet) data = initial.settings;
      else if (channel === IPC.invoke.liveVoiceStatus) data = { enabled: false, settingsRevision: 0, bindings: [], call: null };
      else if (channel === IPC.invoke.backgroundTasksList) data = { tasks: [], version: 0 };
      else if (channel === IPC.invoke.todosGet) {
        const input = args[0];
        assert(input && typeof input === "object" && "sessionId" in input, "invalid checklist request");
        data = { sessionId: input.sessionId, todos: [], revision: 0, updatedAt: 0 };
      }
      else if (channel === IPC.invoke.notificationMarkRead || channel === IPC.invoke.notificationSetViewingSession) data = { ok: true };
      else {
        unexpected.push(channel);
        return { ok: false, error: { code: "FIXTURE_UNEXPECTED", message: `Unexpected IPC ${channel}` } };
      }
      return { ok: true, data: data as T };
    },
  };
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column";
  document.body.append(host);
  const root = createRoot(host);
  const select = async (id: string) => { await useAppStore.getState().selectSession(id); await frame(); };
  const scroller = () => host.querySelector<HTMLDivElement>('[data-visible="true"] .thread-scroll')!;
  const rows = () => [...scroller().querySelectorAll<HTMLElement>("[data-message-id]")];
  const offset = (id: string) => {
    const node = scroller().querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    return node ? node.getBoundingClientRect().top - scroller().getBoundingClientRect().top : Infinity;
  };
  const bottom = () => Math.abs(scroller().scrollHeight - scroller().clientHeight - scroller().scrollTop) < 2;
  try {
    useAppStore.setState({
      sessions, messages: [], activeSessionId: undefined, selectingSessionId: undefined,
      retainedSessionIds: [], retainedTranscripts: {}, transcriptViews: {}, sessionHistory: {},
      sessionCompactions: {}, providers: [], providerModels: {}, pendingPlans: {}, pendingAsks: {},
      pendingPermissions: {}, planningStates: {}, runningSessions: {}, isRunning: false,
      workspace: undefined, queuedPrompts: {}, notifications: [], page: "chat",
      settings: { ...initial.settings, smoothStreaming: false },
    });
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><ChatSurface /></I18nextProvider>));
    await select("switch-A");
    await until(() => !host.querySelector('[data-transcript-settling="true"]') && bottom(), "long conversation settles");
    const mountedBefore = rows().length;
    scroller().dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -500 }));
    scroller().scrollTop = 650;
    scroller().dispatchEvent(new Event("scroll", { bubbles: true }));
    await frame();
    const anchor = rows().find((node) => node.getBoundingClientRect().bottom > scroller().getBoundingClientRect().top)!;
    const anchorId = anchor.dataset.messageId!;
    const expectedOffset = offset(anchorId);
    holdPage();
    const loading = useAppStore.getState().loadTranscriptPage("switch-A", "before");
    await select("switch-B");
    await select("switch-A");
    await until(() => Math.abs(offset(anchorId) - expectedOffset) < 2, "pending page preserves the warm reading position");
    assert(getTranscriptReadingPosition("switch-A")?.pinned === false, "pending paging changed the bookmark to follow mode");
    assert(useAppStore.getState().transcriptViews["switch-A"]?.loading === "before", "revalidation cancelled the pending page");
    releasePage!(); heldPage = undefined; releasePage = undefined;
    await loading;
    await until(() => Math.abs(offset(anchorId) - expectedOffset) < 2, "page completion preserves the same reading anchor");
    await select("switch-B");
    await select("switch-A");
    await until(() => Math.abs(offset(anchorId) - expectedOffset) < 2, "settled warm return preserves the anchor");
    const mountedAfter = rows().length;
    assert(mountedAfter <= mountedBefore, `restoration expanded mounted rows: ${mountedBefore} -> ${mountedAfter}`);
    assert(getTranscriptReadingPosition("switch-A")?.windowSize === 60, "restoration changed the saved window budget");
    console.error("SESSION_SWITCH_STAGE reading position and mount budget passed");
    const retainedScroller = scroller();
    await select("switch-empty");
    assert(host.querySelector('[data-testid="home-empty"]'), "empty session did not reveal the home surface");
    assert(host.contains(retainedScroller), "empty session unmounted the retained long conversation");
    await select("switch-A");
    assert(scroller() === retainedScroller, "returning from empty home rebuilt the transcript");
    await until(() => Math.abs(offset(anchorId) - expectedOffset) < 2, "empty-home return preserves the anchor");
    console.error("SESSION_SWITCH_STAGE empty home preserves mounted panes");

    holdPage();
    const latePage = useAppStore.getState().loadTranscriptPage("switch-A", "before");
    await frame();
    const jump = host.querySelector<HTMLButtonElement>('[data-visible="true"] .jump-latest-btn');
    assert(jump, "return-to-latest control is missing during paging");
    jump.click();
    await until(() => !useAppStore.getState().transcriptViews["switch-A"] && bottom(), "return-to-latest exits paging and reaches the latest row");
    releasePage!(); heldPage = undefined; releasePage = undefined;
    await latePage;
    await frame(); await frame();
    assert(bottom(), "the obsolete page reclaimed the viewport after return-to-latest");
    assert(!useAppStore.getState().transcriptViews["switch-A"], "the obsolete page recreated a reading view");
    assert(getTranscriptReadingPosition("switch-A")?.pinned === true, "return-to-latest did not persist follow intent");
    assert(unexpected.length === 0, `unexpected IPC: ${unexpected}`);
    console.error("SESSION_SWITCH_STAGE return-to-latest and obsolete page passed");
    return { ok: true, anchorId, expectedOffset, mountedBefore, mountedAfter, pageReads };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.stack : String(error), unexpected, pageReads };
  } finally {
    releasePage?.();
    flushSync(() => root.unmount());
    host.remove();
    window.piDesktop = bridge;
    useAppStore.setState(initial);
  }
};
