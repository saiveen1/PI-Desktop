import { mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { buildProviderModel } from "../provider-binding.js";
import { withModelOutputGuard } from "../model-output-guard.js";
import { withProviderStreamIdleTimeout } from "../provider-stream-idle.js";
import { withHostedImageOutputs } from "./hosted-images.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

it("finishes a received image when Stop arrives during its write through the actual guards", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const path = await mkdtemp(join(tmpdir(), "hosted-image-cancel-"));
  let writing!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { writing = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args);
    const write = handle.writeFile.bind(handle);
    vi.spyOn(handle, "writeFile").mockImplementationOnce(async (data, options) => {
      writing();
      await gate;
      return write(data, options);
    });
    return handle;
  });
  const model = { ...buildProviderModel({ id: "fixture", name: "Fixture", modelId: "fixture", apiKey: "fixture", baseUrl: "https://provider.invalid/v1", supportsReasoning: false, supportedThinkingLevels: ["off"] }), api: "openai-responses" as const };
  const abort = new AbortController();
  const image = { type: "response.output_item.done", output_index: 0, item: { type: "image_generation_call", id: "image", status: "completed", result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==" } };
  let callback: SimpleStreamOptions["onProviderStreamEvent"];
  try {
    const stream = withHostedImageOutputs(model, { signal: abort.signal }, path, imageOptions =>
      withModelOutputGuard(model, imageOptions, guarded => withProviderStreamIdleTimeout(model, guarded, 0, options => {
        callback = options.onProviderStreamEvent;
        const inner = createAssistantMessageEventStream();
        const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 1,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        inner.push({ type: "start", partial: message });
        void (async () => {
          await callback?.(image, model);
          inner.push({ type: "done", reason: "stop", message });
          inner.end(message);
        })();
        return inner;
      })));
    await started;
    abort.abort();
    release();
    const output = await stream.result();
    expect(output.stopReason).toBe("aborted");
    expect(output.content).toContainEqual(expect.objectContaining({ type: "text", text: expect.stringContaining(".png>") }));
    expect(await readdir(path)).toHaveLength(1);
    await callback?.({ ...image, item: { ...image.item, id: "late" } }, model);
    expect(await readdir(path)).toHaveLength(1);
  } finally {
    release();
    abort.abort();
    vi.restoreAllMocks();
    await rm(path, { recursive: true, force: true });
  }
});
