import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { IPC, IPC_WHITELIST } from "../../../packages/shared/src/protocol.ts";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { observeToolResult, observeBackgroundResult, sanitizeObservation } = await import("../electron/main/tool-observation.ts");
const { aggregateToolObservations, readToolObservations, parseToolObservationQuery } = await import("../electron/main/tool-observation-report.ts");
const { Logger } = await import("../electron/main/logger.ts");

const now = Date.parse("2026-11-16T12:00:00Z");
const context = { timestamp: now, desktopPlatform: "win32", appVersion: "0.23.1-beta.1",
  sessionId: "session-1", turnId: "turn-1", toolCallId: "call-1", durationMs: 12 };
const observe = (result, error = false, overrides = {}) => observeToolResult({ ...context, ...overrides }, "Bash", result, error);
const query = { days: 7 };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "pi-tool-observer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "logs", "app"), { recursive: true });
  return directory;
}
function logLine(observation, other = {}) {
  return JSON.stringify({ channel: "app", category: "tool", data: { observation }, ...other }) + "\n";
}

test("structured nested outcomes distinguish nonzero, failed tools, and successful stderr", () => {
  assert.equal(observe({ details: { exitCode: 2, commandShellId: "git-bash" } }).outcome, "command_nonzero");
  assert.equal(observe({ details: { exitCode: 0, stderr: "error: example only" } }).outcome, "success");
  assert.equal(observe({ details: { exitCode: 0 } }, true).outcome, "tool_error");
  assert.equal(observe({ details: { errorCode: "TOOL_TIMEOUT" } }, true).outcome, "timeout");
  assert.equal(observe({ details: { errorCode: "TOOL_ABORTED" } }, true).outcome, "cancelled");
  assert.equal(observe({ content: [{ type: "text", text: '{"exitCode":0}' }] }).outcome, "unknown");
  assert.equal(observeToolResult(context, "Read", {}, false).outcome, "success");
  assert.equal(observeToolResult(context, "Read", {}, true, true).outcome, "interrupted");
  assert.equal(observeToolResult(context, "bash", {}, false).outcome, "unknown");
  assert.equal(observeToolResult(context, "bash", { details: { exitCode: 3 } }, true).outcome, "command_nonzero");
  const wait = observeToolResult(context, "TaskWait", { details: { exitCode: 3, backgroundTaskId: "job-1" } }, false);
  assert.equal(wait.outcome, "success");
  assert.equal(wait.backgroundTaskId, undefined);
  assert.equal(observe({ details: { exitCode: 0 } }, false, { toolCallId: "call_123|fc_456" }).toolCallId, "call_123|fc_456");
});

test("observations exclude raw content, paths, unknown error prose, and secret-like IDs", () => {
  const observation = observe({
    command: "SECRET_COMMAND", stdout: "PRIVATE_FILE", stderr: "SECRET_TOKEN",
    details: { exitCode: 1, errorCode: "SECRET_ERROR", commandShellId: "bash;secret", truncated: true },
  }, false, { sessionId: "sk-abcdefghijk12345", toolCallId: "C:/private/file" });
  assert.equal(observation.sessionId, undefined);
  assert.equal(observation.toolCallId, undefined);
  assert.equal(observation.errorCode, undefined);
  assert.equal(observation.shellId, undefined);
  assert.equal(observation.truncated, true);
  assert.doesNotMatch(JSON.stringify(observation), /SECRET|PRIVATE|private|abcdefghijk/);
  const loaded = sanitizeObservation({ ...observation, stdout: "PRIVATE", toolName: "plugin_password", desktopPlatform: "secret" });
  assert.equal(loaded.toolName, "external");
  assert.equal(loaded.desktopPlatform, "unknown");
  assert.doesNotMatch(JSON.stringify(loaded), /PRIVATE|password|secret/);
  assert.equal(observe({}, false, { timestamp: NaN }), undefined);
});

test("aggregation deduplicates call IDs, groups facts, and retains the success denominator", () => {
  const failed = observe({ details: { exitCode: 1 } });
  const again = observe({ details: { exitCode: 1 } }, false, { toolCallId: "call-2", timestamp: now - 1000 });
  const success = observe({ details: { exitCode: 0 } }, false, { toolCallId: "call-3" });
  const report = aggregateToolObservations([failed, failed, again, success], query, now);
  assert.equal(report.total, 3);
  assert.equal(report.counts.success, 1);
  assert.equal(report.counts.command_nonzero, 2);
  assert.equal(report.groups.length, 1);
  assert.equal(report.groups[0].count, 2);
  assert.equal(report.groups[0].sessionCount, 1);
  assert.equal(report.groups[0].examples.length, 2);
  assert.equal(aggregateToolObservations([failed], query, now + 8 * 86_400_000).total, 0);
});

