import type { UiMessage } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";

/** Child input has its own history, without parent-message edit or delete actions. */
export function SubagentUserMessage({ message }: { message: UiMessage }) {
  const { t } = useTranslation();
  return <div className="message-row user" data-message-id={message.id}
    role="article" aria-label={t("chat.userMessage")}>
    <div className="message-col"><div className="message-bubble">
      <div className="message-user-text selectable">{message.content}</div>
    </div></div>
  </div>;
}
