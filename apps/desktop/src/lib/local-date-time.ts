export function formatLocalDateTime(
  date: Date,
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
): string {
  if (!Number.isFinite(date.getTime())) return "";
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

/** Localized, unambiguous instant for a native timestamp hover. */
export function formatPreciseLocalDateTime(
  date: Date,
  locale?: string,
): string {
  return formatLocalDateTime(date, locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  });
}

export function formatPreciseLocalTimestamp(
  value: string | undefined,
  locale?: string,
): string {
  if (!value) return "";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? formatPreciseLocalDateTime(new Date(timestamp), locale)
    : "";
}
