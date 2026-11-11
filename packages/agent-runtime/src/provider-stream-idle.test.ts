import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, normalizeContext, type AssistantMessage, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { stream as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { buildProviderModel } from "./provider-binding.js";
import { classifyProviderError } from "./provider-retry.js";
import { streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_DEFAULT_MS, STREAM_IDLE_TIMEOUT_FLOOR_MS, withProviderStreamIdleTimeout } from "./provider-stream-idle.js";

const model = buildProviderModel({ id: "fixture", name: "Fixture", modelId: "fixture",
  baseUrl: "https://provider.invalid/v1", apiKey: "fixture", apiStyle: "chat_completions",
  supportsReasoning: false, supportedThinkingLevels: ["off"] });
function message(): AssistantMessage {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text: "Partial answer" }], stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("provider transport idle policy", () => {
  it("defaults to ten minutes and accepts explicit zero ahead of the legacy environment", () => {
    vi.stubEnv("PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS", "");
    expect(streamIdleTimeoutMs()).toBe(600_000);
    expect(STREAM_IDLE_TIMEOUT_DEFAULT_MS).toBe(600_000);
    vi.stubEnv("PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS", "45000");
    expect(streamIdleTimeoutMs()).toBe(45_000);
    expect(streamIdleTimeoutMs(15)).toBe(900_000);
    expect(streamIdleTimeoutMs(0)).toBe(0);
    vi.stubEnv("PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS", "1000");
    expect(streamIdleTimeoutMs()).toBe(STREAM_IDLE_TIMEOUT_FLOOR_MS);
    vi.stubEnv("PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS", "bad");
    expect(streamIdleTimeoutMs()).toBe(600_000);
    vi.stubEnv("PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS", "0");
    expect(streamIdleTimeoutMs()).toBe(0);
  });

  it("warns at three minutes without cancelling a ten-minute attempt and cleans up after success", async () => {
    vi.useFakeTimers();
    const inner = createAssistantMessageEventStream();
    const partial = message();
    inner.push({ type: "start", partial });
    const slow = vi.fn();
    let signal: AbortSignal | undefined;
    const stream = withProviderStreamIdleTimeout(model, {}, 600_000, options => {
      signal = options.signal; return inner;
    }, slow);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    inner.push({ type: "done", reason: "stop", message: partial });
    inner.end(partial);
    expect((await stream.result()).stopReason).toBe("stop");
    await vi.advanceTimersByTimeAsync(900_000);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps partial text but drops incomplete tools on a terminal local timeout", async () => {
    vi.useFakeTimers();
    const partial = message();
    partial.content.push({ type: "toolCall", id: "unfinished", name: "Write", arguments: {} });
    const inner = createAssistantMessageEventStream();
    inner.push({ type: "start", partial });
    let signal: AbortSignal | undefined;
    const stream = withProviderStreamIdleTimeout(model, {}, 1000, options => { signal = options.signal; return inner; });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await stream.result();
    expect(result.content).toEqual([{ type: "text", text: "Partial answer" }]);
    expect(partial.content).toHaveLength(2);
    expect(signal?.aborted).toBe(true);
    expect(classifyProviderError(result, 200)).toMatchObject({ code: "PROVIDER_STREAM_IDLE_TIMEOUT", retriable: false });
    expect(classifyProviderError(result, 429).code).toBe("PROVIDER_STREAM_IDLE_TIMEOUT");
    expect(classifyProviderError({ ...result }, 200).code).not.toBe("PROVIDER_STREAM_IDLE_TIMEOUT");
    inner.end(result);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes heartbeats without treating them as model progress or buffering a second stream", async () => {
    vi.useFakeTimers();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { source = controller; }, cancel() { cancelled = true; } }), {
      headers: { "content-type": "text/event-stream", "x-request-id": "fixture-id" },
    });
    Object.defineProperty(response, "url", { value: "https://provider.invalid/v1/responses" });
    const slow = vi.fn();
    const inner = createAssistantMessageEventStream();
    const partial = message();
    let reading: Promise<void> | undefined;
    const stream = withProviderStreamIdleTimeout(model, { fetch: async () => response }, 240_000, options => {
      reading = (async () => {
        const observed = await options.fetch!("https://provider.invalid/v1/responses", { signal: options.signal });
        expect(observed.url).toBe(response.url);
        expect(observed.headers.get("x-request-id")).toBe("fixture-id");
        inner.push({ type: "start", partial });
        const reader = observed.body!.getReader();
        try { while (!(await reader.read()).done) { /* The adapter ignores SSE comments. */ } }
        catch { /* The watchdog aborts this read. */ }
        finally { reader.releaseLock(); inner.end(partial); }
      })();
      return inner;
    }, slow);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(120_000);
      source.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(slow).toHaveBeenCalledTimes(1);
    expect(cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(240_000);
    const result = await stream.result();
    await reading;
    expect(cancelled).toBe(true);
    expect(classifyProviderError(result)).toMatchObject({
      code: "PROVIDER_STREAM_IDLE_TIMEOUT", retriable: false,
      details: { responseBytes: 52, transportObserved: true },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disabling automatic timeout still permits immediate user cancellation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const inner = createAssistantMessageEventStream();
    const stream = withProviderStreamIdleTimeout(model, { signal: controller.signal }, 0, () => inner);
    await vi.advanceTimersByTimeAsync(3_600_000);
    controller.abort();
    expect((await stream.result()).stopReason).toBe("aborted");
    inner.end(message());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start a request for an already cancelled caller", async () => {
    const controller = new AbortController(); controller.abort();
    const factory = vi.fn(() => createAssistantMessageEventStream());
    const stream = withProviderStreamIdleTimeout(model, { signal: controller.signal }, 0, factory);
    expect((await stream.result()).stopReason).toBe("aborted");
    expect(factory).not.toHaveBeenCalled();
  });

  it("keeps original adapter failures instead of relabeling them as idle timeouts", async () => {
    const inner = createAssistantMessageEventStream();
    const original = { ...message(), stopReason: "error" as const, errorMessage: "socket hang up" };
    inner.push({ type: "error", reason: "error", error: original });
    inner.end(original);
    const stream = withProviderStreamIdleTimeout(model, {}, 600_000, () => inner);
    expect(await stream.result()).toBe(original);
    expect(classifyProviderError(original).code).toBe("NETWORK_ERROR");
  });

  it("does not inject fetch into Google adapters and observes raw provider events", async () => {
    vi.useFakeTimers();
    const google = { ...model, api: "google-generative-ai" as const };
    const inner = createAssistantMessageEventStream();
    let captured!: SimpleStreamOptions;
    const hook = vi.fn();
    const stream = withProviderStreamIdleTimeout(google, { onProviderStreamEvent: hook }, 1000, options => { captured = options; return inner; });
    expect(captured.fetch).toBeUndefined();
    await vi.advanceTimersByTimeAsync(800);
    await captured.onProviderStreamEvent?.({ event: "heartbeat" }, google);
    await vi.advanceTimersByTimeAsync(800);
    expect(captured.signal?.aborted).toBe(false);
    expect(hook).toHaveBeenCalledTimes(1);
    inner.push({ type: "done", reason: "stop", message: message() });
    inner.end(message());
    expect((await stream.result()).stopReason).toBe("stop");
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("the real Responses adapter keeps SSE heartbeats alive and retains text at local expiry", async () => {
  vi.useFakeTimers();
  const responsesModel = { ...model, api: "openai-responses" as const };
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; }, cancel() { cancelled = true; } });
  const stream = withProviderStreamIdleTimeout(responsesModel, {
    apiKey: "fixture-only", maxRetries: 0,
    fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
  }, 1000, options => streamResponses(responsesModel, normalizeContext({
    messages: [{ role: "user", content: "Respond", timestamp: Date.now() }],
  }), options));
  const send = (event: unknown) => source.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  send({ type: "response.created", response: { id: "response-fixture" } });
  send({ type: "response.output_item.added", output_index: 0,
    item: { type: "message", id: "message-fixture", role: "assistant", content: [] } });
  send({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Responses partial" });
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(800);
    source.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toBe(false);
  }
  await vi.advanceTimersByTimeAsync(1000);
  const result = await stream.result();
  expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "Responses partial" }));
  expect(classifyProviderError(result)).toMatchObject({ code: "PROVIDER_STREAM_IDLE_TIMEOUT", retriable: false });
  expect(cancelled).toBe(true);
});
