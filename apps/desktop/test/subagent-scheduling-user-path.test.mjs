import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { IPC, bindingForCustomModel } from "@pi-desktop/shared";
import { SubagentSettingsPage } from "../../apps/desktop/src/components/settings/SubagentSettingsPage";
import { ModelSelectionPanes, useModelSelection } from "../../apps/desktop/src/components/settings/ModelSelectionPanes";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

function flatten(value, prefix = "", result = {}) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? prefix + "." + key : key;
    if (typeof child === "string") result[path] = child;
    else flatten(child, path, result);
  }
  return result;
}
await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flatten(catalogs.en) } }, interpolation: { escapeValue: false } });
const originalProviders = [{ id: "account", name: "Workspace", enabled: true,
  vendorKey: "custom", hasSecret: true, hasOauth: false, authKind: "api_key_and_base_url",
  models: [{ id: "legacy", availableForSubagents: true }, { id: "alpha" }, { id: "beta" }] }];
let persisted = { defaultMode: "agent", theme: "light", language: "en", developerMode: false };
let writes = [];
let failNext = false;
let holdNext = false;
let release;
let providerEdits = 0;
const unhandled = [];
window.addEventListener("unhandledrejection", (event) => unhandled.push(String(event.reason)));
window.piDesktop = { platform: "win32", on() { return () => {}; },
  async invoke(channel, input) {
    if (channel === IPC.invoke.subagentList) return { ok: true, data: { subagents: [] } };
    if (channel === IPC.invoke.subagentCatalog) return { ok: true, data: { subagents: [], builtins: [] } };
    if (channel === IPC.invoke.settingsSet) {
      writes.push(structuredClone(input));
      if (holdNext) {
        holdNext = false;
        await new Promise((resolve, reject) => { release = reject; });
      }
      if (failNext) {
        failNext = false;
        return { ok: false, error: { code: "INTERNAL", message: "fixture disk unavailable" } };
      }
      persisted = structuredClone(input);
      return { ok: true, data: undefined };
    }
    throw new Error("Unexpected fixture IPC: " + channel);
  },
};
useAppStore.setState({ settings: persisted, providers: structuredClone(originalProviders),
  settingsTab: "subagents", settingsAnchor: null });
const discovery = { models: [], status: "idle", source: "catalog", canReload: false };
function ModelPane() {
  const [models, setModels] = React.useState([bindingForCustomModel("alpha")]);
  const selection = useModelSelection(discovery, models, (update) => {
    providerEdits += 1;
    setModels(update);
  });
  return React.createElement(ModelSelectionPanes, { discovery, selection, listTitle: "Models" });
}
async function saveSettings(patch) {
  const next = { ...useAppStore.getState().settings, ...patch };
  await api.setSettings(next);
  useAppStore.setState({ settings: next });
}
let round = 0;
const rootNode = createRoot(document.getElementById("root"));
function render(mode = "settings") {
  flushSync(() => rootNode.render(React.createElement(
    mode === "settings" ? SubagentSettingsPage : ModelPane,
    { key: ++round, saveSettings },
  )));
}
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await settle();
  }
  throw new Error(message);
}
function check(condition, message) { if (!condition) throw new Error(message); }
const button = (label) => [...document.querySelectorAll("button")]
  .find((node) => node.textContent.trim() === label || node.getAttribute("aria-label") === label);
