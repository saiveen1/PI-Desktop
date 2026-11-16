# ADR 0207: Allow Three Same-Path Mutation Recovery Failures

- Status: Accepted
- Date: 2026-09-10
- Related: D186, D379, ADR 0087, E2E-140, E2E-141

## Context

The line-anchored mutation guard terminated a prompt after two counted failures
for the same path, although the first failure usually exposes a syntax, range,
or provenance correction and the second can be the agent applying it.

## Decision

Amend D186 and ADR 0087: a prompt may make three counted failed `Edit` calls on
one path, and a recognized shell patch command shares that limit under its
patch-command key. The first two failures return their error-specific recovery
hints and leave the turn running; the third carries `terminate: true` and
finalizes the assistant row with `MUTATION_RETRY_BUDGET_EXHAUSTED`. Recoverable
codes keep one per-code grace, counters stay scoped to the prompt and path, a
successful mutation clears that path's history, and provider retry and
concurrency budgets are untouched.

### Delegate ownership correction (2026-10-07)

The prompt scope is the executing agent, not the whole session, so recovery keys
include the parent or delegation owner instead of letting concurrent delegates
spend one another's attempts. Settlement releases a delegate's counters and
graces, a terminal tool error is carried into the delegate result, and the
failed chain stays resumable through the existing Task flow.

### Write and ordinary command recovery

The original guard allowed repeated Write failures and ordinary shell failures
to consume unlimited model turns. The same owner-scoped guard now includes
Write under its canonical path, and ordinary Bash under a digest of exact
command text. Ordinary command counting requires an unchanged diagnostic
signature; a different error restarts the count. A successful command clears
its own history, and a successful Edit, Write, or recognized patch clears that
owner's ordinary-command history to permit a build/test after a fix. Read
success does not count as corrective progress. Denial and cancellation are
excluded, and no automatic command replay is introduced.

The public error code remains `MUTATION_RETRY_BUDGET_EXHAUSTED`; the open-ended
error details add `write` and `command` kinds. Recovery copy distinguishes them,
and locale messages describe editing or command failures. A small runtime
helper owns the counters instead of extending the central runtime's branch
chain. Parent reset and delegate disposal retain their existing ownership.

Counting every Bash failure together was rejected because independent commands
and legitimate debug iterations would terminate each other. Parsing stderr to
classify arbitrary commands was deferred: exact signatures give a conservative
bound without guessing shell semantics. Changes made outside these tools are
not observed; a new user prompt starts a fresh parent budget.

## Consequences

- The model gets one additional bounded opportunity to correct an Edit or
  recognized shell patch failure.
- Persistent or guessing mutation loops still terminate deterministically.
- The runtime error message and every shipped locale must say three failures.
- No IPC, storage, Host protocol, or tool result shape changes; error details
  accept the additional recovery kinds.

## Alternatives

- Keep the two-failure limit: rejected because the second correction attempt can
  still be an honest recovery after a distinct first error.
- Remove the limit: rejected because malformed or blind mutation loops must not
  consume an unbounded turn.

## Verification

- Runtime unit tests cover Edit, shell patch, per-code grace, reset after a
  successful mutation, and the visible terminating error row.
- `runtime-tool-recovery.test.ts` drives real Agent loops with synthetic
  provider/Host boundaries: Write/Bash terminate after three failures, emit a
  visible error, and accept a follow-up. It also covers changed diagnostics,
  fix-then-retest, cancellation, refusals, and owner isolation.
- E2E-140 and E2E-141 document the third-failure boundary.

### Admission pressure and reveal progress (2026-11-08)

Counting Host capacity failures as malformed edits encouraged the model to
rewrite valid patches. Admission failures now have a separate three-attempt
owner/class budget with HOST_OVERLOADED termination and capacity guidance.
The bound prevents infinite retry loops without pretending the edit ran.
Reads cannot erase blocked-writer pressure, and success in the same capacity
class releases that class's counter. No automatic replay is introduced.

A sequence of complete unseen-line reveals can add real context while still
repeating the same error code. The guard retains per-code grace and recognizes
new line/content pairs, storing digests only, for at most eight progress graces
per path before ordinary counting resumes. Reordered or partial reveals are
not progress. This modest finite allowance supports iterative inspection without
opening an unlimited model loop; successful file work resets it. The UI projects
structured reveal results as context requests but never rewrites their failure
status or applies a patch before the model reviews the evidence.

Real Agent-loop and helper regressions cover admission versus mutation counts,
owner isolation, follow-up prompts and complete/repeated/truncated reveals.
Production tool-row fixtures cover localized context status and unchanged errors.
