import { useMemo, useSyncExternalStore } from "react";
import { formatPreciseLocalTimestamp } from "../../lib/local-date-time";
import { sidebarSessionClock } from "../../lib/sidebar-session-clock";
import { formatSessionLastReplyDate } from "../../lib/sidebar-session-date";

type SessionLastReplyTimeProps = {
  updatedAt: string | undefined;
  locale?: string;
};

function ValidSessionLastReplyTime({ updatedAt, locale }: SessionLastReplyTimeProps) {
  const now = useSyncExternalStore(
    sidebarSessionClock.subscribe,
    sidebarSessionClock.getSnapshot,
    sidebarSessionClock.getSnapshot,
  );
  const title = useMemo(
    () => formatPreciseLocalTimestamp(updatedAt, locale),
    [updatedAt, locale],
  );
  // A newly received timestamp must not use the previous minute's snapshot.
  const label = formatSessionLastReplyDate(updatedAt, new Date(Math.max(now, Date.now())), locale);
  return (
    <time className="thread-item-last-reply" dateTime={updatedAt} title={title}>
      {label}
    </time>
  );
}

export function SessionLastReplyTime(props: SessionLastReplyTimeProps) {
  if (!props.updatedAt || !Number.isFinite(Date.parse(props.updatedAt))) return null;
  return <ValidSessionLastReplyTime {...props} />;
}
