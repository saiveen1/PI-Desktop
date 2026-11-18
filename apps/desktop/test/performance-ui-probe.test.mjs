import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url));
const { build } = require("esbuild");
const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
let instance = 0;
const bundles = new Map();

async function load(mode = "production") {
  if (!bundles.has(mode)) {
    const result = await build({
      stdin: {
        contents: 'export * from "./src/lib/performance-ui-probe.ts"; export * from "./src/lib/render-diagnostics.ts"; export * from "./src/lib/chat-link-scanner.ts";',
        resolveDir: desktopRoot,
        loader: "ts",
      },
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      define: { "import.meta.env": JSON.stringify({ DEV: mode !== "production", MODE: mode }) },
    });
    bundles.set(mode, result.outputFiles[0].text);
  }
  const code = Buffer.from(bundles.get(mode)).toString("base64");
  return import(`data:text/javascript;base64,${code}#${++instance}`);
}

class Clock {
  nowMs = 0;
  epoch = 1_700_000_000_000;
  tasks = new Map();
  nextId = 1;
  now = () => this.nowMs;
  wallNow = () => this.epoch;
  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.nowMs + delay, callback });
    return id;
  };
  clearTimeout = (id) => { this.tasks.delete(id); };
  block(ms) { this.nowMs += ms; this.epoch += ms; }
  runDue() {
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, task]) => task.at <= this.nowMs)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return;
      this.tasks.delete(due[0]);
      due[1].callback();
    }
  }
  advance(ms) {
    const target = this.nowMs + ms;
    for (;;) {
      const next = [...this.tasks.values()].reduce((first, task) => Math.min(first, task.at), Infinity);
      if (next > target) break;
      this.block(Math.max(0, next - this.nowMs));
      this.runDue();
    }
    this.block(target - this.nowMs);
  }
}

function fixture(probe, { developerMode = true, visible = true, send } = {}) {
  const clock = new Clock();
  let state = { settings: { developerMode }, activeSessionId: "private-session-a", page: "settings" };
  let signalListener;
  const stateListeners = new Set();
  const visibilityListeners = new Set();
  const pulses = [];
  const document = {
    visibilityState: visible ? "visible" : "hidden",
    addEventListener(type, listener) { assert.equal(type, "visibilitychange"); visibilityListeners.add(listener); },
    removeEventListener(type, listener) { assert.equal(type, "visibilitychange"); visibilityListeners.delete(listener); },
  };
  const dispose = probe.installPerformanceUiProbe({
    clock,
    document,
    onCapture(listener) { signalListener = listener; return () => { signalListener = undefined; }; },
    sendPulse(pulse) { pulses.push(structuredClone(pulse)); return send ? send(pulse) : Promise.resolve(); },
    getState: () => state,
    subscribeState(listener) { stateListeners.add(listener); return () => stateListeners.delete(listener); },
  });
  return {
    clock, document, pulses, stateListeners, visibilityListeners, dispose,
    emit: (signal) => signalListener?.(signal),
    start: (id, lifetime = 10_000) => signalListener?.({ id, deadline: clock.wallNow() + lifetime }),
    setState(patch) {
      const previous = state;
      state = { ...state, ...patch };
      for (const listener of [...stateListeners]) listener(state, previous);
    },
    setVisible(value) {
      document.visibilityState = value ? "visible" : "hidden";
      for (const listener of [...visibilityListeners]) listener();
    },
    hasSignalListener: () => Boolean(signalListener),
  };
}

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test("release remains idle until both persisted developer mode and a fresh trusted signal", async () => {
  const probe = await load();
  const f = fixture(probe, { developerMode: false });
  try {
    assert.equal(probe.renderDiagnosticSamplesEnabled, false);
    assert.equal(probe.isRenderDiagnosticEnabled(), false);
    assert.equal(probe.beginRenderDiagnostic("chat-link-scan"), probe.beginRenderDiagnostic("chat-link-scan"));
    f.start(1);
    assert.equal(f.clock.tasks.size, 0);
    assert.equal(f.stateListeners.size, 0);
    assert.equal(f.visibilityListeners.size, 0);
    f.setState({ settings: { developerMode: true } });
    f.start(1); // A signal ignored while disabled cannot be replayed after enabling.
    assert.equal(f.clock.tasks.size, 0);
    f.start(2);
    assert.equal(f.clock.tasks.size, 1);
    assert.equal(f.stateListeners.size, 1);
    assert.equal(probe.isRenderDiagnosticEnabled(), true);
    f.setState({ settings: { developerMode: false } });
    assert.equal(f.clock.tasks.size, 0);
    assert.equal(f.stateListeners.size, 0);
    assert.equal(f.visibilityListeners.size, 0);
    assert.equal(probe.isRenderDiagnosticEnabled(), false);
    f.clock.advance(5_000);
    assert.deepEqual(f.pulses, []);
  } finally { f.dispose(); }
  assert.equal(f.hasSignalListener(), false);
});

