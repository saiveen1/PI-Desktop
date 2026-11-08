import type { AppSettings } from "@pi-desktop/shared";

/*
 * Presentation preferences for live and settled process details. Persisted
 * field names are retained for compatibility; missing/true means collapsed.
 * Explicit false keeps the former expand-by-default preference available.
 */

/** Whether ordinary activity starts as a compact action summary. */
export function resolveAutoCollapseSettledGroups(
  settings: AppSettings | undefined,
): boolean {
  return settings?.autoCollapseSettledGroups !== false;
}

/** Whether reasoning starts collapsed, including during generation. */
export function resolveAutoCollapseThinking(
  settings: AppSettings | undefined,
): boolean {
  return settings?.autoCollapseThinking !== false;
}
