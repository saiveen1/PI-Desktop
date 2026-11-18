/** Local, opt-in workstation diagnostics. Times are epoch milliseconds unless noted. */
export type PerformanceProcessRole = "main" | "mainRenderer" | "renderer" | "browser" | "plugin" | "gpu" | "host" | "agent" | "utility" | "other";
export interface PerformanceProcessRow {
  pid: number;
  role: PerformanceProcessRole;
  /** Known plugin identifier only; never a window title, URL or command line. */
  owner: string | null;
  startedAt: number | null;
  /** Percent of total machine CPU (not percent of one logical core). */
  cpuPercent: number | null;
  workingSetKiB: number | null;
  privateKiB: number | null;
}
export interface PerformanceSnapshot { at: number; processes: PerformanceProcessRow[]; truncated: boolean }
export const PERFORMANCE_STAGES = ["chat-link-scan", "markdown-linkify-tree", "markdown-normalize", "markdown-split", "markdown-react-render", "code-highlight"] as const;
export type PerformanceStage = (typeof PERFORMANCE_STAGES)[number];
export interface PerformanceUiPulse {
  id: number;
  maxDelayMs: number | null;
  stages: Partial<Record<PerformanceStage, { count: number; maxMs: number }>>;
  sessionSwitches: number;
  toolOpens: number;
}
export interface PerformanceCaptureSignal { id: number; deadline: number }
export type PerformanceAction = "snapshot" | "start" | "stop" | "mark";
export interface PerformanceDiagnosticsState {
  phase: "idle" | "recording" | "complete";
  id: number | null;
  startedAt: number | null;
  endedAt: number | null;
  deadline: number | null;
  sampleCount: number;
  latest: PerformanceSnapshot | null;
  maxMainDelayMs: number | null;
  maxUiDelayMs: number | null;
  markerCount: number;
}
