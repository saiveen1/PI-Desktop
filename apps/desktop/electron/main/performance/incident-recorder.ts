import type { BrowserWindow, Event, IpcMainEvent, PowerMonitor, ProcessMetric, RenderProcessGoneDetails, WebContentsDidStartNavigationEventParams, WebFrameMain } from "electron";
import { PERFORMANCE_HEARTBEAT } from "../../performance-heartbeat";
import type { Logger } from "../logger";

const TICK_MS = 500;
const SAMPLE_MS = 2_000;
const HISTORY_MS = 30_000;
const MAX_SAMPLES = HISTORY_MS / SAMPLE_MS;
const SIGNIFICANT_MS = 500;
const EXIT_REASONS = new Set<string>(["abnormal-exit", "killed", "crashed", "oom", "launch-failed", "integrity-failure", "memory-eviction"]);
const INCIDENTS = {
  mainDelay: "Main event loop delayed",
  rendererDelay: "Visible renderer heartbeat delayed",
  rendererUnresponsive: "Visible renderer became unresponsive",
  rendererResponsive: "Renderer became responsive again",
  rendererExit: "Renderer exited unexpectedly",
} as const;

type Delay = "mainDelay" | "rendererDelay";
const pidOrNull = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 0xffff_ffff ? value : null;
const counter = (value?: number) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
function processCounters(pid: number, metrics: readonly ProcessMetric[]) {
  const metric = metrics.find((entry) => entry.pid === pid);
  return { pid, startedAt: counter(metric?.creationTime) || null,
    cpuSeconds: counter(metric?.cpu?.cumulativeCPUUsage),
    workingSetKiB: counter(metric?.memory?.workingSetSize), privateKiB: counter(metric?.memory?.privateBytes) };
}

type Sample = { at: number; main: ReturnType<typeof processCounters>; renderer: ReturnType<typeof processCounters> | null };
type Stamp = { mono: number; wall: number };
type Dependencies = {
  window: BrowserWindow;
  isActive(): boolean;
  expectedUrl: string;
  power: Pick<PowerMonitor, "on" | "removeListener">;
  logger: Pick<Logger, "app">;
  getMetrics(): readonly ProcessMetric[];
  now?: () => Stamp;
  every?: (ms: number, tick: () => void) => () => void;
};

