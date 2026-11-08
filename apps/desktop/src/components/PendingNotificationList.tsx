import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { NotificationEntry } from "../lib/notification-delivery";
import { activateNotificationTarget } from "../stores/runtime/notification-runtime";
import { Button } from "./ui";
import { IconBot, IconCircleAlert } from "./icons";
import { notificationTone } from "../lib/notification-presentation";

/** Live source state only; history bulk actions never acknowledge these requests. */
export function PendingNotificationList({ items, onNavigate, onError }: {
  items: NotificationEntry[];
  onNavigate: () => void;
  onError: () => void;
}) {
  const { t } = useTranslation();
  const [opening, setOpening] = useState<string | null>(null);
  if (!items.length) return null;
  return <section className="notification-pending" aria-label={t("notifications.needsAction")}>
    <div className="notification-header"><h3>{t("notifications.needsAction")}</h3></div>
    <ul className="notification-list">
      {items.map(item => <li key={item.id}>
        <Button variant="ghost" className="notification-item unread" disabled={opening !== null}
          data-notification-source={item.target.kind}
          onClick={() => {
            setOpening(item.id);
            void activateNotificationTarget(item.target).then(opened => { if (opened) onNavigate(); })
              .catch(onError).finally(() => setOpening(null));
          }}>
          <span className={`notification-kind-icon ${notificationTone(item.target.kind)}`}>
            {item.target.kind === "delegation-approval" ? <IconBot size={15} aria-hidden /> : <IconCircleAlert size={15} aria-hidden />}
          </span>
          <span className="notification-copy">
            <span className="notification-item-title">{item.title}</span>
            <span className="notification-item-body">{item.body}</span>
          </span>
        </Button>
      </li>)}
    </ul>
  </section>;
}
