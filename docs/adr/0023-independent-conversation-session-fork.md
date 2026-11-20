# ADR 0023: Independent Conversation Session Fork

## Status

Accepted.

## Context

PI-Desktop already keeps linear regenerate variants inside one conversation, but
users also need a Codex-style command that copies the conversation so later prompts
and configuration changes diverge without rewriting the source. Composing
`session.create` with message replacement in the renderer would expose partial
children, lose canonical transcript blocks, omit per-session execution
configuration, and cross the Rust host's persistence ownership, while protocol v4
would let an older host fail only when the new command runs.

## Decision

- Protocol v5 adds the required host RPC `session.fork` and renderer IPC
  `session/fork`.
- The Rust host owns one snapshot: it copies the source's complete active canonical
  transcript into a new session and remaps message and tool-call identifiers.
  Optional `throughMessageId` ends the snapshot inclusively there; an unknown
  boundary creates no child and returns `NOT_FOUND`.
- The child inherits project, provider, model, mode, thinking, and permission mode,
  but no turns, regenerate revisions, notifications, artifacts, session grants,
  scratch outputs, pin state, or live runtime state. Files under the source's
  `scratch/<id>/pasted/` directory are copied into the child's own input directory and
  the references rewritten before indexing, so pasted inputs survive source deletion
  without widening scratch access.
- No parent/child lineage is stored: this is an independent copy, not a message tree.
  Response Fork uses the bounded snapshot. The original D134 edit-on-fork
  workflow was retired by D137; see the in-place editing amendment below.
- Whole-session fork stays idle-only. A desktop message-scoped fork may copy a
  completed assistant prefix while a later turn runs (issue #837): under the same host
  lock as append/publication, a non-assistant, streaming/error, or live-turn anchor is
  rejected with `CONFLICT`, which Electron maps to `AGENT_BUSY`, and the renderer
  sends only the anchor id so the parent keeps running.
- A handled file or index failure removes the child and copied inputs; crashes follow
  the transcript store's orphan-file recovery.

## Consequences

- Protocol v4 peers are rejected at startup instead of failing on Create branch.
- Source and child evolve, reconfigure, persist, and delete independently, and each
  child reseeds its own pi runtime instead of reusing source cache state.
- Storage cost tracks the copied transcript, its pasted inputs, and child-only
  revision payloads.
- There is no ancestry UI, merge operation, or message-level branch tree.

## Amendment: edit the idle assistant tail in place

The later [whole-turn context editor](whole-turn-context-editing.md) supersedes
the final-only UI below. Legacy APIs remain compatible where no turn overlays
exist; new edits preserve originals through context-only overlays.

A user may correct the text of the last completed local assistant reply without
starting a turn, appending a user correction or creating a revision. The Host
owns the compare-and-replace, including validating the target and discarding
stale replay data. The next prompt must seed from the saved conversation.
Older answers use the existing explicit Fork action, then the same tail edit on
the child. Rewriting later history or building a second revision tree would not
improve this infrequent path. User-prompt Edit/Retry stays unchanged.

The editor offers a thinking-context selector in its footer: exclude only the
edited reply (default), exclude all thinking in this turn, or keep all thinking
in this turn. This is a reversible context choice, not deletion: original
thinking remains in history. The current reply means its exact assistant row,
not the last earlier row that happened to contain thinking. Host-owned turn
boundaries keep prior turns, delegated output and tool results outside this
mutation. Explicit choices may be saved without changing the answer text.

An additive `excludeThinkingFromContext` message metadata flag controls runtime
restoration. Excluded rows omit plain, signed and encrypted reasoning; tool
call signatures and results remain. Host invalidates checkpoints covering the
changed context, including retained reasoning, and Electron disposes the warm
runtime before continuing. Old requests that omit the option remain text-only;
old rows without the flag retain their behavior. No database backfill or
transcript format migration is needed for this optional metadata. Older apps
that do not understand the flag will replay original thinking: this is not
secure deletion or a cross-version redaction guarantee.

## Alternatives

- Renderer-owned `create + replaceMessages`: not atomic across the host-owned
  transcript and index.
- Persistent parent/child lineage: deferred, since D109 keeps revisions linear.
- Copy regenerate revisions: it would need a second branch graph and ambiguous pager
  history.
