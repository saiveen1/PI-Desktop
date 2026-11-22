import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { setImmediate as drain } from "node:timers/promises";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { IPC } = await import("@pi-desktop/shared");
const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const { createAgentHostBridge } = await import("../electron/main/agent-host-bridge.ts");
const { createSessionCoordination } = await import("../electron/main/runtime/session-coordination.ts");
const { createEventPersistence } = await import("../electron/main/runtime/event-persistence.ts");
const { createPlanRuntime } = await import("../electron/main/runtime/plans.ts");
const { cancelEndlessContinuation } = await import("../electron/main/runtime/endless-continuations.ts");

function fixture(id, locale = "en") {
  const handlers = new Map(), activeTurns = new Map(), events = [], prompts = [], human = [], logs = [];
  const session = { id, mode: "agent", observerMode: "endless", permissionMode: "ask", messages: [] };
  const f = { session, prompts, events, human, logs, cap: 2, ended: [], permissions: [], plans: [] };
  const logger = { app(...args) { logs.push(args); } };
  const coord = createSessionCoordination({ activeTurns, getMainWindow: () => null, getViewingSessionId: () => null });
  let serial = 0, open, diagnostics;
  const host = { async call(method, p) {
    switch (method) {
      case "session.get": return { session: { ...session, messages: session.messages.slice(-1) } };
      case "settings.get": return {};
      case "session.queueList": return { entries: [] };
      case "session.queuePush": return {};
      case "session.queueRemove": return { removed: true };
      case "session.beginTurn": assert.equal(open, undefined, "no parallel durable turns"); open = `t${++serial}`; return { turnId: open };
      case "session.appendMessage": session.messages.push(structuredClone(p.message)); return { insertedUserMessageId: p.message.id };
      case "session.endTurn": assert.equal(open, p.turnId); await f.endGate; open = undefined; f.ended.push(p); return { ok: f.durable !== false };
      case "session.saveActiveRevision": return {};
      case "permissions.pending": return { requests: f.permissions };
      case "plans.pending": return { plans: f.plans };
      case "backgroundTasks.list": return { tasks: f.jobs ?? [] };
      default: assert.fail(method);
    }
  } };
  const sidecar = { setProjectInstructionRoot() {}, async call(method, p) {
    if (method === "agent.stop") return { requested: true };
    if (method === "agent.getStatus") {
      const currentTurnId = diagnostics?.turnId;
      f.checking?.resolve(); await f.checkGate;
      return { personaConfigurationBlocked: false, status: { currentTurnId, sessionId: id, isRunning: false,
        pendingToolConfirmations: 0, planningState: "inactive", runDiagnostics: diagnostics } };
    }
    assert.equal(method, "agent.prompt"); assert.equal(open, p.turnId);
    prompts.push(p); send(p.turnId, { type: "agent_start" }); return { accepted: true, turnId: p.turnId };
  } };
  const bridge = createAgentHostBridge({ getHost: () => host, channels: IPC.invoke, invoke: (ch, args) => handlers.get(ch)(...args),
    isSessionBusy: coord.isSessionBusy, log(level, message, detail) { logs.push([level, message, detail]); } });
  const runtimeState = { host, sidecar, agentHostBridge: bridge };
  const maps = { scheduledRunsBySession: new Map(), activeToolCalls: new Map(), planSubmissionTurnIds: new Set(),
    approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(), approvedExecutionTurns: new Map(),
    startedApprovedExecutions: new Set(), finishedApprovedExecutions: new Set(), dispatchingApprovedExecutions: new Set(),
    inFlightExecutionFinishes: new Set(), pendingExecutionFinishes: new Map(), completionNoticeTurns: new Set() };
  const emit = envelope => { if (!coord.isStaleTerminalEvent(envelope)) { bridge.ingest(envelope); events.push(envelope); } };
  const { finishTurn, finishApprovedExecution } = createPlanRuntime({ ...maps, runtimeState, coordination: coord, planState: {}, logger,
    announceTurnEnded() {}, emitAgentEvent: emit, sendToRenderer() {}, isQuitting: () => false });
  const persistenceOutbox = { async prepareSessionMutation() {}, size: () => 0, async enqueue({ message, turnId }) {
    if (message) session.messages.push({ ...message, turnId });
  } };
  const persistence = createEventPersistence({ ...maps, ...coord, runtimeState, steeringReplies: new Set(), persistenceOutbox,
    inflightCheckpointer: { observe() {}, async flush() {}, settleIf() {} }, logger, finishTurn, transcriptRewrite: coord,
    finishApprovedExecution, emitAgentEvent: emit });
  function send(turnId, event) { const envelope = { sessionId: id, turnId, ts: Date.now(), event }; emit(envelope); persistence.persistAgentEvent(envelope); }
  registerAgentIpc({ ...maps, ...coord, registrar: { handle: (c, h) => handlers.set(c, h) }, getLocale: () => locale,
    getHost: () => runtimeState.host, getSidecar: () => runtimeState.sidecar, getAgentHostBridge: () => bridge, logger, persistenceOutbox,
    modeRuns: { definitionForPrompt: async () => undefined, prepareTurn: async () => undefined },
    resolveAgentRuntimeLaunch: async (_id, snapshot) => {
      f.launching?.resolve(); await f.launchGate;
      const reviewer = snapshot.observerMode === "guard" ? { id: "reviewer", modelId: f.reviewerModel ?? "judge" } : undefined;
      return { providerId: "p", modelId: "m", sidecarParams: { mode: "agent", provider: { modelConfig: { input: ["text"] } },
        observerGuard: { mode: snapshot.observerMode, provider: reviewer, settings: { maxContinuations: f.cap,
          ...(reviewer ? { providerId: reviewer.id, modelId: reviewer.modelId } : {}) } } } };
    },
    finishTurn, emitAgentEvent: emit, setNotificationViewingSessionId() {}, observePersistedUserMessage: msg => human.push(msg) });
  return Object.assign(f, { runtimeState, sidecar,
    prompt: (content, extra = {}) => handlers.get(IPC.invoke.agentPrompt)({ sessionId: id, content, ...extra }),
    stop: turnId => handlers.get(IPC.invoke.agentStop)({ sessionId: id, turnId }),
    queue: content => handlers.get(IPC.invoke.agentQueuePush)({ sessionId: id, content }),
    answer(extra = {}) {
      const turnId = open, messageId = `reply-${turnId}`;
      diagnostics = { turnId, endedAt: Date.now(), termination: { stopReason: "stop", messageId }, observer: {
        messageId, mode: "endless", status: "assessed", decision: "continue", continued: false, continuationCount: 0, maxContinuations: f.cap, ...extra } };
      send(turnId, { type: "message_end", message: { id: messageId, role: "assistant", content: "Done.", status: "complete", runDiagnostics: diagnostics } });
      return turnId;
    },
    end: turnId => send(turnId, { type: "agent_end", messageIds: [] }),
    async finish() { const turn = this.answer(); this.end(turn); await drain(); }
  });
}

