import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { type AgentEventEnvelope, type ObserverGuardAssessment, type UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime, type AgentRuntimeOptions } from "./runtime.js";
import type { ObserverGuardRuntimeConfig } from "./observer-guard.js";
import { completeOneShot, type OneShotCompleteResult } from "./one-shot-complete.js";
import { PROVIDER_TRANSIENT_MAX_RETRIES, PROVIDER_RATE_LIMIT_MAX_RETRIES } from "./provider-retry.js";

vi.mock("./one-shot-complete.js", () => ({ completeOneShot: vi.fn() }));
const reviewer = vi.mocked(completeOneShot);
const provider = { id: "fixture", name: "Fixture", modelId: "main", apiKey: "", authKind: "none", supportsReasoning: false, supportedThinkingLevels: ["off" as const] };
const guard: ObserverGuardRuntimeConfig = { mode: "guard", settings: { providerId: "reviewer", modelId: "judge", thinkingLevel: "off", maxContinuations: 3 }, provider: { ...provider, id: "reviewer", modelId: "judge" } };
const endless: ObserverGuardRuntimeConfig = { mode: "endless", settings: { maxContinuations: 3 } };
const instances: DesktopAgentRuntime[] = [];
afterEach(async () => { await Promise.all(instances.splice(0).map(runtime => runtime.dispose())); vi.resetAllMocks(); vi.useRealTimers(); });
type Script = Partial<Pick<AssistantMessage, "content" | "stopReason" | "errorMessage">> & { beforeStart?: boolean };
const text = (value: string): Script => ({ content: [{ type: "text", text: value }] });
const read: Script = { content: [{ type: "toolCall", id: "read-receipt", name: "Read", arguments: { path: "private-path" } }], stopReason: "toolUse" };
function fixture(options: Partial<AgentRuntimeOptions> = {}, script: Script[] = [text("Done.")], toolFailure = false) {
  const events: AgentEventEnvelope[] = [];
  const requests: Context[] = [];
  const hostCalls: string[] = [];
  const runtime = new DesktopAgentRuntime({
    host: { async call<T>(method: string): Promise<T> {
      hostCalls.push(method);
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
      if (method === "provider.delegationSnapshot" || method === "session.appendMessage") return undefined as T;
      if (method === "todos.get") return { sessionId: "session", todos: [] } as T;
      if (method === "tools.execute") return { ok: !toolFailure, content: { content: [{ type: "text", text: "private-tool-output" }] } } as T;
      return undefined as T;
    } }, sessionId: "session", mode: "agent", provider, thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    agentOutputGuard: { earlyEndMode: "off", recoveryLimit: 1 }, autoContinueUnfinishedTodos: false,
    ...options, onEvent: event => { events.push(event); options.onEvent?.(event); },
  });
  const streamSimple = (_model: unknown, context: Context) => {
    requests.push({ ...context, messages: [...context.messages] });
    const { beforeStart, ...step } = script[Math.min(requests.length - 1, script.length - 1)];
    const message: AssistantMessage = {
      role: "assistant", api: "openai-completions", provider: "fixture", model: "main", content: [{ type: "text", text: "Done." }],
      usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(), ...step,
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      if (!beforeStart) stream.push({ type: "start", partial: message });
      if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message });
      else if (message.stopReason !== "pending") stream.push({ type: "done", reason: message.stopReason, message });
      stream.end(message);
    });
    return stream;
  };
  (runtime as unknown as { models: { streamSimple: typeof streamSimple } }).models = { streamSimple };
  instances.push(runtime);
  return { runtime, requests, events, hostCalls };
}
function rows(events: AgentEventEnvelope[]): UiMessage[] {
  const messages = new Map<string, UiMessage>();
  for (const { event } of events) if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") messages.set(event.message.id, event.message);
  return [...messages.values()];
}
function assessments(events: AgentEventEnvelope[]): ObserverGuardAssessment[] {
  return rows(events).flatMap(message => message.runDiagnostics?.observer?.messageId === message.id ? [message.runDiagnostics.observer] : []);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("bounded automatic continuation", () => {
  it.each([1, 3, 5])("makes %i unconditional continuations without a reviewer or model configuration", async maxContinuations => {
    const run = fixture({ observerGuard: { mode: "endless", settings: { maxContinuations } } });
    await run.runtime.prompt("Implement the change.", "user");
    expect(run.requests).toHaveLength(maxContinuations + 1);
    expect(reviewer).not.toHaveBeenCalled();
    const saved = assessments(run.events);
    expect(saved).toHaveLength(maxContinuations + 1);
    expect(saved.at(-1)).toMatchObject({ mode: "endless", continued: false, continuationReason: "continuation_limit", continuationCount: maxContinuations, maxContinuations });
    expect(saved.every(row => !row.modelKey && !row.usage && !row.thinkingLevel && !row.verdict)).toBe(true);
    expect(run.requests.at(-1)?.messages.filter(message => message.role === "user")).toHaveLength(1);
  });

  it("reevaluates new final replies and stops when the reviewer says stop", async () => {
    const run = fixture({ observerGuard: guard }, [text("Next I will inspect."), read, text("One step remains."), text("Done.")]);
    reviewer.mockResolvedValueOnce({ text: "continue" }).mockResolvedValueOnce({ text: "continue" }).mockResolvedValueOnce({ text: "stop" });
    await run.runtime.prompt("Continue.", "user");
    expect(run.requests).toHaveLength(4);
    expect(reviewer).toHaveBeenCalledTimes(3);
    expect(assessments(run.events).map(row => row.decision)).toEqual(["continue", "continue", "stop"]);
    expect(assessments(run.events).at(-1)).toMatchObject({ continued: false, continuationCount: 2, continuationReason: "decision_stop" });
    expect(run.hostCalls.filter(name => name === "tools.execute")).toHaveLength(1);
  });

  it("caps guard continuation even when every review requests more work", async () => {
    reviewer.mockResolvedValue({ text: "continue" });
    const run = fixture({ observerGuard: { ...guard, settings: { ...guard.settings, maxContinuations: 2 } }, agentOutputGuard: { earlyEndMode: "continue", recoveryLimit: 3 } }, [text("I will now inspect the code.")]);
    await run.runtime.prompt("Implement the fix.", "user");
    expect(run.requests).toHaveLength(3);
    expect(reviewer).toHaveBeenCalledTimes(2);
    expect(assessments(run.events).at(-1)).toMatchObject({ continuationReason: "continuation_limit", continuationCount: 2 });
  });

  it.each(["先确认样本被拒绝的原因。", "I will inspect permission checks next.", "Which case failed? I will check the log."])("does not keyword-veto the reviewer for %s", async answer => {
    reviewer.mockResolvedValueOnce({ text: "continue" }).mockResolvedValueOnce({ text: "stop" });
    const run = fixture({ observerGuard: guard }, [text(answer), text("Done.")]);
    await run.runtime.prompt("Continue.", "user");
    expect(run.requests).toHaveLength(2);
    expect(assessments(run.events)[0]).toMatchObject({ continued: true });
  });

  it("sends only the redacted final reply and editable prompt, not history or tool content", async () => {
    reviewer.mockResolvedValue({ text: "stop", usage: { inputTokens: 7, outputTokens: 1, totalTokens: 8 } });
    const prompt = "My reviewer policy: stop on completed work. Return continue or stop.";
    const run = fixture({ observerGuard: { ...guard, settings: { ...guard.settings, prompt, includeToolOutput: true } }, systemPrompt: "private-system",
      history: [{ id: "past", role: "user", content: "private-history", createdAt: "2026-01-01T00:00:00Z" }] }, [read, { content: [{ type: "thinking", thinking: "private-reasoning" }, { type: "text", text: "Result password=secretvalue" }] }]);
    await run.runtime.prompt("private-user-task", "user");
    const [binding, context, effort, options] = reviewer.mock.calls[0];
    expect(binding).toMatchObject({ id: "reviewer", modelId: "judge" });
    expect(context.messages[0].content).toContain(prompt);
    expect(context.messages[1].content).toContain("Result password=[REDACTED]");
    for (const excluded of ["private-history", "private-system", "private-reasoning", "private-path", "private-tool-output", "private-user-task", "secretvalue"]) expect(JSON.stringify(context)).not.toContain(excluded);
    expect(context.tools).toBeUndefined();
    expect(effort).toBe("off");
    expect(options).toMatchObject({ disableRetries: true, requireComplete: true, maxOutputTokens: 512 });
    expect(assessments(run.events).at(-1)?.usage?.totalTokens).toBe(8);
    expect(run.runtime.getStatus().runDiagnostics?.requestCount).toBe(2);
  });

  it.each(["not-json", "continue because", "{\"verdict\":\"incomplete\"}", "```continue```", ""])("rejects unsupported output %s without continuing", async reply => {
    reviewer.mockResolvedValue({ text: reply });
    const run = fixture({ observerGuard: guard });
    await run.runtime.prompt("Do the task.", "user");
    expect(run.requests).toHaveLength(1);
    expect(assessments(run.events).at(-1)).toMatchObject({ status: "error", errorCode: "INVALID_RESPONSE" });
  });

  it.each([undefined, { mode: "off" as const, settings: {} }])("off remains inactive: %j", async observerGuard => {
    const run = fixture({ observerGuard }); await run.runtime.prompt("Do the task.", "user");
    expect(run.requests).toHaveLength(1); expect(reviewer).not.toHaveBeenCalled(); expect(assessments(run.events)).toEqual([]);
  });

  it.each([{}, { providerId: "reviewer", modelId: "missing" }])("guard never borrows a default model: %j", async settings => {
    const run = fixture({ observerGuard: { mode: "guard", settings } }); await run.runtime.prompt("Do the task.", "user");
    expect(reviewer).not.toHaveBeenCalled(); expect(run.requests).toHaveLength(1);
    expect(assessments(run.events).at(-1)?.status).toBe("error");
  });

  it.each([guard, endless])("Plan and non-user notices cannot acquire auto-continuation: $mode", async observerGuard => {
    reviewer.mockResolvedValue({ text: "continue" });
    const plan = fixture({ observerGuard, mode: "plan" }); await plan.runtime.prompt("Do the task.", "user");
    expect(plan.requests).toHaveLength(1);
    expect(assessments(plan.events).at(-1)?.continuationReason).toBe("plan_mode");
    const notice = fixture({ observerGuard });
    await notice.runtime.prompt({ text: "Continue", sessionMessage: { kind: "completion", sourceSessionId: "child", sourceTitle: "Child", targetSessionId: "session", messageId: "notice", replyToMessageId: "parent" } });
    expect(notice.requests).toHaveLength(1); expect(assessments(notice.events)).toEqual([]);
  });

  it("uses real tool failure state, not a name whitelist, to avoid unsafe correction", async () => {
    const run = fixture({ observerGuard: endless }, [read, text("Done.")], true);
    await run.runtime.prompt("Do the task.", "user");
    expect(run.requests).toHaveLength(2); expect(reviewer).not.toHaveBeenCalled();
    expect(assessments(run.events).at(-1)).toMatchObject({ continued: false, continuationReason: "runtime_unavailable" });
  });

  it.each(["error", "aborted", "length"] as const)("does not turn %s termination into automatic continue", async stopReason => {
    const run = fixture({ observerGuard: endless }, [{ ...text("Partial reply"), stopReason, ...(stopReason === "error" ? { errorMessage: "401 invalid key" } : {}) }]);
    await run.runtime.prompt("Do the task.", "user");
    expect(run.requests).toHaveLength(1); expect(reviewer).not.toHaveBeenCalled();
    expect(assessments(run.events).at(-1)?.status).toBe("skipped");
  });

  it("ignores queued setting changes until the next explicit turn, then resets its count", async () => {
    const run = fixture({ observerGuard: { ...endless, settings: { maxContinuations: 1 } } });
    await run.runtime.prompt("First task", "first"); await run.runtime.prompt("Second task", "second");
    expect(run.requests).toHaveLength(4);
    const saved = assessments(run.events);
    expect(saved.map(row => row.continuationCount)).toEqual([1, 1, 1, 1]);
    run.runtime.setObserverGuard({ mode: "off", settings: {} }); await run.runtime.prompt("Third task", "third");
    expect(run.requests).toHaveLength(5); expect(assessments(run.events)).toHaveLength(4);
  });

  it("Stop aborts review and stale completion cannot revive the session", async () => {
    const entered = deferred<Context>(), late = deferred<OneShotCompleteResult>();
    reviewer.mockImplementation(async (_provider, context) => { entered.resolve(context); return late.promise; });
    const run = fixture({ observerGuard: guard }); const first = run.runtime.prompt("Do the task.", "user");
    await entered.promise; await run.runtime.abort(); await first.catch(() => undefined);
    expect(assessments(run.events).at(-1)?.errorCode).toBe("CANCELLED");
    run.runtime.setObserverGuard({ mode: "off", settings: {} }); await run.runtime.prompt("New task", "next");
    const count = run.events.length; late.resolve({ text: "continue" }); await Promise.resolve();
    expect(run.requests).toHaveLength(2); expect(run.events).toHaveLength(count);
  });

  it("graceful Stop beats a reviewer continue decision", async () => {
    const entered = deferred<void>(), late = deferred<OneShotCompleteResult>();
    reviewer.mockImplementation(async () => { entered.resolve(); return late.promise; });
    const run = fixture({ observerGuard: guard }); const first = run.runtime.prompt("Do the task.", "user");
    await entered.promise; run.runtime.requestGracefulStop(); late.resolve({ text: "continue" }); await first;
    expect(run.requests).toHaveLength(1); expect(assessments(run.events).at(-1)?.continuationReason).toBe("stop_requested");
  });

  it("timeouts settle without retry or main-model continuation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); const entered = deferred<void>();
    reviewer.mockImplementation(async () => { entered.resolve(); return new Promise(() => undefined); });
    const run = fixture({ observerGuard: { ...guard, settings: { ...guard.settings, timeoutSeconds: 5 } } });
    const first = run.runtime.prompt("Do the task.", "user"); await entered.promise; await vi.advanceTimersByTimeAsync(5000); await first;
    expect(run.requests).toHaveLength(1); expect(reviewer).toHaveBeenCalledTimes(1);
    expect(assessments(run.events).at(-1)?.errorCode).toBe("TIMEOUT");
  });

  it("oversized final replies stop visibly instead of silently judging a fragment", async () => {
    const run = fixture({ observerGuard: { ...guard, settings: { ...guard.settings, maxInputChars: 2000 } } }, [text("x".repeat(3000))]);
    await run.runtime.prompt("Do the task.", "user");
    expect(run.requests).toHaveLength(1); expect(reviewer).not.toHaveBeenCalled();
    expect(assessments(run.events).at(-1)).toMatchObject({ inputTruncated: true, continuationReason: "input_truncated", continued: false });
  });
});

