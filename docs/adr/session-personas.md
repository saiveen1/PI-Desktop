# ADR: Session personas with pinned delegation inheritance

- Status: Implemented candidate
- Scope: Local ordinary Desktop sessions; no mode or permission redesign
- Related: [mode definitions](mode-definitions.md), [runtime contract](../spec/03-runtime/session-personas.md)

## Context

Operating modes own workflow, stages and permissions. They are not a reliable
identity-precedence selector. SYSTEM.md is an optional replacement for the
product identity opening, not an independent highest-priority configuration.
Changing existing mode semantics would alter old conversations and workflows.

Users need a separate persona choice that supplies the first application-owned
identity block, with explicit identity/tone/style precedence, plus a per-session
choice about whether new delegates receive it. Delegates have their own prompts
and context, so inheritance must be deliberate and durable across resume.

## Decision

Keep existing modes and prompt composition unchanged when no persona is selected.
Store reusable templates in the Host-owned application settings. Selecting one
creates a versioned, content-addressed session snapshot in Host-owned storage.
Changing or deleting a template never changes an already selected snapshot.

Place the persona selector next to the composer mode picker. Put the child
inheritance switch in its menu and manage templates under Settings > Instructions.
The control applies to one conversation or to the draft that creates it, not to
all open conversations. Use the existing shared controls and localized strings.

Use a dedicated session.configurePersona operation. The Host resolves the
selected template, validates inputs and rejects changes while main/child work,
queued execution, approvals or a staged mode run are active. It does not queue a
hidden future switch or change mode, model or permissions. Creation may include a
selection atomically; forks keep their source snapshot.

A selected persona replaces only the existing identity opening. Its body is the
first Desktop-composed system text, followed by explicit scope/precedence
wording and the existing runtime guidance. Persona precedence applies to
identity, tone and response style, not execution authorization, reporting
contracts or task ownership. Upstream/provider constraints are not mutable here.

Child inheritance defaults off. An opted-in child records the exact snapshot
in its chain, Task records and checkpoint. Resuming an existing chain always
uses that chain's original snapshot, even if the parent cleared, edited or
reselected a persona. Legacy chains remain unpersonalized. Invalid recorded
snapshots cannot silently acquire today's parent persona.

## Consequences

- Existing sessions and file-based persona configuration retain their behavior.
- Human-selected changes take effect on subsequent turns/new child chains;
  previous messages and completed output are not rewritten.
- A template edit requires selecting/applying it again to change a conversation.
- Database migration 34 to 35 adds separate session-owned persona metadata and
  keeps existing transcript bytes intact. Older hosts must not silently accept
  the new configuration operation.
- Persona text is stored with session/delegation data. It is not a secret store.
- Prompt wording is not a deterministic model-enforcement mechanism. Trusted
  extensions which directly replace final messages/payloads remain outside the
  normal composition guarantee; native extension-agent and remote paths are not
  advertised as supported persona backends in this candidate.

## Validation

Cover Host catalog/selection validation, migration and reopen, atomic creation,
fork/delete ownership, busy/approval gates, draft and existing-session UI paths,
request-prefix and legacy-default equivalence, clearing/reselecting, context
compaction, and a child restart/resume after a different parent selection. Use
synthetic profiles and model boundaries, never the user's running installation.
