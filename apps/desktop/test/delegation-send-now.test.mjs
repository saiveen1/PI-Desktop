import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { createAgentHostBridge, DESKTOP_PRINCIPAL } = await import("../electron/main/agent-host-bridge.ts");
const { IPC } = await import("@pi-desktop/shared");

function fixture(mode) {
  const calls = [];
  const approvals = [];
  const persisted = new Map();
  const host = { async call(method, params) {
    if (method === "session.get") return { session: { id: params.id, permissionMode: "auto", mode: "agent" } };
    if (method === "session.queueList") return { entries: [...persisted.values()] };
    if (method === "session.queuePush") { persisted.set(params.id, params); return {}; }
    if (method === "session.queueRemove") return { removed: persisted.delete(params.id) };
    if (method === "session.queuePrioritize") return {};
    if (method === "session.collaboration.fail") return {};
    throw new Error(`Unexpected host method: ${method}`);
  } };
  const bridge = createAgentHostBridge({
    channels: IPC.invoke, getHost: () => host, isSessionBusy: () => false, log() {},
    ...(mode === "missing" ? {} : { authorizeCollaborationDispatch: async (...args) => {
      approvals.push(args);
      if (mode === "deny") throw new Error("Model approval denied");
    } }),
    invoke: async (channel, [request]) => {
      calls.push({ channel, request });
      return { accepted: true, turnId: "active-runtime-turn" };
    },
  });
  return { bridge, calls, approvals };
}

for (const mode of ["deny", "missing", "allow"]) {
  test(`Send now preserves the collaboration model gate (${mode})`, async () => {
    const { bridge, calls, approvals } = fixture(mode);
    await bridge.agentHost.startTurn(DESKTOP_PRINCIPAL, {
      sessionId: "s1", input: { text: "User's existing task" }, context: { requestId: "first" },
    });
    const queued = await bridge.agentHost.startTurn(DESKTOP_PRINCIPAL, {
      sessionId: "s1", admission: "queue", input: { text: "Delegated follow-up", sessionMessageId: "message-1" },
      context: { requestId: "delegated" },
    });
    assert.equal(approvals.length, 0, "queue admission must not spend an approval");
    await bridge.agentHost.prioritizeTurn(DESKTOP_PRINCIPAL, queued.turn.id);
    const steers = calls.filter((call) => call.channel === IPC.invoke.agentSteer);
    if (mode === "allow") {
      assert.deepEqual(approvals, [["s1", "message-1", "Delegated follow-up"]]);
      assert.equal(steers.length, 1);
      assert.equal(steers[0].request.messageId, "message-1");
      assert.equal(steers[0].request.expectedTurnId, "active-runtime-turn");
    } else {
      assert.equal(steers.length, 0, "unapproved collaboration input must never reach the running model");
      assert.ok(bridge.agentHost.queueEntries("s1").some((entry) => entry.turn.id === queued.turn.id));
    }
    assert.equal(calls.filter((call) => call.channel === IPC.invoke.agentPrompt).length, 1);
  });
}
