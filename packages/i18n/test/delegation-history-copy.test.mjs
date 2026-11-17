/**
 * Notification/delegation-history copy contract.
 *
 * `renderer-keys.test.mjs` only sees static `t("a.b")` literals, so the
 * template-literal keys the notification center and the global delegation
 * history dialog build at runtime (`delegationHistory.statuses.${status}`,
 * `delegationHistory.filters.${filter}`) would otherwise be unchecked. This
 * test couples those dynamic keys to the shared run/approval unions and pins
 * the copy that describes what "clear history" does and does not touch.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { catalogs, en, flattenCatalog } from "../src/index.ts";

const english = flattenCatalog(en);

function placeholders(value) {
  return [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}|{([A-Za-z_][A-Za-z0-9_]*)}/g)]
    .map((match) => match[1] ?? match[2])
    .sort();
}

/** Keys that exist only as runtime-built template literals. */
const HISTORY_KEYS = [
  "title", "allProjects", "close", "back", "openSource", "navigationFailed",
  "status", "created", "completed", "model", "requestedModel", "modelReason",
  "task", "report", "error", "truncated", "pending", "loading", "loadFailed",
  "retry", "noPending", "delegate", "viewApproval", "runs", "refresh", "filter",
  "empty", "loadMore", "end", "noProject", "untitledSession",
];

/** Mirrors DelegationRunHistoryEntry["status"] in packages/shared/src/delegation-history.ts. */
const RUN_STATUSES = ["running", "completed", "failed", "stopped", "aborted", "timed_out", "interrupted"];

/** Mirrors DelegationRunHistoryQuery["status"] minus undefined. */
const RUN_FILTERS = ["all", "running", "ended"];

/** Every key a locale must define for the global delegation history dialog. */
const ALL_KEYS = [
  ...HISTORY_KEYS.map((key) => `delegationHistory.${key}`),
  ...RUN_STATUSES.map((status) => `delegationHistory.statuses.${status}`),
  ...RUN_FILTERS.map((filter) => `delegationHistory.filters.${filter}`),
  "nav.projectNeedsActionCount",
  "nav.projectCompletedCount",
  "nav.projectFailedCount",
  "notifications.approvalHistoryTitle",
  "notifications.approvalHistoryBody",
  "notifications.clearConfirm",
  "notifications.historyLoadFailed",
  "notifications.emptyPendingTitle",
  "notifications.emptyPendingBody",
];

test("every shipped catalog defines the whole delegation history and notification contract", () => {
  for (const [id, catalog] of Object.entries(catalogs)) {
    const flat = flattenCatalog(catalog);
    for (const key of ALL_KEYS) {
      const value = flat[key];
      assert.equal(typeof value, "string", `${id} ${key}`);
      assert.notEqual(value.trim(), "", `${id} ${key} must not be blank`);
    }
  }
  assert.deepEqual(
    RUN_STATUSES.map((status) => english[`delegationHistory.statuses.${status}`]),
    ["Running", "Completed", "Failed", "Stopped", "Aborted", "Timed out", "Interrupted"],
  );
  assert.deepEqual(
    RUN_FILTERS.map((filter) => english[`delegationHistory.filters.${filter}`]),
    ["All", "Running", "Ended"],
  );
});

test("project header counts keep their interpolation variable and localization", () => {
  const countKeys = ["nav.projectNeedsActionCount", "nav.projectCompletedCount", "nav.projectFailedCount"];
  assert.deepEqual(
    countKeys.map((key) => english[key]),
    ["{{count}} need action", "Completed (unread): {{count}}", "Failed (unread): {{count}}"],
  );
  for (const [id, catalog] of Object.entries(catalogs)) {
    const flat = flattenCatalog(catalog);
    assert.deepEqual(placeholders(flat["nav.groupTotalCount"]), ["count"], `${id} group total`);
    for (const key of countKeys) {
      assert.deepEqual(placeholders(flat[key]), ["count"], `${id} ${key}`);
      if (id !== "en") assert.notEqual(flat[key], english[key], `${id} ${key} must not fall back to English`);
    }
  }
});

