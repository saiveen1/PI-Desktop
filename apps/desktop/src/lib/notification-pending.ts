import type { DelegationApprovalPrompt, NotificationTarget } from "@pi-desktop/shared";
import type { AppState } from "../stores/app-state";

export type PendingNotification = { target: NotificationTarget; expiresAt?: number };
export function notificationIdentity(target: NotificationTarget): string {
  return JSON.stringify([target.hostKey ?? null, target.kind, target.sessionId, target.requestId ?? null]);
}

/** A projection only: pending consent never enters the durable task inbox. */
export function pendingNotificationTargets(
  state: Pick<AppState, "pendingAsks" | "pendingPermissions" | "pendingPlans">,
  delegations: readonly DelegationApprovalPrompt[],
  now = Date.now(),
): PendingNotification[] {
  const items: PendingNotification[] = [];
  for (const requests of Object.values(state.pendingAsks)) {
    for (const request of requests) items.push({ target: { kind: "ask", sessionId: request.sessionId, requestId: request.requestId } });
  }
  for (const requests of Object.values(state.pendingPermissions)) {
    for (const request of requests) items.push({ target: { kind: "permission", sessionId: request.sessionId, requestId: request.requestId } });
  }
  for (const request of Object.values(state.pendingPlans)) {
    const expiresAt = request.expiresAt ? Date.parse(request.expiresAt) : undefined;
    if (request.status !== "pending" || expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= now)) continue;
    items.push({ target: { kind: "plan", sessionId: request.sessionId, requestId: request.id }, expiresAt });
  }
  for (const request of delegations) {
    const expiresAt = Date.parse(request.expiresAt);
    if (request.status !== "pending" || !Number.isFinite(expiresAt) || expiresAt <= now) continue;
    items.push({ target: { kind: "delegation-approval", sessionId: request.sessionId, requestId: request.requestId, revision: request.revision }, expiresAt });
  }
  return items;
}
