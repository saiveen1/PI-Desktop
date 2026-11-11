export const PROVIDER_STREAM_IDLE_TIMEOUT_MINUTES_DEFAULT = 10;

export function isProviderStreamIdleTimeoutMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 60;
}

export function resolveProviderStreamIdleTimeoutMinutes(value: unknown): number {
  return isProviderStreamIdleTimeoutMinutes(value) ? value : PROVIDER_STREAM_IDLE_TIMEOUT_MINUTES_DEFAULT;
}
