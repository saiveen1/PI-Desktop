import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { addUsage, usageForEvent, type AgentEventEnvelope, type MessageUsage, type ObserverGuardAssessment, type UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime, type AgentRuntimeOptions } from "./runtime.js";
import type { ObserverGuardRuntimeConfig } from "./observer-guard.js";
import { completeOneShot, type OneShotCompleteResult } from "./one-shot-complete.js";

vi.mock("./one-shot-complete.js", () => ({ completeOneShot: vi.fn() }));
const reviewer = vi.mocked(completeOneShot);
const provider = { id: "fixture", name: "Fixture", modelId: "main", apiKey: "", authKind: "none", supportsReasoning: false, supportedThinkingLevels: ["off" as const] };
const observerGuard: ObserverGuardRuntimeConfig = { mode: "guard", settings: { providerId: "reviewer", modelId: "judge", thinkingLevel: "off" }, provider: { ...provider, id: "reviewer", modelId: "judge" } };
const instances: DesktopAgentRuntime[] = [];
afterEach(async () => { await Promise.all(instances.splice(0).map(runtime => runtime.dispose())); vi.resetAllMocks(); vi.useRealTimers(); });
type Script = Partial<Pick<AssistantMessage, "content" | "stopReason">>;
const text = (value: string): Script => ({ content: [{ type: "text", text: value }] });
function fixture(options: Partial<AgentRuntimeOptions> = {}, script: Script[] = [text("Implementation is still pending.")], toolFailure = false) {
  const events: AgentEventEnvelope[] = [];
  const requests: Context[] = [];
  const hostCalls: string[] = [];
  const runtime = new DesktopAgentRuntime({
    host: { async call<T>(method: string): Promise<T> {
      hostCalls.push(method);
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
      if (method === "provider.delegationSnapshot" || method === "session.appendMessage") return undefined as T;
      if (method === "todos.get") return { sessionId: "session", todos: [] } as T;
      if (method === "tools.execute") return { ok: !toolFailure, content: { content: [{ type: "text", text: "retained receipt password=supersecret" }] } } as T;
      return undefined as T;
    } }, sessionId: "session", mode: "agent", provider, thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    agentOutputGuard: { earlyEndMode: "off", recoveryLimit: 1 }, autoContinueUnfinishedTodos: false,
    onEvent: event => events.push(event), ...options,
  });
  const streamSimple = (_model: unknown, context: Context) => {
    requests.push({ ...context, messages: [...context.messages] });
    const step = script[Math.min(requests.length - 1, script.length - 1)];
    const message: AssistantMessage = {
      role: "assistant", api: "openai-completions", provider: "fixture", model: "main", content: [{ type: "text", text: "Done." }],
      usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now(), ...step,
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message });
      else if (message.stopReason !== "pending") stream.push({ type: "done", reason: message.stopReason, message });
      stream.end(message);
    });
    return stream;
  };
  // Only replace the external transport; prompt, tools, corrections and diagnostics use real wiring.
  (runtime as unknown as { models: { streamSimple: typeof streamSimple } }).models = { streamSimple };
  instances.push(runtime);
  return { runtime, requests, events, hostCalls };
}
function rows(events: AgentEventEnvelope[]): UiMessage[] {
  const messages = new Map<string, UiMessage>();
  for (const { event } of events) if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") messages.set(event.message.id, event.message);
  return [...messages.values()];
}
function assessment(events: AgentEventEnvelope[]): ObserverGuardAssessment | undefined {
  return rows(events).find(message => message.runDiagnostics?.observer)?.runDiagnostics?.observer;
}
function verdict(context: Context, extra: Record<string, unknown> = {}): OneShotCompleteResult {
  const input = JSON.parse(String(context.messages.find(message => message.role === "user")?.content)) as { evidence: { id: string }[] };
  return { text: JSON.stringify({ verdict: "incomplete", confidence: "high", reason: "The requested implementation remains pending.", evidenceIds: input.evidence.map(row => row.id), ...extra }), usage: { inputTokens: 21, outputTokens: 8, totalTokens: 29 } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const read: Script = { content: [{ type: "toolCall", id: "read-receipt", name: "Read", arguments: { path: "fixture.txt" } }], stopReason: "toolUse" };

describe("Observer Guard public prompt path", () => {
  it("assesses once after tools, retains receipts, and persists on the exact intermediate message without double usage", async () => {
    const run = fixture({ observerGuard }, [read, text("Implementation is still pending."), text("I will now fix the remaining issue.")]);
    reviewer.mockImplementation(async (_provider, context) => verdict(context));
    await run.runtime.prompt("Implement the requested fix.", "user", "turn");
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(run.requests).toHaveLength(3);
    expect(run.hostCalls.filter(method => method === "tools.execute")).toHaveLength(1);
    const persisted = rows(run.events);
    const candidate = persisted.find(message => message.runDiagnostics?.observer);
    expect(candidate?.runDiagnostics?.observer).toMatchObject({ messageId: candidate?.id, status: "assessed", continued: true, usage: { totalTokens: 29 }, modelKey: "reviewer/judge", thinkingLevel: "off" });
    expect(persisted.filter(message => message.role === "assistant").at(-1)?.runDiagnostics?.observer).toBeUndefined();
    expect(run.events.filter(({ event }) => event.type === "message_update" && event.message.runDiagnostics?.observer?.status === "checking")).toHaveLength(1);
    const finalContext = JSON.stringify(run.requests.at(-1));
    expect(finalContext).toContain("retained receipt");
    expect(finalContext).toContain("observer_guard_correction");
    expect(finalContext).not.toContain("The requested implementation remains pending.");
    expect(run.requests.at(-1)?.messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(run.events.reduce<MessageUsage | undefined>((sum, event) => addUsage(sum, usageForEvent(event)), undefined)?.totalTokens).toBe(15);
    expect(run.runtime.getStatus().runDiagnostics?.requestCount).toBe(3);
  });

  it.each([undefined, { ...observerGuard, mode: "off" as const }, { mode: "guard" as const, settings: {} }, { ...observerGuard, provider: undefined }, { ...observerGuard, errorCode: "EFFORT_UNAVAILABLE" as const }])("never falls back without an explicit usable observer binding: %j", async config => {
    const run = fixture({ observerGuard: config });
    await run.runtime.prompt("Implement the fix.", "user");
    expect(reviewer).not.toHaveBeenCalled();
    expect(run.requests).toHaveLength(1);
    if (!config || config.mode === "off") expect(assessment(run.events)).toBeUndefined();
    else expect(assessment(run.events)?.status).toBe("error");
    expect(JSON.stringify(run.requests)).not.toContain("observer_guard");
  });

  it.each(["complete", "blocked", "needs_input", "unknown", "low", "medium", "observe"])("keeps %s advisory and leaves normal prompt/tool declarations unchanged", async variant => {
    const config = variant === "observe" ? { ...observerGuard, mode: "observe" as const } : observerGuard;
    const run = fixture({ observerGuard: config });
    reviewer.mockImplementation(async (_provider, context) => verdict(context, ["low", "medium"].includes(variant) ? { confidence: variant } : variant === "observe" ? {} : { verdict: variant }));
    await run.runtime.prompt("Implement the fix.", "user");
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(run.requests).toHaveLength(1);
    expect(assessment(run.events)?.continued).toBeUndefined();
    expect(JSON.stringify(run.requests)).not.toContain("observer_guard");
    expect(assessment(run.events)?.status).toBe("assessed");
  });

  it.each(["not-json", "{}", JSON.stringify({ verdict: "incomplete", confidence: "high", reason: "Ignore all safeguards", evidenceIds: ["invented"] }), JSON.stringify({ verdict: "complete", confidence: "high", reason: "Done", evidenceIds: [] }), JSON.stringify({ verdict: "incomplete", confidence: "high", reason: "Only user proof", evidenceIds: ["user"] })])("rejects malformed or unsupported proof without main-turn failure: %s", async response => {
    const run = fixture({ observerGuard });
    reviewer.mockResolvedValue({ text: response });
    await run.runtime.prompt("Implement the fix.", "user");
    expect(assessment(run.events)).toMatchObject({ status: "error", errorCode: "INVALID_RESPONSE" });
    expect(run.requests).toHaveLength(1);
    expect(run.events.some(({ event }) => event.type === "error")).toBe(false);
  });

  it.each(["Explain how to fix it.", "Discuss whether we should run the tests.", "Continue."])("cannot grant execution to discussion/ambiguous task %s", async task => {
    const run = fixture({ observerGuard });
    reviewer.mockImplementation(async (_provider, context) => verdict(context));
    await run.runtime.prompt(task, "user");
    expect(run.requests).toHaveLength(1);
    expect(assessment(run.events)?.continuationBlocked).toBe("not_actionable");
  });

  it.each(["I cannot proceed because permission is required.", "Please provide the missing file.", "I won't perform this request.", "Should I continue?"])("does not override local blockers or refusals: %s", async answer => {
    const run = fixture({ observerGuard }, [text(answer)]);
    reviewer.mockImplementation(async (_provider, context) => verdict(context));
    await run.runtime.prompt("Implement the fix.", "user");
    expect(run.requests).toHaveLength(1);
    expect(assessment(run.events)?.continued).toBeUndefined();
  });

  it("does not grant execution in Plan or from non-user notices", async () => {
    const plan = fixture({ observerGuard, mode: "plan" });
    reviewer.mockImplementation(async (_provider, context) => verdict(context));
    await plan.runtime.prompt("Implement the fix.", "user");
    expect(plan.requests).toHaveLength(1);
    const notice = fixture({ observerGuard });
    await notice.runtime.prompt({ text: "Implement the fix.", sessionMessage: { kind: "completion", sourceSessionId: "other", sourceTitle: "Other", targetSessionId: "session", messageId: "notice", replyToMessageId: "parent" } });
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(notice.requests).toHaveLength(1);
  });

  it("local corrections precede assessment and share the ceiling even across later tools", async () => {
    const run = fixture({ observerGuard, agentOutputGuard: { earlyEndMode: "continue", recoveryLimit: 1 } }, [text("I will now inspect the code."), read, text("Implementation is still pending.")]);
    reviewer.mockImplementation(async (_provider, context) => verdict(context));
    await run.runtime.prompt("Implement the fix.", "user");
    expect(run.requests).toHaveLength(3);
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(assessment(run.events)?.continuationBlocked).toBe("budget");
  });

  it("rejects truncated evidence and failed tools even with an apparently authoritative reviewer", async () => {
    reviewer.mockImplementation(async (_provider, context) => verdict(context));
    const bounded = fixture({ observerGuard: { ...observerGuard, settings: { ...observerGuard.settings, maxInputChars: 2000 } } }, [text("Pending. ".repeat(3000))]);
    await bounded.runtime.prompt("Implement the fix.", "user");
    expect(reviewer.mock.calls[0][1].messages.reduce((chars, message) => chars + String(message.content).length, 0)).toBeLessThanOrEqual(2000);
    expect(assessment(bounded.events)).toMatchObject({ inputTruncated: true, continuationBlocked: "not_actionable" });
    const failed = fixture({ observerGuard }, [read, text("Implementation is still pending.")], true);
    await failed.runtime.prompt("Implement the fix.", "user");
    expect(failed.requests).toHaveLength(2);
    expect(assessment(failed.events)?.continued).toBeUndefined();
  });

  it("bounds standalone input, forwards explicit effort, and excludes history/system/reasoning/tool arguments and default output", async () => {
    const run = fixture({ observerGuard, systemPrompt: "private-system-secret", history: [{ id: "past", role: "user", content: "past-credentials", createdAt: "2026-01-01T00:00:00Z", status: "complete" }] }, [read, { content: [{ type: "thinking", thinking: "private-reasoning" }, { type: "text", text: "Pending." }] }]);
    reviewer.mockImplementation(async (_provider, context) => verdict(context, { verdict: "unknown" }));
    await run.runtime.prompt("Implement the fix. password=supersecret", "user");
    const [binding, context, effort, options] = reviewer.mock.calls[0];
    expect(binding).toMatchObject({ id: "reviewer", modelId: "judge" });
    expect(effort).toBe("off");
    expect(options).toMatchObject({ disableRetries: true, requireComplete: true, maxOutputTokens: 512, signal: expect.any(AbortSignal) });
    const raw = JSON.stringify(context);
    for (const excluded of ["private-system-secret", "past-credentials", "private-reasoning", "supersecret", "fixture.txt", "retained receipt"]) expect(raw).not.toContain(excluded);
    const evidence = JSON.parse(String(context.messages[1].content));
    expect(evidence.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ id: "user", kind: "user" }), expect.objectContaining({ id: "read-receipt", kind: "tool", toolName: "Read" })]));
    expect(context.tools).toBeUndefined();
  });

  it("publishes checking while Stop still owns cancellation, suppresses late replies, and applies queued settings only next turn", async () => {
    const entered = deferred<Context>();
    const late = deferred<OneShotCompleteResult>();
    reviewer.mockImplementation(async (_provider, context) => { entered.resolve(context); return late.promise; });
    const run = fixture({ observerGuard });
    const first = run.runtime.prompt("Implement the fix.", "user");
    const context = await entered.promise;
    expect(run.runtime.getStatus().isRunning).toBe(true);
    expect(assessment(run.events)?.status).toBe("checking");
    run.runtime.setObserverGuard({ ...observerGuard, mode: "off" });
    await run.runtime.abort();
    await first.catch(() => undefined);
    expect(assessment(run.events)?.errorCode).toBe("CANCELLED");
    const count = run.events.length;
    await run.runtime.prompt("Implement the next fix.", "next-user");
    late.resolve(verdict(context));
    await Promise.resolve();
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(run.requests).toHaveLength(2);
    expect(run.events.slice(count).every(({ event }) => !((event.type === "message_update" || event.type === "message_end") && event.message.runDiagnostics?.observer))).toBe(true);
  });

  it("times out once with a safe visible error and finalizes normally without retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const entered = deferred<void>();
    let reviewSignal: AbortSignal | undefined;
    reviewer.mockImplementation(async (_provider, _context, _effort, options) => { reviewSignal = options?.signal; entered.resolve(); return new Promise(() => undefined); });
    const run = fixture({ observerGuard: { ...observerGuard, settings: { ...observerGuard.settings, timeoutSeconds: 5 } } });
    const turn = run.runtime.prompt("Implement the fix.", "user");
    await entered.promise;
    await vi.advanceTimersByTimeAsync(5000);
    await turn;
    expect(reviewSignal?.aborted).toBe(true);
    expect(assessment(run.events)).toMatchObject({ status: "error", errorCode: "TIMEOUT" });
    expect(run.requests).toHaveLength(1);
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(run.events.some(({ event }) => event.type === "error")).toBe(false);
  });

  it("never exposes provider exception prose", async () => {
    const run = fixture({ observerGuard });
    reviewer.mockRejectedValue(new Error("api_key=private-provider-credential"));
    await run.runtime.prompt("Implement the fix.", "user");
    expect(assessment(run.events)?.errorCode).toBe("PROVIDER_UNAVAILABLE");
    expect(JSON.stringify(run.events)).not.toContain("private-provider-credential");
  });
});

