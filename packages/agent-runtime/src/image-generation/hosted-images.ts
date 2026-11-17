import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  createAssistantMessageEventStream,
  type Api, type AssistantMessage, type AssistantMessageEventStream, type Model, type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { imageExceedsInlineDimensions, probeImageDimensions } from "@pi-desktop/shared";
import { isRecord } from "../agent-messages.js";
import { imageDecodesCompletely } from "../image-integrity.js";
import { readLocalRequestErrorDetails } from "../local-request-errors.js";
import { generatedImageType, imageError } from "./download.js";
import { decodeImageBase64, safeImageError } from "./openai-images.js";

const MAX_IMAGES = 10;
type ImageOutput = { index: number; path?: string; errorCode?: string };
type ImageFailure = { errorCode: string; savedImages: number };
// Local provenance, never inferred from provider-controlled prose or metadata.
const failures = new WeakMap<object, ImageFailure>();
export function readHostedImageFailure(error: unknown): ImageFailure | undefined {
  return error !== null && typeof error === "object" ? failures.get(error) : undefined;
}

function imageKey(item: Record<string, unknown>, index: unknown): string | undefined {
  if (typeof item.id === "string" && item.id.length > 0 && item.id.length <= 256) return `id:${item.id}`;
  return typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? `index:${index}` : undefined;
}

/** The directory comes from the Host, never from a provider output or model argument. */
async function saveImage(scratchDir: string | undefined, data: string): Promise<string> {
  const bytes = decodeImageBase64(data);
  const { extension, mimeType } = generatedImageType(bytes);
  const dimensions = probeImageDimensions(bytes);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) throw imageError("IMAGE_INVALID_CONTENT");
  if (imageExceedsInlineDimensions(dimensions)) throw imageError("IMAGE_TOO_LARGE");
  if (!imageDecodesCompletely(data, mimeType, dimensions)) throw imageError("IMAGE_INVALID_CONTENT");
  if (!scratchDir || !isAbsolute(scratchDir)) throw imageError("IMAGE_STORAGE_UNAVAILABLE");
  const dir = resolve(scratchDir);
  await mkdir(dir, { recursive: true });
  const [parent, realDir] = await Promise.all([realpath(dirname(dir)), realpath(dir)]);
  if (realDir !== join(parent, basename(dir))) throw imageError("IMAGE_UNSAFE_PATH");
  const target = join(realDir, `generated-${randomUUID()}.${extension}`);
  const file = await open(target, "wx", 0o600);
  try {
    // Finish an already received image even if the provider is cancelled during disk I/O.
    await file.writeFile(bytes);
  } catch (error) {
    await file.close();
    await rm(target, { force: true });
    throw error;
  }
  await file.close();
  return target;
}

function imageMarkdown(path: string): string {
  // Angle destinations preserve spaces/parentheses; escape delimiters and percent signs.
  const destination = path.replaceAll("\\", "/").replace(/[%<>\r\n]/g, char => encodeURIComponent(char));
  return `![${basename(path)}](<${destination}>)`;
}

