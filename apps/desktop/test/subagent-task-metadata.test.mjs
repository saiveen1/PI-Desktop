import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { delegateModelId, delegateThinkingLevel } = await import("../src/features/chat/transcript/model.ts");
const { subagentTaskTone } = await import("../src/lib/subagent-task-presentation.ts");
const message = (details) => ({ id: "message-a", toolCallId: "call-a", role: "tool", toolName: "Task", content: "", status: "complete", toolStatus: "success",
  createdAt: "2026-11-12T10:00:00.000Z", toolArgs: { agent: "reviewer", description: "Review implementation", model: "requested-model" },
  toolResult: { details: { delegationId: "a", status: "completed", ...details } },
});

test("recorded metadata never guesses from requested model/settings or loses explicit off/omit", () => {
  assert.equal(delegateModelId(message({ modelId: " effective-model " })), "effective-model");
  assert.equal(delegateModelId(message({})), "");
  for (const level of ["off", "omit", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(delegateThinkingLevel(message({ thinkingLevel: level })), level);
  }
  for (const level of [null, undefined, "auto", "unsupported", 3]) assert.equal(delegateThinkingLevel(message({ thinkingLevel: level })), undefined);
});

test("task accent follows the recorded message across live and history projections", () => {
  const live = message({});
  assert.equal(subagentTaskTone(live), subagentTaskTone({ ...live, toolCallId: live.id }));
});

test("inline and index tasks identify subagents and show recorded model/effort without expansion", async t => {
  const ssr = await slotSsr(t);
  const { SubagentTaskList } = await ssr.load("/src/features/chat/transcript/SubagentTaskList.tsx");
  for (const grouped of [false, true]) {
    const html = ssr.render(createElement(SubagentTaskList, { grouped, items: [{ kind: "tool", message: message({ modelId: "effective-model", thinkingLevel: "high" }) }] }));
    assert.match(html, /subagent-task-kind[^>]*>Subagent</);
    assert.match(html, /lucide-bot/);
    assert.doesNotMatch(html, /lucide-sparkles|requested-model/);
    assert.match(html, /effective-model/);
    assert.match(html, /Effort: high/);
    assert.match(html, /subagent-task-navigation/);
  }
  const missing = ssr.render(createElement(SubagentTaskList, { items: [{ kind: "tool", message: message({ modelId: "legacy-model" }) }] }));
  assert.match(missing, /Effort: Not recorded/);
  assert.doesNotMatch(missing, /Effort: (?:high|off)/);
});

test("all supported locales describe recorded effort and stale refresh failures", async () => {
  const { catalogs } = await import("../../../packages/i18n/src/index.ts");
  for (const [locale, catalog] of Object.entries(catalogs)) {
    for (const key of ["taskLabel", "effort", "notRecorded", "modelUnrecorded", "refreshFailed"]) {
      assert.equal(typeof catalog.subagentControls[key], "string", `${locale}: ${key}`);
      assert.ok(catalog.subagentControls[key].trim(), `${locale}: ${key}`);
    }
    assert.match(catalog.subagentControls.effort, /\{\{level\}\}/);
  }
});
