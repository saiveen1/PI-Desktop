import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { buildProviderModel } from "./provider-binding.js";
import { withModelOutputGuard } from "./model-output-guard.js";
import { readOutputRepetition, RepetitiveOutputDetector } from "./model-output-repetition.js";

const paragraph = "I will inspect the latest execution result before attempting the next change. The existing evidence must be checked carefully, and completed operations must not be repeated without verifying their effects.";
const repeated = (count: number, text = paragraph) => (text + "\n\n").repeat(count);
const low = { repeatedParagraphMinChars: 256, repeatedParagraphMinRepeats: 3 };
const model = buildProviderModel({ id: "fixture", name: "Fixture", modelId: "fixture", baseUrl: "http://provider.invalid/v1", apiKey: "fixture", supportsReasoning: false, supportedThinkingLevels: ["off"] });
function message(source: string, thinking = false): AssistantMessage {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: thinking ? [{ type: "thinking", thinking: source }] : [{ type: "text", text: source }],
    stopReason: "stop", timestamp: 1,
    usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

describe("repeated narrative paragraphs", () => {
  it("detects a sustained exact prose loop that contains meaningful letters", () => {
    expect(new RepetitiveOutputDetector().push(repeated(10))).toMatchObject({ repetitionKind: "paragraph" });
  });

  it.each([1, 7, 103, 4096])("handles arbitrary chunks of %s characters and CRLF", (size) => {
    const source = repeated(10).replace(/\n/g, "\r\n");
    const detector = new RepetitiveOutputDetector();
    let detected;
    for (let i = 0; i < source.length && !detected; i += size) detected = detector.push(source.slice(i, i + size));
    expect(detected?.repetitionKind).toBe("paragraph");
  });

  it("uses configured minimum character volume as well as repetition count", () => {
    const byCount = new RepetitiveOutputDetector({ ...low, repeatedParagraphMinRepeats: 5 });
    expect(byCount.push(repeated(4))).toBeUndefined();
    expect(byCount.push(repeated(1))).toBeDefined();
    const byVolume = new RepetitiveOutputDetector({ ...low, repeatedParagraphMinChars: paragraph.length * 5 });
    expect(byVolume.push(repeated(4))).toBeUndefined();
    expect(byVolume.push(repeated(1))).toBeDefined();
  });

  it("checks the final unterminated paragraph without counting it twice", () => {
    const detector = new RepetitiveOutputDetector(low);
    expect(detector.push(repeated(2) + paragraph)).toBeUndefined();
    expect(detector.push("", true)).toMatchObject({ repeatedChars: paragraph.length * 3 });
    expect(detector.push("", true)).toBeUndefined();
  });

  it("compares whitespace-normalized text without changing the source", () => {
    const source = paragraph + "\n\n" + paragraph.replaceAll(" ", "  ") + "\n\n" + paragraph + "\n\n";
    expect(new RepetitiveOutputDetector(low).push(source)).toBeDefined();
    expect(source).toContain("I  will");
  });

  it("detects long repeated Chinese prose", () => {
    const chinese = "我会先确认当前执行的实际结果，再决定下一步如何处理。已经执行完成的操作必须保留，不能在没有检查副作用的情况下重复执行。这一轮需要根据已有证据继续推进，避免重复没有价值的说明。";
    expect(new RepetitiveOutputDetector(low).push(repeated(5, chinese))).toBeDefined();
  });

  it.each([
    repeated(20, "Done."), repeated(20, "12345. 67890."),
    repeated(20, "- " + paragraph), repeated(20, "1. " + paragraph),
    repeated(20, "> " + paragraph), repeated(20, "    " + paragraph),
    repeated(20, "| " + paragraph + " | value |"),
    repeated(20, `const message = "${paragraph}";`),
    repeated(20, `{"text": "${paragraph}"}`),
    repeated(20, "2026-11-17T00:00:00Z " + paragraph),
    "```text\n" + repeated(20) + "```\n",
    "~~~~text\n" + repeated(20) + "~~~~\n",
    repeated(20, paragraph.repeat(45)),
  ])("preserves structured, short and over-budget examples", (source) => {
    expect(new RepetitiveOutputDetector(low).push(source, true)).toBeUndefined();
  });

  it("requires consecutive matches and resets on evidence of new content", () => {
    const detector = new RepetitiveOutputDetector({ ...low, repeatedParagraphMinRepeats: 4 });
    expect(detector.push(repeated(3) + "New evidence now confirms the operation has completed and the result has changed.\n\n" + repeated(3))).toBeUndefined();
    expect(detector.push(repeated(1))).toBeDefined();
  });

  it("does not join repetition across a code block", () => {
    const detector = new RepetitiveOutputDetector({ ...low, repeatedParagraphMinRepeats: 4 });
    expect(detector.push(repeated(3) + "```text\nexample\n```\n\n" + repeated(3))).toBeUndefined();
  });

  it("honors independent extended detection and master switches", () => {
    const legacy = new RepetitiveOutputDetector({ repeatedParagraphsEnabled: false });
    expect(legacy.push(repeated(20))).toBeUndefined();
    expect(legacy.push(":".repeat(8192))).toBeDefined();
    const disabled = new RepetitiveOutputDetector({ repetitiveOutputEnabled: false });
    expect(disabled.push(repeated(20) + ":".repeat(20000), true)).toBeUndefined();
  });

  it("uses configured legacy symbol thresholds", () => {
    const detector = new RepetitiveOutputDetector({ symbolSingleLineChars: 1024 });
    expect(detector.push(":".repeat(1023))).toBeUndefined();
    expect(detector.push(":")).toMatchObject({ repeatedChars: 1024 });
    expect(new RepetitiveOutputDetector({ symbolMinChars: 1024, symbolMinLines: 32 }).push(":\n".repeat(512))).toBeDefined();
  });
});

describe("paragraph stream safety", () => {
  it.each([false, true])("preserves received text and removes unexecuted tool calls (thinking=%s)", async (thinking) => {
    const inner = createAssistantMessageEventStream();
    const original = message(repeated(10), thinking);
    original.content.push({ type: "toolCall", id: "not-executed", name: "Write", arguments: { content: "unsafe partial" } });
    inner.push({ type: "done", reason: "stop", message: original });
    const result = await withModelOutputGuard(model, {}, () => inner).result();
    expect(result.stopReason).toBe("error");
    expect(result.content).toEqual([original.content[0]]);
    expect(original.content).toHaveLength(2);
    expect(readOutputRepetition(result)).toMatchObject({ repetitionKind: "paragraph", channel: thinking ? "thinking" : "text" });
  });

  it("supports a final-only reply without a trailing blank line", async () => {
    const inner = createAssistantMessageEventStream();
    inner.end(message(repeated(2) + paragraph));
    expect(readOutputRepetition(await withModelOutputGuard(model, {}, () => inner, low).result())).toMatchObject({ repetitionKind: "paragraph" });
  });

  it("takes a snapshot of settings and forwards untouched output when disabled", async () => {
    const inner = createAssistantMessageEventStream();
    const preferences = { repetitiveOutputEnabled: false };
    const guarded = withModelOutputGuard(model, {}, () => inner, preferences);
    preferences.repetitiveOutputEnabled = true;
    const original = message(repeated(20));
    inner.push({ type: "done", reason: "stop", message: original });
    expect(await guarded.result()).toBe(original);
  });

  it("does not combine short independent text and reasoning streams", async () => {
    const inner = createAssistantMessageEventStream();
    const original = message(repeated(2));
    original.content.push({ type: "thinking", thinking: repeated(2) });
    inner.push({ type: "done", reason: "stop", message: original });
    expect(await withModelOutputGuard(model, {}, () => inner, low).result()).toBe(original);
  });
});
