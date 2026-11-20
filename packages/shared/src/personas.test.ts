import { describe, expect, it } from "vitest";
import { isConfigureSessionPersonaRequest, isPersonaCatalog, isPersonaDefinition, isSessionPersona, PERSONA_LIMITS } from "./personas.js";

const definition = { id: "careful-editor", name: "Careful editor", prompt: "Explain decisions with evidence." };
const snapshot = { version: 1, definition, revision: "a".repeat(64), inheritToSubagents: false };

describe("persona boundary contracts", () => {
  it("accepts a template, an immutable selection, a clear and an inheritance-only patch", () => {
    expect(isPersonaDefinition(definition)).toBe(true);
    expect(isSessionPersona(snapshot)).toBe(true);
    expect(isConfigureSessionPersonaRequest({ id: "session", personaId: definition.id })).toBe(true);
    expect(isConfigureSessionPersonaRequest({ id: "session", personaId: null })).toBe(true);
    expect(isConfigureSessionPersonaRequest({ id: "session", inheritToSubagents: true })).toBe(true);
  });

  it("bounds UTF-8 prompt bytes and Unicode name characters without truncating", () => {
    expect(isPersonaDefinition({ ...definition, prompt: "x".repeat(PERSONA_LIMITS.promptBytes) })).toBe(true);
    expect(isPersonaDefinition({ ...definition, prompt: "界".repeat(11_000) })).toBe(false);
    expect(isPersonaDefinition({ ...definition, name: "🌟".repeat(128) })).toBe(true);
    expect(isPersonaDefinition({ ...definition, name: "🌟".repeat(129) })).toBe(false);
  });

  it.each([
    { ...definition, id: "../outside" }, { ...definition, name: " padded " },
    { ...definition, prompt: "\n " }, { ...definition, name: "" },
    { ...definition, permissions: "auto" },
  ])("rejects malformed or privilege-shaped templates: %j", value => {
    expect(isPersonaDefinition(value)).toBe(false);
  });

  it("rejects duplicate and oversized catalogs while allowing an empty catalog", () => {
    expect(isPersonaCatalog([])).toBe(true);
    expect(isPersonaCatalog([definition, definition])).toBe(false);
    expect(isPersonaCatalog(Array.from({ length: 33 }, (_, index) => ({ ...definition, id: `p-${index}` })))).toBe(false);
  });

  it("rejects unsupported snapshots and malformed patches", () => {
    expect(isSessionPersona({ ...snapshot, version: 2 })).toBe(false);
    expect(isSessionPersona({ ...snapshot, revision: "not-a-digest" })).toBe(false);
    expect(isSessionPersona({ ...snapshot, inheritToSubagents: "true" })).toBe(false);
    for (const value of [{ id: "s" }, { id: "s", personaId: undefined },
      { id: "s", personaId: null, inheritToSubagents: true }, { id: "s", inheritToSubagents: 1 },
      { id: "s", personaId: "p", mode: "agent" }]) {
      expect(isConfigureSessionPersonaRequest(value)).toBe(false);
    }
  });
});
