import { THINKING_LEVELS, type ThinkingLevel } from "./types/models.js";
import type { MessageUsage } from "./types/messages.js";

export const OBSERVER_GUARD_MODES = ["off", "observe", "guard"] as const;
export type ObserverGuardMode = typeof OBSERVER_GUARD_MODES[number];
export function isObserverGuardMode(value: unknown): value is ObserverGuardMode {
  return value === "off" || value === "observe" || value === "guard";
}
export function resolveObserverGuardMode(value: unknown): ObserverGuardMode {
  return isObserverGuardMode(value) ? value : "off";
}

/** Explicit independent-model configuration. Selecting a model never enables a session. */
export type ObserverGuardSettings = {
  providerId?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  timeoutSeconds?: number;
  maxInputChars?: number;
  recentToolCount?: number;
  includeToolOutput?: boolean;
};
export const OBSERVER_GUARD_LIMITS = {
  timeoutSeconds: { min: 5, max: 90 },
  maxInputChars: { min: 2000, max: 20000 },
  recentToolCount: { min: 0, max: 8 },
} as const;
export const DEFAULT_OBSERVER_GUARD_SETTINGS: Readonly<Required<ObserverGuardSettings>> = Object.freeze({
  providerId: "", modelId: "", thinkingLevel: "off", timeoutSeconds: 30,
  maxInputChars: 8000, recentToolCount: 3, includeToolOutput: false,
});
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function validField(key: string, value: unknown): boolean {
  if (key === "providerId" || key === "modelId") return typeof value === "string" && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value) && value === value.trim();
  if (key === "thinkingLevel") return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
  if (key === "includeToolOutput") return typeof value === "boolean";
  if (!Object.hasOwn(OBSERVER_GUARD_LIMITS, key)) return false;
  const range = OBSERVER_GUARD_LIMITS[key as keyof typeof OBSERVER_GUARD_LIMITS];
  return typeof value === "number" && Number.isInteger(value) && value >= range.min && value <= range.max;
}
export function isObserverGuardSettings(value: unknown): value is ObserverGuardSettings {
  return record(value) && Object.entries(value).every(([key, field]) => validField(key, field));
}
export function resolveObserverGuardSettings(value: unknown): Required<ObserverGuardSettings> {
  const result = { ...DEFAULT_OBSERVER_GUARD_SETTINGS };
  if (record(value)) for (const key of Object.keys(result)) {
    if (Object.hasOwn(value, key) && validField(key, value[key])) Object.assign(result, { [key]: value[key] });
  }
  return result;
}

export type ObserverGuardVerdict = "complete" | "incomplete" | "blocked" | "needs_input" | "unknown";
export type ObserverGuardError = "MODEL_NOT_CONFIGURED" | "MODEL_UNAVAILABLE" | "EFFORT_UNAVAILABLE" |
  "PROVIDER_UNAVAILABLE" | "TIMEOUT" | "INVALID_RESPONSE" | "CANCELLED" | "INSUFFICIENT_EVIDENCE";

/** Persisted per-response advisory; never part of the main model's history. */
export type ObserverGuardAssessment = {
  messageId: string;
  mode: Exclude<ObserverGuardMode, "off">;
  status: "checking" | "assessed" | "error" | "skipped";
  modelKey?: string;
  thinkingLevel?: ThinkingLevel;
  startedAt: number;
  endedAt?: number;
  verdict?: ObserverGuardVerdict;
  confidence?: "low" | "medium" | "high";
  reason?: string;
  evidenceIds?: string[];
  errorCode?: ObserverGuardError;
  continued?: boolean;
  /** Bounded reason why a verdict did not authorize an action. */
  continuationBlocked?: "observe_only" | "budget" | "unsafe" | "not_actionable";
  inputTruncated?: boolean;
  usage?: MessageUsage;
};
