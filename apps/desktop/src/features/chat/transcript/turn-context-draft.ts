import type { MessageContextOverride, TurnContextEdit, TurnContextMessage } from "@pi-desktop/shared";

type TextBlock = { kind: "thinking" | "text" | "final"; value: string; excluded: boolean };
type ToolBlock = { kind: "tool"; value: string; args: string; excluded: boolean };
export type ContextBlock = TextBlock | ToolBlock;
export type ContextRow = { source: TurnContextMessage; blocks: ContextBlock[]; originals: ContextBlock[] };

const formatArgs = (args: Record<string, unknown> | undefined) => JSON.stringify(args ?? {}, null, 2);

function createBlocks(source: TurnContextMessage, original = false): ContextBlock[] {
  const override = original ? undefined : source.override;
  if (source.role === "tool") return [{
    kind: "tool", args: formatArgs(override?.toolArgs ?? source.toolArgs),
    value: override?.toolResultText ?? source.toolResultText ?? "", excluded: override?.excludeTool === true,
  }];
  const blocks: ContextBlock[] = [];
  if (source.hasThinking || source.thinking !== undefined || source.override?.thinking !== undefined) blocks.push({
    kind: "thinking", value: override?.thinking ?? source.thinking ?? "",
    excluded: (override?.excludeThinking ?? (!original && source.legacyExcludeThinking)) === true,
  });
  if (source.final || source.content || source.override?.content !== undefined) blocks.push({
    kind: source.final ? "final" : "text", value: override?.content ?? source.content, excluded: override?.excludeContent === true,
  });
  return blocks;
}

export function createContextRows(messages: TurnContextMessage[]): ContextRow[] {
  return messages.map((source) => ({ source, blocks: createBlocks(source), originals: createBlocks(source, true) }));
}

export function parseContextArgs(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Validation is reported on the JSON field.
  }
}

export function hasOpaqueThinking(source: TurnContextMessage, block: ContextBlock) {
  return block.kind === "thinking" && source.hasThinking && !source.thinking && !block.value;
}

export function isIncludedContextBlock(source: TurnContextMessage, block: ContextBlock) {
  return !block.excluded && (block.kind === "tool" || Boolean(block.value) || hasOpaqueThinking(source, block));
}

export function proposeContextEdits(rows: ContextRow[], restoreAll: boolean, allowWholeTurnRestore: boolean) {
  const edits: TurnContextEdit[] = [];
  const modified = rows.some(({ source }) => source.override || source.legacyExcludeThinking);
  let matchesOriginals = true;
  let invalid = false;
  for (const { source, blocks, originals } of rows) {
    const initial = restoreAll ? originals : createBlocks(source);
    const next: MessageContextOverride = { version: 1, ...(restoreAll ? undefined : source.override) };
    blocks.forEach((block, index) => {
      const original = originals[index];
      const before = initial[index];
      const excluded = block.excluded ? true : undefined;
      if (block.kind === "final" && !block.excluded && !block.value.trim()) invalid = true;
      if (block.value !== original.value || block.excluded) matchesOriginals = false;
      if (block.kind === "tool" && original.kind === "tool" && before.kind === "tool") {
        const args = parseContextArgs(block.args);
        if (!args) invalid = true;
        const argsText = args && formatArgs(args);
        if (argsText !== original.args) matchesOriginals = false;
        if (argsText !== before.args) next.toolArgs = argsText === original.args ? undefined : args;
        if (block.value !== before.value) next.toolResultText = block.value === original.value ? undefined : block.value;
        if (block.excluded !== before.excluded) next.excludeTool = excluded;
      } else if (block.kind === "thinking") {
        if (block.value !== before.value) next.thinking = block.value === original.value ? undefined : block.value;
        if (restoreAll || block.excluded !== before.excluded) {
          next.excludeThinking = block.excluded || (source.legacyExcludeThinking ? false : undefined);
        }
      } else {
        if (block.value !== before.value) next.content = block.value === original.value ? undefined : block.value;
        if (block.excluded !== before.excluded) next.excludeContent = excluded;
      }
    });
    const stored = source.override;
    if ((!restoreAll || !source.legacyExcludeThinking) && JSON.stringify(next) === JSON.stringify(stored ?? { version: 1 })) continue;
    const hasOverride = Object.entries(next).some(([key, value]) => key !== "version" && value !== undefined &&
      !(key === "excludeThinking" && value === false && source.legacyExcludeThinking));
    // A null reset clears the legacy flag as well. If the user only restored another
    // block, explicitly keep a still-excluded legacy thinking block in the overlay.
    if (!hasOverride && !restoreAll && source.legacyExcludeThinking && next.excludeThinking === undefined) next.excludeThinking = true;
    edits.push({ messageId: source.messageId, contextOverride: hasOverride || next.excludeThinking === true ? next : null });
  }
  const restore = allowWholeTurnRestore && restoreAll && matchesOriginals && modified;
  return { edits: restore ? [] : edits, restore, invalid };
}
