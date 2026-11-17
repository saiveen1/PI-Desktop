import type { UiMessage } from "@pi-desktop/shared";
import type { AssistantTurnPart } from "./assistant-turns";
import { toolResultImageSet } from "./tool-result-images";

/** Reading an existing image is process context, not a delivered artifact. */
export function isInspectionRead(message: UiMessage): boolean {
  return message.toolName === "Read" && !toolResultImageSet(message).generated;
}

export function turnToolImageMessages(parts: readonly AssistantTurnPart[]): UiMessage[] {
  return parts.flatMap((part) => part.kind === "activity"
    ? part.items.flatMap((item) => item.kind === "tool" && !isInspectionRead(item.message)
      ? [item.message] : [])
    : []);
}
