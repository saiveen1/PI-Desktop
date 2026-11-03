/**
 * The unfinished-TodoWrite continuation safeguard switch
 * (Settings → AI → Defaults).
 *
 * What the user gets: the row is on in a fresh install, turning it off writes
 * an explicit `false`, and the value survives a read-modify-write at both
 * settings boundaries. What the runtime does with it belongs to the runtime
 * owner; these tests pin the settings/UI contract only.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";
import { catalogs } from "@pi-desktop/i18n";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const renderer = await import("../src/lib/api.ts");
const { createProviderCatalogRuntime } = await import(
  "../electron/main/runtime/provider-catalog.ts"
);
const { SETTINGS_NAV, searchSettings } = await import(
  "../src/lib/settings-search.ts"
);
const main = createProviderCatalogRuntime({ getHost: () => null, modelsDevCatalog: {} });

const BASE = { defaultMode: "agent", theme: "light", enterToSend: true };

function withWindow(work) {
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { platform: "win32" } };
  try {
    return work();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

test("the safeguard is on when absent and false only when explicitly disabled", () =>
  withWindow(() => {
    assert.equal(renderer.normalizeSettings(BASE).autoContinueUnfinishedTodos, true);
    assert.equal(main.normalizeSettings(BASE).autoContinueUnfinishedTodos, true);
    for (const value of [undefined, null, "yes", 0, {}]) {
      assert.equal(
        renderer.normalizeSettings({ ...BASE, autoContinueUnfinishedTodos: value })
          .autoContinueUnfinishedTodos,
        true,
        `${String(value)} must read as enabled`,
      );
      assert.equal(
        main.normalizeSettings({ ...BASE, autoContinueUnfinishedTodos: value })
          .autoContinueUnfinishedTodos,
        true,
        `${String(value)} must read as enabled in main`,
      );
    }
    for (const normalize of [renderer.normalizeSettings, main.normalizeSettings]) {
      assert.equal(
        normalize({ ...BASE, autoContinueUnfinishedTodos: false })
          .autoContinueUnfinishedTodos,
        false,
      );
      assert.equal(
        normalize({ ...BASE, autoContinueUnfinishedTodos: true })
          .autoContinueUnfinishedTodos,
        true,
      );
    }
  }));

test("only true and false survive both settings write boundaries", () =>
  withWindow(() => {
    for (const validate of [
      renderer.validateSettingsWrite,
      main.validateSettingsWrite,
    ]) {
      assert.equal(
        validate({ ...BASE, autoContinueUnfinishedTodos: false })
          .autoContinueUnfinishedTodos,
        false,
      );
      assert.equal(
        validate({ ...BASE, autoContinueUnfinishedTodos: true })
          .autoContinueUnfinishedTodos,
        true,
      );
      for (const value of [undefined, null, "false", 0, 1, {}]) {
        assert.throws(
          () => validate({ autoContinueUnfinishedTodos: value }),
          /autoContinueUnfinishedTodos is invalid/,
          `${JSON.stringify(value)} must be rejected`,
        );
      }
    }
  }));

test("turning the safeguard off then on persists each choice across the boundaries", () =>
  withWindow(() => {
    // Absent reads as on; the first user action stores an explicit false, and
    // the next one stores an explicit true — never back to "absent".
    let stored = { ...BASE };
    const off = { ...renderer.normalizeSettings(stored) };
    assert.equal(off.autoContinueUnfinishedTodos, true);
    off.autoContinueUnfinishedTodos = false;
    stored = main.validateSettingsWrite(renderer.validateSettingsWrite(off));
    assert.equal(stored.autoContinueUnfinishedTodos, false);
    assert.equal(
      renderer.normalizeSettings(main.normalizeSettings(stored))
        .autoContinueUnfinishedTodos,
      false,
    );

    const on = { ...renderer.normalizeSettings(main.normalizeSettings(stored)) };
    on.autoContinueUnfinishedTodos = true;
    stored = main.validateSettingsWrite(renderer.validateSettingsWrite(on));
    assert.equal(stored.autoContinueUnfinishedTodos, true);
    assert.equal(
      renderer.normalizeSettings(main.normalizeSettings(stored))
        .autoContinueUnfinishedTodos,
      true,
    );
  }));

test("the row is indexed in Settings → AI beside the provider retry switch", () => {
  const ai = SETTINGS_NAV.find((entry) => entry.id === "ai");
  assert.ok(ai, "AI settings entry is registered");
  const at = ai.keywordKeys.indexOf("settings.autoContinueUnfinishedTodos");
  assert.ok(at >= 0, "the row title is searchable in AI");
  assert.equal(
    ai.keywordKeys[at + 1],
    "settings.autoContinueUnfinishedTodosDesc",
    "the description is indexed right after the title",
  );
  assert.ok(
    ai.keywordKeys.indexOf("settings.infiniteProviderRetry") >= 0,
    "the neighbouring safeguard stays indexed",
  );
  assert.equal(
    SETTINGS_NAV.find((entry) => entry.id === "general").keywordKeys.includes(
      "settings.autoContinueUnfinishedTodos",
    ),
    false,
    "the row does not also appear under General",
  );
});

test("the English and Chinese copy explains the one-shot continuation and its cost", () => {
  const en = catalogs.en.settings;
  const zh = catalogs["zh-CN"].settings;
  assert.equal(en.autoContinueUnfinishedTodos, "Auto-continue unfinished tasks");
  assert.equal(zh.autoContinueUnfinishedTodos, "未完成任务自动续跑");
  for (const copy of [en, zh]) {
    const desc = copy.autoContinueUnfinishedTodosDesc;
    assert.match(desc, /TodoWrite/);
    assert.ok(desc.trim().length > 0);
  }
  // One continuation per turn, stoppable, applies next turn, extra requests.
  assert.match(en.autoContinueUnfinishedTodosDesc, /once per user turn/);
  assert.match(en.autoContinueUnfinishedTodosDesc, /never loops/);
  assert.match(en.autoContinueUnfinishedTodosDesc, /Stop still ends the turn/);
  assert.match(en.autoContinueUnfinishedTodosDesc, /from the next turn/);
  assert.match(en.autoContinueUnfinishedTodosDesc, /extra model requests/);
  assert.match(zh.autoContinueUnfinishedTodosDesc, /只续跑一次/);
  assert.match(zh.autoContinueUnfinishedTodosDesc, /仍可随时停止/);
  assert.match(zh.autoContinueUnfinishedTodosDesc, /下一轮/);
  assert.match(zh.autoContinueUnfinishedTodosDesc, /额外的模型请求/);
  // Every shipped catalog carries the pair, so no locale falls back silently.
  for (const [id, catalog] of Object.entries(catalogs)) {
    assert.equal(
      typeof catalog.settings.autoContinueUnfinishedTodos,
      "string",
      `${id} title`,
    );
    assert.notEqual(
      catalog.settings.autoContinueUnfinishedTodosDesc.trim(),
      "",
      `${id} description`,
    );
  }
});

test("searching for the safeguard lands on the AI destination", () => {
  const en = catalogs.en;
  const flat = (value, prefix = "", out = {}) => {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof child === "string") out[path] = child;
      else flat(child, path, out);
    }
    return out;
  };
  for (const [catalog, query] of [
    [catalogs.en, "unfinished"],
    [catalogs["zh-CN"], "未完成任务"],
  ]) {
    const copy = flat(catalog);
    const hits = searchSettings(query, (key) => copy[key] ?? key, {
      developerMode: false,
      includeDevelopmentOnly: false,
    });
    assert.ok(
      hits.some(
        (hit) =>
          hit.tab === "ai" &&
          hit.rowKey === "settings.autoContinueUnfinishedTodos",
      ),
      `${query} must find the row under AI, got ${JSON.stringify(hits)}`,
    );
  }
  assert.ok(en.settings.autoContinueUnfinishedTodos);
});

test("the row renders its saved state and persists real switch clicks", { timeout: 30_000 }, async () => {
  const root = repositoryRoot();
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "todo-settings-ui-"));
  const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
  try {
    await build({
      stdin: {
        contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { AutoContinueUnfinishedTodosRow } from "../../apps/desktop/src/components/settings/AutoContinueUnfinishedTodosRow";
await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } } });
const root = createRoot(document.getElementById("root"));
let settings = { defaultMode: "agent", theme: "light", enterToSend: true };
const writes = [];
const render = () => root.render(React.createElement(AutoContinueUnfinishedTodosRow, {
  settings,
  saveSettings: async (patch) => {
    writes.push(patch);
    settings = { ...settings, ...patch };
    flushSync(render);
  },
}));
flushSync(render);
window.todoSettingsProbe = async () => {
  const toggle = () => document.querySelector('[role="switch"]');
  const label = toggle().getAttribute("aria-label");
  const states = [toggle().getAttribute("aria-checked")];
  toggle().click();
  states.push(toggle().getAttribute("aria-checked"));
  flushSync(render);
  states.push(toggle().getAttribute("aria-checked"));
  toggle().click();
  states.push(toggle().getAttribute("aria-checked"));
  flushSync(() => root.unmount());
  return { label, states, writes };
};`,
        resolveDir: join(root, "scripts/e2e"), loader: "tsx",
      },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.todoSettingsProbe()");
    console.log("TODO_SETTINGS_PROBE " + JSON.stringify(result));
    app.exit(0);
  } catch (error) { console.error(error.stack); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.PI_DESKTOP_DATA_DIR;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill(), 20_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("TODO_SETTINGS_PROBE "));
    assert.ok(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("TODO_SETTINGS_PROBE ".length)), {
      label: "Auto-continue unfinished tasks", states: ["true", "false", "false", "true"],
      writes: [{ autoContinueUnfinishedTodos: false }, { autoContinueUnfinishedTodos: true }],
    });
  } finally { await rm(temp, { recursive: true, force: true }); }
});
