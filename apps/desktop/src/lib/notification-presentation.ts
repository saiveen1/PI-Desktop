import type { AppNotification, DelegationApprovalHistoryEntry } from "@pi-desktop/shared";

export type NotificationTone = "pending" | "running" | "success" | "failed" | "neutral";
export type NotificationHistoryRow =
  | { id: string; kind: "task"; createdAt: string; read: boolean; notification: AppNotification }
  | { id: string; kind: "approval"; createdAt: string; read: boolean; receipt: DelegationApprovalHistoryEntry };

/** Receipt identity is independent from a parent turn's completion notification. */
export function notificationHistoryRows(
  notifications: readonly AppNotification[],
  receipts: readonly DelegationApprovalHistoryEntry[],
  unreadOnly = false,
): NotificationHistoryRow[] {
  const rows: NotificationHistoryRow[] = [
    ...notifications.map(notification => ({ id: `task:${notification.id}`, kind: "task" as const,
      createdAt: notification.createdAt, read: Boolean(notification.readAt), notification })),
    ...receipts.map(receipt => ({ id: JSON.stringify(["approval", receipt.request.sessionId, receipt.request.requestId]),
      kind: "approval" as const, createdAt: receipt.settledAt, read: Boolean(receipt.readAt), receipt })),
  ];
  return rows.filter(row => !unreadOnly || !row.read)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
}

export function notificationTone(kind: string, status?: string): NotificationTone {
  if (["ask", "permission", "plan", "delegation-approval"].includes(kind) && (!status || status === "pending")) return "pending";
  if (status === "running") return "running";
  if (kind.endsWith("failed") || status === "failed" || status === "timed_out") return "failed";
  if (kind === "task.completed" || status === "completed" || status === "approved") return "success";
  return "neutral";
}

export function notificationToastVariant(kind: string): "warning" | "success" | "error" | "info" {
  const tone = notificationTone(kind);
  return tone === "pending" ? "warning" : tone === "success" ? "success" : tone === "failed" ? "error" : "info";
}

/** Use the anchor's actual offset, not a fixed footer-height assumption. */
export function notificationPopoverPosition(top: number, left: number, viewportWidth: number, viewportHeight: number) {
  const gutter = Math.min(12, Math.max(0, viewportWidth / 4), Math.max(0, viewportHeight / 4));
  const width = Math.min(360, Math.max(0, viewportWidth - 2 * gutter));
  const usable = Math.max(0, viewportHeight - 2 * gutter);
  const bottom = Math.min(Math.max(gutter, viewportHeight - top + 8),
    Math.max(gutter, viewportHeight - gutter - Math.min(180, usable)));
  return {
    left: Math.max(gutter, Math.min(left, viewportWidth - width - gutter)),
    bottom,
    maxHeight: Math.min(560, Math.max(0, viewportHeight - bottom - gutter)),
  };
}

export function formatNotificationTime(value: string, locale: string, justNow: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return justNow;
  const delta = timestamp - Date.now(), absoluteDelta = Math.abs(delta);
  if (absoluteDelta < 45_000) return justNow;
  try {
    const formatter = new Intl.RelativeTimeFormat(locale || undefined, { numeric: "auto" });
    if (absoluteDelta < 60 * 60_000) return formatter.format(Math.round(delta / 60_000), "minute");
    if (absoluteDelta < 24 * 60 * 60_000) return formatter.format(Math.round(delta / (60 * 60_000)), "hour");
    if (absoluteDelta < 7 * 24 * 60 * 60_000) return formatter.format(Math.round(delta / (24 * 60 * 60_000)), "day");
    return new Intl.DateTimeFormat(locale || undefined, { month: "short", day: "numeric",
      year: new Date(timestamp).getFullYear() === new Date().getFullYear() ? undefined : "numeric" }).format(timestamp);
  } catch { return justNow; }
}
