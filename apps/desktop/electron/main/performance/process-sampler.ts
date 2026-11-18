import { app, type ProcessMetric } from "electron";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import type { PerformanceProcessRole, PerformanceProcessRow, PerformanceSnapshot } from "@pi-desktop/shared";
import { readOwnedChildMetrics, type OwnedChildMetrics, type OwnedChildProbe } from "./owned-child-metrics";

const MAX_ROWS = 64;
const CHILD_DEADLINE_MS = 250;
const KNOWN_ROLES = ["main", "mainRenderer", "host", "agent", "browser"] as const;
const METRIC_ROLES = ["gpu", "plugin", "renderer", "utility", "other"] as const;
type KnownRole = (typeof KNOWN_ROLES)[number];
type ChildRole = "host" | "agent";

export type PerformanceProcessSamplerDeps = {
  getHostPid: () => number | null;
  getAgentPid: () => number | null;
  getRendererPid: () => number | null;
  getBrowserPids: () => readonly number[];
  getPluginPageOwners?: () => ReadonlyMap<number, string | null>;
  /** Only live host registries, never ProcessMetric.name or serviceName. */
  getPluginProcessOwners?: () => ReadonlyMap<number, string>;
};

type SamplingSources = {
  getAppMetrics: () => readonly ProcessMetric[];
  readChild: OwnedChildProbe;
  mainPid: number;
  platform: NodeJS.Platform;
  logicalCpuCount: () => number;
  wallNow: () => number;
  monotonicNow: () => number;
};

type CpuPoint = { origin: "electron" | "child"; identity: number | bigint; seconds: number; measuredAt: number };
type ChildPoint = { metrics: OwnedChildMetrics; measuredAt: number };

function isPid(pid: number | null): pid is number {
  return pid !== null && Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffff_ffff;
}

