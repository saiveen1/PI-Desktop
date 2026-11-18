import type { PerformanceCaptureSignal, PerformanceDiagnosticsState, PerformanceSnapshot, PerformanceUiPulse } from "@pi-desktop/shared";

const PERIOD = 1_000;
const DURATION = 30_000;
const TICK = 100;
const MAX_MARKERS = 32;
const MAX_SAMPLES = 31;

type Build = { appVersion: string; buildId: string | null; platform: string; arch: string; electron: string };
export interface RecorderDependencies {
  sampler: { sample(): Promise<PerformanceSnapshot>; reset(): void };
  allowed(): boolean;
  signal(value: PerformanceCaptureSignal | null): void;
  now(): number;
  monotonic(): number;
  every(ms: number, callback: () => void): () => void;
  build(): Build;
}

type Capture = {
  id: number; startedAt: number; startedMono: number; endedAt: number | null;
  endReason: "stopped" | "deadline" | null; build: Build;
  samples: PerformanceSnapshot[]; ui: (PerformanceUiPulse & { at: number })[];
  main: { at: number; maxDelayMs: number }[]; markers: number[];
  maxUiDelayMs: number | null; maxMainDelayMs: number | null;
  lastTick: number; lastBucket: number; bucketMax: number | null;
  missedSamples: number; failedSamples: number;
};

