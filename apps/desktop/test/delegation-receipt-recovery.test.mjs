import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";
const { outputText } = ts.transpileModule(readFileSync(new URL("../electron/main/services/delegation-approval-history.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
const module = { exports: {} };
new Function("require", "exports", "module", outputText)(id => { assert.equal(id, "@pi-desktop/shared"); return shared; }, module.exports, module);
const { createDelegationApprovalHistory } = module.exports;
const model = { providerId: "p", providerName: "Provider", modelId: "m", priority: 1, approval: "ask" };
const prompt = requestId => ({ sessionId: "s", requestId, revision: 1, status: "approved", task: "Read the diff",
  createdAt: "2026-11-08T10:00:00.000Z", expiresAt: "2026-11-08T10:05:00.000Z", candidate: model, candidates: [model] });
function fixture() {
  const rows = new Map(), calls = [], errors = [];
  let fail = true;
  const host = { async call(method, input) {
    calls.push(method);
    if (method.endsWith("record")) {
      if (fail) throw new Error("Fixture disk failure");
      rows.set(input.request.requestId, input);
    } else if (method.endsWith("clear")) rows.clear();
    else if (method.endsWith("list")) return { entries: [...rows.values()] };
    else assert.fail("History must not call authorization or execution: " + method);
    return { ok: true };
  } };
  let owner = host;
  const history = createDelegationApprovalHistory({ getHost: () => owner, report: error => errors.push(error), now: () => Date.parse("2026-11-08T10:01:00.000Z") });
  return { history, calls, errors, recover: () => { fail = false; }, replaceHost: value => { owner = value; } };
}

test("manual history retry persists a previously failed receipt without reauthorizing", async () => {
  const f = fixture(); f.history.record(prompt("one"));
  await assert.rejects(f.history.listHistory());
  assert.ok(f.errors.length > 0);
  f.recover();
  assert.deepEqual((await f.history.listHistory()).entries.map(entry => entry.request.requestId), ["one"]);
  assert.ok(f.calls.every(method => method.startsWith("delegation.approvalHistory.")));
});

test("later successful receipts do not silently discard an earlier failed write", async () => {
  const f = fixture(); f.history.record(prompt("one"));
  await assert.rejects(f.history.listHistory());
  f.recover(); f.history.record(prompt("two"));
  assert.deepEqual((await f.history.listHistory()).entries.map(entry => entry.request.requestId).sort(), ["one", "two"]);
});

test("clearing history retires failed writes and never retries them into a replacement Host", async () => {
  const f = fixture(); f.history.record(prompt("one"));
  await assert.rejects(f.history.listHistory());
  const calls = [];
  f.replaceHost({ async call(method) { calls.push(method); return method.endsWith("list") ? { entries: [] } : { ok: true }; } });
  await assert.rejects(f.history.listHistory());
  assert.ok(!calls.some(method => method.endsWith("record")));
  await f.history.clearHistory();
  assert.deepEqual((await f.history.listHistory()).entries, []);
  assert.ok(!calls.some(method => method.endsWith("record")));
});

test("clear during a write preserves a receipt arriving after the clear request", async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const rows = new Map();
  const host = { async call(method, input) {
    if (method.endsWith("record")) {
      if (input.request.requestId === "old") { entered(); await barrier; }
      rows.set(input.request.requestId, input);
    } else if (method.endsWith("clear")) rows.clear();
    else if (method.endsWith("list")) return { entries: [...rows.values()] };
    else assert.fail(method);
    return { ok: true };
  } };
  const history = createDelegationApprovalHistory({ getHost: () => host, report: assert.fail, now: () => Date.parse("2026-11-08T10:01:00.000Z") });
  history.record(prompt("old")); await started;
  const clearing = history.clearHistory();
  history.record(prompt("new")); release(); await clearing;
  assert.deepEqual((await history.listHistory()).entries.map(entry => entry.request.requestId), ["new"]);
});
