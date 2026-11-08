import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { DesktopAgentRuntime, toolResultFromUi } from "./runtime.js";
import { convertToLlm } from "./pi-runtime-messages.js";
import { normalizeToolResultContent } from "./tool-result-content.js";
import { activeToolSupportsImages, withToolImageCapability } from "./tool-image-context.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const image = { type: "image" as const, data: PNG, mimeType: "image/png" };
const raw = { path: "sample.png", text: "Image file sample.png", images: [image] };
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function model<A extends Api>(api: A, vision: boolean): Model<A> {
  return { id: "fixture", name: "Fixture", api, provider: "fixture", baseUrl: "https://fixture.invalid/v1",
    input: vision ? ["text", "image"] : ["text"], reasoning: false, contextWindow: 128000, maxTokens: 1024, cost };
}

function runtime(vision: boolean) {
  return new DesktopAgentRuntime({
    sessionId: "image-fixture", mode: "agent", thinkingLevel: "off", onEvent() {},
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    provider: { id: "fixture", name: "Fixture", baseUrl: "https://fixture.invalid/v1", modelId: "fixture", apiKey: "",
      authKind: "none", supportsReasoning: false, supportedThinkingLevels: [],
      modelConfig: { source: "generic", ...model("openai-completions", vision) } },
    host: { call: async <T>(method: string): Promise<T> => {
      const values: Record<string, unknown> = {
        "project.instructions.resolve": { entries: [] },
        "tools.fileBatchCapabilities": { version: 1, supported: false },
        "provider.delegationSnapshot": undefined,
        "session.appendMessage": undefined,
        "todos.get": { sessionId: "image-fixture", todos: [] },
        "tools.execute": { ok: true, content: raw },
      };
      if (!(method in values)) throw new Error(`Unexpected Host RPC: ${method}`);
      return values[method] as T;
    } },
  });
}
function readTool(owner: DesktopAgentRuntime): AgentTool {
  const state = (owner as unknown as { agent: { state: { tools: AgentTool[] } } }).agent.state;
  const tool = state.tools.find((item) => item.name === "Read");
  if (!tool) throw new Error("Read is not discoverable");
  return tool;
}
function restored(result: unknown): ToolResultMessage {
  return toolResultFromUi({ id: "image-result", role: "tool", content: "", createdAt: "2026-11-08T00:00:00Z",
    toolName: "Read", toolCallId: "call_read", toolStatus: "success", toolResult: result }, 1);
}

