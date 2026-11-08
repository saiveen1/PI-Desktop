import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { UiMessage } from "@pi-desktop/shared";

/** User input is queued on the existing Agent; its tools are never force-aborted. */
export class SubagentConversation {
  private readonly pending = new Set<AgentMessage>();
  private closed = false;

  constructor(private readonly agent: Agent, private readonly publish: (message: UiMessage) => void) {}

  get hasPending(): boolean { return this.pending.size > 0; }

  send(message: UiMessage): boolean {
    if (this.closed) return false;
    const input: AgentMessage = { role: "user", content: message.content, timestamp: Date.now() };
    this.pending.add(input);
    this.agent.steer(input);
    this.publish(message);
    return true;
  }

  consumed(message: AgentMessage): void { this.pending.delete(message); }

  close(): void {
    this.closed = true;
    this.pending.clear();
  }
}
