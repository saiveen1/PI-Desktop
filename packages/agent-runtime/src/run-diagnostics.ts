import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { AgentResponseTermination, AgentRunDiagnostics } from "@pi-desktop/shared";
import type { RunDiagnosticsProviderEvent } from "./run-diagnostics-tracker.js";

export function normalizedStopReason(value: unknown): AgentResponseTermination["stopReason"] {
  switch (value) {
    case "stop": case "length": case "toolUse": case "aborted": case "error": return value;
    default: return "unknown";
  }
}

/** A reused turn snapshot must never annotate an earlier or future bubble. */
export function diagnosticsForMessage(diagnostics: AgentRunDiagnostics, messageId: string): AgentRunDiagnostics {
  if (!diagnostics.termination || diagnostics.termination.messageId === messageId) return diagnostics;
  const { termination: _termination, ...rest } = diagnostics;
  return rest;
}

export function runDiagnosticsProviderEvent(event: AssistantMessageEvent): RunDiagnosticsProviderEvent {
  switch (event.type) {
    case "thinking_start": case "thinking_delta": case "thinking_end": return { kind: "thinking" };
    case "text_start": case "text_end": return { kind: "text" };
    case "text_delta": return { kind: "text", hasNewText: event.delta.length > 0 };
    case "hosted_search_update": return { kind: "search" };
    case "toolcall_start": case "toolcall_delta": case "toolcall_end": return { kind: "tool" };
    default: return { kind: "other" };
  }
}
