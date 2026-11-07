export const DELEGATION_CONTEXT_WINDOW_MAX = 10_000_000;

export class DelegationRequestError extends Error {
  readonly code = "DELEGATION_INVALID_REQUEST";

  constructor(message: string) {
    super(message);
    this.name = "DelegationRequestError";
  }
}

/** Host metadata carries only a positive minimum; Task also accepts zero. */
export function isDelegationContextMinimum(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value > 0 && value <= DELEGATION_CONTEXT_WINDOW_MAX;
}

export function normalizeDelegationContextWindow(value: unknown): number | undefined {
  if (value === undefined || value === 0) return undefined;
  if (!isDelegationContextMinimum(value)) {
    throw new DelegationRequestError(`minContextWindow must be an integer from 0 to ${DELEGATION_CONTEXT_WINDOW_MAX}; omit it or use 0 for no minimum.`);
  }
  return value;
}
