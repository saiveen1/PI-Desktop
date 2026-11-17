import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { normalizeContext, type Model, type Api, type Context, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { stream as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "../runtime.js";
import { subagentModelBinding } from "../subagent-model-binding.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==";
const roots: string[] = [];
const instances: DesktopAgentRuntime[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map(runtime => runtime.dispose()));
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function response(text = "Here is your cat.", image = png): Response {
  const picture = { id: "ig_fixture", type: "image_generation_call", status: "completed", result: image, output_format: "png" };
  const message = { id: "msg_fixture", type: "message", role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: "resp_fixture" } },
    { type: "response.output_item.added", output_index: 0, item: { ...picture, result: null, status: "in_progress" } },
    { type: "response.output_item.done", output_index: 0, item: picture },
    ...(text ? [
      { type: "response.output_item.added", output_index: 1, item: { ...message, content: [] } },
      { type: "response.output_text.delta", output_index: 1, content_index: 0, delta: text },
      { type: "response.output_item.done", output_index: 1, item: message },
    ] : []),
    { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [picture, ...(text ? [message] : [])], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

async function fixture(text?: string, image?: string, history: UiMessage[] = [], defaultRecovery = false) {
  const scratchDir = await mkdtemp(join(tmpdir(), "hosted-image-runtime-"));
  roots.push(scratchDir);
  const events: AgentEventEnvelope[] = [];
  const requests: Context[] = [];
  const runtime = new DesktopAgentRuntime({
    host: { async call<T>(method: string): Promise<T> {
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
      if (method === "provider.delegationSnapshot" || method === "session.appendMessage") return undefined as T;
      if (method === "todos.get") return { sessionId: "image-fixture", todos: [] } as T;
      return undefined as T;
    } },
    sessionId: "image-fixture", mode: "agent", scratchDir, history, thinkingLevel: "off",
    provider: { id: "fixture", name: "Fixture", modelId: "fixture", apiStyle: "responses", apiKey: "fixture-only", baseUrl: "https://provider.invalid/v1", supportsReasoning: false, supportedThinkingLevels: ["off"] },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    ...(!defaultRecovery ? { agentOutputGuard: { earlyEndMode: "off" as const, recoveryLimit: 0 }, autoContinueUnfinishedTodos: false } : {}),
    onEvent: event => events.push(event),
  });
  // Replace only the external transport, retaining the real Responses parser and runtime wiring.
  const streamSimple = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
    requests.push(structuredClone(context));
    return streamResponses({ ...model, api: "openai-responses" }, normalizeContext(context), {
      ...options, apiKey: "fixture-only", fetch: async () => response(text, image),
    });
  };
  (runtime as unknown as { models: { streamSimple: typeof streamSimple } }).models = { streamSimple };
  instances.push(runtime);
  return { runtime, events, requests, scratchDir };
}
function finalAssistant(events: AgentEventEnvelope[]): UiMessage | undefined {
  return events.flatMap(({ event }) => event.type === "message_end" && event.message.role === "assistant" ? [event.message] : []).at(-1);
}

it("delivers native Responses images through the public prompt path without another generation", async () => {
  const run = await fixture();
  await run.runtime.prompt("Draw a cat.", "user", "turn");
  expect(run.requests).toHaveLength(1);
  const message = finalAssistant(run.events);
  expect(message?.content).toContain("Here is your cat.");
  expect(message?.content).toMatch(/!\[[^\]]+\]\(<[^>]+\.png>\)/);
  const files = await readdir(run.scratchDir);
  expect(files).toHaveLength(1);
  expect(await readFile(join(run.scratchDir, files[0]))).toEqual(Buffer.from(png, "base64"));
  expect(JSON.stringify(message)).not.toContain(png);
  expect(message?.status).toBe("complete");
});

it("does not rerun an image-only successful reply as a silent response", async () => {
  const run = await fixture("");
  await run.runtime.prompt("Draw a cat.", "user", "turn");
  expect(run.requests).toHaveLength(1);
  expect(finalAssistant(run.events)?.content).toContain(".png>");
  expect(finalAssistant(run.events)?.status).toBe("complete");
});

it("does not replay invalid native image output through the main recovery loop", async () => {
  const run = await fixture("", "invalid-image", [], true);
  await run.runtime.prompt("Draw a cat.", "user", "turn");
  expect(run.requests).toHaveLength(1);
  expect(finalAssistant(run.events)?.status).toBe("error");
  expect(await readdir(run.scratchDir)).toEqual([]);
});

it("restores generated references without putting image bytes in model replay", async () => {
  const first = await fixture();
  await first.runtime.prompt("Draw a cat.", "user", "turn");
  const saved = finalAssistant(first.events)!;
  const restored = await fixture("Another cat.", png, [JSON.parse(JSON.stringify(saved))]);
  await restored.runtime.prompt("Draw another cat.", "user-2", "turn-2");
  expect(restored.requests).toHaveLength(1);
  const replay = JSON.stringify(restored.requests[0]);
  expect(replay).toContain("generated-");
  expect(replay).not.toContain(png);
  expect(await readdir(first.scratchDir)).toHaveLength(1);
});

it("uses the same native image delivery path for subagent model bindings", async () => {
  const scratchDir = await mkdtemp(join(tmpdir(), "hosted-image-delegate-"));
  roots.push(scratchDir);
  const binding = subagentModelBinding({
    provider: { id: "fixture", name: "Fixture", modelId: "fixture", apiStyle: "responses", apiKey: "fixture-only", baseUrl: "https://provider.invalid/v1", supportsReasoning: false, supportedThinkingLevels: ["off"] },
    sessionId: "image-delegate", thinkingLevel: "off", scratchDir,
  }, { claim: () => undefined });
  let requests = 0;
  const stream = await binding.streamFn(binding.model, normalizeContext({ messages: [{ role: "user", content: "Draw a cat", timestamp: 1 }] }), {
    fetch: async () => { requests++; return response(""); },
  });
  const result = await stream.result();
  expect(requests).toBe(1);
  expect(result.stopReason).toBe("stop");
  expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: expect.stringContaining(".png>") }));
  expect(await readdir(scratchDir)).toHaveLength(1);
});

it("surfaces failed native image delivery in a subagent without another request", async () => {
  const scratchDir = await mkdtemp(join(tmpdir(), "hosted-image-delegate-error-"));
  roots.push(scratchDir);
  const binding = subagentModelBinding({
    provider: { id: "fixture", name: "Fixture", modelId: "fixture", apiStyle: "responses", apiKey: "fixture-only", baseUrl: "https://provider.invalid/v1", supportsReasoning: false, supportedThinkingLevels: ["off"] },
    sessionId: "image-delegate", thinkingLevel: "off", scratchDir,
  }, { claim: () => { throw new Error("Unexpected automatic image replay"); } });
  let requests = 0;
  const stream = await binding.streamFn(binding.model, normalizeContext({ messages: [{ role: "user", content: "Draw a cat", timestamp: 1 }] }), {
    fetch: async () => { requests++; return response("", "invalid-image"); },
  });
  const result = await stream.result();
  expect(requests).toBe(1);
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("IMAGE_INVALID_RESPONSE");
  expect(await readdir(scratchDir)).toEqual([]);
});
