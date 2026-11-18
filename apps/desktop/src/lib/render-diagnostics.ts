import type { PerformanceStage } from "@pi-desktop/shared";

export type RenderDiagnosticStage = PerformanceStage;

export type RenderDiagnosticFields = {
  sourceLength?: number;
  longestLine?: number;
  inputNodeCount?: number;
  workCodeUnits?: number;
  linkCount?: number;
  durationMs?: number;
  baseDurationMs?: number;
  startTime?: number;
  commitTime?: number;
  reason?: string;
  renderPhase?: string;
};

export type RenderDiagnosticSample = RenderDiagnosticFields & {
  key: string;
  stage: RenderDiagnosticStage;
  phase: "start" | "end" | "complete";
  at: number;
};

type RenderDiagnosticSink = (stage: RenderDiagnosticStage, durationMs: number, startedAt?: number) => void;
const MAX_SAMPLES = 128;
const samples: RenderDiagnosticSample[] = [];
let sequence = 0;
let sink: RenderDiagnosticSink | null = null;
const noop = () => undefined;

export const renderDiagnosticSamplesEnabled = typeof import.meta.env !== "undefined" &&
  (import.meta.env.DEV || import.meta.env.MODE === "test");

export function isRenderDiagnosticEnabled(): boolean {
  return renderDiagnosticSamplesEnabled || sink !== null;
}

/** The capture owns the sink; an old cleanup cannot detach a replacement. */
export function installRenderDiagnosticSink(next: RenderDiagnosticSink): () => void {
  sink = next;
  return () => { if (sink === next) sink = null; };
}

function append(sample: RenderDiagnosticSample): void {
  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

export function readRenderDiagnosticSamples(): RenderDiagnosticSample[] {
  return samples.map((sample) => ({ ...sample }));
}

export function clearRenderDiagnosticSamples(): void {
  samples.length = 0;
}

/** Start a bounded, content-free record for the current synchronous phase. */
export function beginRenderDiagnostic(
  stage: RenderDiagnosticStage,
  fields?: RenderDiagnosticFields,
): (result?: RenderDiagnosticFields) => void {
  const startedSink = sink;
  if (!renderDiagnosticSamplesEnabled && !startedSink) return noop;
  const key = renderDiagnosticSamplesEnabled ? `render-${++sequence}` : "";
  const startedAt = performance.now();
  if (renderDiagnosticSamplesEnabled) append({ key, stage, phase: "start", at: startedAt, ...fields });
  return (result) => {
    const at = performance.now();
    if (renderDiagnosticSamplesEnabled) {
      append({ key, stage, phase: "end", at, durationMs: at - startedAt, ...fields, ...result });
    }
    if (startedSink && sink === startedSink) startedSink(stage, at - startedAt);
  };
}

/** Add a completed render measurement supplied by React Profiler. */
export function recordRenderDiagnostic(
  stage: RenderDiagnosticStage,
  fields?: RenderDiagnosticFields,
): void {
  if (!isRenderDiagnosticEnabled()) return;
  if (renderDiagnosticSamplesEnabled) {
    append({ key: `render-${++sequence}`, stage, phase: "complete", at: performance.now(), ...fields });
  }
  if (sink && typeof fields?.durationMs === "number") sink(stage, fields.durationMs, fields.startTime);
}

declare global {
  interface Window {
    __piDesktopRenderDiagnostics?: {
      clear: typeof clearRenderDiagnosticSamples;
      read: typeof readRenderDiagnosticSamples;
    };
  }
}

if (renderDiagnosticSamplesEnabled && typeof window !== "undefined") {
  window.__piDesktopRenderDiagnostics = {
    clear: clearRenderDiagnosticSamples,
    read: readRenderDiagnosticSamples,
  };
}
