import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { IPC, bindingForCustomModel, DEFAULT_DELEGATION_LIMITS, DELEGATION_LIMIT_RANGES, DEFAULT_DELEGATION_RUN_POLICY, DELEGATION_RUN_POLICY_LIMITS } from "@pi-desktop/shared";
import { delegationRunPolicyFields } from "../../apps/desktop/src/lib/subagent-run-policy";
import { SubagentTranscriptTab } from "../../apps/desktop/src/components/workpanel/SubagentTranscriptTab";
import { SubagentSettingsPage } from "../../apps/desktop/src/components/settings/SubagentSettingsPage";
import { ModelSelectionPanes, useModelSelection } from "../../apps/desktop/src/components/settings/ModelSelectionPanes";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import "../../apps/desktop/src/styles/tokens.css";
import "../../apps/desktop/src/styles/base.css";
import "../../apps/desktop/src/styles/ui-kit.css";
import "../../apps/desktop/src/styles/settings.css";

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
function render(mode = "settings", props = {}) {
  flushSync(() => rootNode.render(React.createElement(
    mode === "settings" ? SubagentSettingsPage : mode === "transcript" ? SubagentTranscriptTab : ModelPane,
    { key: ++round, saveSettings, ...props },
  )));
}
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
async function waitFor(predicate, message) {
  const initial = predicate();
  if (initial) return initial;
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      const value = predicate();
      if (!value) return;
      observer.disconnect();
      clearTimeout(deadline);
      resolve(value);
    });
    const deadline = setTimeout(() => {
      observer.disconnect();
      reject(new Error(message));
    }, 2000);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
}
function check(condition, message) {
  if (!condition) throw new Error(message);
}
const button = (label) => [...document.querySelectorAll("button")]
  .find((node) => node.textContent.trim() === label || node.getAttribute("aria-label") === label);
function click(label) {
  const node = button(label);
  check(node && !node.disabled, "Missing or disabled button: " + label);
  node.scrollIntoView({ block: "nearest" });
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
  const node = await waitFor(() => [...document.querySelectorAll('[role="option"]')]
    .find((item) => item.textContent.trim() === text && item.closest(".is-open")), "Menu option not visible: " + text);
  flushSync(() => node.click());
  check(button(label).getAttribute("aria-expanded") === "false", "Menu did not close after selection");
}
const name = (id) => "Workspace / " + id + " (account)";
const priority = (id) => "Priority for " + name(id);
const description = (id) => "Model selection guidance for " + name(id);
const approval = (id) => "Approval for " + name(id);
const waitLabel = "Approval wait (seconds)";
const modelLabels = () => [...document.querySelectorAll(".delegation-model-list button")]
  .map((node) => node.getAttribute("aria-label"));
function selectModel(id) {
  click(name(id));
  check(button(name(id)).getAttribute("aria-pressed") === "true", "model selection did not follow identity");
  check(document.querySelectorAll(".delegation-model-editor textarea").length === 1, "more than one model editor mounted");
}