it.each(["Everything is complete.", "先分析拒绝的原因。", "Please provide more information."])("Endless never makes a semantic judgement about %s", async answer => {
  const run = fixture({ observerGuard: { ...endless, settings: { maxContinuations: 1 } } }, [text(answer)]);
  await run.runtime.prompt("Continue the existing work.", "user");
  expect(run.requests).toHaveLength(2);
  expect(reviewer).not.toHaveBeenCalled();
});

it("tools do not replenish Endless continuation count or replay completed work", async () => {
  const run = fixture({ observerGuard: { ...endless, settings: { maxContinuations: 1 } } }, [text("Next step."), read, text("Done.")]);
  await run.runtime.prompt("Do the task.", "user");
  expect(run.requests).toHaveLength(3);
  expect(run.hostCalls.filter(name => name === "tools.execute")).toHaveLength(1);
  expect(assessments(run.events).at(-1)).toMatchObject({ continuationReason: "continuation_limit", continuationCount: 1 });
});

it("does not send another request while a real tool boundary is waiting", async () => {
  const entered = deferred<void>(), release = deferred<unknown>();
  const run = fixture({ observerGuard: { ...endless, settings: { maxContinuations: 1 } }, host: { async call<T>(method: string): Promise<T> {
    if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
    if (method === "provider.delegationSnapshot" || method === "session.appendMessage") return undefined as T;
    if (method === "todos.get") return { sessionId: "session", todos: [] } as T;
    if (method === "tools.execute") { entered.resolve(); return await release.promise as T; }
    return undefined as T;
  } } }, [read, text("Done.")]);
  const first = run.runtime.prompt("Do the task.", "user");
  await entered.promise;
  expect(run.requests).toHaveLength(1); expect(reviewer).not.toHaveBeenCalled();
  release.resolve({ ok: true, content: { content: [{ type: "text", text: "Settled." }] } });
  await first;
  expect(run.requests).toHaveLength(3);
});

