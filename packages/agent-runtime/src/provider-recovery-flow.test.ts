import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import { SubagentRun } from "./subagent.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

const provider: RuntimeProviderConfig = {
  id: "fixture",
  name: "Fixture",
  modelId: "fixture-model",
  baseUrl: "http://provider.invalid/v1",
  apiKey: "fixture-only",
  apiStyle: "chat_completions",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
};

type Failure = "network" | "rate-limit" | "stream" | "unknown-upstream" | "bad-request";
type Step = Failure | "tool" | "success" | "stall" | "hold-stream";

/** Real provider adapter and agent loop; replace only fetch and the host edge. */
function fixture(steps: Step[], retryAfterMs = 1, recovery: {
  unknownUpstreamRetryLimit?: number;
  infiniteProviderRetry?: boolean;
  providerStreamIdleTimeoutMinutes?: number;
} = {}, childSignal?: AbortSignal) {
  let requests = 0;
  let reads = 0;
  let abortedRequests = 0;
  const startedAborted: boolean[] = [];
  const events: AgentEventEnvelope[] = [];
  let heldStream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
    startedAborted.push(init?.signal?.aborted === true);
    const step = steps[requests++];
    if (!step) throw new Error("Unexpected provider request");
    if (step === "stall") {
      const signal = init?.signal;
      if (!signal) throw new Error("The fixture request needs an abort signal");
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          abortedRequests++;
          reject(new DOMException("Request aborted", "AbortError"));
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }
    if (step === "network") throw new TypeError("fetch failed");
    if (step === "unknown-upstream" || step === "bad-request") {
      return new Response(JSON.stringify({ error: step === "unknown-upstream"
        ? { code: "upstream_400", message: "Upstream returned status 400" }
        : { code: "invalid_request_error", message: "Invalid parameter: temperature" } }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }
    if (step === "rate-limit")
      return new Response("Rate limited", {
        status: 429,
        headers: { "retry-after-ms": String(retryAfterMs) },
      });
    const delta =
      step === "tool"
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${requests}`,
                type: "function",
                function: { name: "Read", arguments: '{"path":"fixture.txt"}' },
              },
            ],
          }
        : { role: "assistant", content: step === "stream" ? "partial" : "Recovered" };
    const chunk = (value: unknown, finish: string | null) =>
      `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
    if (step === "hold-stream") {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { heldStream = controller; },
        cancel() { abortedRequests++; },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    if (step === "stream") {
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(new TextEncoder().encode(chunk(delta, null)));
            } else controller.error(new Error("terminated"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return new Response(
      chunk(delta, null) +
        chunk({}, step === "tool" ? "tool_calls" : "stop") +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  vi.stubGlobal("fetch", fetch);
  const runtime = new DesktopAgentRuntime({
    sessionId: "fixture-session",
    mode: "agent",
    provider,
    ...recovery,
    thinkingLevel: "off",
    commandShell: {
      id: "bash",
      label: "Bash",
      dialect: "posix",
      available: true,
      isDefault: true,
    },
    host: {
      async call<T>(method: string): Promise<T> {
        if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
        if (method === "session.appendMessage") return undefined as T;
        if (method === "provider.delegationSnapshot") return undefined as T;
        if (method === "todos.get") return { sessionId: "fixture-session", todos: [] } as T;
        if (method !== "tools.execute")
          throw new Error(`Unexpected host method: ${method}`);
        reads++;
        return { ok: true, content: "fixture contents" } as T;
      },
    },
    onEvent: (event) => events.push(event),
  });
  const subagent = new SubagentRun({
    definition: {
      name: "fixture",
      description: "Read fixture",
      prompt: "Read fixture",
      source: "builtin",
      tools: ["Read"],
    },
    sessionId: "fixture-session",
    parentToolCallId: "task",
    task: "Read fixture",
    provider,
    ...recovery,
    signal: childSignal,
    thinkingLevel: "off",
    systemPrompt: "Read and report",
    tools: [
      {
        name: "Read",
        label: "Read",
        description: "Read fixture",
        parameters: Type.Object({ path: Type.String() }),
        execute: async () => {
          reads++;
          return { content: [{ type: "text", text: "fixture contents" }], details: {} };
        },
      },
    ],
    onEvent: (event) => events.push(event),
  });
  return { runtime, subagent, events, requests: () => requests, reads: () => reads,
    abortedRequests: () => abortedRequests, startedAborted, heldStream: () => heldStream };
}

async function settle<T>(promise: Promise<T>, seconds = 180): Promise<T> {
  let settled = false;
  // Attach handlers before advancing clocks so expected terminal rejections
  // never become unhandled rejections in the test process.
  const observed = promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  void observed.then(() => {
    settled = true;
  });
  for (let tick = 0; tick < seconds && !settled; tick++)
    await vi.advanceTimersByTimeAsync(1000);
  expect(settled, "run settles inside the bounded recovery window").toBe(true);
  const result = await observed;
  if ("error" in result) throw result.error;
  return result.value;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("provider recovery through real agent loops (#699)", () => {
  for (const owner of ["session", "subagent"] as const) {
    it(`${owner} recovers an enabled unknown upstream failure without replaying a successful tool`, async () => {
      vi.useFakeTimers();
      const f = fixture(["tool", "unknown-upstream", "success"], 1, { unknownUpstreamRetryLimit: 1 });
      try {
        if (owner === "session") await settle(f.runtime.prompt("Read and report."));
        else expect((await settle(f.subagent.run())).status).toBe("completed");
        expect(f.requests()).toBe(3);
        expect(f.reads()).toBe(1);
        expect(f.events.filter(({ event }) => event.type === "error")).toHaveLength(0);
      } finally { await f.runtime.dispose(); }
    });

    it.each(["unknown-upstream", "bad-request"] as const)(
      `${owner} keeps %s terminal by default, even with infinite transient retries`, async failure => {
        vi.useFakeTimers();
        const f = fixture([failure], 1, { infiniteProviderRetry: true });
        try {
          if (owner === "session") await settle(f.runtime.prompt("Report."));
          else expect((await settle(f.subagent.run())).status).toBe("failed");
          expect(f.requests()).toBe(1);
        } finally { await f.runtime.dispose(); }
      },
    );

    it(`${owner} exhausts the independent unknown-error ceiling despite infinite transient retry`, async () => {
      vi.useFakeTimers();
      const f = fixture(["unknown-upstream", "unknown-upstream", "unknown-upstream"], 1, {
        unknownUpstreamRetryLimit: 2, infiniteProviderRetry: true,
      });
      try {
        if (owner === "session") await settle(f.runtime.prompt("Report."));
        else expect((await settle(f.subagent.run())).status).toBe("failed");
        expect(f.requests()).toBe(3);
        expect(f.reads()).toBe(0);
        if (owner === "session") {
          expect(f.events.filter(({ event }) => event.type === "error")).toHaveLength(1);
          expect(f.events.find(({ event }) => event.type === "error")?.event).toMatchObject({
            error: { code: "PROVIDER_ERROR", details: { retryAttempt: 2, recoveryCategory: "unknown-upstream" } },
          });
          const activities = f.events.flatMap(({ event }) => event.type === "status" && event.status.activity?.phase === "retrying"
            ? [event.status.activity] : []);
          expect(activities.map(activity => activity.attempt)).toEqual([1, 2]);
          expect(activities.every(activity => !activity.infinite)).toBe(true);
        }
      } finally { await f.runtime.dispose(); }
    });

    it(`${owner} cancels unknown-upstream backoff without another request`, async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const f = fixture(["unknown-upstream"], 1, { unknownUpstreamRetryLimit: 1 }, controller.signal);
      try {
        const running: Promise<unknown> = owner === "session" ? f.runtime.prompt("Report.") : f.subagent.run();
        await vi.waitFor(() => expect(f.events.some(({ event }) => event.type === "status"
          && event.status.activity?.phase === "retrying")).toBe(true));
        if (owner === "session") await f.runtime.abort();
        else controller.abort();
        await settle(running);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(f.requests()).toBe(1);
      } finally { controller.abort(); await f.runtime.dispose(); }
    });
  }

  for (const [idleTimeout, failures] of [[180_000, 10], [30_000, 1]] as const) {
    it(`keeps ${failures} rate-limit waits outside the ${idleTimeout}ms stream idle budget`, async () => {
      vi.useFakeTimers();
      vi.stubEnv("PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS", String(idleTimeout));
      const f = fixture([...Array<Step>(failures).fill("rate-limit"), "success"], 30_000);
      try {
        await settle(f.runtime.prompt("Report after the provider becomes available."), 400);
        expect(f.requests()).toBe(failures + 1);
        expect(f.events.filter((event) => event.event.type === "error")).toHaveLength(0);
        expect(f.events.some(({ event }) => event.type === "message_end" &&
          event.message.content === "Recovered" && event.message.status === "complete")).toBe(true);
        const attempts = f.events.flatMap(({ event }) =>
          event.type === "status" && event.status.activity?.phase === "retrying"
            ? [event.status.activity.attempt] : []);
        expect(attempts).toEqual(Array.from({ length: failures }, (_, index) => index + 1));
      } finally {
        await f.runtime.dispose();
      }
    });
  }

  it.each([false, true])("does not replay a local idle timeout (infinite retry=%s)", async (infiniteProviderRetry) => {
    vi.useFakeTimers();
    const f = fixture(["stall"], 1, { providerStreamIdleTimeoutMinutes: 1, infiniteProviderRetry });
    try {
      await settle(f.runtime.prompt("Wait for the provider."));
      expect(f.requests()).toBe(1);
      expect(f.abortedRequests()).toBe(1);
      const errors = f.events.filter(({ event }) => event.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.event).toMatchObject({
        type: "error", error: { code: "PROVIDER_STREAM_IDLE_TIMEOUT", retriable: false,
          details: { origin: "local", idleTimeoutMs: 60_000, responseBytes: 0 } },
      });
      expect(f.events.filter(({ event }) => event.type === "agent_end")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(f.requests()).toBe(1);
    } finally { await f.runtime.dispose(); }
  });

  for (const owner of ["session", "subagent"] as const) {
    for (const failure of ["network", "rate-limit", "stream"] as const) {
      it(`${owner} recovers independent ${failure} outages across eleven successful tool rounds`, async () => {
        vi.useFakeTimers();
        const f = fixture([
          ...Array.from({ length: 11 }, (): Step[] => [failure, "tool"]).flat(),
          failure,
          "success",
        ]);
        try {
          if (owner === "session")
            await settle(f.runtime.prompt("Read repeatedly, then report."));
          else expect((await settle(f.subagent.run())).status).toBe("completed");
          expect(f.reads()).toBe(11);
          expect(f.requests()).toBe(24);
          expect(f.events.filter((e) => e.event.type === "error")).toHaveLength(0);
          expect(
            f.events.some(
              (e) =>
                e.event.type === "message_end" &&
                e.event.message.content === "Recovered" &&
                e.event.message.status === "complete",
            ),
          ).toBe(true);
          if (owner === "session") {
            const retryAttempts = f.events.flatMap((e) =>
              e.event.type === "status" && e.event.status.activity?.phase === "retrying"
                ? [e.event.status.activity.attempt]
                : [],
            );
            expect(retryAttempts).toEqual(Array(12).fill(1));
          }
        } finally {
          await f.runtime.dispose();
        }
      });
    }
  }

  it("keeps failures bounded after a recovered tool response and reports the exhausted budget", async () => {
    vi.useFakeTimers();
    const f = fixture(["network", "tool", ...Array<Step>(11).fill("network")]);
    try {
      await settle(f.runtime.prompt("Read, then report."));
      expect(f.reads()).toBe(1);
      expect(f.requests()).toBe(13);
      const errors = f.events.filter((e) => e.event.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.event).toMatchObject({
        type: "error",
        error: { code: "NETWORK_ERROR", details: { retryAttempt: 10 } },
      });
      expect(f.events.filter((e) => e.event.type === "agent_end")).toHaveLength(1);
    } finally {
      await f.runtime.dispose();
    }
  });

  for (const owner of ["session", "subagent"] as const) {
    it(`${owner} does not replenish the budget on partial output or a phase change`, async () => {
      vi.useFakeTimers();
      const f = fixture(
        Array.from({ length: 11 }, (_, i): Step => (i % 2 ? "stream" : "network")),
      );
      try {
        if (owner === "session") {
          await settle(f.runtime.prompt("Report."));
          expect(f.events.filter((e) => e.event.type === "error")).toEqual([
            expect.objectContaining({
              event: expect.objectContaining({
                error: expect.objectContaining({
                  details: expect.objectContaining({ retryAttempt: 10 }),
                }),
              }),
            }),
          ]);
        } else expect((await settle(f.subagent.run())).status).toBe("failed");
        expect(f.requests()).toBe(11);
        expect(f.reads()).toBe(0);
      } finally {
        await f.runtime.dispose();
      }
    });
  }

  it.each(["network", "rate-limit"] as const)("cancels a %s retry wait without opening another provider request", async (failure) => {
    vi.useFakeTimers();
    const f = fixture([failure], 30_000);
    try {
      const prompt = f.runtime.prompt("Report.").catch((error) => error);
      await vi.waitFor(() =>
        expect(
          f.events.some(
            (e) =>
              e.event.type === "status" && e.event.status.activity?.phase === "retrying",
          ),
        ).toBe(true),
      );
      await f.runtime.abort();
      await settle(prompt);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.requests()).toBe(1);
      expect(f.events.filter((e) => e.event.type === "agent_end")).toHaveLength(1);
      expect(
        f.events.some(
          (e) => e.event.type === "error" && e.event.error.code === "NETWORK_ERROR",
        ),
      ).toBe(false);
    } finally {
      await f.runtime.dispose();
    }
  });
});

describe("main-turn diagnostics through real provider recovery", () => {
  it("retains retries across tool requests, freezes the final snapshot and resets the next turn", async () => {
    vi.useFakeTimers();
    const f = fixture(["rate-limit", "tool", "stream", "success", "success"]);
    const startedAt = Date.now();
    try {
      await settle(f.runtime.prompt("Read, then report.", undefined, "diagnostic-turn-a"));
      const final = f.runtime.getStatus().runDiagnostics;
      expect(final).toMatchObject({
        turnId: "diagnostic-turn-a", startedAt, requestCount: 2, attemptCount: 4,
        requestAttempt: 2, retryCount: 2, rateLimitRetries: 1, transientRetries: 1,
        lastRetry: { code: "STREAM_FAILED" },
      });
      expect(final?.endedAt).toBeTypeOf("number");
      expect(final?.lastTextAt).toBeTypeOf("number");
      expect(final?.inputTokens).toBeGreaterThan(0);
      expect(final?.retryWaitMs).toBeGreaterThan(0);
      expect(f.events.some(({ event }) => event.type === "status" && event.status.runDiagnostics?.phase === "tool")).toBe(true);
      const refresh = f.events.filter(({ event }) => event.type === "message_update" &&
        event.message.runDiagnostics?.endedAt !== undefined).at(-1);
      expect(refresh?.event).toMatchObject({ type: "message_update", message: {
        content: "Recovered", status: "complete", runDiagnostics: final,
      } });
      expect(f.events.filter(({ event }) => event.type === "message_end" &&
        event.message.role === "assistant")).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.runtime.getStatus().runDiagnostics).toEqual(final);
      await settle(f.runtime.prompt("Report again.", undefined, "diagnostic-turn-b"));
      expect(f.runtime.getStatus().runDiagnostics).toMatchObject({
        turnId: "diagnostic-turn-b", requestCount: 1, attemptCount: 1,
        requestAttempt: 1, retryCount: 0, rateLimitRetries: 0, transientRetries: 0,
      });
      expect(f.runtime.getStatus().runDiagnostics?.lastRetry).toBeUndefined();
    } finally { await f.runtime.dispose(); }
  });

  it("cancels backoff with actual elapsed wait and no extra attempt", async () => {
    vi.useFakeTimers();
    const f = fixture(["rate-limit"], 30_000);
    try {
      const prompt = f.runtime.prompt("Report.").catch(error => error);
      await vi.waitFor(() => expect(f.runtime.getStatus().activity?.phase).toBe("retrying"));
      const retrySince = f.runtime.getStatus().activity?.since ?? 0;
      await vi.advanceTimersByTimeAsync(137);
      await f.runtime.abort();
      await settle(prompt);
      const final = f.runtime.getStatus().runDiagnostics;
      expect(final?.retryWaitMs).toBe((final?.endedAt ?? 0) - retrySince);
      expect(final?.retryWaitMs).toBeLessThan(30_000);
      expect(final).toMatchObject({ requestCount: 1, attemptCount: 1, retryCount: 1 });
      expect(f.requests()).toBe(1);
    } finally { await f.runtime.dispose(); }
  });

  it("does not invent an event or answer timestamp before the provider responds", async () => {
    vi.useFakeTimers();
    const f = fixture(["stall"]);
    try {
      const startedAt = Date.now();
      const prompt = f.runtime.prompt("Wait.").catch(error => error);
      await vi.waitFor(() => expect(f.requests()).toBe(1));
      expect(f.runtime.getStatus().runDiagnostics).toMatchObject({ startedAt, requestCount: 1, attemptCount: 1 });
      expect(f.runtime.getStatus().runDiagnostics?.lastEventAt).toBeUndefined();
      expect(f.runtime.getStatus().runDiagnostics?.lastTextAt).toBeUndefined();
      await f.runtime.abort();
      await settle(prompt);
    } finally { await f.runtime.dispose(); }
  });
});

it("a local idle watchdog does not fabricate a recent model event", async () => {
  vi.useFakeTimers();
  vi.stubEnv("PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS", "30000");
  const f = fixture(["stall"]);
  try {
    const prompt = f.runtime.prompt("Wait.").catch(error => error);
    await vi.waitFor(() => expect(f.requests()).toBe(1));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.runtime.getStatus().activity?.phase).not.toBe("retrying");
    expect(f.events.some(({ event }) => event.type === "error" && event.error.code === "PROVIDER_STREAM_IDLE_TIMEOUT")).toBe(true);
    expect(f.runtime.getStatus().runDiagnostics?.lastEventAt).toBeUndefined();
    expect(f.runtime.getStatus().runDiagnostics?.lastTextAt).toBeUndefined();
    await f.runtime.abort();
    await settle(prompt);
  } finally { await f.runtime.dispose(); }
});

function heldChunk(delta: unknown, finish: string | null = null): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify({ id: "held", object: "chat.completion.chunk", created: 1,
    model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}

it("keeps raw heartbeats alive past three minutes, shows a waiting hint and clears it on real output", async () => {
  vi.useFakeTimers();
  const f = fixture(["hold-stream"], 1, { providerStreamIdleTimeoutMinutes: 3 });
  try {
    const prompt = f.runtime.prompt("Think for a long time.");
    await vi.waitFor(() => expect(f.heldStream()).toBeDefined());
    await vi.advanceTimersByTimeAsync(0);
    for (let tick = 0; tick < 4; tick++) {
      await vi.advanceTimersByTimeAsync(60_000);
      f.heldStream()!.enqueue(new TextEncoder().encode(": keepalive\n\n"));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(f.requests()).toBe(1);
    expect(f.abortedRequests()).toBe(0);
    expect(f.runtime.getStatus().activity).toMatchObject({ phase: "waiting-model", slow: true });
    expect(f.events.filter(({ event }) => event.type === "error")).toHaveLength(0);
    f.heldStream()!.enqueue(heldChunk({ role: "assistant", content: "Long answer" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.runtime.getStatus().activity).not.toMatchObject({ slow: true });
    f.heldStream()!.enqueue(heldChunk({}, "stop"));
    f.heldStream()!.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
    f.heldStream()!.close();
    await settle(prompt);
    expect(f.events.some(({ event }) => event.type === "message_end" && event.message.content === "Long answer" && event.message.status === "complete")).toBe(true);
  } finally { await f.runtime.dispose(); }
});

it("preserves partial text in a terminal idle error without replay or incomplete tool execution", async () => {
  vi.useFakeTimers();
  const f = fixture(["hold-stream"], 1, { providerStreamIdleTimeoutMinutes: 1, infiniteProviderRetry: true });
  try {
    const prompt = f.runtime.prompt("Report.");
    await vi.waitFor(() => expect(f.heldStream()).toBeDefined());
    f.heldStream()!.enqueue(heldChunk({ role: "assistant", content: "Keep this partial answer" }));
    f.heldStream()!.enqueue(heldChunk({ tool_calls: [{ index: 0, id: "partial-tool", type: "function",
      function: { name: "Read", arguments: '{"path":' } }] }));
    await settle(prompt);
    expect(f.events.some(({ event }) => event.type === "message_end" && event.message.content === "Keep this partial answer" && event.message.status === "error")).toBe(true);
    expect(f.events.filter(({ event }) => event.type === "error")).toHaveLength(1);
    expect(f.requests()).toBe(1);
    expect(f.reads()).toBe(0);
    expect(f.abortedRequests()).toBe(1);
  } finally { await f.runtime.dispose(); }
});

it("applies updated idle settings to a reused runtime's next request, not its active attempt", async () => {
  vi.useFakeTimers();
  const f = fixture(["stall", "stall"], 1, { providerStreamIdleTimeoutMinutes: 0 });
  try {
    const first = f.runtime.prompt("Wait until stopped.");
    await vi.waitFor(() => expect(f.requests()).toBe(1));
    f.runtime.setProviderStreamIdleTimeoutMinutes(1);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(f.abortedRequests()).toBe(0);
    await f.runtime.abort();
    await settle(first);
    const eventOffset = f.events.length;
    await settle(f.runtime.prompt("Use the new timeout."));
    expect(f.requests()).toBe(2);
    expect(f.events.slice(eventOffset).some(({ event }) => event.type === "error" && event.error.code === "PROVIDER_STREAM_IDLE_TIMEOUT")).toBe(true);
  } finally { await f.runtime.dispose(); }
});
