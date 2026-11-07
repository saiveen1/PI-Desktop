import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const { createSessionCoordination } = await import("../electron/main/runtime/session-coordination.ts");
const { IPC } = await import("@pi-desktop/shared");

const sessionId = "retry-session";
const delegationId = "failed-delegation";
const request = { sessionId, delegationId: ` ${delegationId} ` };

function fixture({ activeTurnId, retry, abort, deferStart = false } = {}) {
  const handlers = new Map();
  const hostCalls = [];
  const sidecarCalls = [];
  const roots = [];
  const starts = [];
  const finishes = [];
  const launches = [];
  const listeners = new Set();
  const emitStart = (turnId, sid = sessionId) => {
    for (const listener of listeners) listener("agent.event", { sessionId: sid, turnId, event: { type: "agent_start" } });
  };
  const activeTurns = new Map(activeTurnId ? [[sessionId, activeTurnId]] : []);
  const coordination = createSessionCoordination({
    activeTurns,
    getMainWindow: () => null,
    getViewingSessionId: () => null,
    onTurnStarted: (sid, turnId) => starts.push({ sessionId: sid, turnId }),
  });
  const usage = { inputTokens: 12, outputTokens: 7, totalTokens: 19 };
  coordination.activeTurnUsages.set(sessionId, usage);
  const launch = {
    workspaceRoot: "/fixture/root",
    providerId: "fixture-provider",
    modelId: "fixture-model",
    sidecarParams: { sessionId, mode: "agent", provider: { id: "fixture-provider" } },
  };
  const host = {
    async call(method, params) {
      hostCalls.push({ method, params });
      if (method === "settings.get") return { fixtureSettings: true };
      if (method === "session.get") return { session: { id: sessionId } };
      if (method === "session.beginTurn") return { turnId: "manual-turn" };
      assert.fail(`Unexpected Host RPC: ${method}`);
    },
  };
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => ({
      setProjectInstructionRoot: (...args) => roots.push(args),
      onNotification(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async call(method, params) {
        sidecarCalls.push({ method, params });
        if (method === "agent.abort") return abort?.(params) ?? { ok: true };
        assert.equal(method, "agent.retrySubagent");
        if (params.provider && !deferStart) emitStart(params.turnId);
        if (retry) return retry(params);
        return { accepted: true, turnId: params.turnId, delegationId: "resumed-delegation", resumedFrom: delegationId };
      },
    }),
    getAgentHostBridge: () => null,
    logger: { app() {} },
    agentExtensions: { cancelPrompts() {} },
    cancelSessionTools() {},
    persistenceOutbox: {},
    dataDir: "/unused",
    activeTurns,
    completionNoticeTurns: new Set(),
    recordTurnStart: coordination.recordTurnStart,
    isTurnDispatchable: coordination.isTurnDispatchable,
    activeTurnUsages: coordination.activeTurnUsages,
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    async resolveAgentRuntimeLaunch(...args) {
      launches.push(args);
      return launch;
    },
    acquireSessionOperation: coordination.acquireSessionOperation,
    async finishTurn(...args) {
      finishes.push(args);
      activeTurns.delete(args[0]);
    },
    lockAbortReason: coordination.lockAbortReason,
    async finishApprovedExecution() {},
    async dispatchApprovedPlan() {},
    async dispatchExecutionForProposal() {},
    emitAgentEvent() {},
    setNotificationViewingSessionId() {},
    async optionalWorkspaceRoot() { return null; },
    composerCommandService: { async buildComposerCommands() { return []; } },
    async loadComposerTemplatesCached() { return []; },
  });
  return {
    retry: (input = request) => handlers.get(IPC.invoke.agentRetrySubagent)(input),
    abort: (turnId) => handlers.get(IPC.invoke.agentAbort)({ sessionId, turnId }),
    emitStart, listeners,
    activeTurns, coordination, usage, hostCalls, sidecarCalls, roots, starts, finishes, launches, launch,
  };
}

