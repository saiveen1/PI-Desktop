import { readSettingsSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const settingsSource = await readSettingsSource();
const globalStyles = await loadStyles();

test("the Settings page provides a drag band without intercepting control clicks", () => {
  assert.match(settingsSource, /className="settings-titlebar" aria-hidden="true"/);
  const band = globalStyles.match(/\n\.settings-titlebar\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(band, /-webkit-app-region:\s*drag;/);
  assert.match(band, /pointer-events:\s*none;/);
  assert.match(band, /left:\s*var\(--ds-settings-nav-width\);/);
  assert.match(band, /right:\s*0;/);
  assert.match(settingsSource, /className="settings-nav-top drag"/);
  assert.match(settingsSource, /className="settings-search-wrap no-drag"/);
  assert.match(settingsSource, /className="settings-back no-drag"/);
});

test("the Settings rail keeps the shared width token", () => {
  assert.match(
    globalStyles,
    /\.settings-shell-full \.settings-nav\s*\{[^}]*width:\s*var\(--ds-settings-nav-width\);[^}]*flex:\s*0 0 var\(--ds-settings-nav-width\);/s,
  );
  assert.match(globalStyles, /--ds-settings-nav-width:\s*275px;/);
});