/** One recorder per primary window, independent of developer mode and opt-in capture. */
export function installPerformanceIncidentRecorder({ window, isActive, expectedUrl, power, logger, getMetrics,
  now = () => ({ mono: performance.now(), wall: Date.now() }),
  every = (ms, tick) => { const timer = setInterval(tick, ms); timer.unref(); return () => clearInterval(timer); },
}: Dependencies) {
  const contents = window.webContents;
  const ipc = contents.ipc;
  const samples: { mono: number; sample: Sample }[] = [];
  const lastDelay: Partial<Record<Delay, number>> = {};
  let rendererPid: number | null = null;
  let exitedPid: number | null = null;
  let lastTick = now();
  let nextSample = lastTick.mono;
  let suspended = false;
  let resumeGraceUntil = 0;
  let hungSince: number | null = null;
  let sequence = 0;
  let pending: { id: number; frame: WebFrameMain; started: Stamp; stale: boolean } | null = null;
  let warnedMetrics = false;
  let warnedHeartbeat = false;
  let disposed = false;
  const live = () => !disposed && isActive() && !contents.isDestroyed();
  const visible = () => live() && !window.isDestroyed() && window.isVisible() && !window.isMinimized();
  const awake = (at: Stamp) => !suspended && at.mono >= resumeGraceUntil;
  const clockGap = (a: Stamp, b: Stamp) => Math.abs((b.wall - a.wall) - (b.mono - a.mono)) >= SIGNIFICANT_MS;
  const trusted = (frame: WebFrameMain) => !frame.detached && frame.url.split("#", 1)[0] === expectedUrl;
  // Keep an outstanding ping occupying its slot until it replies or its document goes away.
  const invalidatePing = () => { if (pending) pending.stale = true; };
  const notePid = () => {
    if (!live() || contents.isCrashed()) return null;
    const pid = pidOrNull(contents.getOSProcessId());
    if (pid === null || pid === exitedPid) return null;
    rendererPid = pid;
    return pid;
  };
  const incident = (kind: keyof typeof INCIDENTS, at: Stamp, detail: Record<string, number | string | null> = {}) => {
    if (kind === "mainDelay" || kind === "rendererDelay") {
      if (at.mono - (lastDelay[kind] ?? -Infinity) < HISTORY_MS) return;
      lastDelay[kind] = at.mono;
    }
    logger.app("performance", "warn", INCIDENTS[kind], {
      event: `performance.incident.${kind}`,
      data: { version: 1, mainPid: process.pid, rendererPid, ...detail,
        samples: samples.filter(({ mono }) => at.mono - mono <= HISTORY_MS).map(({ sample }) => sample) },
    });
  };

  function tick() {
    if (!live()) return;
    const at = now();
    const delayMs = Math.round(at.mono - lastTick.mono - TICK_MS);
    const gap = clockGap(lastTick, at);
    lastTick = at;
    if (gap || delayMs >= SIGNIFICANT_MS) invalidatePing();
    if (gap) {
      resumeGraceUntil = at.mono + SAMPLE_MS;
      hungSince = null;
    }
    if (awake(at) && !gap && delayMs >= SIGNIFICANT_MS) incident("mainDelay", at, { delayMs });
    if (suspended) return;
    const currentRendererPid = notePid();
    if (at.mono >= nextSample) {
      nextSample = at.mono + SAMPLE_MS;
      let metrics: readonly ProcessMetric[] = [];
      try { metrics = getMetrics(); }
      catch {
        if (!warnedMetrics) console.warn("[performance] Incident process metrics unavailable");
        warnedMetrics = true;
      }
      samples.push({ mono: at.mono, sample: { at: at.wall, main: processCounters(process.pid, metrics),
        renderer: currentRendererPid === null ? null : processCounters(currentRendererPid, metrics) } });
      if (samples.length > MAX_SAMPLES) samples.shift();
    }
    if (!awake(at) || pending || !visible() || hungSince !== null || contents.isCrashed() || contents.isLoadingMainFrame()) return;
    const frame = contents.mainFrame;
    if (!frame || !trusted(frame)) return;
    pending = { id: ++sequence, frame, started: now(), stale: false };
    try { frame.send(PERFORMANCE_HEARTBEAT, pending.id); }
    catch {
      pending = null;
      if (!warnedHeartbeat) console.warn("[performance] Incident heartbeat unavailable");
      warnedHeartbeat = true;
    }
  }

  function pong(event: IpcMainEvent, id: unknown, isDocumentVisible: unknown, ...extra: unknown[]) {
    if (!live() || !pending || id !== pending.id || typeof isDocumentVisible !== "boolean" || extra.length !== 0 ||
        event.sender !== contents || event.senderFrame !== pending.frame || event.senderFrame !== contents.mainFrame || !trusted(pending.frame)) return;
    const ping = pending;
    pending = null;
    if (ping.stale || !isDocumentVisible || !visible() || hungSince !== null) return;
    const at = now();
    const delayMs = Math.round(at.mono - ping.started.mono);
    // A reply can beat the overdue Main timer. Do not misattribute a Main or sleep gap to the renderer.
    if (!awake(at) || clockGap(ping.started, at) || at.mono - lastTick.mono >= TICK_MS + SIGNIFICANT_MS) return;
    if (delayMs >= SIGNIFICANT_MS) incident("rendererDelay", at, { delayMs });
  }

  function onNavigation(event: Event<WebContentsDidStartNavigationEventParams>) {
    if (event.isMainFrame && !event.isSameDocument) pending = null;
  }
  const onReady = () => { exitedPid = null; notePid(); };
  const onSuspend = () => { suspended = true; hungSince = null; invalidatePing(); };
  const onResume = () => {
    suspended = false;
    hungSince = null;
    lastTick = now();
    resumeGraceUntil = lastTick.mono + SAMPLE_MS;
    invalidatePing();
  };
  const onUnresponsive = () => {
    const at = now();
    if (!visible() || !awake(at) || clockGap(lastTick, at) || hungSince !== null) return;
    notePid();
    hungSince = at.mono;
    invalidatePing();
    incident("rendererUnresponsive", at);
  };
  const onResponsive = () => {
    if (hungSince === null) return;
    const started = hungSince;
    hungSince = null;
    const at = now();
    if (live() && awake(at) && !clockGap(lastTick, at)) incident("rendererResponsive", at, { durationMs: Math.round(at.mono - started) });
  };

  ipc.on(PERFORMANCE_HEARTBEAT, pong);
  power.on("suspend", onSuspend);
  power.on("resume", onResume);
  window.on("hide", invalidatePing);
  window.on("minimize", invalidatePing);
  window.on("unresponsive", onUnresponsive);
  window.on("responsive", onResponsive);
  contents.on("did-start-navigation", onNavigation);
  contents.on("dom-ready", onReady);
  const stop = every(TICK_MS, tick);
  contents.once("destroyed", () => {
    disposed = true;
    stop();
    ipc.removeListener(PERFORMANCE_HEARTBEAT, pong);
    power.removeListener("suspend", onSuspend);
    power.removeListener("resume", onResume);
    window.removeListener("hide", invalidatePing);
    window.removeListener("minimize", invalidatePing);
    contents.removeListener("did-start-navigation", onNavigation);
    contents.removeListener("dom-ready", onReady);
    window.removeListener("unresponsive", onUnresponsive);
    window.removeListener("responsive", onResponsive);
    pending = null;
    samples.length = 0;
  });
  return {
    rendererGone(details: RenderProcessGoneDetails) {
      if (!disposed && isActive() && details.reason !== "clean-exit") incident("rendererExit", now(), {
        reason: EXIT_REASONS.has(details.reason) ? details.reason : "unknown",
        exitCode: Number.isSafeInteger(details.exitCode) ? details.exitCode : null,
      });
      exitedPid = rendererPid ?? exitedPid;
      rendererPid = null;
      pending = null;
      hungSince = null;
    },
  };
}
