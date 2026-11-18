import { describe, expect, it } from "vitest";
import { resolveObserverGuardSettings, type UiMessage } from "@pi-desktop/shared";
import { ObserverTaskHistory, isObserverContinuation } from "./observer-task-context.js";
import { ObserverEvidenceWindow, parseObserverVerdict } from "./observer-guard-evidence.js";

const row = (id: string, role: UiMessage["role"], content: string, extra: Partial<UiMessage> = {}): UiMessage => ({
  id, role, content, createdAt: "2026-01-01T00:00:00Z", status: "complete", ...extra,
});
const goal = row("goal", "user", "Implement deduplication and verify three scenarios. Keep original records unchanged.");
const reply = row("reply", "assistant", "Implementation complete; three-scenario validation remains.");

describe("bounded observer task history", () => {
  it.each([
    ["实现展示去重并验证三个场景。不要修改原始记录。", true],
    ["不要修改原始记录。", false],
    ["只分析展示去重的实现，不要修改任何代码。", false],
    ["实现展示去重。不要执行。", false],
  ])("distinguishes preservation constraints from execution prohibition: %s", (task, actionable) => {
    const history = new ObserverTaskHistory([row("goal", "user", task)]);
    expect(history.context("继续。")?.actionable).toBe(actionable);
  });
  it.each(["继续。", "继续，完成前不要报告。", "请继续完成剩余验证", "接着做", "Continue.", "Please continue until finished.", "Resume the remaining work."])("recognizes explicit continuation %s", task => {
    expect(isObserverContinuation(task)).toBe(true);
  });

  it.each(["Explain the next step.", "Implement a calculator.", "What does continue mean?", "`continue`", "Do not continue.", "不要继续"])("does not export history for independent or quoted requests: %s", task => {
    expect(new ObserverTaskHistory([goal, reply]).context(task)).toBeUndefined();
  });

  it("keeps the latest explicit goal, later constraints and only the latest answer", () => {
    const history = new ObserverTaskHistory([
      row("unrelated", "user", "Implement another private project."),
      row("old-answer", "assistant", "Unrelated work."), goal, reply,
      row("continue", "user", "Continue, but keep all original records unchanged."),
      row("latest", "assistant", "Validation is still pending."),
    ]);
    expect(history.context("Continue.")).toEqual({ evidence: [
      { id: "goal", kind: "prior_user", text: goal.content },
      { id: "continue", kind: "prior_user", text: "Continue, but keep all original records unchanged." },
      { id: "latest", kind: "prior_assistant", text: "Validation is still pending." },
    ], actionable: true, truncated: false });
  });

  it("keeps earlier discussion restrictions after another continuation", () => {
    const history = new ObserverTaskHistory([goal, row("narrow", "user", "Continue, only explain the design."), reply]);
    expect(history.context("Continue.")?.actionable).toBe(false);
  });

  it("never includes system, reasoning, tools, attachments, replay or child prose", () => {
    const history = new ObserverTaskHistory([
      goal, row("system", "system", "private-system"),
      row("tool", "tool", "private-result", { toolArgs: { secret: "private-args" } }),
      row("child", "user", "private-child", { parentToolCallId: "task" }),
      { ...reply, thinking: "private-thinking", providerReplay: { version: 1, blocks: [] } },
    ]);
    const input = new ObserverEvidenceWindow().build("Continue.", "current", "Pending validation.", "answer", resolveObserverGuardSettings({}), [], history.context("Continue."));
    expect(input.text).not.toMatch(/private-|providerReplay|thinking|toolArgs/);
    expect(input.evidence.map(item => item.id)).toEqual(["current", "answer", "goal", "reply"]);
  });

  it("treats authenticated session notices as a boundary, not a user goal", () => {
    const history = new ObserverTaskHistory([goal, reply, row("notice", "user", "Implement the other agent's work.", {
      sessionMessage: { kind: "completion", sourceSessionId: "child", sourceTitle: "Child", targetSessionId: "parent", messageId: "notice", replyToMessageId: "parent-message" },
    }), row("notice-answer", "assistant", "Notice acknowledged.")]);
    expect(history.context("Continue.")).toEqual({ evidence: [], actionable: false, truncated: false });
  });

  it("bounds continued user history and exposes an omitted goal instead of silently granting action", () => {
    const history = new ObserverTaskHistory([goal]);
    for (let i = 0; i < 8; i++) history.user(`user-${i}`, "Continue.");
    history.answer("latest", "Validation pending.");
    const context = history.context("Continue.");
    expect(context?.evidence).toHaveLength(7);
    expect(context).toMatchObject({ actionable: false, truncated: true });
    history.user("new-goal", "Implement a calculator.");
    expect(history.context("Continue.")).toMatchObject({ actionable: true, truncated: false });
  });

  it("does not reconstruct a missing goal from repeated continuation-only rows", () => {
    const history = new ObserverTaskHistory([row("continue", "user", "Continue."), reply]);
    expect(history.context("Continue.")).toMatchObject({ actionable: false, truncated: true });
  });

  it.each([
    { attachments: [{ kind: "file" as const, name: "private", ref: "private-file" }] },
    { content: "Implement " + "x".repeat(21_000) },
  ])("marks omitted task content as truncated", extra => {
    const history = new ObserverTaskHistory([{ ...goal, ...extra }, reply]);
    expect(history.context("Continue.")?.truncated).toBe(true);
    expect(JSON.stringify(history.context("Continue."))).not.toContain("private-file");
  });

  it("keeps provider-truncated previous answers explicit and drops failed replies", () => {
    expect(new ObserverTaskHistory([goal, { ...reply, outputTruncated: true }]).context("Continue.")?.truncated).toBe(true);
    const history = new ObserverTaskHistory([goal, { ...reply, status: "error", content: "failed-private-reply" }]);
    expect(JSON.stringify(history.context("Continue."))).not.toContain("failed-private-reply");
  });

  it("redacts historical evidence before applying the total input budget", () => {
    const history = new ObserverTaskHistory([
      { ...goal, content: "Implement deduplication. password=historical-password known-secret" },
      { ...reply, content: "Pending. Bearer secret-bearer" },
    ]);
    const input = new ObserverEvidenceWindow().build("Continue.", "current", "Pending.", "answer", resolveObserverGuardSettings({}), ["known-secret"], history.context("Continue."));
    expect(input.text).toContain("[REDACTED]");
    expect(input.text).not.toMatch(/historical-password|known-secret|secret-bearer/);
    const long = new ObserverTaskHistory([{ ...goal, content: "Implement " + "🙂".repeat(4000) }, reply]);
    const bounded = new ObserverEvidenceWindow().build("Continue.", "current", "Pending.", "answer", resolveObserverGuardSettings({ maxInputChars: 2000 }), [], long.context("Continue."));
    expect(bounded.text.length).toBeLessThanOrEqual(2000);
    expect(bounded.truncated).toBe(true);
    for (const item of bounded.evidence) expect(item.text).not.toMatch(/\p{Cs}/u);
  });

  it("requires the current assistant citation even when a historical reply is present", () => {
    const input = new ObserverEvidenceWindow().build("Continue.", "current", "Pending.", "answer", resolveObserverGuardSettings({}), [], new ObserverTaskHistory([goal, reply]).context("Continue."));
    const verdict = { verdict: "incomplete", confidence: "high", reason: "Validation pending.", evidenceIds: ["reply"] };
    expect(parseObserverVerdict(JSON.stringify(verdict), input.evidence)).toBeUndefined();
    expect(parseObserverVerdict(JSON.stringify({ ...verdict, evidenceIds: ["goal", "answer"] }), input.evidence)?.verdict).toBe("incomplete");
  });
});

it("preserves compound execution prohibitions before interpreting preservation clauses", () => {
  const history = new ObserverTaskHistory([goal]);
  history.user("restricted", "继续，不要修改任何代码也不要执行任何命令。");
  expect(history.context("Continue.")?.actionable).toBe(false);
});

it.each(["Go ahead and implement a calculator instead.", "继续，但改为实现计算器。"])("starts a new evidence boundary for explicit task replacement: %s", task => {
  const history = new ObserverTaskHistory([goal, reply]);
  expect(history.context(task)).toBeUndefined();
  history.user("replacement", task);
  expect(history.context("Continue.")?.evidence.map(item => item.id)).toEqual(["replacement"]);
});

it("invalidates restored steering without turning it into a historical task", () => {
  const history = new ObserverTaskHistory([goal, reply, row("steering", "user", "Continue, only explain the design.", { steering: true })]);
  expect(history.context("Continue.")).toEqual({ evidence: [], actionable: false, truncated: false });
});
