# ADR: Preserve execution continuity across successful compaction

- Status: Accepted
- Date: 2026-11-13
- Amends: ADR 0064 / ADR 0136 (successful active-turn retention)
- Preserves: ADR 0302 fallback recovery, runtime-owned initiation, host-owned storage

## Context

Successful compaction summarized the complete range but retained only the latest
user request. Recent assistant progress and tool receipts disappeared from the
next provider request. A summary could omit a result, and even a correct summary
could be followed by repeated setup or completed work. Keeping the visible
transcript intact did not preserve the model's execution position.

The text summary adapter also kept only the beginning of long tool results,
which could remove final success/error receipts, and silently omitted images.
These are Desktop-owned transformations, not evidence of a provider's internal
compaction behavior.

## Decision

A successful `active_turn` checkpoint retains the active run's user goal,
same-turn steering messages and a bounded recent execution window. The existing
run-start boundary distinguishes steering from older completed tasks; without a
live boundary the preparation conservatively starts at the latest user message.
The keep-recent budget bounds the combined tail. The initial goal receives at
most half that budget and the existing 20,000-token user cap; the remaining room
goes to recent execution and steering. Older tasks stay in the summary.

Retained batches preserve original tool names, call IDs, arguments, result order
and error flags. Calls without recorded results, orphan results and assistants
already excluded from replay are not reintroduced. Text in the boundary batch
may be shortened with an explicit middle-cut marker, preserving both ends. If
opaque arguments/images cannot fit, the batch is omitted as a unit rather than
modified or sent over budget. The whole range still enters the summary input.
Assistant usage is cleared in the retained copies because it measured the old
request, not the compacted context. The full transcript is never modified.

The tail also has a 16 MiB serialized-byte ceiling below the Host's 64 MiB
request frame. Duplicate non-provider tool-result details are omitted, while
ToolSearch activation markers remain available for restore. Images in a user
goal are preserved when trimming text alone is sufficient; image omission is
explicit when the images themselves cannot fit. Existing wire-ID repair runs
before pairing. Steering inserted inside a batch follows the completed pair in
the provider view, so it never separates a call from its result.

The checkpoint uses the existing `details.retainedTailShape = "recent_window"`
marker so live continuation and restart replay the same tail. Successful
`completed_turn` checkpoints and the `fresh_window` family retain no tail.
Legacy unmarked records keep their existing conservative normalization; they are
not retroactively reconstructed or rewritten. No database schema, IPC field,
permission boundary or storage ownership changes.

Summary input keeps both ends of long tool output within the existing character
caps, including the reduced-input pass. User images are identified as present
but not visually included in that text input. The summary instructions distinguish
plans, verified completion, failure and unknown outcomes, and preserve the next
unfinished action. The continuation wrapper explicitly says a checkpoint is not
a new task: do not restart setup or repeat completed operations merely because
context was compacted; reconcile uncertain side effects before retrying. Necessary
revalidation and a later user instruction remain allowed.

The existing complete-request hard-budget guard, abort handling, persistence
failure behavior, overflow retry and automatic fallback remain authoritative.
There is no semantic command deduplication, exactly-once side-effect guarantee,
new setting, provider request, or automatic replay of external work.

## Alternatives and consequences

Only strengthening the summary prompt leaves recent receipts dependent on lossy
summarization. Keeping all history defeats compaction. Blocking matching command
strings would prevent legitimate verification and cannot establish whether two
commands have equivalent side effects. A bounded raw execution window plus an
explicit continuation contract is the smaller coherent fix.

Continuation requests and checkpoint records can be larger than under user-only
retention, within existing budgets. Older details may still be summarized or
truncated, and a model can still ignore context. The change removes a concrete
source of task-state loss; it does not prove live-model compliance.

## Verification

Offline tests drive the production Agent loop through a completed synthetic tool
call, successful compaction with an intentionally incomplete summary, and the
next provider request. They inspect the retained original call/receipt and the
continuation wrapper, then JSON-round-trip the checkpoint through a new runtime.
Unit coverage checks parallel batches, output endings, strict tail budgets,
failed/missing results, immutable source history, cleared usage and successive
checkpoints. Existing completed-turn, legacy-restore, fallback, overflow,
hosted-search and reasoning-replay coverage remains applicable.

See [runtime specification](../spec/03-runtime/02-agent-runtime.md),
[storage specification](../spec/03-runtime/04-data-storage.md), and
[E2E scenarios](../spec/06-delivery/04-e2e-test-plan.md).
