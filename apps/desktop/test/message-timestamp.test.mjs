import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

// Midnight before the fallback repeats 01:00. `h23` must stay at 00 rather
// than rendering the less familiar 24:00, and both strings must be local EDT.
process.env.TZ = "America/New_York";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const timestamp = "2026-11-01T04:00:05.000Z";
const date = new Date(timestamp);

const clock = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
}).format(date);
const preciseLocalTime = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
}).format(date);

test("message timestamps render a local clock and a precise local-time hover", async () => {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { MessageTimestamp } = await server.ssrLoadModule(
      "/src/features/chat/transcript/shared.tsx",
    );
    const i18n = createInstance();
    await i18n.init({
      lng: "en-US",
      resources: { "en-US": { translation: catalogs.en } },
    });
    const html = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(MessageTimestamp, { createdAt: timestamp }),
      ),
    );

    assert.match(html, /<time class="message-timestamp"/);
    assert.match(html, new RegExp(`dateTime="${timestamp}"`));
    assert.match(html, new RegExp(`title="${preciseLocalTime}"`));
    assert.match(html, new RegExp(`>${clock}</time>`));
    assert.match(html, /(?:EDT|EST)/);
    assert.doesNotMatch(html, new RegExp(`title="${timestamp}"`));
    assert.doesNotMatch(html, /24:00/);
  } finally {
    await server.close();
  }
});

test("message timestamps ignore invalid dates and malformed locales safely", async () => {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { MessageTimestamp } = await server.ssrLoadModule(
      "/src/features/chat/transcript/shared.tsx",
    );
    const i18n = createInstance();
    await i18n.init({
      lng: "en_US",
      resources: { en_US: { translation: catalogs.en } },
    });
    const render = (createdAt) => renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(MessageTimestamp, { createdAt }),
      ),
    );

    assert.equal(render("not-a-timestamp"), "");
    assert.match(render(timestamp), /message-timestamp/);
  } finally {
    await server.close();
  }
});
