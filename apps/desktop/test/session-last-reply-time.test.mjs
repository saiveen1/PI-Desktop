import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { formatPreciseLocalTimestamp } from "../src/lib/local-date-time.ts";

process.env.TZ = "America/New_York";

const relative = (value, unit, locale) => new Intl.RelativeTimeFormat(locale, {
  numeric: "auto",
}).format(value, unit);

test("session time renders precise localized metadata and refreshes new timestamps before a clock tick", async (t) => {
  let now = Date.parse("2026-11-02T05:30:00.000Z");
  t.mock.method(Date, "now", () => now);
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { SessionLastReplyTime } = await server.ssrLoadModule(
      "/src/features/sessions/SessionLastReplyTime.tsx",
    );
    const { sidebarSessionClock } = await server.ssrLoadModule("/src/lib/sidebar-session-clock.ts");
    const initialSnapshot = sidebarSessionClock.getSnapshot();
    const render = (updatedAt, locale = "en-US") => renderToStaticMarkup(
      createElement(SessionLastReplyTime, { updatedAt, locale }),
    );
    const timestamp = "2026-11-02T05:29:43.000Z";
    const initial = render(timestamp);
    assert.match(initial, /<time class="thread-item-last-reply"/);
    assert.ok(initial.includes(`dateTime="${timestamp}"`));
    assert.ok(initial.includes(`title="${formatPreciseLocalTimestamp(timestamp, "en-US")}"`));
    assert.ok(initial.endsWith(`>${relative(0, "second", "en-US")}</time>`));
    assert.doesNotMatch(initial, /17 seconds ago/);
    assert.equal(render(timestamp), initial);
    assert.ok(render(timestamp, "zh-CN").endsWith(`>${relative(0, "second", "zh-CN")}</time>`));

    now += 10 * 60_000;
    const updatedTimestamp = new Date(now - 90_000).toISOString();
    assert.equal(sidebarSessionClock.getSnapshot(), initialSnapshot);
    assert.ok(render(updatedTimestamp).endsWith(`>${relative(-1, "minute", "en-US")}</time>`));
    assert.ok(render(timestamp).endsWith(`>${relative(-10, "minute", "en-US")}</time>`));
    assert.ok(render(new Date(now - 17_000).toISOString()).endsWith(
      `>${relative(0, "second", "en-US")}</time>`,
    ));

    assert.equal(render(undefined), "");
    assert.equal(render(""), "");
    assert.equal(render("not-a-timestamp"), "");
    assert.ok(render(updatedTimestamp, "en_US").endsWith(
      `>${relative(-1, "minute", undefined)}</time>`,
    ));
  } finally {
    await server.close();
  }
});
