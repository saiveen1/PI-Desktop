import { createHash } from "node:crypto";
import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { SubagentApprovalObservation, SubagentModelAttempt, SubagentObservation, SubagentToolEvidence } from "@pi-desktop/shared";
import { isRecord, usageFromPi } from "./agent-messages.js";
import { classifyAgentError } from "./agent-errors.js";
import { classifyProviderError } from "./provider-retry.js";

/** A diagnostic observation window, never an execution or tool deadline. */
export const SUBAGENT_DIAGNOSTIC_INTERVAL_MS = 30_000;
const READ_ONLY = new Set(["Read", "Grep", "Glob"]);
const FILE_TOOLS = new Set([...READ_ONLY, "Write", "Edit"]);
const limited = (value: string, max = 512) => value.slice(0, max);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Local signal observer. No model calls, termination decisions, or executable replay state. */
export class SubagentObserver {
  private readonly createdAt = Date.now();
  private readonly state: SubagentObservation;
  private readonly pending = new Map<string, SubagentToolEvidence>();
  private readonly evidence = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(model: string, private readonly changed: () => void,
    private readonly builtinTools: ReadonlySet<string> = new Set()) {
    this.state = { version: 1, selectedModel: model, phase: "preparing", lastActivityAt: this.createdAt,
      diagnostic: { state: "observing", observedAt: this.createdAt, thresholdMs: SUBAGENT_DIAGNOSTIC_INTERVAL_MS,
        reason: "Observing runtime signals; activity alone does not establish task progress." },
      attemptCount: 0, attemptsOmitted: 0, attempts: [], approvalsOmitted: 0, approvals: [],
      completedToolCalls: 0, failedToolCalls: 0, pendingTools: [], pendingToolsOmitted: 0, recentTools: [],
      confirmedWritePaths: [], confirmedWritePathsOmitted: 0 };
  }

  start(): void {
    this.timer = setInterval(() => this.changed(), SUBAGENT_DIAGNOSTIC_INTERVAL_MS);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  activity(): void { if (!this.closed) this.state.lastActivityAt = Date.now(); }
  meaningful(): void { this.activity(); this.state.lastMeaningfulProgressAt = Date.now(); }
  phase(phase: SubagentObservation["phase"]): void { this.state.phase = phase; this.activity(); this.changed(); }
  selected(model: string): void { this.state.selectedModel = model; this.changed(); }
  approval(model: string, status: SubagentApprovalObservation["status"]): void {
    this.state.approvals.push({ model: limited(model), status, at: Date.now() });
    if (this.state.approvals.length > 64) { this.state.approvals.shift(); this.state.approvalsOmitted++; }
    this.phase(status === "pending" ? "approval" : "preparing");
  }

  observeStream(model: string, createStream: () => AssistantMessageEventStream): AssistantMessageEventStream {
    const startedAt = Date.now();
    const clock = performance.now();
    const attempt: SubagentModelAttempt = { sequence: ++this.state.attemptCount, model: limited(model), startedAt, outcome: "running" };
    this.state.executionStartedAt ??= startedAt;
    this.state.selectedModel = model;
    this.state.attempts.push(attempt);
    if (this.state.attempts.length > 64) { this.state.attempts.shift(); this.state.attemptsOmitted++; }
    this.phase("model");
    const finish = (message?: AssistantMessage, error?: unknown) => {
      if (this.closed || attempt.outcome !== "running") return;
      attempt.finishedAt = Math.max(startedAt, Date.now());
      attempt.providerDurationMs = Math.max(0, performance.now() - clock);
      attempt.outcome = message?.stopReason === "aborted" ? "aborted" : error || message?.stopReason === "error" ? "failed" : "completed";
      if (error || message?.stopReason === "error") {
        const classified = message ? classifyProviderError(message) : classifyAgentError(error);
        if (classified.code === "TURN_ABORTED") attempt.outcome = "aborted";
        else attempt.error = { code: limited(classified.code, 200), message: limited(classified.message || "Request failed", 2000) };
      }
      const usage = message && usageFromPi(message.usage);
      if (usage) attempt.usage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens };
      this.state.phase = this.pending.size ? "tool" : "preparing";
      this.activity();
      this.changed();
    };
    let stream: AssistantMessageEventStream;
    try { stream = createStream(); } catch (error) { finish(undefined, error); throw error; }
    const observer = this;
    return new Proxy(stream, {
      get(target, property, receiver) {
        if (property === "result") return async () => {
          try { const message = await target.result(); finish(message); return message; }
          catch (error) { finish(undefined, error); throw error; }
        };
        if (property === Symbol.asyncIterator) return async function* () {
          try {
            for await (const event of target) {
              observer.activity();
              if (event.type === "done") finish(event.message);
              if (event.type === "error") finish(event.error);
              yield event;
            }
          } catch (error) { finish(undefined, error); throw error; }
        };
        return Reflect.get(target, property, receiver);
      },
    });
  }

  toolStarted(id: string, name: string, args: unknown): void {
    // Only file-tool path aliases are retained; never commands, write contents, or arbitrary arguments.
    const candidate = this.builtinTools.has(name) && FILE_TOOLS.has(name) && isRecord(args) ? args.path || args.file_path : undefined;
    const path = typeof candidate === "string" && candidate.length > 0 && candidate.length <= 1000 ? candidate : undefined;
    this.pending.set(id, { toolCallId: limited(id), toolName: limited(name, 200), startedAt: Date.now(),
      outcome: "pending", effects: "unknown", ...(path ? { path } : {}) });
    this.phase("tool");
  }

