import { randomUUID } from "node:crypto";
import type {
  AgentStatus,
  AppSettings,
  SessionCollaborationDelivery,
  SessionCollaborationMessage,
  SessionCollaborationSummary,
} from "@pi-desktop/shared";
import { isDelegationSettings, orderDelegationModels, delegationModelKey, type DelegationApprovalRequest, type DelegationApprovalDecision } from "@pi-desktop/shared";
import { DESKTOP_PRINCIPAL, type AgentHostBridge } from "../agent-host-bridge";
import { listReadyPluginModels, parsePluginModelKey } from "../plugin-agent-complete";
import type { McpControlInvokeInput } from "../mcp-control";

type Host = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };
type Sidecar = { call<T>(method: string, params: Record<string, unknown>): Promise<T> };

/** Shared by the plugin and the sidebar: durable outcomes plus live activity. */
export async function readSessionCollaboration(
  host: Host,
  sidecar: Sidecar | null,
  sessionId: string,
): Promise<SessionCollaborationSummary> {
  const [summary, live] = await Promise.all([
    host.call<SessionCollaborationSummary>("session.collaboration.status", { sessionId }),
    sidecar?.call<{ status: AgentStatus }>("agent.getStatus", { sessionId }),
  ]);
  if (live?.status.sessionId === sessionId && live.status.isRunning) {
    return {
      ...summary,
      status: live.status.pendingToolConfirmations > 0 ? "waiting_permission" : "running",
      observedAt: new Date().toISOString(),
    };
  }
  return summary;
}

export type SessionCollaborationDependencies = {
  getHost: () => Host | null;
  getSidecar: () => Sidecar | null;
  getBridge: () => AgentHostBridge | null;
  getActiveTurn: (sessionId: string) => string | undefined;
  flushTranscript: () => Promise<boolean>;
  isPluginLoaded: (pluginId: string) => boolean;
  isQuitting: () => boolean;
  onChanged: () => void;
  log: (message: string, data: Record<string, unknown>) => void;
  authorizeDelegation?: (request: DelegationApprovalRequest) => Promise<DelegationApprovalDecision>;
  cancelDelegationApproval?: (request: Pick<DelegationApprovalRequest, "sessionId" | "requestId">) => void;
};

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code, errorCode: code });
}

function text(input: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = input[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim()) fail("INVALID_ARGUMENT", `${key} must be a nonempty string`);
  return value.trim();
}

function messageKind(value: unknown): "task" | "message" {
  if (value === undefined) return "message";
  if (value !== "task" && value !== "message") fail("INVALID_ARGUMENT", "kind must be task or message");
  return value;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { code?: string; errorCode?: string; data?: { errorCode?: string } };
  return value.data?.errorCode ?? value.errorCode ?? value.code;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error) ?? String(error); } catch { return String(error); }
}

function delivery(message: SessionCollaborationMessage): SessionCollaborationDelivery {
  return {
    sessionId: message.targetSessionId,
    messageId: message.id,
    status: message.status,
    ...(message.turnId ? { turnId: message.turnId } : {}),
  };
}

