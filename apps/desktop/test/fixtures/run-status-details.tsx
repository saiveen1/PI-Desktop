import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { WorkingIndicator, RunActivityIndicator } from "../../src/features/chat/transcript/ActivityGroup";
import { RunStatusIndicator } from "../../src/features/chat/transcript/RunStatusIndicator";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/styles/ui-kit.css";
import "../../src/styles/messages.css";

await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", resources: { en: { translation: catalogs.en } }, interpolation: { escapeValue: false } });
const host = document.getElementById("root")!;
const root = createRoot(host);
const now = Date.parse("2026-11-06T10:00:00Z");
let clock = now;
Date.now = () => clock;
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const diagnostics = {
  turnId: "turn-a", startedAt: now - 492_000, requestCount: 2, attemptCount: 5, requestAttempt: 4,
  retryCount: 3, rateLimitRetries: 1, transientRetries: 2, retryWaitMs: 25_000,
  requestStartedAt: now - 130_000, attemptStartedAt: now - 60_000,
  lastEventAt: now - 4_000, lastTextAt: now - 80_000, lastEventKind: "thinking" as const,
  phase: "thinking" as const, inputTokens: 749350, contextWindow: 1000000,
  lastRetry: { at: now - 70_000, code: "PROVIDER_ERROR", providerStatus: 503 },
};
const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

