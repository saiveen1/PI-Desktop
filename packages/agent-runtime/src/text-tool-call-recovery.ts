import type { AgentContext, AgentTurnContext } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { textToolCallDiagnostic } from "./text-tool-call.js";

const SECTION = "text_tool_call_recovery";
const REMINDER = [
  "<text_tool_call_recovery>",
  "Your last reply contained tool-call markup as ordinary text, not an executable structured tool call. Nothing was executed from that text.",
  "Continue the existing task within its original scope and permissions. Preserve completed tool results and do not repeat successful actions. Inspect uncertain effects before retrying any action.",
  "If an action is still needed, emit a valid structured tool call using the available tools; do not print tool protocol markup or guess missing arguments. Discover on-demand tools with ToolSearch when needed.",
  "If the task is complete, blocked, or needs user input, report that accurately instead. This is the only automatic text-call correction for this user turn, not a new user request.",
  "</text_tool_call_recovery>",
].join("\n");

/** Recover protocol leakage, not semantic incompleteness, inside the existing loop. */
export class TextToolCallRecovery {
  private attempted = false;
  private pendingReminder = false;

  get pending(): boolean { return this.pendingReminder; }

  reset(): void {
    this.attempted = false;
    this.pendingReminder = false;
  }

  finishTurn(
    { message }: AgentTurnContext,
    toolNames: ReadonlyMap<string, unknown>,
    canContinue: boolean,
    signal?: AbortSignal,
  ): { action: "continue" | "end" } | undefined {
    if (signal?.aborted || !canContinue || message.stopReason !== "stop" ||
      message.content.some((block) => block.type === "toolCall")) return;
    const text = message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
    if (!textToolCallDiagnostic(text, toolNames)) return;
    // Do not let an unfinished checklist add another nudge to the same failure.
    if (this.attempted) return { action: "end" };
    this.attempted = true;
    this.pendingReminder = true;
    return { action: "continue" };
  }

  prepareRequest(context: AgentContext): AgentContext {
    const reminder = this.pendingReminder ? REMINDER : null;
    this.pendingReminder = false;
    if (!reminder && !getCurrentSystemMessage(context.messages)?.sections?.[SECTION]) return context;
    return {
      ...context,
      messages: [...context.messages, {
        role: "system", content: "", sections: { [SECTION]: reminder }, timestamp: Date.now(),
      }],
    };
  }
}
