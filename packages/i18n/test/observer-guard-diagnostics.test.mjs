import assert from "node:assert/strict";
import { test } from "vitest";
import { catalogs } from "../src/index.ts";
import { observerGuardDiagnostics } from "../src/locales/observer-guard-diagnostics.ts";

const locales = ["en", "zh-CN", "zh-TW", "de", "es", "fr", "ko", "pt-BR", "tr"];
const rootKeys = ["busy", "configuredModel", "ready", "waiting", "triggerHint", "checkingHint", "interruptedHint", "legacyReason", "notReassessed", "details", "relatedTool", "reviewedResponse", "openResponse", "openEvidence", "evidenceUnavailable"];
const skipReasons = ["response_error", "response_aborted", "response_length", "empty_response", "task_changed", "no_user_task", "stop_requested", "mode_closeout"];
const continuationReasons = ["observe_only", "verdict_complete", "verdict_blocked", "verdict_needs_input", "verdict_unknown", "low_confidence", "correction_budget", "input_truncated", "task_not_actionable", "answer_needs_input", "tool_error", "tool_effects_unknown", "tool_receipt_mismatch", "stop_requested", "plan_mode", "pending_work", "task_changed", "runtime_unavailable", "continuation_limit", "decision_stop", "user_input_pending"];
const paths = [...rootKeys, "summary.continued", "summary.notContinued", ...skipReasons.map((key) => `skipReasons.${key}`), ...continuationReasons.map((key) => `continuationReasons.${key}`)];
const get = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);
const placeholders = (value) => [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g)].map((match) => match[1]).sort();

test("observer diagnostics have translated copy and matching placeholders in every shipped catalog", () => {
  assert.deepEqual(Object.keys(catalogs).sort(), [...locales].sort());
  for (const locale of locales) {
    const diagnostics = observerGuardDiagnostics[locale];
    const catalog = catalogs[locale].observerGuard;
    assert.deepEqual(Object.keys(diagnostics).sort(), [...rootKeys, "summary", "skipReasons", "continuationReasons"].sort(), locale);
    assert.deepEqual(Object.keys(diagnostics.skipReasons).sort(), [...skipReasons].sort(), locale);
    assert.deepEqual(Object.keys(diagnostics.continuationReasons).sort(), [...continuationReasons].sort(), locale);
    assert.deepEqual(Object.keys(diagnostics.summary).sort(), ["continued", "notContinued"].sort(), locale);
    for (const path of paths) {
      const value = get(diagnostics, path);
      const english = get(observerGuardDiagnostics.en, path);
      assert.equal(typeof value, "string", `${locale} ${path}`);
      assert.notEqual(value.trim(), "", `${locale} ${path}`);
      assert.equal(get(catalog, path), value, `${locale} catalog ${path}`);
      assert.deepEqual(placeholders(value), placeholders(english), `${locale} ${path}`);
      if (locale !== "en") assert.notEqual(value, english, `${locale} ${path} must not fall back to English`);
    }
    assert.deepEqual(placeholders(catalog.openEvidence), ["index"], locale);
  }
});

test("English diagnostics preserve uncertainty and continuation limits", () => {
  const copy = catalogs.en.observerGuard;
  assert.equal(copy.configuredModel, "Configured model (next turn)");
  assert.match(copy.continuationReasons.low_confidence, /not high enough/);
  assert.match(catalogs["zh-CN"].observerGuard.continuationReasons.low_confidence, /置信度不足/);
  assert.match(copy.legacyReason, /The specific reason was not recorded/);
  assert.match(copy.notReassessed, /not reassessed/);
  assert.match(copy.skipReasons.response_length, /output limit/);
  assert.match(copy.continuationReasons.tool_effects_unknown, /Tool effects are not confirmed/);
  assert.match(copy.continuationReasons.tool_effects_unknown, /not a model judgement of danger/);
  assert.match(copy.continuationReasons.tool_error, /original tool call failed/);
  assert.match(copy.continuationReasons.tool_receipt_mismatch, /pairing is incomplete/);
  assert.match(copy.busy, /current turn ends/);
  assert.match(copy.busy, /inspect the status/);
});

test("auto continuation controls, privacy, costs, and counters are localized", () => {
  const keys = ["title", "description", "privacy", "endless", "endlessHint", "limitHint", "maxContinuations", "continueOnTransientError", "continueOnTransientErrorHint", "guardOnly", "prompt", "promptHint", "promptInvalid", "resetPrompt", "noReviewer", "response", "decisions.continue", "decisions.stop", "continuationProgress"];
  const en = catalogs.en.observerGuard;
  for (const locale of locales) {
    const copy = catalogs[locale].observerGuard;
    for (const key of keys) {
      const value = get(copy, key);
      assert.ok(typeof value === "string" && value.trim(), `${locale} ${key}`);
      assert.deepEqual(placeholders(value), placeholders(get(en, key)), `${locale} ${key}`);
      if (locale !== "en") assert.notEqual(value, get(en, key), `${locale} ${key} must not fall back to English`);
    }
  }
  assert.deepEqual(placeholders(en.continuationProgress), ["current", "max"]);
  assert.match(en.privacy, /only the final reply/);
  assert.match(en.endlessHint, /turn limit.*No reviewer.*main-model requests may incur charges/);
  assert.match(en.limitHint, /Tool calls do not reset/);
  assert.match(en.continueOnTransientErrorHint, /built-in retries are exhausted.*remaining auto-continuation limit.*No reviewer.*Stop remains available.*Off by default/);
  assert.equal(catalogs["zh-CN"].observerGuard.endless, "无尽");
  assert.equal(catalogs["zh-TW"].observerGuard.endless, "無盡");
});
