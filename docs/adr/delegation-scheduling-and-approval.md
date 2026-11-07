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

Role descriptions and tools remain owned by subagent definitions. As amended by
[session-scoped on-demand delegation](session-organization-and-scoped-delegation.md),
Task metadata retains role guidance while TaskModels returns model descriptions
on demand. The full directory does not remain in every provider request. The model may select peers or
request a lower-priority specialist with a reason. The scheduler applies enabled
membership, deterministic tier ordering and declared capability requirements.
Descriptions and AI explanations never grant permission.

Approval lives in a focused Electron service shared with collaboration. The
amendment below uses dedicated core IPC through the existing renderer transport,
separate from generic extension prompts. The service rereads settings and
provider availability and rechecks exact request/session/revision/model after
waiting. Auto tool permissions do not participate. Approval allows only this
invocation; resume requires a new decision and every fallback is checked before
its first request. Cancellation never authorizes an alternative. After expiry,
only compatible candidates already authorized by `auto` remain eligible; no new
full ask deadline is started. Late replies cannot start a second task. Exact
requirements and user-picked identities never silently substitute another model.

Natural-language requests remain expressible through Task.model.
`modelSelection` distinguishes preference from exact requirement; neither is
human approval. The runtime does not accept an AI-authored "user approved" flag.

Keep successful tool history when a running delegate changes provider. Do not
replay a task or completed tools to accomplish fallback. Record requested and
actual models plus skipped/selected reasons in the existing Task result and
settlement snapshots; existing usage and timing remain intact.

### Amendment: live policy and recoverable consent center

An asynchronous center is needed because independent requests arrive while the
user reads another task or continues the parent conversation. One-request modal
queues obscure pending work and make dismissal ambiguous; ambient approve-all
would extend consent to requests the user never reviewed. Group live requests by
source project/session, append without taking focus/scroll/selection, and freeze
an explicit ID/revision snapshot for each selected batch. Each call has its own
ACK/error; failed live items remain retryable. Collapse/close/Escape sends no
decision. Only explicit cancellation ends the invocation, with structured parent
feedback and no same-task retry or model switch.

The compact list expands horizontally into a constrained two-column task reader
(approximately 320–360px list plus flexible body), with independent scrolling,
fixed actions/deadline and exact full-task copy. Narrow windows use details/Back
without losing selection or scroll. Short identity/summary headings stay separate
from the task body; source, requested/candidate model and thinking metadata are
visible. Host scheduling facts and optional short modelReason remain distinct.
App-known aliases never claim to establish the remote provider's true backend.

Dedicated `delegationApproval` list/respond/extend/changed channels prevent a
plugin identity or generic UI response from granting core model consent. Shared
DTOs bind actions to a host-owned revision and deadline. Allow once, authorized
alternative, exact selection and cancellation are distinct. Host and runtime
revalidate authority/capabilities; changed task/candidate/policy revisions retire
old consent. Subscribe-before-list and terminal tombstones prevent stale reloads
or ACKs from reviving work. Acknowledgment means consent accepted, independently
of capacity or execution start. Ordinary extension approvals retain their UX.

New/default settings seed 300 seconds without rewriting saved 0–300 values.
Explicit extension adds exactly 300 seconds to the live deadline and returns a
new revision; no arrival, viewing or scroll renews it. Timeout restricts this
invocation to compatible `auto` candidates or a clear timeout result.

Current policy/catalog/description/priority applies to later admissions in the
same long turn, later resumes, pending approvals and natural fallback. The
additive `provider.delegationSnapshot` callback carries settings, opaque revision
and available model keys; the parent catalog refreshes at a request boundary.
An active child retains its provider and three-field `runPolicy`
(`maxToolCalls`, `maxDurationSeconds`, `finalReportTimeoutSeconds`). Saved changes
never interrupt/recreate work or rewrite an in-flight provider payload. Existing
checkpoint compatibility remains intact.

Manual retry preserves retained history/checkpoints and successful tools. While
the child runs, the same durable turn accepts steering through one parent loop.
Settlement feeds one parent continuation and exactly one durable finalization;
Stop still cancels the child and joins cleanup. This keeps the conversation
usable without duplicating child report delivery or parent execution.

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

The acceptance map is
[E2E-DELEGATION-scheduling-and-model-approval](../spec/06-delivery/04-e2e-test-plan.md#e2e-delegation-scheduling-and-model-approval).
Policy/contracts cover candidate authority, action shapes and saved defaults;
runtime user paths cover steering during retry, one continuation/finalization,
exact selection, current-policy admission, auto-only timeout and retained tools.
Host/IPC tests must prove deadline extension, stale consent rejection and
retirement. Component fixtures cover asynchronous arrivals, per-item partial
ACK/errors, source navigation, full-task reader and narrow layouts. This ADR
states required acceptance, not a claim that every integration gate has run.
