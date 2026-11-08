import assert from "node:assert/strict";
import test from "node:test";
import { sessionColor, colorToHex, sessionColorCss, hexToHsv, hsvToHex, SESSION_COLORS } from "../src/lib/session-colors.ts";
import { cleanSessionLabels } from "../src/lib/session-labels.ts";
import { loadSidebarPreferences, saveSidebarPreferences } from "../src/lib/sidebar-preferences.ts";

test("strict colors accept existing names and normalized RGB, never arbitrary CSS", () => {
  for (const color of SESSION_COLORS) assert.equal(sessionColor(color), color);
  assert.equal(sessionColor("#ABC"), "#aabbcc");
  assert.equal(sessionColor(" #A18AfF "), "#a18aff");
  for (const bad of ["red; color:black", "var(--secret)", "url(https://example.org)", "#abcd", "#12345678", "transparent", "#ggg", null, {}]) assert.equal(sessionColor(bad), undefined);
  assert.equal(sessionColorCss("#fff"), "#ffffff");
  assert.equal(sessionColorCss("red"), "var(--ds-error)");
});

test("HSV coordinates preserve RGB across all hue sectors, black and white", () => {
  for (const hex of ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#00ffff", "#ff00ff", "#ffff00", "#a18aff", "#081c7f", "#8899aa"]) assert.equal(hsvToHex(hexToHsv(hex)), hex);
  assert.equal(hsvToHex({ h: 360, s: 100, v: 100 }), "#ff0000");
  assert.equal(hsvToHex({ h: -120, s: 100, v: 100 }), "#0000ff");
  assert.equal(hsvToHex({ h: Number.NaN, s: -10, v: 200 }), "#ffffff");
  assert.match(colorToHex("blue"), /^#[0-9a-f]{6}$/);
});

test("custom label and group colors survive a preference reload", () => {
  const previous = globalThis.localStorage; const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  try {
    const labels = cleanSessionLabels([{ id: "local", name: "Local", color: "#AbC" }]);
    saveSidebarPreferences({ ...loadSidebarPreferences(), sessionOrganization: { version: 1, scopes: { "project:/test": {
      groups: [{ id: "g", name: "Group", color: "#D12AF8" }], labels,
    } } }, sessionMeta: { a: { groupId: "g", organizationScope: "project:/test", labelIds: ["local"], color: "#Ff12Ab" } } });
    const restored = loadSidebarPreferences();
    assert.equal(restored.sessionOrganization.scopes["project:/test"].groups[0].color, "#d12af8");
    assert.equal(restored.sessionOrganization.scopes["project:/test"].labels[0].color, "#aabbcc");
    assert.equal(restored.sessionMeta.a.color, "#ff12ab");
  } finally { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous; }
});
