import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { formatSessionLastReplyDate } from "../src/lib/sidebar-session-date.ts";

// A fixed local timezone lets the test cover both a DST boundary and a local
// date boundary without relying on the workstation's timezone.
process.env.TZ = "America/New_York";

const sidebarSource = await readFile(
  new URL("../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);
const sidebarStyles = await Promise.all([
  readFile(new URL("../src/styles/sidebar-threads.css", import.meta.url), "utf8"),
  readFile(new URL("../src/styles/sessions.css", import.meta.url), "utf8"),
]).then((styles) => styles.join("\n"));

const relative = (value, unit, locale = "en") => new Intl.RelativeTimeFormat(
  locale,
  { numeric: "auto" },
).format(value, unit);

const calendarDate = (value, now, locale = "en") => new Intl.DateTimeFormat(locale, {
  month: "short",
  day: "numeric",
  year: new Date(value).getFullYear() === now.getFullYear() ? undefined : "numeric",
}).format(new Date(value));

test("formats recent session activity by elapsed seconds, minutes, hours, and days", () => {
  // November 2, 2026 at 00:30 EST. Two actual elapsed hours earlier was 22:30
  // on the prior local calendar day, after the DST fallback weekend.
  const now = new Date("2026-11-02T05:30:00.000Z");

  assert.equal(
    formatSessionLastReplyDate("2026-11-02T05:29:43.000Z", now, "en"),
    relative(-17, "second"),
  );
  assert.equal(
    formatSessionLastReplyDate("2026-11-02T05:10:00.000Z", now, "en"),
    relative(-20, "minute"),
  );
  assert.equal(
    formatSessionLastReplyDate("2026-11-02T03:30:00.000Z", now, "en"),
    relative(-2, "hour"),
  );
  assert.equal(
    formatSessionLastReplyDate("2026-11-01T05:30:00.000Z", now, "en"),
    relative(-1, "day"),
  );
  assert.equal(
    formatSessionLastReplyDate("2026-10-26T05:30:00.000Z", now, "en"),
    relative(-7, "day"),
  );
});

test("uses a localized calendar date after a week, including a different year", () => {
  const now = new Date("2026-11-02T05:30:00.000Z");
  const eightDaysAgo = "2026-10-25T05:30:00.000Z";
  const lastYear = "2025-12-31T05:30:00.000Z";

  assert.equal(
    formatSessionLastReplyDate(eightDaysAgo, now, "en"),
    calendarDate(eightDaysAgo, now),
  );
  assert.equal(
    formatSessionLastReplyDate(lastYear, now, "en"),
    calendarDate(lastYear, now),
  );
});

test("clamps slight future clock skew without treating a distant future update as current", () => {
  const now = new Date("2026-11-02T05:30:00.000Z");
  const slightFuture = "2026-11-02T05:33:00.000Z";
  const distantFuture = "2026-11-02T07:30:00.000Z";

  assert.equal(formatSessionLastReplyDate(slightFuture, now, "en"), relative(0, "second"));
  assert.equal(
    formatSessionLastReplyDate(distantFuture, now, "en"),
    calendarDate(distantFuture, now),
  );
});

test("invalid timestamps are blank and invalid locales safely fall back", () => {
  const now = new Date("2026-11-02T05:30:00.000Z");
  assert.equal(formatSessionLastReplyDate(undefined, now), "");
  assert.equal(formatSessionLastReplyDate("not-a-date", now), "");
  assert.equal(
    formatSessionLastReplyDate("2026-11-02T03:30:00.000Z", now, "en_US"),
    new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-2, "hour"),
  );
});

test("project session rows show the date until hover or focus reveals actions", () => {
  assert.match(sidebarSource, /sidebarSessionTime === true/);
  assert.match(sidebarSource, /window\.setInterval\(\(\) => setLastReplyNow\(Date\.now\(\)\), 1_000\)/);
  assert.match(sidebarSource, /new Date\(lastReplyNow\)/);
  assert.match(sidebarSource, /formatPreciseLocalTimestamp\(session\.updatedAt, lastReplyLocale\)/);
  assert.match(sidebarSource, /className=\{cx\([\s\S]*?"thread-item-meta"[\s\S]*?sessionMenu === session\.id/);
  assert.match(sidebarSource, /className="thread-item-last-reply"/);
  assert.match(
    sidebarStyles,
    /\.thread-item:hover \.thread-item-last-reply,[\s\S]*?\.thread-item:focus-within \.thread-item-last-reply\s*\{\s*opacity:\s*0;\s*visibility:\s*hidden;/,
  );
  assert.match(
    sidebarStyles,
    /\.thread-item:hover \.thread-item-more[\s\S]*?\.thread-item:focus-within \.thread-item-more[\s\S]*?opacity:\s*1;/,
  );
});