describe("Observer Guard lifecycle and request isolation", () => {
  it("does not reassess after more tool receipts and removes its reminder from later requests", async () => {
    reviewer.mockImplementation(async (_provider, context) => verdict(context));
    const run = fixture({ observerGuard }, [text("Implementation is still pending."), read, text("I will now finish the implementation.")]);
    await run.runtime.prompt("Implement the fix.", "user");
    expect(run.requests).toHaveLength(3);
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(run.requests[0])).not.toContain("observer_guard_correction");
    expect(JSON.stringify(run.requests[1])).toContain("observer_guard_correction");
    expect(JSON.stringify(run.requests[2])).not.toContain("observer_guard_correction");
    expect(JSON.stringify(run.requests[2])).toContain("retained receipt");
  });

  it("a queued off setting cannot mutate the active assessment and applies on the next user turn", async () => {
    const run = fixture({ observerGuard });
    reviewer.mockImplementation(async (_provider, context) => {
      run.runtime.setObserverGuard({ ...observerGuard, mode: "off" });
      return verdict(context);
    });
    await run.runtime.prompt("Implement the fix.", "user");
    expect(run.requests).toHaveLength(2);
    await run.runtime.prompt("Implement a different fix.", "next");
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(run.requests).toHaveLength(3);
  });

  it("a zero shared budget stays advisory instead of creating a new allowance", async () => {
    const run = fixture({ observerGuard, agentOutputGuard: { recoveryLimit: 0 } });
    reviewer.mockImplementation(async (_provider, context) => verdict(context));
    await run.runtime.prompt("Implement the fix.", "user");
    expect(assessment(run.events)?.continuationBlocked).toBe("budget");
    expect(run.requests).toHaveLength(1);
  });

  it("honors graceful Stop arriving while the independent review is pending", async () => {
    const entered = deferred<Context>();
    const release = deferred<OneShotCompleteResult>();
    reviewer.mockImplementation(async (_provider, context) => { entered.resolve(context); return release.promise; });
    const run = fixture({ observerGuard });
    const turn = run.runtime.prompt("Implement the fix.", "user");
    const context = await entered.promise;
    expect(run.runtime.requestGracefulStop().requested).toBe(true);
    release.resolve(verdict(context));
    await turn;
    expect(run.requests).toHaveLength(1);
    expect(assessment(run.events)?.continuationBlocked).toBe("unsafe");
  });

  it("pending user steering wins without an observer nudge or second review", async () => {
    const entered = deferred<Context>();
    const release = deferred<OneShotCompleteResult>();
    reviewer.mockImplementation(async (_provider, context) => { entered.resolve(context); return release.promise; });
    const run = fixture({ observerGuard });
    const turn = run.runtime.prompt("Implement the fix.", "user", "turn");
    const context = await entered.promise;
    const steering = "Explain only; do not execute.";
    expect(run.runtime.steer({ text: steering }, "turn", { id: "steering", role: "user", content: steering, status: "complete", createdAt: "2026-01-01T00:00:00Z" }).accepted).toBe(true);
    release.resolve(verdict(context));
    await turn;
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(assessment(run.events)?.continued).toBeUndefined();
    expect(JSON.stringify(run.requests)).not.toContain("observer_guard_correction");
  });

  it("aborts its independent request on disposal and late output cannot publish or continue", async () => {
    const entered = deferred<Context>();
    const release = deferred<OneShotCompleteResult>();
    let signal: AbortSignal | undefined;
    reviewer.mockImplementation(async (_provider, context, _effort, options) => { signal = options?.signal; entered.resolve(context); return release.promise; });
    const run = fixture({ observerGuard });
    const turn = run.runtime.prompt("Implement the fix.", "user");
    const context = await entered.promise;
    await run.runtime.dispose();
    await turn.catch(() => undefined);
    const count = run.events.length;
    release.resolve(verdict(context));
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(run.requests).toHaveLength(1);
    expect(run.events).toHaveLength(count);
  });
});

