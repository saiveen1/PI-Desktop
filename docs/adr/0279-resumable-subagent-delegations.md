# ADR 0279: Resumable subagent delegations

- Status: Accepted for implementation
- Date: 2026-09-17
- Amended: 2026-11-04 — durable progress reports and explicit recovery after cancellation
- Amended: 2026-11-05 — visible scheduling run policy and immutable task snapshots
- Amended: 2026-11-07 — user continuation rejoins parent-interrupted chains; retry can join an active turn
- Amended: 2026-11-26 — distinguish proven same-session unretained chains from unknown IDs
- Deciders: PI-Desktop core
- Related: [ADR 0062](0062-bounded-subagents-behind-a-task-tool.md) ·
  [ADR 0089](0089-proactive-background-subagent-delegation.md) ·
  [ADR 0119](0119-event-driven-subagent-timeouts.md) ·
  [ADR 0165](0165-withdraw-a2a-peer-stack.md) ·
  [03-runtime/02-agent-runtime.md](../spec/03-runtime/02-agent-runtime.md) §5f
- Amends: ADR 0062 (the `Task` tool contract) and ADR 0089 (the delegation
  lifecycle). Both are preserved; this adds one opt-in parameter and one piece
  of bookkeeping.
- Tracking: #513

## Context

ADR 0062 and ADR 0089 spawn one single-use `SubagentRun` per `Task` call,
starting from `messages: []`. A delegate's rows persist with `parentToolCallId`
and `agentName`, but nothing reads them back into a delegate and the session
runtime skips them when rebuilding model context, so every `Task` call is a cold
start even when the parent delegates the same subagent for the same files twice.

## Decision

`Task` gains an opt-in `resume` parameter; when present the new delegation is
seeded with the prior delegation's reconstructed context instead of starting
empty.

### 1. `Task` gains `resume?: delegationId`

Resolution is by `delegationId` only, the id `Task` already returns and
`TaskWait` accepts, with a stable internal `delegateSessionId` chaining runs and a
reverse map that also resolves ids from the middle of a chain.

### 2. Chains, not records, are the unit of resumability

A chain is one `delegateSessionId` plus its ordered `Task` toolCallIds, and
reconstruction selects every child row whose `parentToolCallId` is in the chain
with a matching `agentName`. `DelegationRecord` gains `delegateSessionId`, plus
`resumedFrom` and `modelChangedFrom` when a run continues a chain.

### 3. Context reconstruction is a pure function

`packages/agent-runtime/src/delegation-history.ts` selects the chain's rows,
synthesizes the original `task` as the first user message from the first `Task`
row's arguments, converts with the delegate's own binding, and gates on a read
budget. Transport identity is `model.provider` / `model.id`, not the account row
id, which would make restored same-model reasoning look foreign; `SubagentRun`
gains `initialMessages?` and is otherwise a normal run under
`MAX_SUBAGENT_CONCURRENCY` with its own `delegationId`, report, and counters.

### 4. Validation is visible, never thrown

`resume` is validated before the run starts; every failure is a tool error the
model can act on:

| Condition | Outcome |
|---|---|
| known in reliable same-session history but no longer retained for resume | Report that the chain is no longer retained for resume, plus the current resumable list; do not start a new delegation |
| unknown id, including an id from another session | `Unknown delegation "<id>"` plus the current session's resumable list |
| still running | `Delegation <id> is still running`, call TaskWait first — a resume is never queued |
| `stopped` / `aborted` | explicit resume permitted after retirement; never automatic |
| `interrupted` (the app closed mid-run) | explicit resume from retained transcript/checkpoint |
| `Task.agent` differs from the chain's agent | name mismatch, lists available |
| `Task.model` present on a resume | exact retained `providerId/modelId` repeats are treated as omitted; model/account changes and unverifiable identities are rejected |
| large retained history | existing model-context seeding bounds call/result pairs; read volume alone does not reject resume |
| the chain resolves but has neither rows nor a validated checkpoint | the chain is dropped and reported as having no recorded history; the same id is never listed as reusable |

The distinction requires reliable evidence that the ID belongs to a previously
existing chain in the current session. An arbitrary ID, an ID from another
session, or an ID whose same-session history cannot establish that fact remains
unknown. History lookup must not disclose whether another session contains the
ID. Recognition is limited by available reliable history; it is not a promise
to identify every formerly retained chain. Neither refusal automatically
redispatches work.

