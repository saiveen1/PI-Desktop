import type { AssistantTurnEntry, AssistantTurnPart, SubagentRunItem } from "./assistant-turns";

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
