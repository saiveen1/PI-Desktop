# ADR: Session organization and scoped on-demand delegation

- Status: Accepted, implementation candidate; validation deferred by request
- Date: 2026-11-07
- Amends: ADR 0016 and `delegation-scheduling-and-approval`

## Context

Generic session activity includes assistant output and configuration writes.
Using that timestamp for the conversation list conflicts with an intentional
manual position and with reading an old conversation without moving it.
Labels and independent color marks serve different organization needs.

Delegation has a global candidate pool, priority and human approval. A user
also needs to narrow the pool for one conversation and let the parent match
each task to model descriptions. Repeating the full model directory in every
parent request adds unrelated context to turns that do not delegate.

## Decision

Keep conversation organization in the existing renderer presentation record.
The default `recent` view becomes Activity order: drag operations and accepted
user messages update one persistent sequence without changing other rows'
relative order. Opening, output streaming, completion and history restoration
do not move a conversation. A durable queued submission raises it once; queue
execution does not raise it again. Explicit Name/Created/Oldest views remain
projections; a drag returns to Activity order. Global pins stay independent of
send activity. Archived and ordinary rows never cross their organization bucket.
Filtering changes visibility, not the underlying sequence or host timestamps.

A local global label catalog supports editable names, colors and order. A
conversation may reference multiple labels and independently have one color
mark. Deletion removes label associations, not conversations. Multiple selected
label filters match any selected label; the selected color filter is combined
with that result. Defaults are ordinary editable entries. No label, including
TODO, creates tasks, notifications or other automation.

The Rust Host owns an optional per-session list of exact delegation model
keys. Missing means inherit global policy; an empty list disables delegation.
An explicit list narrows global eligibility and never grants approval. Session
configuration is idle-only and does not interrupt existing delegates. Session
forks copy the list, and permanent deletion removes it. Existing sessions do
not acquire a custom pool during upgrade. The existing Host `kv` extension
stores this additive setting without a new SQLite table or schema version.

The candidate snapshot and approval service resolve the invocation's session,
not the visible UI selection. Initial launch, later Task admissions, role pins,
resume, fallback and approval alternatives share the same effective pool.
Global revocation remains effective even when a session retains a saved key.

Expose the effective model descriptions through the read-only `TaskModels`
tool when delegation is needed. The full directory is absent from the system
prompt and the ordinary Task declaration. A parent can reuse one query across
a batch and refresh after policy changes. Custom session pools use task fit
before numeric priority; an explicit compatible selection is not demoted by
the old priority-promotion gate. Inherited pools retain their legacy ordering.
This adds no separate model-routing service or role/model binding system.

Retain the parent's concise `modelReason` in each delegation's historical
scheduling metadata. Display it separately from requested/actual model identity
and the scheduler's approval, skipping and fallback decisions. Never derive
missing historical explanations from descriptions or current settings.

## Consequences

The existing process and security boundaries remain. Renderer preferences
can be cleared without deleting conversations; authoritative model constraints
survive renderer resets through Host persistence. Old profiles and delegation
records remain readable. Description-based selection is a parent-agent decision,
not a claim that deterministic scheduling can measure model quality.

The implementation candidate needs user-path coverage for organizing, filtering,
reloading, configuring a pool, querying models, admitting a task and showing its
history. Tests are not recorded as passing until executed against this candidate.

## Alternatives

Two new global strategy modes add configuration without expressing the user's
per-conversation candidate choice. Hard role/model bindings add another policy
authority. A plugin-only sidebar cannot provide the native row/menu workflow.
These alternatives are outside this change.
