import { contextBoundaryIndex, type ContextCompactionRecord, type UiMessage } from "@pi-desktop/shared";

/** Recovery, attachment reads and compaction must start at the same row as provider replay. */
export function runtimeHistorySeed(rows: readonly UiMessage[] = [], checkpoint?: ContextCompactionRecord | null) {
  const start = contextBoundaryIndex(rows);
  const boundaryMessageId = start < 0 ? undefined : rows[start].id;
  const details = checkpoint?.details;
  const stampedBoundary = details && typeof details === "object" && "contextBoundaryMessageId" in details
    ? details.contextBoundaryMessageId : undefined;
  // A through-id after the cut doesn't prove the summary (or opaque retained tail) excludes earlier turns.
  return { history: rows.slice(Math.max(0, start)), boundaryMessageId,
    compaction: stampedBoundary === boundaryMessageId ? checkpoint ?? undefined : undefined };
}
