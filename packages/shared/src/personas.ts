/** The built-in identity opening, before other instructions are composed. */
export const DEFAULT_RUNTIME_SYSTEM_PROMPT =
  "You are PI-Desktop, a coding agent. Answer in the user's language. Be concise, direct, and actionable.";

/** Persona templates are preferences, never permission or execution grants. */
export const PERSONA_LIMITS = { count: 32, id: 64, name: 128, promptBytes: 32_768 } as const;

export type PersonaDefinition = { id: string; name: string; prompt: string };

/** Host-owned immutable selection; templates may subsequently change or disappear. */
export type SessionPersona = {
  version: 1;
  definition: PersonaDefinition;
  revision: string;
  inheritToSubagents: boolean;
};

export type ConfigureSessionPersonaRequest = {
  id: string;
  /** Omission preserves the snapshot. Null clears it and its inheritance flag. */
  personaId?: string | null;
  inheritToSubagents?: boolean;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

export function isPersonaId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}

export function isPersonaDefinition(value: unknown): value is PersonaDefinition {
  return record(value) && onlyKeys(value, ["id", "name", "prompt"]) &&
    isPersonaId(value.id) && typeof value.name === "string" &&
    value.name.length > 0 && value.name === value.name.trim() &&
    Array.from(value.name).length <= PERSONA_LIMITS.name &&
    typeof value.prompt === "string" && value.prompt.trim().length > 0 &&
    new TextEncoder().encode(value.prompt).byteLength <= PERSONA_LIMITS.promptBytes;
}

export function isPersonaCatalog(value: unknown): value is PersonaDefinition[] {
  return Array.isArray(value) && value.length <= PERSONA_LIMITS.count &&
    value.every(isPersonaDefinition) && new Set(value.map(item => item.id)).size === value.length;
}

export function isSessionPersona(value: unknown): value is SessionPersona {
  return record(value) && onlyKeys(value, ["version", "definition", "revision", "inheritToSubagents"]) &&
    value.version === 1 && isPersonaDefinition(value.definition) &&
    typeof value.revision === "string" && /^[a-f0-9]{64}$/.test(value.revision) &&
    typeof value.inheritToSubagents === "boolean";
}

export function isConfigureSessionPersonaRequest(value: unknown): value is ConfigureSessionPersonaRequest {
  return record(value) && onlyKeys(value, ["id", "personaId", "inheritToSubagents"]) &&
    typeof value.id === "string" && value.id.length > 0 && value.id === value.id.trim() &&
    (Object.hasOwn(value, "personaId") || Object.hasOwn(value, "inheritToSubagents")) &&
    (!Object.hasOwn(value, "personaId") || value.personaId === null || isPersonaId(value.personaId)) &&
    (!Object.hasOwn(value, "inheritToSubagents") || typeof value.inheritToSubagents === "boolean") &&
    !(value.personaId === null && value.inheritToSubagents === true);
}
