import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { subagentDiagnostics } = await import("../src/lib/subagent-diagnostics.ts");

test("delegation details retain selection, actual model and missing terminal report evidence", () => {
  const facts = subagentDiagnostics({
    modelId: "fallback", turns: 2, toolCalls: 1,
    scheduling: { requestedModel: "account/preferred", decisions: [
      { model: "account/preferred", decision: "skipped", reason: "Approval expired" },
      { model: "account/fallback", decision: "selected", reason: "Automatically allowed" },
    ] },
    modelFailures: [{ model: "account/preferred", code: "PROVIDER_ERROR", message: "Unavailable" }],
    terminal: { stopReason: "stop", rawStopReason: "stop", reportOutcome: "missing", textBlocks: 0,
      thinkingBlocks: 1, toolCalls: 0, reportRecoveryAttempt: 1, thinking: "private reasoning" },
    error: { code: "SUBAGENT_NO_REPORT", message: "No final report was produced" },
  });
  assert.equal(facts.requestedModel, "account/preferred");
  assert.equal(facts.actualModel, "fallback");
  assert.deepEqual(facts.decisions.map(row => row.decision), ["skipped", "selected"]);
  assert.equal(facts.terminal.reportOutcome, "missing");
  assert.equal(facts.terminal.reportRecoveryAttempt, 1);
  assert.equal(facts.error.code, "SUBAGENT_NO_REPORT");
  assert.equal(JSON.stringify(facts).includes("private reasoning"), false);
});

test("old history and malformed terminal metadata never acquire invented diagnostics", () => {
  assert.equal(subagentDiagnostics(undefined), undefined);
  assert.equal(subagentDiagnostics({}), undefined);
  const old = subagentDiagnostics({ modelId: "old-model" });
  assert.equal(old.actualModel, "old-model");
  assert.equal(old.terminal, undefined);
  assert.equal(old.requestedModel, undefined);
  assert.equal(old.turns, undefined);
  assert.equal(subagentDiagnostics({ terminal: { stopReason: "stop", reportOutcome: "delivered" } }), undefined);
  assert.equal(subagentDiagnostics({ turns: -1, toolCalls: 0.5 }), undefined);
});

test("terminal diagnostics retain normalized truncation and only known raw stop reasons", () => {
  const input = { terminal: { stopReason: "length", rawStopReason: "max_tokens", reportOutcome: "truncated",
    textBlocks: 0, thinkingBlocks: 0, toolCalls: 0, reportRecoveryAttempt: 0 } };
  assert.equal(subagentDiagnostics(input).terminal.rawStopReason, "max_tokens");
  input.terminal.rawStopReason = "unexpected provider payload";
  assert.equal(subagentDiagnostics(input).terminal.rawStopReason, undefined);
  input.terminal.toolCalls = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(subagentDiagnostics(input), undefined);
});

test("the public detail summary follows a task from admission through failure and restored history", async () => {
  const { createServer } = await import("vite");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createInstance } = await import("i18next");
  const { I18nextProvider } = await import("react-i18next");
  const { catalogs } = await import("@pi-desktop/i18n");
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { SubagentDiagnosticsSummary } = await server.ssrLoadModule("/src/components/workpanel/SubagentDiagnosticsSummary.tsx");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const render = payload => renderToStaticMarkup(createElement(I18nextProvider, { i18n },
      createElement(SubagentDiagnosticsSummary, { payload })));
    const admitted = { modelId: "worker-a", turns: 0, toolCalls: 0,
      scheduling: { requestedModel: "account/requested", decisions: [
        { model: "account/worker-a", decision: "selected", reason: "Automatically allowed" },
      ] } };
    const initial = render(admitted);
    assert.match(initial, /Requested model/);
    assert.match(initial, /worker-a/);
    assert.doesNotMatch(initial, /Report delivered|No final report/);
    const failed = { ...admitted, turns: 3, toolCalls: 1,
      terminal: { stopReason: "stop", rawStopReason: "stop", reportOutcome: "missing",
        textBlocks: 0, thinkingBlocks: 1, toolCalls: 0, reportRecoveryAttempt: 1 },
      error: { code: "SUBAGENT_NO_REPORT", message: "No final report was produced" } };
    const final = render(failed);
    assert.match(final, /3 turns/);
    assert.match(final, /No final report/);
    assert.match(final, /SUBAGENT_NO_REPORT/);
    assert.doesNotMatch(final, /Report delivered/);
    assert.equal(render(JSON.parse(JSON.stringify(failed))), final);
    assert.doesNotMatch(render({ modelId: "legacy" }), /Report outcome|Report recovery attempts/);
  } finally { await server.close(); }
});
