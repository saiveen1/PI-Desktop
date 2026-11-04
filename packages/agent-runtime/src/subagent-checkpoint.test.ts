import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  persistSubagentCheckpoint,
  readSubagentCheckpoint,
  type SubagentCheckpoint,
} from "./subagent-checkpoint.js";

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "pi-subagent-checkpoint-"));
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

function checkpoint(overrides: Partial<SubagentCheckpoint> = {}): SubagentCheckpoint {
  return {
    version: 1,
    status: "running",
    sessionId: "session-1",
    delegateSessionId: "delegate-1",
    delegationId: "delegation-1",
    agentName: "researcher",
    modelId: "local-model",
    thinkingLevel: "medium",
    task: "Find where the permission dialog is rendered.",
    report: "Current findings: café and 東京.",
    partial: true,
    turns: 2,
    toolCalls: 3,
    updatedAt: "2026-11-04T12:00:00.000Z",
    context: { retainedTurns: 2 },
    contextCompactions: 1,
    ...overrides,
  };
}

function persist(options: {
  scratchDir?: string;
  delegateSessionId?: string;
  parentToolCallId?: string;
  checkpoint?: SubagentCheckpoint;
}) {
  return persistSubagentCheckpoint({
    scratchDir: options.scratchDir ?? scratchDir,
    delegateSessionId: "delegateSessionId" in options ? options.delegateSessionId : "delegate-1",
    parentToolCallId: options.parentToolCallId ?? "parent-1",
    checkpoint: options.checkpoint ?? checkpoint(),
  });
}

function read(options: {
  scratchDir?: string;
  delegateSessionId?: string;
  parentToolCallId?: string;
  sessionId?: string;
  agentName?: string;
}) {
  return readSubagentCheckpoint({
    scratchDir: options.scratchDir ?? scratchDir,
    delegateSessionId: "delegateSessionId" in options ? options.delegateSessionId : "delegate-1",
    parentToolCallId: options.parentToolCallId ?? "parent-1",
    sessionId: options.sessionId ?? "session-1",
    agentName: options.agentName ?? "researcher",
  });
}

/** A failure code must be a bare code: no paths, no separators, no file text. */
function expectSafeError(code: string | undefined): void {
  expect(typeof code).toBe("string");
  expect(code).not.toMatch(/[\\/]/);
  expect(code).not.toContain(scratchDir);
}

function canCreateDirSymlink(): boolean {
  const target = mkdtempSync(join(tmpdir(), "pi-subagent-link-probe-"));
  const link = `${target}-link`;
  try {
    symlinkSync(target, link, "dir");
    return true;
  } catch {
    try {
      symlinkSync(target, link, "junction");
      return true;
    } catch {
      return false;
    }
  } finally {
    rmSync(link, { force: true, recursive: true });
    rmSync(target, { recursive: true, force: true });
  }
}

function createDirSymlink(target: string, link: string): void {
  try {
    symlinkSync(target, link, "dir");
  } catch {
    symlinkSync(target, link, "junction");
  }
}

const SYMLINK_CAPABLE = canCreateDirSymlink();