function nonnegative(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function startedAt(metric: ProcessMetric): number | null {
  const time = nonnegative(metric.creationTime);
  return time === 0 ? null : time;
}

function safePluginOwner(id: string | null | undefined): string | null {
  return id && id.length <= 128 && id !== "." && id !== ".." && !/[^a-zA-Z0-9._-]/.test(id) ? id : null;
}

function cpuPercent(current: CpuPoint, previous: CpuPoint | undefined, logicalCpuCount: number): number | null {
  if (!previous || current.origin !== previous.origin || current.identity !== previous.identity || logicalCpuCount < 1) return null;
  const elapsedSeconds = (current.measuredAt - previous.measuredAt) / 1000;
  const consumedSeconds = current.seconds - previous.seconds;
  // Do not present a long collapsed/hidden-panel interval as current CPU load.
  return elapsedSeconds > 0 && elapsedSeconds <= 5 && consumedSeconds >= 0
    ? Math.min(100, consumedSeconds / elapsedSeconds / logicalCpuCount * 100)
    : null;
}

async function untilChildDeadline(tasks: Promise<void>[], controller: AbortController): Promise<void> {
  if (tasks.length === 0 || controller.signal.aborted) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort!: () => void;
  const deadline = new Promise<void>((resolve) => {
    onAbort = resolve;
    controller.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => controller.abort(), CHILD_DEADLINE_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([Promise.all(tasks), deadline]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

export function createPerformanceProcessSampler(
  deps: PerformanceProcessSamplerDeps,
  sources: SamplingSources = {
    getAppMetrics: () => app.getAppMetrics(),
    readChild: readOwnedChildMetrics,
    mainPid: process.pid,
    platform: process.platform,
    logicalCpuCount: () => cpus().length,
    wallNow: Date.now,
    monotonicNow: () => performance.now(),
  },
): { sample: () => Promise<PerformanceSnapshot>; reset: () => void } {
  let generation = 0;
  let prior = new Map<number, CpuPoint>();
  let coreCount: number | undefined;
  let inFlight: { controller: AbortController; promise: Promise<PerformanceSnapshot> } | null = null;
  const pendingChildren = new Set<ChildRole>();
  let warnedMetrics = false;
  let warnedChild = false;

  async function collect(epoch: number, controller: AbortController): Promise<PerformanceSnapshot> {
    const at = sources.wallNow();
    const known = new Map<number, KnownRole>();
    const add = (role: KnownRole, pid: number | null) => { if (isPid(pid) && !known.has(pid)) known.set(pid, role); };
    add("main", sources.mainPid);
    add("mainRenderer", deps.getRendererPid());
    add("host", deps.getHostPid());
    add("agent", deps.getAgentPid());
    for (const pid of deps.getBrowserPids()) add("browser", pid);

    let metrics: readonly ProcessMetric[] = [];
    try {
      metrics = sources.getAppMetrics();
    } catch {
      if (!warnedMetrics) console.warn("[performance] Electron process metrics unavailable");
      warnedMetrics = true;
    }
    const measuredAt = sources.monotonicNow();
    const electron = new Map<number, ProcessMetric>();
    for (const metric of metrics) {
      if (!isPid(metric.pid)) continue;
      const existing = electron.get(metric.pid);
      if (!existing || (startedAt(metric) ?? 0) > (startedAt(existing) ?? 0)) electron.set(metric.pid, metric);
    }
    const owners = deps.getPluginProcessOwners?.();
    const pages = deps.getPluginPageOwners?.();

    const children = new Map<number, ChildPoint>();
    const tasks: Promise<void>[] = [];
    const signal = controller.signal;
    for (const [pid, role] of known) {
      if ((role !== "host" && role !== "agent") || electron.has(pid) || pendingChildren.has(role)) continue;
      pendingChildren.add(role);
      tasks.push((async () => {
        try {
          const result = await sources.readChild(pid, signal);
          if (result && !signal.aborted) children.set(pid, { metrics: result, measuredAt: sources.monotonicNow() });
        } catch {
          if (!signal.aborted && !warnedChild) {
            console.warn("[performance] Local sidecar process metrics unavailable");
            warnedChild = true;
          }
        } finally {
          // If an OS call outlasts the response deadline, don't requeue its slot.
          pendingChildren.delete(role);
        }
      })());
    }
    await untilChildDeadline(tasks, controller);
    if (epoch !== generation) return { at, processes: [], truncated: false };
    if (tasks.length > 0) {
      for (const [pid, role] of known) {
        if ((role === "host" && deps.getHostPid() !== pid) || (role === "agent" && deps.getAgentPid() !== pid)) known.delete(pid);
      }
    }

    const candidates = new Map<number, { role: PerformanceProcessRole; owner: string | null; rank: number }>();
    for (const [pid, role] of known) candidates.set(pid, { role, owner: null, rank: KNOWN_ROLES.indexOf(role) });
    for (const [pid, metric] of electron) {
      if (candidates.has(pid)) continue;
      const pluginId = metric.type === "Utility" ? owners?.get(pid) : metric.type === "Tab" ? pages?.get(pid) : undefined;
      const role = pluginId !== undefined ? "plugin" : metric.type === "Utility" ? "utility" :
        metric.type === "GPU" ? "gpu" : metric.type === "Tab" ? "renderer" : "other";
      const rank = KNOWN_ROLES.length + METRIC_ROLES.indexOf(role);
      candidates.set(pid, { role, owner: safePluginOwner(pluginId), rank });
    }
    const sorted = [...candidates].sort(([pidA, a], [pidB, b]) => a.rank - b.rank || pidA - pidB);
    coreCount ??= sources.logicalCpuCount();
    const next = new Map<number, CpuPoint>();
    const processes = sorted.slice(0, MAX_ROWS).map(([pid, { role, owner }]): PerformanceProcessRow => {
      const metric = electron.get(pid);
      const child = children.get(pid);
      const birth = metric ? startedAt(metric) : child?.metrics.startedAt ?? null;
      // Electron's reported percentages use a shared interval; use its
      // cumulative counter and our own monotonic interval instead.
      const seconds = metric ? nonnegative(metric.cpu?.cumulativeCPUUsage) : child?.metrics.cpuSeconds ?? null;
      const identity = metric ? birth : child?.metrics.identity ?? null;
      let percent: number | null = null;
      if (identity !== null && seconds !== null) {
        const point: CpuPoint = {
          origin: metric ? "electron" : "child", identity, seconds, measuredAt: child?.measuredAt ?? measuredAt,
        };
        percent = cpuPercent(point, prior.get(pid), coreCount ?? 0);
        next.set(pid, point);
      }
      return {
        pid, role, owner, startedAt: birth, cpuPercent: percent,
        // Electron's app ProcessMetric memory numbers are already in KiB.
        workingSetKiB: metric ? nonnegative(metric.memory?.workingSetSize) : child?.metrics.workingSetKiB ?? null,
        privateKiB: sources.platform === "win32"
          ? metric ? nonnegative(metric.memory?.privateBytes) : child?.metrics.privateKiB ?? null
          : null,
      };
    });
    prior = next;
    return { at, processes, truncated: sorted.length > MAX_ROWS };
  }

  return {
    sample() {
      if (inFlight) return inFlight.promise;
      const controller = new AbortController();
      const promise = collect(generation, controller).finally(() => {
        if (inFlight?.controller === controller) inFlight = null;
      });
      inFlight = { controller, promise };
      return promise;
    },
    reset() {
      generation++;
      prior.clear();
      inFlight?.controller.abort();
      inFlight = null;
    },
  };
}