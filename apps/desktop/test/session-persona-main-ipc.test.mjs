import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";
const require = createRequire(import.meta.url);
function fixture(options = {}) {
  const source = readFileSync(new URL("../electron/main/ipc/session-ipc.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function("require", "exports", "module", code)(id => {
    if (id === "@pi-desktop/shared") return shared;
    if (id.startsWith("node:")) return require(id);
    if (id === "electron") return { shell: {} };
    if (["../importers", "../services/session-collaboration", "../services/session-search", "../bootstrap/remote-hosts.js"].includes(id)) return {};
    throw Error(`Unexpected dependency ${id}`);
  }, module.exports, module);
  const handlers = new Map(), calls = [], active = new Map(); let released = 0;
  const host = { async call(method, input) {
    calls.push([method, input]);
    if (method === "session.get") { if (options.startWhileReading) active.set("s", "turn"); return { session: { id: "s", providerId: "fixture", ...options.session } }; }
    if (method === "session.configurePersona") return { session: { id: input.id, persona: input.personaId === null ? null : { definition: { id: "first" } } } };
    throw Error(`Unexpected RPC ${method}`);
  } };
  module.exports.registerSessionIpc({ registrar: { handle: (channel, fn) => handlers.set(channel, fn) },
    getHost: () => host, getSidecar: () => options.sidecar ?? null, activeTurns: active,
    compactingSessions: options.compactingSessions,
    acquireSessionOperation: async () => () => { released++; },
    sessionCapabilityContext: async () => ({ providers: [], defaults: {} }), enrichSession: value => value,
  });
  return { call: handlers.get(shared.IPC.invoke.sessionConfigurePersona), calls, active, released: () => released };
}

test("persona configuration and clear use the dedicated Host RPC under the session lock", async () => {
  const f = fixture();
  for (const patch of [{ personaId: "first" }, { inheritToSubagents: true }, { personaId: null }]) {
    await f.call({ id: "s", ...patch });
    assert.deepEqual(f.calls.at(-1), ["session.configurePersona", { id: "s", ...patch }]);
  }
  assert.equal(f.released(), 3);
});

test("invalid, native, remote, and already-running requests do not read or mutate Host", async () => {
  const f = fixture();
  for (const request of [{ id: "s" }, { id: "s", personaId: "../x" }, { id: "s", inheritToSubagents: "true" },
    { id: "native-pi:x", personaId: "first" }, { id: "remote:host:x", personaId: "first" }]) await assert.rejects(f.call(request));
  f.active.set("s", "turn");
  await assert.rejects(f.call({ id: "s", personaId: "first" }), /running/);
  assert.deepEqual(f.calls, []);
});

test("a run that starts during the session read prevents mutation and releases the lock", async () => {
  const f = fixture({ startWhileReading: true });
  await assert.rejects(f.call({ id: "s", personaId: "first" }), /running/);
  assert.equal(f.calls.filter(([method]) => method === "session.configurePersona").length, 0);
  assert.equal(f.released(), 1);
});

test("a remote-workspace backend rejects selection but allows clearing a retained persona", async () => {
  const f = fixture({ session: { remoteWorkspace: { hostKey: "remote", path: "/work" } } });
  await assert.rejects(f.call({ id: "s", personaId: "first" }), /unavailable/);
  await f.call({ id: "s", personaId: null });
  assert.equal(f.calls.filter(([method]) => method === "session.configurePersona").length, 1);
});

test("sidecar work blocks persona writes even after Main has no active turn", async () => {
  for (const blocked of [true, undefined]) {
    const reads = [];
    const f = fixture({ sidecar: { call: async (method, input) => {
      reads.push([method, input]); return { personaConfigurationBlocked: blocked };
    } } });
    await assert.rejects(f.call({ id: "s", personaId: "first" }), /Settle agent work/);
    assert.deepEqual(reads, [["agent.getStatus", { sessionId: "s" }]]);
    assert.equal(f.calls.filter(([method]) => method === "session.configurePersona").length, 0);
    assert.equal(f.released(), 1);
  }
  const idle = fixture({ sidecar: { call: async () => ({ personaConfigurationBlocked: false }) } });
  await idle.call({ id: "s", personaId: "first" });
  assert.equal(idle.calls.at(-1)[0], "session.configurePersona");
});

test("manual compaction reservation blocks a switch before a sidecar run exists", async () => {
  const compactingSessions = new Set(["s"]);
  const f = fixture({ compactingSessions });
  await assert.rejects(f.call({ id: "s", personaId: "first" }), /compacting/);
  assert.deepEqual(f.calls, []);
  compactingSessions.delete("s");
  await f.call({ id: "s", personaId: "first" });
  assert.equal(f.calls.at(-1)[0], "session.configurePersona");
});
