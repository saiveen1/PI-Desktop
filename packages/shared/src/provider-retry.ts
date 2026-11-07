/** Shared automatic provider retry budget used by runtime and renderer status. */
export const PROVIDER_RETRY_MAX_RETRIES = 10;

/** Independent opt-in budget; unlimited transient retry never widens this limit. */
export const UNKNOWN_UPSTREAM_RETRY_LIMIT_DEFAULT = 0;
export const UNKNOWN_UPSTREAM_RETRY_LIMIT_MAX = 3;

export function isUnknownUpstreamRetryLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= 0 && value <= UNKNOWN_UPSTREAM_RETRY_LIMIT_MAX;
}

export function resolveUnknownUpstreamRetryLimit(value?: number): number {
  if (value === undefined) return UNKNOWN_UPSTREAM_RETRY_LIMIT_DEFAULT;
  if (!isUnknownUpstreamRetryLimit(value)) throw new Error("Invalid unknown upstream retry limit");
  return value;
}
