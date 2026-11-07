import type { AssistantMessage } from "@earendil-works/pi-ai";
import { assistantContent } from "./agent-messages.js";

export type SubagentRawStopReason = "stop" | "toolUse" | "tool_calls" | "length" | "max_tokens" | "error" | "aborted";
export type SubagentReportOutcome = "delivered" | "missing" | "truncated" | "invalid_tool_ending" | "error" | "cancelled";

/** Structural delivery diagnostics, never provider text or reasoning. */
export type SubagentTerminalDiagnostics = {
  stopReason: "stop" | "tool_calls" | "length" | "error" | "aborted" | "unknown";
  rawStopReason?: SubagentRawStopReason;
  textBlocks: number;
  thinkingBlocks: number;
  toolCalls: number;
  reportOutcome: SubagentReportOutcome;
  reportRecoveryAttempt: number;
  providerRetries?: number;
};

export type SubagentTerminalResponse = Omit<SubagentTerminalDiagnostics, "reportOutcome" | "reportRecoveryAttempt" | "providerRetries"> & {
  text: string;
};

function knownStopReason(value: string | undefined): SubagentRawStopReason | undefined {
  switch (value) {
    case "stop": case "toolUse": case "tool_calls": case "length":
    case "max_tokens": case "error": case "aborted":
      return value;
    default:
      return undefined;
  }
}

export function readSubagentTerminalResponse(message: AssistantMessage): SubagentTerminalResponse {
  const rawStopReason = knownStopReason(message.stopReason);
  return {
    stopReason: rawStopReason === "toolUse" || rawStopReason === "tool_calls" ? "tool_calls"
      : rawStopReason === "length" || rawStopReason === "max_tokens" ? "length"
        : rawStopReason ?? "unknown",
    ...(rawStopReason ? { rawStopReason } : {}),
    text: assistantContent(message.content).text,
    textBlocks: message.content.filter(part => part.type === "text").length,
    thinkingBlocks: message.content.filter(part => part.type === "thinking").length,
    toolCalls: message.content.filter(part => part.type === "toolCall").length,
  };
}

export function subagentReportOutcome(response?: SubagentTerminalResponse): SubagentReportOutcome {
  if (response?.stopReason === "error") return "error";
  if (response?.stopReason === "aborted") return "cancelled";
  if (response?.stopReason === "length") return "truncated";
  if (response?.stopReason === "tool_calls" || (response?.toolCalls ?? 0) > 0) return "invalid_tool_ending";
  return response?.stopReason === "stop" && response.text.trim() ? "delivered" : "missing";
}

/** Restore only bounded scalar diagnostics, never arbitrary provider payloads. */
export function parseSubagentTerminalDiagnostics(value: unknown): SubagentTerminalDiagnostics | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const stopReasons: readonly SubagentTerminalDiagnostics["stopReason"][] = ["stop", "tool_calls", "length", "error", "aborted", "unknown"];
  const outcomes: readonly SubagentReportOutcome[] = ["delivered", "missing", "truncated", "invalid_tool_ending", "error", "cancelled"];
  if (!stopReasons.some(reason => reason === row.stopReason) || !outcomes.some(outcome => outcome === row.reportOutcome)) return undefined;
  const count = (number: unknown): number is number => typeof number === "number" && Number.isSafeInteger(number) && number >= 0;
  if (!count(row.textBlocks) || !count(row.thinkingBlocks) || !count(row.toolCalls) ||
      !count(row.reportRecoveryAttempt) || row.reportRecoveryAttempt > 1) return undefined;
  if (row.providerRetries !== undefined && !count(row.providerRetries)) return undefined;
  const rawStopReason = typeof row.rawStopReason === "string" ? knownStopReason(row.rawStopReason) : undefined;
  return {
    stopReason: row.stopReason as SubagentTerminalDiagnostics["stopReason"],
    reportOutcome: row.reportOutcome as SubagentReportOutcome,
    textBlocks: row.textBlocks, thinkingBlocks: row.thinkingBlocks, toolCalls: row.toolCalls,
    reportRecoveryAttempt: row.reportRecoveryAttempt,
    ...(count(row.providerRetries) ? { providerRetries: row.providerRetries } : {}),
    ...(rawStopReason ? { rawStopReason } : {}),
  };
}