test("visible recording emits only allowlisted aggregates, delay and meaningful counters", async () => {
  const probe = await load();
  const f = fixture(probe);
  const originalPerformance = globalThis.performance;
  Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: f.clock.now } });
  try {
    f.start(7);
    const finish = probe.beginRenderDiagnostic("chat-link-scan", { reason: "secret-input" });
    f.clock.block(12);
    finish({ reason: "private-result" });
    probe.scanChatLinkCandidates("secret/private-file.ts", probe.createChatLinkScanBudget(), () => null, () => "accept");
    probe.recordRenderDiagnostic("markdown-normalize", { durationMs: 4, reason: "private" });
    probe.recordRenderDiagnostic("markdown-normalize", { durationMs: 9, reason: "private" });
    probe.recordRenderDiagnostic("markdown-normalize", { durationMs: Number.NaN });
    probe.recordRenderDiagnostic("markdown-normalize", { durationMs: -1 });
    probe.recordRenderDiagnostic("markdown-normalize", { durationMs: 60_001 });
    probe.recordRenderDiagnostic("__proto__", { durationMs: 500 });
    f.setState({ page: "chat", activeSessionId: "private-session-b" });
    f.setState({ page: "settings" }); // Navigating away from Settings never stops the probe.
    f.setState({ activeSessionId: "private-session-c" });
    probe.recordPerformanceToolOpen();
    probe.recordPerformanceToolOpen();
    f.clock.block(288); // Timer was due at 100ms, so this foreground stall is 200ms late.
    f.clock.runDue();
    f.clock.advance(700);
    await settle();
    assert.deepEqual(f.pulses, [{
      id: 7,
      maxDelayMs: 200,
      stages: { "chat-link-scan": { count: 2, maxMs: 12 }, "markdown-normalize": { count: 2, maxMs: 9 } },
      sessionSwitches: 2,
      toolOpens: 2,
    }]);
    assert.doesNotMatch(JSON.stringify(f.pulses), /private|secret|reason|session-a|session-b|session-c/);
    f.clock.advance(1_000);
    await settle();
    assert.deepEqual(f.pulses[1], { id: 7, maxDelayMs: 0, stages: {}, sessionSwitches: 0, toolOpens: 0 });
  } finally {
    f.dispose();
    Object.defineProperty(globalThis, "performance", { configurable: true, value: originalPerformance });
  }
});

test("hidden and resumed gaps are excluded, including stage and interaction work", async () => {
  const probe = await load();
  const f = fixture(probe);
  try {
    f.start(8, 20_000);
    probe.recordRenderDiagnostic("markdown-split", { durationMs: 3 });
    const staleFinish = probe.beginRenderDiagnostic("chat-link-scan");
    f.clock.advance(200);
    f.setVisible(false);
    probe.recordRenderDiagnostic("markdown-split", { durationMs: 99 });
    probe.recordPerformanceToolOpen();
    f.setState({ activeSessionId: "private-background-session" });
    f.clock.advance(4_000);
    assert.deepEqual(f.pulses, []);
    f.setVisible(true);
    staleFinish(); // A phase begun before hiding cannot cross the visibility boundary.
    probe.recordRenderDiagnostic("markdown-react-render", { durationMs: 7, startTime: 100 });
    probe.recordRenderDiagnostic("markdown-react-render", { durationMs: 6, startTime: f.clock.now() });
    f.clock.advance(100);
    await settle();
    assert.deepEqual(f.pulses, [{
      id: 8, maxDelayMs: 0,
      stages: { "markdown-split": { count: 1, maxMs: 3 }, "markdown-react-render": { count: 1, maxMs: 6 } }, sessionSwitches: 0, toolOpens: 0,
    }]);
  } finally { f.dispose(); }
});

test("switching captures invalidates old work and never overlaps an in-flight send", async () => {
  const probe = await load();
  let release;
  const f = fixture(probe, { send: () => new Promise((resolve) => { release = resolve; }) });
  try {
    f.start(10);
    f.clock.advance(1_000);
    assert.equal(f.pulses.length, 1);
    const staleFinish = probe.beginRenderDiagnostic("chat-link-scan");
    const staleTimer = [...f.clock.tasks.values()][0].callback;
    f.start(11);
    staleFinish();
    staleTimer();
    assert.equal(f.clock.tasks.size, 1);
    probe.recordRenderDiagnostic("code-highlight", { durationMs: 5 });
    probe.recordRenderDiagnostic("markdown-react-render", { durationMs: 7, startTime: 999 });
    f.clock.advance(2_000);
    assert.equal(f.pulses.length, 1);
    release();
    await settle();
    f.clock.advance(100);
    assert.equal(f.pulses.length, 2);
    assert.equal(f.pulses[1].id, 11);
    assert.deepEqual(f.pulses[1].stages, { "code-highlight": { count: 1, maxMs: 5 } });
    f.emit(null);
    assert.equal(f.clock.tasks.size, 0);
    f.clock.advance(5_000);
    assert.equal(f.pulses.length, 2);
    release();
    await settle();
  } finally { f.dispose(); }
});

