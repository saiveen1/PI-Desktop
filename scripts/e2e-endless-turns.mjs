// Headless Desktop conversation: real Rust storage, Main settlement/admission and
// Agent loop; no credentials, installed profile or external model requests.
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { register } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { createSession } from "./e2e/session.mjs";
import { DesktopAgentRuntime } from "../packages/agent-runtime/dist/runtime.js";
import { IPC } from "../packages/shared/dist/index.js";
register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const main = name => import(`../apps/desktop/electron/main/${name}.ts`);
const { cancelEndlessContinuation } = await main("runtime/endless-continuations");
const { PersistenceOutbox } = await main("persistence-outbox");
const { createEventPersistence } = await main("runtime/event-persistence");
const { createPlanRuntime } = await main("runtime/plans");
const { createSessionCoordination } = await main("runtime/session-coordination");
const { createAgentHostBridge } = await main("agent-host-bridge");
const { registerAgentIpc } = await main("ipc/agent-ipc");
const { buildTranscriptEntries } = await import("../apps/desktop/src/lib/assistant-turns.ts");
const { getAssistantTurnSummary } = await import("../apps/desktop/src/lib/transcript-summary.ts");
const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "continuation-turns-"));
process.env.PI_DESKTOP_AGENTS_DIR = join(root, "agents");
await mkdir(process.env.PI_DESKTOP_AGENTS_DIR);
const provider = { id: "fixture", name: "Fixture", modelId: "fixture", apiKey: "", authKind: "none", supportsReasoning: false, supportedThinkingLevels: ["off"] };
const task = "Give a brief answer.";

