import { describe, expect, it } from "vitest";
import { isNotificationSettings, isNotificationTarget, resolveNotificationPolicy } from "./notification-settings.js";

describe("core notification preferences", () => {
  it("defaults to automatic, audible delivery without rewriting missing settings", () => {
    expect(resolveNotificationPolicy(undefined, "delegation-approval")).toEqual({
      enabled: true, channel: "auto", sound: true, volume: 100, repeatIntervalSeconds: 0,
    });
    expect(resolveNotificationPolicy(undefined, "task.completed").enabled).toBe(true);
  });
  it("resolves a delegation override but never bypasses the global master switch", () => {
    const settings = { version: 1 as const, enabled: false, categories: { needsAction: false },
      delegation: { enabled: true, channel: "system" as const, sound: false, volume: 40, repeatIntervalSeconds: 30 } };
    expect(resolveNotificationPolicy(settings, "delegation-approval")).toEqual({
      enabled: false, channel: "system", sound: false, volume: 40, repeatIntervalSeconds: 30,
    });
    expect(resolveNotificationPolicy({ ...settings, enabled: true }, "delegation-approval").enabled).toBe(true);
    expect(resolveNotificationPolicy({ ...settings, enabled: true }, "ask").enabled).toBe(false);
    expect(resolveNotificationPolicy({ version: 1, delegation: { enabled: false } }, "delegation.failed").enabled).toBe(false);
  });
  it("keeps failures, completions and interactive categories independent", () => {
    const settings = { version: 1 as const, categories: { failures: false, completions: false } };
    expect(resolveNotificationPolicy(settings, "task.failed").enabled).toBe(false);
    expect(resolveNotificationPolicy(settings, "delegation.failed").enabled).toBe(false);
    expect(resolveNotificationPolicy(settings, "task.completed").enabled).toBe(false);
    expect(resolveNotificationPolicy(settings, "permission").enabled).toBe(true);
    expect(resolveNotificationPolicy(settings, "plan").repeatIntervalSeconds).toBe(0);
  });
  it("validates strict preferences and reminder bounds", () => {
    for (const value of [{ version: 1 }, { version: 1, volume: 0 },
      { version: 1, delegation: { repeatIntervalSeconds: 0 } },
      { version: 1, delegation: { repeatIntervalSeconds: 10 } },
      { version: 1, delegation: { repeatIntervalSeconds: 300 } }]) expect(isNotificationSettings(value)).toBe(true);
    for (const value of [null, [], {}, { version: 2 }, { version: 1, enabled: "true" },
      { version: 1, channel: "native" }, { version: 1, volume: 101 }, { version: 1, volume: 1.5 },
      { version: 1, categories: { other: true } }, { version: 1, delegation: null },
      { version: 1, delegation: { repeatIntervalSeconds: 9 } },
      { version: 1, delegation: { repeatIntervalSeconds: 301 } },
      { version: 1, task: "untrusted" }]) expect(isNotificationSettings(value)).toBe(false);
  });
  it("validates typed navigation targets without coercing source kinds", () => {
    expect(isNotificationTarget({ kind: "ask", sessionId: "session", requestId: "request", hostKey: "remote", revision: 1 })).toBe(true);
    for (const value of [null, { kind: ["ask"], sessionId: "session" }, { kind: "unknown", sessionId: "session" },
      { kind: "ask", sessionId: "" }, { kind: "ask", sessionId: "session", approve: true },
      { kind: "ask", sessionId: "session", revision: -1 }]) expect(isNotificationTarget(value)).toBe(false);
  });
});