test("unmount and remount cannot overlap a pending pulse", async () => {
  const probe = await load();
  let release;
  const first = fixture(probe, { send: () => new Promise((resolve) => { release = resolve; }) });
  first.start(50);
  first.clock.advance(1_000);
  assert.equal(first.pulses.length, 1);
  first.dispose();
  const second = fixture(probe);
  try {
    second.clock.block(1_000); // The same renderer monotonic clock continues across mounts.
    second.start(51);
    second.clock.advance(2_000);
    assert.equal(second.pulses.length, 0);
    release();
    await settle();
    second.clock.advance(100);
    await settle();
    assert.equal(second.pulses.length, 1);
    assert.equal(second.pulses[0].id, 51);
  } finally { second.dispose(); }
});

test("deadline and 30-second monotonic cap clean up even if stop is lost", async () => {
  const probe = await load();
  const f = fixture(probe, { visible: false });
  try {
    f.start(20, 90_000);
    f.clock.epoch -= 60_000; // A backward wall-clock jump cannot extend recording.
    f.clock.advance(30_000);
    assert.equal(f.clock.tasks.size, 0);
    assert.equal(f.stateListeners.size, 0);
    assert.equal(f.visibilityListeners.size, 0);
    f.setVisible(true);
    f.start(20, 90_000); // Duplicate start is not a new capture.
    assert.equal(f.clock.tasks.size, 0);
    f.emit({ id: 21, deadline: f.clock.wallNow() - 1 });
    assert.equal(f.clock.tasks.size, 0);
    f.start(22, 500);
    f.clock.advance(500);
    assert.equal(f.clock.tasks.size, 0);
    f.start(23, 5_000);
    f.clock.epoch += 5_001;
    probe.recordPerformanceToolOpen();
    assert.equal(f.clock.tasks.size, 0);
    assert.equal(f.stateListeners.size, 0);
    assert.deepEqual(f.pulses, []);
  } finally { f.dispose(); }
});

test("late failures are quiet; current failures expose only a static diagnostic", async () => {
  const probe = await load();
  let reject;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  const f = fixture(probe, { send: () => new Promise((_, fail) => { reject = fail; }) });
  try {
    f.start(30);
    f.clock.advance(1_000);
    reject(new Error("private tool contents"));
    await settle();
    assert.deepEqual(warnings, [["Performance UI pulse failed"]]);
    f.clock.advance(1_000);
    f.dispose();
    reject(new Error("private stale error"));
    await settle();
    assert.equal(warnings.length, 1);
    assert.equal(f.clock.tasks.size, 0);
  } finally { f.dispose(); console.warn = originalWarn; }
});

test("DEV bounded samples remain available alongside opt-in aggregates", async () => {
  const probe = await load("test");
  const f = fixture(probe);
  try {
    assert.equal(probe.renderDiagnosticSamplesEnabled, true);
    probe.clearRenderDiagnosticSamples();
    for (let i = 0; i < 100; i += 1) {
      probe.beginRenderDiagnostic("chat-link-scan", { sourceLength: 4 })({ reason: "scan-budget" });
    }
    assert.equal(probe.readRenderDiagnosticSamples().length, 128);
    assert.equal(probe.readRenderDiagnosticSamples().at(-1).reason, "scan-budget");
    f.start(40);
    probe.recordRenderDiagnostic("markdown-react-render", { durationMs: 13, renderPhase: "mount" });
    f.clock.advance(1_000);
    await settle();
    assert.deepEqual(f.pulses[0].stages, { "markdown-react-render": { count: 1, maxMs: 13 } });
    assert.equal(probe.readRenderDiagnosticSamples().at(-1).renderPhase, "mount");
  } finally { f.dispose(); }
});

test("the main App owns the probe and the host tool-row click counts openings only", async () => {
  const [app, main, toolRow] = await Promise.all([
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/features/chat/transcript/ToolRow.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(main, /rendererSurface === "plugin-launcher"[\s\S]*rendererSurface === "live-voice-widget"[\s\S]*rendererSurface === "computer-cursor"[\s\S]*<App \/>/);
  assert.match(app, /URLSearchParams\(window\.location\.search\)\.get\("surface"\)/);
  assert.match(app, /installPerformanceUiProbe\(/);
  assert.doesNotMatch(app, /settingsTab|page === "settings"/);
  assert.match(toolRow, /diagnosticOpen\.current = open;\s*diagnosticParentVisible\.current = disclosure\.parentVisible;/);
  assert.match(toolRow, /if \(!diagnosticOpen\.current && diagnosticParentVisible\.current\) recordPerformanceToolOpen\(\);\s*toggleDisclosure\(\);\s*\}, \[onUserInteraction, toggleDisclosure\]\);/);
  assert.match(toolRow, /onClick=\{\(\) => hasDetails && toggleRow\(\)\}/);
  assert.match(toolRow, /onClick=\{toggleRow\}/);
});
