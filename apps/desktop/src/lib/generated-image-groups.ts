import type { UiMessage } from "@pi-desktop/shared";
import type { ToolResultImage } from "./tool-result-images";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function generatedImageDetails(message: UiMessage) {
  const result = record(message.toolResult);
  return record(result?.details ?? result);
}
export type GeneratedBatch = { message: UiMessage; results: unknown[] };
export function generatedImageBatch(message: UiMessage): GeneratedBatch | undefined {
  const details = generatedImageDetails(message);
  if (details?.kind === "generated-images" && Array.isArray(details.results)) return { message, results: details.results };
}

type TurnOutput = { kind: "generated"; batches: GeneratedBatch[] } | { kind: "other"; message: UiMessage };

/** Present a turn's batches at the first batch's position; all other outputs stay in order. */
export function groupGeneratedImageMessages(messages: readonly UiMessage[]): TurnOutput[] {
  const outputs: TurnOutput[] = [];
  const batches: GeneratedBatch[] = [];
  for (const message of messages) {
    const batch = generatedImageBatch(message);
    if (!batch) outputs.push({ kind: "other", message });
    else {
      if (!batches.length) outputs.push({ kind: "generated", batches });
      batches.push(batch);
    }
  }
  return outputs;
}

type Outcome = "succeeded" | "timedOut" | "failed" | "cancelled";
type SourceItem = { key: string; messageId: string; toolCallId?: string; batch: number; slot: number; sourceIndex: number };
type TraceItem = SourceItem & { outcome: Outcome; errorCode?: string };
export type GalleryImage = ToolResultImage & SourceItem;

export function summarizeGeneratedBatches(batches: readonly GeneratedBatch[]) {
  const counts: Record<Outcome, number> = { succeeded: 0, timedOut: 0, failed: 0, cancelled: 0 };
  const items: TraceItem[] = [];
  const images: GalleryImage[] = [];
  for (const [batch, { message, results }] of batches.entries()) {
    const occurrences = new Map<number, number>();
    for (const [slot, raw] of results.entries()) {
      const item = record(raw);
      const sourceIndex = typeof item?.index === "number" && Number.isSafeInteger(item.index) && item.index >= 0 ? item.index : slot;
      // Keep the stored identity across partial projections; tolerate legacy duplicate or missing indices.
      const occurrence = occurrences.get(sourceIndex) ?? 0;
      occurrences.set(sourceIndex, occurrence + 1);
      const source = { key: JSON.stringify([message.id, sourceIndex, occurrence]), messageId: message.id, toolCallId: message.toolCallId, batch, slot, sourceIndex };
      const path = typeof item?.path === "string" ? item.path.trim() : "";
      const errorCode = typeof item?.errorCode === "string" && /^IMAGE_[A-Z0-9_]{1,64}$/.test(item.errorCode) ? item.errorCode : undefined;
      let outcome: Outcome;
      if (item?.status === "succeeded" && path) {
        outcome = "succeeded";
        // The shared viewer needs a distinct numeric index for thumbnail keys, sizes and download filenames.
        images.push({ ...source, index: items.length, path, mimeType: typeof item.mimeType === "string" ? item.mimeType : undefined, allowThumbnail: true });
      } else if (item?.status === "cancelled" || errorCode === "IMAGE_CANCELLED") outcome = "cancelled";
      else outcome = errorCode === "IMAGE_TIMEOUT" ? "timedOut" : "failed";
      counts[outcome]++;
      items.push({ ...source, outcome, errorCode: outcome === "succeeded" ? undefined : errorCode });
    }
  }
  return { items, images, counts };
}
