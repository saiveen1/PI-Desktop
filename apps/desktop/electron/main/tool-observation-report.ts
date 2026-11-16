import { open, lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ToolObservation, ToolObservationGroup, ToolObservationQuery, ToolObservationReport } from "@pi-desktop/shared";
import { observationId, sanitizeObservation } from "./tool-observation";

const MAX_FILE_BYTES = 5 * 1024 * 1024 + 64 * 1024;
const MAX_RECORDS = 20_000;
const MAX_RECENT = 200;
const MAX_GROUPS = 100;
const MAX_EXAMPLES = 5;

export function parseToolObservationQuery(input: unknown): ToolObservationQuery {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid observation query");
  const query = input as Record<string, unknown>;
  if (Object.keys(query).some((key) => key !== "days") || ![1, 7, 30].includes(Number(query.days))
    || typeof query.days !== "number") throw new Error("invalid observation query");
  return { days: query.days as 1 | 7 | 30 };
}

function emptyReport(query: ToolObservationQuery, now: number): ToolObservationReport {
  return {
    schemaVersion: 1, generatedAt: new Date(now).toISOString(),
    since: new Date(now - query.days * 86_400_000).toISOString(), days: query.days,
    total: 0,
    counts: { success: 0, command_nonzero: 0, tool_error: 0, timeout: 0, cancelled: 0,
      interrupted: 0, background_started: 0, unknown: 0 },
    groups: [], recent: [],
    coverage: { filesRead: 0, malformedLines: 0, ignoredLegacyRecords: 0, limited: false, readErrors: 0 },
  };
}

export function aggregateToolObservations(
  rows: readonly ToolObservation[], query: ToolObservationQuery, now: number,
): ToolObservationReport {
  const report = emptyReport(query, now);
  const byId = new Map<string, ToolObservation>();
  for (const raw of rows) {
    const row = sanitizeObservation(raw);
    if (row && row.timestamp >= report.since && row.timestamp <= report.generatedAt) byId.set(row.id, row);
  }
  const sorted = [...byId.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const settled = new Set(sorted.filter((row) => row.backgroundTaskId && row.outcome !== "background_started")
    .map((row) => `${row.sessionId}:${row.backgroundTaskId}`));
  const groups = new Map<string, { group: ToolObservationGroup; sessions: Set<string> }>();
  for (const row of sorted) {
    // A launch receipt is not a second completed execution once its job settles.
    if (row.outcome === "background_started" && settled.has(`${row.sessionId}:${row.backgroundTaskId}`)) continue;
    report.total++;
    report.counts[row.outcome]++;
    if (report.recent.length < MAX_RECENT) report.recent.push(row);
    if (row.outcome === "success" || row.outcome === "background_started") continue;
    const id = observationId([row.toolName, row.outcome, row.desktopPlatform, row.appVersion,
      row.shellId, row.errorCode, row.exitCode]);
    let entry = groups.get(id);
    if (!entry) {
      entry = { sessions: new Set(), group: {
        id, toolName: row.toolName, outcome: row.outcome, desktopPlatform: row.desktopPlatform,
        appVersion: row.appVersion, shellId: row.shellId, errorCode: row.errorCode, exitCode: row.exitCode,
        count: 0, sessionCount: 0, firstSeen: row.timestamp, lastSeen: row.timestamp, examples: [],
      } };
      groups.set(id, entry);
    }
    entry.group.count++;
    entry.group.firstSeen = row.timestamp;
    if (row.sessionId) entry.sessions.add(row.sessionId);
    entry.group.sessionCount = entry.sessions.size;
    if (entry.group.examples.length < MAX_EXAMPLES) entry.group.examples.push(row);
  }
  report.groups = [...groups.values()].map(({ group }) => group)
    .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen)).slice(0, MAX_GROUPS);
  report.coverage.limited = groups.size > MAX_GROUPS || report.total > MAX_RECENT;
  return report;
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

/** Only the owning Desktop's fixed tool log files; never a caller-supplied path. */
export async function readToolObservations(
  dataDir: string, query: ToolObservationQuery, now = Date.now(),
): Promise<ToolObservationReport> {
  const report = emptyReport(query, now);
  const rows: ToolObservation[] = [];
  let directory: string;
  try {
    const root = await realpath(dataDir);
    const expected = join(root, "logs", "app");
    directory = await realpath(expected);
    if (directory !== expected) {
      report.coverage.readErrors++;
      return report;
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") report.coverage.readErrors++;
    return report;
  }
  let scanned = 0;
  for (const name of ["tool.log", "tool.1.log", "tool.2.log"]) {
    if (scanned >= MAX_RECORDS) { report.coverage.limited = true; break; }
    const path = join(directory, name);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || await realpath(path) !== path) {
        report.coverage.readErrors++;
        continue;
      }
      handle = await open(path, "r");
      const stat = await handle.stat();
      if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) {
        report.coverage.readErrors++;
        continue;
      }
      const size = Math.min(stat.size, MAX_FILE_BYTES);
      const start = stat.size - size;
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, start);
      report.coverage.filesRead++;
      if (start > 0 || bytesRead !== size) report.coverage.limited = true;
      let text = buffer.subarray(0, bytesRead).toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      const lines = text.split("\n");
      // An in-progress append is not a complete observation.
      if (lines.at(-1) !== "") { lines.pop(); report.coverage.limited = true; }
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        if (++scanned > MAX_RECORDS) { report.coverage.limited = true; break; }
        if (scanned % 250 === 0) await setImmediate();
        if (line.length > 32 * 1024) { report.coverage.malformedLines++; continue; }
        let parsed: unknown;
        try { parsed = JSON.parse(line); }
        catch { report.coverage.malformedLines++; continue; }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          report.coverage.malformedLines++;
          continue;
        }
        const record = parsed as Record<string, unknown>;
        if (record.category !== "tool" || record.channel !== "app") continue;
        const data = record.data && typeof record.data === "object" && !Array.isArray(record.data)
          ? record.data as Record<string, unknown> : {};
        const observation = sanitizeObservation(data.observation);
        if (observation) rows.push(observation);
        else report.coverage.ignoredLegacyRecords++;
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") report.coverage.readErrors++;
    } finally {
      if (handle) {
        try { await handle.close(); }
        catch { report.coverage.readErrors++; }
      }
    }
  }
  const aggregate = aggregateToolObservations(rows, query, now);
  aggregate.coverage = { ...report.coverage, limited: report.coverage.limited || aggregate.coverage.limited };
  return aggregate;
}
