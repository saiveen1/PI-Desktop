import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const require = createRequire(import.meta.url);
function sessionFixture() {
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
  const handlers = new Map(), writes = [];
  const host = { async call(method, input) {
    writes.push([method, input]);
    if (method === "session.configure") return { session: { id: input.id, observerMode: input.observerMode ?? "off", mode: input.mode } };
    throw Error(`Unexpected RPC ${method}`);
  } };
  module.exports.registerSessionIpc({ registrar: { handle: (name, handler) => handlers.set(name, handler) },
    getHost: () => host, getSidecar: () => null, activeTurns: new Map(), sessionProjects: new Map(),
    modeCatalog: { snapshotFor: async () => undefined }, sessionCapabilityContext: async () => ({ providers: [], defaults: {} }),
    enrichSession: session => session, plugins: { broadcastEvent() {} },
  });
  return { configure: handlers.get(shared.IPC.invoke.sessionConfigure), writes };
}

test("local configuration preserves the requested Observer mode through the real IPC handler", async () => {
  const f = sessionFixture();
  for (const observerMode of ["off", "endless", "guard"]) {
    const result = await f.configure("session", { mode: "agent", observerMode });
    assert.equal(result.session.observerMode, observerMode);
    assert.deepEqual(f.writes.at(-1), ["session.configure", { id: "session", mode: "agent", observerMode }]);
  }
  await f.configure("session", { mode: "plan" });
  assert.equal(Object.hasOwn(f.writes.at(-1)[1], "observerMode"), false);
});

test("invalid explicit mode and native configuration never reach Host", async () => {
  const f = sessionFixture();
  for (const observerMode of [null, true, "auto", "observe", [], 1]) await assert.rejects(f.configure("session", { mode: "agent", observerMode }), /observerMode is invalid/);
  await assert.rejects(f.configure("native-pi:session", { mode: "agent", observerMode: "guard" }));
  assert.equal(f.writes.length, 0);
});

test("remote bridge rejects Observer instead of silently dropping local consent", async () => {
  const { createRemoteBackend } = await import("../electron/main/remote/remote-backend.ts");
  const { makeRemoteSessionId } = await import("../electron/main/remote/backend-router.ts");
  const calls = [];
  const backend = createRemoteBackend({ hostKey: "remote", client: { request: async (...args) => { calls.push(args); throw Error("must not contact remote"); } } });
  for (const observerMode of ["off", "endless", "guard"]) {
    await assert.rejects(backend.invoke(shared.IPC.invoke.sessionConfigure, [makeRemoteSessionId("remote", "session"), { mode: "agent", observerMode }]), /Observer Guard/);
  }
  assert.deepEqual(calls, []);
});
