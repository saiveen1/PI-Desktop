import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const appShell = await readFile(
  new URL("../src/features/app/AppShell.tsx", import.meta.url),
  "utf8",
);
const settingsPage = await readFile(
  new URL("../src/features/settings/SettingsPage.tsx", import.meta.url),
  "utf8",
);

test("Settings is a page outside the hidden, inert workspace and its portals", () => {
  assert.match(appShell, /const settingsActive = page === "settings"/);
  const workspace = appShell.match(/<PortalVisibilityProvider visible=\{!settingsActive\}>([\s\S]*?)<\/PortalVisibilityProvider>/)?.[1];
  assert.ok(workspace, "workspace portals must be suppressed while Settings is active");
  const chatShell = workspace.match(/<div\s+className="app-chat-shell"[^>]*>/)?.[0];
  assert.ok(chatShell);
  assert.match(chatShell, /hidden=\{settingsActive\}/);
  assert.match(chatShell, /inert=\{settingsActive\}/);
  assert.doesNotMatch(chatShell, /aria-hidden/);
  assert.doesNotMatch(workspace, /<SettingsPage\b/);
  assert.match(appShell, /<SettingsPage\b/);
  assert.doesNotMatch(settingsPage, /role="dialog"|aria-modal|portalOverlay\(|createPortal\(|useModalDialog\(/);
  assert.match(settingsPage, /data-nav="back-to-app"[\s\S]*?onClick=\{\(\) => setPage\("chat"\)\}/);
});

test("entering Settings moves focus to its first search control", () => {
  assert.match(settingsPage, /const settingsSearchRef = useRef<HTMLInputElement>\(null\)/);
  assert.match(
    settingsPage,
    /settingsSearchRef\.current\?\.focus\(\{ preventScroll: true \}\)/,
  );
  assert.match(settingsPage, /<(?:input|Input)\s+ref=\{settingsSearchRef\}/);
});

test("chat code loads inside the existing route boundary and stays mounted under Settings", () => {
  assert.match(
    appShell,
    /const loadChatSurface = \(\) => import\("\.\.\/\.\.\/components\/ChatSurface"\)/,
  );
  assert.match(appShell, /const ChatSurface = lazy\(\(\) =>\s*loadChatSurface\(\)/);
  assert.match(appShell, /useEffect\(\(\) => \{\s*void loadChatSurface\(\)\.catch/);
  assert.doesNotMatch(appShell, /import \{ ChatSurface \} from/);
  assert.match(
    appShell,
    /<Suspense fallback=\{<RoutePending \/>\}>[\s\S]*?<ChatSurface visible=\{page === "chat"\} \/>[\s\S]*?<\/Suspense>/,
  );
  for (const [route, component] of [["scheduled", "ScheduledPage"], ["plugins", "PluginsPage"]]) {
    assert.match(appShell, new RegExp(`surfacePage === "${route}" \\? \\([\\s\\S]*?<${component} />`));
  }
});

test("the Settings route renders its search and Return to app as page controls", async (t) => {
  const h = await slotSsr(t);
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { platform: "win32" } };
  t.after(() => { globalThis.window = previousWindow; });
  const { SettingsPage } = await h.load("/src/features/settings/SettingsPage.tsx");
  const { useAppStore } = await h.load("/src/stores/app-store.ts");
  Object.assign(useAppStore.getInitialState(), {
    page: "settings", settingsTab: "notifications", settings: { developerMode: false },
  });
  const html = h.render(createElement(SettingsPage));
  assert.match(html, /class="settings-shell settings-shell-full"/);
  assert.match(html, /<input[^>]*aria-label="Search settings"/);
  assert.match(html, /<button[^>]*data-nav="back-to-app"[^>]*>.*?Back to app/s);
  assert.match(html, /class="settings-content" role="main"/);
  assert.doesNotMatch(html, /aria-modal="true"/);
});
