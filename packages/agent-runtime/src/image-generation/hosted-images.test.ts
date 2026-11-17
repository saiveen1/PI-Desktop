import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, normalizeContext, type AssistantMessage, type AssistantMessageEvent, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { stream as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { buildProviderModel } from "../provider-binding.js";
import { classifyProviderError, createProviderRetryStream } from "../provider-retry.js";
import { MAX_IMAGE_BYTES } from "./download.js";
import { readHostedImageFailure, withHostedImageOutputs } from "./hosted-images.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==";
const model = { ...buildProviderModel({ id: "fixture", name: "Fixture", modelId: "fixture", apiKey: "fixture", baseUrl: "https://provider.invalid/v1", supportsReasoning: false, supportedThinkingLevels: ["off"] }), api: "openai-responses" as const };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function root() {
  const path = await mkdtemp(join(tmpdir(), "hosted-image-test-"));
  roots.push(path);
  return path;
}
function image(id = "ig_1", result = png) { return { type: "image_generation_call", id, status: "completed", result, output_format: "png" }; }
const doneImage = (item: unknown, index = 0) => ({ type: "response.output_item.done", output_index: index, item });
const completed = (output: unknown[] = []) => ({ type: "response.completed", response: { id: "resp_fixture", status: "completed", output, usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } });
function message(): AssistantMessage {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], timestamp: 1, stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
async function run(events: unknown[], scratchDir: string | undefined, options: SimpleStreamOptions = {}) {
  let requests = 0;
  const stream = withHostedImageOutputs(model, options, scratchDir, bound => streamResponses(model, normalizeContext({ messages: [{ role: "user", content: "Draw a cat", timestamp: 1 }] }), {
    ...bound, apiKey: "fixture-only", maxRetries: 0, fetch: async () => {
      requests++;
      return new Response([{ type: "response.created", response: { id: "resp_fixture" } }, ...events].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    },
  }));
  const emitted: AssistantMessageEvent[] = [];
  for await (const event of stream) emitted.push(event);
  return { output: await stream.result(), emitted, requests };
}
function text(output: AssistantMessage) { return output.content.flatMap(block => block.type === "text" ? [block.text] : []).join(""); }

describe("hosted Responses image delivery", () => {
  it("saves a streamed image once when the terminal snapshot repeats it", async () => {
    const path = await root();
    const hook = vi.fn();
    const result = await run([doneImage(image()), doneImage(image()), completed([image()])], path, { onProviderStreamEvent: hook });
    expect(result.output.stopReason).toBe("stop");
    expect(result.output.usage.totalTokens).toBe(16);
    expect(result.requests).toBe(1);
    const files = await readdir(path);
    expect(files).toHaveLength(1);
    expect(await readFile(join(path, files[0]))).toEqual(Buffer.from(png, "base64"));
    expect(text(result.output).match(/!\[/g)).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(png);
    expect(hook).toHaveBeenCalledTimes(4);
    expect(result.emitted.at(-1)?.type).toBe("done");
  });

  it("recovers terminal-only output and keeps separate images in provider order", async () => {
    const path = await root();
    const result = await run([completed([image("a"), image("b")])], path);
    expect(await readdir(path)).toHaveLength(2);
    expect(text(result.output).match(/!\[/g)).toHaveLength(2);
    expect(result.output.stopReason).toBe("stop");
  });

  it("escapes Markdown delimiters while keeping a normal local path", async () => {
    const path = join(await root(), "images (100%) <draft>");
    // Windows forbids angle brackets in filenames; exercise valid cross-platform delimiters.
    const actual = process.platform === "win32" ? path.replace("<draft>", "draft") : path;
    const result = await run([completed([image()])], actual);
    expect(text(result.output)).toContain("(100%25)");
    expect(text(result.output)).not.toContain("\\");
    expect(await readdir(actual)).toHaveLength(1);
  });

  it.each([
    ["invalid base64", "not-base64", "IMAGE_INVALID_RESPONSE"],
    ["non-image bytes", Buffer.from("<svg/>0").toString("base64"), "IMAGE_INVALID_CONTENT"],
    ["truncated PNG", Buffer.from(png, "base64").subarray(0, 45).toString("base64"), "IMAGE_INVALID_CONTENT"],
    ["oversized encoded output", "A".repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4), "IMAGE_TOO_LARGE"],
  ])("reports %s without retaining unsafe bytes or retrying", async (_name, data, errorCode) => {
    const path = await root();
    const { output, requests } = await run([completed([image("bad", data)])], path);
    expect(output.stopReason).toBe("error");
    expect(classifyProviderError(output, 429)).toMatchObject({ code: "HOSTED_IMAGE_OUTPUT_FAILED", retriable: false, details: { errorCode } });
    expect(await readdir(path)).toEqual([]);
    expect(requests).toBe(1);
    expect(text(output)).toBe("");
  });

  it("keeps valid siblings when another image fails", async () => {
    const path = await root();
    const { output } = await run([completed([image(), image("bad", "bad")])], path);
    expect(await readdir(path)).toHaveLength(1);
    expect(text(output)).toContain(".png>");
    expect(readHostedImageFailure(output)).toMatchObject({ savedImages: 1 });
  });

  it("bounds image count and retains the first ten results", async () => {
    const path = await root();
    const { output } = await run([completed(Array.from({ length: 11 }, (_, i) => image(String(i))))], path);
    expect(await readdir(path)).toHaveLength(10);
    expect(readHostedImageFailure(output)).toEqual({ errorCode: "IMAGE_TOO_MANY_RESULTS", savedImages: 10 });
  });

  it("reports unavailable storage rather than falling back to cwd", async () => {
    const { output } = await run([completed([image()])], undefined);
    expect(readHostedImageFailure(output)?.errorCode).toBe("IMAGE_STORAGE_UNAVAILABLE");
  });

  it("refuses a session directory symlink that escapes its parent", async () => {
    const parent = await root();
    const outside = await root();
    const target = join(parent, "session");
    await symlink(outside, target, process.platform === "win32" ? "junction" : "dir");
    const { output } = await run([completed([image()])], target);
    expect(readHostedImageFailure(output)?.errorCode).toBe("IMAGE_UNSAFE_PATH");
    expect(await readdir(outside)).toEqual([]);
  });

  it("reports filesystem failures without leaking paths", async () => {
    const target = join(await root(), "not-a-directory");
    await writeFile(target, "preserve");
    const { output } = await run([completed([image()])], target);
    expect(output.stopReason).toBe("error");
    expect(output.errorMessage).not.toContain(target);
    expect(await readFile(target, "utf8")).toBe("preserve");
  });

  it("retains completed images on abrupt end and blocks request-side replay", async () => {
    const path = await root();
    const claim = vi.fn(() => 1);
    let attempts = 0;
    const stream = createProviderRetryStream(model, normalizeContext({ messages: [] }), {}, options => withHostedImageOutputs(model, options, path, bound => {
      attempts++;
      const inner = createAssistantMessageEventStream();
      void (async () => {
        await bound.onProviderStreamEvent?.(doneImage(image()), model);
        const failed = { ...message(), stopReason: "error" as const, errorMessage: "503 upstream failed" };
        inner.push({ type: "error", reason: "error", error: failed });
        inner.end(failed);
      })();
      return inner;
    }), { claim, headers: () => undefined, status: () => 429 });
    const output = await stream.result();
    expect(attempts).toBe(1);
    expect(claim).not.toHaveBeenCalled();
    expect(readHostedImageFailure(output)?.savedImages).toBe(1);
    expect(text(output)).toContain(".png>");
  });

  it("preserves completed images on cancellation and ignores late events", async () => {
    const path = await root();
    let callback: SimpleStreamOptions["onProviderStreamEvent"];
    const stream = withHostedImageOutputs(model, {}, path, options => {
      callback = options.onProviderStreamEvent;
      const inner = createAssistantMessageEventStream();
      void (async () => {
        await callback?.(doneImage(image()), model);
        const aborted = { ...message(), stopReason: "aborted" as const, errorMessage: "Request aborted" };
        inner.push({ type: "error", reason: "aborted", error: aborted });
        inner.end(aborted);
      })();
      return inner;
    });
    const output = await stream.result();
    expect(output.stopReason).toBe("aborted");
    expect(text(output)).toContain(".png>");
    await callback?.(doneImage(image("late")), model);
    expect(await readdir(path)).toHaveLength(1);
  });

  it("does not publish partial images or report progress-only output as success", async () => {
    const path = await root();
    const { output } = await run([{ type: "response.image_generation_call.partial_image", item_id: "ig_1", partial_image_b64: png }, completed()], path);
    expect(readHostedImageFailure(output)?.errorCode).toBe("IMAGE_INCOMPLETE_RESPONSE");
    expect(await readdir(path)).toEqual([]);
  });

  it("does not hide an unfinished sibling behind a completed image", async () => {
    const path = await root();
    const { output } = await run([
      { type: "response.output_item.added", output_index: 1, item: { ...image("unfinished"), status: "in_progress", result: null } },
      doneImage(image()), completed([image()]),
    ], path);
    expect(readHostedImageFailure(output)).toEqual({ errorCode: "IMAGE_INCOMPLETE_RESPONSE", savedImages: 1 });
    expect(await readdir(path)).toHaveLength(1);
  });

  it("preserves completed files when the real Responses stream ends abruptly", async () => {
    const path = await root();
    const { output, requests } = await run([doneImage(image())], path);
    expect(output.stopReason).toBe("error");
    expect(readHostedImageFailure(output)).toEqual({ errorCode: "IMAGE_RESPONSE_INTERRUPTED", savedImages: 1 });
    expect(text(output)).toContain(".png>");
    expect(requests).toBe(1);
  });

  it("preserves local setup failure provenance before any image event", async () => {
    const original = Object.assign(new Error("private diagnostic payload"), { code: "LOCAL_REQUEST_ERROR", phase: "request-preparation" });
    const stream = withHostedImageOutputs(model, {}, undefined, () => { throw original; });
    const output = await stream.result();
    expect(classifyProviderError(output, 429)).toMatchObject({ code: "INTERNAL", retriable: false, details: { origin: "local", phase: "request-preparation" } });
    expect(JSON.stringify(output)).not.toContain("private diagnostic payload");
  });

  it("captures terminal-only response.done through the real Codex adapter", async () => {
    const { stream: streamCodex } = await import("@earendil-works/pi-ai/api/openai-codex-responses");
    const path = await root();
    const codexModel = { ...model, api: "openai-codex-responses" as const };
    const auth = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-test-account" } })).toString("base64");
    let requests = 0;
    const stream = withHostedImageOutputs(codexModel, {}, path, options => streamCodex(codexModel, normalizeContext({ messages: [{ role: "user", content: "Draw a cat", timestamp: 1 }] }), {
      ...options, apiKey: `e30.${auth}.offline-signature`, transport: "sse", maxRetries: 0,
      fetch: async () => {
        requests++;
        const events = [{ type: "response.created", response: { id: "resp_fixture" } }, { ...completed([image()]), type: "response.done" }];
        return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      },
    }));
    const output = await stream.result();
    expect(output.stopReason).toBe("stop");
    expect(requests).toBe(1);
    expect(await readdir(path)).toHaveLength(1);
    expect(text(output).match(/!\[/g)).toHaveLength(1);
  });

  it("leaves other adapters and their options untouched", () => {
    const inner = createAssistantMessageEventStream();
    const options = { onProviderStreamEvent: vi.fn() };
    const factory = vi.fn(() => inner);
    expect(withHostedImageOutputs({ ...model, api: "anthropic-messages" }, options, undefined, factory)).toBe(inner);
    expect(factory).toHaveBeenCalledWith(options);
    inner.end(message());
  });
});
