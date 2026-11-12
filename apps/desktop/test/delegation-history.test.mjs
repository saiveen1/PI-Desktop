import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";
const nativeRequire = createRequire(import.meta.url);
function load(relative) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    if (id.startsWith("node:")) return nativeRequire(id);
    if (id === "@pi-desktop/shared") return shared;
    throw new Error(`Unexpected dependency: ${id}`);
  }, module.exports, module);
  return module.exports;
}
const { registerDelegationHistoryIpc } = load("../electron/main/ipc/delegation-history-ipc.ts");
const { registerDelegationApprovalIpc } = load("../electron/main/ipc/delegation-approval-ipc.ts");

function registrar() {
  const handlers = new Map();
  return { handlers, registrar: {
    handleWithEvent: (channel, handler) => handlers.set(channel, handler),
    assertMainWindowSender(event) { if (event.sender !== "main") throw new Error("PERMISSION_DENIED"); },
  } };
}
const page = { entries: [], nextOffset: null };
test("run history IPC forwards only validated queries from the main window", async () => {
  const { handlers, registrar: r } = registrar(), calls = [];
  registerDelegationHistoryIpc({ registrar: r, getHost: () => ({ async call(method, params) { calls.push([method, params]); return page; } }) });
  const handler = handlers.get(shared.IPC.invoke.delegationHistoryList);
  assert.deepEqual(await handler({ sender: "main" }), page);
  const query = { offset: 200, limit: 50, status: "ended", projectPath: "D:/work", sessionId: "session-1" };
  await handler({ sender: "main" }, query);
  assert.deepEqual(calls, [["delegation.history.list", {}], ["delegation.history.list", query]]);
  for (const args of [[{ limit: 500 }], [{ authorize: true }], [{}, {}], ...["", " s", "s ", "x".repeat(257), null, 5].map(sessionId => [{ sessionId }])]) {
    await assert.rejects(handler({ sender: "main" }, ...args), /Invalid delegation history query/);
  }
  await assert.rejects(handler({ sender: "plugin" }, { limit: 10 }), /PERMISSION_DENIED/);
  registerDelegationHistoryIpc({ registrar: r, getHost: () => null });
  await assert.rejects(handlers.get(shared.IPC.invoke.delegationHistoryList)({ sender: "main" }), /host unavailable/);
});

test("receipt history IPC is main-window only and requires the paired identity for markRead", async () => {
  const { handlers, registrar: r } = registrar(), calls = [];
  const approvals = {
    listHistory: async () => ({ entries: [] }),
    markHistoryRead: async (input) => { calls.push(["read", input]); return { ok: true }; },
    clearHistory: async () => { calls.push(["clear"]); return { ok: true }; },
  };
  registerDelegationApprovalIpc({ registrar: r, approvals });
  const main = { sender: "main" };
  assert.deepEqual(await handlers.get(shared.IPC.invoke.delegationApprovalHistoryList)(main), { entries: [] });
  assert.deepEqual(await handlers.get(shared.IPC.invoke.delegationApprovalHistoryClear)(main), { ok: true });
  assert.deepEqual(await handlers.get(shared.IPC.invoke.delegationApprovalHistoryMarkRead)(main, {}), { ok: true });
  await handlers.get(shared.IPC.invoke.delegationApprovalHistoryMarkRead)(main, { sessionId: "s", requestId: "r" });
  assert.deepEqual(calls, [["clear"], ["read", {}], ["read", { sessionId: "s", requestId: "r" }]]);
  await assert.rejects(handlers.get(shared.IPC.invoke.delegationApprovalHistoryMarkRead)(main, { sessionId: "s" }), /Invalid delegation history identity/);
  await assert.rejects(handlers.get(shared.IPC.invoke.delegationApprovalHistoryClear)(main, {}), /no arguments/);
  await assert.rejects(handlers.get(shared.IPC.invoke.delegationApprovalHistoryList)({ sender: "plugin" }), /PERMISSION_DENIED/);
});
