import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Models,
} from "@earendil-works/pi-ai";
import type { AgentEventEnvelope, SubagentDefinition } from "@pi-desktop/shared";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";

// Keep both parent and delegate pi loops real; replace only provider transport.
const transport = vi.hoisted(() => vi.fn<Models["streamSimple"]>());
vi.mock("./provider-binding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider-binding.js")>();
  return {
    ...actual,
    createProviderModels: (...args: Parameters<typeof actual.createProviderModels>) => {
      const models = actual.createProviderModels(...args);
      models.streamSimple = transport;
      return models;
    },
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const provider: RuntimeProviderConfig = {
  id: "fixture", name: "Fixture", apiKey: "", authKind: "none",
  baseUrl: "http://127.0.0.1:1/v1", modelId: "fixture", supportsReasoning: false,
  supportedThinkingLevels: ["off"],
};
const definition = (name: string, permission?: SubagentDefinition["permission"]): SubagentDefinition => ({
  name, permission, description: "Focused delegate", tools: ["Read", "Write"],
  prompt: "Perform the task and report.", source: "builtin",
});
function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
    timestamp: Date.now(), stopReason, content,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
function response(content: AssistantMessage["content"], stopReason: "stop" | "toolUse" = "stop") {
  const stream = createAssistantMessageEventStream();
  const result = message(content, stopReason);
  queueMicrotask(() => {
    stream.push({ type: "start", partial: result });
    stream.push({ type: "done", reason: stopReason, message: result });
    stream.end(result);
  });
  return stream;
}
const finalResponse = () => response([{ type: "text", text: "Finished the requested work." }]);
const runtimes: DesktopAgentRuntime[] = [];
const hostCall = async (method: string, _params?: unknown): Promise<unknown> => {
  if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false };
  if (method === "provider.delegationSnapshot" || method === "session.appendMessage") return undefined;
  if (method === "todos.get") return { sessionId: "delegate-boundaries", todos: [] };
  return { ok: true, content: {} };
};
function fixture(call = vi.fn(hostCall)) {
  const events: AgentEventEnvelope[] = [];
  const runtime = new DesktopAgentRuntime({
    host: { call, onNotification: () => () => {} } as never,
    sessionId: "delegate-boundaries", mode: "agent", thinkingLevel: "off", provider,
    workspaceRoot: "D:/fixture/session-worktree",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    subagents: [definition("inherited")],
    onEvent: (event) => events.push(event),
  });
  runtimes.push(runtime);
  return { runtime, internal: runtime as any };
}
beforeEach(() => { transport.mockReset().mockImplementation(finalResponse); });
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

// Event-loop deadline, not the resolver's outcome, is the cancellation oracle.
async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("operation did not retire before authorization")), 1000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

describe("Parent Stop waits for every delegate", () => {
  it.each(["waiting-model", "waiting-subagents"] as const)(
    "aborts every child and waits for their retirement while the parent is %s",
    async (phase) => {
      const streams = new Map<string, { signal?: AbortSignal; finish: () => void }>();
      const cleanups = new Map<string, { entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> }>();
      const call = vi.fn(async (method: string, params?: unknown) => {
        if (method === "worktree.delegate.create" || method === "worktree.delegate.settle") {
          const { delegationId } = params as { delegationId: string };
          if (method === "worktree.delegate.create") {
            cleanups.set(delegationId, { entered: deferred<void>(), release: deferred<void>() });
            return {};
          }
          const cleanup = cleanups.get(delegationId);
          if (!cleanup) throw new Error("Settlement has no fixture worktree");
          cleanup.entered.resolve();
          await cleanup.release.promise;
          return { settlement: { status: "kept" } };
        }
        return hostCall(method, params);
      });
      const { runtime, internal } = fixture(call);
      let parentRequests = 0;
      transport.mockImplementation((_model, context, options) => {
        const isParent = context.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Start both workers."));
        if (isParent) {
          if (++parentRequests === 1) return response(["A", "B"].map((id) => ({
            type: "toolCall" as const, id: `task-${id}`, name: "Task",
            arguments: { agent: "inherited", task: `Worker ${id}` },
          })), "toolUse");
          if (phase === "waiting-subagents") return finalResponse();
        }
        const stream = createAssistantMessageEventStream();
        const key = isParent
          ? "parent" : JSON.stringify(context.messages.at(-1)?.content);
        const finish = () => {
          const aborted = message([], "aborted");
          stream.push({ type: "error", reason: "aborted", error: aborted });
          stream.end(aborted);
        };
        options?.signal?.addEventListener("abort", finish, { once: true });
        streams.set(key, { signal: options?.signal, finish });
        return stream;
      });
      const running = runtime.prompt("Start both workers.");
      let stopping: Promise<void> | undefined;
      try {
        await vi.waitFor(() => {
          expect(parentRequests).toBe(2);
          expect(streams.size).toBe(phase === "waiting-model" ? 3 : 2);
          expect(cleanups.size).toBe(2);
          expect(runtime.getStatus().activity?.phase).toBe(phase);
        });
        let acknowledged = false;
        const cancellation = runtime.abort();
        expect(runtime.abort()).toBe(cancellation);
        stopping = cancellation.then(() => { acknowledged = true; });
        expect([...streams.values()].every((stream) => stream.signal?.aborted)).toBe(true);
        // Production retirement awaits Host worktree cleanup, not the raw stream.
        const children = [...cleanups.values()];
        await promptly(Promise.all(children.map(child => child.entered.promise)));
        expect(internal.runningDelegations()).toHaveLength(2);
        expect(runtime.getStatus().isRunning).toBe(true);
        expect(acknowledged).toBe(false);
        expect(call.mock.calls.filter(([method]) => method === "worktree.delegate.settle").map(([, params]) => params))
          .toEqual([...cleanups.keys()].map(delegationId => ({ sessionId: "delegate-boundaries", delegationId, merge: false })));
        children[0].release.resolve();
        await vi.waitFor(() => expect(internal.runningDelegations()).toHaveLength(1));
        expect(runtime.getStatus().isRunning).toBe(true);
        expect(acknowledged).toBe(false);
        await expect(runtime.prompt("Too soon.")).rejects.toMatchObject({ errorCode: "AGENT_BUSY" });
        children[1].release.resolve();
        await promptly(Promise.all([running, stopping]));
        expect(runtime.getStatus().isRunning).toBe(false);
        expect(internal.runningDelegations()).toHaveLength(0);
        expect(parentRequests).toBe(2);
        transport.mockImplementation(finalResponse);
        await promptly(runtime.prompt("Safe follow-up."));
      } finally {
        for (const cleanup of cleanups.values()) cleanup.release.resolve();
        for (const stream of streams.values()) stream.finish();
        await promptly(Promise.allSettled([running, stopping ?? runtime.abort()]));
      }
    },
  );
});
