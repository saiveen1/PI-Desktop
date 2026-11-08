# ADR: Subagent failure policy and direct user input

- Status: Accepted
- Date: 2026-11-08
- Scope: Local Desktop delegation controls
- Amends: [ADR 0279](0279-resumable-subagent-delegations.md) sections 6 and 15
- Related: [agent runtime](../spec/03-runtime/02-agent-runtime.md),
  [IPC](../spec/03-runtime/01-ipc-protocol.md)

## Context

Provider retries can delay fallback, especially with an inherited unlimited
retry policy. Users cannot distinguish waiting for a provider from waiting for
another model's authorization. A child transcript also looks like a chat but
its disabled input cannot correct ongoing work. Finally, a Task skipped for
new parent input is rendered as an actively coordinated task despite never
starting a worker.

## Decision

Scheduling gains an optional `failurePolicy` with modes `inherit`, `stop`,
`retry`, and `fallback`, plus bounded `maxRetries` (0–10) and `maxFallbacks`
(1–10). Absence means `inherit` and preserves existing session retry behavior;
legacy data is not rewritten on read. The settings editor starts from inherit
with draft limits of two retries and two switches. Explicit modes override
session infinite retries. Stop performs neither automatic retries nor model
switches. Retry performs only bounded same-model retries. Fallback permits
bounded retries followed by compatible, authorized alternatives. Exact-model
selection and the allowed model pool still constrain all alternatives. Tool
errors and elapsed time without a tool call do not authorize switching. Policy
is snapshotted per child admission and shown with its effective configuration.

Direct user text is addressed to an existing delegation chain in the same
session, through the new local `agent/subagent/message` IPC channel. Active
workers use the existing Agent steering queue at a safe boundary without
force-aborting tools. Settled chains resume through the ordinary Task history,
checkpoint, model authorization and worktree path. Each chain still has only
one live execution; ordinary model-originated Task/resume of a running child
remains rejected. This adds direct user input, not child-to-user approval tools
or cross-session agent collaboration.

A request carries a stable message ID and at most 32000 text characters. The
runtime coalesces transport retries and serializes distinct inputs to one chain.
Accepted child input is retained through the existing transcript/outbox path;
Stop ends execution but does not discard that input. Receipt identities are
stored as child user-row IDs or direct-message synthetic Task call IDs, so a
restored transcript rejects a replay or conflicting reuse of the same ID.
This is not an exactly-once external-side-effect guarantee: callers must inspect
uncertain interrupted tool effects before repeating them, and an unacknowledged
outbox write may still need recovery after process loss.

Active parent turns accept child input without being replaced. Idle sessions
start a dedicated recovery turn, which consumes the child report and closes
once. The parent receives an input-arrival notice and the eventual report, not
a copy of the running child's entire conversation. Pending admission belongs
to the parent owner and remains cancellable. Native and remote sessions stay
outside this local-only surface. Opening a transcript or booting Desktop never
restarts a child; sending to a stopped/failed child is an explicit recovery act.

Skipped Task records stay auditable, but display as not started because new
input arrived. They do not contribute to active coordination counts and do not
show a misleading execution duration. No automatic redispatch is added.

## Compatibility and consequences

Settings are additive optional JSON validated by the Host; storage schema and
protocol version remain unchanged. The IPC whitelist gains one typed channel.
Existing child rows and Task records remain readable. No renderer owns runtime
state or accesses SQLite, and no user message may change a child's permissions.
A model switch retains completed tools and prior context rather than rerunning
them. The new composer reuses the existing subagent transcript and shared UI
primitives instead of adding a separate global panel or another conversation.

## Validation

Use controlled model streams and Host boundaries for active input, terminal
resume, duplicated and conflicting requests, authorization races, cancellation,
retained input and parent report delivery. Test failure-policy validation in
TypeScript and Rust and exercise actual retry/fallback budgets without provider
calls. Renderer tests cover drafts, stale acknowledgments, failure states,
latest-chain targeting and skipped/running mixed topologies. Real accounts and
the daily Desktop profile are not acceptance fixtures.
