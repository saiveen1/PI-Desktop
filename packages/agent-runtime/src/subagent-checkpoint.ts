import { isDelegationRunPolicySnapshot, parseSubagentObservation, type SubagentObservation, type DelegationRunPolicy } from "@pi-desktop/shared";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { parseSubagentTerminalDiagnostics, type SubagentTerminalDiagnostics } from "./subagent-terminal.js";

export type SubagentCheckpointStatus = "running" | "completed" | "failed" | "aborted" | "timed_out";
export type SubagentCheckpointError = {
  code?: string; message?: string; resumeId?: string; charactersProduced?: number;
};
export type SubagentCheckpoint = {
  version?: 1;
  status: SubagentCheckpointStatus;
  sessionId?: string;
  delegateSessionId?: string;
  delegationId?: string;
  agentName: string;
  modelId: string;
  thinkingLevel: string;
  task?: string;
  report: string;
  partial?: boolean;
  runPolicy?: Readonly<DelegationRunPolicy>;
  terminationReason?: string;
  turns: number;
  toolCalls: number;
  updatedAt: string | number;
  error?: SubagentCheckpointError | string;
  /** Historical extension data is never restored as executable context. */
  context?: unknown;
  contextCompactions?: number;
  contextDegraded?: boolean;
  outputTruncated?: boolean;
  terminal?: SubagentTerminalDiagnostics;
  observation?: SubagentObservation;
};
type CheckpointLocation = { scratchDir?: string; delegateSessionId?: string; parentToolCallId: string };
export type PersistSubagentCheckpointOptions = CheckpointLocation & { checkpoint: SubagentCheckpoint };
export type PersistSubagentCheckpointResult = { checkpointPath?: string; reportPath?: string; error?: string };
export type ReadSubagentCheckpointOptions = CheckpointLocation & { sessionId: string; agentName: string };
export type ReadSubagentCheckpointResult = { checkpoint?: SubagentCheckpoint; error?: string };

const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;
const STATUSES = new Set(["running", "completed", "failed", "aborted", "timed_out"]);
const chainId = (options: CheckpointLocation) => options.delegateSessionId || options.parentToolCallId;
function safeId(value: string): string {
  if (/^[A-Za-z0-9._-]{1,120}$/.test(value) && value !== "." && value !== "..") return value;
  return `id-h${createHash("sha256").update(Buffer.from(value, "utf16le")).digest("hex")}`;
}
function code(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
function fail(errorCode: string): never { throw Object.assign(new Error(errorCode), { code: errorCode }); }
function safeError(error: unknown): string {
  const value = code(error);
  return value?.startsWith("checkpoint-") ? value : "checkpoint-io-error";
}
function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith("../") && !suffix.startsWith("..\\");
}

/** The root is host supplied; every component below it is fixed or derived from an opaque id. */
function directory(options: CheckpointLocation, create: boolean): string {
  if (!options.scratchDir) fail("checkpoint-unavailable");
  if (create) mkdirSync(options.scratchDir, { recursive: true });
  const root = realpathSync.native(options.scratchDir);
  let current = root;
  for (const segment of ["delegations", safeId(chainId(options))]) {
    const target = join(current, segment);
    let exists = true;
    try {
      if (lstatSync(target).isSymbolicLink()) fail("checkpoint-unsafe-path");
    } catch (error) {
      if (code(error) !== "ENOENT") throw error;
      exists = false;
      if (!create) throw error;
    }
    if (!exists) mkdirSync(target);
    current = realpathSync.native(target);
    if (!contained(root, current)) fail("checkpoint-unsafe-path");
  }
  return current;
}
function atomicWrite(target: string, text: string): void {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, target);
  } finally {
    try { unlinkSync(temporary); } catch { /* Rename already consumed it, or the original I/O error is returned. */ }
  }
}

