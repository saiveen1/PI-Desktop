import type { AppNotification } from "@pi-desktop/shared";

/** Task outcomes remain visible after reading; only explicit clear removes history. */
export function inboxNotifications(
  notifications: AppNotification[],
): AppNotification[] {
  return notifications;
}

export function inboxUnreadCount(notifications: AppNotification[]): number {
  return inboxNotifications(notifications).reduce(
    (count, notification) => count + (notification.readAt ? 0 : 1),
    0,
  );
}