async function scenario(mode, disableDuringReview = false) {
  const label = disableDuringReview ? "guard-off-during-review" : mode;
  const expectedTurns = disableDuringReview ? 1 : 2;
  const expectedAnswers = Array.from({ length: expectedTurns }, (_, i) => `Answer ${i + 1}.`);
  const workspace = join(root, label, "workspace"), data = join(root, label, "data");
  await mkdir(workspace, { recursive: true });
  process.env.PI_DESKTOP_DATA_DIR = data;
  const host = new Host(resolveHostBinary(), data, { quiet: true });
  const port = { call: (...args) => host.call(...args), isAvailable: () => !!host.child && !host.exited };
  const done = Promise.withResolvers(), jobs = [], settled = [], requests = [], reviews = [], ends = [], errors = [], handlers = new Map();
  const fail = error => { errors.push(error instanceof Error ? error : new Error(String(error))); done.reject(errors[0]); };
  const logger = { app(_area, level, message, detail) { if (level === "error" || level === "warn") fail(`${message}: ${JSON.stringify(detail)}`); } };
  let runtime, persistence, reviewer, timer;
  try {
    await host.start();
    const sessionId = (await createSession(host, workspace, `${label} continuation fixture`)).id;
    await host.call("session.configure", { id: sessionId, mode: "agent", observerMode: mode });
    const disable = async () => {
      cancelEndlessContinuation(sessionId);
      const revoked = await host.call("session.configure", { id: sessionId, mode: "agent", observerMode: "off" });
      assert.equal(revoked.session.observerMode, "off");
    };
    const settings = { maxContinuations: 2 };
    let reviewProvider;
    if (mode === "guard") {
      reviewer = createServer(async (req, res) => {
        try {
          let raw = "";
          for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw);
          assert.equal(req.url, "/v1/chat/completions");
          assert.equal(body.model, "judge");
          assert.ok(!body.tools?.length);
          assert.deepEqual(body.messages.map(m => m.role), ["system", "user"]);
          const content = body.messages[1].content;
          const answer = Array.isArray(content) ? content.map(part => part.text).join("") : content;
          reviews.push(answer);
          assert.equal(answer, expectedAnswers[reviews.length - 1]);
          assert.ok(!raw.includes(task), "reviewer must not receive the human prompt");
          if (disableDuringReview) {
            assert.equal(settled.length, 0);
            await disable(); // The reviewer's late continue must not start a turn.
          }
          const delta = { role: "assistant", content: reviews.length === 1 ? "continue" : "stop" };
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
        } catch (error) { res.writeHead(500); res.end(); fail(error); }
      });
      await new Promise((resolve, reject) => reviewer.once("error", reject).listen(0, "127.0.0.1", resolve));
      reviewProvider = { ...provider, id: "reviewer", modelId: "judge", apiStyle: "chat_completions", baseUrl: `http://127.0.0.1:${reviewer.address().port}/v1` };
      Object.assign(settings, { providerId: reviewProvider.id, modelId: reviewProvider.modelId, timeoutSeconds: 5 });
    }
    const shell = (await host.call("commandShells.list")).effective;
    const coord = createSessionCoordination({ activeTurns: new Map(), getMainWindow: () => null, getViewingSessionId: () => null });
    const maps = { scheduledRunsBySession: new Map(), activeToolCalls: new Map(), planSubmissionTurnIds: new Set(),
      approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(), approvedExecutionTurns: new Map(),
      startedApprovedExecutions: new Set(), finishedApprovedExecutions: new Set(), dispatchingApprovedExecutions: new Set(),
      inFlightExecutionFinishes: new Set(), pendingExecutionFinishes: new Map(), completionNoticeTurns: new Set() };
    const bridge = createAgentHostBridge({ getHost: () => port, channels: IPC.invoke, invoke: (ch, args) => handlers.get(ch)(...args), isSessionBusy: coord.isSessionBusy, log() {} });
    const sidecar = { setProjectInstructionRoot() {}, async call(method, params) {
      if (method === "agent.getStatus") return { status: runtime.getStatus(), personaConfigurationBlocked: runtime.personaConfigurationBlocked() };
      assert.equal(method, "agent.prompt");
      runtime.setObserverGuard(params.observerGuard);
      jobs.push(runtime.prompt(params.content, params.userMessageId, params.turnId).catch(fail));
      return { accepted: true, turnId: params.turnId };
    } };
    const runtimeState = { host: port, sidecar, agentHostBridge: bridge };
    const emit = e => { if (!coord.isStaleTerminalEvent(e)) bridge.ingest(e); };
    const deliver = e => { emit(e); persistence.persistAgentEvent(e); };
    const { finishTurn, finishApprovedExecution } = createPlanRuntime({ ...maps, runtimeState, coordination: coord, logger,
      planState: {}, sendToRenderer() {}, announceTurnEnded() {}, emitAgentEvent: emit, isQuitting: () => false,
      onTurnSettled: async (id, turn) => { assert.equal(id, sessionId); settled.push(turn); if (settled.length === expectedTurns) done.resolve(); },
    });
    const outbox = new PersistenceOutbox(data, (level, message) => logger.app("outbox", level, message));
    persistence = createEventPersistence({ ...maps, ...coord, runtimeState, logger, finishTurn, finishApprovedExecution,
      steeringReplies: new Set(), transcriptRewrite: coord, persistenceOutbox: outbox, emitAgentEvent: emit,
      inflightCheckpointer: { observe() {}, async flush() {}, settleIf() {} } });
    runtime = new DesktopAgentRuntime({ host: port, sessionId, mode: "agent", projectPath: workspace, commandShell: shell,
      provider, thinkingLevel: "off", subagents: [], onEvent: e => { if (e.event.type === "agent_end") ends.push(e); deliver(e); } });
    runtime.models = { streamSimple(_model, context) {
      const stream = createAssistantMessageEventStream();
      requests.push(context.messages.filter(m => m.role === "user").length);
      const step = requests.length;
      const reply = { role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", content: [{ type: "text", text: `Answer ${step}.` }], stopReason: "stop", timestamp: Date.now(), usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      void (async () => {
        assert.ok(step <= expectedTurns, "unexpected extra main request");
        if (step === 2) {
          assert.equal(settled.length, 1, "the original turn must already have ended");
          const { session } = await host.call("session.get", { id: sessionId });
          assert.ok(session.messages.some(m => m.role === "assistant" && m.status === "complete" && m.content === "Answer 1."));
          deliver(ends[0]); // A duplicate terminal event must not settle the new turn.
          if (mode === "endless") await disable();
        }
        stream.push({ type: "start", partial: reply }); stream.push({ type: "done", reason: "stop", message: reply }); stream.end(reply);
      })().catch(error => { fail(error); stream.end(reply); });
      return stream;
    } };
    registerAgentIpc({ ...maps, ...coord, registrar: { handle: (channel, fn) => handlers.set(channel, fn) }, getHost: () => port,
      getSidecar: () => sidecar, getAgentHostBridge: () => bridge, getLocale: () => "zh-CN", dataDir: data, persistenceOutbox: outbox,
      modeRuns: { definitionForPrompt: async () => undefined, prepareTurn: async () => undefined }, logger, finishTurn, emitAgentEvent: emit, setNotificationViewingSessionId() {},
      resolveAgentRuntimeLaunch: async (_id, session) => ({ workspaceRoot: workspace, providerId: provider.id, modelId: provider.modelId, sidecarParams: { sessionId, mode: "agent", provider, observerGuard: { mode: session.observerMode, settings, provider: reviewProvider } } }),
    });
    timer = setTimeout(() => fail(`${label}: ${requests.length} requests, ${reviews.length} reviews, ${settled.length} settlements; ${JSON.stringify(runtime.getStatus().runDiagnostics?.observer)}`), 20_000);
    await Promise.all([done.promise, handlers.get(IPC.invoke.agentPrompt)({ sessionId, content: task })]);
    await Promise.all(jobs); await persistence.flush(); await outbox.prepareSessionMutation(sessionId, () => port);
    const read = async () => (await host.call("session.get", { id: sessionId })).session;
    const before = await read();
    await host.restart();
    for (const end of ends) deliver(end);
    await persistence.flush(); await outbox.prepareSessionMutation(sessionId, () => port);
    const session = await read();
    assert.deepEqual(session.messages, before.messages, "reopen and terminal replay must not change history");
    assert.equal(session.observerMode, mode === "endless" || disableDuringReview ? "off" : "guard");
    assert.deepEqual(requests, expectedAnswers.map((_, i) => i + 1));
    assert.deepEqual(reviews, mode === "guard" ? expectedAnswers : []);
    assert.deepEqual(ends.map(e => e.turnId), settled);
    assert.equal(new Set(settled).size, expectedTurns);
    const { entries } = buildTranscriptEntries(session.messages);
    assert.deepEqual(entries.map(e => e.kind), expectedAnswers.flatMap(() => ["message", "assistant-turn"]));
    if (expectedTurns === 2) assert.match(entries[2].message.content, /继续.*自动.*1\s*\/\s*2/);
    assert.deepEqual(entries.filter(e => e.kind === "message").map(e => [e.message.role, e.message.turnId]), settled.map(id => ["user", id]));
    const answers = entries.filter(e => e.kind === "assistant-turn").map(e => getAssistantTurnSummary(e).responses.map(r => r.message));
    assert.deepEqual(answers.map(turn => turn.map(m => [m.turnId, m.content, m.status])), expectedAnswers.map((text, i) => [[settled[i], text, "complete"]]));
    if (mode === "guard") answers.flat().forEach((message, i) => {
      const marker = message.runDiagnostics?.observer;
      assert.deepEqual([marker?.messageId, marker?.mode, marker?.modelKey, marker?.status, marker?.decision, marker?.continued, marker?.continuationCount, marker?.maxContinuations],
        [message.id, "guard", "reviewer/judge", "assessed", i === 0 ? "continue" : "stop", false, 0, settings.maxContinuations]);
    });
    if (errors.length) throw errors[0];
    console.log(`PASS ${label}: ${settled.length} distinct settled turn(s), ${reviews.length} reviews, replay and reopened transcript verified`);
  } finally {
    clearTimeout(timer); await runtime?.dispose(); await persistence?.flush(); await host.stop();
    if (reviewer?.listening) await new Promise(resolve => reviewer.close(resolve));
  }
}

await scenario("endless");
await scenario("guard");
await scenario("guard", true);