window.schedulingLayoutProbe = async (width, theme) => {
  document.documentElement.dataset.theme = theme;
  document.getElementById("root").style.width = width + "px";
  const models = Array.from({ length: 40 }, (_, index) => ({
    providerId: index === 39 ? "missing-account" : index === 1 ? "peer-account" : "account",
    modelId: index === 0 ? "model-" + "long-identity-".repeat(12) : index < 3 ? "same-model" : "model-" + index,
    enabled: index % 5 !== 0, priority: 40 - index, approval: index % 2 ? "ask" : "auto", description: "",
  }));
  const pool = { version: 1, approvalTimeoutSeconds: 60, models };
  const serialized = JSON.stringify(pool);
  flushSync(() => useAppStore.setState({ settings: { ...persisted, delegation: pool }, providers: [
    { ...originalProviders[0], models: models.filter((model) => model.providerId === "account").map((model) => ({ id: model.modelId })) },
    { ...originalProviders[0], id: "peer-account", models: [{ id: "same-model" }] },
  ] }));
  render();
  click("Scheduling");
  await settle();
  const list = document.querySelector(".delegation-model-list");
  const sidebar = document.querySelector(".delegation-model-sidebar").getBoundingClientRect();
  const editor = document.querySelector(".delegation-model-editor").getBoundingClientRect();
  const workbench = document.querySelector(".delegation-workbench");
  const priorities = [...list.querySelectorAll(".delegation-model-priority")].map((node) => Number(node.textContent));
  check(priorities.length === 40 && priorities.every((number, index) => number === index + 1), "saved pool not displayed in ascending priority order");
  check(JSON.stringify(pool) === serialized && writes.length === 0, "display sorting mutated saved data");
  check(list.scrollHeight > list.clientHeight && list.clientHeight <= (width > 720 ? 452 : 232), "many models expanded the page instead of scrolling locally");
  check(workbench.scrollWidth <= workbench.clientWidth + 1, "model workbench overflows horizontally");
  check(width > 720 ? sidebar.right <= editor.left : sidebar.bottom <= editor.top, "workbench did not adapt to available width");
  check(document.querySelectorAll(".delegation-model-editor textarea").length === 1, "large pool rendered more than one editor");
  check(document.body.textContent.includes(i18n.t("settings.delegationUnavailable")), "unavailable saved model cannot be inspected");
  const peers = modelLabels().filter((label) => label.includes("same-model"));
  check(peers.length === 2 && peers[0] !== peers[1], "same-name models lost provider identity");
  const target = name(models[0].modelId);
  button(target).focus();
  check(document.activeElement === button(target), "model selector did not accept keyboard focus");
  return { width, theme, models: priorities.length, target };
};
window.schedulingKeyboardProbe = async (target) => {
  await settle();
  check(button(target).getAttribute("aria-pressed") === "true", "keyboard activation did not select model");
  const editor = document.querySelector(".delegation-model-editor");
  check(editor.getAttribute("aria-label") === target && editor.scrollWidth <= editor.clientWidth + 1, "long selected identity overflowed or selected another model");
};
window.resetSchedulingFixture = () => {
  flushSync(() => rootNode.render(null));
  useAppStore.setState({ settings: persisted, providers: structuredClone(originalProviders), settingsAnchor: null });
  document.getElementById("root").style.width = "";
};