Object.assign(window, {
  async runStatusProbe() {
    flushSync(() => root.render(<WorkingIndicator diagnostics={diagnostics} />));
    let trigger = host.querySelector<HTMLButtonElement>(".run-status-trigger");
    check(trigger, "ordinary running status must expose details");
    check(host.textContent?.includes("8m 12s"), "whole-turn timer must include the pre-response wait");
    flushSync(() => { trigger!.focus(); trigger!.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
    await settle();
    let panel = document.querySelector<HTMLElement>(".run-status-popover");
    check(panel && !host.contains(panel), "details must portal out of the scrolling transcript");
    check(panel!.textContent?.includes("749"), "current request context estimate missing");
    check(panel!.textContent?.includes("503"), "latest retry must survive resumed thinking");
    check(panel!.textContent?.includes("3"), "whole-turn retries missing");
    flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    check(!document.querySelector(".run-status-popover"), "Escape must dismiss details");
    flushSync(() => trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await settle();
    panel = document.querySelector<HTMLElement>(".run-status-popover");
    check(panel?.contains(document.activeElement), "ArrowDown must enter the details action");
    flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    check(!document.querySelector(".run-status-popover"), "Escape must dismiss focused details");
    check(document.activeElement === trigger, "Escape from details must restore trigger focus");
    flushSync(() => trigger!.blur());
    flushSync(() => trigger!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
    await settle();
    check(document.querySelector(".run-status-popover"), "pointer hover must expose ordinary running details");
    flushSync(() => trigger!.click());
    flushSync(() => trigger!.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body })));
    await settle();
    check(document.querySelector(".run-status-popover"), "click must pin details after pointer leave");
    flushSync(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    check(!document.querySelector(".run-status-popover"), "outside click must dismiss details");
    const activity = { phase: "retrying" as const, since: now - 1000, attempt: 3, retryDelayMs: 7000,
      error: { code: "PROVIDER_ERROR", message: "Service temporarily unavailable", providerStatus: 503 } };
    flushSync(() => root.render(<RunActivityIndicator activity={activity} diagnostics={diagnostics} />));
    check(host.textContent?.includes("8m 12s"), "retry transition must not reset the turn timer");
    check(host.textContent?.includes("Retrying"), "existing retry countdown must remain visible");
    trigger = host.querySelector<HTMLButtonElement>(".run-status-trigger");
    flushSync(() => trigger!.click());
    await settle();
    panel = document.querySelector<HTMLElement>(".run-status-popover");
    check(panel!.textContent?.includes("Service temporarily unavailable"), "current retry reason must be preserved");
    const pane = host.closest<HTMLElement>(".main-pane")!;
    pane.style.width = "300px";
    flushSync(() => window.dispatchEvent(new Event("resize")));
    await settle();
    const box = panel!.getBoundingClientRect();
    check(box.left >= 0 && box.right <= window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight,
      "narrow details must stay inside the viewport");
    document.documentElement.setAttribute("data-theme", "light");
    check(getComputedStyle(panel!).color !== "rgba(0, 0, 0, 0)", "details must have a visible semantic foreground");
    pane.style.width = "";
    flushSync(() => root.render(<WorkingIndicator key="turn-b" diagnostics={{ ...diagnostics, turnId: "turn-b", startedAt: now - 5000, retryCount: 0, lastRetry: undefined }} />));
    check(!document.querySelector(".run-status-popover"), "old session details must close on switch");
    check(!host.textContent?.includes("8m 12s"), "another turn must not inherit old elapsed time");
    flushSync(() => root.render(<WorkingIndicator />));
    trigger = host.querySelector<HTMLButtonElement>(".run-status-trigger");
    check(!trigger, "old hosts without diagnostics must keep the plain fallback");
    flushSync(() => root.render(<RunStatusIndicator diagnostics={{ ...diagnostics, endedAt: now - 1000 }} summary label="Run details" />));
    check(host.textContent?.includes("8m 11s"), "completed summary must use the frozen whole-turn end");
    check(!host.querySelector(".run-status-retries"), "old retries must not leave a permanent badge on completed summaries");
    const originalSetTimeout = window.setTimeout;
    let expireBadge: (() => void) | undefined;
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 10_000 && typeof handler === "function") {
        expireBadge = () => handler(...args);
        return 123456;
      }
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout;
    const recent = { ...diagnostics, lastRetry: { ...diagnostics.lastRetry, at: now } };
    flushSync(() => root.render(<RunStatusIndicator diagnostics={{ ...recent, endedAt: now }} summary label="Run details" />));
    check(host.querySelector(".run-status-retries"), "a recent retry must show a transient badge");
    window.setTimeout = originalSetTimeout;
    check(expireBadge, "a completed summary must schedule badge expiration");
    clock = now + 10_000;
    flushSync(() => expireBadge!());
    check(!host.querySelector(".run-status-retries"), "the badge must disappear when the timer expires without another update");
    clock = now;
    flushSync(() => root.render(<RunStatusIndicator diagnostics={{ ...recent, lastRetry: { ...recent.lastRetry, at: now - 11_000 }, endedAt: now }} summary label="Run details" />));
    check(!host.querySelector(".run-status-retries"), "the badge must disappear after the retry window");
    flushSync(() => root.render(<RunStatusIndicator diagnostics={{ ...recent, retryCount: 4, endedAt: now }} summary label="Run details" />));
    check(host.querySelector(".run-status-retries")?.textContent?.includes("4"), "a later retry must restore the badge with the accumulated count");
    flushSync(() => root.render(<RunStatusIndicator diagnostics={{ ...recent, retryCount: 4, lastRetry: { ...recent.lastRetry, at: now - 11_000 }, endedAt: now }} summary label="Run details" />));
    check(!host.querySelector(".run-status-retries"), "the later badge must also expire");
    trigger = host.querySelector<HTMLButtonElement>(".run-status-trigger");
    flushSync(() => trigger!.click());
    await settle();
    panel = document.querySelector<HTMLElement>(".run-status-popover");
    const retriesRow = Array.from(panel!.querySelectorAll("dl > div")).find(row => row.querySelector("dt")?.textContent === i18n.t("chat.runDetails.retries"));
    check(retriesRow?.querySelector("dd")?.textContent?.includes("4"), "details must retain the cumulative retry count after the badge disappears");
    check(!Array.from(panel!.querySelectorAll("dt")).some(row => row.textContent === i18n.t("chat.runDetails.stage")),
      "completed details must not pretend an active stage still exists");
    flushSync(() => root.unmount());
    check(!document.querySelector(".run-status-popover"), "unmount must remove portaled details");
    return { passed: true, stableElapsed: true, hoverFocusClick: true, sessionIsolation: true };
  },
});
