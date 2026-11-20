import { useEffect, useState } from "react";
import type { UiMessage } from "@pi-desktop/shared";
import { useChatSessionCapability } from "../../../hooks/use-chat-session-capability";
import { api } from "../../../lib/api";
import { toolResultImageSet, type ToolImageSet } from "../../../lib/tool-result-images";

// Use the existing Host single-message cap, not the uncapped transcript endpoint.
const IMAGE_RECOVERY_CONTENT_LIMIT = 256 * 1024;
const reads = new WeakMap<UiMessage, { sessionId: string; value: Promise<ToolImageSet | undefined> }>();

export function useRestoredToolImages(message: UiMessage, sessionId: string | undefined, visible: boolean) {
  const original = toolResultImageSet(message);
  const allowed = useChatSessionCapability("canUseLocalTools");
  const target = allowed && original.inlineOmitted && sessionId && !sessionId.startsWith("native-pi:") ? sessionId : undefined;
  const [restored, setRestored] = useState<{ sessionId: string; message: UiMessage; images?: ToolImageSet }>();
  useEffect(() => {
    if (!visible || !target) return;
    let read = reads.get(message);
    if (read?.sessionId !== target) {
      const value = api.getSession(target, {
        messageAround: message.id, messageLimit: 1, contentLimit: IMAGE_RECOVERY_CONTENT_LIMIT,
      }).then(({ session }) => {
        if (session?.id !== target) return;
        const tool = session.messages.find((row) => row.id === message.id && row.role === "tool" && row.toolCallId === message.toolCallId);
        if (!tool) return;
        const result = toolResultImageSet(tool);
        if (result.images.some((image) => image.dataUrl) && result.images.length >= original.images.length) return result;
      }).catch(() => undefined);
      read = { sessionId: target, value };
      reads.set(message, read);
      void value.then((result) => {
        if (!result && reads.get(message)?.value === value) reads.delete(message);
      });
    }
    let current = true;
    void read.value.then((images) => {
      if (current) setRestored({ sessionId: target, message, images });
    });
    return () => { current = false; };
  }, [message, original, target, visible]);
  const settled = restored?.sessionId === target && restored?.message === message ? restored : undefined;
  return { result: settled?.images ?? original, restoring: !!target && !settled };
}
