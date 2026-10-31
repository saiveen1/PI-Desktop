# ADR: Unified delegation scheduling and mandatory model approval

- Status: Accepted
- Scope: Desktop delegation, including Task, resumed delegates, model fallback,
  and plugin session collaboration.

## Context

The existing `availableForSubagents` flag grants selection, while definition
pins and inherited models remain separate paths. Instruction files cannot
provide reliable cost authorization. Extension hooks are cooperative and fail
open on errors/timeouts; ordinary tool permissions may be allowed in Auto mode.
Neither is a suitable boundary for mandatory model consent.

## Decision

Store an optional versioned `AppSettings.delegation` object through the existing
Host-owned settings repository. Each exact provider/model identity has an enabled
flag, integer priority (lower first, ties allowed), `auto` or `ask` approval,
and a short user-authored capability description. One approval wait setting
applies to the pool; zero skips approval-required models for unattended work.
The JSON extension needs no SQLite table/schema migration. Missing policy keeps
legacy behavior. Saving a policy makes its enabled members authoritative,
including definition pins, session inheritance and resumed/fallback bindings.
The settings form seeds existing opt-ins without changing persisted behavior
until save; the old model checkbox becomes a navigation entry after adoption.

Role descriptions and tools remain owned by subagent definitions. Task metadata
is built from the role catalog and scheduling policy, so descriptions remain
available on provider requests after compaction. The model may select peers or
request a lower-priority specialist with a reason. The scheduler applies enabled
membership, deterministic tier ordering and declared capability requirements.
Descriptions and AI explanations never grant permission.

Approval lives in a focused Electron service shared with collaboration, using
the existing Host UI prompt transport rather than an extension event handler.
It rereads settings and provider availability, binds each decision to an exact
request/session/model, and rechecks after waiting. Auto tool permissions do not
participate. Approval allows only this delegate invocation; resume requires a
new decision. Every fallback model is checked before its first provider request.
Cancellation aborts the exact prompt and never authorizes an alternative. An
expired/unavailable prompt skips the candidate; the scheduler can start the
same work on another enabled, compatible, authorized model. Late replies cannot
start a second task. A required exact model never silently substitutes another.

Natural-language model requests remain expressible through Task.model. The
`modelSelection` parameter distinguishes a preference from an exact requirement;
neither is evidence of human approval. Explicit approval uses the existing UI
channel, and the runtime does not accept an AI-authored "user approved" flag.

Keep successful tool history when a running delegate changes provider. Do not
replay a task or completed tools to accomplish fallback. Record requested and
actual models plus skipped/selected reasons in the existing Task result and
settlement snapshots; existing usage and timing remain intact.

## Alternatives

A plugin-only hook cannot reliably enforce this cost boundary. Adding another
AI just to route tasks adds latency and spend without removing the need for a
host check. Maintaining per-role fallback permissions alongside a global pool
creates conflicting authorities; legacy role pins remain preferences while the
adopted pool governs their eligibility and approval.

## Consequences

The process model and credential ownership are unchanged. Internal sidecar
messages gain explicit authorization/cancellation callbacks; unsupported hosts
fail closed when a unified policy is present. Existing users retain their old
configuration until they save the scheduling page. Users adopting a pool must
include the fixed models they want delegates to keep using. Capability prose
improves selection but cannot prove model quality; priority and human policy
remain user-controlled, with no self-modifying ranking or claimed optimality.

## Verification

Policy tests cover ties, escalation rationale, disabled membership, validation
and legacy import. Runtime tests use local HTTP/SSE parent/child providers to
verify no child request before consent, automatic alternatives, exact selection,
resume reapproval and cancellation. Fallback tests assert request identity and
that completed edits occur once. Host and renderer tests cover saved settings,
policy revalidation, prompt retirement and the add/edit/save/reload user path.
