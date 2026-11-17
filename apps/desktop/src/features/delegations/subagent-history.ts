import type { SessionDetail, UiMessage } from "@pi-desktop/shared";
import { buildSubagentTranscript } from "../../lib/subagent-transcript";
import { delegationIdForMessage } from "../../lib/subagent-panel";
import { isDelegationStartTool } from "../../lib/tool-display";
import { extendTranscriptView, TRANSCRIPT_SEARCH_PAGE_SIZE, type TranscriptView } from "../../lib/transcript-reading";
import { preferRecordedTask } from "./session-delegation-tasks";

export function mergeSubagentHistory(recorded: readonly UiMessage[], ...sources: readonly UiMessage[][]): UiMessage[] {
  const merged = new Map(recorded.map(message => [message.id, message]));
  for (const source of sources) {
    for (const message of source) merged.set(message.id, preferRecordedTask(merged.get(message.id), message));
  }
  return [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Parent-session cursors do not prove that this delegate has unseen content. */
export function subagentHistoryAddsContent(known: readonly UiMessage[], candidate: readonly UiMessage[], delegationId: string): boolean {
  const next = buildSubagentTranscript(candidate, delegationId);
  if (!next) return false;
  const previous = buildSubagentTranscript(known, delegationId);
  if (!previous || next.chainId !== previous.chainId || next.latestCall.id !== previous.latestCall.id || next.turns.length > previous.turns.length) return true;
  const rows = new Set(previous.turns.flatMap(turn => turn.rows.map(row => `${row.kind}:${row.message.id}`)));
  return next.turns.some(turn => turn.rows.some(row => !rows.has(`${row.kind}:${row.message.id}`)));
}

const isTask = (message: UiMessage) => message.role === "tool" && isDelegationStartTool(message.toolName);
const taskLinks = (message: UiMessage) => {
  const args = message.toolArgs;
  const resume = args && typeof args === "object" && "resume" in args && typeof args.resume === "string" ? args.resume.trim() : "";
  return [message.toolCallId ?? "", delegationIdForMessage(message), resume].filter(Boolean);
};
// Cached promises also need a task boundary so disposal/input can interrupt a long scan.
const yieldToInput = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Read bounded physical pages until a button would reveal new child content. */
export async function findSubagentHistoryPage({ view, direction, delegationId, knownMessages, readPage, isCurrent, yieldControl = yieldToInput }: {
  view: TranscriptView;
  direction: "before" | "after";
  delegationId: string;
  knownMessages: () => UiMessage[];
  readPage: (before: number) => Promise<SessionDetail | undefined>;
  isCurrent: () => boolean;
  yieldControl?: () => Promise<void>;
}): Promise<TranscriptView | null> {
  let scanned: TranscriptView = { ...view, messages: [] };
  const records = new Map(view.messages.map(message => [message.id, message]));
  const tasks = new Map(view.messages.filter(isTask).map(message => [message.id, message]));
  let indexedKnown: UiMessage[] | undefined;
  let knownIds = new Set<string>();
  let callIds = new Set<string | undefined>();
  let links = new Set([delegationId]);
  let pages = 0;
  while (isCurrent() && (direction === "before" ? scanned.hasMoreBefore : scanned.hasMoreAfter)) {
    if (pages > 0 && pages % 16 === 0) {
      await yieldControl();
      if (!isCurrent()) return null;
    }
    const page = await readPage(direction === "before" ? scanned.messageStart : (scanned.messageEnd ?? 0) + TRANSCRIPT_SEARCH_PAGE_SIZE);
    if (!isCurrent()) return null;
    if (!page) throw new Error("Conversation unavailable");
    if (direction === "before" ? page.hasMoreBefore && (page.messageStart ?? 0) >= scanned.messageStart
      : page.hasMoreAfter && (page.messageEnd ?? 0) <= (scanned.messageEnd ?? 0)) throw new Error("History cursor did not advance");
    scanned = extendTranscriptView(scanned, { ...page, messages: [] }, direction);
    pages++;
    let tasksChanged = false;
    for (const message of page.messages) {
      // Keep orphan child rows until an earlier Task resolves their resume chain.
      // Unattributed parent prose is never rendered by this surface.
      if (message.role !== "tool" && !message.parentToolCallId) continue;
      if (direction === "before" && records.has(message.id)) continue;
      records.set(message.id, message);
      if (isTask(message)) {
        tasks.set(message.id, message);
        if (taskLinks(message).some(link => links.has(link))) tasksChanged = true;
      }
    }
    const known = knownMessages();
    if (known !== indexedKnown) {
      indexedKnown = known;
      knownIds = new Set(known.map(message => message.id));
      for (const message of known.filter(isTask)) tasks.set(message.id, preferRecordedTask(tasks.get(message.id), message));
      tasksChanged = true;
    }
    let chainChanged = false;
    if (tasksChanged) {
      const calls = buildSubagentTranscript(mergeSubagentHistory([...tasks.values()]), delegationId)?.calls ?? [];
      const nextIds = new Set(calls.map(call => call.toolCallId));
      chainChanged = [...nextIds].some(id => !callIds.has(id));
      callIds = nextIds;
      links = new Set([delegationId, ...calls.flatMap(taskLinks)]);
    }
    if (!chainChanged && !page.messages.some(message => message.parentToolCallId && callIds.has(message.parentToolCallId) && !knownIds.has(message.id))) continue;
    // Only materialize/sort when this page can change the selected chain.
    const messages = mergeSubagentHistory([...records.values()]);
    if (subagentHistoryAddsContent(known, mergeSubagentHistory(messages, known), delegationId)) return { ...scanned, messages };
  }
  return null;
}
