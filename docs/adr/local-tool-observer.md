# ADR: Local tool observation and developer review

- Status: Accepted
- Scope: Additive Desktop diagnostics IPC and background settlement telemetry

## Context

Tool execution already produces bounded, redacted local logs. A user should not
have to discover repeated failures manually or put platform advice into every
model request. Existing tool logs do not expose structured nested result fields,
and background launch receipts do not represent process settlement.

## Decision

Reuse the existing `app/tool` NDJSON log and its two rotations. Add an allowlisted
`data.observation` to the existing completion/interruption record; observe native
session tool events without changing their persistence owner. Add one Host
`backgroundTasks.settled` notification after terminal state publication and pipe
drain. No output, command, workspace, environment, or free-text failure reason is
included. Main logs a separate lifecycle record and joins it to a launch by task
and session IDs. No database table, schema migration, timer, or model observer is
introduced.

A Main-owned `diagnostics/toolObservations({days:1|7|30})` channel reads only the
fixed tool logs. Developer mode is checked before and after asynchronous reads.
Inputs cannot select filesystem paths. Reads reject non-regular files and paths
resolved outside the expected log directory; bytes, rows, groups, and examples
are bounded. The returned contract is `ToolObservationReport` in shared.

The Settings developer section displays fact groups, coverage and examples. A
user may append a bounded selected report to the active eligible conversation's
draft. Existing draft text/attachments are preserved; no session is created and
no message is sent automatically. Collection does not add model context. The
explicitly referenced report does become model input when the user sends it.

## Semantics and safety

- Tool errors and command nonzero exits are distinct. Nonzero, permission denial,
  timeout, cancellation, and unknown results are not proof of a harness defect.
- A background launch is not success; once its terminal record is present the
  report does not count the launch as another execution.
- Grouping is correlation, not root-cause analysis or a recovery claim. No
  automatic retries, command rewriting, provider calls, or upload occurs.
- Only allowlisted structured scalars are retained. Arbitrary output is never
  parsed for error keywords. Reading a report does not open transcripts.
- Platform identifies the observing Desktop, not a remote host's operating system.
- Existing logs and unknown outcomes cannot be retrospectively reconstructed.
  Coverage reports bounded/legacy/malformed/unreadable data explicitly.
- Normal logging remains independent of developer UI visibility. Rotation and
  log failures retain the existing non-fatal behavior.

## Consequences

The report is immediately useful for repeated structured failures without a new
telemetry service. It cannot detect every semantic/model error or establish why
an unrelated later call succeeded. Short, rotating local retention and metadata
minimization intentionally trade forensic completeness for privacy and bounded
cost. Full diagnostics remain an explicit, separately authorized investigation.
