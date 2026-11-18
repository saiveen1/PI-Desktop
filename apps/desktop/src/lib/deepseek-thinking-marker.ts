import type { Root } from "mdast";

export const deepSeekThinkingEnd = "<｜end▁of▁thinking｜>";
// Preserve quoted examples, including a quote that hasn't closed on a live frame.
const quotations = /"[^"]*"?|(?<![\p{L}\p{N}])'[^']*'?|“[^”]*”?|‘[^’]*’?|«[^»]*»?|「[^」]*」?|『[^』]*』?/gu;

export function hasRepeatedDeepSeekThinkingEnd(model: string | undefined, source: string): boolean {
  if (!model || !/(?:^|\/)deepseek(?:[-_.:][^/]*)?$/i.test(model)) return false;
  const first = source.indexOf(deepSeekThinkingEnd);
  return first >= 0 && source.includes(deepSeekThinkingEnd, first + deepSeekThinkingEnd.length);
}

/** Change only the display AST, never the Markdown source or its offsets. */
export function remarkDeepSeekThinkingEnd() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    tree.children = tree.children.filter((paragraph) => {
      if (paragraph.type !== "paragraph" || paragraph.children.some((node) =>
        node.type === "html" && !/^<\/?thinking>$/i.test(node.value))) return true;
      const start = paragraph.position?.start.offset;
      if (start === undefined) return true;
      const raw = source.slice(start, paragraph.position?.end.offset);
      if (!raw.includes(deepSeekThinkingEnd)) return true;
      const unquoted = raw.replace(quotations, (quote) => " ".repeat(quote.length));
      for (const node of paragraph.children) {
        if (node.type !== "text") continue;
        const offset = node.position?.start.offset;
        // Decoded escapes/entities are authored Markdown, not literal wire delimiters.
        if (offset === undefined || node.value !== source.slice(offset, node.position?.end.offset)) continue;
        node.value = node.value.replaceAll(deepSeekThinkingEnd, (token, index: number) =>
          unquoted.startsWith(token, offset - start + index) ? "" : token);
      }
      return paragraph.children.some((node) => node.type !== "text" || node.value.trim());
    });
  };
}