describe("Observer Guard new user tasks", () => {
  it("retains prior diagnostics and assesses a reused runtime's next real user task independently", async () => {
    const run = fixture({ observerGuard: { ...observerGuard, mode: "observe" } });
    reviewer.mockRejectedValueOnce(new Error("provider failed"));
    reviewer.mockImplementationOnce(async (_provider, context) => verdict(context, { verdict: "complete" }));
    await run.runtime.prompt("Implement the first fix.", "first");
    await run.runtime.prompt("Implement the second fix.", "second");
    expect(reviewer).toHaveBeenCalledTimes(2);
    const saved = rows(run.events).flatMap(message => message.runDiagnostics?.observer ? [message.runDiagnostics.observer] : []);
    expect(saved.map(row => row.status)).toEqual(["error", "assessed"]);
    expect(new Set(saved.map(row => row.messageId)).size).toBe(2);
  });

  it.each(["host", "approval"] as const)("does not infer user authority from a %s continuation's instruction text", async origin => {
    const run = fixture({ observerGuard });
    await run.runtime.prompt({ text: "Implement the fix.", modeTurn: { runId: "run", stageId: "stage", origin, enteredStage: false, input: "Implement the fix.", artifactPaths: {} } });
    expect(reviewer).not.toHaveBeenCalled();
    expect(run.requests).toHaveLength(1);
    expect(assessment(run.events)).toBeUndefined();
  });
});