it("graceful Stop during an Endless continuation prevents the next continuation", async () => {
  let replies = 0;
  const run = fixture({ observerGuard: endless, onEvent: ({ event }) => {
    if (event.type === "message_start" && event.message.role === "assistant" && ++replies === 2) run.runtime.requestGracefulStop();
  } });
  await run.runtime.prompt("Do the task.", "user");
  expect(run.requests).toHaveLength(2); expect(reviewer).not.toHaveBeenCalled();
  expect(assessments(run.events).at(-1)).toMatchObject({ status: "skipped", skipReason: "stop_requested", continuationCount: 1 });
});

it("snapshots model, prompt and count while a review is active", async () => {
  const entered = deferred<void>(), release = deferred<OneShotCompleteResult>();
  reviewer.mockImplementationOnce(async () => { entered.resolve(); return release.promise; });
  const run = fixture({ observerGuard: { ...guard, settings: { ...guard.settings, maxContinuations: 1, prompt: "old-prompt" } } });
  const first = run.runtime.prompt("Do the task.", "user"); await entered.promise;
  run.runtime.setObserverGuard({ ...endless, settings: { maxContinuations: 2, prompt: "new-prompt" } });
  release.resolve({ text: "continue" }); await first;
  expect(run.requests).toHaveLength(2); expect(reviewer).toHaveBeenCalledTimes(1);
  expect(reviewer.mock.calls[0][1].messages[0].content).toContain("old-prompt");
  await run.runtime.prompt("Next task.", "next-user");
  expect(run.requests).toHaveLength(5); expect(reviewer).toHaveBeenCalledTimes(1);
});

