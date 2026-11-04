import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";
import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import { IPC, IPC_WHITELIST } from "../../../packages/shared/src/protocol.ts";

const source = fs.readFileSync(new URL("../electron/main/ipc/session-ipc.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
const imports = {
  electron: { shell: {} }, "node:fs": fs, "node:path": path,
  "@pi-desktop/shared": { IPC, ErrorCodes }, "../importers": {},
  "../services/session-collaboration": {}, "../services/session-search": {},
  "../bootstrap/remote-hosts.js": { getActiveRemoteHostsBoot: () => null },
};
const module = { exports: {} };
new Function("require", "exports", "module", outputText)((id) => {
  assert.ok(Object.hasOwn(imports, id), "unexpected dependency: " + id);
  return imports[id];
}, module.exports, module);
const { registerSessionIpc } = module.exports;

function harness({ drain = async () => {}, hostResult = { ok: true } } = {}) {
  const handlers = new Map();
  const events = [];
  const activeTurns = new Map();
  const projects = new Map([["session", "/project"]]);
  let host = { call: async (method, input) => { events.push([method, input]); return hostResult; } };
  const sidecar = {
    clearProjectInstructionRoot: (id) => events.push(["clearRoot", id]),
    clearVendorAuthBindings: (id) => events.push(["clearAuth", id]),
    call: async (method, input) => { events.push([method, input]); },
  };
  registerSessionIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host, getSidecar: () => sidecar, activeTurns, sessionProjects: projects,
    acquireSessionOperation: async (id) => {
      events.push(["acquire", id]); return () => events.push(["release", id]);
    },
    persistenceOutbox: {
      prepareSessionMutation: async (id) => { events.push(["drain", id]); await drain(); },
      dropSession: async (id) => { events.push(["drop", id]); },
    },
    forgetTranscriptRewriteHistory: (id) => events.push(["forget", id]),
    logger: { app() {} }, plugins: { broadcastEvent() {} },
  });
  return {
    invoke: (channel, value) => handlers.get(channel)(value), events, activeTurns, projects,
    replaceHost: () => { host = { call: async () => assert.fail("replacement host must not receive stale mutation") }; },
  };
}

test("recycle-bin IPC channels are allowlisted and preserve history before trashing", async () => {
  for (const channel of [IPC.invoke.sessionTrashList, IPC.invoke.sessionTrash, IPC.invoke.sessionTrashRestore, IPC.invoke.sessionTrashDelete]) {
    assert.ok(IPC_WHITELIST.has(channel));
  }
  const h = harness();
  await h.invoke(IPC.invoke.sessionTrash, "session");
  assert.deepEqual(h.events.map(([name]) => name), ["acquire", "drain", "session.trash", "forget", "clearRoot", "clearAuth", "agent.disposeSession", "release"]);
  assert.equal(h.projects.has("session"), false);
});

test("restore does not discard runtime history and purge cleans only after host success", async () => {
  const restored = harness();
  await restored.invoke(IPC.invoke.sessionTrashRestore, "session");
  assert.deepEqual(restored.events.map(([name]) => name), ["acquire", "session.restoreTrashed", "release"]);
  const purged = harness();
  await purged.invoke(IPC.invoke.sessionTrashDelete, "session");
  assert.ok(purged.events.findIndex(([name]) => name === "session.deleteTrashed") < purged.events.findIndex(([name]) => name === "drop"));
  const missing = harness({ hostResult: { ok: false } });
  await missing.invoke(IPC.invoke.sessionTrashDelete, "session");
  assert.deepEqual(missing.events.map(([name]) => name), ["acquire", "session.deleteTrashed", "release"]);
});

test("invalid, nonlocal and active targets are rejected without mutation", async () => {
  for (const channel of [IPC.invoke.sessionTrash, IPC.invoke.sessionTrashRestore, IPC.invoke.sessionTrashDelete]) {
    for (const id of [null, 1, "", " ", "x".repeat(257), "native-pi:id", "remote:host:id"]) {
      const h = harness();
      await assert.rejects(h.invoke(channel, id), { errorCode: ErrorCodes.INVALID_ARGUMENT });
      assert.deepEqual(h.events, []);
    }
    const h = harness();
    h.activeTurns.set("session", "turn");
    await assert.rejects(h.invoke(channel, "session"), { errorCode: ErrorCodes.AGENT_BUSY });
    assert.deepEqual(h.events.map(([name]) => name), ["acquire", "release"]);
  }
});

test("failed persistence or a changed host leaves the session untouched and releases its lock", async () => {
  const failed = harness({ drain: async () => { throw new Error("pending append"); } });
  await assert.rejects(failed.invoke(IPC.invoke.sessionTrash, "session"), /pending append/);
  assert.deepEqual(failed.events.map(([name]) => name), ["acquire", "drain", "release"]);
  assert.equal(failed.projects.has("session"), true);
  let release;
  const changed = harness({ drain: () => new Promise((resolve) => { release = resolve; }) });
  const pending = changed.invoke(IPC.invoke.sessionTrash, "session");
  await Promise.resolve();
  changed.replaceHost();
  release();
  await assert.rejects(pending, { errorCode: ErrorCodes.HOST_UNAVAILABLE });
  assert.deepEqual(changed.events.map(([name]) => name), ["acquire", "drain", "release"]);
});
