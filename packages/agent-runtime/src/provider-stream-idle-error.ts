import type { AssistantMessage } from "@earendil-works/pi-ai";

export type ProviderIdleDetails = {
  idleTimeoutMs: number;
  lastTransportAt?: number;
  lastModelEventAt?: number;
  responseBytes: number;
  transportObserved: boolean;
};

// Local provenance must not be inferred from provider-controlled error prose.
const timeouts = new WeakMap<object, ProviderIdleDetails>();

export function markProviderIdleTimeout(message: AssistantMessage, details: ProviderIdleDetails): AssistantMessage {
  timeouts.set(message, details);
  return message;
}

export function readProviderIdleTimeout(error: unknown): ProviderIdleDetails | undefined {
  return error !== null && typeof error === "object" ? timeouts.get(error) : undefined;
}
