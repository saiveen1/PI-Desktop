import { afterEach, expect, it, vi } from "vitest";
import type { DelegationApprovalDecision, DelegationApprovalRequest } from "@pi-desktop/shared";
import { AgentSidecar, type SidecarHostLink } from "./agent-sidecar.js";

const source = `const rl=require('node:readline').createInterface({input:process.stdin});
const pending=new Map();rl.on('line',line=>{const m=JSON.parse(line);
if(m.method==='probe'){pending.set('r'+m.id,m.id);console.log(JSON.stringify({id:'r'+m.id,method:'host.proxy',params:m.params}));}
else if(m.method==='shutdown'){console.log(JSON.stringify({id:m.id,result:{ok:true}}));process.exit(0);}
else if(pending.has(m.id)){console.log(JSON.stringify({...m,id:pending.get(m.id)}));pending.delete(m.id);}});`;
const sidecars: AgentSidecar[] = [];
afterEach(async () => { await Promise.all(sidecars.splice(0).map(sidecar => sidecar.dispose())); });
function fixture() {
  const sidecar = new AgentSidecar({ launch: { command: process.execPath, args: ["-e", source] }, onStderr: () => {} });
  sidecars.push(sidecar);
  const forwarded: string[] = [];
  const host: SidecarHostLink = {
    call: async <T>(method: string) => { forwarded.push(method); return { ok: true } as T; },
    onNotification: () => () => {}, onExit: () => () => {},
  };
  sidecar.setHost(host);
  const rpc = <T = unknown>(method: string, params: Record<string, unknown> = {}) => sidecar.call<T>("probe", { method, params });
  return { sidecar, rpc, forwarded };
}
const request = { sessionId: "s", requestId: "r", providerId: "p", modelId: "m", task: "Review" };
it("uses the real NDJSON transport for additive metadata and exact selected identity", async () => {
  const { sidecar, rpc, forwarded } = fixture();
  const authorize = vi.fn(async (_input: DelegationApprovalRequest): Promise<DelegationApprovalDecision> => ({ decision: "allow", reason: "once", code: "selected",
    selectedModel: { providerId: "p2", modelId: "alternate" } }));
  sidecar.setDelegationAuthorizer(authorize, () => {});
  const full = { ...request, task: "T".repeat(20000), agentName: "reviewer", description: "Review changes", requestedModel: "original selector",
    thinkingLevel: "high", requiresImages: true, minContextWindow: 4096, selection: "prefer", automaticOnly: true, reason: "specialist" };
  await expect(rpc("provider.authorizeDelegation", full)).resolves.toMatchObject({ code: "selected", selectedModel: { providerId: "p2", modelId: "alternate" } });
  expect(authorize).toHaveBeenCalledWith(full); expect(forwarded).toEqual([]);
});
it("fails closed for malformed metadata, unknown methods, and absent callbacks", async () => {
  const { sidecar, rpc, forwarded } = fixture();
  await expect(rpc("provider.authorizeDelegation", request)).resolves.toMatchObject({ decision: "skip", code: "unavailable" });
  const authorize = vi.fn(async (): Promise<DelegationApprovalDecision> => ({ decision: "allow", reason: "policy" }));
  sidecar.setDelegationAuthorizer(authorize, () => {});
  for (const bad of [{ task: 1 }, { selection: "force" }, { automaticOnly: "false" }, { minContextWindow: -1 },
    ...[0, 0.5, 10_000_001, Number.MAX_SAFE_INTEGER + 1, "4096", null].map(minContextWindow => ({ minContextWindow })),
    { thinkingLevel: "unknown" }, { description: {} }, { userApproved: true }, { sessionId: " " }]) {
    await expect(rpc("provider.authorizeDelegation", { ...request, ...bad })).resolves.toMatchObject({ decision: "skip", code: "invalid" });
  }
  expect(authorize).not.toHaveBeenCalled();
  await expect(rpc("provider.delegationSnapshot")).rejects.toMatchObject({ code: -32601 });
  await expect(rpc("provider.unknownPolicy")).rejects.toMatchObject({ code: -32601 });
  expect(forwarded).toEqual([]);
});
it.each([undefined, 1, 10_000_000])("admits an omitted or bounded positive context requirement (%s)", async minContextWindow => {
  const { sidecar, rpc } = fixture();
  const authorize = vi.fn(async (): Promise<DelegationApprovalDecision> => ({ decision: "allow", reason: "policy" }));
  sidecar.setDelegationAuthorizer(authorize, () => {});
  const metadata = { ...request, ...(minContextWindow === undefined ? {} : { minContextWindow }) };
  await expect(rpc("provider.authorizeDelegation", metadata)).resolves.toMatchObject({ decision: "allow" });
  expect(authorize).toHaveBeenCalledWith(metadata);
});
it("snapshot callback stays host-local, preserves adopted empty policy and rejects malformed snapshots", async () => {
  const { sidecar, rpc, forwarded } = fixture();
  sidecar.setDelegationSnapshotResolver(async () => ({ revision: "r1", modelKeys: ["p/m"], settings: {
    version: 1, approvalTimeoutSeconds: 300, models: [{ providerId: "p", modelId: "m", enabled: true, priority: 1, approval: "ask", description: "" }],
  } }));
  await expect(rpc("provider.delegationSnapshot", { sessionId: "s" })).resolves.toMatchObject({ revision: "r1", modelKeys: ["p/m"] });
  sidecar.setDelegationSnapshotResolver(async () => ({ revision: "r2", modelKeys: [], settings: { version: 1, approvalTimeoutSeconds: 30, models: [] } }));
  await expect(rpc("provider.delegationSnapshot")).resolves.toMatchObject({ settings: { models: [] }, modelKeys: [] });
  sidecar.setDelegationSnapshotResolver(async () => ({ revision: "r3", modelKeys: [] }));
  await expect(rpc("provider.delegationSnapshot")).resolves.toEqual({ revision: "r3", modelKeys: [] });
  sidecar.setDelegationSnapshotResolver(async () => ({ revision: "", modelKeys: [] }));
  await expect(rpc("provider.delegationSnapshot")).rejects.toThrow("Invalid delegation policy snapshot");
  expect(forwarded).toEqual([]);
});
it("same-session pending reverse calls remain concurrent; abort cancels exact source requests", async () => {
  const { sidecar, rpc } = fixture();
  const started: string[] = [];
  let ready!: () => void;
  const observed = new Promise<void>(resolve => { ready = resolve; });
  const finishes = new Map<string, (decision: DelegationApprovalDecision) => void>();
  const cancel = vi.fn((input: Pick<DelegationApprovalRequest, "sessionId" | "requestId">) => {
    finishes.get(input.requestId)?.({ decision: "cancel", reason: "stopped", code: "cancelled" });
  });
  sidecar.setDelegationAuthorizer(input => new Promise(resolve => {
    finishes.set(input.requestId, resolve); started.push(input.requestId); if (started.length === 2) ready();
  }), cancel);
  const first = rpc("provider.authorizeDelegation", request);
  const second = rpc("provider.authorizeDelegation", { ...request, requestId: "second" });
  await observed;
  await rpc("provider.cancelDelegationApproval", { sessionId: "s", requestId: "second" });
  await expect(second).resolves.toMatchObject({ code: "cancelled" });
  expect(started).toEqual(["r", "second"]);
  const abort = sidecar.call("agent.abort", { sessionId: "s" });
  await expect(first).resolves.toMatchObject({ code: "cancelled" });
  // Fixture deliberately has no agent.abort implementation; closing retires its call.
  const rejected = expect(abort).rejects.toThrow();
  await sidecar.dispose(); await rejected;
  expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s", requestId: "r" }));
});
