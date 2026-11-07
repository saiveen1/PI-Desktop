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

test("formats recent session activity as now, minutes, hours, and days", () => {
  // November 2, 2026 at 00:30 EST. Two actual elapsed hours earlier was 22:30
  // on the prior local calendar day, after the DST fallback weekend.
  const now = new Date("2026-11-02T05:30:00.000Z");

  assert.equal(
    formatSessionLastReplyDate("2026-11-02T05:29:43.000Z", now, "en"),
    relative(0, "second"),
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
test("every sub-minute age uses localized now without a literal seconds count", () => {
  const now = new Date("2026-11-02T05:30:00.000Z");
  for (const locale of ["en", "zh-CN", "zh-TW", "de"]) {
    for (let seconds = 0; seconds < 60; seconds += 1) {
      const value = new Date(now.getTime() - seconds * 1_000).toISOString();
      const label = formatSessionLastReplyDate(value, now, locale);
      assert.equal(label, relative(0, "second", locale));
      assert.doesNotMatch(label, /\d|seconds? ago|秒/);
    }
    assert.equal(
      formatSessionLastReplyDate(new Date(now.getTime() - 60_000).toISOString(), now, locale),
      relative(-1, "minute", locale),
    );
  }
});

test("repeated row timestamps reuse a bounded set of locale formatters", async (t) => {
  const { formatSessionLastReplyDate: format } = await import("../src/lib/sidebar-session-date.ts?cache-test");
  const RelativeTimeFormat = Intl.RelativeTimeFormat;
  const DateTimeFormat = Intl.DateTimeFormat;
  let relativeCreations = 0;
  let calendarCreations = 0;
  t.mock.method(Intl, "RelativeTimeFormat", function (...args) {
    relativeCreations += 1;
    return new RelativeTimeFormat(...args);
  });
  t.mock.method(Intl, "DateTimeFormat", function (...args) {
    calendarCreations += 1;
    return new DateTimeFormat(...args);
  });
  const now = new Date("2026-11-02T05:30:00.000Z");
  const recent = "2026-11-02T05:29:43.000Z";
  const old = "2026-10-01T05:30:00.000Z";
  for (let row = 0; row < 200; row += 1) {
    assert.equal(format(recent, now, "en"), "now");
    assert.ok(format(old, now, "en"));
    assert.ok(format("2025-10-01T05:30:00.000Z", now, "en"));
  }
  assert.equal(relativeCreations, 1);
  assert.equal(calendarCreations, 2);
  for (let index = 0; index < 16; index += 1) {
    format(recent, now, `en-x-cache-${index}`);
    format(old, now, `en-x-cache-${index}`);
  }
  const previousRelative = relativeCreations;
  const previousCalendar = calendarCreations;
  // The oldest locale must have been evicted, rather than retained forever.
  format(recent, now, "en");
  format(old, now, "en");
  assert.equal(relativeCreations, previousRelative + 1);
  assert.equal(calendarCreations, previousCalendar + 1);
});

test("project session rows show the date until hover or focus reveals actions", () => {
  assert.match(sidebarSource, /sidebarSessionTime === true/);
  assert.match(sidebarSource, /<SessionLastReplyTime\s+updatedAt=\{session\.updatedAt\}\s+locale=\{[^}]+\}\s*\/>/);
  assert.doesNotMatch(sidebarSource, /setLastReplyNow/);
  assert.match(sidebarSource, /className=\{cx\([\s\S]*?"thread-item-meta"[\s\S]*?sessionMenu === session\.id/);
  assert.doesNotMatch(sidebarSource, /className="thread-item-last-reply"/);
  assert.match(
    sidebarStyles,
    /\.thread-item:hover \.thread-item-last-reply,[\s\S]*?\.thread-item:focus-within \.thread-item-last-reply\s*\{\s*opacity:\s*0;\s*visibility:\s*hidden;/,
  );
  assert.match(
    sidebarStyles,
    /\.thread-item:hover \.thread-item-more[\s\S]*?\.thread-item:focus-within \.thread-item-more[\s\S]*?opacity:\s*1;/,
  );
});
