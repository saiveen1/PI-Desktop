# Session personas

This contract covers ordinary local Desktop sessions. A persona is independent
of Agent/Plan/Goal/custom operating modes and of a subagent's specialist role.
See [the decision](../../adr/session-personas.md).

## Template catalog and selection

Host-owned AppSettings.personas is an optional array of at most 32 definitions:
`{ id, name, prompt }`. IDs match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` and are unique.
Names are nonempty, trimmed, and at most 128 Unicode characters; nonblank prompt
bodies are limited to 32 KiB of UTF-8. Invalid/oversized values are rejected,
never truncated. An omitted settings field preserves the catalog; `[]` clears it.
Unknown persona fields do not grant capabilities and are rejected.

Settings > Instructions manages templates. Their content is user-authored data,
not executable code. No scripts, tools or permissions are defined by a persona.

SessionSummary.persona is absent/null for the default behavior. A selection is:

```ts
{
  version: 1,
  definition: { id: string, name: string, prompt: string },
  revision: string, // lowercase SHA-256 of the Host's canonical definition JSON
  inheritToSubagents: boolean
}
```

Host owns the selected snapshot. Editing/deleting the template leaves existing
selections intact. Explicitly selecting it again installs its current content.
Switching the inheritance flag alone must not reload a modified template.

## IPC, Host RPC and persistence

Main-window IPC `pi-desktop/session/configurePersona` forwards to Host
`session.configurePersona` with one object:
`{ id, personaId?: string | null, inheritToSubagents?: boolean }`.
At least one patch field is required. Omitted personaId preserves the snapshot;
null clears it and inheritance. A true inheritance flag without a persona is
invalid. A supplied ID must resolve in the current catalog. Errors preserve the
previous selection. The result is `{ session: SessionSummary }`.

`session.create` additionally accepts personaId and inheritToSubagents from a
new-chat draft. It validates/resolves them before committing the new session,
with selection storage inside the creation transaction. Invalid selections
cannot leave an undisclosed empty session. Forking copies the source snapshot;
permanent deletion removes only that session's owned metadata.

Schema 35 adds a separate `session_personas` table keyed by session ID with a
cascading owner relationship and versioned snapshot JSON. The 34-to-35 migration
uses the existing verified backup/transaction mechanism; old sessions retain an
absent persona and their transcripts are unchanged. This is the database schema,
not the legacy shared protocol's similarly named schema constant.

Main takes the session operation lock and rechecks active-turn state across
awaits and checks sidecar work state, including inline children. Host gates its
active/queued work, tool/plan approvals and mode runs; Main and sidecar gate inline
Tasks and their pending delegation approvals. No hidden queued
persona change is accepted. Native Pi, remote and native extension-agent
backends are not supported selection targets. Clearing a retained selection is
available on a local session before moving to an unsupported backend.

## Prompt assembly

With no persona, the existing identity choice and every remaining section are
unchanged. With one, its body replaces the product opening or SYSTEM.md opening,
then a short precedence statement is included. Existing operational instructions,
APPEND_SYSTEM.md, tools/skills, project instructions, memory, runtime identity and
mode sections remain.

The selected body is the first application-composed identity instruction.
Conflicts in identity, tone and response style favor this selection. Permission,
approval, specialist duties, reporting, task scope and execution contracts stay
intact. This does not override provider-side instructions or promise perfect
model compliance. before_agent_start prompt replacement retains the selected
persona prefix; trusted context/raw-payload hooks can still change wire content.

A change to the selected snapshot retires the idle runtime and recomposes on the
next turn. The canonical transcript retains historical system updates instead
of rewriting previous messages. Provider projection may fold effective system
state or preserve chronological updates, according to existing capabilities.
Context compaction retains the effective persona with the normal system state.

## Child inheritance and resume

The switch defaults off and is disabled when no persona is selected. It affects
only persona text, not tool, skill, model or permission inheritance.

For a new opted-in delegation, copy the session snapshot once before constructing
SubagentRun. Child system text becomes persona + precedence, delegation framing,
role definition, earned tool/skill/project guidance, and the run policy. Task.task
is still a separate user message. Parent history is not copied.

Record the snapshot in the chain and durable Task/checkpoint metadata. Every
path-specific prompt refresh must retain this captured snapshot. A resume uses
the original child snapshot regardless of the parent's current selection or
inheritance flag. Legacy/unpersonalized chains never acquire a new parent
persona implicitly; malformed snapshots block that chain's resume rather than
silently changing its identity. New delegation is the way to adopt new settings.

## UI semantics

The composer has an independently labeled persona selector immediately before
the mode picker; it does not create a new operating mode or duplicate the topbar
task monitor. Its menu includes the session-level inheritance switch and
management entry. Default has independent hover/focus help: it injects no session
persona and keeps the existing mode, global/project instructions and SYSTEM.md
configuration effective. Opening help must not select or clear a persona.
Settings > Instructions places persona management before global instructions.
It shows the built-in fallback identity opening verbatim, read-only and separate
from the editable catalog. This does not resolve per-session SYSTEM.md overrides
or show the rest of the prompt. Saved templates are visible without opening a menu.
The welcome surface is not the only place to configure it.

A draft carries selection into first-session creation. Idle existing conversations
can change for the next turn; active work/approval states explain why switching
is unavailable. Async saves remain bound to their initiating conversation/draft,
not whichever conversation becomes visible later. A removed template does not
hide or silently replace the currently saved session persona.

Copy explains the architecture: first client-composed identity block, persona-
focused content recommended, ordinary style conflicts favor it, but permissions,
approvals, workflow contracts and provider constraints are unaffected. Template
editing explains that existing session snapshots do not update automatically.

## Acceptance

- Absent configuration preserves legacy defaults and file-based identity.
- Selection replaces only the identity opening, persists, and can be cleared.
- Main and opted-in child requests carry the correct prefix after restart and
  compaction; an old child resume does not adopt a newer parent persona.
- Template CRUD, inheritance-only toggles, draft creation and stale UI completions
  behave correctly. All text is localized.
- Host rejects invalid inputs and busy/approval conflicts without partial writes.
- Source and isolated fixture validation are not a claim of real-provider persona
  adherence, installed-upgrade success or support for arbitrary extension hooks.
