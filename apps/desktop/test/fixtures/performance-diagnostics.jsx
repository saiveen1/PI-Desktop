import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { DeveloperSection } from "../../src/features/settings/developer-sections";
import { searchSettings } from "../../src/lib/settings-search";
import { api } from "../../src/lib/api";
import { useAppStore } from "../../src/stores/app-store";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/styles/ui-kit.css";
import "../../src/styles/settings.css";

await i18n.use(initReactI18next).init({ lng: "en", interpolation: { escapeValue: false }, resources: Object.fromEntries(Object.entries(catalogs).map(([locale, catalog]) => [locale, { translation: catalog }])) });
window.piDesktop = { platform: "win32", invoke: () => { throw Error("Fixture must not invoke Desktop"); }, on: () => () => {} };
const calls = [];
const realSetTimeout = window.setTimeout.bind(window), realClearTimeout = window.clearTimeout.bind(window);
const timers = new Map(); let nextTimer = 100000, hidden = false;
window.setTimeout = (fn, delay, ...args) => delay === 2000 ? (timers.set(++nextTimer, () => fn(...args)), nextTimer) : realSetTimeout(fn, delay, ...args);
window.clearTimeout = id => { if (timers.has(id)) timers.delete(id); else realClearTimeout(id); };
Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
const setHidden = value => { hidden = value; document.dispatchEvent(new Event("visibilitychange")); };
const tick = () => { const [id, fn] = timers.entries().next().value ?? []; if (!fn) throw Error("Missing diagnostics poll"); timers.delete(id); fn(); };

const stamp = Date.UTC(2026, 10, 17, 10);
const snapshot = { at: stamp, truncated: true, processes: [
  { pid: 17, role: "main", owner: null, startedAt: stamp, cpuPercent: 0, workingSetKiB: 1024, privateKiB: null },
  { pid: 23, role: "plugin", owner: "fixture.plugin-with-an-extremely-long-unbroken-identifier-for-layout", startedAt: null, cpuPercent: null, workingSetKiB: 2048, privateKiB: 512 },
] };
let main = { phase: "idle", id: null, startedAt: null, endedAt: null, deadline: null, sampleCount: 0,
  latest: snapshot, maxMainDelayMs: null, maxUiDelayMs: 0, markerCount: 0 };
let failure = null, held = null, inFlight = 0, maxInFlight = 0, saveResult = false;
function holdNext(kind) {
  let release, started;
  const promise = new Promise(resolve => { release = resolve; });
  const hasStarted = new Promise(resolve => { started = resolve; });
  held = { kind, promise, release, started, hasStarted };
  return held;
}
async function perform(kind, ...args) {
  calls.push([kind, ...args]); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    if (failure === kind) { failure = null; throw Error("fixture secret should not appear"); }
    if (held?.kind === kind) { const item = held; held = null; item.started(); const override = await item.promise; if (override !== undefined) return override; }
    if (kind === "snapshot") return structuredClone(main);
    if (kind === "start") {
      main = { ...main, phase: "recording", id: 41, startedAt: stamp, deadline: stamp + 30000, endedAt: null, sampleCount: 1, markerCount: 0, maxMainDelayMs: 0, maxUiDelayMs: null };
      return structuredClone(main);
    }
    if (kind === "mark") { if (args[0] !== main.id) throw Error("wrong marker capture"); main.markerCount++; return structuredClone(main); }
    if (kind === "stop") { if (args[0] !== main.id) throw Error("wrong stop capture"); main = { ...main, phase: "complete", endedAt: stamp + 2000, deadline: null, sampleCount: 3, maxMainDelayMs: 12.5, maxUiDelayMs: 9 }; return structuredClone(main); }
    if (kind === "preview") { if (args[0] !== main.id || main.phase !== "complete") throw Error("wrong preview capture"); return JSON.stringify({ demo: true, capture: main.id, long: "x".repeat(400) }, null, 2); }
    if (kind === "save") { if (args[0] !== main.id || main.phase !== "complete") throw Error("wrong save capture"); return { saved: saveResult }; }
    throw Error("unexpected action");
  } finally { inFlight--; }
}
api.performanceDiagnostics = (...args) => perform(...args);
api.previewPerformanceReport = id => perform("preview", id);
api.exportPerformanceReport = id => perform("save", id);
api.getToolObservations = async () => ({ since: "demo", generatedAt: "demo", total: 0, groups: [], counts: {}, coverage: { filesRead: 0, malformedLines: 0, ignoredLegacyRecords: 0, readErrors: 0, limited: false } });
let incidentFolders = 0;
api.openLogs = async () => {
  if (++incidentFolders === 1) throw Error("fixture secret should not appear");
  return { ok: true };
};
useAppStore.setState({ settings: { developerMode: false } });
let setInfo;
function Harness() {
  const [developer, setDeveloper] = useState(false);
  const [info, changeInfo] = useState(true);
  setInfo = changeInfo;
  return <main className="fixture-page">{info ? <DeveloperSection settings={{ developerMode: developer }} saveSettings={async patch => {
    setDeveloper(patch.developerMode); useAppStore.setState({ settings: { developerMode: patch.developerMode } });
  }} /> : <p>Demo navigation away from Info</p>}</main>;
}
const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(<Harness />));
const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const check = (condition, message) => { if (!condition) throw Error(message); };
const buttons = () => [...document.querySelectorAll("button")];
const button = key => { const label = i18n.t(`performanceDiagnostics.${key}`); const node = buttons().find(item => item.textContent.trim() === label); check(node, `Missing button ${label}`); return node; };
const click = async node => { flushSync(() => node.click()); await settle(); };
const text = () => document.querySelector(".performance-content")?.textContent ?? "";
const navigate = async value => { flushSync(() => setInfo(value)); await settle(); };

