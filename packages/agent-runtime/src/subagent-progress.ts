import type { AgentContext, AgentTool } from "@earendil-works/pi-agent-core";
import { getCurrentTools, getToolStateChanges, Type } from "@earendil-works/pi-ai";
import { isRecord } from "./agent-messages.js";
import { persistSubagentCheckpoint, type SubagentCheckpoint, type PersistSubagentCheckpointResult } from "./subagent-checkpoint.js";
import type { SubagentTerminalDiagnostics } from "./subagent-terminal.js";

export const SUBAGENT_REPORT_TOOL = "TaskReport";
export const SUBAGENT_FINAL_REPORT_PROMPT = "Stop exploration and write a self-contained partial report from the evidence already collected: confirmed findings with file references, completed work, unresolved questions, and the exact next step. No tools are available. Do not claim unfinished work is complete.";

/** Persistence is automatic; an explicit model-authored summary is optional. */
export class SubagentProgress {
  private report = "";
  private latestOutput = "";
  private pending = new Map<string, string>();
  persistence: PersistSubagentCheckpointResult = {};
  /** Reporting diagnostics never determine whether work may continue. */
  error?: { code: string; message: string };
  readonly tool: AgentTool;

  constructor(private readonly options: {
    scratchDir?: string;
    delegateSessionId?: string;
    parentToolCallId: string;
    metadata: () => Pick<SubagentCheckpoint, "agentName" | "modelId" | "thinkingLevel" | "turns" | "toolCalls" | "updatedAt"> & {
      version: 1; sessionId: string; delegateSessionId: string; delegationId: string; task: string;
      contextCompactions: number; contextDegraded: boolean;
    };
    initialReport?: string;
  }) {
    this.report = options.initialReport ?? "";
    this.tool = {
      name: SUBAGENT_REPORT_TOOL, label: "Save task report",
      description: "Optionally save a concise progress summary when useful: findings, evidence, completed work and next steps. The runtime already saves state automatically; this tool is never required to continue working. No path or workspace-writing permission is needed.",
      parameters: Type.Object({ report: Type.String({ minLength: 1, maxLength: 32_000 }) }),
      executionMode: "sequential",
      execute: async (_id, args, signal) => {
        if (signal?.aborted) throw new Error("Task report cancelled");
        if (!isRecord(args) || typeof args.report !== "string" || !args.report.trim() || args.report.length > 32_000) {
          throw new Error("A non-empty progress report of at most 32000 characters is required");
        }
        this.report = args.report.trim();
        const saved = this.save("running", this.report);
        this.error = saved.error ? { code: "SUBAGENT_CHECKPOINT_FAILED", message: saved.error } : undefined;
        return {
          content: [{ type: "text", text: saved.error
            ? `Progress report retained in the delegation transcript. Local checkpoint write failed (${saved.error}); continue the task without retrying this optional report solely for that reason.`
            : saved.checkpointPath ? `Progress report saved to ${saved.checkpointPath}`
              : "Progress report recorded in the delegation transcript; no local scratch directory is available." }],
          details: { ...saved, report: this.report },
        };
      },
    };
  }

  prepareRequest(context: AgentContext, finalizing: boolean): AgentContext {
    if (!finalizing) return context;
    const changes = getToolStateChanges(getCurrentTools(context.messages), []);
    return {
      ...context, tools: [],
      messages: [...context.messages, { role: "system", content: "", ...changes,
        sections: { subagent_final_report: SUBAGENT_FINAL_REPORT_PROMPT }, timestamp: Date.now() }],
    };
  }

  recordContextSummary(summary: string): void {
    if (summary.trim()) this.report = `Context checkpoint summary (partial):
${summary.trim()}`;
  }

  started(id: string, name: string): void { this.pending.set(id, name); }
  ended(id: string): void { this.pending.delete(id); }

  partialText(output: string): string {
    if (output.trim()) this.latestOutput = output;
    const lastOutput = output || this.latestOutput;
    if (!this.report && !lastOutput && this.pending.size === 0) return "No findings have been reported yet. Inspect the retained tool history before continuing; the task is incomplete.";
    return [this.report || (lastOutput
      ? "No separate findings summary was saved. The retained assistant output below is partial progress, not a final deliverable."
      : "No findings have been reported yet."),
      lastOutput !== this.report ? lastOutput : "", this.pending.size
      ? `Interrupted or pending tools (their effects may need verification): ${[...this.pending.values()].join(", ")}.`
      : ""].filter(Boolean).join("\n\n") || "No findings have been reported yet. Inspect the retained tool history before continuing; the task is incomplete.";
  }

  save(status: SubagentCheckpoint["status"], report: string, error?: { code: string; message: string }, terminal?: SubagentTerminalDiagnostics): PersistSubagentCheckpointResult {
    this.persistence = persistSubagentCheckpoint({
      ...this.options,
      checkpoint: {
        ...this.options.metadata(), status, report, partial: status !== "completed",
        terminationReason: error?.code === "SUBAGENT_BUDGET_EXHAUSTED" ? "budget_exhausted" : status,
        ...(error ? { error } : {}),
        ...(terminal ? { terminal } : {}),
      },
    });
    return this.persistence;
  }
}
