import { PERFORMANCE_STAGES, type PerformanceCaptureSignal, type PerformanceUiPulse } from "@pi-desktop/shared";
import { installRenderDiagnosticSink } from "./render-diagnostics";

const SAMPLE_INTERVAL_MS = 100;
const PULSE_INTERVAL_MS = 1_000;
const MAX_CAPTURE_MS = 30_000;
const MAX_METRIC_MS = 60_000;
const MAX_COUNT = 1_000_000;

type ProbeState = {
  settings?: { developerMode?: boolean };
  activeSessionId?: string;
};
type Clock = {
  wallNow(): number;
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
};
type ProbeOptions = {
  onCapture(listener: (signal: PerformanceCaptureSignal | null) => void): () => void;
  sendPulse(pulse: PerformanceUiPulse): Promise<void>;
  getState(): ProbeState;
  subscribeState(listener: (state: ProbeState, previous: ProbeState) => void): () => void;
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  clock?: Clock;
};
type Capture = {
  id: number;
  deadline: number;
  monotonicDeadline: number;
  started: number;
  timer: ReturnType<typeof setTimeout> | null;
  detachStage: (() => void) | null;
  detachState: (() => void) | null;
  maxDelayMs: number | null;
  stages: PerformanceUiPulse["stages"];
  sessionSwitches: number;
  toolOpens: number;
};

const systemClock: Clock = {
  wallNow: () => Date.now(),
  now: () => performance.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle),
};
let toolOpenSink: (() => void) | null = null;
let pulseInFlight = false;
let lastPulseAt = -Infinity;

/** Counts manual opening of a host tool detail row, without receiving its identity. */
export function recordPerformanceToolOpen(): void {
  toolOpenSink?.();
}

/**
 * Installs only the trusted Main signal listener until recording is authorized.
 * Timings cover work while the main document is visible, not each pane's visibility.
 */
export function installPerformanceUiProbe(options: ProbeOptions): () => void {
  const clock = options.clock ?? systemClock;
  const seen = new Set<number>();
  let capture: Capture | null = null;
  let disposed = false;

  function stop(): void {
    const current = capture;
    if (!current) return;
    capture = null;
    if (current.timer !== null) clock.clearTimeout(current.timer);
    current.detachStage?.();
    current.detachState?.();
    options.document.removeEventListener("visibilitychange", onVisibilityChange);
    if (toolOpenSink === onToolOpen) toolOpenSink = null;
  }

  function live(current: Capture): boolean {
    if (disposed || capture !== current) return false;
    if (clock.wallNow() >= current.deadline || clock.now() >= current.monotonicDeadline ||
      options.getState().settings?.developerMode !== true) {
      stop();
      return false;
    }
    return true;
  }

  function visible(current: Capture): boolean {
    return live(current) && options.document.visibilityState === "visible";
  }

  function onToolOpen(): void {
    const current = capture;
    if (current && visible(current)) current.toolOpens = Math.min(MAX_COUNT, current.toolOpens + 1);
  }

  function attachStage(current: Capture): void {
    const visibleSince = clock.now();
    current.detachStage = installRenderDiagnosticSink((stage, durationMs, startedAt) => {
      if (!visible(current) || !PERFORMANCE_STAGES.includes(stage) || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > MAX_METRIC_MS ||
        (startedAt !== undefined && (!Number.isFinite(startedAt) || startedAt < visibleSince))) return;
      const row = current.stages[stage];
      if (row) {
        row.count = Math.min(MAX_COUNT, row.count + 1);
        row.maxMs = Math.max(row.maxMs, durationMs);
      } else {
        current.stages[stage] = { count: 1, maxMs: durationMs };
      }
    });
  }

  function schedule(current: Capture): void {
    if (!live(current)) return;
    const remaining = Math.min(current.deadline - clock.wallNow(), current.monotonicDeadline - clock.now());
    const delay = options.document.visibilityState === "visible"
      ? Math.min(SAMPLE_INTERVAL_MS, remaining)
      : remaining;
    const expected = clock.now() + delay;
    current.timer = clock.setTimeout(() => tick(current, expected), delay);
  }

  function send(current: Capture, now: number): void {
    const pulse: PerformanceUiPulse = {
      id: current.id,
      maxDelayMs: current.maxDelayMs,
      stages: current.stages,
      sessionSwitches: current.sessionSwitches,
      toolOpens: current.toolOpens,
    };
    current.maxDelayMs = null;
    current.stages = {};
    current.sessionSwitches = 0;
    current.toolOpens = 0;
    pulseInFlight = true;
    lastPulseAt = now;
    try {
      void Promise.resolve(options.sendPulse(pulse)).then(
        () => { pulseInFlight = false; },
        () => {
          pulseInFlight = false;
          if (visible(current)) console.warn("Performance UI pulse failed");
        },
      );
    } catch {
      pulseInFlight = false;
      if (visible(current)) console.warn("Performance UI pulse failed");
    }
  }

  function tick(current: Capture, expected: number): void {
    if (!live(current)) return;
    current.timer = null;
    if (options.document.visibilityState === "visible") {
      const now = clock.now();
      const delay = Math.max(0, now - expected);
      current.maxDelayMs = Math.max(current.maxDelayMs ?? 0, delay);
      if (!pulseInFlight && now - current.started >= PULSE_INTERVAL_MS && now - lastPulseAt >= PULSE_INTERVAL_MS) {
        send(current, now);
      }
    }
    schedule(current);
  }

  function onVisibilityChange(): void {
    const current = capture;
    if (!current || !live(current)) return;
    if (current.timer !== null) clock.clearTimeout(current.timer);
    current.timer = null;
    current.detachStage?.();
    current.detachStage = null;
    if (options.document.visibilityState === "visible") attachStage(current);
    schedule(current);
  }

  function onCapture(signal: PerformanceCaptureSignal | null): void {
    if (disposed) return;
    if (signal === null) {
      stop();
      return;
    }
    if (!Number.isSafeInteger(signal.id) || signal.id <= 0 || !Number.isFinite(signal.deadline) ||
      signal.deadline <= clock.wallNow() || seen.has(signal.id)) return;
    seen.add(signal.id);
    if (seen.size > 64) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    stop();
    if (options.getState().settings?.developerMode !== true) return;
    const now = clock.now();
    const wallNow = clock.wallNow();
    const deadline = Math.min(signal.deadline, wallNow + MAX_CAPTURE_MS);
    const lifetime = deadline - wallNow;
    if (lifetime <= 0) return;
    const current: Capture = {
      id: signal.id,
      deadline,
      monotonicDeadline: now + lifetime,
      started: now,
      timer: null,
      detachStage: null,
      detachState: null,
      maxDelayMs: null,
      stages: {},
      sessionSwitches: 0,
      toolOpens: 0,
    };
    capture = current;
    toolOpenSink = onToolOpen;
    current.detachState = options.subscribeState((state, previous) => {
      if (!live(current)) return;
      if (options.document.visibilityState === "visible" && state.activeSessionId &&
        state.activeSessionId !== previous.activeSessionId) {
        current.sessionSwitches = Math.min(MAX_COUNT, current.sessionSwitches + 1);
      }
    });
    options.document.addEventListener("visibilitychange", onVisibilityChange);
    if (options.document.visibilityState === "visible") attachStage(current);
    schedule(current);
  }

  const detachSignal = options.onCapture(onCapture);
  return () => {
    disposed = true;
    stop();
    detachSignal();
  };
}