test("background launches do not count twice after authoritative settlement", () => {
  const launch = observe({ details: { backgroundTaskId: "job-1", commandShellId: "git-bash" } });
  const settled = observeBackgroundResult(context, { taskId: "job-1", sessionId: "session-1",
    state: "failed", exitCode: 17, commandShellId: "git-bash", durationMs: 20, command: "PRIVATE" });
  assert.equal(launch.outcome, "background_started");
  assert.equal(settled.outcome, "command_nonzero");
  assert.equal(aggregateToolObservations([launch, settled, settled], query, now).total, 1);
  assert.equal(aggregateToolObservations([launch], query, now).counts.background_started, 1);
  assert.equal(observeBackgroundResult(context, { taskId: "job-1", sessionId: "session-1", state: "running" }), undefined);
  assert.equal(observeBackgroundResult(context, { taskId: "job-1", sessionId: "session-1", state: "stopped", exitCode: 1 }).outcome, "cancelled");
  assert.doesNotMatch(JSON.stringify(settled), /PRIVATE/);
});

test("real Logger to report path reads rotations, ignores legacy, and flags incomplete data", async (t) => {
  const directory = await fixture(t);
  const logger = new Logger(directory, "info", { mirrorConsole: false });
  logger.app("tool", "info", "tool execution completed", { data: { observation: observe({ details: { exitCode: 3 } }) } });
  await writeFile(join(directory, "logs/app/tool.1.log"),
    logLine(observe({ details: { exitCode: 0 } }, false, { toolCallId: "call-2" }))
      + logLine(undefined) + "{broken}\n" + '{"incomplete":');
  const report = await readToolObservations(directory, query, now);
  assert.equal(report.total, 2);
  assert.equal(report.counts.success, 1);
  assert.equal(report.coverage.filesRead, 2);
  assert.equal(report.coverage.malformedLines, 1);
  assert.equal(report.coverage.ignoredLegacyRecords, 1);
  assert.equal(report.coverage.limited, true);
  assert.equal(report.coverage.readErrors, 0);
  assert.doesNotMatch(JSON.stringify(report), /incomplete|broken/);
});

test("reader handles missing logs and does not accept non-regular files", async (t) => {
  const directory = await fixture(t);
  assert.equal((await readToolObservations(directory, query, now)).total, 0);
  await mkdir(join(directory, "logs/app/tool.log"));
  assert.equal((await readToolObservations(directory, query, now)).coverage.readErrors, 1);
});

test("reader refuses a log directory junction escaping the data root", async (t) => {
  const directory = await fixture(t);
  const external = await fixture(t);
  await writeFile(join(external, "logs/app/tool.log"), logLine(observe({ details: { exitCode: 1 } })));
  await rm(join(directory, "logs/app"), { recursive: true });
  await symlink(join(external, "logs/app"), join(directory, "logs/app"), process.platform === "win32" ? "junction" : "dir");
  const report = await readToolObservations(directory, query, now);
  assert.equal(report.total, 0);
  assert.equal(report.coverage.readErrors, 1);
});

test("reader caps oversized files and bounded examples without losing aggregate counts", async (t) => {
  const directory = await fixture(t);
  const line = logLine(observe({ details: { exitCode: 1 } }));
  await writeFile(join(directory, "logs/app/tool.log"), "x".repeat(6 * 1024 * 1024) + "\n" + line);
  const report = await readToolObservations(directory, query, now);
  assert.equal(report.total, 1);
  assert.equal(report.coverage.limited, true);
  const many = Array.from({ length: 250 }, (_, index) => observe({ details: { exitCode: 1 } }, false, { toolCallId: `call-${index}` }));
  const aggregate = aggregateToolObservations(many, query, now);
  assert.equal(aggregate.total, 250);
  assert.equal(aggregate.recent.length, 200);
  assert.equal(aggregate.groups[0].examples.length, 5);
  assert.equal(aggregate.coverage.limited, true);
});

test("IPC query only accepts a supported day window, never a filesystem path", () => {
  for (const input of [null, [], {}, { days: "7" }, { days: 0 }, { days: 7, path: "secret" }]) {
    assert.throws(() => parseToolObservationQuery(input), /invalid observation query/);
  }
  for (const days of [1, 7, 30]) assert.deepEqual(parseToolObservationQuery({ days }), { days });
  assert.ok(IPC_WHITELIST.has(IPC.invoke.toolObservationsRead));
});

test("diagnostics IPC gates developer access before and after reads and coalesces requests", async () => {
  const source = await readFile(new URL("../electron/main/ipc/diagnostics-ipc.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  let enabled = false;
  let reads = 0;
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const imports = { electron: { shell: {} }, "node:fs": {}, "node:path": { join }, "@pi-desktop/shared": { IPC },
    "../tool-observation-report": { parseToolObservationQuery, readToolObservations: () => { reads++; return pending; } } };
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), id);
    return imports[id];
  }, module.exports, module);
  const handlers = new Map();
  module.exports.registerDiagnosticsIpc({ registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    dataDir: "unused", stripWinLongPrefix: (path) => path, isDeveloperMode: () => enabled, getMainWindow: () => null });
  const read = handlers.get(IPC.invoke.toolObservationsRead);
  await assert.rejects(read(query), /developer mode/);
  assert.equal(reads, 0);
  enabled = true;
  const first = read(query);
  const second = read(query);
  assert.equal(reads, 1);
  enabled = false;
  resolve(aggregateToolObservations([], query, now));
  await assert.rejects(first, /developer mode/);
  await assert.rejects(second, /developer mode/);
});