window.runPolicyProbe = async () => {
  const label = (key) => i18n.t(delegationRunPolicyFields.find((item) => item.key === key).label);
  const recoveryLabel = i18n.t("settings.delegationRunReportRecovery");
  const recoveryToggle = () => [...document.querySelectorAll('[role="switch"]')].find(node => node.getAttribute("aria-label") === recoveryLabel);
  const policyValues = () => ({
    ...Object.fromEntries(delegationRunPolicyFields.map(({ key }) => [key, Number(field(label(key)).value)])),
    reportRecoveryAttempts: recoveryToggle()?.getAttribute("aria-checked") === "true" ? 1 : 0,
  });
  const equals = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), message + ": " + JSON.stringify(actual));
  const saved = () => waitFor(() => [...document.querySelectorAll('[role="status"]')]
    .some((node) => node.textContent === i18n.t("settings.delegationSaved")), "run policy save did not finish");
  render();
  await settle();
  click("Scheduling");
  equals(policyValues(), DEFAULT_DELEGATION_RUN_POLICY, "omitted policy did not show defaults");
  check(recoveryToggle()?.getAttribute("aria-checked") === "false", "optional report recovery is not visibly disabled by default");
  check(writes.length === 0 && persisted.delegation === undefined, "reading defaults wrote settings");
  check(delegationRunPolicyFields.length === 3, "retired report controls remain visible");
  // Old trial values are readable, ignored during work, and removed on a new save.
  persisted = { ...persisted, delegation: { version: 1, approvalTimeoutSeconds: 60,
    models: [{ providerId: "account", modelId: "legacy", enabled: true, priority: 1, approval: "auto", description: "" }],
    runPolicy: { ...DEFAULT_DELEGATION_RUN_POLICY, checkpointInterval: 1, maxCheckpointRequests: 1 } } };
  flushSync(() => useAppStore.setState({ settings: persisted }));
  for (const { key } of delegationRunPolicyFields) {
    const { min, max } = DELEGATION_RUN_POLICY_LIMITS[key];
    for (const invalid of ["", min - 1, max + 1, min + 0.5]) {
      input(label(key), invalid);
      check(button("Save").disabled && field(label(key)).getAttribute("aria-invalid") === "true", "invalid policy value accepted: " + key);
      check(field(label(key)).value === String(invalid), "invalid value was silently clamped: " + key);
      check([...document.querySelectorAll('[role="alert"]')].some((node) => node.textContent === i18n.t("settings.delegationRunInvalid")), "localized policy validation error missing");
      check(![...document.querySelectorAll('[role="alert"]')].some((node) => node.textContent === i18n.t("settings.delegationInvalid")), "run policy error showed unrelated model-policy validation");
      flushSync(() => button("Save").click());
      check(writes.length === 0, "invalid policy was saved");
    }
    input(label(key), DEFAULT_DELEGATION_RUN_POLICY[key]);
  }
  const edited = { maxToolCalls: 0, maxDurationSeconds: 0, finalReportTimeoutSeconds: 45, reportRecoveryAttempts: 1 };
  for (const { key } of delegationRunPolicyFields) input(label(key), edited[key]);
  flushSync(() => recoveryToggle().click());
  click("Save");
  await saved();
  equals(persisted.delegation.runPolicy, edited, "policy edits were not saved");
  render();
  click("Scheduling");
  equals(policyValues(), edited, "saved policy was not retained on reload");
  input(description("legacy"), "Model changes preserve run policy");
  click("Remove " + name("legacy") + " from scheduling");
  await option("Choose a configured model", name("alpha"));
  click("Add model");
  input(description("alpha"), "Model changes preserve run policy");
  click("Save");
  await saved();
  equals(persisted.delegation.runPolicy, edited, "model edit/removal replaced policy");
  input(label("maxToolCalls"), 64);
  input(label("maxDurationSeconds"), 120);
  input(description("alpha"), "Keep this model draft");
  input(waitLabel, 19);
  failNext = true;
  const persistedBeforeFailure = JSON.stringify(persisted);
  click("Save");
  await waitFor(() => document.querySelector('[role="alert"]')?.textContent.includes("fixture disk unavailable"), "policy failure was not displayed");
  check(field(label("maxToolCalls")).value === "64" && field(label("maxDurationSeconds")).value === "120", "failed save lost policy draft");
  check(JSON.stringify(persisted) === persistedBeforeFailure, "failed save changed persisted values");
  click(i18n.t("settings.delegationRunReset"));
  equals(policyValues(), DEFAULT_DELEGATION_RUN_POLICY, "restore defaults did not restore the supported fields");
  check(field(description("alpha")).value === "Keep this model draft" && field(waitLabel).value === "19", "restoring policy defaults overwrote other edits");
  check(button(approval("alpha")).textContent.includes("Ask every time") && modelLabels().length === 1, "restoring defaults changed model authorization");
  click("Save");
  await saved();
  equals(persisted.delegation.runPolicy, DEFAULT_DELEGATION_RUN_POLICY, "restored defaults were not saved");
  check(persisted.delegation.models[0].description === "Keep this model draft" && persisted.delegation.approvalTimeoutSeconds === 19, "default save lost other draft values");
  render();
  click("Scheduling");
  equals(policyValues(), DEFAULT_DELEGATION_RUN_POLICY, "restored defaults were not retained");

  // Render the real work-panel tab against task metadata and different global settings.
  const snapshot = { maxToolCalls: 0, maxDurationSeconds: 77, checkpointInterval: 9, maxCheckpointRequests: 4, finalReportTimeoutSeconds: 61 };
  const task = (id, delegationId, runPolicy) => ({ id, sessionId: "policy-session", role: "tool", content: "", status: "complete", createdAt: "2026-11-12T00:00:00.000Z",
    toolName: "Task", toolCallId: "call-" + id, toolArgs: { task: "Inspect " + delegationId },
    toolResult: { details: { delegationId, status: "completed", ...(runPolicy === undefined ? {} : { runPolicy }) } } });
  flushSync(() => useAppStore.setState({ activeSessionId: "policy-session", runningSessions: {}, messages: [
    task("old", "chosen", DEFAULT_DELEGATION_RUN_POLICY),
    task("current", "chosen", snapshot),
    task("other", "other", { ...snapshot, maxDurationSeconds: 999 }),
    task("legacy", "legacy"),
    task("partial", "partial", { maxToolCalls: 12 }),
  ] }));
  render("transcript", { delegationId: "chosen" });
  await settle();
  const summary = () => document.querySelector('section[aria-label="' + i18n.t("settings.delegationRunSnapshot") + '"]');
  check(summary(), "task snapshot summary is absent");
  const rows = [...summary().querySelectorAll("dl > div")];
  equals(rows.map((row) => row.querySelector("dd").textContent), delegationRunPolicyFields.map(({ key, unit }) =>
    snapshot[key] === 0 ? i18n.t("settings.delegationRunUnlimited") : snapshot[key] + " " + i18n.t(unit)), "tab displayed global settings or another task instead of latest task snapshot");
  check(!summary().querySelector("input, button"), "snapshot exposes running-policy editing controls");
  flushSync(() => useAppStore.setState({ settings: { ...persisted, delegation: { ...persisted.delegation,
    runPolicy: { ...DEFAULT_DELEGATION_RUN_POLICY, maxDurationSeconds: 888 } } } }));
  check(summary().textContent.includes("77 seconds") && !summary().textContent.includes("888"), "global setting update changed task snapshot");
  for (const delegationId of ["legacy", "partial"]) {
    render("transcript", { delegationId });
    await settle();
    check(!summary(), "missing or partial task metadata fabricated defaults: " + delegationId);
  }
  const settingsWrites = writes.length;
  flushSync(() => rootNode.render(null));
  persisted = { defaultMode: "agent", theme: "light", language: "en", developerMode: false };
  writes = [];
  useAppStore.setState({ settings: persisted, providers: structuredClone(originalProviders), activeSessionId: null,
    messages: [], runningSessions: {}, settingsAnchor: null });
  return { passed: true, fields: delegationRunPolicyFields.length, settingsWrites, snapshotRendered: true };
};

