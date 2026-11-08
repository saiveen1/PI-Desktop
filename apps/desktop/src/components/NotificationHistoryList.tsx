import { useTranslation } from "react-i18next";
import type { AppNotification, DelegationApprovalHistoryEntry } from "@pi-desktop/shared";
import { formatNotificationTime, notificationTone, type NotificationHistoryRow } from "../lib/notification-presentation";
import { IconBot, IconCircleAlert, IconCircleCheck } from "./icons";
import { Button } from "./ui";

export function NotificationHistoryList({ rows, busy, expanded, onExpand, onTask, onReadReceipt, onSource }: {
  rows: NotificationHistoryRow[];
  busy: boolean;
  expanded: string | null;
  onExpand: (id: string | null) => void;
  onTask: (notification: AppNotification) => void;
  onReadReceipt: (receipt: DelegationApprovalHistoryEntry) => void;
  onSource: (sessionId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  return <ul className="notification-list">
    {rows.map(row => {
      const receipt = row.kind === "approval" ? row.receipt : null;
      const notification = row.kind === "task" ? row.notification : null;
      const failed = notification?.kind === "task.failed";
      const sessionTitle = (receipt?.request.sessionTitle ?? notification?.sessionTitle) || t("chat.untitledTask");
      const title = receipt ? t("notifications.approvalHistoryTitle", { sessionTitle })
        : t(failed ? "notifications.failedTitle" : "notifications.completedTitle", { sessionTitle });
      const body = receipt ? t("notifications.approvalHistoryBody", {
        agent: receipt.request.agentName ?? t("delegationApproval.delegate"),
        status: t(`delegationApproval.feedback.${receipt.request.status}`),
      }) : failed ? notification?.errorCode
        ? t("notifications.failedBodyWithCode", { code: notification.errorCode }) : t("notifications.failedBody")
        : t("notifications.completedBody");
      const tone = notificationTone(receipt ? "delegation-approval" : notification?.kind ?? "", receipt?.request.status);
      return <li key={row.id}>
        <Button variant="ghost" className={`notification-item ${row.read ? "" : "unread"}`}
          data-notification-id={notification?.id} data-notification-history-id={row.id}
          aria-expanded={receipt ? expanded === row.id : undefined} disabled={busy}
          onClick={() => {
            if (receipt) { onExpand(expanded === row.id ? null : row.id); onReadReceipt(receipt); }
            else if (notification) onTask(notification);
          }}>
          <span className={`notification-kind-icon ${tone}`} aria-hidden>
            {receipt ? <IconBot size={17} /> : failed ? <IconCircleAlert size={17} /> : <IconCircleCheck size={17} />}
          </span>
          <span className="notification-copy"><span className="notification-item-title">{title}</span>
            <span className="notification-item-body">{body}</span></span>
          <time className="notification-time" dateTime={row.createdAt}>{formatNotificationTime(row.createdAt,
            i18n.resolvedLanguage || i18n.language, t("notifications.justNow"))}</time>
          {!row.read ? <span className="notification-unread-dot" aria-hidden /> : null}
        </Button>
        {receipt && expanded === row.id ? <div className="notification-receipt-detail">
          <p>{receipt.request.projectTitle ?? receipt.request.projectPath ?? t("delegationApproval.noProject")}</p>
          {receipt.request.description ? <p>{receipt.request.description}</p> : null}
          <p className="notification-receipt-task selectable">{receipt.request.task}</p>
          <Button variant="ghost" size="sm" onClick={() => onSource(receipt.request.sessionId)}>
            {t("delegationApproval.openSource", { title: sessionTitle })}
          </Button>
        </div> : null}
      </li>;
    })}
  </ul>;
}