/** Main owns the bounded capture; settings navigation has no effect on it. */
export function createPerformanceRecorder(deps: RecorderDependencies) {
  let capture: Capture | null = null;
  let serial = 0;
  let epoch = 0;
  let cancelTick: (() => void) | null = null;
  let latest: PerformanceSnapshot | null = null;
  let lastAttempt = -Infinity;
  let lastStart = -Infinity;
  let read: { epoch: number; promise: Promise<void> } | null = null;

  function invalidate() {
    epoch++;
    latest = null;
    lastAttempt = -Infinity;
    deps.sampler.reset();
  }
  function clear() {
    const wasActive = capture?.endedAt === null;
    cancelTick?.(); cancelTick = null;
    capture = null;
    invalidate();
    if (wasActive) deps.signal(null);
  }
  function state(): PerformanceDiagnosticsState {
    const c = capture;
    return { phase: !c ? "idle" : c.endedAt === null ? "recording" : "complete", id: c?.id ?? null,
      startedAt: c?.startedAt ?? null, endedAt: c?.endedAt ?? null, deadline: c ? c.startedAt + DURATION : null,
      sampleCount: c?.samples.length ?? 0, latest, maxMainDelayMs: c?.maxMainDelayMs ?? null,
      maxUiDelayMs: c?.maxUiDelayMs ?? null, markerCount: c?.markers.length ?? 0 };
  }
  function take(c: Capture | null): Promise<void> {
    if (read?.epoch === epoch) return read.promise;
    if (deps.monotonic() - lastAttempt < PERIOD) return Promise.resolve();
    const generation = epoch;
    lastAttempt = deps.monotonic();
    // A reset can occur during native I/O. Serialize even across ownership changes.
    const previous = read?.promise;
    const current = () => generation === epoch && deps.allowed() && (!c || (capture === c && c.endedAt === null));
    const promise = (async () => {
      if (previous) await previous.catch(() => undefined); // Its original caller handles the failure.
      if (!current()) return;
      const sample = await deps.sampler.sample();
      if (!current() || (c && (deps.now() >= c.startedAt + DURATION || deps.monotonic() - c.startedMono >= DURATION))) return;
      latest = sample;
      if (c && c.samples.length < MAX_SAMPLES) c.samples.push(sample);
    })().finally(() => { if (read?.promise === promise) read = null; });
    read = { epoch: generation, promise };
    return promise;
  }
  function sampleCapture(c: Capture) {
    if (read?.epoch === epoch) { c.missedSamples++; return; }
    void take(c).catch(() => { if (capture === c && c.endedAt === null) c.failedSamples++; });
  }
  function flushDelay(c: Capture) {
    if (c.bucketMax !== null && c.main.length < MAX_SAMPLES) c.main.push({ at: deps.now(), maxDelayMs: c.bucketMax });
    c.bucketMax = null;
  }
  function finish(c: Capture, reason: "stopped" | "deadline") {
    c.endedAt = deps.now(); c.endReason = reason;
    flushDelay(c);
    cancelTick?.(); cancelTick = null;
    deps.signal(null);
  }
  function tick(c: Capture) {
    if (capture !== c || c.endedAt !== null) return;
    if (!deps.allowed()) { clear(); return; }
    const now = deps.monotonic();
    const delay = Math.max(0, Math.round(now - c.lastTick - TICK));
    c.lastTick = now;
    c.bucketMax = Math.max(c.bucketMax ?? 0, delay);
    c.maxMainDelayMs = Math.max(c.maxMainDelayMs ?? 0, delay);
    if (now - c.startedMono >= DURATION || deps.now() >= c.startedAt + DURATION) { finish(c, "deadline"); return; }
    if (now - c.lastBucket >= PERIOD) {
      c.lastBucket = now;
      flushDelay(c);
      sampleCapture(c);
    }
  }
  function checkDeadline() {
    if (capture?.endedAt === null && (deps.monotonic() - capture.startedMono >= DURATION || deps.now() >= capture.startedAt + DURATION)) tick(capture);
  }
  function start(): PerformanceDiagnosticsState {
    checkDeadline();
    if (capture?.endedAt === null) return state();
    const now = deps.monotonic();
    if (now - lastStart < PERIOD) throw new Error("Recording started too recently");
    lastStart = now;
    invalidate();
    const c: Capture = { id: ++serial, startedAt: deps.now(), startedMono: now, endedAt: null, endReason: null,
      build: deps.build(), samples: [], main: [], ui: [], markers: [], maxUiDelayMs: null, maxMainDelayMs: null,
      lastTick: now, lastBucket: now, bucketMax: null, missedSamples: 0, failedSamples: 0 };
    capture = c;
    try {
      cancelTick = deps.every(TICK, () => tick(c));
      deps.signal({ id: c.id, deadline: c.startedAt + DURATION });
      sampleCapture(c);
      return state();
    } catch (error) { clear(); throw error; }
  }
  function requireCapture(id: number) {
    checkDeadline();
    if (!capture || capture.id !== id) throw new Error("Recording is no longer available");
    return capture;
  }
  return { clear, start,
    async snapshot() {
      checkDeadline();
      if (!capture || capture.endedAt !== null) await take(null);
      return state();
    },
    stop(id: number) {
      const c = requireCapture(id);
      if (c.endedAt === null) finish(c, "stopped");
      return state();
    },
    mark(id: number) {
      const c = requireCapture(id);
      if (c.endedAt !== null || c.markers.length >= MAX_MARKERS) throw new Error("Recording cannot accept another marker");
      c.markers.push(deps.now());
      return state();
    },
    pulse(value: PerformanceUiPulse) {
      checkDeadline();
      const c = capture;
      // Delivery after stop/reload is normal. Never attach stale data to another recording.
      if (!c || c.endedAt !== null || value.id !== c.id || c.ui.length >= MAX_SAMPLES) return;
      c.ui.push({ ...value, at: deps.now() });
      if (value.maxDelayMs !== null) c.maxUiDelayMs = Math.max(c.maxUiDelayMs ?? 0, value.maxDelayMs);
    },
    report(id: number) {
      const c = requireCapture(id);
      if (c.endedAt === null) throw new Error("Stop recording before previewing the report");
      let peakCpu: PerformanceSnapshot["processes"][number] | null = null;
      let peakMemory: PerformanceSnapshot["processes"][number] | null = null;
      for (const sample of c.samples) for (const row of sample.processes) {
        if (row.cpuPercent !== null && row.cpuPercent > (peakCpu?.cpuPercent ?? -1)) peakCpu = row;
        if (row.workingSetKiB !== null && row.workingSetKiB > (peakMemory?.workingSetKiB ?? -1)) peakMemory = row;
      }
      return JSON.stringify({ schemaVersion: 1, build: c.build, recordingId: id, startedAt: c.startedAt, endedAt: c.endedAt,
        endReason: c.endReason, units: { timestamps: "unix-ms", cpuPercent: "total-machine", memory: "KiB", latency: "timer-delay-ms" },
        samplePeriodMs: PERIOD, mainProbePeriodMs: TICK, durationLimitMs: DURATION,
        summary: { maxMainDelayMs: c.maxMainDelayMs, maxUiDelayMs: c.maxUiDelayMs, peakCpu, peakWorkingSet: peakMemory,
          processSamples: c.samples.length, uiPulses: c.ui.length, missedProcessSamples: c.missedSamples, failedProcessSamples: c.failedSamples },
        processes: c.samples, main: c.main, ui: c.ui, manualMarkers: c.markers }, null, 2) + "\n";
    },
  };
}
