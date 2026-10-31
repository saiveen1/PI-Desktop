import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSidecar } from "./agent-sidecar.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const children: EventEmitter[] = [];
afterEach(() => { for (const child of children.splice(0)) child.emit("exit", 0, null); });

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  children.push(child);
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
  const sidecar = new AgentSidecar({ launch: { command: "fixture", args: [] }, onStderr() {} });
  let nextId = 0;
  function rpc(method: string, params: Record<string, unknown>) {
    const id = ++nextId;
    const response = new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
      const read = (chunk: Buffer) => {
        const value = JSON.parse(String(chunk));
        if (value.id !== id) return;
        child.stdin.off("data", read);
        resolve(value);
      };
      child.stdin.on("data", read);
    });
    child.stdout.write(JSON.stringify({ id, method: "host.proxy", params: { method, params } }) + "\n");
    return response;
  }
  return { child, sidecar, rpc };
}
const request = { sessionId: "s", requestId: "r", providerId: "p", modelId: "m", task: "Review" };

it("fails closed when no delegation callback exists and rejects malformed requests", async () => {
  const { sidecar, rpc } = fixture();
  expect((await rpc("provider.authorizeDelegation", request)).result).toMatchObject({ decision: "skip" });
  const authorize = vi.fn(async () => ({ decision: "allow" as const, reason: "policy" }));
  sidecar.setDelegationAuthorizer(authorize, () => {});
  expect((await rpc("provider.authorizeDelegation", { ...request, task: 1 })).result).toMatchObject({ decision: "skip" });
  expect(authorize).not.toHaveBeenCalled();
  expect((await rpc("provider.authorizeDelegation", request)).result).toMatchObject({ decision: "allow" });
  expect(authorize).toHaveBeenCalledWith(request);
});

it("routes exact cancellation and transport cleanup for outstanding approvals", async () => {
  const { child, sidecar, rpc } = fixture();
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => { started = resolve; });
  let finish!: (value: { decision: "cancel"; reason: string }) => void;
  const cancel = vi.fn();
  sidecar.setDelegationAuthorizer(() => {
    started();
    return new Promise((resolve) => { finish = resolve; });
  }, cancel);
  const pending = rpc("provider.authorizeDelegation", request);
  await dispatched;
  await rpc("provider.cancelDelegationApproval", { sessionId: "other", requestId: "r" });
  expect(cancel).toHaveBeenLastCalledWith({ sessionId: "other", requestId: "r" });
  await rpc("provider.cancelDelegationApproval", { sessionId: "s", requestId: "r" });
  expect(cancel).toHaveBeenLastCalledWith({ sessionId: "s", requestId: "r" });
  finish({ decision: "cancel", reason: "test" });
  expect((await pending).result).toMatchObject({ decision: "cancel" });
  const next = rpc("provider.authorizeDelegation", { ...request, requestId: "next" });
  await Promise.resolve();
  child.emit("exit", 0, null);
  expect(cancel).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "s", requestId: "next" }));
  finish({ decision: "cancel", reason: "closed" });
  void next;
});
