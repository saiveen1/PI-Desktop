import { unified } from "unified";
import remarkParse from "remark-parse";
import { markdownRemarkPlugins } from "./markdown-blocks.ts";
import { markdownFileDirectoryAfterNode } from "./chat-links.ts";

const parser = unified().use(remarkParse).use(markdownRemarkPlugins);

/** Carry explicit directory context across independently rendered Markdown blocks. */
export function markdownFileDirectories(blocks: readonly string[]): (string | undefined)[] {
  let current: string | undefined;
  return blocks.map((raw) => {
    const before = current;
    // Most blocks cannot declare a directory or end its heading scope. Avoid
    // another parse for those, especially large fenced/code and table blocks.
    if (/[\\/]`/.test(raw) || /^ {0,3}#{1,6}\s/m.test(raw) || /\n[=-]+\s*$/.test(raw.trimEnd())) {
      for (const node of parser.parse(raw).children) {
        current = markdownFileDirectoryAfterNode(node, current);
      }
    }
    return before;
  });
}
