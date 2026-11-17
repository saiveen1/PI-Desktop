import type { Context, Model } from "@earendil-works/pi-ai";

export const responsesModel: Model<"openai-responses"> = {
  id: "terminal-content-fixture", name: "Terminal content fixture",
  api: "openai-responses", provider: "fixture", baseUrl: "https://fixture.invalid/v1",
  reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
export const responsesContext: Context = {
  messages: [{ role: "user", content: "Run the requested check.", timestamp: 1 }],
};
export const reasoning = "Check the fixture before reporting the result.";
export const answer = "The requested check completed with the expected result.";
export const dsmlTail = [
  '<｜DSML｜ parameter name="timeout" string="false">200</｜DSML｜ parameter>',
  "</｜DSML｜ invoke>", "</｜DSML｜ calls>",
].join("\n");
export type WireEvent = { type: string } & Record<string, unknown>;
export type MessagePart = { type: "output_text"; text: string } | { type: "refusal"; refusal: string };

export function messageFrames(index: number, text: string, content?: MessagePart[]): WireEvent[] {
  const item = { id: `msg_${index}`, type: "message", role: "assistant" };
  return [
    { type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", output_index: index, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: index,
      item: { ...item, status: "completed", ...(content === undefined ? {} : { content }) } },
  ];
}

export function reasoningFrames(index: number, text: string, summary?: string, content?: string): WireEvent[] {
  const item = { id: `rs_${index}`, type: "reasoning" };
  return [
    { type: "response.output_item.added", output_index: index, item: { ...item, summary: [] } },
    { type: "response.reasoning_summary_text.delta", output_index: index, summary_index: 0, delta: text },
    { type: "response.output_item.done", output_index: index, item: {
      ...item, status: "completed",
      ...(summary === undefined ? {} : { summary: [{ type: "summary_text", text: summary }] }),
      ...(content === undefined ? {} : { content: [{ type: "reasoning_text", text: content }] }),
    } },
  ];
}

export function toolFrames(index: number): WireEvent[] {
  const item = { id: "fc_check", call_id: "call_check", type: "function_call", name: "Bash" };
  const args = JSON.stringify({ command: "printf checked" });
  return [
    { type: "response.output_item.added", output_index: index, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: index, delta: args },
    { type: "response.output_item.done", output_index: index, item: { ...item, arguments: args, status: "completed" } },
  ];
}

export function responseBody(frames: WireEvent[], terminal: Record<string, unknown> = {}): string {
  return [
    { type: "response.created", response: { id: "resp_fixture" } },
    ...frames,
    { type: "response.completed", response: {
      id: "resp_fixture", status: "completed", model: responsesModel.id,
      output: frames.filter((frame) => frame.type === "response.output_item.done").map((frame) => frame.item),
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15,
        input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 2 } },
      ...terminal,
    } },
  ].map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");
}
