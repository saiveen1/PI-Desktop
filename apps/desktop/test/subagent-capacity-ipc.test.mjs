import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";
import { loadSubagentDefinitions } from "@pi-desktop/agent-runtime";
import * as modeSubagents from "../electron/main/runtime/mode-subagents.ts";

// Only shell/unused import services and the Host are external to this IPC path.
const imports = {
  electron: {},
  "../skill-folder-import": {},
  "../builtin-skills": {},
  "../skill-market-scan": {},
  "../runtime/mode-subagents": modeSubagents,
  "@pi-desktop/shared": shared,
  "@pi-desktop/agent-runtime": { loadSubagentDefinitions },
};
const source = readFileSync(new URL("../electron/main/ipc/skills-ipc.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
const module = { exports: {} };
new Function("require", "exports", "module", outputText)((id) => {
  assert.ok(Object.hasOwn(imports, id), `Unexpected IPC import ${id}`);
  return imports[id];
}, module.exports, module);
const { registerSkillsIpc } = module.exports;

function fixture() {
  const state = { available: true, maxDefinitions: 2, calls: 0 };
  const handlers = new Map();
  const documents = Array.from({ length: 3 }, (_, index) => ({ id: `worker-${index}`,
    document: `---\nname: worker-${index}\ndescription: Inspect fixture\n---\nReport.\n` }));
  const host = { isAvailable: () => state.available, async call(method) {
    assert.equal(method, "settings.get");
    assert.ok(state.available, "Offline Host must not be called");
    state.calls++;
    return { delegation: { version: 1, approvalTimeoutSeconds: 60, models: [], limits: { maxDefinitions: state.maxDefinitions } } };
  } };
  registerSkillsIpc({ registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host, optionalWorkspaceRoot: async () => null,
    activeUserSubagentDocuments: async () => state.available ? documents : [],
    disabledBuiltinSubagents: async () => [], disabledBuiltinSkills: async () => [],
    stripWinLongPrefix: value => value, sendToRenderer() {}, searchSkillMarket() {},
    fetchSkillMarketDocument() {}, logger: { app() {} },
  });
  return { state, preview: () => handlers.get(shared.IPC.invoke.subagentCatalog)() };
}

test("catalog preview reads saved capacity on each request without consuming definitions", async () => {
  const { state, preview } = fixture();
  for (const limit of [1, 3, 2]) {
    state.maxDefinitions = limit;
    const result = await preview();
    assert.equal(result.subagents.length, limit);
    assert.equal(result.subagents[0].name, "worker-0");
    assert.ok(result.diagnostics.some(text => text.includes("catalog cap")));
  }
  assert.equal(state.calls, 3);
});

test("offline catalog preview preserves builtin fallback and rejects invalid online limits", async () => {
  const { state, preview } = fixture();
  state.available = false;
  const offline = await preview();
  assert.equal(offline.subagents.length, 5);
  assert.equal(state.calls, 0);
  state.available = true;
  state.maxDefinitions = 0;
  await assert.rejects(preview(), /Invalid subagent limits/);
});