function assertActiveUntouched(f, turnId = "parent-turn") {
  assert.equal(f.activeTurns.get(sessionId), turnId);
  assert.equal(f.coordination.activeTurnUsages.get(sessionId), f.usage);
  assert.deepEqual(f.hostCalls, []);
  assert.deepEqual(f.roots, []);
  assert.deepEqual(f.launches, []);
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.finishes, []);
}

test("active parent retry reuses its durable turn without reconfiguration or lifecycle changes", async () => {
  const result = { accepted: true, turnId: "parent-turn", delegationId: "resumed", resumedFrom: delegationId };
  const f = fixture({ activeTurnId: "parent-turn", retry: () => result });
  assert.equal(await f.retry(), result);
  assert.deepEqual(f.sidecarCalls, [{
    method: "agent.retrySubagent",
    params: { sessionId, turnId: "parent-turn", delegationId },
  }]);
  assertActiveUntouched(f);
});

test("active retry admission errors and refusals leave the parent intact and release the lock", async () => {
  const error = Object.assign(new Error("Model authorization denied"), { errorCode: "MODEL_NOT_AUTHORIZED" });
  const refusal = { accepted: false, turnId: "parent-turn", resumedFrom: delegationId, error: "No retained history" };
  let attempt = 0;
  const f = fixture({ activeTurnId: "parent-turn", retry: () => {
    if (attempt++ === 0) throw error;
    return refusal;
  } });
  await assert.rejects(f.retry(), (caught) => caught === error);
  assertActiveUntouched(f);
  assert.equal(await f.retry(), refusal, "the rejection must release the session lock");
  assertActiveUntouched(f);
  assert.equal(f.sidecarCalls.length, 2, "Main must never replay admission automatically");
});

test("idle retry creates a manual turn with existing launch configuration", async () => {
  const f = fixture();
  const result = await f.retry();
  assert.equal(result.turnId, "manual-turn");
  assert.deepEqual(f.hostCalls.map(({ method }) => method), ["settings.get", "session.get", "session.beginTurn"]);
  assert.deepEqual(f.hostCalls.at(-1).params, {
    sessionId, providerId: "fixture-provider", modelId: "fixture-model",
  });
  assert.deepEqual(f.roots, [[sessionId, "/fixture/root"]]);
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.starts, [{ sessionId, turnId: "manual-turn" }]);
  assert.equal(f.activeTurns.get(sessionId), "manual-turn");
  assert.equal(f.coordination.activeTurnUsages.has(sessionId), false);
  assert.deepEqual(f.finishes, []);
  assert.deepEqual(f.sidecarCalls[0].params, { ...f.launch.sidecarParams, turnId: "manual-turn", delegationId });
});

test("idle admission errors finalize only the newly created manual turn", async () => {
  const error = Object.assign(new Error("Retry failed"), { errorCode: "RETRY_FAILED" });
  const f = fixture({ retry: () => { throw error; } });
  await assert.rejects(f.retry(), (caught) => caught === error);
  assert.deepEqual(f.finishes, [[sessionId, "error", "RETRY_FAILED", { turnId: "manual-turn" }]]);
  assert.equal(f.activeTurns.has(sessionId), false);
  const release = await f.coordination.acquireSessionOperation(sessionId);
  release();
});

test("retry retains native and remote capability restrictions before any side effects", async () => {
  for (const [sid, errorCode] of [["native-pi:fixture", "NATIVE_PI_UNSUPPORTED"], ["remote:fixture", "CAPABILITY_UNAVAILABLE"]]) {
    const f = fixture({ activeTurnId: "parent-turn" });
    f.activeTurns.set(sid, "restricted-turn");
    await assert.rejects(f.retry({ sessionId: sid, delegationId }), { errorCode });
    assert.equal(f.activeTurns.get(sid), "restricted-turn");
    assert.deepEqual(f.sidecarCalls, []);
    assertActiveUntouched(f);
  }
});