/** JSON is the recovery authority. Each file is atomic; the pair is not a transaction. */
export function persistSubagentCheckpoint(options: PersistSubagentCheckpointOptions): PersistSubagentCheckpointResult {
  if (!options.scratchDir) return {};
  try {
    const dir = directory(options, true);
    const value = { ...options.checkpoint, version: 1, delegateSessionId: chainId(options) };
    const json = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(json, "utf8") > MAX_CHECKPOINT_BYTES) fail("checkpoint-too-large");
    const checkpointPath = join(dir, "checkpoint.json");
    const reportPath = join(dir, "report.md");
    atomicWrite(reportPath, value.report);
    atomicWrite(checkpointPath, json);
    return { checkpointPath, reportPath };
  } catch (error) { return { error: safeError(error) }; }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function shortString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 200; }
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function restoredError(value: unknown): SubagentCheckpointError | string | undefined {
  if (typeof value === "string") return value.slice(0, 2000);
  if (!record(value)) return undefined;
  return {
    ...(shortString(value.code) ? { code: value.code } : {}),
    ...(typeof value.message === "string" ? { message: value.message.slice(0, 2000) } : {}),
    ...(shortString(value.resumeId) ? { resumeId: value.resumeId } : {}),
    ...(count(value.charactersProduced) ? { charactersProduced: value.charactersProduced } : {}),
  };
}
function validate(value: unknown, options: ReadSubagentCheckpointOptions): SubagentCheckpoint {
  if (!record(value) || value.version !== 1) fail("checkpoint-invalid");
  if (value.sessionId !== options.sessionId || value.agentName !== options.agentName || value.delegateSessionId !== chainId(options)) {
    fail("checkpoint-identity-mismatch");
  }
  if (typeof value.status !== "string" || !STATUSES.has(value.status) ||
      typeof value.report !== "string" || !value.report.trim() ||
      !shortString(value.modelId) || !shortString(value.thinkingLevel) ||
      !count(value.turns) || !count(value.toolCalls) ||
      !(typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ||
        typeof value.updatedAt === "string" && value.updatedAt.length > 0 && value.updatedAt.length <= 64) ||
      value.task !== undefined && typeof value.task !== "string") fail("checkpoint-invalid");
  if (value.runPolicy !== undefined && !isDelegationRunPolicySnapshot(value.runPolicy)) fail("checkpoint-invalid");
  const terminal = parseSubagentTerminalDiagnostics(value.terminal);
  if (value.terminal !== undefined && !terminal) fail("checkpoint-invalid");
  const observation = parseSubagentObservation(value.observation);
  if (value.observation !== undefined && !observation) fail("checkpoint-invalid");
  // Only known fields survive: no arbitrary persisted context, tools, or credentials.
  return {
    version: 1, sessionId: options.sessionId, agentName: options.agentName, delegateSessionId: chainId(options),
    status: value.status as SubagentCheckpointStatus, modelId: value.modelId, thinkingLevel: value.thinkingLevel,
    ...(isDelegationRunPolicySnapshot(value.runPolicy) ? { runPolicy: value.runPolicy } : {}),
    report: value.report, turns: value.turns, toolCalls: value.toolCalls, updatedAt: value.updatedAt,
    ...(shortString(value.delegationId) ? { delegationId: value.delegationId } : {}),
    ...(typeof value.task === "string" ? { task: value.task } : {}),
    ...(typeof value.partial === "boolean" ? { partial: value.partial } : {}),
    ...(shortString(value.terminationReason) ? { terminationReason: value.terminationReason } : {}),
    ...(count(value.contextCompactions) ? { contextCompactions: value.contextCompactions } : {}),
    ...(typeof value.contextDegraded === "boolean" ? { contextDegraded: value.contextDegraded } : {}),
    ...(typeof value.outputTruncated === "boolean" ? { outputTruncated: value.outputTruncated } : {}),
    ...(terminal ? { terminal } : {}),
    ...(observation ? { observation } : {}),
    ...(value.error !== undefined ? { error: restoredError(value.error) } : {}),
  };
}

/** Read only this chain's fixed file, with a descriptor size bound and identity validation. */
export function readSubagentCheckpoint(options: ReadSubagentCheckpointOptions): ReadSubagentCheckpointResult {
  if (!options.scratchDir) return {};
  let descriptor: number | undefined;
  try {
    const file = join(directory(options, false), "checkpoint.json");
    if (lstatSync(file).isSymbolicLink()) fail("checkpoint-unsafe-path");
    descriptor = openSync(file, "r");
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) fail("checkpoint-unreadable");
    if (stat.size > MAX_CHECKPOINT_BYTES) fail("checkpoint-too-large");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!read) break;
      offset += read;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.subarray(0, offset).toString("utf8")); }
    catch { fail("checkpoint-invalid-json"); }
    return { checkpoint: validate(parsed, options) };
  } catch (error) {
    return code(error) === "ENOENT" || code(error) === "ENOTDIR" ? {} : { error: safeError(error) };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
