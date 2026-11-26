/*
 * Payloads are opt-in even while work is live. The header carries liveness;
 * disclosure.tsx preserves explicit choices, search reveals and reading focus.
 * Keep the existing opt-out preferences compatible without adding a UI mode.
 */

/** Whether an activity group's detail starts open. */
export function activityGroupStartsOpen(state: {
  turnActive?: boolean;
  groupActive: boolean;
  collapseSettled: boolean;
}): boolean {
  return !state.collapseSettled;
}

/** Generating reasoning must not force the reader into its full text. */
export function thinkingRowStartsOpen(state: {
  streaming: boolean;
  collapseSettled: boolean;
}): boolean {
  return !state.collapseSettled;
}
