import { assistantContent } from "./agent-messages.js";

export const PROGRESS_TURN_NUDGE = [
  "<progress_only_recovery>",
  "Your last message announced next steps but contained no tool call, so the autonomous run would have stopped mid-task.",
  "Continue the approved plan now: either call the tools for the work you just described, or write the final self-contained completion report.",
  "Do not announce intent without a tool call in the same message.",
  "</progress_only_recovery>",
].join("\n");

const FORWARD_INTENT = [
  /\b(?:about to|going to|will|next|then|still(?: need| have to)?|remaining|left to|working on|writing|reading|updating|implementing|checking|running|creating|fixing|reviewing|proceed(?:ing)?|continu(?:e|ing)|starting|moving on)\b/i,
  /(?:接下来|下一步|还需要|仍需|剩下|正在|将要|继续|开始)/i,
];
const TERMINAL_LEAD = /^(?:done|all done|complete(?:d)?|finished|implemented|resolved|verified|successful(?:ly)?|the (?:approved )?(?:plan|goal) is complete)\b/i;

/** Existing approved-execution heuristic; ordinary tasks use the stricter early-end policy. */
export function isProgressOnlyAssistantTurn(message: unknown): boolean {
  if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return false;
  const content = "content" in message ? message.content : undefined;
  if (Array.isArray(content) && content.some(part => part?.type === "toolCall")) return false;
  const text = assistantContent(content).text.trim();
  const forward = (value: string) => FORWARD_INTENT.some(pattern => pattern.test(value));
  if (!text || !forward(text)) return false;
  return !TERMINAL_LEAD.test(text) || forward(text.replace(TERMINAL_LEAD, ""));
}