A resume keeps the chain's own model binding. The `providerId/modelId` key the
chain recorded is preferred; a chain rebuilt from the transcript only knows the
model id, which is matched only against the current definition's pin/fallbacks,
the session binding, and currently authorized overrides. A remembered key whose
turn grant expired is reauthorized before use; a denied key cannot select another
account by model id. Other definitions' private pins are never candidates (#841). Changing the
parent's own session model therefore does not strand a chain, and a delegate never
swaps models by accident. If nothing resolves the recorded binding any more, the
run continues on the binding the definition resolves to now and records the
previous model id in the delegation's lifecycle details as `modelChangedFrom`:
refusing instead would strand the chain forever, and swapping silently would hand
the same conversation to a different model with no trace.

Amendment (2026-11-12): a redundant `Task.model` must not strand a reusable
chain in a parameter-error loop. Trim outer whitespace, then compare against
the recorded key, or the independently resolved resume binding when a restored
chain has no key. Never use this field to resolve a provider on a resume.
Matching repeats follow exactly the omitted-model path, including fresh pool
membership, authorization, fallback, cancellation, and concurrency checks.
Different accounts remain distinct even if their model ids match. Missing or
unverifiable identities fail with an instruction to omit `model`; they are not
guessed or silently accepted. This is an additive admission relaxation with no
storage or protocol-version change.

### 5. Cancellation ends execution without destroying explicit resume

Completed, failed, stopped, aborted, interrupted and legacy timed_out chains
can be continued explicitly after they retire while they remain retained and
eligible for resume. Stop still cancels current work and never triggers a new
provider request. This separates permission to run now from the ability to use
saved findings in a later authorized Task invocation.
Model authorization and tool permissions are rechecked on that new invocation.
A parent failure keeps SUBAGENT_PARENT_FAILED; user Stop keeps its aborted or
stopped status. Recovery does not relabel cancellation as a provider failure.

### 6. One live record per chain, ever

A chain has at most one running record at a time; a model-originated `resume`
while it runs is rejected with the TaskWait error above. The
[direct input amendment](subagent-controls-and-direct-input.md) allows explicit
user messages to that existing worker at a safe boundary, or a normal resumed
run after settlement. It never forks a chain or creates overlapping workers.

### 7. Resumable chains are bounded, LRU, per agent name

`MAX_RESUMABLE_CHAINS_PER_AGENT = 2`, chains are exempt from
`pruneFinishedDelegations`, and exceeding the bound evicts the least-recently-used
whole chain at settlement, registry entry and reverse-map entries together. A
chain whose latest run still works is never evicted and does not count against
the two settled-chain limit. Eviction removes resumability, not necessarily the
historical report. Reliable same-session history may still establish that an
ID was previously known without retaining the chain for resume; it need not
recognize every evicted ID.

### 8. Bound the replay context rather than rejecting large chains

ADR 0299 already bounds seed messages and compacts live delegate context.
Cumulative read volume therefore no longer prevents resume; a 50001-line audit
must not discard its findings just because it was expensive. The existing seed
projection removes old tool call/result pairs together and retains the original
task. The validated report supplements that bounded context. Read counts and
file lists remain telemetry, and the two-chain LRU retention limit is unchanged.

### 9. The parent discovers a resumable list through `TaskList`

`TaskList` reports delegation status and includes a current resumable list with
agent name, delegation id, objective, and files read. That list contains only
settled reusable chains, not every historical report. A report remaining readable
does not make its chain resumable. The list stays out of the system prompt
because it changes on every settlement and would invalidate the cached request
prefix (ADR 0337); a failed resume names the currently reusable IDs in its own
error.

### 10. Same session only

`resume` resolves only against the current session's transcript; sharing facts
across conversations stays in the prompt (ADR 0165).

### 11. Definition edits take effect on resume, with a diagnostic

An edited definition applies as-is on resume, matching the catalog's "editing
takes effect on the next prompt" semantics, and the change is recorded in the
delegation lifecycle details without storing a snapshot.

### 12. Chain index is rebuilt from the transcript on startup

Persisted `Task` arguments carry resume links. Launch rescans and rehydrates the
chain index, normalizes names (`Explorer` / `explorer.md` → `explorer`) and uses
each settled Task row's recorded status. A row still `running` after shutdown
rebuilds as explicitly resumable `interrupted`, never a live worker. Legacy rows
without status remain settled. Restored bindings use recorded model identity
and the authorized resolution rules in §4; restart supplies no new consent.

### 13. The transcript renders a chain as one continuous conversation

