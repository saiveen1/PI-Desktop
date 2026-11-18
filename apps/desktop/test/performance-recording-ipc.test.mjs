import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as drain } from "node:timers/promises";
import test from "node:test";
import { IPC, IPC_WHITELIST } from "@pi-desktop/shared/protocol";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerPerformanceIpc } = await import("../electron/main/ipc/performance-ipc.ts");
const { savePerformanceFile } = await import("../electron/main/performance/save-report.ts");

function fixture(overrides = {}) {
  let ms = 0, mode = false, tick, samples = 0;
  const frame = { url: "app://test/main" }, sent = [], saved = [], handlers = new Map();
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame, getURL: () => frame.url,
    isDestroyed: () => false, isCrashed: () => false, send: (channel, value) => sent.push({ channel, value }) });
  const event = { sender: contents, senderFrame: frame };
  const now = () => 1_800_000_000_000 + ms;
  const clear = registerPerformanceIpc({ registrar: {
    assertMainWindowSender(e) { if (e.sender !== contents) throw new Error("Not the main window"); },
    handleWithEvent(channel, handler) { handlers.set(channel, handler); },
  }, getContents: () => contents, isDeveloperMode: () => mode, now, monotonic: () => ms,
  every(period, cb) { assert.equal(period, 100); assert.equal(tick, undefined); tick = cb; return () => { tick = undefined; }; },
  sampler: { reset() {}, async sample() { samples++; return { at: now(), truncated: false, processes: [{ pid: 7, role: "renderer",
    owner: null, startedAt: now() - 1000, cpuPercent: samples === 1 ? null : 0, workingSetKiB: 4096, privateKiB: null }] }; } },
  build: () => ({ appVersion: "1.2.3", buildId: null, platform: "win32", arch: "x64", electron: "43" }),
  chooseFile: async () => "synthetic.json", saveFile: async (path, text, authorized) => { authorized(); saved.push({ path, text }); }, ...overrides });
  const call = (name, ...args) => handlers.get(IPC.invoke[name])(event, ...args);
  return { call, action: (...args) => call("performanceDiagnostics", ...args), clear, contents, event, handlers, sent, saved,
    enable(value) { mode = value; }, advance(value) { ms += value; tick?.(); }, active: () => !!tick, samples: () => samples };
}
const pulse = (id) => ({ id, maxDelayMs: 150, sessionSwitches: 1, toolOpens: 2, stages: { "markdown-split": { count: 2, maxMs: 17 } } });

test("only the developer-enabled main top frame can sample, mark or save", async () => {
  const f = fixture();
  for (const channel of f.handlers.keys()) assert.ok(IPC_WHITELIST.has(channel));
  for (const handler of f.handlers.values()) await assert.rejects(handler(f.event), /developer mode/);
  assert.equal(f.samples(), 0); assert.equal(f.active(), false);
  f.enable(true);
  const invoke = f.handlers.get(IPC.invoke.performanceDiagnostics);
  await assert.rejects(invoke({ ...f.event, senderFrame: { url: f.event.senderFrame.url } }, "start"), /main window/);
  await assert.rejects(invoke({ ...f.event, sender: new EventEmitter() }, "start"), /main window/);
  await assert.rejects(f.action("snapshot", 654), /Invalid/);
  await assert.rejects(f.action("start", { path: "secret" }), /Invalid/);
  assert.equal((await f.action("snapshot")).latest.processes[0].cpuPercent, null);
  await f.action("snapshot"); assert.equal(f.samples(), 1); assert.equal(f.active(), false);
});

test("record across settings navigation, mark, stop, preview and export exactly those bytes", async () => {
  const f = fixture(); f.enable(true);
  const { id } = await f.action("start"); await drain();
  assert.equal((await f.action("start")).id, id); assert.ok(f.active());
  assert.deepEqual(f.sent[0], { channel: IPC.event.performanceCapture, value: { id, deadline: 1_800_000_030_000 } });
  f.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  f.contents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
  await f.call("performancePulse", pulse(id)); f.advance(1300); await drain();
  assert.equal((await f.action("mark", id)).markerCount, 1);
  await assert.rejects(f.call("performanceReportPreview", id), /Stop/);
  await assert.rejects(f.action("stop", id + 1), /no longer/);
  assert.equal((await f.action("stop", id)).phase, "complete"); assert.equal(f.active(), false);
  await f.call("performancePulse", { ...pulse(id), maxDelayMs: 900 });
  await assert.rejects(f.call("performanceReportExport", id), /Preview/);
  const text = await f.call("performanceReportPreview", id); const report = JSON.parse(text);
  assert.equal(report.endReason, "stopped"); assert.equal(report.summary.peakCpu.cpuPercent, 0);
  assert.equal(report.summary.peakWorkingSet.workingSetKiB, 4096); assert.equal(report.summary.maxUiDelayMs, 150);
  assert.equal(report.summary.maxMainDelayMs, 1200); assert.equal(report.summary.processSamples, 2);
  assert.deepEqual(report.ui[0].stages, pulse(id).stages); assert.equal(report.ui[0].sessionSwitches, 1);
  assert.equal(report.manualMarkers.length, 1); assert.equal(report.ui.length, 1);
  await assert.rejects(f.call("performanceReportExport", id, "arbitrary path"), /Preview/);
  assert.deepEqual(await f.call("performanceReportExport", id), { saved: true }); assert.equal(f.saved[0].text, text);
  assert.equal(f.sent.at(-1).value, null);
});