window.performanceProbe = async stage => {
  if (stage === "gate") {
    for (const [locale, catalog] of Object.entries(catalogs)) check(catalog.performanceDiagnostics?.title, `Missing diagnostics copy for ${locale}`);
    check(catalogs['zh-CN'].performanceDiagnostics.title === '性能诊断' && catalogs['zh-TW'].performanceDiagnostics.title === '效能診斷', 'Chinese copy missing');
    for (const locale of ['de', 'es', 'fr', 'ko', 'pt-BR', 'tr']) check(catalogs[locale].performanceDiagnostics === catalogs.en.performanceDiagnostics, `Fallback mismatch: ${locale}`);
    check(!document.body.textContent.includes(i18n.t("performanceDiagnostics.title")), "Developer gating failed");
    check(searchSettings("performanceDiagnostics.title", x => x, { developerMode: false }).length === 0, "Search exposes disabled diagnostics");
    check(searchSettings("performanceDiagnostics.title", x => x, { developerMode: true }).some(hit => hit.tab === "about"), "Developer search missing");
    const toggle = document.querySelector('[role="switch"]'); check(toggle, "Missing real developer toggle"); await click(toggle);
    check(button("open").getAttribute("aria-expanded") === "false" && calls.length === 0 && timers.size === 0, "Collapsed diagnostics requested data");
  } else if (stage === "error-and-retry") {
    failure = "snapshot"; await click(button("open"));
    check(document.querySelector('.performance-error[role="alert"]') && !document.body.textContent.includes("fixture secret"), "Failure was hidden or unsanitized");
    await click(button("retry"));
    check(button("start") && document.querySelector(".performance-table"), "Retry did not render measurements");
    const cells = [...document.querySelectorAll(".performance-table tbody tr:first-child td")].map(cell => cell.textContent.trim());
    check(cells[0] === "0" && cells[1] === "1" && cells[2] === i18n.t("performanceDiagnostics.unavailable"), "Zero/null or KiB conversion incorrect");
    check(text().includes(i18n.t("performanceDiagnostics.truncated")), "Missing truncation notice");
    check(calls.filter(call => call[0] === "snapshot").every(call => call.length === 1), "Snapshot sent an id");
    check(text().includes("app/performance.log"), "Incident log location missing");
    await click(button("openIncidentLogs"));
    check(text().includes(i18n.t("performanceDiagnostics.incidentLogsError")) && !text().includes("fixture secret"), "Log-folder error missing or unsanitized");
    await click(button("openIncidentLogs"));
    check(incidentFolders === 2 && !text().includes(i18n.t("performanceDiagnostics.incidentLogsError")), "Log-folder retry did not clear the error");
    check(calls.every(([kind]) => kind === "snapshot"), "Opening incident logs started an opt-in capture");
  } else if (stage === "record-and-save") {
    failure = "start"; await click(button("start"));
    check(document.querySelector('.performance-error[role="alert"]') && button("start"), "Start failure/retry missing");
    button("start").focus(); await click(button("start")); check(calls.some(call => call[0] === "start" && call.length === 1), "Start sent an id");
    check(document.activeElement === button("stop"), "Starting a recording lost keyboard focus");
    check(text().includes(i18n.t("performanceDiagnostics.status.recording")), "Recording state missing");
    await click(button("mark")); check(calls.some(call => call[0] === "mark" && call[1] === 41), "Marker lost capture id");
    button("stop").focus(); await click(button("stop")); check(calls.some(call => call[0] === "stop" && call[1] === 41), "Stop lost capture id");
    check(document.activeElement === button("preview"), "Stopping a recording lost keyboard focus");
    check(text().includes("12.5 ms") && text().includes("9 ms"), "Recorded delays missing");
    await click(button("preview")); const preview = document.querySelector(".performance-preview pre");
    check(preview && preview.textContent.includes('"capture": 41') && !preview.isContentEditable, "Preview missing or editable");
    await click(button("save")); check(calls.some(call => call[0] === "save" && call[1] === 41), "Save lost capture id");
    check(text().includes(i18n.t("performanceDiagnostics.cancelled")) && !document.querySelector(".performance-error"), "Cancel treated as error");
    check(document.querySelector(".performance-preview pre").textContent === preview.textContent, "Cancel changed preview");
    saveResult = true; await click(button("save")); check(text().includes(i18n.t("performanceDiagnostics.saved")), "Save success missing");
    failure = "save"; await click(button("save")); check(document.querySelector('.performance-error[role="alert"]') && button("save"), "Save failure/retry missing");
  } else if (stage === "poll-visibility") {
    check(timers.size === 1, "Expected exactly one poll timer"); const before = calls.length;
    setHidden(true); check(timers.size === 0, "Hidden document retained a timer");
    setHidden(false); await settle(); check(calls.length === before + 1 && calls.at(-1)[0] === "snapshot", "Visibility did not refresh once");
    main = { ...main, id: 42 }; tick(); await settle();
    check(!document.querySelector(".performance-preview"), "Changed capture retained stale preview");
    check(timers.size === 1 && maxInFlight === 1, "Polling overlapped or duplicated");
  } else if (stage === "stale-navigation") {
    const pending = holdNext("preview"); await click(button("preview")); await pending.hasStarted;
    check(button("preview").disabled, "Pending preview not disabled");
    const oldStops = calls.filter(call => call[0] === "stop").length;
    await navigate(false); check(timers.size === 0, "Navigation left a timer");
    await navigate(true); await click(button("open"));
    const readsBefore = calls.filter(call => call[0] === "snapshot").length;
    pending.release('{"stale":true}'); await settle();
    check(calls.filter(call => call[0] === "snapshot").length === readsBefore + 1, "Revisit did not re-read after old request");
    check(!document.querySelector(".performance-preview") && !text().includes("stale"), "Unmounted preview was published");
    check(calls.filter(call => call[0] === "stop").length === oldStops && maxInFlight === 1, "Unmount stopped capture or overlapped requests");
    await click(button("preview"));
  } else if (stage === "recording-revisit") {
    await click(button("startNew")); await navigate(false); check(timers.size === 0, "Recording navigation retained polling");
    const oldStops = calls.filter(call => call[0] === "stop").length;
    await navigate(true); await click(button("open"));
    check(text().includes(i18n.t("performanceDiagnostics.status.recording")), "Revisit did not restore recording state");
    check(calls.filter(call => call[0] === "stop").length === oldStops, "Navigation stopped recording");
    button("stop").focus();
    main = { ...main, phase: "complete", endedAt: stamp + 30000, deadline: null, sampleCount: 30 }; tick(); await settle();
    check(document.activeElement === button("preview"), "Automatic cutoff lost keyboard focus");
    check(text().includes(i18n.t("performanceDiagnostics.status.complete")) && text().includes("30"), "Automatic cutoff state not reflected");
    await click(button("preview"));
  } else if (stage === "queued-action") {
    const first = holdNext("snapshot"); tick(); await first.hasStarted; await settle();
    button("preview").focus(); check(!button("preview").disabled, "Passive polling disabled a focused action");
    const before = calls.filter(call => call[0] === "preview").length;
    await click(button("preview")); check(button("preview").disabled && calls.filter(call => call[0] === "preview").length === before, "Action was not queued behind the snapshot");
    first.release(); await settle();
    check(calls.filter(call => call[0] === "preview").length === before + 1 && maxInFlight === 1, "Queued action did not run serially");
    const second = holdNext("snapshot"); tick(); await second.hasStarted; await click(button("preview"));
    const beforeChanged = calls.filter(call => call[0] === "preview").length;
    main = { ...main, id: 43 }; second.release(); await settle();
    check(calls.filter(call => call[0] === "preview").length === beforeChanged && document.querySelector('.performance-error[role="alert"]'), "Changed capture did not invalidate queued action");
    main = { ...main, id: 41 }; tick(); await settle(); await click(button("preview"));
  } else if (stage === "hidden-inflight") {
    const pending = holdNext("snapshot"); tick(); await pending.hasStarted; await settle();
    check(!button("preview").disabled, "Passive snapshot disabled an action");
    const previewsBefore = calls.filter(call => call[0] === "preview").length;
    await click(button("preview")); check(button("preview").disabled, "Queued preview has no busy state");
    setHidden(true); check(timers.size === 0, "Hidden in-flight read retained a timer");
    setHidden(false); const readsBefore = calls.filter(call => call[0] === "snapshot").length;
    pending.release({ ...structuredClone(main), id: 999 }); await settle();
    check(calls.filter(call => call[0] === "snapshot").length === readsBefore + 1, "Visible refresh did not wait for the stale read");
    check(calls.filter(call => call[0] === "preview").length === previewsBefore && document.querySelector('.performance-error[role="alert"]'), "Hidden queued action was not invalidated");
    check(document.querySelector(".performance-preview pre")?.textContent.includes('"capture": 41'), "Hidden stale result replaced the preview");
    check(maxInFlight === 1 && timers.size === 1, "Visibility change overlapped reads");
    await click(button("preview"));
  } else if (stage === "disable-developer") {
    const before = calls.length, stops = calls.filter(call => call[0] === "stop").length;
    await click(document.querySelector('[role="switch"]'));
    check(!document.body.textContent.includes(i18n.t("performanceDiagnostics.title")) && timers.size === 0, "Disabling developer mode left diagnostics active");
    check(calls.length === before && calls.filter(call => call[0] === "stop").length === stops, "Disabling panel issued a recording action");
  }
  return { stage, passed: true };
};
window.performanceLayout = async (theme, language) => {
  document.documentElement.dataset.theme = theme; await i18n.changeLanguage(language); await settle();
  const panel = document.querySelector(".performance-content"), table = document.querySelector(".performance-table");
  check(panel && table, "Layout missing panel or table");
  const p = panel.getBoundingClientRect(), t = table.getBoundingClientRect();
  check(t.left >= p.left && t.right <= p.right + 1, "Table exceeds card");
  for (const row of table.rows) {
    const cells = [...row.cells].map(cell => cell.getBoundingClientRect());
    for (let i = 1; i < cells.length; i++) check(cells[i].left >= cells[i - 1].right - 1, "Table cells overlap");
  }
  check(document.documentElement.scrollWidth <= innerWidth + 1, "Page overflows viewport");
  const pre = document.querySelector(".performance-preview pre"); check(pre && pre.scrollWidth <= pre.clientWidth + 1, "Preview clips long content");
  return { width: innerWidth, theme, language, tableWidth: Math.round(t.width), panelWidth: Math.round(p.width) };
};
window.performanceFixtureReady = true;
