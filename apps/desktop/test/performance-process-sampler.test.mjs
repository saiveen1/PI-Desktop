import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { register, registerHooks } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
registerHooks({
  resolve(specifier, context, next) {
    if (specifier !== "electron") return next(specifier, context);
    return { url: "data:text/javascript,export const app = { getAppMetrics: () => [] }", shortCircuit: true };
  },
});
const { createPerformanceProcessSampler } = await import("../electron/main/performance/process-sampler.ts");
const { parseLinuxChildStat } = await import("../electron/main/performance/owned-child-metrics.ts");

const nullPid = () => null;
const baseDeps = { getHostPid: nullPid, getAgentPid: nullPid, getRendererPid: nullPid, getBrowserPids: () => [] };
const byPid = (snapshot, pid) => snapshot.processes.find((row) => row.pid === pid);
const done = () => new Promise(setImmediate);
const deferred = () => Promise.withResolvers();
const metric = (pid, type, extra = {}) => ({
  pid, type, creationTime: 100,
  cpu: { cumulativeCPUUsage: 1, percentCPUUsage: 99, idleWakeupsPerSecond: 0 },
  memory: { workingSetSize: 1024, privateBytes: 800 },
  ...extra,
});
const nativeMetric = (identity, cpuSeconds = 1) => ({
  identity, cpuSeconds, startedAt: 100, workingSetKiB: 2048, privateKiB: 1024,
});

function fixture(deps = {}, overrides = {}) {
  let elapsed = 0;
  let metrics = [];
  const sampler = createPerformanceProcessSampler({ ...baseDeps, ...deps }, {
    getAppMetrics: () => metrics,
    readChild: async () => null,
    mainPid: 10,
    platform: "win32",
    logicalCpuCount: () => 4,
    wallNow: () => 10_000 + elapsed,
    monotonicNow: () => elapsed,
    ...overrides,
  });
  return { ...sampler, setMetrics: (value) => { metrics = value; }, advance: (ms = 1000) => { elapsed += ms; } };
}

test("correlates app roles and registered plugin owners without exporting process labels or input data", async () => {
  const probed = [];
  const s = fixture({
    getRendererPid: () => 11, getBrowserPids: () => [12, 21], getHostPid: () => 13, getAgentPid: () => 14,
    getPluginPageOwners: () => new Map([[22, "demo.panel"], [23, null]]),
    getPluginProcessOwners: () => new Map([[16, "demo.tool"], [17, "unsafe\n"], [99, "not-in-Electron"]]),
  }, { readChild: async (pid) => { probed.push(pid); return nativeMetric(BigInt(pid)); } });
  s.setMetrics([
    metric(18, "Utility", { serviceName: "pi-plugin-demo.tool", name: "private URL/path", arguments: ["private"] }),
    metric(12, "Tab"), metric(10, "Browser"), metric(16, "Utility"), metric(17, "Utility"),
    metric(20, "Sandbox helper"), metric(19, "Tab"), metric(15, "GPU"), metric(11, "Tab"),
    metric(21, "Tab"), metric(22, "Tab"), metric(23, "Tab"),
    metric(12, "Tab", { creationTime: 50 }), metric(0, "Utility"), metric(2.5, "Utility"),
  ]);
  const snapshot = await s.sample();
  assert.equal(snapshot.at, 10_000);
  assert.equal(snapshot.truncated, false);
  assert.deepEqual(probed, [13, 14]);
  assert.deepEqual(snapshot.processes.map(({ pid, role, owner }) => [pid, role, owner]), [
    [10, "main", null], [11, "mainRenderer", null], [13, "host", null], [14, "agent", null], [12, "browser", null], [21, "browser", null],
    [15, "gpu", null], [16, "plugin", "demo.tool"], [17, "plugin", null], [22, "plugin", "demo.panel"], [23, "plugin", null], [19, "renderer", null],
    [18, "utility", null], [20, "other", null],
  ]);
  assert.deepEqual(byPid(snapshot, 12), { pid: 12, role: "browser", owner: null, startedAt: 100, cpuPercent: null, workingSetKiB: 1024, privateKiB: 800 });
  assert.deepEqual(byPid(snapshot, 13), { pid: 13, role: "host", owner: null, startedAt: 100, cpuPercent: null, workingSetKiB: 2048, privateKiB: 1024 });
  assert.doesNotMatch(JSON.stringify(snapshot), /private URL|pi-plugin-|arguments|unsafe|not-in-Electron/);
});

test("deduplicates aliases and bounds the sorted snapshot while retaining known sidecars", async () => {
  const s = fixture({ getRendererPid: () => 300, getBrowserPids: () => [300], getHostPid: () => 400, getAgentPid: () => 500 });
  s.setMetrics(Array.from({ length: 80 }, (_, i) => metric(100 - i, "Tab")));
  const snapshot = await s.sample();
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.processes.length, 64);
  assert.deepEqual(snapshot.processes.slice(0, 6).map((row) => row.pid), [10, 300, 400, 500, 21, 22]);
  assert.equal(byPid(snapshot, 300).role, "mainRenderer");
  assert.equal(byPid(snapshot, 400).workingSetKiB, null);
});

