import type { AgentContext, AgentTurnContext } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { SessionTodoSnapshot } from "@pi-desktop/shared";
import type { RuntimeHost } from "./host-client.js";

const REMINDER_SECTION = "unfinished_todo_recovery";
const REMINDER = [
  "<unfinished_todo_recovery>",
  "Your last response ended while the checklist you updated during this task still has pending or in-progress items.",
  "Continue the user's existing task now, within its original scope and permissions. Use tools to advance the unfinished work and keep TodoWrite accurate.",
  "Do not mark unfinished work completed just to end the turn. If you need user input, ask for it with asktool; if blocked, explain the concrete blocker and leave the checklist truthful.",
  "This is a single automatic continuation for this user turn, not a new user request.",
  "</unfinished_todo_recovery>",
].join("\n");

/** One bounded continuation, based on current-turn writes and Host-owned state. */
export class UnfinishedTodoContinuation {
  private wroteChecklist = false;
  private attempted = false;
  private lastToolBatchFailed = false;
  private pendingReminder = false;
  private generation = 0;

  constructor(
    private readonly host: RuntimeHost,
    private readonly sessionId: string,
    private enabled = true,
  ) {}

  get pending(): boolean {
    return this.pendingReminder;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  reset(): void {
    this.generation++;
    this.wroteChecklist = false;
    this.attempted = false;
    this.lastToolBatchFailed = false;
    this.pendingReminder = false;
  }

  async finishTurn(
    { message, toolResults }: AgentTurnContext,
    canContinue: () => boolean,
    signal?: AbortSignal,
  ): Promise<{ action: "continue" } | undefined> {
    if (toolResults.length) {
      this.lastToolBatchFailed = toolResults.some((result) => result.isError);
      if (toolResults.some((result) => result.toolName === "TodoWrite" && !result.isError)) {
        this.wroteChecklist = true;
      }
    }
    if (!this.enabled || this.attempted || !this.wroteChecklist || this.lastToolBatchFailed ||
      signal?.aborted || !canContinue() || message.stopReason !== "stop" ||
      message.content.some((block) => block.type === "toolCall") ||
      !message.content.some((block) => block.type === "text" && block.text.trim())) return;

    const generation = this.generation;
    let snapshot: SessionTodoSnapshot;
    try {
      snapshot = await this.host.call<SessionTodoSnapshot>("todos.get", { sessionId: this.sessionId });
    } catch {
      // Checklist lookup is optional; a failed read must not turn a valid reply into an error.
      console.error(`[runtime] unfinished checklist continuation skipped: todos.get failed (session=${this.sessionId})`);
      return;
    }
    if (generation !== this.generation || signal?.aborted || !this.enabled || !canContinue()) return;
    if (snapshot?.sessionId !== this.sessionId || !Array.isArray(snapshot.todos) ||
      !snapshot.todos.some((todo) => todo.status === "pending" || todo.status === "in_progress")) return;

    this.attempted = true;
    this.pendingReminder = true;
    return { action: "continue" };
  }

  prepareRequest(context: AgentContext): AgentContext {
    const reminder = this.pendingReminder ? REMINDER : null;
    this.pendingReminder = false;
    // Replaceable sections expire on the following request, including a later user prompt.
    if (!reminder && !getCurrentSystemMessage(context.messages)?.sections?.[REMINDER_SECTION]) return context;
    return {
      ...context,
      messages: [...context.messages, {
        role: "system", content: "", sections: { [REMINDER_SECTION]: reminder }, timestamp: Date.now(),
      }],
    };
  }
}
