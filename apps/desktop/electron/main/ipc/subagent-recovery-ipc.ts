import {
  IPC, ErrorCodes, isAgentSendSubagentMessageRequest,
  type AgentEventEnvelope, type AgentRetrySubagentRequest, type AgentRetrySubagentResponse,
  type AgentSendSubagentMessageResponse,
} from "@pi-desktop/shared";
import type { AgentIpcDependencies } from "./agent-ipc";

type Dependencies = Pick<AgentIpcDependencies, "getHost" | "getSidecar" | "activeTurns" |
  "acquireSessionOperation" | "resolveAgentRuntimeLaunch" | "recordTurnStart" |
  "activeTurnUsages" | "finishTurn"> & {
    handle: (channel: string, handler: (request: unknown) => Promise<unknown>) => void;
  };

/** Child recovery and direct input share one owner, startup fence and Stop path. */
export function registerSubagentRecoveryIpc(deps: Dependencies): void {
  for (const operation of ["retry", "message"] as const) {
    const channel = operation === "retry" ? IPC.invoke.agentRetrySubagent : IPC.invoke.agentSendSubagentMessage;
    const method = operation === "retry" ? "agent.retrySubagent" : "agent.sendSubagentMessage";
    deps.handle(channel, async (input) => {
      if (operation === "message" && !isAgentSendSubagentMessageRequest(input)) {
        throw Object.assign(new Error("Invalid subagent message request"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
      }
      const req = input as AgentRetrySubagentRequest;
      if (!req || typeof req.sessionId !== "string" || !req.sessionId.trim() ||
          typeof req.delegationId !== "string" || !req.delegationId.trim()) {
        throw Object.assign(new Error("Invalid subagent recovery request"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
      }
      if (req.sessionId.startsWith("native-pi:")) {
        throw Object.assign(new Error("Operation is unsupported for native Pi sessions"), { errorCode: "NATIVE_PI_UNSUPPORTED" });
      }
      if (req.sessionId.startsWith("remote:")) {
        throw Object.assign(new Error("Direct subagent controls are unavailable for remote sessions"), { errorCode: "CAPABILITY_UNAVAILABLE" });
      }
      const host = deps.getHost(), sidecar = deps.getSidecar();
      if (!host || !sidecar) throw new Error("backend unavailable");
      const payload = operation === "message" && isAgentSendSubagentMessageRequest(input)
        ? { sessionId: req.sessionId, delegationId: req.delegationId.trim(), messageId: input.messageId.trim(), content: input.content.trim() }
        : { sessionId: req.sessionId, delegationId: req.delegationId.trim() };
      let release: (() => void) | undefined = await deps.acquireSessionOperation(req.sessionId);
      const releaseStartup = () => { const current = release; release = undefined; current?.(); };
      let unsubscribe: (() => void) | undefined;
      try {
        const active = deps.activeTurns.get(req.sessionId);
        if (active) {
          const admission = sidecar.call<AgentRetrySubagentResponse | AgentSendSubagentMessageResponse>(method, { ...payload, turnId: active });
          releaseStartup();
          return await admission;
        }
        const settings = await host.call("settings.get");
        const detail = await host.call<{ session?: unknown }>("session.get", { id: req.sessionId });
        if (!detail.session) throw Object.assign(new Error("Session not found"), { errorCode: ErrorCodes.NOT_FOUND });
        const launch = await deps.resolveAgentRuntimeLaunch(req.sessionId, detail.session, settings);
        sidecar.setProjectInstructionRoot(req.sessionId, launch.workspaceRoot ?? launch.projectPath);
        const turn = await host.call<{ turnId?: string }>("session.beginTurn", {
          sessionId: req.sessionId, providerId: launch.providerId, modelId: launch.modelId,
        });
        const turnId = String(turn?.turnId ?? "").trim();
        if (!turnId) throw new Error("session.beginTurn returned no turn");
        deps.activeTurns.set(req.sessionId, turnId);
        deps.recordTurnStart(req.sessionId, turnId);
        deps.activeTurnUsages.delete(req.sessionId);
        // A child event must never release a still-initializing parent owner.
        unsubscribe = sidecar.onNotification((eventMethod, params) => {
          if (eventMethod !== "agent.event" || !params || typeof params !== "object") return;
          const envelope = params as Partial<AgentEventEnvelope>;
          if (envelope.sessionId !== req.sessionId || envelope.turnId !== turnId || envelope.parentToolCallId ||
              envelope.event?.type !== "agent_start") return;
          releaseStartup();
          unsubscribe?.();
          unsubscribe = undefined;
        });
        try {
          return await sidecar.call<AgentRetrySubagentResponse | AgentSendSubagentMessageResponse>(method, {
            ...launch.sidecarParams, ...payload, turnId,
          });
        } catch (error) {
          await deps.finishTurn(req.sessionId, "error", (error as { errorCode?: string })?.errorCode, { turnId });
          throw error;
        }
      } finally {
        unsubscribe?.();
        releaseStartup();
      }
    });
  }
}