test("capture auto-stops without panel polling; inputs and samples are bounded and content-free", async () => {
  const f = fixture(); f.enable(true); const { id } = await f.action("start");
  for (const invalid of [{ ...pulse(id), path: "SECRET" }, { ...pulse(id), stages: { SECRET: { count: 1, maxMs: 1 } } },
    { ...pulse(id), maxDelayMs: NaN }, { ...pulse(id), stages: { "markdown-split": { reason: "SECRET", count: 1, maxMs: 1 } } }]) {
    await assert.rejects(f.call("performancePulse", invalid), /Invalid/);
  }
  for (let i = 0; i < 32; i++) await f.action("mark", id);
  await assert.rejects(f.action("mark", id), /marker/);
  for (let i = 0; i < 33; i++) await f.call("performancePulse", pulse(id));
  for (let i = 0; i < 30; i++) { f.advance(1000); await drain(); }
  assert.equal(f.active(), false); assert.equal(f.sent.at(-1).value, null);
  const text = await f.call("performanceReportPreview", id), report = JSON.parse(text);
  assert.equal(report.endReason, "deadline"); assert.equal(report.ui.length, 31); assert.ok(report.processes.length <= 31);
  assert.doesNotMatch(text, /SECRET|app:\/\/test|synthetic\.json/);
});

for (const end of ["revoke", "reload", "crash", "destroy", "replace", "cancel"]) {
  test(`pending native save cannot publish on ${end}`, async () => {
    const gate = Promise.withResolvers(); const f = fixture({ chooseFile: () => gate.promise }); f.enable(true);
    const { id } = await f.action("start"); f.advance(1200); await drain(); await f.action("stop", id);
    await f.call("performanceReportPreview", id); const pending = f.call("performanceReportExport", id);
    await assert.rejects(f.call("performanceReportExport", id), /already open/);
    if (end === "revoke") { f.enable(false); f.clear(); f.enable(true); }
    if (end === "reload") f.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    if (end === "crash") f.contents.emit("render-process-gone");
    if (end === "destroy") f.contents.emit("destroyed");
    if (end === "replace") await f.action("start");
    gate.resolve(end === "cancel" ? null : "never-written.json");
    if (end === "cancel") assert.deepEqual(await pending, { saved: false });
    else await assert.rejects(pending, /ended|changed/);
    assert.equal(f.saved.length, 0); f.clear(); assert.equal(f.active(), false);
    assert.equal(f.contents.listenerCount("did-start-navigation"), 0);
  });
}

test("a snapshot completing across revocation is not returned or retained", async () => {
  const gate = Promise.withResolvers(); let calls = 0;
  const f = fixture({ sampler: { reset() {}, async sample() { return ++calls === 1 ? gate.promise : { at: 44, processes: [], truncated: false }; } } });
  f.enable(true); const pending = f.action("snapshot"); f.clear(); f.enable(false); f.enable(true);
  const next = f.action("snapshot"); assert.equal(calls, 1);
  gate.resolve({ at: 33, processes: [], truncated: false }); await assert.rejects(pending, /ended/);
  assert.equal((await next).latest.at, 44); assert.equal(calls, 2);
});

test("native report writer preserves the previous file on revocation and publishes identical JSON bytes", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-performance-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "report.json"); await writeFile(path, "original"); let checks = 0;
  await assert.rejects(savePerformanceFile(path, "new", () => { if (++checks === 2) throw new Error("revoked"); }), /revoked/);
  assert.equal(await readFile(path, "utf8"), "original"); assert.deepEqual(await readdir(dir), ["report.json"]);
  await assert.rejects(savePerformanceFile(join(dir, "other.txt"), "new", () => {}), /JSON/);
  await savePerformanceFile(path, '{"ok":true}\n', () => {}); assert.equal(await readFile(path, "utf8"), '{"ok":true}\n');
});

test("partial settings writes preserve the developer gate; disabling it takes effect before async side effects", async () => {
  const { registerHooks } = await import("node:module");
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (specifier !== "../network-proxy" || !context.parentURL?.endsWith("/settings-ipc.ts")) return next(specifier, context);
    return { url: "data:text/javascript,export const currentSystemProxyRelayUrl=()=>null", shortCircuit: true };
  } });
  let registerSettingsIpc;
  try { ({ registerSettingsIpc } = await import("../electron/main/ipc/settings-ipc.ts")); } finally { hook.deregister(); }
  const f = fixture(); f.enable(true); const { id } = await f.action("start");
  let stored = { developerMode: true }; const settings = new Map();
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  registerSettingsIpc({ registrar: { handle: (key, handler) => settings.set(key, handler) },
    getHost: () => ({ call: async (method, value) => method === "settings.get" ? stored : (stored = { ...stored, ...value }) }),
    getSidecar: () => null, validateSettingsWrite: value => value,
    applyDeveloperMode(committed) { f.enable(committed.developerMode === true); if (committed.developerMode !== true) f.clear(); },
    async applyNetworkProxyFromAppSettings() { if (!stored.developerMode) { entered.resolve(); await release.promise; } },
    applyApplicationMenuSettings() {},
  });
  const save = settings.get(IPC.invoke.settingsSet); await save({ theme: "dark" });
  assert.equal((await f.action("snapshot")).id, id);
  const pending = save({ developerMode: false }); await entered.promise;
  try { assert.equal(f.active(), false); await assert.rejects(f.action("snapshot"), /developer mode/); }
  finally { release.resolve(); await pending; }
});