A resumed card shows the chain's rows as consecutive task and reply turns with no
"resumed" badge, counters start at zero, and `details.resumedFrom` keeps the link
auditable.

### 14. Durable progress before enforcing a work budget

The observed audit spent hundreds of calls and then lost its only deliverable
on cancellation. A hard timeout alone would make that failure happen sooner.
The runtime saves state throughout execution independently of model behavior.
TaskReport is an optional summary tool; calling it is never a prerequisite to
continue work. The earlier trial's periodic report gate and missing-report
termination counter are removed: a fixed cadence favored some model/workflow
patterns and imposed new failure modes without improving durable recovery.

Scheduling exposes three resource settings: an optional tool-admission limit,
an optional duration limit, and the bounded final-report deadline. The two work
limits default to 0 (disabled). A configured budget ending reserves one tool-free
report request, default 60 seconds; failure to produce that report still returns
retained partial output. Explicit cancellation skips the extra request. This
contract does not depend on a model completing a task within a presumed number
of steps or summarizing on a prescribed schedule.

Shared defaults/ranges, Rust write validation, next-parent-turn propagation and
immutable per-run snapshots make the active resource policy visible. Model
summaries are subject to the same explicitly configured tool budget as other
admitted tools. Automatic persistence consumes no model request or tool slot.
Legacy checkpointInterval/maxCheckpointRequests fields are accepted as historical
data but ignored on execution and dropped from new resolved settings/snapshots.
Existing explicit work budgets and old reports remain intact.
A budget result is failed/partial with SUBAGENT_BUDGET_EXHAUSTED and can resume.

An existing context-compaction summary is reused in the recovery report as
plain text; saving it makes no additional model request.

Session transcript remains host-core owned. The Node runtime writes only its
session scratch artifacts, as it previously did for long reports. The versioned
JSON report and Markdown projection are individually atomically replaced. Reads
are path-derived, size-bounded and identity-validated; no serialized Agent or
permission state is loaded. TaskWait can recover reports after a restart without
spawning a child. No new SQLite schema or parent IPC contract is needed.

Alternatives rejected: restoring a raw Agent dump would couple storage to
provider internals and duplicate the host transcript; a general tool-side-effect
guard would broaden this change without fixing lost reports. Costs are local
checkpoint writes and optional summary tokens. Disk errors remain visible and
local artifacts require scratch availability. A process killed between tool
boundaries can retain incomplete results, so resumed work must verify uncertain
side effects. It never automatically replays an interrupted write.

### 15. Recovery belongs to the continuing parent turn

Parent failure still cancels its workers and releases the failed turn. The next
ordinary user prompt recovers that preceding failure's retained chains through
the same admission path as the Desktop retry control. This repairs the gap where
Continue resumed only the parent and left its children stranded. Restored history
selects SUBAGENT_PARENT_FAILED only within the latest failed parent turn; explicit
cancellation, unrelated failures and completed work remain excluded.

Manual retry joins an active parent turn rather than opening a competing turn;
an idle retry retains its existing dedicated recovery lifecycle. One chain-owned
admission coalesces automatic and manual requests, holds ownership during consent,
and is cancelled on Stop/dispose/failure. A stale active-turn request fails without
ending or replacing the parent. Existing model authorization, bounded history,
checkpoints and worktree ownership remain authoritative. Completed tools are not
replayed. Ordinary Task/resume still rejects resuming a running delegation.

This avoids both rejected recovery during a busy parent and duplicate workers
from automatic/manual races. It deliberately does not keep workers detached from
a failed parent, infer a user's intent from prompt text, or automatically retry
on failure/boot. Wire shapes and storage versions are unchanged.

## Consequences

- `Task`'s schema widens by one optional field, and `resume` omitted is exactly
  today's behavior.
- The delegate→parent boundary is untouched: reconstructed rows seed only the
  delegate's context, and `parentToolCallId` rows are still skipped when the
  parent's context is rebuilt.
- No new storage schema, tables, or event types. Chain identity, read tracking,
  and the model binding live on the in-memory chain; `resumedFrom` and
  `modelChangedFrom` ride the existing lifecycle details projection.
- A resumed run is billed and bounded exactly like a fresh one — same concurrency
  slot, same permission scope, same fallback models, same abort sources.
- Large histories use bounded seeding; partial results remain explicit and can be
  resumed only while their chains are retained and eligible.

## Out of scope

- Cross-session resumption or automatic replay of interrupted side effects.
- Queuing model-originated Task/resume calls on an already running chain; explicit
  user follow-up uses the separate direct-input contract in §6.
