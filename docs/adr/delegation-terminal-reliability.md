# ADR: Truthful delegation delivery and bounded recovery

- Status: Accepted, implementation candidate
- Date: 2026-11-07
- Related: [Resumable delegations](0279-resumable-subagent-delegations.md),
  [Provider retry](0128-bounded-transient-provider-retry.md),
  [Scheduling and approval](delegation-scheduling-and-approval.md),
  [Runtime specification](../spec/03-runtime/02-agent-runtime.md)

## Context

A delegate could retain text emitted before a tool call and later return it as
its final report after an empty response. Truncation was updated only beside
non-empty text, so an empty output-limit ending could also become successful.
The retained text was useful recovery evidence but was not proof of delivery.

Admission had a separate deterministic mismatch: Task allowed a context minimum
of zero, while Host authorization metadata required a positive integer. A valid
no-minimum request could exhaust an automatically permitted model pool under a
generic authorization-unavailable error.

Existing provider recovery deliberately excludes permanent 400/422 failures.
A generic upstream wrapper alone does not establish a permanent request defect
or a transient outage. Retrying all 400s, especially under unlimited transient
retry, would replace a visible failure with unbounded requests. The historical
upstream failure's cause remains unknown.

## Decision

Keep runtime ownership of delivery and recovery. Track retained progress
separately from the latest terminal response. Successful delivery requires a
current normally stopped, non-empty text response without tools. Inspect finish
and truncation state even when no text was returned. Retain partial progress,
tool history and checkpoints on failure; no text-length quality heuristic or
mandatory TaskReport cadence is introduced.

Add optional `delegation.runPolicy.reportRecoveryAttempts`, integer 0 or 1,
default 0. Enabling it permits one tool-free report request after ordinary
termination without a deliverable, using the run's authorized model and existing
final-report deadline. It cannot trigger retries, output-limit repairs, fallback
or tool replay. Cancellation and terminal execution/provider errors do not
start it. The existing configured-budget closure remains a failed partial
result and does not stack with ordinary report recovery.

Add optional global `unknownUpstreamRetryLimit`, integer 0-3, default 0, for
generic upstream 400/422 wrappers without explicit permanent evidence. Main and
child requests use an independent response budget and existing abortable backoff.
Unlimited transient retry does not widen this budget. Only the failed request
is retried; successful tools and parent/child ownership remain intact. Terminal
parent failure still cancels owned children and preserves explicit resume.
This global limit follows portable application configuration sync and is
validated before importing it. Delegation run policy remains installation-local.

Normalize Task's zero context minimum to omission before authorization. Validate
positive values as safe integers no greater than 10000000 on both sides. Reject
malformed request metadata distinctly and before traversing the model pool.
Model eligibility, exact selection and user cancellation retain their own
outcomes.

Expose factual live counters and a compact terminal diagnostic through existing
Task results, lifecycle persistence and checkpoint records. Keep requested and
actual model identities, selection decisions and model failures distinguishable.
Persist only allowlisted stop reasons, content/tool counts and report outcomes;
do not log thinking text, credentials or replay material. Approval accepted,
execution started, stop requested and final delivery remain distinct states.

### Amendment: bounded runtime observations and consumer delivery

The [observation contract](../spec/03-runtime/delegation-observability.md)
adds allowlisted version-1 observational facts to the existing Task/checkpoint
records and canonical Host history projection. Actual request attempts,
authorization, tool evidence, execution end, report production and parent
delivery remain separate. The 30-second diagnostic window does not terminate
work or impose periodic model reports. No new state authority, tool replay,
approval capability, IPC channel or SQLite migration is introduced.

## Consequences

The changes add optional settings and diagnostic fields without changing SQLite
ownership, the process model, consent boundaries or the status vocabulary. New
readers accept old settings and three-field execution snapshots; they do not
invent unrecorded historical recovery policy. Existing version-1 settings are
not rewritten merely by opening the editor. Older binaries with strict policy
validation may reject newly saved fields; this decision does not promise
transparent downgrade compatibility.

The default adds no report-recovery or unknown-error provider requests. Opt-in
recovery can add usage, remains bounded and exposes its outcome. Long-running
read-only work remains legitimate: tool counts, repeated paths and lack of writes
do not establish non-convergence. Existing optional work budgets retain their
zero-as-unlimited meaning and supply bounded closure when configured.

The renderer displays these facts, runtime owns execution, and Host owns durable
session data and native controls. Existing stop selector compatibility and core
notification preferences are reused. This record describes the implementation
candidate; final integration verification is pending and does not imply a tested
installed application, physical audio or a successful real-provider replay.

## Alternatives

- Ask the parent to monitor, correct and retry delegates: rejected because the
  failure belongs to the runtime boundary and would add model-dependent duties.
- Evaluate every response with another model: rejected because structural
  delivery can be checked locally and evaluation would add cost and new failure
  paths without proving task quality.
- Retry every 400/422 or silently enable recovery: rejected because permanent
  input failures and unknown wrappers require different policy.
- Infer non-convergence from read/write counts or impose a hidden deadline:
  rejected because useful analysis can be read-only and user budgets are explicit.
