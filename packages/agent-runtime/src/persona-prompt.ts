import { isSessionPersona, type SessionPersona } from "@pi-desktop/shared";

/** Do not let malformed persisted configuration silently select another identity. */
export function readSessionPersona(value: unknown): SessionPersona | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isSessionPersona(value)) {
    throw Object.assign(new Error("Invalid session persona snapshot"), { errorCode: "INVALID_PARAMS" });
  }
  return structuredClone(value);
}

/** The persona body is the first application-owned text, not a task or tool result. */
export function personaSystemPrompt(persona?: SessionPersona | null): string | undefined {
  if (!persona) return undefined;
  return [
    persona.definition.prompt.trim(),
    "# Session persona precedence",
    "The opening persona is the user's selected identity, tone, and response-style preference. For conflicts in those areas, follow it rather than ordinary defaults in later mode, project, or skill guidance. Keep the delegated task and specialist responsibilities, tool contracts, approvals, safety boundaries, and execution workflow intact. Persona instructions do not grant capabilities or override provider constraints.",
  ].join("\n\n");
}

/** Trusted before-agent-start additions cannot accidentally remove the selected persona. */
export function withPersonaPrefix(prompt: string, persona?: SessionPersona): string {
  const prefix = personaSystemPrompt(persona);
  return !prefix || prompt.startsWith(prefix) ? prompt : `${prefix}\n\n${prompt}`;
}

export type DelegationPersonaState = { persona?: SessionPersona; personaInvalid?: boolean };

/** Legacy and explicitly unpersonalized chains never adopt today's parent selection. */
export function delegationPersona(
  current?: SessionPersona,
  resumed?: DelegationPersonaState,
): SessionPersona | undefined {
  if (resumed) {
    if (resumed.personaInvalid) throw new Error("This delegation has an invalid persona snapshot. Start a new task instead of resuming it.");
    return readSessionPersona(resumed.persona);
  }
  return current?.inheritToSubagents ? readSessionPersona(current) : undefined;
}

export function restoredDelegationPersona(value: unknown): DelegationPersonaState {
  if (value === undefined) return {};
  return isSessionPersona(value) ? { persona: structuredClone(value) } : { personaInvalid: true };
}
