import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IPC_WHITELIST } from "@pi-desktop/shared/protocol";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { installPerformanceIncidentRecorder } = await import("../electron/main/performance/incident-recorder.ts");
const { PERFORMANCE_HEARTBEAT } = await import("../electron/performance-heartbeat.ts");
const { Logger } = await import("../electron/main/logger.ts");
const { recoverRendererAfterGone } = await import("../electron/main/renderer-recovery.ts");

function fixture(logger) {
  const expectedUrl = "file:///internal-secret/index.html";
  const stamp = { mono: 0, wall: 1_800_000_000_000 };
  let run, visible = true, active = true, crashed = false, destroyed = false, pid = 700, reads = 0;
  const power = new EventEmitter(), ipc = new EventEmitter(), sent = [], records = [];
  const frame = { url: expectedUrl, detached: false, send: (channel, id) => sent.push([channel, id]) };
  const contents = Object.assign(new EventEmitter(), { ipc, mainFrame: frame,
    getOSProcessId: () => pid, isCrashed: () => crashed, isLoadingMainFrame: () => false, isDestroyed: () => destroyed });
  const window = Object.assign(new EventEmitter(), { webContents: contents, isVisible: () => visible,
    isMinimized: () => !visible, isDestroyed: () => destroyed });
  const hit = (p) => ({ pid: p, name: "do-not-persist", creationTime: 1_700_000_000_000,
    cpu: { cumulativeCPUUsage: 12.5 }, memory: { workingSetSize: 900_000, privateBytes: 800_000 } });
  const recorder = installPerformanceIncidentRecorder({ window, power, expectedUrl, isActive: () => active,
    logger: logger ?? { app: (_category, _level, _message, { event, data }) => records.push({ event, data }) },
    getMetrics: () => { reads++; return [hit(pid), hit(process.pid), hit(999)]; }, now: () => ({ ...stamp }),
    every(ms, tick) { assert.equal(ms, 500); run = tick; return () => { run = null; }; },
  });
  const advance = (delta = 500, wallDelta = delta, tick = true) => {
    stamp.mono += delta; stamp.wall += wallDelta; if (tick) run?.();
  };
  function reply({ id = sent.at(-1)?.[1], sender = contents, senderFrame = frame, shown = true, extra = [] } = {}) {
    ipc.emit(PERFORMANCE_HEARTBEAT, { sender, senderFrame }, id, shown, ...extra);
  }
  return { advance, reply, frame, contents, window, power, ipc, sent, records, recorder, stamp, reads: () => reads,
    setPid(value) { pid = value; }, setCrashed(value) { crashed = value; }, setActive(value) { active = value; },
    setVisible(value) { visible = value; if (!value) window.emit("hide"); }, destroy() { destroyed = true; contents.emit("destroyed"); },
  };
}

test("quiet sampling retains only two process roles; OOM persists old PID and history before reload", (t) => {
  const root = mkdtempSync(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-performance-incident-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "logs", "app", "performance.log");
  const logger = new Logger(root, "info", { mirrorConsole: false });
  const f = fixture(logger);
  for (let i = 0; i < 76; i++) { f.advance(); f.reply(); }
  assert.equal(f.reads(), 19);
  assert.throws(() => readFileSync(file), { code: "ENOENT" });
  f.setCrashed(true); f.setPid(0);
  const gone = { reason: "oom", exitCode: -1 };
  f.recorder.rendererGone(gone);
  let reloaded = false;
  assert.equal(recoverRendererAfterGone(gone, {
    isCurrentWindow: true, quitting: false, windowCloseAccepted: false, windowDestroyed: false, webContentsDestroyed: false,
    log: () => {}, reload() {
      const raw = readFileSync(file, "utf8");
      const { event, data } = JSON.parse(raw);
      assert.equal(event, "performance.incident.renderer.exit");
      assert.equal(data.rendererPid, 700);
      assert.equal(data.reason, "oom"); assert.equal(data.exitCode, -1);
      assert.equal(data.samples.length, 15);
      assert.ok(data.samples[0].at > f.stamp.wall - 30_000);
      for (const sample of data.samples) {
        assert.equal(sample.main.pid, process.pid);
        assert.deepEqual(sample.renderer, { pid: 700, startedAt: 1_700_000_000_000,
          cpuSeconds: 12.5, workingSetKiB: 900_000, privateKiB: 800_000 });
      }
      assert.doesNotMatch(raw, /do-not-persist|internal-secret|DepthLimited/);
      assert.ok(Buffer.byteLength(raw) < 8 * 1024);
      reloaded = true;
    },
  }), true);
  assert.ok(reloaded);
  f.destroy();
  const fresh = fixture(new Logger(root, "info", { mirrorConsole: false }));
  fresh.setPid(701); fresh.contents.emit("dom-ready"); fresh.setPid(0);
  fresh.recorder.rendererGone({ reason: "crashed", exitCode: 1 });
  const records = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(records.map(({ data }) => data.rendererPid), [700, 701]);
  fresh.recorder.rendererGone({ reason: "clean-exit", exitCode: 0 });
  fresh.setActive(false); fresh.recorder.rendererGone(gone);
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2);
  fresh.destroy();
});

