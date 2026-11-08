import type { AssistantTurnEntry, AssistantTurnPart, SubagentRunItem } from "./assistant-turns";
import type { UiMessage } from "@pi-desktop/shared";
import type { SubagentTranscriptTurn } from "./subagent-transcript";

type SubagentReadingEntry = AssistantTurnEntry | { kind: "message"; message: UiMessage };

/** A direct child message starts a new response without becoming assistant activity. */
export function subagentTurnEntries(id: string, rows: readonly SubagentTranscriptTurn["rows"][number][]): SubagentReadingEntry[] {
  const entries: SubagentReadingEntry[] = [];
  let segmentId = `${id}:initial`;
  let assistantRows: SubagentRunItem[] = [];
  const flush = () => {
    if (assistantRows.length) entries.push(subagentTurnEntry(segmentId, assistantRows));
    assistantRows = [];
  };
  for (const row of rows) {
    if (row.kind === "user") {
      flush();
      entries.push({ kind: "message", message: row.message });
      segmentId = `${id}:after:${row.message.id}`;
    } else assistantRows.push(row);
  }
  flush();
  return entries;
}

/** Project the delegate's recorded rows into the same reading model as its parent. */
export function subagentTurnEntry(id: string, rows: readonly SubagentRunItem[]): AssistantTurnEntry {
  const parts: AssistantTurnPart[] = [];
  for (const row of rows) {
    if (row.kind === "answer") {
      parts.push({ kind: "message", message: row.message });
      continue;
    }
    const previous = parts.at(-1);
    if (previous?.kind === "activity") previous.items.push(row);
    else parts.push({ kind: "activity", items: [row] });
  }
  return { kind: "assistant-turn", id, anchorId: rows[0]?.message.id, parts };
}
