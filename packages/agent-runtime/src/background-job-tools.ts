/** Model job controls route to their existing owner; only Bash crosses Host RPC. */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TObject } from "typebox";
import { Type } from "typebox";
import {
  BACKGROUND_JOBS_VERSION,
  type BackgroundJobSnapshot,
  type BackgroundJobSummary,
  type JobReference,
} from "@pi-desktop/shared";
import type { RuntimeHost } from "./host-client.js";

const jobSchema = Type.Object({
  kind: Type.Union([Type.Literal("bash"), Type.Literal("delegation")]),
  id: Type.String({ minLength: 1 }),
}, { additionalProperties: false, description: "One explicit job returned by Bash, Task or TaskList. A Bash job selects its target; delegationIds, mode and minCompleted are ignored. For a delegation, omit delegationIds or use exactly [id]." });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function target(params: unknown): JobReference | undefined {
  if (!record(params) || params.job === undefined) return undefined;
  const job = params.job;
  if (!record(job) || (job.kind !== "bash" && job.kind !== "delegation") ||
      typeof job.id !== "string" || !job.id.trim() || Object.keys(job).some(key => key !== "id" && key !== "kind")) {
    throw new Error("job must contain a kind (bash or delegation) and a nonempty id");
  }
  const retry = `Retry with ${JSON.stringify({ job })} and omit the conflicting delegation selectors.`;
  if (job.kind === "delegation" && params.delegationIds !== undefined && (!Array.isArray(params.delegationIds) ||
      params.delegationIds.length !== 1 || params.delegationIds[0] !== job.id)) {
    throw new Error(`job and delegationIds must identify the same single delegation. ${retry}`);
  }
  return { kind: job.kind, id: job.id };
}

/** Drop inapplicable selectors before pi validates their delegation-only types. */
function prepareJobArguments(input: unknown): unknown {
  if (!record(input) || !record(input.job) || input.job.kind !== "bash") return input;
  const params = { ...input };
  delete params.delegationIds;
  delete params.mode;
  delete params.minCompleted;
  return params;
}

/** Observe late rejections and release the listener on either completion path. */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("Job wait aborted"), { errorCode: "TOOL_ABORTED" }));
    signal?.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
    if (signal?.aborted) {
      signal.removeEventListener("abort", abort);
      abort();
    }
  });
}

type Result = AgentToolResult<unknown>;
type Options = {
  host: RuntimeHost;
  sessionId: string;
  remote: boolean;
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  /** The runtime also interrupts this wait when new steering input arrives. */
  wait: (run: (signal: AbortSignal) => Promise<Result>, signal?: AbortSignal) => Promise<Result>;
};

function observation(snapshot: BackgroundJobSnapshot, status: string): Result {
  return {
    content: [{ type: "text", text: JSON.stringify({ status, ...snapshot }) }],
    details: { status, job: snapshot },
  };
}

