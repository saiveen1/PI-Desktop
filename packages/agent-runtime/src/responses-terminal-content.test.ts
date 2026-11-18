import { describe, expect, it } from "vitest";
import { normalizeContext, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import { textToolCallDiagnostic } from "./text-tool-call.js";
import {
  answer, dsmlTail, messageFrames, reasoning, reasoningFrames, responseBody,
  responsesContext, responsesModel, toolFrames, type WireEvent,
} from "./test-support/responses-terminal-fixture.js";

async function decode(frames: WireEvent[], terminal?: Record<string, unknown>) {
  const fetchFixture = async () => new Response(responseBody(frames, terminal), {
    headers: { "content-type": "text/event-stream" },
  });
  const events = stream(responsesModel, normalizeContext(responsesContext), { apiKey: "fixture", fetch: fetchFixture });
  const seen: AssistantMessageEvent[] = [];
  for await (const event of events) seen.push(structuredClone(event));
  return { seen, result: await events.result() };
}

function textOf(result: Awaited<ReturnType<typeof decode>>["result"]) {
  return result.content.filter((block) => block.type === "text").map((block) => block.text);
}

function thinkingOf(result: Awaited<ReturnType<typeof decode>>["result"]) {
  return result.content.filter((block) => block.type === "thinking").map((block) => block.thinking);
}

describe("Responses terminal content preservation", () => {
  it.each([undefined, "", " ", "\n\t", "\u200b", " \u200b\u200c\u200d\u2060\ufeff"])("retains streamed thinking with blank final summary %j", async (summary) => {
    const frames = reasoningFrames(0, reasoning, summary);
    const { seen, result } = await decode(frames);
    expect(seen).toContainEqual(expect.objectContaining({ type: "thinking_delta", delta: reasoning }));
    expect(seen).toContainEqual(expect.objectContaining({ type: "thinking_end", content: reasoning }));
    expect(thinkingOf(result)).toEqual([reasoning]);
    const block = result.content.find((value) => value.type === "thinking");
    expect(JSON.parse(block?.thinkingSignature ?? "null")).toEqual(frames.at(-1)?.item);
    expect(result.stopReason).toBe("stop");
    expect(result.usage).toMatchObject({ input: 8, cacheRead: 2, output: 5, reasoning: 2, totalTokens: 15 });
  });

  it("uses meaningful final reasoning content when the summary is whitespace", async () => {
    const { result } = await decode(reasoningFrames(0, reasoning, " ", "Corrected reasoning."));
    expect(thinkingOf(result)).toEqual(["Corrected reasoning."]);
  });

  it.each([
    { label: "omitted", content: undefined },
    { label: "empty parts", content: [] },
    { label: "empty text", content: [{ type: "output_text" as const, text: "" }] },
    { label: "whitespace", content: [{ type: "output_text" as const, text: " \n" }] },
  ])(
    "retains streamed answer with empty terminal content: $label", async ({ content }) => {
      const { seen, result } = await decode(messageFrames(0, answer, content));
      expect(seen).toContainEqual(expect.objectContaining({ type: "text_delta", delta: answer }));
      expect(seen).toContainEqual(expect.objectContaining({ type: "text_end", content: answer }));
      expect(textOf(result)).toEqual([answer]);
      expect(result.content[0]).toMatchObject({ textSignature: expect.any(String) });
    },
  );

  it.each([dsmlTail, "</｜DSML｜ invoke>\n</｜DSML｜ calls>", "</｜DSML｜ calls>"])(
    "retains the full streamed answer when the terminal item repeats only its DSML tail: %s", async (tail) => {
      const text = `${answer}\n${dsmlTail}`;
      const { seen, result } = await decode([
        ...reasoningFrames(0, reasoning, " "),
        ...messageFrames(1, text, [{ type: "output_text", text: tail }]),
        ...toolFrames(2),
      ]);
      expect(textOf(result)).toEqual([text]);
      expect(thinkingOf(result)).toEqual([reasoning]);
      expect(seen).toContainEqual(expect.objectContaining({ type: "text_end", content: text }));
      expect(textToolCallDiagnostic(textOf(result).join(""), new Map())).toMatchObject({ code: "TOOL_CALL_NOT_EXECUTED" });
      expect(result.content.filter((block) => block.type === "toolCall")).toEqual([
        expect.objectContaining({ id: "call_check|fc_check", name: "Bash", arguments: { command: "printf checked" } }),
      ]);
      expect(result.stopReason).toBe("toolUse");
    },
  );

  it.each(["Done.", "expected result.", "A corrected result, rather than the streamed draft."])(
    "accepts a nonempty final revision instead of choosing the longest string: %s", async (text) => {
      const { result } = await decode([
        ...reasoningFrames(0, reasoning, "Checked."),
        ...messageFrames(1, answer, [{ type: "output_text", text }]),
      ]);
      expect(textOf(result)).toEqual([text]);
      expect(thinkingOf(result)).toEqual(["Checked."]);
    },
  );

  it.each(["Cannot perform that request.", ""])("keeps explicit refusal authoritative: %j", async (refusal) => {
    const { result } = await decode(messageFrames(0, answer, [{ type: "refusal", refusal }]));
    expect(textOf(result)).toEqual([refusal]);
  });

  it.each([
    dsmlTail.replace("200", "300"),
    `<｜DSML｜ calls>\n<｜DSML｜ invoke name="Bash">\n${dsmlTail}`,
  ])("does not invent a missing prefix for an unrelated or complete final call envelope", async (text) => {
    const { result } = await decode(messageFrames(0, `${answer}\n${dsmlTail}`, [{ type: "output_text", text }]));
    expect(textOf(result)).toEqual([text]);
  });

  it("keeps output items isolated and does not invent content for an empty stream", async () => {
    const { result } = await decode([
      ...messageFrames(0, answer, []),
      ...messageFrames(1, "", []),
      ...messageFrames(2, "Another item.", [{ type: "output_text", text: "Final item." }]),
      ...reasoningFrames(3, "", ""),
    ]);
    expect(textOf(result)).toEqual([answer, "", "Final item."]);
    expect(thinkingOf(result)).toEqual([""]);
  });

  it.each([
    ["max_output_tokens", "length"], ["content_filter", "error"],
  ])("preserves incomplete response semantics: %s", async (reason, stopReason) => {
    const { result } = await decode(messageFrames(0, answer, []), {
      status: "incomplete", incomplete_details: { reason },
    });
    expect(result.stopReason).toBe(stopReason);
    expect(result.rawStopReason).toBe(`incomplete.${reason}`);
    expect(textOf(result)).toEqual([answer]);
  });
});