describe("tool image input contract", () => {
  it("keeps mixed image containers and plain text behavior consistent", () => {
    const result = normalizeToolResultContent({ content: [image], images: [image] }, true, true);
    expect(result.content.filter((block) => block.type === "image")).toEqual([image]);
    expect(normalizeToolResultContent({ content: [], images: [image] }, true, true).content).toEqual([image]);
    expect(normalizeToolResultContent("", true, true).content).toEqual([{ type: "text", text: "" }]);
    expect(normalizeToolResultContent({ ok: true }, true).content).toEqual([{ type: "text", text: '{"ok":true}' }]);
  });

  it("describes local raster reads and preserves source bytes and legacy imageCount", async () => {
    const owner = runtime(true);
    try {
      const read = readTool(owner);
      expect(read.description).toMatch(/PNG, JPEG, GIF, or WebP/);
      const result = await read.execute("call_read", { path: "sample.png" });
      expect(result.content).toContainEqual(image);
      expect(result.details).toMatchObject({ images: [image], imageCount: 1,
        imageInput: { imageCount: 1, includedCount: 1, issues: [] } });
      expect(restored(JSON.parse(JSON.stringify(result))).content).toContainEqual(image);
    } finally { await owner.dispose(); }
  });

  it.each([true, false])("uses the delegate's capability instead of a %s-vision parent's", async (parentVision) => {
    const owner = runtime(parentVision);
    try {
      const child = withToolImageCapability(readTool(owner), () => !parentVision);
      const result = await child.execute("child", { path: "sample.png" });
      expect(result.content.some((block) => block.type === "image")).toBe(!parentVision);
      expect(result.details).toMatchObject({ images: [image], imageInput: { includedCount: parentVision ? 0 : 1 } });
      expect(activeToolSupportsImages(parentVision)).toBe(parentVision);
      const parent = await readTool(owner).execute("parent", { path: "sample.png" });
      expect(parent.content.some((block) => block.type === "image")).toBe(parentVision);
    } finally { await owner.dispose(); }
  });

  it("isolates parallel image capabilities across awaits and releases them on rejection", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const tool: AgentTool = { name: "fixture", label: "fixture", description: "fixture", parameters: {},
      execute: async (id) => {
        await barrier;
        if (id === "reject") throw new Error("fixture failure");
        return { content: [{ type: "text", text: String(activeToolSupportsImages(false)) }], details: {} };
      } };
    const yes = withToolImageCapability(tool, () => true).execute("yes", {});
    const no = withToolImageCapability(tool, () => false).execute("no", {});
    release();
    expect((await yes).content).toEqual([{ type: "text", text: "true" }]);
    expect((await no).content).toEqual([{ type: "text", text: "false" }]);
    await expect(withToolImageCapability(tool, () => true).execute("reject", {})).rejects.toThrow("fixture failure");
    expect(activeToolSupportsImages(false)).toBe(false);
  });

  it("reports malformed MIME/base64, byte excess and pixel excess without altering originals", () => {
    const tall = Buffer.from(PNG, "base64"); tall.writeUInt32BE(9001, 20);
    const huge = Buffer.alloc(10_000_001); Buffer.from(PNG, "base64").copy(huge);
    const inputs = [image, { ...image, mimeType: "text/html" }, { ...image, data: "ab=c" },
      { ...image, data: huge.toString("base64") }, { ...image, data: tall.toString("base64") }];
    const result = normalizeToolResultContent({ images: inputs }, true);
    expect(result.imageInput?.includedCount).toBe(1);
    expect(result.imageInput?.issues.map(({ index, code }) => ({ index, code }))).toEqual([
      { index: 1, code: "IMAGE_INVALID" }, { index: 2, code: "IMAGE_INVALID" },
      { index: 3, code: "IMAGE_TOO_LARGE" }, { index: 4, code: "IMAGE_TOO_LARGE" },
    ]);
    expect(result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")).not.toContain(PNG);
    expect(inputs[0]).toEqual(image);
  });

  for (const api of ["openai-responses", "openai-completions", "anthropic-messages"] as const) {
    it.each([true, false])(`serializes real tool image bytes on ${api} only for vision=%s`, async (vision) => {
      const owner = runtime(vision);
      try {
        const result = await readTool(owner).execute("call_read", { path: "sample.png" });
        const call: AssistantMessage = { role: "assistant", api, provider: "fixture", model: "fixture", stopReason: "toolUse",
          timestamp: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...cost, total: 0 } },
          content: [{ type: "toolCall", id: "call_read", name: "Read", arguments: { path: "sample.png" } }] };
        const context = normalizeContext({ messages: convertToLlm([
          { role: "user", content: "Inspect the saved image", timestamp: 0 }, call, restored(result),
        ], vision) });
        const requests: unknown[] = [];
        const options = { apiKey: "fixture-key", maxRetries: 0, fetch: async (_url: unknown, init?: RequestInit) => {
          requests.push(JSON.parse(String(init?.body)));
          return new Response('{"error":{"message":"fixture complete"}}', { status: 400, headers: { "content-type": "application/json" } });
        } };
        if (api === "openai-responses") await responses(model(api, vision), context, options).result();
        else if (api === "openai-completions") await completions(model(api, vision), context, options).result();
        else await anthropic(model(api, vision), context, options).result();
        expect(requests).toHaveLength(1);
        const body = JSON.stringify(requests[0]);
        if (vision) {
          expect(body).toContain(PNG);
          expect(body).toContain(api === "anthropic-messages" ? '"type":"base64"' : `data:image/png;base64,${PNG}`);
        } else {
          expect(body).not.toContain(PNG);
          expect(body).toContain("does not support image input");
        }
      } finally { await owner.dispose(); }
    });
  }
});
