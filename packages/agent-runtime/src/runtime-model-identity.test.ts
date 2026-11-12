import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import type { ContextCompactionRecord, UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";

type Options = ConstructorParameters<typeof DesktopAgentRuntime>[0];

function fixture(overrides: Partial<Options> = {}) {
  const journal: UiMessage[] = [];
  let checkpoint: ContextCompactionRecord | undefined;
  const runtime = new DesktopAgentRuntime({
    sessionId: "model-identity-fixture", mode: "agent", thinkingLevel: "off",
    provider: {
      id: "account-fixture", name: "Not the model ID", modelId: "vendor/model-A",
      apiKey: "secret-key-fixture", baseUrl: "https://private.fixture.invalid/v1",
      headers: { "X-Private": "secret-header-fixture" },
      supportsReasoning: false, supportedThinkingLevels: ["off"],
    },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: async <T>(method: string, params?: unknown): Promise<T> => {
      let result: unknown;
      if (method === "tools.fileBatchCapabilities") result = { version: 1, supported: false };
      else if (method === "provider.delegationSnapshot") result = undefined;
      else if (method === "session.appendMessage") journal.push((params as { message: UiMessage }).message);
      else if (method === "session.appendCompaction") checkpoint = (params as { compaction: ContextCompactionRecord }).compaction;
      else if (method === "extensions.commands.publish" || method === "extensions.diagnostics.publish") result = undefined;
      else if (method === "todos.get") result = { sessionId: "model-identity-fixture", todos: [] };
      else throw new Error(`Unexpected Host call: ${method}`);
      return result as T;
    } },
    onEvent: () => {},
    ...overrides,
  });
  const requests: Context[] = [];
  const streamMock = vi.spyOn(runtime["models"], "streamSimple").mockImplementation((model, context) => {
    requests.push(structuredClone(context));
    const message: AssistantMessage = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [{ type: "text", text: "Fixture reply." }], stopReason: "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    });
    return stream;
  });
  return { runtime, requests, journal, stream: streamMock.getMockImplementation()!, checkpoint: () => checkpoint };
}

function assertIdentity(context: Context, providerId: string, modelId: string) {
  const prompt = getCurrentSystemPrompt(context.messages);
  expect(prompt).toContain("# Current runtime model identity");
  expect(prompt).toContain(`Model ID: ${JSON.stringify(modelId)}`);
  expect(prompt).toContain(`Provider ID: ${JSON.stringify(providerId)}`);
  expect(prompt).toContain("AI-Model");
  expect(prompt).toContain("not proof of the upstream weights");
  return prompt;
}

describe("main-agent runtime model identity", () => {
  it.each(["agent", "plan"] as const)("exposes the exact request identity in %s without credentials", async mode => {
    const f = fixture({ mode, customSystemPrompt: { replace: "Custom persona.", append: "Custom appendix." } });
    try {
      await f.runtime.prompt("Which model are you? Use the exact ID for an AI-Model trailer.");
      expect(f.requests).toHaveLength(1);
      const prompt = assertIdentity(f.requests[0]!, "account-fixture", "vendor/model-A");
      expect(prompt).toContain("Custom persona.");
      expect(prompt).toContain("Custom appendix.");
      for (const secret of ["secret-key-fixture", "secret-header-fixture", "private.fixture.invalid", "Not the model ID"]) {
        expect(prompt).not.toContain(secret);
      }
    } finally { await f.runtime.dispose(); }
  });

  it("does not churn the prompt or journal when the binding stays unchanged", async () => {
    const f = fixture();
    try {
      await f.runtime.prompt("Identify yourself.");
      const rows = f.journal.length;
      await f.runtime.prompt("Identify yourself again.");
      const first = assertIdentity(f.requests[0]!, "account-fixture", "vendor/model-A");
      expect(getCurrentSystemPrompt(f.requests[1]!.messages)).toBe(first);
      expect(f.journal).toHaveLength(rows);
    } finally { await f.runtime.dispose(); }
  });

  it("replaces restored identity with the new binding without rewriting old records", async () => {
    const first = fixture();
    try {
      await first.runtime.prompt("Identify yourself.");
      const history = structuredClone(first.journal);
      const original = JSON.stringify(history);
      const next = fixture({ history, provider: {
        id: "second-account", name: "Second account", modelId: "vendor/model-B", apiKey: "fixture",
        baseUrl: "https://fixture.invalid/v1", supportsReasoning: false, supportedThinkingLevels: ["off"],
      } });
      try {
        await next.runtime.prompt("Continue with the selected model.");
        const prompt = assertIdentity(next.requests[0]!, "second-account", "vendor/model-B");
        expect(prompt).not.toContain("vendor/model-A");
        expect(JSON.stringify(history)).toBe(original);
        expect(next.journal.length).toBeGreaterThan(0);
      } finally { await next.runtime.dispose(); }
    } finally { await first.runtime.dispose(); }
  });

  it("refreshes identity when a trusted extension model is activated in place", async () => {
    const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "identity-extension-"));
    const entry = join(root, "fixture.mjs");
    await writeFile(entry, `export default pi => pi.registerAgent({
      id: "identity-agent", name: "Identity fixture", models: [{ id: "extension-model" }],
      complete: async () => { throw new Error("Provider boundary must be stubbed"); }
    });`);
    const f = fixture({ trustedExtensions: [{ id: entry, entry, label: "Identity fixture", source: "user", root }] });
    try {
      await f.runtime.prompt("Identify before the switch.");
      await f.runtime.loadTrustedExtensions();
      const registered = f.runtime["extensionRunner"]!.getAgents()[0]!;
      expect(registered).toBeDefined();
      expect(await f.runtime.activateTrustedExtensionAgent(registered.key, "extension-model")).toBe(true);
      vi.spyOn(f.runtime["models"], "streamSimple").mockImplementation(f.stream);
      await f.runtime.prompt("Identify after the switch.");
      const prompt = assertIdentity(f.requests[1]!, registered.providerId, "extension-model");
      expect(prompt).not.toContain("vendor/model-A");
    } finally {
      await f.runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains identity through a real compaction checkpoint and continuation", async () => {
    const f = fixture();
    const summary = vi.spyOn(f.runtime["models"], "completeSimple").mockResolvedValue({
      role: "assistant", api: "openai-completions", provider: "account-fixture", model: "vendor/model-A",
      content: [{ type: "text", text: "The previous task is complete." }], stopReason: "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    try {
      await f.runtime.prompt("Identify before compaction.");
      await f.runtime.compactManually();
      expect(summary).toHaveBeenCalled();
      expect(f.checkpoint()).toBeDefined();
      await f.runtime.prompt("Identify after compaction.");
      assertIdentity(f.requests[1]!, "account-fixture", "vendor/model-A");
    } finally { await f.runtime.dispose(); }
  });
});