for (const [locale, expected] of [["en", "Continue (Automatic 1/2)"], ["zh-CN", "继续（自动 1/2）"]]) {
  test(`manual input → separate, visible real user turns; bounded across successful starts (${locale})`, async () => {
    const f = fixture(locale, locale); await f.prompt("Do the task");
    const first = f.answer(), gate = Promise.withResolvers(); f.endGate = gate.promise;
    f.end(first); f.end(first); await drain(); assert.equal(f.prompts.length, 1);
    gate.resolve(); await drain(); assert.equal(f.prompts.length, 2, JSON.stringify(f.logs));
    f.cap = 100; await f.finish(); await f.finish(); f.end(first); await drain();
    assert.deepEqual(f.prompts.map(p => p.content), ["Do the task", expected, expected.replace("1/2", "2/2")]);
    assert.deepEqual(f.session.messages.map(m => m.role), ["user", "assistant", "user", "assistant", "user", "assistant"]);
    const users = f.session.messages.filter(m => m.role === "user");
    assert.deepEqual(users.map(m => m.id), f.prompts.map(p => p.userMessageId));
    assert.equal(new Set(users.map(m => m.turnId)).size, 3);
    assert.deepEqual(f.events.filter(e => e.event.type === "message_end" && e.event.message.role === "user").map(e => e.event.message), users);
    assert.equal(f.human.length, 1, "automatic rows are not new human submissions for plugins");
  });
}

test("optional recovery and automatic turns share the original allowance", async () => {
  const f = fixture("shared-allowance"); await f.prompt("first");
  assert.equal(f.prompts[0].observerGuard.endlessRemaining, 2);
  const first = f.answer({ endlessRecoveriesUsed: 1 }); f.end(first); await drain();
  assert.equal(f.prompts[1]?.content, "Continue (Automatic 2/2)");
  assert.equal(f.prompts[1].observerGuard.endlessRemaining, 0);
  await f.finish(); assert.equal(f.prompts.length, 2);
});

for (const used of [-1, 0.5, 3]) test(`invalid recovery charge ${used} cannot authorize additional work`, async () => {
  const f = fixture(`charge-${used}`); await f.prompt("first");
  f.end(f.answer({ endlessRecoveriesUsed: used })); await drain();
  assert.equal(f.prompts.length, 1);
});

for (const action of ["disable", "stop", "stale-sidecar", "supersede"]) test(`${action} during post-settlement IO revokes the old result`, async () => {
  const f = fixture(action); await f.prompt("first");
  const gate = Promise.withResolvers(); f.checkGate = gate.promise; f.checking = Promise.withResolvers();
  const turn = f.answer(); f.end(turn); await f.checking.promise;
  if (action === "disable") { cancelEndlessContinuation(action); f.session.observerMode = "off"; }
  if (action === "stop") await f.stop(turn);
  if (action === "stale-sidecar") f.runtimeState.sidecar = {};
  if (action === "supersede") await f.prompt("real replacement");
  gate.resolve(); await drain(); assert.deepEqual(f.prompts.map(p => p.content), action === "supersede" ? ["first", "real replacement"] : ["first"]);
});