test("single-flight heartbeat accepts only a matching trusted top-frame reply and survives navigation", () => {
  const f = fixture();
  assert.equal(IPC_WHITELIST.has(PERFORMANCE_HEARTBEAT), false);
  f.advance(); const [channel, first] = f.sent[0]; assert.equal(channel, PERFORMANCE_HEARTBEAT);
  f.advance();
  f.reply({ sender: {} }); f.reply({ senderFrame: { url: f.frame.url } }); f.reply({ id: String(first) });
  f.reply({ shown: {} }); f.reply({ extra: ["secret"] });
  assert.equal(f.records.length, 0);
  f.advance();
  assert.equal(f.sent.length, 1);
  f.reply();
  assert.equal(f.records[0].event, "performance.incident.rendererDelay");
  assert.equal(f.records[0].data.delayMs, 1000);
  f.advance(); const previous = f.sent.at(-1)[1];
  f.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  f.frame.url = "file:///wrong/index.html"; f.advance(); assert.equal(f.sent.length, 2);
  f.frame.url = "file:///internal-secret/index.html#settings"; f.advance();
  assert.equal(f.sent.length, 3);
  f.reply({ id: previous }); f.advance(); assert.equal(f.sent.length, 3);
  f.reply(); f.advance(); assert.equal(f.sent.length, 4);
  f.destroy(); f.advance();
  for (const [emitter, event] of [[f.ipc, channel], [f.power, "resume"], [f.power, "suspend"],
    [f.window, "unresponsive"], [f.contents, "did-start-navigation"]]) assert.equal(emitter.listenerCount(event), 0);
  assert.equal(f.sent.length, 4);
});

test("records Main stalls and native responsiveness without mistaking hiding or sleep for a stall", () => {
  const f = fixture();
  f.advance();
  f.advance(1_200, 1_200, false); f.reply(); f.advance(0);
  assert.deepEqual(f.records.map(({ event, data }) => [event, data.delayMs]), [["performance.incident.mainDelay", 700]]);
  f.advance(1_200); // Repeated significant timing hints are rate-limited.
  f.setVisible(false); f.window.emit("unresponsive"); f.advance(); f.reply();
  f.setVisible(true); f.window.emit("unresponsive"); f.window.emit("unresponsive");
  f.advance(); f.window.emit("responsive");
  assert.deepEqual(f.records.slice(1).map(({ event, data }) => [event, data.durationMs]), [
    ["performance.incident.rendererUnresponsive", undefined], ["performance.incident.rendererResponsive", 500],
  ]);
  f.advance();
  f.power.emit("suspend"); f.advance(120_000); f.power.emit("resume"); f.reply();
  f.window.emit("unresponsive"); f.advance(500, 60_500); // Wall/monotonic gap fallback without a power event.
  assert.equal(f.records.length, 3);
  f.advance(); f.advance(); f.advance(); f.advance();
  f.window.emit("unresponsive");
  f.advance(500, 60_500); // A native interval must not be extended by a clock discontinuity either.
  f.advance(); f.advance(); f.advance(); f.advance();
  f.window.emit("responsive");
  assert.equal(f.records.length, 4);
  assert.equal(f.records.at(-1).event, "performance.incident.rendererUnresponsive");
  f.destroy();
});
