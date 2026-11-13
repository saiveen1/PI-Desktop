import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { parseSubagentObservation } from "@pi-desktop/shared";
import { SubagentObserver, subagentEvidenceHandoff } from "./subagent-observability.js";
import { persistSubagentCheckpoint, readSubagentCheckpoint } from "./subagent-checkpoint.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const result = (text: string) => ({ content: [{ type: "text", text }], details: {} });
const message = (): AssistantMessage => ({ role: "assistant", content: [], api: "openai-completions", provider: "fixture", model: "model",
  timestamp: Date.now(), stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
afterEach(() => vi.useRealTimers());

describe("subagent observational signal boundaries", () => {
  it("counts changed read evidence but not repeated reads, arbitrary calls or heartbeats", () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const observer = new SubagentObserver("fixture/model", () => undefined, new Set(["Read"]));
    observer.toolStarted("a", "Read", { path: "a.ts" });
    observer.toolEnded("a", result("same evidence"), false);
    expect(observer.snapshot().lastMeaningfulProgressAt).toBe(100_000);
    vi.setSystemTime(140_000);
    observer.toolStarted("b", "Read", { path: "a.ts" });
    observer.toolEnded("b", result("same evidence"), false);
    observer.toolStarted("shell", "Bash", { command: "sensitive command" });
    observer.activity();
    observer.toolEnded("shell", result("arbitrary output"), false);
    expect(observer.snapshot()).toMatchObject({ completedToolCalls: 3, lastActivityAt: 140_000, lastMeaningfulProgressAt: 100_000,
      diagnostic: { state: "no_new_evidence" } });
    expect(JSON.stringify(observer.snapshot())).not.toContain("sensitive command");
    observer.toolStarted("c", "Read", { path: "a.ts" });
    observer.toolEnded("c", result("new evidence"), false);
    expect(observer.snapshot().lastMeaningfulProgressAt).toBe(140_000);
  });

  it("distinguishes quiet active model requests from meaningful progress and does not fabricate unresolved metrics", async () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const changed = vi.fn();
    const observer = new SubagentObserver("fixture/model", changed);
    const inner = createAssistantMessageEventStream();
    const observed = observer.observeStream("fixture/model", () => inner);
    vi.setSystemTime(140_000);
    observer.activity();
    expect(observer.snapshot()).toMatchObject({ phase: "model", diagnostic: { state: "waiting_model" }, lastActivityAt: 140_000 });
    observer.end(false);
    const ended = observer.snapshot();
    expect(ended.attempts).toEqual([{ sequence: 1, model: "fixture/model", startedAt: 100_000, outcome: "unresolved" }]);
    const calls = changed.mock.calls.length;
    inner.end(message());
    await observed.result();
    expect(changed).toHaveBeenCalledTimes(calls);
    expect(observer.snapshot()).toEqual(ended);
  });

  it("bounds attempts and tool evidence while exposing omissions and every attempt transition", async () => {
    const changes: number[] = [];
    const observer = new SubagentObserver("fixture/model", () => changes.push(observer.snapshot().attemptCount), new Set(["Write", "Edit"]));
    for (let i = 0; i < 66; i++) {
      const stream = observer.observeStream("fixture/model", () => { const stream = createAssistantMessageEventStream(); stream.end(message()); return stream; });
      await stream.result();
      observer.toolStarted(`write${i}`, "Write", { path: `src/${i}.ts`, content: "private contents" });
      observer.toolEnded(`write${i}`, result("ok"), false);
    }
    for (let i = 0; i < 18; i++) observer.toolStarted(`pending${i}`, "Edit", { path: `${"long".repeat(200)}/${i}.ts` });
    const snapshot = observer.snapshot();
    expect(snapshot).toMatchObject({ attemptCount: 66, attemptsOmitted: 2, completedToolCalls: 66, pendingToolsOmitted: 2, confirmedWritePathsOmitted: 34 });
    expect(snapshot.attempts).toHaveLength(64);
    expect(snapshot.recentTools).toHaveLength(12);
    expect(snapshot.confirmedWritePaths).toHaveLength(32);
    expect(snapshot.pendingTools).toHaveLength(16);
    expect(new Set(changes).size).toBe(66);
    expect(JSON.stringify(snapshot)).not.toContain("private contents");
    const handoff = subagentEvidenceHandoff(snapshot);
    expect(handoff).toContain("Pending tools; effects unknown");
    expect(handoff).toContain("Confirmed successful file writes");
    expect(handoff).toContain("omitted");
    expect(handoff.length).toBeLessThan(10_000);
    expect(parseSubagentObservation(snapshot)).toEqual(snapshot);
  });

  it("retains unknown failed effects and does not mark arbitrary successful tools as writes", () => {
    const observer = new SubagentObserver("fixture/model", () => undefined, new Set(["Write"]));
    observer.toolStarted("failed", "Write", { file_path: "failed.ts" });
    observer.toolEnded("failed", result("partial failure"), true);
    observer.toolStarted("shell", "Bash", { path: "not-confirmed.ts" });
    observer.toolEnded("shell", result("success"), false);
    expect(observer.snapshot()).toMatchObject({ confirmedWritePaths: [], failedToolCalls: 1,
      recentTools: [{ path: "failed.ts", effects: "unknown", outcome: "failed" }, { effects: "unknown", outcome: "completed" }] });
  });

  it("does not trust dynamic tools that merely use builtin file-tool names", () => {
    const observer = new SubagentObserver("fixture/model", () => undefined);
    for (const name of ["Read", "Write", "Edit"]) {
      observer.toolStarted(name, name, { path: "untrusted/private-path" });
      observer.toolEnded(name, result("claimed success"), false);
    }
    const snapshot = observer.snapshot();
    expect(snapshot.confirmedWritePaths).toEqual([]);
    expect(snapshot.lastMeaningfulProgressAt).toBeUndefined();
    expect(snapshot.recentTools.every(tool => tool.effects === "unknown" && tool.path === undefined)).toBe(true);
  });

  it("allowlists checkpoint observations, accepts old checkpoints, and rejects malformed metadata", () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "observation-checkpoint-"));
    const location = { scratchDir, parentToolCallId: "parent", sessionId: "session", agentName: "worker" };
    const observer = new SubagentObserver("fixture/model", () => undefined);
    const base = { version: 1 as const, status: "failed" as const, sessionId: "session", agentName: "worker", modelId: "model",
      thinkingLevel: "off", report: "Retained finding", turns: 1, toolCalls: 0, updatedAt: Date.now() };
    try {
      persistSubagentCheckpoint({ ...location, checkpoint: base });
      expect(readSubagentCheckpoint(location).checkpoint?.observation).toBeUndefined();
      expect(readSubagentCheckpoint(location).checkpoint?.report).toBe("Retained finding");
      const observation = observer.snapshot();
      const injected = { ...observation, command: "do not restore", attempts: [] };
      persistSubagentCheckpoint({ ...location, checkpoint: { ...base, observation: injected } });
      expect(readSubagentCheckpoint(location).checkpoint?.observation).toEqual(observation);
      expect(parseSubagentObservation({ ...observation, attemptCount: -1 })).toBeUndefined();
      expect(parseSubagentObservation({ ...observation, pendingTools: Array(17).fill({}) })).toBeUndefined();
      expect(parseSubagentObservation({ ...observation, attempts: [{ sequence: 1, model: "fixture/model", startedAt: 1, outcome: "failed", providerDurationMs: NaN }], attemptCount: 1 })).toBeUndefined();
      const invalid = { ...observation, diagnostic: { ...observation.diagnostic, thresholdMs: -1 } };
      persistSubagentCheckpoint({ ...location, checkpoint: { ...base, observation: invalid } });
      expect(readSubagentCheckpoint(location).error).toBe("checkpoint-invalid");
    } finally { rmSync(scratchDir, { recursive: true, force: true }); }
  });
});
