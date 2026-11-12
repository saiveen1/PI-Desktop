import type { UiMessage } from "@pi-desktop/shared";
import type { AssistantTurnPart } from "./assistant-turns";
import { toolResultImageSet } from "./tool-result-images";

/** Presentation only: never merge durable calls or cross a narrative/owner boundary. */
export function groupTurnToolImages(parts: readonly AssistantTurnPart[]): UiMessage[][] {
  const groups: UiMessage[][] = [];
  let adjacent: UiMessage[] | undefined;
  for (const part of parts) {
    if (part.kind !== "activity") { adjacent = undefined; continue; }
    for (const item of part.items) {
      if (item.kind !== "tool") { adjacent = undefined; continue; }
      const message = item.message;
      const result = toolResultImageSet(message);
      const mergeable = message.toolName === "Read" && !message.isError &&
        (message.toolStatus === "success" || message.toolStatus === undefined) &&
        !result.generated && !result.displayOmitted && result.images.length > 0 && result.issueCodes.length === 0;
      const previous = adjacent?.at(-1);
      if (mergeable && adjacent && previous && previous.parentToolCallId === message.parentToolCallId &&
        previous.nestedParentToolCallId === message.nestedParentToolCallId && previous.agentName === message.agentName) {
        adjacent.push(message);
      } else {
        const group = [message];
        // Keep single non-image calls as boundaries; their component returns null.
        groups.push(group);
        adjacent = mergeable ? group : undefined;
      }
    }
  }
  return groups;
}
