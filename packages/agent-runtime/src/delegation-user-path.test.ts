import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DelegationApprovalDecision, DelegationApprovalRequest, DelegationSettings, UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";

type Payload = { model: string; tools?: Array<{ function: { name: string; description: string } }>; messages: Array<{ role: string; content?: unknown }> };
async function fixture(options: {
  authorize: (request: DelegationApprovalRequest) => Promise<DelegationApprovalDecision>;
  args?: Record<string, unknown>;
  pin?: boolean;
  pinPriority?: number;
}) {
  const requests: Payload[] = [];
  const rows: UiMessage[] = [];
  const errors: unknown[] = [];
  const cancellations: string[] = [];
  let nextTask: Record<string, unknown> | undefined = { agent: "worker", task: "Review the isolated fixture.", ...options.args };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as Payload;
    requests.push(payload);
    const args = payload.model === "parent" ? nextTask : undefined;
    if (args) nextTask = undefined;
    const delta = args ? { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function",
      function: { name: "Task", arguments: JSON.stringify(args) } }] }
      : { role: "assistant", content: payload.model === "parent" ? "Delegation checked." : "Fixture review completed." };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: args ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const provider = (modelId: string): RuntimeProviderConfig => ({
    id: "fixture", name: "Fixture", modelId, baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "fixture", authKind: "api_key_and_base_url", apiStyle: "openai-chat",
    supportsReasoning: false, supportedThinkingLevels: ["off"],
  });
  const settings: DelegationSettings = { version: 1, approvalTimeoutSeconds: 60, models: [
    { providerId: "fixture", modelId: "expensive", enabled: true, priority: options.pinPriority ?? 1, approval: "ask", description: "Independent concurrency review" },
    { providerId: "fixture", modelId: "cheap", enabled: true, priority: 1, approval: "auto", description: "Routine fixture checks" },
  ] };
  const runtime = new DesktopAgentRuntime({
    sessionId: "delegation-fixture", mode: "agent", provider: provider("parent"), thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    subagents: [{ name: "worker", description: "Review an independent change", tools: ["Read"], prompt: "Review the task and report evidence.", source: "user",
      ...(options.pin ? { model: { providerId: "fixture", modelId: "expensive" } } : {}) }],
    subagentProviders: { "fixture/expensive": provider("expensive"), "fixture/cheap": provider("cheap") },
    subagentModelKeys: ["fixture/expensive", "fixture/cheap"],
    delegationSettings: settings, delegationAuthorization: true,
    host: { call: async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "provider.authorizeDelegation") return await options.authorize(params as DelegationApprovalRequest) as T;
      if (method === "provider.cancelDelegationApproval") { cancellations.push((params as { requestId: string }).requestId); return undefined as T; }
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
      if (method === "session.appendMessage") return undefined as T;
      throw new Error(`Unexpected host method ${method}`);
    } },
    onEvent: ({ event }) => {
      if (event.type === "error") errors.push(event.error);
      if (event.type === "tool_start") rows.push({ id: event.toolCallId, role: "tool", content: "",
        toolCallId: event.toolCallId, toolName: event.toolName, toolArgs: event.args, createdAt: new Date().toISOString() });
      if (event.type === "tool_end") {
        const row = rows.find((entry) => entry.id === event.toolCallId);
        if (row) { row.toolResult = event.result; row.isError = event.isError; }
      }
      if (event.type === "message_end") {
        const index = rows.findIndex((row) => row.id === event.message.id);
        if (index === -1) rows.push(event.message); else rows[index] = event.message;
      }
    },
  });
  return { runtime, requests, rows, errors, cancellations,
    queueTask: (args: Record<string, unknown>) => { nextTask = { agent: "worker", task: "Continue the fixture review.", ...args }; },
    prompt: () => runtime.prompt("Delegate this fixture review.", randomUUID(), randomUUID()),
    close: async () => {
      await runtime.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

const allow = async (): Promise<DelegationApprovalDecision> => ({ decision: "allow", reason: "Approved once" });
describe("delegation user path through real parent and child transports", () => {
  it.each([undefined, "fixture/expensive"])("preserves a lower-tier role pin when model is %s", async (model) => {
    const f = await fixture({ pin: true, pinPriority: 2, authorize: allow, args: model ? { model } : {} });
    try {
      await f.prompt();
      expect(f.errors).toEqual([]);
      expect(f.requests.filter((row) => row.model !== "parent").map((row) => row.model)).toEqual(["expensive"]);
    } finally { await f.close(); }
  });

  it("stops during approval and never starts a child after a late approval", async () => {
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    let release!: (decision: DelegationApprovalDecision) => void;
    const approval = new Promise<DelegationApprovalDecision>((resolve) => { release = resolve; });
    const f = await fixture({ authorize: async () => { entered(); return approval; } });
    try {
      const pending = f.prompt();
      await waiting;
      f.runtime.abort();
      release(await allow());
      await pending;
      expect(f.requests.every((request) => request.model === "parent")).toBe(true);
      expect(f.cancellations).toHaveLength(1);
    } finally { release(await allow()); await f.close(); }
  });

  it.each([false, true])("holds the model request until approval and keeps descriptions in Task (pin=%s)", async (pin) => {
    let entered!: () => void;
    const pendingApproval = new Promise<void>((resolve) => { entered = resolve; });
    let release!: (decision: DelegationApprovalDecision) => void;
    const approval = new Promise<DelegationApprovalDecision>((resolve) => { release = resolve; });
    const f = await fixture({ pin, authorize: async () => { entered(); return approval; } });
    try {
      const pending = f.prompt();
      await pendingApproval;
      expect(f.requests.map((row) => row.model)).toEqual(["parent"]);
      release(await allow());
      await pending;
      expect(f.errors).toEqual([]);
      expect(f.requests.some((row) => row.model === "expensive")).toBe(true);
      for (const request of f.requests.filter((row) => row.model === "parent")) {
        const task = request.tools?.find((tool) => tool.function.name === "Task");
        expect(task?.function.description).toContain("Independent concurrency review");
        expect(task?.function.description).toContain("Review an independent change");
      }
    } finally { release(await allow()); await f.close(); }
  });

  it("uses a permitted alternative without asking the parent to redelegate", async () => {
    const f = await fixture({ authorize: async (request) => request.modelId === "expensive"
      ? { decision: "skip", reason: "Approval expired" } : allow() });
    try {
      await f.prompt();
      expect(f.errors).toEqual([]);
      expect(f.requests.filter((row) => row.model !== "parent").map((row) => row.model)).toEqual(["cheap"]);
      const taskRow = f.rows.find((row) => row.toolName === "Task");
      expect(JSON.stringify(taskRow)).toContain("Approval expired");
      expect(JSON.stringify(taskRow)).toContain("cheap");
    } finally { await f.close(); }
  });

  it.each(["cancel", "require"])("does not start an alternative on %s", async (mode) => {
    const f = await fixture({ args: { model: "fixture/expensive", ...(mode === "require" ? { modelSelection: "require" } : {}) },
      authorize: async () => ({ decision: mode === "cancel" ? "cancel" : "skip", reason: "User decision" }) });
    try {
      await f.prompt();
      expect(f.requests.every((row) => row.model === "parent")).toBe(true);
      const result = f.rows.find((row) => row.toolName === "Task")?.toolResult as { details?: { error?: string } } | undefined;
      expect(result?.details?.error).toContain(mode === "cancel" ? "cancelled by the user" : "No authorized");
    } finally { await f.close(); }
  });

  it("requires fresh authorization when continuing the same delegate", async () => {
    const approvals: string[] = [];
    const f = await fixture({ authorize: async (request) => { approvals.push(request.requestId); return allow(); } });
    try {
      await f.prompt();
      const row = f.rows.find((entry) => entry.toolName === "Task");
      const result = row?.toolResult as { details?: { delegationId?: string } } | undefined;
      expect(result?.details?.delegationId).toBeTruthy();
      f.queueTask({ resume: result!.details!.delegationId });
      await f.prompt();
      expect(approvals).toHaveLength(2);
      expect(new Set(approvals).size).toBe(2);
      expect(f.requests.filter((entry) => entry.model === "expensive")).toHaveLength(2);
    } finally { await f.close(); }
  });
});
