export type SidebarSessionStatus =
  | "running"
  | "selected"
  | "unread"
  | "completed"
  | "failed"
  | "permission";
export type SidebarSessionOutcome = Extract<
  SidebarSessionStatus,
  "completed" | "failed"
>;

export { latestSessionOutcomes } from "@pi-desktop/shared";

export function sidebarSessionStatus({
  running,
  selected,
  unread,
  outcome,
  hasPendingPermission,
}: {
  running: boolean;
  selected: boolean;
  unread?: boolean;
  outcome?: SidebarSessionOutcome;
  hasPendingPermission?: boolean;
}): SidebarSessionStatus | null {
  if (hasPendingPermission) return "permission";
  if (running) return "running";
  if (unread) return "unread";
  if (selected) return "selected";
  return outcome ?? null;
}