export function buildJobTools(
  delegates: { wait: AgentTool; list: AgentTool; stop: AgentTool },
  options: Options,
): AgentTool[] {
  let capability: Promise<boolean> | undefined;
  const supported = () => capability ??= (async () => {
    if (options.remote) return false;
    try {
      const response = await options.host.call("backgroundJobs.capabilities", { sessionId: options.sessionId });
      return record(response) && response.version === BACKGROUND_JOBS_VERSION && response.supported === true;
    } catch (error) {
      if (record(error) && (error.code === -32601 || error.errorCode === "METHOD_NOT_FOUND" ||
          (record(error.rpc) && error.rpc.code === -32601))) return false;
      capability = undefined;
      throw error;
    }
  })();

  const requireSupported = async () => {
    if (!await supported()) throw new Error("This Host/workspace does not support background Bash job controls.");
  };
  const call = <T>(method: string, params: Record<string, unknown> = {}) =>
    options.host.call<T>(method, { ...params, sessionId: options.sessionId });

  const wait: AgentTool = {
    ...delegates.wait,
    description: `${delegates.wait.description}\nFor a background Bash command, pass its job reference ({kind: "bash", id: backgroundTaskId}); it selects the target, and delegationIds, mode and minCompleted are ignored. timeoutSeconds still applies. Returns state, exitCode and bounded stdout/stderr tails. Timeout or interrupted waiting leaves the process running. Bash completion is not automatically delivered; call TaskWait again when needed. For a delegation job, mode and minCompleted still apply; if delegationIds is also supplied, it must name the same single delegation (exactly [job.id]). Conflicting delegation selectors are rejected before waiting. Omit job to keep the existing subagent defaults.`,
    parameters: Type.Object({ ...(delegates.wait.parameters as TObject).properties, job: Type.Optional(jobSchema) }),
    prepareArguments: prepareJobArguments,
    execute: async (id, input, signal, update) => {
      const params = record(input) ? input : {};
      const job = target(params);
      if (!job) return delegates.wait.execute(id, params, signal, update);
      if (job.kind === "delegation") {
        return delegates.wait.execute(id, { ...params, job: undefined, delegationIds: [job.id] }, signal, update);
      }
      const seconds = params.timeoutSeconds ?? options.defaultTimeoutSeconds;
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 1 || seconds > options.maxTimeoutSeconds) {
        throw new Error(`timeoutSeconds must be between 1 and ${options.maxTimeoutSeconds}`);
      }
      return options.wait(async waitSignal => {
        if (waitSignal.aborted) throw Object.assign(new Error("Job wait aborted"), { errorCode: "TOOL_ABORTED" });
        const budgetMs = Math.ceil(seconds * 1000);
        const deadline = performance.now() + budgetMs;
        const timerAbort = new AbortController();
        const signal = AbortSignal.any([waitSignal, timerAbort.signal]);
        const timer = setTimeout(() => timerAbort.abort(), budgetMs);
        let snapshot: BackgroundJobSnapshot | undefined;
        try {
          await abortable(requireSupported(), signal);
          while (!signal.aborted && performance.now() < deadline) {
            // Read once immediately so a deadline during a later long poll
            // can return the last observed state.
            const timeoutMs = snapshot ? Math.min(1000, Math.ceil(deadline - performance.now())) : 0;
            snapshot = await abortable(call<BackgroundJobSnapshot>("backgroundJobs.wait", {
              id: job.id, timeoutMs: Math.max(0, timeoutMs),
            }), signal);
            if (snapshot.state !== "running") return observation(snapshot, "completed");
          }
        } catch (error) {
          if (!timerAbort.signal.aborted || waitSignal.aborted ||
              !record(error) || error.errorCode !== "TOOL_ABORTED") throw error;
        } finally {
          clearTimeout(timer);
        }
        if (snapshot) return observation(snapshot, "timeout");
        const result = { status: "timeout", job, snapshotAvailable: false };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      }, signal);
    },
  };
  const list: AgentTool = {
    ...delegates.list,
    description: `${delegates.list.description}\nAlso lists this session's retained background Bash jobs when supported. Use the returned job reference with TaskWait or TaskStop. Finished Bash history is bounded and expires when the Host restarts.`,
    execute: async (...args) => {
      const result = await delegates.list.execute(...args);
      const available = await supported();
      const tasks = available ? (await call<{ tasks: BackgroundJobSummary[] }>("backgroundJobs.list")).tasks : [];
      const details = record(result.details) ? result.details : {};
      return {
        ...result,
        content: [...result.content, { type: "text", text: available
          ? `Background Bash jobs: ${JSON.stringify(tasks)}`
          : "Background Bash job controls are unavailable on this Host/workspace." }],
        details: { ...details, backgroundJobs: { supported: available, tasks } },
      };
    },
  };
  const stop: AgentTool = {
    ...delegates.stop,
    description: `${delegates.stop.description}\nPass job to stop one explicit Bash or delegation job. If delegationIds is also supplied with a delegation job, it must name the same single delegation (exactly [job.id]). A Bash job selects the target and ignores delegationIds. Conflicting delegation selectors are rejected before stopping anything. Omitting job never stops Bash processes. A Bash stopRequested flag acknowledges a stop request only; the returned snapshot determines whether the process has actually terminated.`,
    parameters: Type.Object({ ...(delegates.stop.parameters as TObject).properties, job: Type.Optional(jobSchema) }),
    prepareArguments: prepareJobArguments,
    execute: async (id, input, signal, update) => {
      const params = record(input) ? input : {};
      const job = target(params);
      if (!job) return delegates.stop.execute(id, params, signal, update);
      if (job.kind === "delegation") {
        return delegates.stop.execute(id, { delegationIds: [job.id] }, signal, update);
      }
      if (signal?.aborted) throw Object.assign(new Error("Job stop aborted before dispatch"), { errorCode: "TOOL_ABORTED" });
      await abortable(requireSupported(), signal);
      if (signal?.aborted) throw Object.assign(new Error("Job stop aborted before dispatch"), { errorCode: "TOOL_ABORTED" });
      const snapshot = await abortable(call<BackgroundJobSnapshot>("backgroundJobs.stop", { id: job.id, timeoutMs: 1000 }), signal);
      return observation(snapshot, snapshot.state === "running" ? "stopPending" : "completed");
    },
  };
  return [wait, list, stop];
}