it("steering wins over a pending review and does not acquire a fresh continuation allowance", async () => {
  const entered = deferred<void>(), release = deferred<OneShotCompleteResult>();
  reviewer.mockImplementation(async () => { entered.resolve(); return release.promise; });
  const run = fixture({ observerGuard: guard }); const first = run.runtime.prompt("Do the task.", "user", "turn");
  await entered.promise;
  run.runtime.steer({ text: "Only explain now." }, "turn", { id: "steering", role: "user", content: "Only explain now.", createdAt: "2026-01-01T00:00:00Z", status: "complete" });
  release.resolve({ text: "continue" }); await first;
  expect(run.requests).toHaveLength(2); expect(reviewer).toHaveBeenCalledTimes(1);
  expect(assessments(run.events).every(row => !row.continued)).toBe(true);
});

describe("optional recovery after transient retry exhaustion", () => {
  const failure = (beforeStart = false, errorMessage = "fetch failed"): Script => ({
    beforeStart, stopReason: "error", errorMessage, content: beforeStart ? [] : [{ type: "text", text: "Partial result." }],
  });

  it.each([false, true])("uses the configured shared balance after network exhaustion, beforeStart=%s", async beforeStart => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const run = fixture({ observerGuard: { ...endless, settings: { maxContinuations: 2, continueOnTransientError: true } } }, [failure(beforeStart)]);
    const work = run.runtime.prompt("Do the task.", "user");
    await vi.runAllTimersAsync(); await work;
    expect(run.requests).toHaveLength(1 + PROVIDER_TRANSIENT_MAX_RETRIES + 2);
    expect(reviewer).not.toHaveBeenCalled();
    expect(assessments(run.events).at(-1)).toMatchObject({ status: "skipped", skipReason: "response_error", continuationCount: 2, maxContinuations: 2 });
    const extra = run.events.flatMap(({ event }) => event.type === "status" && event.status.activity?.phase === "retrying" && event.status.activity.attempt > PROVIDER_TRANSIENT_MAX_RETRIES ? [event.status.activity] : []);
    expect(extra).toHaveLength(2);
    expect(extra.every(activity => activity.maxAttempts === PROVIDER_TRANSIENT_MAX_RETRIES + 2)).toBe(true);
  });

  it.each(["guard", "endless"] as const)("recovers %s after a successful write without replaying it or calling a reviewer", async mode => {
    const written = deferred<void>();
    const failures = Array.from({ length: PROVIDER_TRANSIENT_MAX_RETRIES + 1 }, () => failure());
    const write: Script = { stopReason: "toolUse", content: [{ type: "toolCall", id: "write-once", name: "Write", arguments: { path: "fixture.txt", content: "saved exactly once" } }] };
    const run = fixture({ observerGuard: { mode, settings: { maxContinuations: 1, continueOnTransientError: true } }, onEvent: ({ event }) => {
      if (event.type === "tool_end" && event.toolCallId === "write-once") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        written.resolve();
      }
    } }, [write, ...failures, text("Done.")]);
    const work = run.runtime.prompt("Do the task.", "user");
    await written.promise; await vi.runAllTimersAsync(); await work;
    expect(run.requests).toHaveLength(PROVIDER_TRANSIENT_MAX_RETRIES + 3);
    expect(run.hostCalls.filter(name => name === "tools.execute")).toHaveLength(1);
    expect(JSON.stringify(run.requests.at(-1))).toContain("private-tool-output");
    expect(assessments(run.events).at(-1)).toMatchObject({ continuationCount: 1, continuationReason: "continuation_limit" });
    expect(run.events.some(({ event }) => event.type === "error")).toBe(false);
    expect(reviewer).not.toHaveBeenCalled();
  });

  it("recovery and normal continuation spend one balance even after a successful response", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const failures = Array.from({ length: PROVIDER_TRANSIENT_MAX_RETRIES + 1 }, () => failure());
    const run = fixture({ observerGuard: { ...endless, settings: { maxContinuations: 2, continueOnTransientError: true } } }, [...failures, text("Next step."), text("Done.")]);
    const work = run.runtime.prompt("Do the task.", "user"); await vi.runAllTimersAsync(); await work;
    expect(run.requests).toHaveLength(PROVIDER_TRANSIENT_MAX_RETRIES + 3);
    expect(assessments(run.events).at(-1)).toMatchObject({ continuationCount: 2, continuationReason: "continuation_limit" });
    expect(reviewer).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "endless" as const, settings: { maxContinuations: 2 } },
    { mode: "endless" as const, settings: { maxContinuations: 2, continueOnTransientError: false } },
    { mode: "off" as const, settings: { maxContinuations: 2, continueOnTransientError: true } },
  ])("preserves the built-in retry limit when not opted in: %j", async observerGuard => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const run = fixture({ observerGuard }, [failure()]);
    const work = run.runtime.prompt("Do the task.", "user"); await vi.runAllTimersAsync(); await work;
    expect(run.requests).toHaveLength(1 + PROVIDER_TRANSIENT_MAX_RETRIES);
    expect(reviewer).not.toHaveBeenCalled();
  });

  it("also bounds opted-in temporary rate-limit recovery", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const run = fixture({ observerGuard: { ...endless, settings: { maxContinuations: 1, continueOnTransientError: true } } }, [failure(false, "429 too many requests")]);
    const work = run.runtime.prompt("Do the task.", "user"); await vi.runAllTimersAsync(); await work;
    expect(run.requests).toHaveLength(1 + PROVIDER_RATE_LIMIT_MAX_RETRIES + 1);
    expect(reviewer).not.toHaveBeenCalled();
  });

  it.each(["401 invalid api key", "403 permission denied", "CERT_HAS_EXPIRED", "400 invalid request body"])("does not recover permanent or security failure: %s", async errorMessage => {
    const run = fixture({ observerGuard: { ...endless, settings: { maxContinuations: 3, continueOnTransientError: true } } }, [failure(false, errorMessage)]);
    await run.runtime.prompt("Do the task.", "user");
    expect(run.requests).toHaveLength(1); expect(reviewer).not.toHaveBeenCalled();
  });

  it("Stop during the extra recovery backoff prevents the next request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let stopped: Promise<void> | undefined;
    const run = fixture({ observerGuard: { ...endless, settings: { maxContinuations: 2, continueOnTransientError: true } }, onEvent: ({ event }) => {
      if (!stopped && event.type === "status" && event.status.activity?.phase === "retrying" && (event.status.activity.attempt ?? 0) > PROVIDER_TRANSIENT_MAX_RETRIES) stopped = run.runtime.abort();
    } }, [failure()]);
    const work = run.runtime.prompt("Do the task.", "user").catch(() => undefined);
    await vi.runAllTimersAsync(); await work; await stopped;
    expect(stopped).toBeDefined();
    expect(run.requests).toHaveLength(1 + PROVIDER_TRANSIENT_MAX_RETRIES);
    expect(reviewer).not.toHaveBeenCalled();
  });
});