  toolEnded(id: string, result: unknown, failed: boolean): void {
    const started = this.pending.get(id);
    this.pending.delete(id);
    if (!started) return;
    const details = isRecord(result) && isRecord(result.details) ? result.details : undefined;
    const text = isRecord(result) && Array.isArray(result.content) ? result.content.flatMap(part =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n") : "";
    const builtin = this.builtinTools.has(started.toolName);
    const write = builtin && !failed && (started.toolName === "Write" || started.toolName === "Edit") && started.path;
    const evidence: SubagentToolEvidence = { ...started, finishedAt: Date.now(), outcome: failed ? "failed" : "completed",
      effects: write ? "write_confirmed" : builtin && READ_ONLY.has(started.toolName) ? "read_only" : "unknown",
      ...(text ? { outputChars: text.length } : {}), ...(count(details?.totalLines) ? { totalLines: details.totalLines } : {}) };
    this.state.recentTools.push(evidence);
    if (this.state.recentTools.length > 12) this.state.recentTools.shift();
    if (failed) this.state.failedToolCalls++; else this.state.completedToolCalls++;
    if (write) {
      if (!this.state.confirmedWritePaths.includes(write)) {
        this.state.confirmedWritePaths.push(write);
        if (this.state.confirmedWritePaths.length > 32) { this.state.confirmedWritePaths.shift(); this.state.confirmedWritePathsOmitted++; }
      }
      this.meaningful();
    } else if (!failed && (builtin && READ_ONLY.has(started.toolName) || started.toolName === "TaskReport")) {
      const returnedEvidence = started.toolName === "TaskReport" && typeof details?.report === "string" ? details.report : text;
      // Hash returned evidence, not call identity/count. Repeating an identical read is only activity.
      const key = returnedEvidence ? createHash("sha256").update(`${started.toolName}\0${started.path ?? ""}\0${returnedEvidence}`).digest("hex") : "";
      if (key && !this.evidence.has(key)) {
        this.evidence.add(key);
        const oldest = this.evidence.values().next().value;
        if (this.evidence.size > 256 && oldest) this.evidence.delete(oldest);
        this.meaningful();
      }
    }
    this.phase(this.pending.size ? "tool" : "preparing");
  }

  end(produced: boolean): void {
    this.stop();
    this.closed = true;
    this.state.executionEndedAt = Date.now();
    this.state.lastActivityAt = this.state.executionEndedAt;
    // A local abort can retire the loop before a provider reports settlement.
    // No provider finish time or duration is invented for such attempts.
    for (const attempt of this.state.attempts) if (attempt.outcome === "running") attempt.outcome = "unresolved";
    if (produced) { this.state.reportProducedAt = Date.now(); this.meaningful(); }
    this.phase("ended");
  }

  snapshot(): SubagentObservation {
    const now = Date.now();
    const quiet = now - (this.state.lastMeaningfulProgressAt ?? this.createdAt) >= SUBAGENT_DIAGNOSTIC_INTERVAL_MS;
    const pending = [...this.pending.values()];
    const phase = this.state.phase;
    const state = phase === "ended" ? "ended" : phase === "approval" ? "approval_pending"
      : !quiet ? "observing" : pending.length ? "waiting_tool" : phase === "model" ? "waiting_model" : "no_new_evidence";
    const reason = state === "ended" ? "Execution ended; report production and parent delivery are recorded separately."
      : state === "approval_pending" ? "Waiting for model authorization; acceptance is not execution start."
      : state === "waiting_tool" ? "No new confirmed evidence in 30000 ms; tool outcome/effects remain pending. A quiet tool may be valid; no automatic abort or replay."
      : state === "waiting_model" ? "No new confirmed evidence in 30000 ms; model request remains active. Stream activity is not task progress; no automatic retry."
      : state === "no_new_evidence" ? "No new confirmed evidence in 30000 ms. Inspect retained evidence; repeated activity alone does not establish progress."
      : "Observing runtime signals; new evidence is not proof of semantic task completion.";
    return structuredClone({ ...this.state, pendingTools: pending.slice(0, 16), pendingToolsOmitted: Math.max(0, pending.length - 16),
      diagnostic: { state, observedAt: this.state.executionEndedAt ?? now, thresholdMs: SUBAGENT_DIAGNOSTIC_INTERVAL_MS, reason } });
  }
}

/** A bounded, non-executable handoff; full details remain in the tool transcript. */
export function subagentEvidenceHandoff(observation: SubagentObservation): string {
  const describe = (item: SubagentToolEvidence) => `${item.toolName} ${item.path ?? ""} [${item.toolCallId}]: ${item.outcome}, effects=${item.effects}${item.totalLines !== undefined ? `, totalLines=${item.totalLines}` : ""}${item.outputChars !== undefined ? `, outputChars=${item.outputChars}` : ""}`;
  const lines = (items: string[], omitted = 0) => {
    const kept: string[] = [];
    let length = 0;
    for (const item of items) { if (length + item.length > 2800) break; kept.push(item); length += item.length + 1; }
    const remaining = items.length - kept.length + omitted;
    return [...kept, ...(remaining ? [`+${remaining} omitted; inspect the checkpoint/tool transcript`] : [])].join("\n");
  };
  return [
    observation.recentTools.length || observation.pendingTools.length ? "Do not replay completed writes or assume failed/pending operations had no effects. Verify unknown outcomes before any authorized continuation." : "",
    observation.pendingTools.length ? `Pending tools; effects unknown and require verification:\n${lines(observation.pendingTools.map(describe), observation.pendingToolsOmitted)}` : "",
    observation.confirmedWritePaths.length ? `Confirmed successful file writes (do not replay):\n${lines(observation.confirmedWritePaths, observation.confirmedWritePathsOmitted)}` : "",
    observation.recentTools.length ? `Recent tool evidence (bounded; inspect original tool rows for full results):\n${lines(observation.recentTools.map(describe))}` : "",
  ].filter(Boolean).join("\n\n");
}