test("uses own CPU interval, resets on reuse or counter gaps, and leaves unavailable fields null", async () => {
  let child = nativeMetric(111n, 1);
  const s = fixture({ getHostPid: () => 13 }, { readChild: async () => child, platform: "linux" });
  function setCpu(cumulativeCPUUsage, creationTime = 100) {
    s.setMetrics([metric(10, "Browser", { creationTime, cpu: { cumulativeCPUUsage, percentCPUUsage: 99 } })]);
  }
  setCpu(5);
  const first = await s.sample();
  assert.equal(byPid(first, 10).cpuPercent, null);
  assert.equal(byPid(first, 10).privateKiB, null);
  s.advance(); setCpu(6); child = nativeMetric(111n, 3);
  const next = await s.sample();
  assert.equal(byPid(next, 10).cpuPercent, 25);
  assert.equal(byPid(next, 13).cpuPercent, 50);
  s.advance(7_000); setCpu(8);
  assert.equal(byPid(await s.sample(), 10).cpuPercent, null, "a long pause starts a new interval");
  s.advance(); setCpu(7, 200); child = nativeMetric(222n, 9);
  const reused = await s.sample();
  assert.equal(byPid(reused, 10).cpuPercent, null);
  assert.equal(byPid(reused, 13).startedAt, 100, "native creation identity is finer than displayed time");
  assert.equal(byPid(reused, 13).cpuPercent, null);
  s.advance(); setCpu(0, 200);
  assert.equal(byPid(await s.sample(), 10).cpuPercent, null, "counter regression is not zero usage");
  s.advance(); setCpu(undefined, 200);
  assert.equal(byPid(await s.sample(), 10).cpuPercent, null);
  s.advance(); setCpu(1, 200);
  assert.equal(byPid(await s.sample(), 10).cpuPercent, null, "no stale interval across a missing counter");
  s.reset();
  s.advance(); setCpu(2, 200);
  assert.equal(byPid(await s.sample(), 10).cpuPercent, null);
  s.advance(); setCpu(2, 0);
  const unidentifiable = byPid(await s.sample(), 10);
  assert.equal(unidentifiable.startedAt, null);
  assert.equal(unidentifiable.cpuPercent, null);
});

test("coalesces captures, preserves completed roles at the deadline, and doesn't requeue a wedged read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const host = deferred();
  const calls = [];
  const s = fixture({ getHostPid: () => 13, getAgentPid: () => 14 }, {
    readChild(pid, signal) { calls.push([pid, signal]); return pid === 13 ? host.promise : Promise.resolve(nativeMetric(222n)); },
  });
  const pending = s.sample();
  assert.equal(s.sample(), pending);
  await Promise.resolve();
  t.mock.timers.tick(250);
  const partial = await pending;
  assert.equal(calls[0][1].aborted, true);
  assert.equal(byPid(partial, 13).workingSetKiB, null);
  assert.equal(byPid(partial, 14).workingSetKiB, 2048);
  s.advance();
  assert.equal(byPid(await s.sample(), 13).cpuPercent, null);
  assert.deepEqual(calls.map(([pid]) => pid), [13, 14, 14]);
  host.resolve(nativeMetric(111n));
  await done();
  s.advance();
  const recovered = await s.sample();
  assert.equal(byPid(recovered, 13).cpuPercent, null, "late result must not update the baseline");
  assert.deepEqual(calls.map(([pid]) => pid), [13, 14, 14, 13, 14]);
});

test("drops restarted sidecars and invalidates an in-flight snapshot on reset", async () => {
  let pid = 13;
  const old = deferred();
  const newer = deferred();
  const s = fixture({ getHostPid: () => pid }, { readChild: (id) => id === 13 ? old.promise : newer.promise });
  const beforeRestart = s.sample();
  pid = 14;
  old.resolve(nativeMetric(111n));
  assert.equal(byPid(await beforeRestart, 13), undefined);
  const beforeReset = s.sample();
  s.reset();
  assert.deepEqual((await beforeReset).processes, []);
  newer.resolve(nativeMetric(222n));
  await done();
  const fresh = byPid(await s.sample(), 14);
  assert.equal(fresh.workingSetKiB, 2048);
  assert.equal(fresh.cpuPercent, null);
});

test("Linux stat parser verifies parent and handles spaces and closing parentheses in comm", () => {
  const stat = "555 (my ) name) S 123 0 0 0 0 0 0 0 0 0 20 4 0 0 0 0 0 0 456 0";
  assert.deepEqual(parseLinuxChildStat(stat, 123), { startTicks: 456, cpuTicks: 24 });
  assert.equal(parseLinuxChildStat(stat, 124), null);
  assert.equal(parseLinuxChildStat(stat.replace(") S", ") Z"), 123), null);
  assert.equal(parseLinuxChildStat("555 (truncated) S 123", 123), null);
});

test("native fallback sees a real owned child working set and CPU interval", {
  skip: !["win32", "linux"].includes(process.platform), timeout: 8_000,
}, async (t) => {
  const started = Date.now();
  const child = spawn(process.execPath, ["-e", `
    const { pbkdf2Sync } = require("node:crypto");
    process.on("message", () => {
      pbkdf2Sync("fixture", "fixture", 350000, 32, "sha256");
      process.send("done");
    });
    process.send("ready");
  `], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: {} });
  const exited = once(child, "exit");
  try {
    assert.equal((await once(child, "message", { signal: t.signal }))[0], "ready");
    const sampler = createPerformanceProcessSampler({ ...baseDeps, getAgentPid: () => child.pid });
    const first = byPid(await sampler.sample(), child.pid);
    assert.equal(first.role, "agent");
    assert.ok(first.workingSetKiB > 0);
    assert.ok(first.startedAt >= started - 1000 && first.startedAt <= Date.now() + 1000);
    assert.equal(first.cpuPercent, null);
    if (process.platform === "win32") assert.ok(first.privateKiB > 0);
    const doneComputing = once(child, "message", { signal: t.signal });
    child.send("compute");
    assert.equal((await doneComputing)[0], "done");
    const second = byPid(await sampler.sample(), child.pid);
    assert.equal(second.startedAt, first.startedAt);
    assert.ok(second.cpuPercent > 0 && second.cpuPercent <= 100, `CPU interval: ${second.cpuPercent}`);
  } finally {
    if (child.connected) child.disconnect();
    await exited;
  }
});