it("a normal continuation already spent reduces the remaining network recovery allowance", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const error: Script = { stopReason: "error", errorMessage: "fetch failed", content: [] };
  const run = fixture({ observerGuard: { ...endless, settings: { maxContinuations: 2, continueOnTransientError: true } } }, [text("Next step."), error]);
  const work = run.runtime.prompt("Do the task.", "user"); await vi.runAllTimersAsync(); await work;
  expect(run.requests).toHaveLength(1 + 1 + PROVIDER_TRANSIENT_MAX_RETRIES + 1);
  expect(assessments(run.events).at(-1)).toMatchObject({ continuationCount: 2, skipReason: "response_error" });
});

it("changing the error recovery toggle affects only the next user turn", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let changed = false;
  const error: Script = { stopReason: "error", errorMessage: "fetch failed", content: [] };
  const run = fixture({ observerGuard: { ...endless, settings: { maxContinuations: 1, continueOnTransientError: true } }, onEvent: ({ event }) => {
    if (!changed && event.type === "status" && event.status.activity?.phase === "retrying") {
      changed = true;
      run.runtime.setObserverGuard({ ...endless, settings: { maxContinuations: 1, continueOnTransientError: false } });
    }
  } }, [error]);
  const first = run.runtime.prompt("First task.", "first"); await vi.runAllTimersAsync(); await first;
  expect(run.requests).toHaveLength(1 + PROVIDER_TRANSIENT_MAX_RETRIES + 1);
  const second = run.runtime.prompt("Next task.", "next"); await vi.runAllTimersAsync(); await second;
  expect(run.requests).toHaveLength(2 * (1 + PROVIDER_TRANSIENT_MAX_RETRIES) + 1);
  expect(assessments(run.events).at(-1)?.continuationCount).toBe(0);
});
