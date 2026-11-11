import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const renderer = await import("../src/lib/api.ts");
const { createProviderCatalogRuntime } = await import("../electron/main/runtime/provider-catalog.ts");
const main = createProviderCatalogRuntime({ getHost: () => null, modelsDevCatalog: {} });

test("settings read-modify-write preserves disabled retry and unrelated preferences", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { platform: "win32" } };
  try {
    for (const stored of [
      {},
      { infiniteProviderRetry: false },
      { infiniteProviderRetry: true },
      { unknownUpstreamRetryLimit: 2 },
      { keepCommandsExpanded: false },
    ]) {
      const original = { defaultMode: "agent", theme: "light", ...stored };
      const received = structuredClone(main.normalizeSettings(original));
      const displayed = renderer.normalizeSettings(received);
      const edited = { ...displayed, imageGeneration: { providerId: "images", modelId: "image" } };
      const outgoing = renderer.validateSettingsWrite(edited);
      const persisted = main.validateSettingsWrite(structuredClone(outgoing));
      assert.equal(persisted.infiniteProviderRetry, stored.infiniteProviderRetry === true);
      assert.equal(persisted.unknownUpstreamRetryLimit, stored.unknownUpstreamRetryLimit ?? 0);
      // Absent means on; an explicit false survives both boundaries.
      assert.equal(
        persisted.keepCommandsExpanded,
        stored.keepCommandsExpanded !== false,
      );
      assert.equal(persisted.theme, "light");
      assert.deepEqual(persisted.imageGeneration, edited.imageGeneration);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("invalid retry writes stay rejected at both boundaries", () => {
  for (const value of [undefined, null, "yes", 0, {}]) {
    const settings = { infiniteProviderRetry: value };
    assert.throws(() => renderer.validateSettingsWrite(settings), /infiniteProviderRetry is invalid/);
    assert.throws(() => main.validateSettingsWrite(settings), /infiniteProviderRetry is invalid/);
  }
});

test("unknown upstream recovery stays disabled on old reads and rejects invalid writes before IPC", () => {
  const previousWindow = globalThis.window;
  let invoked = 0;
  globalThis.window = { piDesktop: { platform: "win32", invoke: async () => { invoked++; } } };
  try {
    const base = { defaultMode: "agent", theme: "light", enterToSend: true };
    for (const normalize of [renderer.normalizeSettings, main.normalizeSettings]) {
      assert.equal(normalize(base).unknownUpstreamRetryLimit, 0);
      assert.equal(Object.hasOwn(base, "unknownUpstreamRetryLimit"), false);
      for (const limit of [0, 1, 2, 3]) {
        assert.equal(normalize({ ...base, unknownUpstreamRetryLimit: limit }).unknownUpstreamRetryLimit, limit);
      }
      for (const value of [null, "2", -1, 1.5, 4, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(normalize({ ...base, unknownUpstreamRetryLimit: value }).unknownUpstreamRetryLimit, 0);
      }
    }
    for (const value of [undefined, null, "2", -1, 1.5, 4, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      const settings = { ...base, unknownUpstreamRetryLimit: value };
      assert.throws(() => renderer.validateSettingsWrite(settings), /unknownUpstreamRetryLimit is invalid/);
      assert.throws(() => main.validateSettingsWrite(settings), /unknownUpstreamRetryLimit is invalid/);
      assert.throws(() => renderer.api.setSettings(settings), /unknownUpstreamRetryLimit is invalid/);
    }
    assert.equal(invoked, 0);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("stream idle timeout defaults safely, preserves valid choices and rejects invalid writes", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { platform: "win32" } };
  try {
    const base = { defaultMode: "agent", theme: "light", enterToSend: true };
    for (const normalize of [renderer.normalizeSettings, main.normalizeSettings]) {
      assert.equal(normalize(base).providerStreamIdleTimeoutMinutes, 10);
      for (const value of [0, 1, 3, 10, 17, 60]) {
        const settings = normalize({ ...base, providerStreamIdleTimeoutMinutes: value });
        assert.equal(main.validateSettingsWrite(renderer.validateSettingsWrite(settings)).providerStreamIdleTimeoutMinutes, value);
      }
      for (const value of [undefined, null, "10", -1, 1.5, 61, {}, NaN, Infinity]) {
        assert.equal(normalize({ ...base, providerStreamIdleTimeoutMinutes: value }).providerStreamIdleTimeoutMinutes, 10);
        for (const validate of [renderer.validateSettingsWrite, main.validateSettingsWrite]) {
          assert.throws(() => validate({ ...base, providerStreamIdleTimeoutMinutes: value }), /providerStreamIdleTimeoutMinutes is invalid/);
        }
      }
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("command folding defaults on and rejects non-boolean writes before IPC", () => {
  const previousWindow = globalThis.window;
  let invoked = 0;
  globalThis.window = {
    piDesktop: {
      platform: "win32",
      invoke: async () => {
        invoked += 1;
        return { ok: true, data: undefined };
      },
    },
  };
  try {
    const base = { defaultMode: "agent", theme: "light", enterToSend: true };
    assert.equal(
      renderer.normalizeSettings(base).keepCommandsExpanded,
      true,
    );
    assert.equal(
      renderer.normalizeSettings({ ...base, keepCommandsExpanded: false })
        .keepCommandsExpanded,
      false,
    );
    assert.equal(
      main.normalizeSettings({ ...base, keepCommandsExpanded: false })
        .keepCommandsExpanded,
      false,
    );
    for (const value of ["yes", 0, null, undefined, {}]) {
      assert.throws(
        () => renderer.validateSettingsWrite({ keepCommandsExpanded: value }),
        /keepCommandsExpanded is invalid/,
      );
      assert.throws(
        () => renderer.api.setSettings({ keepCommandsExpanded: value }),
        /keepCommandsExpanded is invalid/,
      );
    }
    assert.equal(invoked, 0, "invalid writes must not reach the preload bridge");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("transcript display mode defaults to fully folded and validates its three values", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { platform: "win32" } };
  try {
    const base = { defaultMode: "agent", theme: "light", enterToSend: true };
    assert.equal(renderer.normalizeSettings(base).transcriptDisplayMode, "fully-folded");
    assert.equal(main.normalizeSettings(base).transcriptDisplayMode, "fully-folded");
    for (const mode of ["flat", "command-first", "fully-folded"]) {
      assert.equal(
        renderer.normalizeSettings({ ...base, transcriptDisplayMode: mode }).transcriptDisplayMode,
        mode,
      );
      assert.equal(
        main.normalizeSettings({ ...base, transcriptDisplayMode: mode }).transcriptDisplayMode,
        mode,
      );
      assert.equal(
        renderer.validateSettingsWrite({ ...base, transcriptDisplayMode: mode }).transcriptDisplayMode,
        mode,
      );
    }
    for (const value of ["yes", 0, null, undefined, {}]) {
      assert.throws(
        () => renderer.validateSettingsWrite({ transcriptDisplayMode: value }),
        /transcriptDisplayMode is invalid/,
      );
      assert.throws(
        () => main.validateSettingsWrite({ transcriptDisplayMode: value }),
        /transcriptDisplayMode is invalid/,
      );
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("radial menu preferences normalize per direction and reject unknown actions", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { platform: "win32" } };
  try {
    const base = { defaultMode: "agent", theme: "light", enterToSend: true };
    assert.deepEqual(renderer.normalizeSettings(base).radialMenu, {});
    assert.deepEqual(main.normalizeSettings(base).radialMenu, {});
    const radialMenu = {
      enabled: true,
      up: "copy-last-answer",
      right: "none",
      down: "scroll-bottom",
      left: "scroll-top",
    };
    assert.deepEqual(
      renderer.normalizeSettings({ ...base, radialMenu }).radialMenu,
      radialMenu,
    );
    assert.deepEqual(
      main.normalizeSettings({ ...base, radialMenu }).radialMenu,
      radialMenu,
    );
    assert.equal(
      renderer.validateSettingsWrite({ ...base, radialMenu }).radialMenu.up,
      "copy-last-answer",
    );
    assert.throws(
      () => renderer.validateSettingsWrite({ radialMenu: { up: "nope" } }),
      /radialMenu\.up is invalid/,
    );
    assert.throws(
      () => main.validateSettingsWrite({ radialMenu: { up: "nope" } }),
      /radialMenu\.up is invalid/,
    );
    assert.throws(
      () => renderer.validateSettingsWrite({ radialMenu: { enabled: "yes" } }),
      /radialMenu\.enabled is invalid/,
    );
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("settings write round-trips command folding through the preload boundary", async () => {
  const previousWindow = globalThis.window;
  const calls = [];
  let stored = {
    defaultMode: "agent",
    theme: "light",
    enterToSend: true,
    onboardingDismissed: false,
  };
  globalThis.window = {
    piDesktop: {
      platform: "win32",
      invoke: async (channel, payload) => {
        calls.push({ channel, payload });
        if (channel === IPC.invoke.settingsGet) {
          return { ok: true, data: structuredClone(stored) };
        }
        if (channel === IPC.invoke.settingsSet) {
          stored = { ...stored, ...structuredClone(payload) };
          return { ok: true, data: undefined };
        }
        throw new Error(`Unexpected settings IPC: ${channel}`);
      },
    },
  };
  try {
    const initial = await renderer.api.getSettings();
    assert.equal(initial.keepCommandsExpanded, true);
    assert.equal(initial.unknownUpstreamRetryLimit, 0);
    assert.equal(Object.hasOwn(stored, "unknownUpstreamRetryLimit"), false);

    await renderer.api.setSettings({ ...initial, keepCommandsExpanded: false, unknownUpstreamRetryLimit: 2 });

    const write = calls.find(({ channel }) => channel === IPC.invoke.settingsSet);
    assert.ok(write, "settings write must cross the preload boundary");
    assert.equal(write.payload.keepCommandsExpanded, false);
    assert.equal(stored.keepCommandsExpanded, false);
    assert.equal(stored.unknownUpstreamRetryLimit, 2);

    const reread = await renderer.api.getSettings();
    assert.equal(reread.keepCommandsExpanded, false);
    assert.equal(reread.unknownUpstreamRetryLimit, 2);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
