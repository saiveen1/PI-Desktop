import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerSubagentRecoveryIpc } = await import("../electron/main/ipc/subagent-recovery-ipc.ts");
const { createSessionCoordination } = await import("../electron/main/runtime/session-coordination.ts");
const { IPC } = await import("@pi-desktop/shared");
const request = { sessionId: "session", delegationId: "old", messageId: "message", content: "Follow-up" };
function fixture(active = true, respond = async () => ({ accepted: true, delivery: "steered" })) {
  const handlers = new Map(), calls = [], starts = [], finishes = [], listeners = new Set();
  const activeTurns = new Map(active ? [["session", "parent"]] : []);
  const coordination = createSessionCoordination({ activeTurns, getMainWindow: () => null, getViewingSessionId: () => null });
  const sidecar = {
    setProjectInstructionRoot() {},
    onNotification(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async call(method, params) {
      calls.push({ method, params });
      if (params.provider) for (const listener of listeners) listener("agent.event", {
        sessionId: "session", turnId: "manual", event: { type: "agent_start" },
      });
      return respond(params);
    },
  };
  registerSubagentRecoveryIpc({ handle: (channel, handler) => handlers.set(channel, handler),
    getHost: () => ({ async call(method) {
      calls.push({ method });
      if (method === "session.get") return { session: { id: "session" } };
      if (method === "session.beginTurn") return { turnId: "manual" };
      return {};
    } }), getSidecar: () => sidecar, activeTurns,
    acquireSessionOperation: coordination.acquireSessionOperation,
    resolveAgentRuntimeLaunch: async () => ({ providerId: "provider", modelId: "model", sidecarParams: { sessionId: "session", provider: {} } }),
    recordTurnStart: (...args) => starts.push(args), activeTurnUsages: new Map(), finishTurn: async (...args) => finishes.push(args),
  });
  return { send: input => handlers.get(IPC.invoke.agentSendSubagentMessage)(input ?? request), calls, starts, finishes, listeners, activeTurns, coordination };
}

test("direct child message reuses the active turn and sends only bounded identity and input", async () => {
  const f = fixture();
  assert.equal((await f.send()).accepted, true);
  assert.deepEqual(f.calls, [{ method: "agent.sendSubagentMessage", params: { ...request, turnId: "parent" } }]);
  assert.deepEqual(f.starts, []); assert.deepEqual(f.finishes, []);
});
test("idle direct input creates a recovery owner and removes its startup listener", async () => {
  const f = fixture(false);
  await f.send();
  assert.deepEqual(f.starts, [["session", "manual"]]);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.calls.at(-1).params.content, request.content);
  assert.equal(f.calls.at(-1).params.messageId, request.messageId);
});
test("invalid and unsupported messages cannot create turns or dispatch calls", async () => {
  for (const input of [{ ...request, content: " " }, { ...request, messageId: "" }, { ...request, content: "x".repeat(32001) },
    { ...request, model: "bypass" }, { ...request, sessionId: "remote:session" }, { ...request, sessionId: "native-pi:session" }]) {
    const f = fixture(false);
    await assert.rejects(f.send(input)); assert.deepEqual(f.calls, []);
  }
});
test("message rejection never finalizes an active parent", async () => {
  const f = fixture(true, async () => { throw new Error("stale target"); });
  await assert.rejects(f.send(), /stale target/);
  assert.deepEqual(f.finishes, []); assert.equal(f.activeTurns.get("session"), "parent");
});
test("a pending message admission releases the operation lock for Stop", async () => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const f = fixture(true, async () => { entered.resolve(); await gate.promise; return { accepted: false }; });
  const sending = f.send(); await entered.promise;
  let acquired = false;
  const stopping = f.coordination.acquireSessionOperation("session").then(release => { acquired = true; release(); });
  await setImmediate();
  try { assert.equal(acquired, true); } finally { gate.resolve(); await sending; await stopping; }
});
