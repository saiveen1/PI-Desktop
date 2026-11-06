import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { DelegationApprovalCenter } from "../../src/components/delegation-approval/DelegationApprovalCenter";
import "../../src/styles/tokens.css";
import "../../src/styles/ui-kit.css";

const style = document.createElement("style");
style.textContent = `* { box-sizing: border-box; } body { margin: 0; background: var(--ds-bg-primary); color: var(--ds-text-primary); font: var(--text-base)/var(--leading-body) system-ui, sans-serif; } main { padding: 32px; max-width: 520px; } main h1 { font-size: var(--text-lg); } .delegation-task-body > .delegation-metadata { margin-bottom: 16px; }`;
document.head.append(style);
await i18next.init({ lng: "en", fallbackLng: "en", initImmediate: false, interpolation: { escapeValue: false }, resources: Object.fromEntries(Object.entries(catalogs).map(([locale, translation]) => [locale, { translation }])) });
const root = createRoot(document.getElementById("root"));
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const check = (condition, message) => { if (!condition) throw new Error(message); };
function until(predicate) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => { if (predicate()) { observer.disconnect(); clearTimeout(timeout); resolve(); } });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("Fixture condition not reached: " + predicate)); }, 2000);
  });
}
const paint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
let clock = Date.parse("2026-11-05T12:00:00.000Z");
Date.now = () => clock;
const clockTicks = new Set();
const nativeSetInterval = window.setInterval.bind(window);
const nativeClearInterval = window.clearInterval.bind(window);
window.setInterval = (callback, ms, ...args) => ms === 1000 ? (clockTicks.add(callback), callback) : nativeSetInterval(callback, ms, ...args);
window.clearInterval = (timer) => { if (!clockTicks.delete(timer)) nativeClearInterval(timer); };
let copied = "";
let copyFailure = false;
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { if (copyFailure) throw new Error("Fixture clipboard failure"); copied = text; } } });
const candidate = { providerId: "demo-provider", providerName: "Demo provider", modelId: "review-model", modelLabel: "Review model", priority: 1, approval: "ask", thinkingLevel: "high" };
const alternative = { ...candidate, providerId: "other-provider", providerName: "Other demo provider", modelId: "alternate-model", modelLabel: "Alternate model", approval: "auto" };
const task = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1}. Review the implementation and preserve the existing behavior.\nD:/项目/审批测试/${"very-long-English-path-segment/".repeat(12)}源文件.tsx\n${"请保留完整任务内容，不要重复执行。".repeat(12)}`).join("\n\n") + "\n\nEND OF FULL TASK";
const request = (requestId, extra = {}) => ({ requestId, sessionId: "demo-session-a", revision: 1, status: "pending", createdAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 300_000).toISOString(), sessionTitle: "Review source session", projectTitle: "PI-Desktop demo project", projectPath: `D:/${"长路径/English-path/".repeat(18)}`, agentName: `Reviewer ${requestId}`, description: "Check renderer behavior and approval boundaries", task, candidate, candidates: [candidate, alternative], requestedModel: "specialist-model", modelReason: "The requested specialist is not the current candidate.", ...extra });
const originals = [request("first"), request("second", { sessionId: "demo-session-b", sessionTitle: "Second source session", projectTitle: "另一项目 / another project", candidate: { ...candidate, thinkingLevel: undefined } })];
let list = deferred();
const listeners = new Set();
const calls = [];
const replies = [];
const navigation = [];
window.piDesktop = {
  invoke: async (channel, input) => {
    if (channel === IPC.invoke.delegationApprovalList) return list.promise;
    if (channel === IPC.invoke.delegationApprovalRespond || channel === IPC.invoke.delegationApprovalExtend) {
      calls.push({ channel, input }); const reply = deferred(); replies.push(reply); return reply.promise;
    }
    throw new Error("Unexpected fixture IPC: " + channel);
  },
  on: (channel, listener) => {
    check(channel === IPC.event.delegationApprovalChanged, "Dedicated approval subscription required");
    listeners.add(listener); return () => listeners.delete(listener);
  },
};
const emit = (value) => flushSync(() => { for (const listener of listeners) listener({ request: value }); });
const answer = (result) => { const reply = replies.shift(); check(reply, "Expected a pending host ACK"); reply.resolve({ ok: true, data: result }); };
const row = (id) => document.querySelector(`[data-request-id="${id}"]`);
const button = (label, scope = document) => [...scope.querySelectorAll("button")].find((node) => node.textContent.trim() === label || node.getAttribute("aria-label") === label);
const click = (label, scope) => { const node = button(label, scope); check(node && !node.disabled, "Enabled button missing: " + label); flushSync(() => node.click()); return node; };
const text = (key, options) => i18next.t("delegationApproval." + key, options);
const toggle = () => document.querySelector(".delegation-center-head button");
flushSync(() => root.render(<I18nextProvider i18n={i18next}><DelegationApprovalCenter onNavigate={async (sessionId) => { navigation.push(sessionId); }} /></I18nextProvider>));
list.resolve({ ok: true, data: { requests: originals } });
await until(() => row("second"));
window.fixtureReady = true;

window.delegationWorkflowProbe = async () => {
  check(![...document.querySelectorAll('input[type="checkbox"]')].some((node) => node.checked), "Nothing may be preselected");
  check(!row("second").textContent.includes(text("thinking")), "Unknown thinking must remain absent");
  flushSync(() => row("first").querySelector("input").click());
  flushSync(() => row("second").querySelector("input").click());
  click(text("taskDetails"), row("first")); await paint();
  const reader = document.querySelector(".delegation-task-body"); reader.scrollTop = 120;
  const listScroll = document.querySelector(".delegation-request-list"); listScroll.scrollTop = 40;
  const focus = button(text("copyTask")); focus.focus();
  emit(request("late"));
  check(row("first").querySelector("input").checked && row("second").querySelector("input").checked && !row("late").querySelector("input").checked, "Late arrivals must not join selection");
  check(document.activeElement === focus && reader.scrollTop === 120 && listScroll.scrollTop === 40, "Late arrivals must preserve open task, focus, and scroll");
  click(text("copyTask")); await until(() => copied === task);
  check(copied.endsWith("END OF FULL TASK"), "Full prompt must be copied without truncation");
  copyFailure = true; click(text("copyTask")); await until(() => document.querySelector(".delegation-center").textContent.includes(text("copyFailed"))); copyFailure = false;
  click(text("openSource", { title: originals[0].sessionTitle }), document.querySelector(".delegation-reader"));
  check(navigation.at(-1) === originals[0].sessionId, "Source navigation must use the source session ID");
  click(text("hide")); check(toggle().getAttribute("aria-expanded") === "false", "Hide must collapse"); check(calls.length === 0, "Hide must not cancel");
  flushSync(() => toggle().click());
  check(row("first").querySelector("input").checked && document.querySelector(".delegation-task-body").scrollTop === 120, "Reopen must retain selection and task scroll");
  click(text("allowSelected"));
  check(calls.length === 1 && calls[0].input.requestId === "first", "First explicit selected request only");
  check(row("first") && row("first").textContent.includes(text("feedback.sending")), "Sending request stays pending until ACK");
  emit(request("later"));
  answer({ accepted: true, request: { ...originals[0], status: "approved" } });
  await until(() => !row("first")); await until(() => row("second").textContent.includes(text("feedback.sending")));
  answer({ accepted: false, code: "unavailable" });
  await until(() => row("second")?.textContent.includes(text("feedback.unavailable")));
  check(calls.length === 2 && calls[1].input.requestId === "second", "Batch snapshot must exclude all late arrivals");
  check(row("second").querySelector("input").checked, "Failed ACK must retain selected retry target");
  check(document.querySelector(".delegation-results").textContent.includes(text("feedback.approved")), "Approved must not imply running");
  await until(() => !button(text("allowSelected")).disabled);
  click(text("allowSelected")); answer({ accepted: true, request: { ...originals[1], status: "approved" } });
  await until(() => !row("second"));
  const late = request("late");
  click(text("extend"), row("late"));
  check(calls.at(-1).channel === IPC.invoke.delegationApprovalExtend && !Object.hasOwn(calls.at(-1).input, "expiresAt"), "Extension only submits identity/revision");
  check(row("late").querySelector("time").dateTime === late.expiresAt, "Extension must not silently renew the deadline");
  const extended = { ...late, revision: 2, expiresAt: new Date(Date.parse(late.expiresAt) + 300_000).toISOString() };
  answer({ accepted: true, request: extended }); await until(() => row("late").querySelector("time").dateTime === extended.expiresAt);
  const select = row("late").querySelector("select");
  check(select.value === "" && button(text("confirmModel"), row("late")).disabled, "Exact model choice has no default");
  flushSync(() => { select.value = JSON.stringify([alternative.providerId, alternative.modelId]); select.dispatchEvent(new Event("change", { bubbles: true })); });
  check(!button(text("confirmModel"), row("late")).disabled, "Explicit target enables confirmation");
  flushSync(() => row("late").querySelector("input").click());
  emit({ ...extended, revision: 3, candidate: alternative });
  check(!row("late").querySelector("input").checked && row("late").querySelector("select").value === "", "Replacement candidate/revision invalidates both selections");
  const currentSelect = row("late").querySelector("select");
  flushSync(() => { currentSelect.value = JSON.stringify([candidate.providerId, candidate.modelId]); currentSelect.dispatchEvent(new Event("change", { bubbles: true })); });
  click(text("confirmModel"), row("late"));
  check(calls.at(-1).input.action === "select" && calls.at(-1).input.providerId === candidate.providerId && calls.at(-1).input.revision === 3, "Exact provider/model/revision submitted");
  answer({ accepted: false, code: "stale" }); await until(() => row("late").textContent.includes(text("feedback.stale")));
  const expiring = request("expired", { expiresAt: new Date(clock + 1000).toISOString() }); emit(expiring);
  flushSync(() => row("expired").querySelector("input").click());
  clock += 2000; flushSync(() => { for (const tick of clockTicks) tick(); });
  await until(() => !row("expired").querySelector("input").checked && button(text("allowOnce"), row("expired")).disabled);
  check(!row("expired").querySelector("input").checked && button(text("allowOnce"), row("expired")).disabled, "Expired requests lose selection and cannot approve");
  const before = calls.length; button(text("allowOnce"), row("expired")).click(); check(calls.length === before, "No expired approval IPC");
  click(text("skip"), row("later")); answer({ accepted: true, request: { ...request("later"), status: "skipped" } }); await until(() => !row("later"));
  click(text("cancel"), row("late")); answer({ accepted: true, request: { ...extended, revision: 3, status: "cancelled" } }); await until(() => !row("late"));
  emit(request("layout"));
  click(text("taskDetails"), row("layout")); await paint();
  return { passed: true, calls: calls.length, copiedCharacters: copied.length };
};

window.delegationLayoutProbe = async () => {
  await paint();
  const center = document.querySelector(".delegation-center");
  const reader = document.querySelector(".delegation-reader");
  const body = reader.querySelector(".delegation-task-body");
  const actions = reader.querySelector(".delegation-reader-actions");
  const a = actions.getBoundingClientRect(); const c = center.getBoundingClientRect(); const b = body.getBoundingClientRect();
  check(c.left >= 0 && c.right <= innerWidth && c.top >= 0 && c.bottom <= innerHeight, "Center must stay within viewport: " + JSON.stringify({ width: innerWidth, left: c.left, right: c.right, top: c.top, bottom: c.bottom }));
  check(a.top >= 0 && a.bottom <= innerHeight && b.height >= 64, "Actions visible independently of full task: " + JSON.stringify({ actions: a.toJSON(), body: b.toJSON() }));
  check(body.scrollHeight > body.clientHeight && body.scrollWidth <= body.clientWidth + 1, "Long CJK/English body must wrap and scroll vertically");
  check(document.documentElement.scrollWidth <= innerWidth, "No page horizontal overflow");
  body.scrollTop = 300;
  check(actions.getBoundingClientRect().top === a.top, "Reading must not move actions");
  check(reader.querySelector("time") && reader.querySelector(".delegation-metadata"), "Actual model/deadline remain pinned");
  if (innerWidth <= 760) {
    check(getComputedStyle(document.querySelector(".delegation-list-column")).display === "none", "Narrow reader uses full width");
    click(text("back"), reader); await paint(); check(row("layout"), "Back restores requests");
    click(text("taskDetails"), row("layout")); await paint();
  } else {
    const width = document.querySelector(".delegation-list-column").getBoundingClientRect().width;
    check(width >= 320 && width <= 360, "Wide list is 320–360px");
  }
  click(text("hide")); await paint();
  const collapsed = center.getBoundingClientRect();
  check(collapsed.top >= 40 && collapsed.bottom < innerHeight / 2, "Collapsed approval entry must stay away from the bottom composer");
  check(collapsed.width < Math.min(320, innerWidth - 32), "Collapsed approval entry must size to its contents, not keep the panel width");
  check(collapsed.right <= innerWidth && collapsed.left >= 0, "Collapsed approval entry stays inside the viewport");
  flushSync(() => toggle().click()); await paint();
  return { width: innerWidth, bodyHeight: b.height, actionsBottom: a.bottom, reducedMotion: getComputedStyle(row("layout")).animationName };
};
window.delegationLocaleProbe = async () => {
  const keys = (object, prefix = "") => Object.entries(object).flatMap(([key, value]) => typeof value === "object" ? keys(value, prefix + key + ".") : [prefix + key]);
  const expected = keys(catalogs.en.delegationApproval).sort();
  for (const [locale, catalog] of Object.entries(catalogs)) {
    check(JSON.stringify(keys(catalog.delegationApproval).sort()) === JSON.stringify(expected), "Approval catalog parity: " + locale);
    await i18next.changeLanguage(locale); await paint(); await window.delegationLayoutProbe();
    check(!document.querySelector(".delegation-center").textContent.includes("delegationApproval."), "No untranslated labels: " + locale);
  }
  await i18next.changeLanguage("en"); return { locales: Object.keys(catalogs).length };
};
window.delegationFocusProbe = () => {
  const node = document.activeElement;
  check(node instanceof HTMLButtonElement && node.matches(":focus-visible") && getComputedStyle(node).outlineStyle !== "none", "Keyboard focus is visible");
  return true;
};
window.delegationEscapeProbe = () => {
  check(toggle().getAttribute("aria-expanded") === "false", "Escape hides without cancelling");
  check(document.activeElement === toggle(), "Collapse returns focus to reopening control");
  check(!calls.some(({ input }) => input.requestId === "layout"), "Escape must not answer the request");
  return true;
};

window.delegationLifecycleProbe = async () => {
  list = deferred();
  flushSync(() => root.render(<I18nextProvider key="lifecycle" i18n={i18next}><DelegationApprovalCenter onNavigate={async () => { throw new Error("Demo navigation failure"); }} /></I18nextProvider>));
  check(listeners.size === 1 && clockTicks.size === 1, "Remount must clean the previous subscription and clock");
  check(document.querySelector(".delegation-center").textContent.includes(text("loading")), "Hydration exposes loading");
  list.resolve({ ok: false, error: { code: "DEMO_FAILURE", message: "Demo listing failed" } });
  await until(() => document.querySelector(".delegation-center").textContent.includes(text("loadFailed")));
  list = deferred(); click(text("retry"));
  const stale = request("hydration", { sessionId: "stale-session" });
  const live = request("hydration", { sessionId: "live-session" });
  emit(stale); emit({ ...stale, status: "cancelled" });
  list.resolve({ ok: true, data: { requests: [stale, live] } });
  await until(() => row("hydration"));
  check(document.querySelectorAll('[data-request-id="hydration"]').length === 1, "Older hydrate must not revive terminal event");
  click(text("openSource", { title: live.sessionTitle }));
  await until(() => document.querySelector(".delegation-center").textContent.includes(text("navigationFailed")));
  const sameA = request("same-id", { sessionId: "session-a", agentName: "Collision A" });
  const sameB = request("same-id", { sessionId: "session-b", agentName: "Collision B" });
  emit(sameA); emit(sameB);
  const collisionRows = [...document.querySelectorAll('[data-request-id="same-id"]')];
  check(collisionRows.length === 2, "Same request IDs in different sessions remain independent");
  flushSync(() => collisionRows[1].querySelector("input").click());
  click(text("allowSelected"));
  check(calls.at(-1).input.sessionId === "session-b" && calls.at(-1).input.requestId === "same-id", "Batch targets exact session/request pair");
  answer({ accepted: true, request: { ...sameB, status: "approved" } });
  await until(() => document.querySelectorAll('[data-request-id="same-id"]').length === 1);
  const before = request("reply-race"); emit(before);
  click(text("allowOnce"), row("reply-race"));
  const newer = { ...before, revision: 2, candidate: alternative };
  emit(newer);
  answer({ accepted: true, request: { ...before, status: "approved" } });
  await until(() => row("reply-race") && !button(text("allowOnce"), row("reply-race")).disabled);
  check(!row("reply-race").textContent.includes(text("feedback.approved")), "Older ACK cannot claim newer candidate approval");
  flushSync(() => row("reply-race").querySelector("input").click());
  click(text("allowSelected"));
  check(calls.at(-1).input.revision === 2, "Retry submits displayed revision");
  replies.shift().reject(new Error("Demo transport disconnected"));
  await until(() => row("reply-race").textContent.includes(text("feedback.failed")));
  check(row("reply-race").querySelector("input").checked, "Transport failure preserves selected retry target");
  await until(() => !button(text("allowSelected")).disabled);
  click(text("allowSelected")); answer({ accepted: true, request: { ...newer, status: "approved" } }); await until(() => !row("reply-race"));
  emit({ ...live, status: "expired" }); emit({ ...sameA, status: "invalidated" });
  await until(() => document.querySelector(".delegation-empty"));
  check(document.querySelector(".delegation-empty").textContent === text("empty"), "Resolved requests expose the empty state");
  const callsBeforeHide = calls.length;
  click(text("hide"));
  check(!document.querySelector(".delegation-center"), "Dismissed results must not leave a zero-count floating panel");
  const arriving = request("after-dismiss", { expiresAt: new Date(clock + 1000).toISOString() });
  emit(arriving);
  check(toggle()?.getAttribute("aria-expanded") === "false", "New live requests restore the compact entry without reopening the panel");
  flushSync(() => toggle().click());
  check(row("after-dismiss") && document.querySelector(".delegation-results"), "Reopening retains results and exposes the new request");
  click(text("hide"));
  clock += 2000; flushSync(() => { for (const tick of clockTicks) tick(); });
  check(!document.querySelector(".delegation-center"), "Local deadline expiry removes an idle collapsed entry before the host event");
  const settling = request("settle-collapsed"); emit(settling);
  check(toggle(), "A later live request restores the entry after expiry");
  emit({ ...settling, status: "approved" });
  check(!document.querySelector(".delegation-center"), "Host settlement removes the collapsed entry");
  check(calls.length === callsBeforeHide, "Dismissal, reappearance and expiry must not submit any approval action");
  flushSync(() => root.render(null));
  check(listeners.size === 0 && clockTicks.size === 0, "Unmount releases subscriptions and deadline clock");
  return { hydrationRace: true, replyRace: true, transportRetry: true, cleanup: true };
};
