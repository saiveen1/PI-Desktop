/** Local output guards. These preferences never become model instructions. */
export type AgentOutputGuardSettings = {
  earlyEndMode?: "off" | "warn" | "continue";
  /** Shared per-user-turn correction allowance; transport retries are separate. */
  recoveryLimit?: number;
  repetitiveOutputEnabled?: boolean;
  repeatedParagraphsEnabled?: boolean;
  symbolMinChars?: number;
  symbolMinLines?: number;
  symbolSingleLineChars?: number;
  repeatedParagraphMinChars?: number;
  repeatedParagraphMinRepeats?: number;
};

export type ResolvedAgentOutputGuardSettings = Required<AgentOutputGuardSettings>;

export const DEFAULT_AGENT_OUTPUT_GUARD_SETTINGS: Readonly<ResolvedAgentOutputGuardSettings> = Object.freeze({
  earlyEndMode: "warn",
  recoveryLimit: 1,
  repetitiveOutputEnabled: true,
  repeatedParagraphsEnabled: true,
  symbolMinChars: 4096,
  symbolMinLines: 512,
  symbolSingleLineChars: 8192,
  repeatedParagraphMinChars: 1200,
  repeatedParagraphMinRepeats: 4,
});

/** Public validation bounds also drive the Settings controls. */
export const AGENT_OUTPUT_GUARD_LIMITS = {
  recoveryLimit: { min: 0, max: 3 },
  symbolMinChars: { min: 1024, max: 65536 },
  symbolMinLines: { min: 32, max: 4096 },
  symbolSingleLineChars: { min: 1024, max: 131072 },
  repeatedParagraphMinChars: { min: 256, max: 65536 },
  repeatedParagraphMinRepeats: { min: 3, max: 20 },
} as const;

type NumericSetting = keyof typeof AGENT_OUTPUT_GUARD_LIMITS;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validField(key: string, value: unknown): boolean {
  if (key === "earlyEndMode") return value === "off" || value === "warn" || value === "continue";
  if (key === "repetitiveOutputEnabled" || key === "repeatedParagraphsEnabled") return typeof value === "boolean";
  if (!Object.hasOwn(AGENT_OUTPUT_GUARD_LIMITS, key)) return false;
  const range = AGENT_OUTPUT_GUARD_LIMITS[key as NumericSetting];
  return typeof value === "number" && Number.isInteger(value) && value >= range.min && value <= range.max;
}

/** Writes reject invalid values instead of silently changing user preferences. */
export function isAgentOutputGuardSettings(value: unknown): value is AgentOutputGuardSettings {
  return record(value) && Object.entries(value).every(([key, field]) => validField(key, field));
}

/** Old/partial settings receive defaults; malformed persisted fields are ignored. */
export function resolveAgentOutputGuardSettings(value: unknown): ResolvedAgentOutputGuardSettings {
  const result = { ...DEFAULT_AGENT_OUTPUT_GUARD_SETTINGS };
  if (!record(value)) return result;
  for (const key of Object.keys(result) as Array<keyof ResolvedAgentOutputGuardSettings>) {
    if (!Object.hasOwn(value, key) || !validField(key, value[key])) continue;
    // The field-specific validator establishes the key/value relationship.
    Object.assign(result, { [key]: value[key] });
  }
  return result;
}

/** This records the adapter's normalized reason, not an invented raw provider frame. */
export type AgentResponseTermination = {
  messageId: string;
  stopReason: "stop" | "length" | "toolUse" | "aborted" | "error" | "unknown";
  reasonSource: "normalized";
  outputTokens?: number;
  maxOutputTokens?: number;
  earlyEnd?: "suspected" | "recovering" | "exhausted";
  recoveryAttempts?: number;
};
