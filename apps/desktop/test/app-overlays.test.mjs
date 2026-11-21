import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { slotSsr } from "./helpers/slot-ssr.mjs";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const model = await import("../src/features/startup/app-overlay-model.ts");

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("startup guide takes priority over announcements; Settings is never an overlay", () => {
  assert.equal(model.resolveAppOverlay({ guide: true, announcement: true }), "guide");
  assert.equal(model.resolveAppOverlay({ guide: false, announcement: true }), "announcement");
  assert.equal(model.resolveAppOverlay({ guide: false, announcement: false, settings: true }), null);
});

test("startup guide: new users configure a model, returning users learn the launcher", () => {
  assert.deepEqual(
    model.planStartupGuide({ completedVersion: 0, hasUsableModel: false }),
    { audience: "new", steps: ["model", "launcher"] },
  );
  assert.deepEqual(
    model.planStartupGuide({ completedVersion: 0, hasUsableModel: true }),
    { audience: "returning", steps: ["launcher"] },
  );
  assert.equal(
    model.planStartupGuide({
      completedVersion: model.STARTUP_GUIDE_VERSION,
      hasUsableModel: false,
    }),
    null,
    "a finished or skipped guide version never returns",
  );
});

test("announcement is off by default and shows at most once per release", () => {
  const release = { id: "0.24.0" };
  const empty = { shownIds: [] };
  assert.equal(model.shouldShowAnnouncement(null, empty), false, "off by default");
  assert.equal(model.shouldShowAnnouncement(release, empty), true);
  const shown = model.announcementShown(release, empty);
  assert.equal(model.shouldShowAnnouncement(release, shown), false, "closed means never again");
  assert.strictEqual(model.announcementShown(release, shown), shown, "recording twice is a no-op");
  assert.equal(model.shouldShowAnnouncement({ id: "0.25.0" }, shown), true, "next release starts fresh");
  let history = empty;
  for (let i = 0; i < 30; i += 1) history = model.announcementShown({ id: `v${i}` }, history);
  assert.equal(history.shownIds.length, 20, "history stays bounded");
});

test("a replayed guide follows the user's current model state", () => {
  assert.deepEqual(model.startupGuideFor(true).steps, ["launcher"]);
  assert.deepEqual(model.startupGuideFor(false).steps, ["model", "launcher"]);
});

test("announcement locale fallback", () => {
  assert.deepEqual(model.announcementLocaleCandidates("zh-TW"), ["zh-TW", "zh", "en"]);
  assert.deepEqual(model.announcementLocaleCandidates("en"), ["en"]);
  assert.deepEqual(model.announcementLocaleCandidates(undefined), ["en"]);
});

test("Settings deep links navigate once and preserve Back/Forward route history", async (t) => {
  const h = await slotSsr(t);
  const { useAppStore } = await h.load("/src/stores/app-store.ts");
  const state = useAppStore.getState;
  state().setPage("plugins");
  state().setSettingsTab("about");
  assert.equal(state().page, "settings");
  assert.equal(state().settingsTab, "about");
  const index = state().navIndex;
  const nonce = state().settingsTabNonce;
  state().openSettings("shortcuts");
  state().openSettings();
  assert.equal(state().settingsTab, "shortcuts");
  assert.equal(state().settingsTabNonce, nonce + 1);
  assert.equal(state().navIndex, index, "switching tabs or reopening does not add a route");
  state().navBack();
  assert.equal(state().page, "plugins");
  state().navForward();
  assert.equal(state().page, "settings");
  assert.equal(state().settingsTab, "shortcuts");
  state().setSettingsAnchor("updates.title");
  state().setPage("chat");
  assert.equal(state().settingsAnchor, null, "Back to app clears a pending row anchor");
  state().navBack();
  state().setSettingsTab("appearance");
  state().openSettings();
  assert.equal(state().canNavForward(), true, "in-page actions preserve forward history");
  state().navForward();
  assert.equal(state().page, "chat");
  state().openSettings();
  assert.equal(state().page, "settings");
  assert.equal(state().settingsTab, "appearance");
});

test("the shell's overlay host owns startup dialogs, not Settings", async () => {
  const shell = await read("../src/features/app/AppShell.tsx");
  const host = await read("../src/features/startup/AppOverlayHost.tsx");
  assert.match(shell, /<AppOverlayHost active=\{!showSplash\} \/>/);
  assert.match(host, /<StartupGuideDialog\b/);
  assert.match(host, /<AnnouncementDialog\b/);
  assert.doesNotMatch(host, /SettingsDialog|<SettingsPage\b|overlay === "settings"/);
  assert.match(host, /if \(exit === "openShortcuts"\) (?:setSettingsTab|openSettings)\("shortcuts"\)/);
});

test("the startup guide embeds the shared Settings destination", async () => {
  const [guide, settingsPage] = await Promise.all([
    read("../src/features/startup/StartupGuideDialog.tsx"),
    read("../src/features/settings/SettingsPage.tsx"),
  ]);
  assert.match(guide, /<SettingsDestinationContent tab="agent" \/>/);
  assert.match(settingsPage, /<SettingsDestinationContent tab=\{tab\} tabHidden=\{tabHidden\} \/>/);
});

test("guide replay and launcher detection are wired end to end", async () => {
  const [host, about, guide, launcher] = await Promise.all([
    read("../src/features/startup/AppOverlayHost.tsx"),
    read("../src/features/settings/pages/AboutSettings.tsx"),
    read("../src/features/startup/StartupGuideDialog.tsx"),
    read("../electron/main/bootstrap/launcher.ts"),
  ]);
  // Settings → About replays the guide without touching the first-launch marker.
  assert.match(about, /useStartupGuideRequest\.getState\(\)\.request\(\)/);
  assert.match(host, /if \(guide\?\.source === "auto"\) saveStartupGuideCompletedVersion/);
  // Keycaps light up when the launcher actually opens.
  assert.match(guide, /api\.onPluginLauncherShown\(\(\) => setPressed\(true\)\)/);
  assert.match(guide, /keybindingMatchesEvent\(binding, event, platform\)/);
  assert.match(launcher, /mainWindow\.webContents\.send\(IPC\.event\.pluginLauncherShown\)/);
});

test("the chat home no longer carries the first-run checklist", async () => {
  const chat = await read("../src/components/ChatSurface.tsx");
  assert.doesNotMatch(chat, /OnboardingChecklist/);
});