window.capacityProbe = async () => {
  const labels = { maxDefinitions: "settings.delegationMaxDefinitions", maxConcurrent: "settings.delegationMaxConcurrent" };
  const values = () => Object.fromEntries(Object.entries(labels).map(([key, label]) => [key, Number(field(i18n.t(label)).value)]));
  const equals = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), message + ": " + JSON.stringify(actual));
  const saved = () => waitFor(() => [...document.querySelectorAll('[role="status"]')]
    .some(node => node.textContent === i18n.t("settings.delegationSaved")), "capacity save did not finish");
  for (const [locale, catalog] of Object.entries(catalogs)) {
    i18n.addResourceBundle(locale, "translation", flatten(catalog));
    await i18n.changeLanguage(locale);
    render();
    click(i18n.t("settings.delegationScheduling"));
    equals(values(), DEFAULT_DELEGATION_LIMITS, locale + " capacity defaults differ");
  }
  await i18n.changeLanguage("en");
  render();
  click("Scheduling");
  check(writes.length === 0 && persisted.delegation === undefined, "reading capacity defaults wrote settings");
  for (const [key, range] of Object.entries(DELEGATION_LIMIT_RANGES)) {
    const label = i18n.t(labels[key]);
    const node = field(label);
    check(node.min === String(range.min) && node.max === String(range.max), "capacity range not exposed accessibly");
    for (const invalid of ["", 0, range.max + 1, 1.5]) {
      input(label, invalid);
      check(button("Save").disabled && field(label).getAttribute("aria-invalid") === "true", "invalid capacity accepted: " + key);
      check(field(label).value === String(invalid), "capacity input silently clamped");
      check([...document.querySelectorAll('[role="alert"]')].some(node => node.textContent === i18n.t("settings.delegationRunInvalid")), "capacity validation error missing");
      check(![...document.querySelectorAll('[role="alert"]')].some(node => node.textContent === i18n.t("settings.delegationInvalid")), "capacity showed unrelated model error");
      flushSync(() => button("Save").click());
      check(writes.length === 0, "invalid capacity saved");
    }
    input(label, DEFAULT_DELEGATION_LIMITS[key]);
  }
  input(i18n.t(labels.maxDefinitions), 24);
  input(i18n.t(labels.maxConcurrent), 12);
  input(description("legacy"), "Keep model guidance");
  input(waitLabel, 17);
  click("Save");
  await saved();
  equals(persisted.delegation.limits, { maxDefinitions: 24, maxConcurrent: 12 }, "capacity not persisted");
  render();
  click("Scheduling");
  equals(values(), persisted.delegation.limits, "capacity lost on reopen");
  input(i18n.t(labels.maxDefinitions), 32);
  input(i18n.t(labels.maxConcurrent), 20);
  failNext = true;
  const before = JSON.stringify(persisted);
  click("Save");
  await waitFor(() => document.querySelector('[role="alert"]')?.textContent.includes("fixture disk unavailable"), "capacity failure hidden");
  equals(values(), { maxDefinitions: 32, maxConcurrent: 20 }, "failed save lost capacity draft");
  check(JSON.stringify(persisted) === before, "failed save altered stored capacity");
  click("Save");
  await saved();
  equals(persisted.delegation.limits, { maxDefinitions: 32, maxConcurrent: 20 }, "retry lost capacity draft");
  click(i18n.t("settings.delegationLimitsReset"));
  equals(values(), DEFAULT_DELEGATION_LIMITS, "capacity reset failed");
  check(field(description("legacy")).value === "Keep model guidance" && field(waitLabel).value === "17", "capacity reset overwrote other settings");
  click("Save");
  await saved();
  render();
  click("Scheduling");
  equals(values(), DEFAULT_DELEGATION_LIMITS, "capacity reset not retained");
  check(JSON.stringify(useAppStore.getState().providers) === JSON.stringify(originalProviders), "capacity save mutated providers");
  return { passed: true, locales: Object.keys(catalogs).length, settingsWrites: writes.length };
};

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
  check(document.querySelector(".delegation-model-list"), "scheduling models need a compact selector instead of expanded forms");
  check(field(priority("legacy")) && !field(priority("alpha"), false), "legacy opt-ins not loaded");
  check(writes.length === 0 && persisted.delegation === undefined, "viewing legacy settings enabled policy");
  check(document.body.textContent.includes("even pinned role models and default models"), "membership help missing");
  click("Remove " + name("legacy") + " from scheduling");
  await option("Choose a configured model", name("alpha"));
  click("Add model");
  await option("Choose a configured model", name("beta"));
  click("Add model");
  check(button(approval("beta")).textContent.includes("Ask every time") && !field(priority("alpha"), false), "new model should open alone and require approval");
  selectModel("alpha");
  check(button(approval("alpha")).textContent.includes("Ask every time"), "new alpha model must require approval");
  const activeInput = field(priority("alpha"));
  activeInput.focus();
  input(priority("alpha"), 20);
  check(modelLabels()[0] === name("beta") && document.activeElement === activeInput && button(name("alpha")).getAttribute("aria-pressed") === "true", "sorting stole the active model or input focus");
  input(priority("alpha"), "");
  check(button("Save").disabled && field(priority("alpha")).value === "", "empty priority lost its editor or enabled Save");
  input(priority("alpha"), 7);
  selectModel("beta");
  input(priority("beta"), 7);
  check(JSON.stringify(modelLabels()) === JSON.stringify([name("alpha"), name("beta")]), "equal priorities must retain original order");
  selectModel("alpha");
  await option(approval("alpha"), "Allow automatically");
  input(description("alpha"), "Fast code review with predictable cost");
  selectModel("beta");
  input(description("beta"), "Deep reasoning for difficult migrations");
  input(waitLabel, 0);
  click("Enable scheduling for " + name("beta"));
  check(button(name("beta")).textContent.includes(i18n.t("settings.providerDisabledBadge")), "disabled model disappeared or lacks status");
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
  check(field(priority("alpha")).value === "7" && button(approval("alpha")).textContent.includes("Allow automatically"), "alpha edits lost on reload");
  selectModel("beta");
  check(field(priority("beta")).value === "7" && button(approval("beta")).textContent.includes("Ask every time"), "beta edits lost on reload");
  check(field(description("beta")).value === expected.models[1].description && field(waitLabel).value === "0", "description or zero wait lost on reload");
  input(description("beta"), "Preserve this edit after failure");
  selectModel("alpha");
  check(field(description("alpha")).value === expected.models[0].description, "switching models lost description");
  input(priority("alpha"), 9);
  check(modelLabels()[0] === name("beta"), "priority edit did not reorder sidebar");
  selectModel("beta");
  input(waitLabel, 300);
  click("Roles");
  click("Scheduling");
  check(field(description("beta")).value === "Preserve this edit after failure", "tab navigation lost draft");
  failNext = true;
  click("Save");
  await waitFor(() => document.querySelector('[role="alert"]')?.textContent.includes("fixture disk unavailable"), "failed save did not surface error");
  check(field(description("beta")).value === "Preserve this edit after failure" && field(waitLabel).value === "300", "failed save lost edits");
  selectModel("alpha");
  check(field(priority("alpha")).value === "9", "failed save lost another model's edits");
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
  check(field(priority("beta")) && modelLabels()[0] === name("beta"), "reload did not select highest priority model");
  selectModel("alpha");
  check(field(priority("alpha")).value === "9" && field(waitLabel).value === "300", "retry did not persist edits");
  click("Remove " + name("alpha") + " from scheduling");
  check(field(priority("beta")) && modelLabels().length === 1, "removing selected model lost remaining editor");
  click("Remove " + name("beta") + " from scheduling");
  check(!document.querySelector(".delegation-model-editor") && document.body.textContent.includes(i18n.t("settings.delegationEmpty")), "last removal did not show empty state");
  await option("Choose a configured model", name("alpha"));
  click("Add model");
  check(field(priority("alpha")) && modelLabels().length === 1, "adding after empty state did not open editor");
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
      loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
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
    await writeFile(join(temp, "renderer.css"), (await readFile(join(temp, "renderer.css"), "utf8")).replace(/@theme(?: inline)?\s*\{/g, ":root {"));
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 760,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on("console-message", (_event, ...args) => console.log("RENDERER", ...args));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    for (const [width, theme] of [[1000, "light"], [360, "dark"]]) {
      const layout = await win.webContents.executeJavaScript("window.schedulingLayoutProbe(" + width + ", " + JSON.stringify(theme) + ").catch(error => { console.error(error.stack); throw error; })");
      console.log("LAYOUT_PROBE " + JSON.stringify(layout));
      win.webContents.focus();
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      win.webContents.sendInputEvent({ type: "char", keyCode: "\\r" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      await win.webContents.executeJavaScript("window.schedulingKeyboardProbe(" + JSON.stringify(layout.target) + ")");
    }
    await win.webContents.executeJavaScript("window.resetSchedulingFixture()");
    console.log("SCHEDULING_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.schedulingProbe().catch(error => { console.error(error.stack); throw error; })")));
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("RUN_POLICY_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.runPolicyProbe().catch(error => { console.error(error.stack); throw error; })")));
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("CAPACITY_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.capacityProbe().catch(error => { console.error(error.stack); throw error; })")));
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
      stream.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
    }
    const timer = setTimeout(() => child.kill(), 25_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    } finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-8000));
    const capacityLine = output.split(/\r?\n/).find(item => item.startsWith("CAPACITY_PROBE "));
    assert.ok(capacityLine, output.slice(-8000));
    assert.deepEqual(JSON.parse(capacityLine.slice("CAPACITY_PROBE ".length)), {
      passed: true, locales: 9, settingsWrites: 4,
    });
    const policyLine = output.split(/\r?\n/).find((item) => item.startsWith("RUN_POLICY_PROBE "));
    assert.ok(policyLine, output.slice(-8000));
    assert.deepEqual(JSON.parse(policyLine.slice("RUN_POLICY_PROBE ".length)), {
      passed: true, fields: 3, settingsWrites: 4, snapshotRendered: true,
    });
    const line = output.split(/\r?\n/).find((item) => item.startsWith("SCHEDULING_PROBE "));
    assert.ok(line, output.slice(-8000));
    assert.deepEqual(JSON.parse(line.slice("SCHEDULING_PROBE ".length)), {
      passed: true, locales: 9, settingsWrites: 4, providerEdits: 0,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
