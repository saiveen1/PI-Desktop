import type { AgentContext, AgentTurnContext } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { resolveAgentOutputGuardSettings, type AgentOutputGuardSettings, type AgentResponseTermination } from "@pi-desktop/shared";
import type { RuntimeHost } from "./host-client.js";
import { CorrectiveBudget } from "./corrective-budget.js";
import { EARLY_END_REMINDER, EARLY_END_SECTION, suspectedEarlyEnd } from "./early-end.js";
import { TextToolCallRecovery } from "./text-tool-call-recovery.js";
import { UnfinishedTodoContinuation } from "./unfinished-todo-continuation.js";

type EarlyEnd = NonNullable<AgentResponseTermination["earlyEnd"]>;

/** Main-turn local correction policy. Settings are captured only at a new user turn. */
export class TurnCorrectionPolicy {
  readonly budget = new CorrectiveBudget();
  readonly todos: UnfinishedTodoContinuation;
  private readonly textCalls = new TextToolCallRecovery(this.budget);
  private nextSettings?: AgentOutputGuardSettings;
  private activeSettings = Object.freeze(resolveAgentOutputGuardSettings(undefined));
  private task = "";
  private hasToolProgress = false;
  private latestBatchUnsafe = false;
  private pendingEarlyEnd = false;
  private generation = 0;

  constructor(host: RuntimeHost, sessionId: string, todosEnabled = true, settings?: AgentOutputGuardSettings) {
    this.todos = new UnfinishedTodoContinuation(host, sessionId, todosEnabled, this.budget);
    this.setSettings(settings);
    this.reset();
  }

  get settings() { return this.activeSettings; }
  get progressSafe(): boolean { return !this.latestBatchUnsafe; }
  get attempts(): number { return this.budget.attempts; }
  get pending(): boolean { return this.pendingEarlyEnd || this.todos.pending || this.textCalls.pending; }

  setSettings(settings?: AgentOutputGuardSettings): void {
    this.nextSettings = settings ? { ...settings } : undefined;
  }

  setTask(task: string, steering = false): void {
    this.task = task;
    if (steering) {
      this.pendingEarlyEnd = false;
      this.todos.cancelPending();
      this.textCalls.cancelPending();
    }
  }

  reset(): void {
    this.generation++;
    this.activeSettings = Object.freeze(resolveAgentOutputGuardSettings(this.nextSettings));
    this.budget.reset(this.settings.recoveryLimit);
    this.todos.reset();
    this.textCalls.reset();
    this.task = "";
    this.hasToolProgress = false;
    this.latestBatchUnsafe = false;
    this.pendingEarlyEnd = false;
  }

  observeTools({ message, toolResults }: AgentTurnContext): void {
    const calls = message.content.filter(block => block.type === "toolCall");
    if (!calls.length && !toolResults.length) return;
    this.latestBatchUnsafe = calls.length !== toolResults.length || calls.some(call =>
      !toolResults.some(result => result.toolCallId === call.id && result.toolName === call.name)) ||
      toolResults.some(result => result.isError !== false || result.toolName === "asktool");
    if (!this.latestBatchUnsafe) this.hasToolProgress = true;
  }

  claimLegacyProgress(): boolean {
    return !this.latestBatchUnsafe && this.budget.claim();
  }

  async finishTurn(
    turn: AgentTurnContext,
    toolNames: ReadonlyMap<string, unknown>,
    canContinue: () => boolean,
    annotate: (state: EarlyEnd, attempts: number) => void,
    signal?: AbortSignal,
    autonomous = false,
  ): Promise<{ action: "continue" | "end" } | undefined> {
    this.observeTools(turn);
    const correction = this.textCalls.finishTurn(turn, toolNames, canContinue(), signal);
    if (correction) return correction;
    const generation = this.generation;
    const todo = await this.todos.finishTurn(turn, canContinue, signal);
    if (todo) return todo;
    const { message } = turn;
    if (generation !== this.generation || signal?.aborted || !canContinue() || autonomous ||
      this.settings.earlyEndMode === "off" || this.latestBatchUnsafe || this.pending ||
      message.stopReason !== "stop" || message.content.some(block => block.type === "toolCall")) return;
    const response = message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
    if (!suspectedEarlyEnd(this.task, response, this.hasToolProgress)) return;
    if (this.settings.earlyEndMode === "warn") {
      annotate("suspected", this.attempts);
      return;
    }
    if (!this.budget.claim()) {
      annotate("exhausted", this.attempts);
      return;
    }
    this.pendingEarlyEnd = true;
    annotate("recovering", this.attempts);
    return { action: "continue" };
  }

  prepareRequest(context: AgentContext): AgentContext {
    const prepared = this.textCalls.prepareRequest(this.todos.prepareRequest(context));
    const reminder = this.pendingEarlyEnd ? EARLY_END_REMINDER : null;
    this.pendingEarlyEnd = false;
    if (!reminder && !getCurrentSystemMessage(prepared.messages)?.sections?.[EARLY_END_SECTION]) return prepared;
    return { ...prepared, messages: [...prepared.messages, {
      role: "system", content: "", sections: { [EARLY_END_SECTION]: reminder }, timestamp: Date.now(),
    }] };
  }
}
