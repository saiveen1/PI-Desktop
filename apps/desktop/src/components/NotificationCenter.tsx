import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { AppNotification, DelegationApprovalHistoryEntry } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { portalToBody } from "../lib/portal-visibility";
import { inboxNotifications, inboxUnreadCount } from "../lib/notification-inbox";
import { notificationHistoryRows, notificationPopoverPosition } from "../lib/notification-presentation";
import { useDelegationReceipts } from "../hooks/use-delegation-receipts";
import { useAppStore } from "../stores/app-store";
import { usePendingNotifications } from "../stores/runtime/notification-runtime";
import { IconBell, IconCheckCheck, IconTrash } from "./icons";
import { Button, TooltipButton } from "./ui";
import { PendingNotificationList } from "./PendingNotificationList";
import { NotificationHistoryList } from "./NotificationHistoryList";

type NotificationFilter = "all" | "unread" | "pending";

export function NotificationCenter({ onBeforeOpen }: { onBeforeOpen?: () => void }) {
  const { t } = useTranslation();
  const pendingNotifications = usePendingNotifications();
  const receipts = useDelegationReceipts();
  const storedNotifications = useAppStore(state => state.notifications);
  const notifications = useMemo(() => inboxNotifications(storedNotifications), [storedNotifications]);
  const receiptUnread = receipts.entries.filter(entry => !entry.readAt).length;
  const unreadCount = inboxUnreadCount(storedNotifications) + receiptUnread + pendingNotifications.length;
  const allUnreadCount = useAppStore(state => state.unreadNotificationCount);
  const refreshNotifications = useAppStore(state => state.refreshNotifications);
  const markAllNotificationsRead = useAppStore(state => state.markAllNotificationsRead);
  const clearNotifications = useAppStore(state => state.clearNotifications);
  const openNotification = useAppStore(state => state.openNotification);
  const selectSession = useAppStore(state => state.selectSession);
  const showToast = useAppStore(state => state.showToast);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const [expandedReceipt, setExpandedReceipt] = useState<string | null>(null);
  const [popoverPos, setPopoverPos] = useState<ReturnType<typeof notificationPopoverPosition> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => notificationHistoryRows(notifications, receipts.entries)
    .filter(row => filter !== "unread" || !row.read || row.id === expandedReceipt),
    [notifications, receipts.entries, filter, expandedReceipt]);
  const closePopover = useCallback((restoreFocus = true) => {
    setOpen(false); setConfirmClear(false); setExpandedReceipt(null);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  }, []);
  const reportError = useCallback(() => showToast(t("notifications.actionFailed"), { variant: "error", sound: false }), [showToast, t]);

  useLayoutEffect(() => {
    if (!open) { setPopoverPos(null); return; }
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setPopoverPos(notificationPopoverPosition(rect.top, rect.left, window.innerWidth, window.innerHeight));
    };
    place();
    window.addEventListener("resize", place);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (rootRef.current) observer?.observe(rootRef.current);
    return () => { window.removeEventListener("resize", place); observer?.disconnect(); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false, frame = 0;
    setBusy(true);
    void Promise.all([refreshNotifications(), receipts.reload()]).catch(() => { if (!cancelled) reportError(); })
      .finally(() => {
        if (cancelled) return;
        setBusy(false);
        frame = requestAnimationFrame(() => {
          if (cancelled || popoverRef.current?.contains(document.activeElement)) return;
          popoverRef.current?.querySelector<HTMLButtonElement>(".notification-filter.active")?.focus({ preventScroll: true });
        });
      });
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [open, refreshNotifications, receipts.reload, reportError]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) closePopover(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); closePopover();
    };
    window.addEventListener("mousedown", onMouseDown); window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("mousedown", onMouseDown); window.removeEventListener("keydown", onKeyDown); };
  }, [open, closePopover]);

  const onPopoverKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".notification-item:not(:disabled)"));
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "End" ? buttons.length - 1 : event.key === "ArrowUp" ? Math.max(0, current - 1)
      : event.key === "ArrowDown" ? Math.min(buttons.length - 1, current + 1) : 0;
    buttons[next]?.focus();
  };
  const runToolbarAction = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); setConfirmClear(false); }
    catch { reportError(); }
    finally {
      setBusy(false);
      requestAnimationFrame(() => popoverRef.current?.querySelector<HTMLButtonElement>(".notification-filter.active")?.focus({ preventScroll: true }));
    }
  };
  const activateNotification = (notification: AppNotification) => {
    closePopover(); void openNotification(notification.id).catch(reportError);
  };
  const readReceipt = (receipt: DelegationApprovalHistoryEntry) => {
    if (!receipt.readAt) void receipts.markRead({ sessionId: receipt.request.sessionId, requestId: receipt.request.requestId }).catch(reportError);
  };
  const openSource = (sessionId: string) => {
    closePopover(); void selectSession(sessionId).catch(reportError);
  };
  const unreadLabel = unreadCount > 0 ? t("notifications.openUnread", { count: unreadCount }) : t("notifications.open");
  const hasHistory = storedNotifications.length > 0 || receipts.entries.length > 0 || receipts.error;
  const empty = pendingNotifications.length === 0 && (filter === "pending" || rows.length === 0);

  return <div className="notification-center" ref={rootRef}>
    <TooltipButton ref={triggerRef} type="button" className={`footer-notification notification-trigger ${open ? "active" : ""}`}
      tooltip={unreadLabel} ariaLabel={unreadLabel} aria-haspopup="dialog" aria-controls="notification-popover" aria-expanded={open}
      onClick={() => { if (open) closePopover(); else { onBeforeOpen?.(); setOpen(true); } }}>
      <IconBell size={14} aria-hidden />
      {unreadCount > 0 ? <span className="notification-badge" aria-hidden>{unreadCount > 99 ? "99+" : unreadCount}</span> : null}
    </TooltipButton>
    <span className="sr-only" role="status" aria-live="polite">{unreadLabel}</span>
    {open && popoverPos && typeof document !== "undefined" ? portalToBody(
      <div ref={popoverRef} id="notification-popover" className="notification-popover notification-popover-portaled"
        role="dialog" aria-labelledby="notification-title" onKeyDown={onPopoverKeyDown} style={popoverPos}>
        <header className="notification-header">
          <h2 id="notification-title">{t("notifications.title")}</h2>
          <div className="notification-actions">
            <TooltipButton type="button" className="notification-action" tooltip={t("notifications.markAllRead")}
              ariaLabel={t("notifications.markAllRead")} disabled={busy || allUnreadCount + receiptUnread === 0}
              onClick={() => void runToolbarAction(() => Promise.all([markAllNotificationsRead(), receipts.markRead()]))}>
              <IconCheckCheck size={15} aria-hidden />
            </TooltipButton>
            <TooltipButton type="button" className="notification-action" tooltip={t("notifications.clearAll")}
              ariaLabel={t("notifications.clearAll")} disabled={busy || !hasHistory} onClick={() => setConfirmClear(true)}>
              <IconTrash size={15} aria-hidden />
            </TooltipButton>
          </div>
        </header>
        <div className="notification-filters" role="group" aria-label={t("notifications.title")}>
          {(["all", "unread", "pending"] as const).map(value => <Button key={value} variant="ghost" size="sm"
            className={`notification-filter ${filter === value ? "active" : ""}`} aria-pressed={filter === value}
            onClick={() => { setFilter(value); setExpandedReceipt(null); if (scrollRef.current) scrollRef.current.scrollTop = 0; }}>
            {t(value === "pending" ? "notifications.needsAction" : `notifications.${value}`)}
          </Button>)}
        </div>
        {confirmClear ? <div className="notification-clear-confirm" role="group" aria-label={t("notifications.clearConfirm")}>
          <p>{t("notifications.clearConfirm")}</p>
          <Button size="sm" disabled={busy} onClick={() => void runToolbarAction(() => Promise.all([clearNotifications(), receipts.clear()]))}>{t("notifications.clearAll")}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmClear(false)}>{t("common.cancel")}</Button>
        </div> : null}
        <div ref={scrollRef} className="notification-scroll" tabIndex={0} aria-label={t("notifications.title")}>
          <PendingNotificationList items={pendingNotifications} onNavigate={() => closePopover(false)} onError={reportError} />
          {filter !== "pending" && receipts.error ? <div className="notification-history-error" role="alert">
            <p>{t("notifications.historyLoadFailed")}</p>
            <Button size="sm" variant="ghost" onClick={() => void receipts.reload().catch(reportError)}>{t("delegationApproval.retry")}</Button>
          </div> : null}
          {filter !== "pending" && rows.length > 0 ? <NotificationHistoryList rows={rows} busy={busy}
            expanded={expandedReceipt} onExpand={setExpandedReceipt}
            onTask={activateNotification} onReadReceipt={readReceipt} onSource={openSource} /> : null}
          {empty ? <div className="notification-empty" role="status">
            <IconBell size={22} aria-hidden />
            <strong>{t(filter === "pending" ? "notifications.emptyPendingTitle" : filter === "unread" ? "notifications.emptyUnreadTitle" : "notifications.emptyTitle")}</strong>
            <span>{t(filter === "pending" ? "notifications.emptyPendingBody" : filter === "unread" ? "notifications.emptyUnreadBody" : "notifications.emptyBody")}</span>
          </div> : null}
        </div>
      </div>,
    ) : null}
  </div>;
}