/** Coordinates reviewed operations; Rust owns all identity and outcome state. */
export function createSessionCollaborationService(deps: SessionCollaborationDependencies) {
  const dispatching = new Map<string, Promise<SessionCollaborationDelivery>>();
  // Turn IDs awaiting settlement. The host keys the receipt by the turn row in
  // its own database, so an entry orphaned by a host restart is replayed there.
  const settlements = new Set<string>();
  let draining: Promise<void> | undefined;
  let dirty = false;

  const spawnApprovals = new Map<string, { providerId: string; modelId: string; policy: string; task: string }>();
  const dispatchApprovals = new Map<string, DelegationApprovalRequest>();
  const dispatchSignals = new Map<string, AbortSignal>();

  async function authorize(request: DelegationApprovalRequest, signal?: AbortSignal) {
    if (!deps.authorizeDelegation) fail("PERMISSION_DENIED", "Delegation approval unavailable");
    const abort = () => deps.cancelDelegationApproval?.(request);
    if (signal?.aborted) fail("ABORTED", "Delegation cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await deps.authorizeDelegation(request);
      if (signal?.aborted || result.decision === "cancel") fail("ABORTED", "Delegation cancelled");
      return result.decision === "allow";
    } finally { signal?.removeEventListener("abort", abort); }
  }

  async function authorizeDispatch(sessionId: string, messageId: string, content: string): Promise<void> {
    const host = requireHost();
    const settings = await host.call<AppSettings>("settings.get");
    checkCurrent(host);
    if (settings?.delegation === undefined) return;
    if (!isDelegationSettings(settings.delegation)) fail("PERMISSION_DENIED", "Invalid delegation policy");
    const result = await host.call<{ session?: { providerId?: string; modelId?: string } }>("session.get", { id: sessionId });
    checkCurrent(host);
    const target = result.session;
    if (!target?.providerId || !target.modelId) fail("MODEL_NOT_CONFIGURED", "Target session has no configured model");
    const approved = spawnApprovals.get(messageId);
    spawnApprovals.delete(messageId);
    const listed = await host.call<{ providers: Parameters<typeof listReadyPluginModels>[0] }>("providers.list", { includeDisabled: false });
    checkCurrent(host);
    const enabled = listReadyPluginModels(listed.providers, settings).some((model) =>
      model.providerId === target.providerId && model.modelId === target.modelId && model.availableForSubagents);
    if (!enabled) fail("PERMISSION_DENIED", "Target model is not enabled for delegation");
    if (!(approved?.providerId === target.providerId && approved.modelId === target.modelId && approved.task === content
      && approved.policy === JSON.stringify(settings.delegation))) {
      const request = { sessionId, requestId: `session-message:${messageId}:${randomUUID()}`,
        providerId: target.providerId, modelId: target.modelId, task: content };
      dispatchApprovals.set(messageId, request);
      try {
        if (!await authorize(request, dispatchSignals.get(messageId))) fail("PERMISSION_DENIED", "Target model delegation was skipped");
      } finally { if (dispatchApprovals.get(messageId) === request) dispatchApprovals.delete(messageId); }
    }
    const latest = await host.call<{ session?: { providerId?: string; modelId?: string } }>("session.get", { id: sessionId });
    checkCurrent(host);
    if (latest.session?.providerId !== target.providerId || latest.session?.modelId !== target.modelId) {
      fail("PERMISSION_DENIED", "Target model changed while awaiting delegation approval");
    }
    const [latestSettings, latestProviders, message] = await Promise.all([
      host.call<AppSettings>("settings.get"),
      host.call<{ providers: Parameters<typeof listReadyPluginModels>[0] }>("providers.list", { includeDisabled: false }),
      host.call<{ message?: SessionCollaborationMessage }>("session.collaboration.message", { messageId }),
    ]);
    checkCurrent(host);
    if (JSON.stringify(latestSettings.delegation) !== JSON.stringify(settings.delegation)
      || !listReadyPluginModels(latestProviders.providers, latestSettings).some((model) =>
        model.providerId === target.providerId && model.modelId === target.modelId && model.availableForSubagents)) {
      fail("PERMISSION_DENIED", "Delegation policy or provider changed before dispatch");
    }
    if (!message.message || message.message.status !== "queued" || message.message.targetSessionId !== sessionId || message.message.content !== content
      || !deps.isPluginLoaded(message.message.pluginId)) fail("ABORTED", "Session delivery was cancelled before dispatch");
  }
  function requireHost(): Host {
    if (deps.isQuitting()) fail("ABORTED", "The application is shutting down");
    const host = deps.getHost();
    if (!host) fail("HOST_UNAVAILABLE", "The host is unavailable");
    return host;
  }

  function checkCurrent(host: Host, signal?: AbortSignal): void {
    if (signal?.aborted || deps.isQuitting()) fail("ABORTED", "The session operation was cancelled");
    if (deps.getHost() !== host) fail("HOST_UNAVAILABLE", "The host restarted during the session operation");
  }

  function sender(input: McpControlInvokeInput): { pluginId: string; sourceSessionId: string; sourceTurnId: string } {
    const context = input.pluginContext;
    if (!context?.sessionId || !context.turnId || !context.invocationId
      || deps.getActiveTurn(context.sessionId) !== context.turnId) {
      fail("PERMISSION_DENIED", "Sending requires an active, host-authenticated Agent tool invocation");
    }
    return { pluginId: context.pluginId, sourceSessionId: context.sessionId, sourceTurnId: context.turnId };
  }

  async function dispatch(message: SessionCollaborationMessage, signal?: AbortSignal): Promise<SessionCollaborationDelivery> {
    const existing = dispatching.get(message.id);
    if (existing) return existing;
    const operation = (async () => {
      const host = requireHost();
      try {
        checkCurrent(host, signal);
        const current = (await host.call<{ message?: SessionCollaborationMessage }>(
          "session.collaboration.message", { messageId: message.id },
        )).message;
        checkCurrent(host, signal);
        if (!current) fail("NOT_FOUND", "Session message not found");
        if (current.status !== "queued") return delivery(current);
        const bridge = deps.getBridge();
        if (!bridge || !deps.getSidecar()) fail("HOST_UNAVAILABLE", "The Agent runtime is unavailable");
        if (bridge.queue.list(current.targetSessionId).some((entry) => entry.sessionMessageId === current.id)) {
          return delivery(current);
        }
        if (!deps.isPluginLoaded(current.pluginId)) fail("ABORTED", "The sending plugin is no longer enabled");
        // The Agent Host callback rechecks delegation at execution, including durable queue replay.
        if (signal) dispatchSignals.set(current.id, signal);
        await bridge.agentHost.startTurn(DESKTOP_PRINCIPAL, {
          sessionId: current.targetSessionId,
          input: { text: current.content, sessionMessageId: current.id },
          admission: "queue",
          idempotencyKey: `session-message:${current.id}`,
          context: { requestId: `session-message:${current.id}` },
        });
        checkCurrent(host);
        const accepted = (await host.call<{ message: SessionCollaborationMessage }>(
          "session.collaboration.message", { messageId: current.id },
        )).message;
        if (signal?.aborted) await cancel(host, { sessionId: current.targetSessionId, messageId: current.id });
        deps.onChanged();
        return delivery(accepted);
      } catch (error) {
        // A full callback inbox is deferred until a later queue/turn change.
        // It must not turn a successfully completed original task into failure.
        if (deps.getHost() === host && !(message.kind === "completion" && errorCode(error) === "AGENT_BUSY")) {
          // The host persists free text, so the code is embedded to keep the
          // stored failure machine-readable and bounded.
          const persisted = `${errorCode(error) ?? "FAILED"}: ${errorMessage(error)}`;
          await host.call("session.collaboration.fail", {
            messageId: message.id,
            error: persisted.slice(0, 2000),
          }).catch((persistenceError: unknown) => deps.log("Session delivery failure could not be saved", {
            messageId: message.id, error: String(persistenceError),
          }));
        }
        throw error;
      } finally { dispatchSignals.delete(message.id); }
    })();
    dispatching.set(message.id, operation);
    try { return await operation; }
    finally { if (dispatching.get(message.id) === operation) dispatching.delete(message.id); }
  }

  async function cancel(host: Host, args: Record<string, unknown>) {
    const result = await host.call<{
      sessionId: string; cancelled: true; sessionRetained: true; messageIds: string[]; runningTurnIds: string[];
    }>("session.collaboration.cancel", args);
    for (const messageId of result.messageIds) {
      const request = dispatchApprovals.get(messageId);
      if (request) deps.cancelDelegationApproval?.(request);
      spawnApprovals.delete(messageId);
    }
    checkCurrent(host);
    const bridge = deps.getBridge();
    if (bridge) {
      for (const messageId of result.messageIds) await bridge.queue.cancelSessionMessage(result.sessionId, messageId);
      for (const turnId of result.runningTurnIds) {
        // The exact turn guard prevents a late cancellation from stopping a
        // newer task in this reusable session.
        if (deps.getActiveTurn(result.sessionId) === turnId) {
          await bridge.interruptSessionMessage(result.sessionId, turnId);
        }
      }
    }
    deps.onChanged();
    return { sessionId: result.sessionId, cancelled: true, sessionRetained: true };
  }

  async function drain(): Promise<void> {
    // Re-entrant, self-healing: a caller arriving while a pass is running flags
    // dirty and awaits it, then re-checks. This also closes the narrow window
    // where a settlement is queued right as a running pass decides to stop, so a
    // completion callback is never deferred to an unrelated later trigger.
    for (;;) {
      if (draining) {
        dirty = true;
        await draining;
        if (!dirty) return;
        continue;
      }
      if (!deps.getHost() || deps.isQuitting()) return;
      draining = (async () => {
        do {
          // Cleared first so a throwing pass cannot keep re-running the loop.
          dirty = false;
          const host = requireHost();
          if (settlements.size && await deps.flushTranscript()) {
            checkCurrent(host);
            for (const turnId of settlements) {
              // Settling is idempotent host-side, so entries recorded against a
              // previous host are replayed rather than dropped. A failing call
              // keeps its entry for a later drain.
              await host.call("session.collaboration.settle", { turnId });
              settlements.delete(turnId);
            }
          }
          const pending = await host.call<{ messages: SessionCollaborationMessage[] }>("session.collaboration.pending", {});
          checkCurrent(host);
          await Promise.all(pending.messages.map(async (message) => {
            try { await dispatch(message); }
            catch (error) {
              deps.log("Session completion delivery is pending or failed", { messageId: message.id, error: String(error) });
            }
          }));
        } while (dirty);
      })();
      try { await draining; }
      finally { draining = undefined; }
      if (dirty) continue;
      return;
    }
  }

  return {
    async invoke(input: McpControlInvokeInput): Promise<unknown> {
      if (input.source !== "plugin" || !input.pluginContext?.pluginId) {
        fail("PERMISSION_DENIED", "Session collaboration requires a trusted plugin context");
      }
      const args = input.args?.[0];
      if (input.args?.length !== 1 || !args || typeof args !== "object" || Array.isArray(args)) {
        fail("INVALID_ARGUMENT", "One session operation object is required");
      }
      const data = args as Record<string, unknown>;
      const host = requireHost();
      checkCurrent(host, input.signal);
      switch (input.operation) {
        case "session/collaboration/status":
          await drain();
          return readSessionCollaboration(host, deps.getSidecar(), text(data, "sessionId")!);
        case "session/collaboration/list":
          await drain();
          return host.call("session.collaboration.list", {});
        case "session/collaboration/result":
          await drain();
          return host.call("session.collaboration.result", {
            sessionId: text(data, "sessionId"), messageId: text(data, "messageId", false), turnId: text(data, "turnId", false),
          });
        case "session/collaboration/cancel": {
          const result = await cancel(host, {
            sessionId: text(data, "sessionId"), messageId: text(data, "messageId", false),
            pluginId: input.pluginContext.pluginId,
            ...(input.pluginContext.sessionId ? { sourceSessionId: input.pluginContext.sessionId } : {}),
          });
          await drain();
          return result;
        }
        case "session/collaboration/spawn":
        case "session/collaboration/send": {
          const source = sender(input);
          const spawn = input.operation.endsWith("/spawn");
          const content = text(data, spawn ? "task" : "content");
          const notify = data.notifyOnCompletion;
          if (notify !== undefined && typeof notify !== "boolean") fail("INVALID_ARGUMENT", "notifyOnCompletion must be a boolean");
          let model: { providerId: string; modelId: string } | null = null;
          let approvedPolicy: string | undefined;
          if (spawn) {
            const [listed, settings] = await Promise.all([
              host.call<{ providers: Parameters<typeof listReadyPluginModels>[0] }>("providers.list", { includeDisabled: false }),
              host.call<AppSettings>("settings.get"),
            ]);
            checkCurrent(host, input.signal);
            const models = listReadyPluginModels(listed.providers, settings);
            const requested = text(data, "modelKey", false);
            // No isDefault fallback here: naming a default the user never
            // opted into delegation would spend a model the Task gate
            // refuses (issue #1183). Omitting modelKey must fall back to the
            // spawn path's own inheritance, not to an un opted-in default.
            let chosen = requested
              ? models.find((item) => item.key === requested)
              : models.find((item) => item.availableForSubagents);
            if (settings.delegation !== undefined) {
              if (!isDelegationSettings(settings.delegation)) fail("PERMISSION_DENIED", "Invalid delegation policy");
              chosen = undefined;
              const candidates = orderDelegationModels(settings.delegation, { preferredKey: requested });
              for (const candidate of candidates) {
                const ready = models.find((item) => item.key === delegationModelKey(candidate) && item.availableForSubagents);
                if (!ready) continue;
                if (await authorize({ sessionId: source.sourceSessionId, requestId: randomUUID(),
                  providerId: ready.providerId, modelId: ready.modelId, task: content! }, input.signal)) {
                  chosen = ready;
                  approvedPolicy = JSON.stringify(settings.delegation);
                  break;
                }
                checkCurrent(host, input.signal);
                sender(input);
              }
            }
            if (!chosen) fail("MODEL_NOT_CONFIGURED", "No matching configured model is available");
            // A worker the agent starts is AI-driven delegation, so naming a model here
            // needs that model's own `availableForSubagents` opt-in — the gate `Task.model`
            // already applies (ADR subagent-model-opt-in; #386). Inheriting stays open, and
            // naming the default is that inheritance spelled out, the way repeating a
            // definition's own pin is on the Task path.
            if (requested && !chosen.availableForSubagents && (settings.delegation !== undefined || !chosen.isDefault)) {
              fail("PERMISSION_DENIED", `Model "${requested}" is not enabled for AI delegation. Turn on "Available for AI delegation" for it in model settings, or omit modelKey to inherit.`);
            }
            model = parsePluginModelKey(chosen.key);
          }
          checkCurrent(host, input.signal);
          sender(input);
          const response = await host.call<{ message: SessionCollaborationMessage }>(`session.collaboration.${spawn ? "spawn" : "send"}`, {
            ...source, content,
            idempotencyKey: text(data, "idempotencyKey", false) ?? randomUUID(),
            ...(typeof notify === "boolean" ? { notifyOnCompletion: notify } : {}),
            ...(spawn ? { ...model, title: text(data, "title", false) }
              : { sessionId: text(data, "sessionId"), kind: messageKind(data.kind) }),
          });
          if (spawn && model && approvedPolicy) spawnApprovals.set(response.message.id, { ...model, policy: approvedPolicy, task: content! });
          return dispatch(response.message, input.signal);
        }
        default: fail("NOT_FOUND", "Unknown session collaboration operation");
      }
    },
    // The session ID stays part of the runtime callback contract; the host
    // resolves the receipt from the turn ID alone.
    async settle(_sessionId: string, turnId: string): Promise<void> {
      const host = deps.getHost();
      if (!host || deps.isQuitting()) return;
      settlements.add(turnId);
      // Let final message_end enqueues from this event-loop turn reach the outbox.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await drain();
      deps.onChanged();
    },
    drain,
    authorizeDispatch,
    dispose() {
      for (const request of dispatchApprovals.values()) deps.cancelDelegationApproval?.(request);
      dispatchApprovals.clear();
      spawnApprovals.clear();
      dispatchSignals.clear();
    },
  };
}
