import { PERFORMANCE_STAGES, type PerformanceUiPulse } from "@pi-desktop/shared";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
}
function duration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 60_000;
}
export function isCaptureId(id: unknown): id is number {
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0;
}

/** Reconstruct only numeric measurements. Never retain even unknown fields from IPC. */
export function parsePerformancePulse(value: unknown): PerformanceUiPulse {
  const invalid = () => new Error("Invalid performance measurement");
  if (!record(value) || !isCaptureId(value.id) || !count(value.sessionSwitches) || !count(value.toolOpens) ||
    (value.maxDelayMs !== null && !duration(value.maxDelayMs)) || !record(value.stages) ||
    Object.keys(value).length !== 5) throw invalid();
  const stages: PerformanceUiPulse["stages"] = {};
  for (const key of Object.keys(value.stages)) {
    const stage = PERFORMANCE_STAGES.find(allowed => allowed === key);
    const entry = value.stages[key];
    if (!stage || !record(entry) || Object.keys(entry).length !== 2 || !count(entry.count) || !duration(entry.maxMs)) throw invalid();
    stages[stage] = { count: entry.count, maxMs: entry.maxMs };
  }
  return { id: value.id, maxDelayMs: value.maxDelayMs, stages,
    sessionSwitches: value.sessionSwitches, toolOpens: value.toolOpens };
}
