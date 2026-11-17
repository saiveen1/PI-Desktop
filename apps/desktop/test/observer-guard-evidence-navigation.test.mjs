import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { resolveObserverEvidenceMessageId } = await import("../src/lib/observer-guard-evidence-navigation.ts");

test("observer navigation resolves provider-local tool IDs to the owning session's stored message", async () => {
  const reads = [];
  const target = await resolveObserverEvidenceMessageId("own", "call", async (id, options) => {
    reads.push([id, options.messageAround]);
    return options.messageAround === "call" ? { session: null } : { session: { id, messages: [{ id: "own:call", role: "tool", toolCallId: "call" }] } };
  });
  assert.equal(target, "own:call");
  assert.deepEqual(reads, [["own", "call"], ["own", "own:call"]]);
});

test("observer evidence accepts direct IDs but never aliases another session or unrelated message", async () => {
  assert.equal(await resolveObserverEvidenceMessageId("own", "answer", async id => ({ session: { id, messages: [{ id: "answer", role: "assistant" }] } })), "answer");
  for (const row of [{ id: "own:call", role: "assistant" }, { id: "own:call", role: "tool", toolCallId: "other" }]) {
    assert.equal(await resolveObserverEvidenceMessageId("own", "call", async id => ({ session: { id, messages: [row] } })), undefined);
  }
  assert.equal(await resolveObserverEvidenceMessageId("own", "call", async () => ({ session: { id: "foreign", messages: [{ id: "call" }] } })), undefined);
  await assert.rejects(resolveObserverEvidenceMessageId("own", "call", async () => { throw Error("unavailable"); }), /unavailable/);
});
