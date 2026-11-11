import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { isProviderStreamIdleTimeoutMinutes, PROVIDER_STREAM_IDLE_TIMEOUT_MINUTES_DEFAULT } from "@pi-desktop/shared";
import { adapterAcceptsCustomFetch } from "./provider-binding.js";
import { markProviderIdleTimeout, type ProviderIdleDetails } from "./provider-stream-idle-error.js";

export const STREAM_SLOW_NOTICE_MS = 180_000;
export const STREAM_IDLE_TIMEOUT_DEFAULT_MS = PROVIDER_STREAM_IDLE_TIMEOUT_MINUTES_DEFAULT * 60_000;
export const STREAM_IDLE_TIMEOUT_FLOOR_MS = 30_000;

/** An explicit saved setting wins; retain the legacy override for older callers. */
export function streamIdleTimeoutMs(minutes?: number): number {
  if (isProviderStreamIdleTimeoutMinutes(minutes)) return minutes * 60_000;
  const raw = process.env.PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return STREAM_IDLE_TIMEOUT_DEFAULT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return STREAM_IDLE_TIMEOUT_DEFAULT_MS;
  return value === 0 ? 0 : Math.max(STREAM_IDLE_TIMEOUT_FLOOR_MS, Math.floor(value));
}

function failureMessage(model: Model<Api>, error: unknown, partial?: AssistantMessage, aborted = false): AssistantMessage {
  const message: AssistantMessage = partial ? structuredClone(partial) : {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error", timestamp: Date.now(),
  };
  // Never execute an incomplete function call from an interrupted response.
  message.content = message.content.filter(block => block.type !== "toolCall");
  message.stopReason = aborted ? "aborted" : "error";
  message.errorMessage = aborted ? "Request aborted" : error instanceof Error ? error.message : String(error);
  return message;
}

/** One attempt owns both clocks. Byte activity is not model progress; neither caps total duration. */
export function withProviderStreamIdleTimeout(
  model: Model<Api>,
  options: SimpleStreamOptions,
  idleTimeoutMs: number,
  createStream: (options: SimpleStreamOptions) => AssistantMessageEventStream,
  onSlow?: (since: number) => void,
): AssistantMessageEventStream {
  const outer = createAssistantMessageEventStream();
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  let active = true;
  let partial: AssistantMessage | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  const details: ProviderIdleDetails = { idleTimeoutMs, responseBytes: 0, transportObserved: false };
  const cleanup = () => {
    clearTimeout(idleTimer);
    clearTimeout(slowTimer);
    options.signal?.removeEventListener("abort", onAbort);
  };
  const interrupt = (message: AssistantMessage) => {
    if (!active) return;
    active = false;
    cleanup();
    // Publish local provenance before aborting the adapter's pending read.
    outer.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
    outer.end(message);
    abort.abort();
  };
  const armIdle = () => {
    clearTimeout(idleTimer);
    if (!active || idleTimeoutMs <= 0) return;
    idleTimer = setTimeout(() => {
      if (options.signal?.aborted) { onAbort(); return; }
      interrupt(markProviderIdleTimeout(failureMessage(model,
        new Error(`Provider connection idle for ${idleTimeoutMs}ms; automatic replay stopped.`), partial), { ...details }));
    }, idleTimeoutMs);
  };
  const transportActivity = (bytes = 0) => {
    if (!active) return;
    details.transportObserved = true;
    details.lastTransportAt = Date.now();
    details.responseBytes += bytes;
    armIdle();
  };
  const armSlow = () => {
    clearTimeout(slowTimer);
    if (!active || !onSlow) return;
    const since = Date.now();
    slowTimer = setTimeout(() => { if (active && !signal.aborted) onSlow(since); }, STREAM_SLOW_NOTICE_MS);
  };
  const onAbort = () => interrupt(failureMessage(model, new Error("Request aborted"), partial, true));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  armIdle();
  armSlow();
  const baseFetch = options.fetch ?? globalThis.fetch;
  const timedOptions: SimpleStreamOptions = {
    ...options,
    signal,
    ...(adapterAcceptsCustomFetch(model.api) ? { fetch: async (input, init) => {
      const response = await baseFetch(input, init);
      transportActivity();
      if (!response.ok || !response.body) return response;
      // Observe bytes inline, without teeing, decoding or retaining response data.
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (chunk.byteLength > 0) transportActivity(chunk.byteLength);
          controller.enqueue(chunk);
        },
      }), { signal });
      const observed = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      Object.defineProperties(observed, {
        url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type },
      });
      return observed;
    } } : {}),
    onProviderStreamEvent: async (event, responseModel) => {
      if (!adapterAcceptsCustomFetch(model.api)) transportActivity();
      await options.onProviderStreamEvent?.(event, responseModel);
    },
  };

  void (async () => {
    try {
      if (options.signal?.aborted) onAbort();
      if (!active) return;
      const inner = createStream(timedOptions);
      for await (const event of inner) {
        if (!active) return;
        if ("partial" in event) partial = event.partial;
        if (event.type !== "error" && event.type !== "done") {
          details.lastModelEventAt = Date.now();
          // Non-fetch adapters without raw-event hooks retain a model-event fallback.
          if (!details.transportObserved) armIdle();
          if (event.type !== "start") armSlow();
        }
        if (event.type === "done" || event.type === "error") {
          active = false;
          cleanup();
          outer.push(event);
          return;
        }
        outer.push(event);
      }
      if (active) outer.end(await inner.result());
    } catch (error) {
      if (!active) return;
      const message = failureMessage(model, error, partial, options.signal?.aborted === true);
      outer.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
      outer.end(message);
    } finally {
      active = false;
      cleanup();
    }
  })();
  return outer;
}
