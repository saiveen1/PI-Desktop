import {
  createAssistantMessageEventStream,
  type Api, type Model, type AssistantMessage, type AssistantMessageEventStream, type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { markOutputRepetition, RepetitiveOutputDetector, type OutputRepetitionDetails } from "./model-output-repetition.js";

type ObservedBlock = { source: string; detector: RepetitiveOutputDetector };

/** Stop one runaway response without changing prior tool results or replaying the request. */
export function withModelOutputGuard(
  model: Model<Api>,
  options: SimpleStreamOptions,
  createStream: (options: SimpleStreamOptions) => AssistantMessageEventStream,
): AssistantMessageEventStream {
  const outer = createAssistantMessageEventStream();
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  const blocks = new Map<number, ObservedBlock>();
  let active = true;
  let partial: AssistantMessage | undefined;
  const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
  const stop = (error: unknown, details?: OutputRepetitionDetails) => {
    if (!active) return;
    active = false;
    cleanup();
    const message: AssistantMessage = partial ? structuredClone(partial) : {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      stopReason: "error", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    // A tool in this unfinished response has not executed and cannot be trusted.
    message.content = message.content.filter((block) => block.type !== "toolCall");
    const userStopped = options.signal?.aborted === true;
    message.stopReason = userStopped ? "aborted" : "error";
    message.errorMessage = userStopped ? "Request aborted" : error instanceof Error ? error.message : String(error);
    if (details && !userStopped) markOutputRepetition(message, details);
    outer.push({ type: "error", reason: userStopped ? "aborted" : "error", error: message });
    outer.end(message);
    abort.abort();
  };
  const onAbort = () => stop(new Error("Request aborted"));
  const inspect = (message: AssistantMessage, index: number, terminal = false): OutputRepetitionDetails | undefined => {
    const block = message.content[index];
    if (!block || (block.type !== "text" && block.type !== "thinking")) return;
    const source = block.type === "text" ? block.text : block.thinking;
    let previous = blocks.get(index);
    // Normal append updates consume only their suffix. Same-length rewrites
    // and final snapshots reset; a suspected trip is always fully confirmed.
    if (!previous || terminal || source.length < previous.source.length ||
      (source.length === previous.source.length && source !== previous.source) ||
      source.slice(Math.max(0, previous.source.length - 32), previous.source.length) !== previous.source.slice(-32)) {
      previous = { source: "", detector: new RepetitiveOutputDetector() };
      blocks.set(index, previous);
    }
    let result = previous.detector.push(source.slice(previous.source.length));
    if (result && !terminal && previous.source.length > 0) {
      previous.detector = new RepetitiveOutputDetector();
      result = previous.detector.push(source);
    }
    previous.source = source;
    return result ? { channel: block.type, ...result } : undefined;
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  void (async () => {
    try {
      if (options.signal?.aborted) { onAbort(); return; }
      const inner = createStream({ ...options, signal });
      for await (const event of inner) {
        if (!active) return;
        if ("partial" in event) partial = event.partial;
        if (event.type === "done") partial = event.message;
        let detected: OutputRepetitionDetails | undefined;
        if (event.type === "text_delta" || event.type === "thinking_delta") {
          detected = inspect(event.partial, event.contentIndex);
        } else if (event.type === "done") {
          for (let i = 0; i < event.message.content.length && !detected; i++) detected = inspect(event.message, i, true);
        }
        if (detected) {
          stop(new Error("Stopped repetitive model output. Review the partial reply before continuing."), detected);
          return;
        }
        if (event.type === "error" || event.type === "done") {
          active = false;
          cleanup();
          outer.push(event);
          return;
        }
        outer.push(event);
      }
      if (active) {
        partial = await inner.result();
        let detected: OutputRepetitionDetails | undefined;
        for (let i = 0; i < partial.content.length && !detected; i++) detected = inspect(partial, i, true);
        if (detected && partial.stopReason !== "error" && partial.stopReason !== "aborted") {
          stop(new Error("Stopped repetitive model output. Review the partial reply before continuing."), detected);
        } else outer.end(partial);
      }
    } catch (error) {
      stop(error);
    } finally {
      active = false;
      cleanup();
    }
  })();
  return outer;
}
