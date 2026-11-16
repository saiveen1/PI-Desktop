# Delegation observations, measurements, and reminder delivery

Status: implementation candidate. This extends [the agent runtime](02-agent-runtime.md#5f-subagent-delegation-d201-adr-0062-adr-0089),
[terminal reliability](../../adr/delegation-terminal-reliability.md), and
[canonical history](../../adr/global-delegation-history.md). Execution ownership,
model authorization, parent-fatal cleanup and explicit resume are unchanged.

## Recorded observations

`Task` lifecycle snapshots, `TaskList`, `TaskWait`, local checkpoints and the
Host's read-only history projection carry an optional version-1 `observation`.
It is evidence, never permission or executable recovery context. Old records
without it remain readable; current settings cannot fill historical gaps.

- Account/model identity and actual provider-request attempts retain their
  sequence, start/end, outcome and safe failure diagnostics. Request duration
  measures invocation through settlement, including transport wait; it is not
  pure token-generation time. An `unresolved` attempt means execution retired
  before provider settlement was observed; no finish time, duration or usage is
  invented for it, and a late response cannot rewrite the terminal checkpoint.
- Authorization pending/accepted/rejected/cancelled is distinct from actual
  provider invocation. Initial scheduler authorization precedes child creation;
  child observations cover subsequent fallback authorization. An accepted
  authorization does not prove a human click or provider execution.
- `executionStartedAt` records the first provider invocation, not Task admission.
  `executionEndedAt` is distinct from structural `reportProducedAt` and
  consumer-confirmed `reportDeliveredAt`. Partial checkpoint consumption is not
  delivery of a valid final report. Existing terminal stop/report diagnostics
  remain authoritative for structural completion.
- Activity and observed evidence have separate timestamps. Tool admission,
  repeated output and transport activity alone do not prove useful progress.
  Successful new read-only evidence can advance the observation without writes;
  this is not a semantic assessment of whether a task is converging.
- Retention is bounded: 64 attempts, 64 approval observations, 16 pending tools,
  12 recent tool outcomes and 32 confirmed built-in Write/Edit paths. Omitted
  counts identify incomplete history. Tool evidence retains identities, safe
  paths, counts and outcomes, not shell commands, arguments or reasoning text.
  Unknown effects remain unknown, including interrupted or failed mutations.
  Read-only/file-write classification requires provenance from the runtime's
  built-in tool registry; a dynamic tool with the same name remains unknown.

## Non-progress diagnosis and handoff

The runtime's 30-second observation checkpoint is a diagnostic threshold, not
an execution deadline. Its states distinguish observing, waiting for a tool,
waiting for a model, authorization pending, no new observed evidence and ended.
Pending long-running tools are not labeled deadlocked merely for being quiet.
A diagnostic changes neither retry policy nor configured work budgets, does not
kill the child, adds no model-report obligation and replays no completed writes.

Automatic checkpoints and partial reports include bounded tool evidence,
confirmed write paths and uncertain pending effects. Generic abort/protocol
fragments cannot replace useful retained evidence or become final delivery.
Recovery uses the existing retained transcript and explicit resume/authorized
recovery flow; the user or subsequent agent must verify uncertain effects before
repeating operations. The parent-fatal cleanup boundary remains in force.

## Measurements and historical comparison

The parent writes the child's recorded usage into the canonical Task result.
History exposes actual `startedAt` separately from its `createdAt` sort timestamp,
which can fall back to the original Task row for old records. Input/output/total
token counts are finite nonnegative safe integers. The Host copies only the
bounded observation and selected usage fields, not arbitrary operation payloads.
No second ledger, database migration, protocol version bump or new channel is
introduced by this optional projection extension.

Details and global history show recorded requested/actual model, completion,
elapsed time and output tokens. End-to-end throughput divides positive recorded
output tokens by positive recorded run duration and explicitly includes tools
and waits. Per-request throughput, when shown, uses measured request duration
and also includes transport wait. Neither metric is a claim about pure generation
speed, model quality, or the optimal future model. Missing/invalid/zero-duration
measurements remain unavailable; interrupted owner timestamps are not relabeled
as confirmed child completion.

## Approval sound

Settings > Subagents > Scheduling reuses the persisted core notification policy:
sound inheritance/override, volume 0–100, repeat 0 (once) or 10–300 seconds, and a
preview at the effective draft volume. Merely previewing does not save settings,
resolve consent or start a model request.

Genuinely new live approvals use the effective sound policy. Snapshot hydration
suppresses the initial sound after refresh/reopen, while configured repetitions
remain active. A previously existing request whose update arrives before the
first snapshot is recognized using its Host `createdAt` relative to subscription
start. Revisions and reopening do not create a new identity. Terminal approval,
cancellation, expiry and automatic fallback retire repetitions; asynchronous
stale delivery and disposal cannot restart them. The renderer does not persist a
second consent/notification ledger. Physical speakers and OS audibility require
separate manual verification; isolated tests verify delivery calls and controls.

## Acceptance

See [delegation observation and sound scenarios](../06-delivery/e2e/plugins-and-extensions.md#e2e-delegation-observations-and-approval-sound).
Use real runtime loops with synthetic model transport, isolated Host data and
production renderer components. No installed profile or real provider is a
default test environment. Results are reported separately from installed-app
and physical-audio verification.