describe("persistSubagentCheckpoint", () => {
  it("does not write or throw when scratchDir is missing", () => {
    expect(() => persistSubagentCheckpoint({
      parentToolCallId: "parent-1",
      checkpoint: checkpoint(),
    })).not.toThrow();
    expect(persistSubagentCheckpoint({
      parentToolCallId: "parent-1",
      checkpoint: checkpoint(),
    })).toEqual({});
    expect(readSubagentCheckpoint({
      parentToolCallId: "parent-1",
      sessionId: "session-1",
      agentName: "researcher",
    })).toEqual({});
    expect(existsSync(join(scratchDir, "delegations"))).toBe(false);
  });

  it("keeps an unsafe chain id inside the delegations directory", () => {
    const result = persist({ delegateSessionId: "../../outside\\escape" });

    expect(result.error).toBeUndefined();
    expect(result.checkpointPath).toBeTruthy();
    expect(result.reportPath).toBeTruthy();

    const delegationRoot = resolve(scratchDir, "delegations");
    const outputDirectory = resolve(dirname(result.checkpointPath!));
    expect(relative(delegationRoot, outputDirectory)).not.toMatch(/^\.\.(?:[\\/]|$)/);
    expect(existsSync(join(scratchDir, "outside", "escape"))).toBe(false);
  });

  it("keeps a malformed unicode id inside the delegations directory without throwing", () => {
    let result: ReturnType<typeof persist>;
    expect(() => {
      result = persist({ delegateSessionId: "\uD800no-escape" });
    }).not.toThrow();

    expect(result!.error).toBeUndefined();
    expect(result!.checkpointPath).toBeTruthy();
    const delegationRoot = resolve(scratchDir, "delegations");
    expect(resolve(dirname(result!.checkpointPath!)).startsWith(delegationRoot)).toBe(true);

    const restored = read({ delegateSessionId: "\uD800no-escape" });
    expect(restored.error).toBeUndefined();
    expect(restored.checkpoint?.delegateSessionId).toBe("\uD800no-escape");
  });

  it("writes readable atomic JSON and Markdown results as UTF-8", () => {
    const value = checkpoint({ status: "completed" });
    const result = persist({ checkpoint: value });

    expect(result.error).toBeUndefined();
    expect(existsSync(result.checkpointPath!)).toBe(true);
    expect(existsSync(result.reportPath!)).toBe(true);
    expect(JSON.parse(readFileSync(result.checkpointPath!, "utf8"))).toEqual({
      ...value,
      delegateSessionId: "delegate-1",
    });
    expect(readFileSync(result.reportPath!, "utf8")).toBe(value.report);
    expect(
      readdirSync(dirname(result.checkpointPath!)).some((entry) => entry.endsWith(".tmp")),
    ).toBe(false);
  });

  it("overwrites the previous checkpoint for the same stable chain", () => {
    const first = checkpoint({ report: "old report", turns: 1 });
    const second = checkpoint({ status: "failed", report: "new report", turns: 4 });

    const firstResult = persist({ checkpoint: first });
    const secondResult = persist({ checkpoint: second });

    expect(secondResult.checkpointPath).toBe(firstResult.checkpointPath);
    expect(secondResult.reportPath).toBe(firstResult.reportPath);
    expect(JSON.parse(readFileSync(secondResult.checkpointPath!, "utf8"))).toEqual({
      ...second,
      delegateSessionId: "delegate-1",
    });
    expect(readFileSync(secondResult.reportPath!, "utf8")).toBe(second.report);
  });

  it("returns a safe error instead of throwing when writing fails", () => {
    const blockedScratchDir = join(scratchDir, "not-a-directory");
    writeFileSync(blockedScratchDir, "blocked");

    let result: ReturnType<typeof persist>;
    expect(() => {
      result = persist({ scratchDir: blockedScratchDir });
    }).not.toThrow();

    expectSafeError(result!.error);
    expect(result!.checkpointPath).toBeUndefined();
    expect(result!.reportPath).toBeUndefined();
  });

  it("keeps the previous checkpoint when the report projection fails", () => {
    const first = persist({ checkpoint: checkpoint({ report: "first report" }) });
    expect(first.error).toBeUndefined();

    // Force the next report rename to fail without touching checkpoint.json.
    rmSync(first.reportPath!, { force: true });
    mkdirSync(first.reportPath!);

    const second = persist({ checkpoint: checkpoint({ report: "second report" }) });
    expectSafeError(second.error);
    expect(second.checkpointPath).toBeUndefined();

    const restored = read({});
    expect(restored.error).toBeUndefined();
    expect(restored.checkpoint?.report).toBe("first report");
  });

  it.skipIf(!SYMLINK_CAPABLE)(
    "refuses a delegations directory that links outside the scratch root",
    () => {
      const outside = mkdtempSync(join(tmpdir(), "pi-subagent-outside-"));
      try {
        createDirSymlink(outside, join(scratchDir, "delegations"));

        const write = persist({});
        expectSafeError(write.error);
        expect(write.checkpointPath).toBeUndefined();
        expect(existsSync(join(outside, "delegate-1"))).toBe(false);

        const restored = read({});
        expectSafeError(restored.error);
        expect(restored.checkpoint).toBeUndefined();
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!SYMLINK_CAPABLE)(
    "refuses a chain directory that links outside the delegations root",
    () => {
      const outside = mkdtempSync(join(tmpdir(), "pi-subagent-chain-outside-"));
      try {
        mkdirSync(join(scratchDir, "delegations"), { recursive: true });
        createDirSymlink(outside, join(scratchDir, "delegations", "delegate-1"));

        const write = persist({});
        expectSafeError(write.error);
        expect(write.checkpointPath).toBeUndefined();

        const restored = read({});
        expectSafeError(restored.error);
        expect(restored.checkpoint).toBeUndefined();
        expect(existsSync(join(outside, "checkpoint.json"))).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );
});

describe("readSubagentCheckpoint", () => {
  it("keeps findings readable when old metadata contains retired report controls", () => {
    const runPolicy = { maxToolCalls: 128, maxDurationSeconds: 900, finalReportTimeoutSeconds: 30,
      checkpointInterval: 12, maxCheckpointRequests: 2 };
    persist({ checkpoint: checkpoint({ report: "Earlier findings remain usable.", runPolicy }) });
    const restored = read({});
    expect(restored.error).toBeUndefined();
    expect(restored.checkpoint?.report).toBe("Earlier findings remain usable.");
    expect(restored.checkpoint?.runPolicy).toEqual(runPolicy);
  });

  it("roundtrips a persisted checkpoint for the same identity", () => {
    const value = checkpoint({ status: "completed", partial: false });
    persist({ checkpoint: value });

    const restored = read({});
    expect(restored.error).toBeUndefined();
    expect(restored.checkpoint).toMatchObject({
      version: 1,
      status: "completed",
      sessionId: "session-1",
      delegateSessionId: "delegate-1",
      delegationId: "delegation-1",
      agentName: "researcher",
      modelId: "local-model",
      thinkingLevel: "medium",
      task: value.task,
      report: value.report,
      partial: false,
      turns: 2,
      toolCalls: 3,
    });
    // A persisted context blob is data, never execution history.
    expect(Object.keys(restored.checkpoint!)).not.toContain("context");
  });

  it("resolves the chain id fallback when no delegateSessionId is given", () => {
    persist({ delegateSessionId: undefined, parentToolCallId: "parent-9" });

    const restored = read({ delegateSessionId: undefined, parentToolCallId: "parent-9" });
    expect(restored.error).toBeUndefined();
    expect(restored.checkpoint?.delegateSessionId).toBe("parent-9");
  });

  it("returns an empty result when scratch or the checkpoint is missing", () => {
    expect(read({ scratchDir: undefined })).toEqual({});
    expect(read({ scratchDir: join(scratchDir, "does-not-exist") })).toEqual({});
    expect(read({ parentToolCallId: "never-written" })).toEqual({});
  });

  it("rejects a checkpoint written for a different session, agent, or chain", () => {
    const result = persist({});
    const stored = JSON.parse(readFileSync(result.checkpointPath!, "utf8"));

    const forOtherSession = read({ sessionId: "session-9" });
    expect(forOtherSession.checkpoint).toBeUndefined();
    expectSafeError(forOtherSession.error);

    writeFileSync(
      result.checkpointPath!,
      JSON.stringify({ ...stored, sessionId: "session-1", agentName: "impostor" }),
      "utf8",
    );
    const forOtherAgent = read({});
    expect(forOtherAgent.checkpoint).toBeUndefined();
    expectSafeError(forOtherAgent.error);

    writeFileSync(
      result.checkpointPath!,
      JSON.stringify({ ...stored, agentName: "researcher", delegateSessionId: "delegate-9" }),
      "utf8",
    );
    const forOtherChain = read({});
    expect(forOtherChain.checkpoint).toBeUndefined();
    expectSafeError(forOtherChain.error);
  });

  it("rejects malformed JSON without leaking its content", () => {
    const result = persist({});
    writeFileSync(result.checkpointPath!, "{ not json", "utf8");

    const restored = read({});
    expect(restored.checkpoint).toBeUndefined();
    expectSafeError(restored.error);
    expect(restored.error).not.toContain("not json");
  });

  it("rejects unsupported versions and invalid fields", () => {
    const result = persist({});
    const stored = JSON.parse(readFileSync(result.checkpointPath!, "utf8"));
    const rewrite = (patch: Record<string, unknown>) => {
      writeFileSync(result.checkpointPath!, JSON.stringify({ ...stored, ...patch }), "utf8");
      const restored = read({});
      expect(restored.checkpoint).toBeUndefined();
      expectSafeError(restored.error);
    };

    rewrite({ version: 2 });
    rewrite({ version: 1, status: "exploded" });
    rewrite({ version: 1, status: "completed", turns: -1 });
    rewrite({ version: 1, status: "completed", turns: 1.5 });
    rewrite({ version: 1, status: "completed", turns: 2, report: "  " });
    rewrite({ version: 1, status: "completed", report: "ok", modelId: "" });
    rewrite({ version: 1, status: "completed", report: "ok", modelId: "local-model", thinkingLevel: 7 });
  });

  it("rejects an oversized checkpoint file", () => {
    const chainDir = join(scratchDir, "delegations", "oversized");
    mkdirSync(chainDir, { recursive: true });
    writeFileSync(
      join(chainDir, "checkpoint.json"),
      JSON.stringify({
        version: 1,
        sessionId: "session-1",
        delegateSessionId: "oversized",
        agentName: "researcher",
        modelId: "local-model",
        thinkingLevel: "medium",
        status: "completed",
        report: "x".repeat(2 * 1024 * 1024 + 64),
        turns: 1,
        toolCalls: 1,
        updatedAt: 1,
      }),
      "utf8",
    );

    const restored = read({ delegateSessionId: "oversized" });
    expect(restored.checkpoint).toBeUndefined();
    expectSafeError(restored.error);
  });
});