function click(label) {
  const node = button(label);
  check(node && !node.disabled, "Missing or disabled button: " + label);
  flushSync(() => node.click());
}
const field = (label, required = true) => {
  const node = [...document.querySelectorAll("input, textarea")].find((node) => node.getAttribute("aria-label") === label);
  if (required) check(node, "Missing field: " + label);
  return node;
};
function input(label, value) {
  const node = field(label);
  check(node, "Missing field: " + label);
  const prototype = node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(node, String(value));
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function option(label, text) {
  click(label);
  await settle();
  const node = [...document.querySelectorAll('[role="option"]')].find((item) => item.textContent.trim() === text);
  check(node, "Missing menu option: " + text);
  flushSync(() => node.click());
  await settle();
}
const name = (id) => "Workspace / " + id + " (account)";
const priority = (id) => "Priority for " + name(id);
const description = (id) => "Model selection guidance for " + name(id);
const approval = (id) => "Approval for " + name(id);
const waitLabel = "Approval wait (seconds)";

window.schedulingProbe = async () => {
  // The old provider checkbox remains available until the first unified save.
  render("models");
  await settle();
  click(i18n.t("settings.advanced"));
  check([...document.querySelectorAll("label")].some((node) => node.textContent.includes("Available for AI delegation") && node.querySelector('input[type="checkbox"]')), "legacy model checkbox missing");
  check(!button("Configure subagent scheduling"), "unified link shown before first save");
  render();
  await settle();
  check(button("Roles").getAttribute("aria-selected") === "true", "roles not the default tab");
  click("Scheduling");
  check(field(priority("legacy")) && !field(priority("alpha"), false), "legacy opt-ins not loaded");
  check(writes.length === 0 && persisted.delegation === undefined, "viewing legacy settings enabled policy");
  check(document.body.textContent.includes("even pinned role models and default models"), "membership help missing");
  click("Remove " + name("legacy") + " from scheduling");
  await option("Choose a configured model", name("alpha"));
  click("Add model");
  await option("Choose a configured model", name("beta"));
  click("Add model");
  check(button(approval("alpha")).textContent.includes("Ask every time") && button(approval("beta")).textContent.includes("Ask every time"), "new models must require approval");
  input(priority("alpha"), 7);
  input(priority("beta"), 7);
  await option(approval("alpha"), "Allow automatically");
  input(description("alpha"), "Fast code review with predictable cost");
  input(description("beta"), "Deep reasoning for difficult migrations");
  input(waitLabel, 0);
  click("Enable scheduling for " + name("beta"));
  click("Enable scheduling for " + name("beta"));
  click("Save");
  await waitFor(() => [...document.querySelectorAll('[role="status"]')].some((node) => node.textContent === i18n.t("settings.delegationSaved")), "save did not finish");
  check(writes.length === 1, "save wrote more than once");
  const expected = { version: 1, approvalTimeoutSeconds: 0, models: [
    { providerId: "account", modelId: "alpha", enabled: true, priority: 7, approval: "auto", description: "Fast code review with predictable cost" },
    { providerId: "account", modelId: "beta", enabled: true, priority: 7, approval: "ask", description: "Deep reasoning for difficult migrations" },
  ] };
  check(JSON.stringify(persisted.delegation) === JSON.stringify(expected), "saved policy differs: " + JSON.stringify(persisted.delegation));
  check(JSON.stringify(useAppStore.getState().providers) === JSON.stringify(originalProviders), "policy save changed provider data");
  render();
  click("Scheduling");
  check(field(priority("alpha")).value === "7" && field(priority("beta")).value === "7", "same priorities lost on reload");
  check(field(description("beta")).value === expected.models[1].description && field(waitLabel).value === "0", "description or zero wait lost on reload");
  check(button(approval("alpha")).textContent.includes("Allow automatically") && button(approval("beta")).textContent.includes("Ask every time"), "approval choices lost on reload");
  // Switching sections preserves unsaved model guidance.
  input(description("beta"), "Preserve this edit after failure");
  input(priority("alpha"), 9);
  input(waitLabel, 300);
  click("Roles");
  click("Scheduling");
  check(field(description("beta")).value === "Preserve this edit after failure", "tab navigation lost draft");
  failNext = true;
  click("Save");
  await waitFor(() => document.querySelector('[role="alert"]')?.textContent.includes("fixture disk unavailable"), "failed save did not surface error");
  check(field(description("beta")).value === "Preserve this edit after failure" && field(priority("alpha")).value === "9" && field(waitLabel).value === "300", "failed save lost edits");
  check(persisted.delegation.models[0].priority === 7 && persisted.delegation.approvalTimeoutSeconds === 0, "failed save changed persisted policy");
  input(waitLabel, 301);
  check(button("Save").disabled && field(waitLabel).getAttribute("aria-invalid") === "true", "out of range wait accepted");
  input(waitLabel, 300);
  input(priority("alpha"), 1.5);
  check(button("Save").disabled, "fractional priority accepted");
  input(priority("alpha"), 9);
  click("Save");
  await waitFor(() => [...document.querySelectorAll('[role="status"]')].some((node) => node.textContent === i18n.t("settings.delegationSaved")), "retry save did not finish");
  render();
  click("Scheduling");
  check(field(priority("alpha")).value === "9" && field(waitLabel).value === "300", "retry did not persist edits");
  // With unified settings, the provider pane only navigates; it never edits opt-ins.
  render("models");
  await settle();
  click(i18n.t("settings.advanced"));
  check(![...document.querySelectorAll("label")].some((node) => node.textContent.includes("Available for AI delegation")), "duplicate legacy checkbox still shown");
  click("Configure subagent scheduling");
  check(providerEdits === 0 && useAppStore.getState().settingsTab === "subagents", "scheduling link edited provider data or failed navigation");
  render();
  await settle();
  check(button("Scheduling").getAttribute("aria-selected") === "true", "deep link did not select scheduling");
  flushSync(() => useAppStore.getState().setSettingsAnchor(null));
  check(button("Scheduling").getAttribute("aria-selected") === "true", "clearing navigation anchor reset tab");
  click("Roles");
  flushSync(() => useAppStore.getState().setSettingsAnchor("settings.delegationScheduling"));
  flushSync(() => useAppStore.getState().setSettingsAnchor(null));
  check(button("Scheduling").getAttribute("aria-selected") === "true", "same-page deep link reset tab");
  // A late failure after leaving Settings is handled without stale UI or unhandled rejection.
  holdNext = true;
  const beforePending = writes.length;
  const save = button("Save");
  flushSync(() => { save.click(); save.click(); });
  check(button("Saving…").disabled && writes.length === beforePending + 1, "pending save was not guarded");
  flushSync(() => rootNode.unmount());
  release(new Error("late fixture failure"));
  await settle();
  check(unhandled.length === 0, "late failure escaped: " + unhandled.join(", "));
  const keys = Object.keys(catalogs.en.settings).filter((key) => key.startsWith("delegation"));
  for (const [locale, catalog] of Object.entries(catalogs)) {
    for (const key of keys) {
      check(typeof catalog.settings[key] === "string", locale + " missing " + key);
      const variables = (text) => [...text.matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1]).sort().join(",");
      check(variables(catalog.settings[key]) === variables(catalogs.en.settings[key]), locale + " interpolation differs for " + key);
    }
  }
  return { passed: true, locales: Object.keys(catalogs).length, settingsWrites: writes.length, providerEdits };
};
`;

test("Subagent scheduling user path preserves legacy opt-ins, policy edits, reload and failures", {
  timeout: 30_000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Isolated Electron fixture requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "delegation-ui-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 760,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (_event, ...args) => console.log("RENDERER", ...args));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("SCHEDULING_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.schedulingProbe().catch(error => { console.error(error.stack); throw error; })")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.PI_DESKTOP_DATA_DIR;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill(), 25_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    } finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-8000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("SCHEDULING_PROBE "));
    assert.ok(line, output.slice(-8000));
    assert.deepEqual(JSON.parse(line.slice("SCHEDULING_PROBE ".length)), {
      passed: true, locales: 9, settingsWrites: 4, providerEdits: 0,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
