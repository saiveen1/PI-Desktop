import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, normalizeContext, type AssistantMessage } from "@earendil-works/pi-ai";
import { DesktopAgentRuntime } from "./runtime.js";
import { subagentModelBinding } from "./subagent-model-binding.js";
import * as binding from "./provider-binding.js";
import * as outputGuard from "./model-output-guard.js";

function completed() {
  const message: AssistantMessage = {
    role: "assistant", content: [{ type: "text", text: "Completed." }], stopReason: "stop", timestamp: 1,
    api: "openai-completions", provider: "fixture", model: "fixture",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}
const provider: binding.RuntimeProviderConfig = {
  id: "fixture", name: "Fixture", modelId: "fixture", baseUrl: "http://provider.invalid/v1", apiKey: "", authKind: "none",
  supportsReasoning: false, supportedThinkingLevels: ["off"],
};
afterEach(() => vi.restoreAllMocks());

describe("output guard settings at stream boundaries", () => {
  it("passes the captured policy to main streams and takes reuse updates on the next turn", async () => {
    const wrapped = vi.spyOn(outputGuard, "withModelOutputGuard");
    const runtime = new DesktopAgentRuntime({
      sessionId: "settings-fixture", mode: "agent", thinkingLevel: "off", provider,
      agentOutputGuard: { earlyEndMode: "off", repetitiveOutputEnabled: false, recoveryLimit: 2 },
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      host: { async call<T>(method: string): Promise<T> {
        if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
        if (method === "todos.get") return { sessionId: "settings-fixture", todos: [] } as T;
        if (["provider.delegationSnapshot", "session.appendMessage", "project.instructions.resolve"].includes(method)) return undefined as T;
        throw new Error(`Unexpected Host method: ${method}`);
      } }, onEvent: () => {},
    });
    vi.spyOn(runtime["models"], "streamSimple").mockImplementation(() => completed());
    try {
      await runtime.prompt("Report status.");
      const firstPolicy = wrapped.mock.calls[0]?.[3];
      expect(firstPolicy).toMatchObject({ earlyEndMode: "off", repetitiveOutputEnabled: false, recoveryLimit: 2 });
      runtime.setAgentOutputGuard({ repetitiveOutputEnabled: true, repeatedParagraphMinRepeats: 7 });
      await runtime.prompt("Report status again.");
      expect(wrapped.mock.calls[1]?.[3]).toMatchObject({ earlyEndMode: "warn", repetitiveOutputEnabled: true, repeatedParagraphMinRepeats: 7, recoveryLimit: 1 });
      expect(firstPolicy?.repetitiveOutputEnabled).toBe(false);
    } finally { await runtime.dispose(); }
  });

  it("passes the same output settings into delegated model streams without a provider call", async () => {
    const createModels = binding.createProviderModels;
    vi.spyOn(binding, "createProviderModels").mockImplementation((...args) => {
      const models = createModels(...args);
      vi.spyOn(models, "streamSimple").mockImplementation(() => completed());
      return models;
    });
    const wrapped = vi.spyOn(outputGuard, "withModelOutputGuard");
    const settings = { repetitiveOutputEnabled: false, repeatedParagraphsEnabled: false, symbolMinChars: 16384 };
    const delegate = subagentModelBinding({ provider, sessionId: "settings-fixture", thinkingLevel: "off", agentOutputGuard: settings }, { claim: () => undefined });
    const stream = delegate.streamFn(delegate.model, normalizeContext({ messages: [{ role: "user", content: "Report status.", timestamp: 1 }] }), {});
    expect((await stream.result()).stopReason).toBe("stop");
    expect(wrapped.mock.calls[0]?.[3]).toEqual(settings);
  });
});
