# ADR 0189: Parent fatal error aborts leftover delegates

- Status: Accepted for implementation
- Date: 2026-09-08
- Amended: 2026-11-07 — resume retained interrupted chains on the next user continuation (ADR 0279 §15)
- Deciders: PI-Desktop core
- Related: D352, D328, ADR 0166, ADR 0089, E2E-155

## Context

D328 / ADR 0166 keep a durable turn open when the parent idles with running
delegates, which is right for a parent that merely stopped calling tools. After a
terminal parent error the turn ends as `error`, yet leftover delegates kept
`isRunning` true, so Continue was rejected as `AGENT_BUSY` while the conversation
looked finished.

## Decision

### 1. Parent idle still does not abort delegates

D328 is unchanged for a parent that stops calling tools without a fatal error.

### 2. A terminal parent error aborts leftover delegates

Exhausted rate limits, other terminal provider or stream errors, overflow-recovery
failure, mutation-budget termination, and rejected-prompt failures abort running
delegates, skip the resume prompt, and emit `agent_end`.

### 3. The session becomes idle for Continue

`getStatus().isRunning` ignores leftover delegates after `turnHadError`; the failed
TurnOutcomeCard stays visible and a later `agent_end` must not overwrite it.

### 4. A later prompt inherits no still-running earlier delegates

Each `prompt()` / `executeApprovedPlan()` bumps a turn epoch and retires earlier
workers. An ordinary user continuation can rejoin only the preceding failure's
retained `SUBAGENT_PARENT_FAILED` chains, after retirement and through normal
authorized resume admission (ADR 0279 §15). Those workers belong to the new
epoch and only its reports auto-deliver. Cancelled/completed workers do not
automatically restart; recovery does not overlap workers or relabel cancellation.

## Consequences

- Continue is accepted after a 429 even while an unrelated subagent was running.
- Unreported delegate work is aborted instead of landing in a dead turn.
- Idle parents with live delegates still show a live turn until reports arrive.

## Alternatives

- Detach leftovers from `isRunning` without aborting: rejected because a later
  turn would race them on the workspace.