test("approval history placeholders match their call sites", () => {
  assert.deepEqual(placeholders(english["notifications.approvalHistoryTitle"]), ["sessionTitle"]);
  assert.deepEqual(placeholders(english["notifications.approvalHistoryBody"]), ["agent", "status"]);
  for (const [id, catalog] of Object.entries(catalogs)) {
    const flat = flattenCatalog(catalog);
    assert.deepEqual(placeholders(flat["notifications.approvalHistoryTitle"]), ["sessionTitle"], id);
    assert.deepEqual(placeholders(flat["notifications.approvalHistoryBody"]), ["agent", "status"], id);
    assert.deepEqual(placeholders(flat["notifications.clearConfirm"]), [], id);
    assert.deepEqual(placeholders(flat["notifications.historyLoadFailed"]), [], id);
  }
});

test("clearing the notification center keeps pending requests pending in every locale", () => {
  const zhCN = flattenCatalog(catalogs["zh-CN"]);
  const zhTW = flattenCatalog(catalogs["zh-TW"]);
  assert.match(english["notifications.clearConfirm"], /pending/);
  assert.match(english["notifications.clearConfirm"], /history/);
  assert.match(zhCN["notifications.clearConfirm"], /清除/);
  assert.match(zhCN["notifications.clearConfirm"], /待处理/);
  assert.match(zhTW["notifications.clearConfirm"], /待處理/);
  // "Pending unchanged" must be stated for the history failure path too.
  assert.match(english["notifications.historyLoadFailed"], /pending/i);
  for (const [id, catalog] of Object.entries(catalogs)) {
    const flat = flattenCatalog(catalog);
    assert.doesNotMatch(flat["notifications.clearConfirm"], /\{\{/, `${id} clearConfirm takes no variables`);
    if (id !== "en") {
      assert.notEqual(flat["notifications.clearConfirm"], english["notifications.clearConfirm"], id);
      assert.notEqual(flat["notifications.emptyPendingTitle"], english["notifications.emptyPendingTitle"], id);
      assert.notEqual(flat["notifications.emptyPendingBody"], english["notifications.emptyPendingBody"], id);
    }
  }
});

test("delegation history copy is translated, not English filler", () => {
  const chinese = flattenCatalog(catalogs["zh-CN"]);
  assert.equal(english["delegationHistory.title"], "Global delegations");
  assert.equal(chinese["delegationHistory.title"], "全局委派");
  const copyKeys = [
    "title", "allProjects", "close", "back", "openSource", "navigationFailed",
    "requestedModel", "noPending", "loadFailed", "empty", "loadMore", "end",
    "noProject", "untitledSession", "filters.all", "filters.running", "filters.ended",
    "statuses.running", "statuses.completed", "statuses.failed",
  ].map((key) => `delegationHistory.${key}`);

  for (const [id, catalog] of Object.entries(catalogs)) {
    if (id === "en") continue;
    const flat = flattenCatalog(catalog);
    for (const key of copyKeys) {
      assert.notEqual(flat[key], english[key], `${id} ${key} must not fall back to English`);
    }
    assert.deepEqual(
      placeholders(flat["delegationHistory.title"]),
      [],
      `${id} title takes no variables`,
    );
  }
});

test("global delegation history titles stay in the intended register", () => {
  const expected = {
    "zh-CN": "全局委派",
    "zh-TW": "全域委派",
    de: "Globale Delegationen",
    es: "Delegaciones globales",
    fr: "Délégations globales",
    ko: "전체 위임",
    "pt-BR": "Delegações globais",
    tr: "Tüm görevlendirmeler",
  };
  for (const [id, title] of Object.entries(expected)) {
    assert.equal(flattenCatalog(catalogs[id])["delegationHistory.title"], title, id);
  }
});