for (const action of ["stored-off", "permission", "plan", "running-job", "pending-job", "failed-end", "wrong-owner", "already-continued"]) test(`${action} cannot authorize a follow-up`, async () => {
  const f = fixture(action); await f.prompt("first");
  if (action === "stored-off") f.session.observerMode = "off";
  if (action === "permission") f.permissions.push({ id: "pending" });
  if (action === "plan") f.plans.push({ id: "pending" });
  if (action === "running-job") f.jobs = [{ sessionId: action, state: "running" }];
  if (action === "pending-job") f.jobs = [{ sessionId: action, state: "exited", continuation: "pending" }];
  if (action === "failed-end") f.durable = false;
  const turn = f.answer(action === "wrong-owner" ? { messageId: "earlier" } : action === "already-continued" ? { continued: true } : {});
  f.end(turn); await drain(); assert.equal(f.prompts.length, 1);
});

test("a queued manual prompt wins over a late eligible result and gets its own allowance", async () => {
  const f = fixture("fifo"); await f.prompt("first"); const turn = f.answer();
  await f.queue("new instructions"); f.end(turn); await drain();
  assert.deepEqual(f.prompts.map(p => p.content), ["first", "new instructions"]);
  await f.finish(); assert.equal(f.prompts[2]?.content, "Continue (Automatic 1/2)", JSON.stringify(f.logs));
});

for (const revoke of ["off", "cancel"]) test(`recheck ${revoke} after launch IO, before opening a new turn`, async () => {
  const f = fixture(revoke); await f.prompt("first");
  const gate = Promise.withResolvers(); f.launching = Promise.withResolvers(); f.launchGate = gate.promise;
  f.end(f.answer()); await f.launching.promise;
  if (revoke === "off") f.session.observerMode = "off";
  else cancelEndlessContinuation(revoke);
  gate.resolve(); await drain();
  assert.equal(f.prompts.length, 1); assert.equal(f.session.messages.length, 2); assert.equal(f.ended.length, 1);
});

test("Stop before the late eligible final answer cannot restart the chain", async () => {
  const f = fixture("late"); await f.prompt("first"); await f.stop("t1"); await f.finish();
  assert.equal(f.prompts.length, 1); assert.equal(f.ended[0].status, "completed");
});

test("typing the automatic label is still explicit user input, not trusted provenance", async () => {
  const f = fixture("typed"); await f.prompt("Continue (Automatic 2/2)"); await f.finish();
  assert.equal(f.human.length, 1); assert.equal(f.prompts[1].content, "Continue (Automatic 1/2)");
});

const reviewed = { mode: "guard", modelKey: "reviewer/judge" };
test("Guard dispatches a real user turn only after an approved reply settles, then stops on the next verdict", async () => {
  const f = fixture("reviewed", "zh-CN"); f.session.observerMode = "guard";
  await f.prompt("手动输入");
  const turn = f.answer(reviewed);
  assert.equal(f.prompts.length, 1);
  f.end(turn); await drain();
  assert.deepEqual(f.prompts.map(p => p.content), ["手动输入", "继续（自动 1/2）"]);
  assert.notEqual(f.prompts[0].turnId, f.prompts[1].turnId);
  assert.deepEqual(f.prompts.map(p => p.observerGuard.endlessRemaining), [2, 1]);
  f.end(f.answer({ ...reviewed, decision: "stop", continuationReason: "decision_stop" })); await drain();
  assert.deepEqual(f.session.messages.map(m => m.role), ["user", "assistant", "user", "assistant"]);
});

test("a positive Guard verdict cannot refresh the chain allowance or double-dispatch", async () => {
  const f = fixture("guard-limit"); f.session.observerMode = "guard"; await f.prompt("task");
  const first = f.answer({ ...reviewed, endlessRecoveriesUsed: 1 }); f.end(first); f.end(first); await drain();
  assert.equal(f.prompts[1]?.content, "Continue (Automatic 2/2)");
  assert.equal(f.prompts[1]?.observerGuard.endlessRemaining, 0);
  f.end(f.answer(reviewed)); await drain(); assert.equal(f.prompts.length, 2);
});

for (const cause of ["off", "mode-changed", "wrong-mode", "wrong-reviewer", "changed-reviewer", "error", "cancel"]) {
  test(`Guard: ${cause} rejects a late positive verdict`, async () => {
    const f = fixture(`guard-${cause}`); f.session.observerMode = "guard"; await f.prompt("task");
    const turn = f.answer({ ...reviewed, ...(cause === "wrong-mode" ? { mode: "endless" } : {}),
      ...(cause === "wrong-reviewer" ? { modelKey: "reviewer/other" } : {}), ...(cause === "error" ? { status: "error" } : {}) });
    if (cause === "off") f.session.observerMode = "off";
    if (cause === "mode-changed") f.session.observerMode = "endless";
    if (cause === "changed-reviewer") f.reviewerModel = "replacement";
    if (cause === "cancel") cancelEndlessContinuation(f.session.id);
    f.end(turn); await drain(); assert.deepEqual(f.prompts.map(p => p.content), ["task"]);
  });
}
