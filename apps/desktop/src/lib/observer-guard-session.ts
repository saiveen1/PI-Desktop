import type { ObserverGuardMode, SessionSummary } from "@pi-desktop/shared";
import { isRemoteSession } from "./remote-session-safety";

export function supportsObserverGuard(session: SessionSummary): boolean {
  return !session.scheduledRun && !session.id.startsWith("native-pi:") && !isRemoteSession(session) &&
    (!session.source || session.source === "desktop");
}

export function canRevokeRunningContinuation(
  current: SessionSummary["observerMode"], next: ObserverGuardMode, running: boolean,
): boolean {
  return running && next === "off" && (current === "endless" || current === "guard");
}
