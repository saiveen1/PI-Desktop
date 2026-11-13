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

test("timing and output throughput use only valid recorded run facts", () => {
  const facts = subagentDiagnostics({ startedAt: 1000, completedAt: 3000, usage: { outputTokens: 120 },
    activity: { phase: "waiting-model" }, lastToolName: "Read" });
  assert.equal(facts.elapsedMs, 2000);
  assert.equal(facts.outputTokensPerSecond, 60);
  assert.equal(facts.activityPhase, "waiting-model");
  assert.equal(facts.lastToolName, "Read");
  for (const [startedAt, completedAt, outputTokens] of [[1000, 1000, 10], [3000, 1000, 10], [0, 1000, 10], [1000, 2000, 0], [1000, 2000, -1]]) {
    const value = subagentDiagnostics({ startedAt, completedAt, usage: { outputTokens } });
    assert.equal(value?.outputTokensPerSecond, undefined);
  }
  assert.equal(subagentDiagnostics({ startedAt: Infinity, activity: { phase: "unknown" } }), undefined);
});
const observation = {
  version: 1, selectedModel: "account/selected", phase: "tool", lastActivityAt: 4000,
  diagnostic: { state: "no_new_evidence", observedAt: 4000, thresholdMs: 1000, reason: "no new evidence" },
  executionStartedAt: 1500, executionEndedAt: 3500, reportProducedAt: 3600,
  attemptCount: 2, attemptsOmitted: 0, attempts: [
    { sequence: 1, model: "account/first", startedAt: 1500, finishedAt: 2000, outcome: "failed", error: { code: "PROVIDER_ERROR", message: "private command" } },
    { sequence: 2, model: "account/fallback", startedAt: 2000, finishedAt: 3000, outcome: "completed", providerDurationMs: 1000, usage: { inputTokens: 40, outputTokens: 50, totalTokens: 90 } },
  ], approvalsOmitted: 0, approvals: [{ model: "account/selected", status: "accepted", at: 1200 }],
  completedToolCalls: 1, failedToolCalls: 0, pendingToolsOmitted: 0,
  pendingTools: [{ toolCallId: "tool-a", toolName: "Write", startedAt: 3000, outcome: "pending", effects: "unknown" }],
  recentTools: [], confirmedWritePaths: [], confirmedWritePathsOmitted: 0,
};

test("observation parser accepts bounded facts and rejects malformed records", () => {
  assert.equal(subagentDiagnostics({ observation }).observation.attempts[1].model, "account/fallback");
  assert.equal(subagentDiagnostics({ observation: { ...observation, attemptsOmitted: 2 } }), undefined);
  assert.equal(subagentDiagnostics({ observation: { ...observation, pendingTools: Array(17).fill(observation.pendingTools[0]) } }), undefined);
});

test("history adapter uses recorded start rather than createdAt fallback", async () => {
  const { delegationHistoryDiagnostics, delegationHistoryTask } = await import("../src/features/delegations/session-delegation-tasks.ts");
  const entry = { messageId: "m", delegationId: "d", status: "completed", createdAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:02.000Z", observation };
  assert.equal(subagentDiagnostics(delegationHistoryDiagnostics(entry)).elapsedMs, undefined);
  entry.startedAt = "2026-01-01T00:00:01.000Z";
  assert.equal(subagentDiagnostics(delegationHistoryTask(entry).message.toolResult.details).elapsedMs, 1000);
  entry.status = "interrupted";
  assert.equal(delegationHistoryDiagnostics(entry).completedAt, undefined);
});


test("all locale catalogs expose observability labels with localized English and Simplified Chinese", async () => {
  for (const locale of ["en", "zh-CN", "zh-TW", "de", "es", "fr", "ko", "pt-BR", "tr"]) {
    const { delegationDiagnostics } = await import(`../../../packages/i18n/src/locales/${locale}/delegation-reliability.ts`);
    assert.ok(delegationDiagnostics.observation.requestThroughput);
    assert.ok(delegationDiagnostics.observation.approvalStates.accepted);
    assert.ok(delegationDiagnostics.observation.attemptStates.unresolved);
    assert.ok(delegationDiagnostics.throughput);
    if (locale === "zh-CN") assert.match(delegationDiagnostics.observation.requestThroughput, /网络等待/);
    if (locale === "en") assert.match(delegationDiagnostics.observation.requestThroughput, /network wait/);
  }
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
    const labels = { runStarted: "Run started", currentActivity: "Current activity", lastTool: "Last tool observed",
      completedAt: "Completed at", elapsed: "Run elapsed time", seconds: "{{value}} s", outputTokens: "Output tokens",
      throughput: "End-to-end output throughput (includes tools and waits)", tokensPerSecond: "{{value}} tokens/s", unavailable: "Unavailable",
      phases: { "waiting-model": "Waiting for model response", retrying: "Retrying model request" } };
    const { delegationObservability } = await import("../../../packages/i18n/src/locales/en/delegation-observability.ts");
    i18n.addResourceBundle("en", "translation", { chat: { delegationDiagnostics: { ...delegationObservability, ...labels } } }, true, true);
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
    const running = render({ ...admitted, startedAt: 1000, activity: { phase: "waiting-model" }, lastToolName: "Read" });
    assert.match(running, /Waiting for model response/);
    assert.match(running, /Last tool observed/);
    assert.doesNotMatch(running, /Completed at|throughput/);
    const measured = render({ ...failed, startedAt: 1000, completedAt: 3000, usage: { outputTokens: 120 } });
    assert.match(measured, /End-to-end output throughput \(includes tools and waits\)/);
    assert.match(measured, /60 tokens\/s/);
    assert.match(measured, /120/);
    assert.match(render({ ...failed, completedAt: 3000 }), /Unavailable/);
    const observed = render({ observation });
    assert.match(observed, /account\/fallback/);
    assert.match(observed, /50 tokens\/s/);
    assert.match(observed, /Approval accepted \(not execution start\)/);
    assert.match(observed, /Effects unknown/);
    assert.match(observed, /No new evidence/);
    assert.doesNotMatch(observed, /private command/);
    for (const [outputTokens, providerDurationMs] of [[0, 1000], [50, 0], [50, Number.MIN_VALUE]]) {
      const invalidRate = render({ observation: { ...observation, attemptCount: 1,
        attempts: [{ ...observation.attempts[1], providerDurationMs,
          usage: { inputTokens: 40, outputTokens, totalTokens: 90 } }] } });
      assert.match(invalidRate, /Request output throughput.*Unavailable/s);
      assert.doesNotMatch(invalidRate, /0 tokens\/s|∞|Infinity/);
    }
    const unresolved = render({ observation: { ...observation, attemptCount: 1,
      attempts: [{ sequence: 1, model: "account/unknown", startedAt: 1500, outcome: "unresolved" }] } });
    assert.match(unresolved, /Provider outcome unconfirmed at execution end/);
    assert.match(unresolved, /Request output throughput.*Unavailable/s);
    assert.doesNotMatch(render({ modelId: "legacy" }), /Report outcome|Report recovery attempts/);
  } finally { await server.close(); }
});