/** Preserve hosted Responses images without manufacturing a tool call or repeating generation. */
export function withHostedImageOutputs(
  model: Model<Api>, options: SimpleStreamOptions, scratchDir: string | undefined,
  createStream: (options: SimpleStreamOptions) => AssistantMessageEventStream,
): AssistantMessageEventStream {
  if (!["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(model.api)) return createStream(options);
  const outer = createAssistantMessageEventStream();
  const outputs = new Map<string, ImageOutput>();
  const incomplete = new Set<string>();
  let observed = false;
  let active = true;
  let pending: Promise<void> = Promise.resolve();
  let errorCode: string | undefined;
  let partial: AssistantMessage | undefined;

  const collect = async (item: unknown, index: unknown) => {
    if (!isRecord(item) || item.type !== "image_generation_call") return;
    observed = true;
    const key = imageKey(item, index);
    if (!key) { errorCode ??= "IMAGE_INVALID_RESPONSE"; return; }
    incomplete.delete(key);
    if (outputs.has(key)) return;
    if (outputs.size >= MAX_IMAGES) { errorCode ??= "IMAGE_TOO_MANY_RESULTS"; return; }
    const result: ImageOutput = { index: typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? index : outputs.size };
    outputs.set(key, result);
    try {
      if ((item.status !== undefined && item.status !== "completed") || typeof item.result !== "string")
        throw imageError("IMAGE_INVALID_RESPONSE");
      result.path = await saveImage(scratchDir, item.result);
    } catch (error) {
      const code = safeImageError(error);
      result.errorCode = code === "IMAGE_REQUEST_FAILED" ? "IMAGE_SAVE_FAILED" : code;
      errorCode ??= result.errorCode;
    }
  };
  const capture = async (event: unknown) => {
    if (!isRecord(event)) return;
    if (typeof event.type === "string" && event.type.startsWith("response.image_generation_call.")) observed = true;
    if (event.type === "response.output_item.added" && isRecord(event.item) && event.item.type === "image_generation_call") {
      observed = true;
      const key = imageKey(event.item, event.output_index);
      if (!key) errorCode ??= "IMAGE_INVALID_RESPONSE";
      else if (!outputs.has(key)) {
        if (incomplete.size < MAX_IMAGES) incomplete.add(key);
        else errorCode ??= "IMAGE_TOO_MANY_RESULTS";
      }
    }
    if (event.type === "response.output_item.done") await collect(event.item, event.output_index);
    if (["response.completed", "response.done", "response.incomplete", "response.failed"].includes(String(event.type)) &&
      isRecord(event.response) && Array.isArray(event.response.output)) {
      for (const [index, item] of event.response.output.entries()) await collect(item, index);
    }
  };
  const finish = async (message: AssistantMessage) => {
    active = false;
    await pending;
    if (!observed) return message;
    const paths = [...outputs.values()].sort((a, b) => a.index - b.index).flatMap(item => item.path ? [item.path] : []);
    if (!paths.length || incomplete.size) errorCode ??= "IMAGE_INCOMPLETE_RESPONSE";
    if (message.stopReason === "error" || message.stopReason === "length") errorCode ??= "IMAGE_RESPONSE_INTERRUPTED";
    if (paths.length) {
      const text = `\n\n${paths.map(imageMarkdown).join("\n\n")}`;
      const contentIndex = message.content.length;
      message.content.push({ type: "text", text });
      outer.push({ type: "text_start", contentIndex, partial: message });
      outer.push({ type: "text_delta", contentIndex, delta: text, partial: message });
      outer.push({ type: "text_end", contentIndex, content: text, partial: message });
    }
    if (errorCode && message.stopReason !== "aborted") {
      message.content = message.content.filter(block => block.type !== "toolCall");
      message.stopReason = "error";
      message.errorMessage = `Hosted image output could not be fully delivered (${errorCode}). Completed images are retained; automatic replay stopped to avoid duplicate generation.`;
      failures.set(message, { errorCode, savedImages: paths.length });
    }
    return message;
  };
  void (async () => {
    try {
      const inner = createStream({
        ...options,
        onProviderStreamEvent: async (event, responseModel) => {
          if (!active) return;
          pending = pending.then(() => capture(event)).catch(error => { errorCode ??= safeImageError(error); });
          await pending;
          await options.onProviderStreamEvent?.(event, responseModel);
        },
      });
      for await (const event of inner) {
        if ("partial" in event) partial = event.partial;
        if (event.type === "done" || event.type === "error") {
          const message = await finish(event.type === "done" ? event.message : event.error);
          if (message.stopReason === "error" || message.stopReason === "aborted")
            outer.push({ type: "error", reason: message.stopReason, error: message });
          else outer.push(event);
          outer.end(message);
          return;
        }
        outer.push(event);
      }
      outer.end(await finish(await inner.result()));
    } catch (error) {
      const local = readLocalRequestErrorDetails(error);
      const message: AssistantMessage = partial ?? {
        role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "error", timestamp: Date.now(),
      };
      message.stopReason = options.signal?.aborted ? "aborted" : "error";
      message.errorMessage = message.stopReason === "aborted" ? "Request aborted" : local?.message ?? (error instanceof Error ? error.message : String(error));
      if (local) {
        message.errorDetails = local;
        Object.defineProperty(message, "cause", { value: error, configurable: true });
      }
      const result = await finish(message);
      outer.push({ type: "error", reason: result.stopReason === "aborted" ? "aborted" : "error", error: result });
      outer.end(result);
    } finally { active = false; }
  })();
  return outer;
}
