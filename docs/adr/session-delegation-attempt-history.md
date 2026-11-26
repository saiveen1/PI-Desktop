# ADR: Session delegation attempts are not runs

- Status: Accepted
- Extends: [Global delegation history](global-delegation-history.md)
- Contracts: [Renderer IPC](../spec/03-runtime/01-ipc-protocol.md), [Host RPC](../spec/03-runtime/06-host-rpc-protocol.md)

## Context

A parent `Task` tool call can return a terminal result without starting a
subagent. The existing history intentionally lists only runs with a recorded
run identity and status. That remains correct for global history and run
statistics, but hides known unstarted requests from a session's own history.

## Decision

For an exact session query with `all` or `ended`, Host can additionally return
`attempts` from the existing indexed Task candidate window and the owning local
transcript. For an errored parent Task with a resume target and no recorded
run ID, Host reads only `toolResult.details.code`: `DELEGATION_RESUME_UNKNOWN`
means `Unknown delegation.`; `DELEGATION_RESUME_NOT_RETAINED` means
`Resume chain no longer retained.` These summaries match the live Task view.
The legacy unknown-target result (including plain text) must name the actual
requested target; other uncoded resume errors are not inferred. The explicit
new-user-input skip remains supported. A running or nested tool row, approval
receipt, arbitrary tool error, or unrecognized result is not evidence. A
recorded run remains a run even if it failed.

An attempt has a message identity in its requested session and may carry the
original tool-call identity. It never gets a new `delegationId`. Only selected
original arguments are shown, with UTF-16 bounds (1,024 for the agent name and
4,096 for description and task previews). `resume`, when present, is the bounded
requested target, not a resolved delegation. A fixed summary explains the
outcome without exposing raw errors, scheduling data, or reusable-session
lists. Existing scope, project, and deleted-session filters apply unchanged.

`entries` and `attempts` are mutually exclusive projections of the same
candidate window; an empty result may still have `nextOffset`. Global and
`running` pages and pages without matches omit `attempts`; consumers accept
older hosts that never return it. The protocol version, storage schema and
execution/approval authority are unchanged.

## Alternatives

Inventing run IDs would inflate execution statistics and make rejected requests
look actionable. An independent cursor or ledger would duplicate pagination or
persistence without gaining evidence. Matching every Task error would confuse
unstarted requests with authorization, cancellation and real run failures.
