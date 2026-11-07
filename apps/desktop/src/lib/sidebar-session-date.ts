const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const FUTURE_SKEW_MS = 5 * MINUTE_MS;
const FORMATTER_CACHE_LIMIT = 8;
const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>();
const calendarFormatters = new Map<string, Intl.DateTimeFormat>();

/** Bound locale churn while reusing formatters across every sidebar row. */
function cachedFormatter<T>(
  cache: Map<string, T>,
  key: string,
  locale: string | undefined,
  create: (locale: string | undefined) => T,
): T {
  const existing = cache.get(key);
  if (existing) return existing;
  let formatter: T;
  try {
    formatter = create(locale || undefined);
  } catch {
    formatter = create(undefined);
  }
  if (cache.size >= FORMATTER_CACHE_LIMIT) cache.clear();
  cache.set(key, formatter);
  return formatter;
}

function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  locale?: string,
): string {
  try {
    return cachedFormatter(relativeFormatters, locale || "", locale,
      language => new Intl.RelativeTimeFormat(language, { numeric: "auto" }),
    ).format(value, unit);
  } catch {
    return "";
  }
}

function formatCalendarDate(date: Date, now: Date, locale?: string): string {
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  };
  try {
    return cachedFormatter(calendarFormatters, `${locale || ""}:${options.year || ""}`, locale,
      language => new Intl.DateTimeFormat(language, options),
    ).format(date);
  } catch {
    return "";
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
    return formatRelativeTime(0, "second", locale);
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
