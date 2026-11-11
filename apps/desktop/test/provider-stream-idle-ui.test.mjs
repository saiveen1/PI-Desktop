import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";
import { catalogs } from "@pi-desktop/i18n";

test("slow model waiting remains a live translated status in both transcript layouts", async t => {
  const ssr = await slotSsr(t);
  const { runActivityLabel } = await ssr.load("/src/features/chat/transcript/ActivityGroup.tsx");
  const { TurnProcess } = await ssr.load("/src/features/chat/transcript/TurnProcess.tsx");
  const activity = { phase: "waiting-model", since: 100, slow: true };
  assert.equal(runActivityLabel(activity, key => key), "errors.PROVIDER_STREAM_SLOW");
  assert.equal(runActivityLabel({ ...activity, slow: false }, key => key), "chat.waitingForModel");
  const html = ssr.render(createElement(TurnProcess, {
    turnId: "fixture-turn", processParts: [], turnParts: [], visibleSteps: 1,
    isActive: true, failed: false, activity, children: "Fixture process",
  }));
  assert.match(html, /class="turn-process[^\"]* active/);
  assert.match(html, /180 seconds|three minutes|3 minutes/i);
  assert.doesNotMatch(html, /errors\.PROVIDER_STREAM_SLOW|Process failed/);
});

test("Behavior timeout choices save the selected value and survive rerender", async t => {
  const ssr = await slotSsr(t);
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { platform: "win32" } };
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  const { AgentBehaviorSettings } = await ssr.load("/src/features/settings/pages/AgentBehaviorSettings.tsx");
  const { SettingsMenuSelect } = await ssr.load("/src/components/settings/SettingsMenuSelect.tsx");
  const { normalizeSettings, validateSettingsWrite } = await ssr.load("/src/lib/api.ts");
  let stored = { defaultMode: "agent", theme: "light", enterToSend: true };
  let selector;
  const writes = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.type === SettingsMenuSelect && node.props.label === "Model connection idle timeout") selector = node;
    visit(node.props?.children);
  }
  function Harness() {
    const tree = AgentBehaviorSettings({ settings: normalizeSettings(stored), saveSettings: async patch => {
      writes.push(patch);
      stored = validateSettingsWrite({ ...stored, ...patch });
    } });
    visit(tree);
    return tree;
  }
  const render = () => { selector = undefined; ssr.render(createElement(Harness)); assert.ok(selector); return selector.props; };
  let menu = render();
  assert.equal(menu.value, "10");
  assert.deepEqual(menu.options.map(option => option.id), ["0", "3", "5", "10", "15", "30", "60"]);
  for (const value of ["15", "0", "60"]) {
    menu.onChange(value);
    await Promise.resolve();
    menu = render();
    assert.equal(menu.value, value);
    assert.equal(stored.providerStreamIdleTimeoutMinutes, Number(value));
  }
  assert.deepEqual(writes, [15, 0, 60].map(providerStreamIdleTimeoutMinutes => ({ providerStreamIdleTimeoutMinutes })));
  stored = { ...stored, providerStreamIdleTimeoutMinutes: 7 };
  menu = render();
  assert.equal(menu.value, "7");
  assert.ok(menu.options.some(option => option.id === "7"));
});

test("idle waiting settings and notices have copy in every shipped locale", () => {
  for (const [locale, catalog] of Object.entries(catalogs)) {
    for (const key of ["providerStreamIdleTimeout", "providerStreamIdleTimeoutDesc", "providerStreamIdleTimeoutDisabled", "providerStreamIdleTimeoutMinutes"])
      assert.ok(catalog.settings[key]?.trim(), `${locale}: ${key}`);
    for (const key of ["PROVIDER_STREAM_IDLE_TIMEOUT", "PROVIDER_STREAM_SLOW"])
      assert.ok(catalog.errors[key]?.trim(), `${locale}: ${key}`);
  }
});
