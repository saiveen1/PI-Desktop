const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const FUTURE_SKEW_MS = 5 * MINUTE_MS;

function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  locale?: string,
): string {
  try {
    return new Intl.RelativeTimeFormat(locale || undefined, {
      numeric: "auto",
    }).format(value, unit);
  } catch {
    try {
      return new Intl.RelativeTimeFormat(undefined, {
        numeric: "auto",
      }).format(value, unit);
    } catch {
      return "";
    }
  }
}

function formatCalendarDate(date: Date, now: Date, locale?: string): string {
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  };
  try {
    return new Intl.DateTimeFormat(locale || undefined, options).format(date);
  } catch {
    try {
      return new Intl.DateTimeFormat(undefined, options).format(date);
    } catch {
      return "";
    }
  }
}

/** Format the session's most recent update as elapsed activity or a calendar date. */
export function formatSessionLastReplyDate(
  value: string | undefined,
  now = new Date(),
  locale?: string,
): string {
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !Number.isFinite(now.getTime())) return "";

  if (timestamp - now.getTime() > FUTURE_SKEW_MS) {
    return formatCalendarDate(new Date(timestamp), now, locale);
  }
  const elapsed = Math.max(0, now.getTime() - timestamp);
  if (elapsed < MINUTE_MS) {
    return formatRelativeTime(-Math.floor(elapsed / SECOND_MS), "second", locale);
  }
  if (elapsed < HOUR_MS) {
    return formatRelativeTime(-Math.floor(elapsed / MINUTE_MS), "minute", locale);
  }
  if (elapsed < DAY_MS) {
    return formatRelativeTime(-Math.floor(elapsed / HOUR_MS), "hour", locale);
  }
  if (elapsed <= WEEK_MS) {
    return formatRelativeTime(-Math.floor(elapsed / DAY_MS), "day", locale);
  }

  return formatCalendarDate(new Date(timestamp), now, locale);
}
