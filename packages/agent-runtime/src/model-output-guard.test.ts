import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { buildProviderModel } from "./provider-binding.js";
import { classifyProviderError, createProviderRetryStream } from "./provider-retry.js";
import { RepetitiveOutputDetector } from "./model-output-repetition.js";
import { withModelOutputGuard } from "./model-output-guard.js";

const model = buildProviderModel({ id: "fixture", name: "Fixture", modelId: "fixture", baseUrl: "http://provider.invalid/v1", apiKey: "fixture", supportsReasoning: false, supportedThinkingLevels: ["off"] });
function message(content: AssistantMessage["content"]): AssistantMessage {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content, stopReason: "stop", timestamp: 1,
    usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const text = (value: string) => message([{ type: "text", text: value }]);
const junk = ":\n\n".repeat(3000);

async function collect(stream: ReturnType<typeof createAssistantMessageEventStream>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("incremental low-information detector", () => {
  it.each([":\n\n", "-\n", "：\n\n", "\n", " \t", ".", "\u200B", "|", ":;.,!"])("detects runaway %j across arbitrary chunks", (unit) => {
    const detector = new RepetitiveOutputDetector();
    let detected;
    for (const char of unit.repeat(9000)) {
      detected = detector.push(char);
      if (detected) break;
    }
    expect(detected).toBeDefined();
    expect(detected?.repeatedChars).toBeLessThanOrEqual(8192);
  });

  it.each([
    "- item\n".repeat(9000), "const x = 1;\n".repeat(9000),
    "| x | y |\n| --- | --- |\n".repeat(1000),
    "```text\n" + junk + "```\nDone.", "~~~~text\n" + junk + "~~~~\nDone.",
    ":\n".repeat(1000), "word\n".repeat(10000),
  ])("preserves ordinary content and fenced examples", (source) => {
    expect(new RepetitiveOutputDetector().push(source)).toBeUndefined();
  });

  it("resets a suspicion on meaningful text and detects repetition after a closing fence", () => {
    const detector = new RepetitiveOutputDetector();
    expect(detector.push(":\n".repeat(1000))).toBeUndefined();
    expect(detector.push("Progress\n" + ":\n".repeat(1000))).toBeUndefined();
    expect(new RepetitiveOutputDetector().push("```\n" + junk + "```\n" + junk)).toBeDefined();
  });
});

describe("model output stream guard", () => {
  it("does not combine independent text and thinking blocks into one streak", async () => {
    const inner = createAssistantMessageEventStream();
    const final = message([{ type: "text", text: ":".repeat(5000) }, { type: "thinking", thinking: ":".repeat(5000) }]);
    inner.push({ type: "done", reason: "stop", message: final });
    expect(await withModelOutputGuard(model, {}, () => inner).result()).toBe(final);
  });

  it("detaches cancellation on success and emits exactly one terminal event", async () => {
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    const inner = createAssistantMessageEventStream();
    const final = text("Complete.");
    inner.push({ type: "done", reason: "stop", message: final });
    const guarded = withModelOutputGuard(model, { signal: parent.signal }, () => inner);
    expect(await guarded.result()).toBe(final);
    parent.abort();
    const events = await collect(guarded);
    expect(events.map((event) => event.type)).toEqual(["done"]);
    expect(remove).toHaveBeenCalled();
  });

  it("keeps local repetition provenance across a stale 429 retry wrapper", async () => {
    const claim = vi.fn(() => undefined);
    const stream = createProviderRetryStream(model, { messages: [] }, {}, (options) => withModelOutputGuard(model, options, () => {
      const inner = createAssistantMessageEventStream();
      inner.push({ type: "done", reason: "stop", message: text(junk) });
      return inner;
    }), { claim, headers: () => undefined, status: () => 429 });
    const events = await collect(stream);
    const result = await stream.result();
    expect(classifyProviderError(result, 429).code).toBe("MODEL_OUTPUT_REPETITION");
    expect(claim).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
  });

  it.each(["text", "thinking"] as const)("cuts off live %s, preserves received output and refuses incomplete tools", async (channel) => {
    const inner = createAssistantMessageEventStream();
    let signal: AbortSignal | undefined;
    const parent = new AbortController();
    const partial = message([
      channel === "text" ? { type: "text", text: junk } : { type: "thinking", thinking: junk },
      { type: "toolCall", id: "not-run", name: "Write", arguments: { content: "x" } },
    ]);
    const guarded = withModelOutputGuard(model, { signal: parent.signal }, (options) => {
      signal = options.signal;
      options.signal?.addEventListener("abort", () => inner.end(partial), { once: true });
      return inner;
    });
    inner.push({ type: "start", partial: text("Prefix") });
    inner.push(channel === "text"
      ? { type: "text_delta", contentIndex: 0, delta: junk, partial }
      : { type: "thinking_delta", contentIndex: 0, delta: junk, partial });
    const result = await guarded.result();
    const events = await collect(guarded);
    expect(result.stopReason).toBe("error");
    expect(result.content).toEqual([partial.content[0]]);
    expect(result.usage).toEqual(partial.usage);
    expect(partial.content).toHaveLength(2);
    expect(signal?.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(classifyProviderError(result, 429)).toMatchObject({ code: "MODEL_OUTPUT_REPETITION", retriable: false, details: { origin: "local", channel } });
    expect(classifyProviderError({ ...result }).code).not.toBe("MODEL_OUTPUT_REPETITION");
    partial.content = [];
    expect(result.content).toHaveLength(1);
  });

  it.each([true, false])("inspects a final snapshot even without deltas (done event=%s)", async (done) => {
    const inner = createAssistantMessageEventStream();
    const partial = text(junk);
    if (done) inner.push({ type: "done", reason: "stop", message: partial });
    inner.end(partial);
    const result = await withModelOutputGuard(model, {}, () => inner).result();
    expect(classifyProviderError(result).code).toBe("MODEL_OUTPUT_REPETITION");
  });

  it("does not count cumulative snapshots twice and tolerates replacement snapshots", async () => {
    const inner = createAssistantMessageEventStream();
    const short = text(":\n".repeat(1000));
    inner.push({ type: "start", partial: short });
    for (let i = 0; i < 10; i++) inner.push({ type: "text_delta", contentIndex: 0, delta: "", partial: short });
    const replacement = text("Normal answer.");
    inner.push({ type: "text_delta", contentIndex: 0, delta: "Normal answer.", partial: replacement });
    inner.push({ type: "done", reason: "stop", message: replacement });
    expect(await withModelOutputGuard(model, {}, () => inner).result()).toBe(replacement);
  });

  it("never examines tool arguments and forwards successful message identity", async () => {
    const inner = createAssistantMessageEventStream();
    const partial = message([{ type: "toolCall", id: "valid", name: "Write", arguments: { content: junk } }]);
    partial.stopReason = "toolUse";
    inner.push({ type: "toolcall_delta", contentIndex: 0, delta: junk, partial });
    inner.push({ type: "done", reason: "toolUse", message: partial });
    expect(await withModelOutputGuard(model, {}, () => inner).result()).toBe(partial);
  });

  it("user cancellation wins, settles stalled streams and detaches its listener", async () => {
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    const inner = createAssistantMessageEventStream();
    const guarded = withModelOutputGuard(model, { signal: parent.signal }, (options) => {
      options.signal?.addEventListener("abort", () => inner.end(text("Partial")), { once: true });
      return inner;
    });
    parent.abort();
    const result = await guarded.result();
    expect(result.stopReason).toBe("aborted");
    expect(classifyProviderError(result).code).toBe("TURN_ABORTED");
    expect(remove).toHaveBeenCalled();
  });

  it("does not start a request whose owner is already cancelled", async () => {
    const parent = new AbortController(); parent.abort();
    const factory = vi.fn(() => createAssistantMessageEventStream());
    expect((await withModelOutputGuard(model, { signal: parent.signal }, factory).result()).stopReason).toBe("aborted");
    expect(factory).not.toHaveBeenCalled();
  });

  it("preserves provider error identity rather than reclassifying it as repetition", async () => {
    const inner = createAssistantMessageEventStream();
    const error = text(junk); error.stopReason = "error"; error.errorMessage = "401 Unauthorized";
    inner.push({ type: "error", reason: "error", error });
    expect(await withModelOutputGuard(model, {}, () => inner).result()).toBe(error);
  });

  it("reports a thrown provider exception and cancels its owned request", async () => {
    let options: SimpleStreamOptions | undefined;
    const result = await withModelOutputGuard(model, {}, (value) => { options = value; throw new Error("fixture failure"); }).result();
    expect(result.errorMessage).toBe("fixture failure");
    expect(options?.signal?.aborted).toBe(true);
  });
});

describe("repetition review regressions", () => {
  it("preserves a fence opener with a long whitespace suffix", () => {
    const detector = new RepetitiveOutputDetector();
    expect(detector.push("```" + " ".repeat(9000))).toBeUndefined();
    expect(detector.push("\ncode\n```\nDone.")).toBeUndefined();
  });

  it.each([true, false])("rechecks rewritten prefixes with unchanged tails (separate replacement=%s)", async (separate) => {
    const inner = createAssistantMessageEventStream();
    const initial = text(":".repeat(8000));
    inner.push({ type: "text_delta", contentIndex: 0, delta: initial.content[0].type === "text" ? initial.content[0].text : "", partial: initial });
    if (separate) inner.push({ type: "text_delta", contentIndex: 0, delta: "", partial: text("A" + ":".repeat(7999)) });
    const final = text("A" + ":".repeat(8191));
    inner.push({ type: "text_delta", contentIndex: 0, delta: ":".repeat(192), partial: final });
    inner.push({ type: "done", reason: "stop", message: final });
    expect(await withModelOutputGuard(model, {}, () => inner).result()).toBe(final);
  });
});