test("duplicate requests target the same turn without holding its lock during authorization", async () => {
  const entered = Promise.withResolvers();
  const admission = Promise.withResolvers();
  let contenderAcquired = false;
  let calls = 0;
  const f = fixture({ activeTurnId: "parent-turn", retry: async (params) => {
    assert.equal(params.turnId, "parent-turn");
    if (++calls === 1) {
      entered.resolve();
      await admission.promise;
    }
    return { accepted: true, turnId: params.turnId, delegationId: "same-resumed-chain", resumedFrom: delegationId };
  } });
  const first = f.retry();
  // Release the explicit barrier even if a regression rejects before admission.
  void first.catch(() => entered.resolve());
  await entered.promise;
  const lockContender = f.coordination.acquireSessionOperation(sessionId).then((release) => {
    contenderAcquired = true;
    release();
  });
  const second = f.retry();
  const results = Promise.allSettled([first, second]);
  // Flush queued admission/lock continuations, without a time-based wait.
  await setImmediate();
  const callsDuringAdmission = calls;
  const contenderDuringAdmission = contenderAcquired;
  admission.resolve();
  const [a, b] = await results;
  await lockContender;
  assert.equal(callsDuringAdmission, 2, "runtime coalesces concurrent admissions for the same chain");
  assert.equal(contenderDuringAdmission, true, "authorization must not hold the session operation lock");
  assert.equal(a.status, "fulfilled");
  assert.equal(b.status, "fulfilled");
  assert.deepEqual(a.value, b.value);
  assert.equal(calls, 2);
  assertActiveUntouched(f);
});

test("a parent ending during admission is not replaced by a manual turn or replayed", async () => {
  const error = Object.assign(new Error("The target turn has ended"), { errorCode: "TURN_NOT_FOUND" });
  const f = fixture({ activeTurnId: "parent-turn", retry: (params) => {
    assert.equal(params.turnId, "parent-turn");
    f.activeTurns.delete(sessionId);
    throw error;
  } });
  await assert.rejects(f.retry(), (caught) => caught === error);
  assert.equal(f.activeTurns.has(sessionId), false);
  assert.equal(f.sidecarCalls.length, 1);
  assert.deepEqual(f.hostCalls, []);
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.finishes, []);
});

for (const activeTurnId of [undefined, "parent-turn"]) {
  test(`Stop reaches a pending ${activeTurnId ? "active" : "idle"} retry authorization`, async () => {
    const entered = Promise.withResolvers();
    const admission = Promise.withResolvers();
    const turnId = activeTurnId ?? "manual-turn";
    const f = fixture({ activeTurnId,
      retry: async () => { entered.resolve(); await admission.promise; return { accepted: false, turnId, resumedFrom: delegationId, error: "cancelled" }; },
      abort: () => { admission.resolve(); return { ok: true }; },
    });
    const retrying = f.retry();
    await entered.promise;
    const stopping = f.abort(turnId);
    try {
      await setImmediate();
      assert.equal(f.sidecarCalls.some(call => call.method === "agent.abort"), true, "Stop must not wait for authorization");
      assert.equal((await retrying).accepted, false);
      await stopping;
      assert.equal(f.listeners.size, 0);
      assert.equal(f.activeTurns.has(sessionId), false);
    } finally { admission.resolve(); await Promise.allSettled([retrying, stopping]); }
  });
}

test("idle retry keeps the startup fence until its own runtime starts and removes the listener", async () => {
  const entered = Promise.withResolvers();
  const admission = Promise.withResolvers();
  const f = fixture({ deferStart: true,
    retry: async () => { entered.resolve(); await admission.promise; return { accepted: false, turnId: "manual-turn", resumedFrom: delegationId, error: "cancelled" }; },
    abort: () => { admission.resolve(); return { ok: true }; },
  });
  const retrying = f.retry();
  await entered.promise;
  const stopping = f.abort("manual-turn");
  try {
    f.emitStart("other-turn");
    f.emitStart("manual-turn", "other-session");
    await setImmediate();
    assert.equal(f.sidecarCalls.some(call => call.method === "agent.abort"), false);
    f.emitStart("manual-turn");
    await setImmediate();
    assert.equal(f.sidecarCalls.some(call => call.method === "agent.abort"), true);
    await Promise.all([retrying, stopping]);
    assert.equal(f.listeners.size, 0);
  } finally { admission.resolve(); await Promise.allSettled([retrying, stopping]); }
});
