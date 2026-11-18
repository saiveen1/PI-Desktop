import type { AssistantTurnPart } from "./assistant-turns";
import { isAskToolName } from "./tool-display";
import { askToolResultBlock, type ToolBlock } from "./tool-presentation";

type Section =
  | { kind: "work"; key: string; parts: AssistantTurnPart[] }
  | { kind: "ask"; key: string; block: Extract<ToolBlock, { kind: "asktool" }> };

/** Keep user decisions in reading order, outside the disclosures for surrounding work. */
export function splitAtAnsweredQuestions(parts: readonly AssistantTurnPart[]): Section[] {
  const sections: Section[] = [];
  let work: AssistantTurnPart[] = [];
  // A section's identity follows the preceding decision, not its changing first row.
  let key = "";
  const flush = () => {
    if (work.length) sections.push({ kind: "work", key, parts: work });
    work = [];
  };
  for (const part of parts) {
    if (part.kind === "message") {
      work.push(part);
      continue;
    }
    let start = 0;
    for (const [index, item] of part.items.entries()) {
      const { message } = item;
      if (
        item.kind !== "tool" || !isAskToolName(message.toolName) || message.isError || message.error ||
        (message.status !== undefined && message.status !== "complete") ||
        (message.toolStatus !== undefined && message.toolStatus !== "success")
      ) continue;
      const block = askToolResultBlock(message);
      if (!block) continue;
      if (start < index) work.push({ kind: "activity", items: part.items.slice(start, index), endedAt: message.createdAt });
      flush();
      key = message.id;
      sections.push({ kind: "ask", key, block });
      start = index + 1;
    }
    if (start === 0) work.push(part);
    else if (start < part.items.length) work.push({ ...part, items: part.items.slice(start) });
  }
  flush();
  return sections;
}
