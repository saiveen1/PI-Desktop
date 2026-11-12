import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { selectActiveTurnTail } from "./compaction-continuity.js";
import { estimateContextTokens, estimateTokens } from "./pi-runtime-estimates.js";
import { replayRetainedTail } from "./compaction-tail.js";

const user = (content: string): UserMessage => ({ role: "user", content, timestamp: 1 });
const assistant = (ids: string[], text = "Apply once"): AssistantMessage => ({
  role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
  timestamp: 2, stopReason: ids.length ? "toolUse" : "stop",
  content: [{ type: "text", text }, ...ids.map(id => ({ type: "toolCall" as const,
    id, name: "Write", arguments: { path: `${id}.txt`, content: "fixture" } }))],
  usage: { input: 900_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 900_100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const result = (toolCallId: string, text: string, isError = false): ToolResultMessage => ({
  role: "toolResult", toolName: "Write", toolCallId, content: [{ type: "text", text }],
  isError, timestamp: 3,
});
const cost = (messages: AgentMessage[]) => messages.reduce((sum, m) => sum + estimateTokens(m), 0);

describe("selectActiveTurnTail", () => {
  it("keeps the current goal and original executed pairs, not older tasks or usage", () => {
    const messages = [user("old task"), assistant([], "old task complete"), user("current task"),
      assistant(["apply"]), result("apply", "applied receipt=17"), assistant([], "Next: publish")];
    const before = JSON.stringify(messages);
    const tail = selectActiveTurnTail(messages, 8_000, 20_000);
    expect(tail.map(m => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(JSON.stringify(tail)).not.toContain("old task");
    expect(JSON.stringify(tail)).toContain('"name":"Write"');
    expect(JSON.stringify(tail)).toContain("applied receipt=17");
    expect(estimateContextTokens(tail).usageTokens).toBe(0);
    expect(JSON.stringify(messages)).toBe(before);
    expect(replayRetainedTail(JSON.parse(JSON.stringify(tail)))).toEqual(tail);
  });

  it("bounds an oversized parallel batch without losing result endings or call identity", () => {
    const messages = [user("publish once"), assistant(["a", "b"]),
      result("a", `start-a ${"x".repeat(60_000)} SUCCESS receipt=a`),
      result("b", `start-b ${"y".repeat(90_000)} ERROR outcome=unknown`, true)];
    const tail = selectActiveTurnTail(messages, 2_000, 20_000);
    expect(cost(tail)).toBeLessThanOrEqual(2_000);
    expect(tail.map(m => m.role)).toEqual(["user", "assistant", "toolResult", "toolResult"]);
    const outputs = tail.filter(m => m.role === "toolResult");
    expect(outputs.map(m => m.toolCallId)).toEqual(["a", "b"]);
    expect(outputs.map(m => m.isError)).toEqual([false, true]);
    expect(JSON.stringify(outputs)).toContain("SUCCESS receipt=a");
    expect(JSON.stringify(outputs)).toContain("ERROR outcome=unknown");
    expect(JSON.stringify(outputs)).toContain("checkpoint truncated");
    expect(JSON.stringify(messages[2])).not.toContain("checkpoint truncated");
  });

  it("keeps only answered calls and their own results, including error outcomes", () => {
    const tail = selectActiveTurnTail([user("continue"), result("orphan", "ignore"),
      assistant(["done", "missing"]), result("done", "failed", true),
      result("orphan", "ignore again"), result("done", "duplicate")], 8_000, 20_000);
    expect(tail.map(m => m.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(JSON.stringify(tail)).not.toMatch(/missing|orphan|duplicate/);
    expect(tail[2]).toMatchObject({ toolCallId: "done", isError: true });
  });

  it.each(["error", "aborted", "deferred"] as const)("does not resurrect a %s assistant or its results", stopReason => {
    const failed = { ...assistant(["failed"]), stopReason };
    const tail = selectActiveTurnTail([user("continue"), failed, result("failed", "partial")], 8_000, 20_000);
    expect(tail).toEqual([user("continue")]);
  });

  it("omits an unfit opaque call as a whole rather than mutating its arguments", () => {
    const call = assistant(["huge"]);
    const tool = call.content.find(block => block.type === "toolCall")!;
    tool.arguments = { content: "x".repeat(100_000) };
    const messages = [user("continue"), call, result("huge", "success")];
    const before = JSON.stringify(messages);
    expect(selectActiveTurnTail(messages, 100, 20_000)).toEqual([user("continue")]);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("shares the budget between an oversized goal and current execution evidence", () => {
    const messages = [user(`goal-start ${"x".repeat(50_000)} goal-end`),
      assistant(["applied"]), result("applied", "APPLIED receipt=17")];
    const tail = selectActiveTurnTail(messages, 1_000, 20_000);
    expect(cost(tail)).toBeLessThanOrEqual(1_000);
    expect(JSON.stringify(tail[0])).toContain("goal-start");
    expect(JSON.stringify(tail[0])).toContain("goal-end");
    expect(JSON.stringify(tail)).toContain("APPLIED receipt=17");
  });

  it("preserves recent evidence through a second checkpoint without duplicate calls", () => {
    const first = selectActiveTurnTail([user("finish"), assistant(["one"]), result("one", "done one")], 1_000, 20_000);
    const second = selectActiveTurnTail([...first, assistant(["two"]), result("two", "done two")], 1_000, 20_000);
    expect(second.filter(m => m.role === "user")).toHaveLength(1);
    expect(second.filter(m => m.role === "toolResult").map(m => m.toolCallId)).toEqual(["one", "two"]);
    expect(estimateContextTokens(second).usageTokens).toBe(0);
  });
});

describe("continuity review regressions", () => {
  it("bounds image checkpoint bytes independently of the token estimate", () => {
    const image = { type: "image" as const, mimeType: "image/png", data: "A".repeat(12 * 1024 * 1024) };
    const messages: AgentMessage[] = [user("inspect"), assistant(["a", "b", "c"]),
      ...["a", "b", "c"].map(id => ({ ...result(id, "image"), content: [image], details: { image } }))];
    const tail = selectActiveTurnTail(messages, 8_000, 20_000);
    expect(cost(tail)).toBeLessThanOrEqual(8_000);
    expect(Buffer.byteLength(JSON.stringify(tail))).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it("retains an image when reducing only goal text makes it fit", () => {
    const image = { type: "image" as const, mimeType: "image/png", data: "fixture" };
    const goal: UserMessage = { role: "user", timestamp: 1,
      content: [{ type: "text", text: "x".repeat(50_000) }, image] };
    const tail = selectActiveTurnTail([goal], 10_000, 20_000);
    expect(cost(tail)).toBeLessThanOrEqual(5_000);
    const keptGoal = tail[0];
    expect(keptGoal?.role === "user" && Array.isArray(keptGoal.content) &&
      keptGoal.content.some(block => block.type === "image")).toBe(true);
  });

  it("keeps same-turn steering after completed execution without reviving an older task", () => {
    const messages = [user("old task"), assistant([], "old completed"),
      { ...user("current task"), timestamp: 10 }, { ...assistant(["apply"]), timestamp: 11 },
      { ...result("apply", "APPLIED receipt=17"), timestamp: 12 },
      { ...user("also use dark mode"), timestamp: 13 }];
    const tail = selectActiveTurnTail(messages, 8_000, 20_000, 10);
    expect(tail.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
    expect(JSON.stringify(tail)).not.toContain("old task");
    expect(JSON.stringify(tail)).toContain("APPLIED receipt=17");
  });

  it("uses existing wire-id repair before retaining execution pairs", () => {
    const output = result("call-1|other", "APPLIED receipt=17");
    const tail = selectActiveTurnTail([user("continue"), assistant(["call-1|item-1"]), output], 8_000, 20_000);
    expect(tail.filter(message => message.role === "toolResult").map(message => message.toolCallId))
      .toEqual(["call-1|item-1"]);
    expect(output.toolCallId).toBe("call-1|other");
  });
});

it("strips duplicate result payloads but preserves on-demand activation markers", () => {
  const call = assistant(["activate"]);
  const block = call.content.find(item => item.type === "toolCall")!;
  block.name = "ToolSearch";
  const output = { ...result("activate", "Activated: BrowserPreview"), toolName: "ToolSearch",
    details: { addedToolNames: ["BrowserPreview"], blocks: [{ data: "duplicate".repeat(10_000) }] } };
  const tail = selectActiveTurnTail([user("inspect"), call, output], 8_000, 20_000);
  expect(tail.find(message => message.role === "toolResult")).toMatchObject({
    details: { addedToolNames: ["BrowserPreview"] },
  });
  expect(JSON.stringify(tail)).not.toContain("duplicate");
  expect(output.details.blocks).toHaveLength(1);
});

it("keeps steering at a safe batch boundary when it arrives before a tool result", () => {
  const tail = selectActiveTurnTail([user("continue"), assistant(["apply"]),
    { ...user("also use dark mode"), timestamp: 3 }, result("apply", "APPLIED receipt=17", false)], 8_000, 20_000, 1);
  expect(tail.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
  expect(tail[2]).toMatchObject({ toolCallId: "apply", isError: false });
});
