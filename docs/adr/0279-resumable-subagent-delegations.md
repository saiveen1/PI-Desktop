# ADR 0279: Resumable subagent delegations

- Status: Accepted for implementation
- Date: 2026-09-17
- Amended: 2026-11-04 — durable progress reports and explicit recovery after cancellation
- Amended: 2026-11-05 — visible scheduling run policy and immutable task snapshots
- Amended: 2026-11-07 — user continuation rejoins parent-interrupted chains; retry can join an active turn
- Deciders: PI-Desktop core
- Related: [ADR 0062](0062-bounded-subagents-behind-a-task-tool.md) ·
  [ADR 0089](0089-proactive-background-subagent-delegation.md) ·
  [ADR 0119](0119-event-driven-subagent-timeouts.md) ·
  [ADR 0165](0165-withdraw-a2a-peer-stack.md) ·
  [03-runtime/02-agent-runtime.md](../spec/03-runtime/02-agent-runtime.md) §5f
- Amends: ADR 0062 (the `Task` tool contract) and ADR 0089 (the delegation
  lifecycle). Both are preserved — every existing boundary still holds; this
  adds one opt-in parameter and one piece of bookkeeping.
- Tracking: #513

## Context

Delegation as built by ADR 0062 and ADR 0089 spawns one `SubagentRun` per `Task`
call. Each run starts with `messages: []` (`packages/agent-runtime/src/subagent.ts`)
and is single-use. A delegate's transcript rows are persisted — they carry
`parentToolCallId` and `agentName` and land in the session transcript — but
nothing ever reads them back into a delegate, and the session runtime skips them
when it rebuilds model context (`runtime.ts`, `if (m.parentToolCallId) continue;`).

That makes every `Task` call a cold start even when the parent delegates the
same subagent for the same files twice. The context the first run bought —
which files it read, what it found, what it already changed — is discarded, and
the second run pays for it again, or worse, works from a stale file version it
never re-reads.

The pieces to do better are already in place: the rows are persisted with
enough fidelity for a full rebuild (tool call/result pairs, thinking blocks, and
the original `Task` arguments on the tool row), and the session runtime already
contains a `UiMessage[] → AgentMessage[]` converter that produces well-formed
provider messages including synthesized carriers for orphan tool rows.

## Decision

Add an opt-in `resume` parameter to the `Task` tool. When present, the new
delegation is seeded with the prior delegation's reconstructed context instead
of starting empty.

### 1. `Task` gains `resume?: delegationId`

Resolution is by `delegationId` only — the id the `Task` result already returns
and `TaskWait` already accepts. A second, stable internal key
(`delegateSessionId`) exists solely to chain the runs; it never appears in a
tool parameter, tool result, or prompt. The runtime keeps a reverse map from
every `delegationId` issued on a live chain to that chain, so an id from the
middle of a chain resolves too.

### 2. Chains, not records, are the unit of resumability

A **chain** is one `delegateSessionId` plus the ordered `Task` toolCallIds that
belong to it. Each `resume` appends the new toolCallId. Child transcript rows
are keyed by `parentToolCallId`, so reconstructing a chain's context means
selecting every row whose `parentToolCallId` is in the chain and whose
`agentName` matches.

`DelegationRecord` gains `delegateSessionId`, plus `resumedFrom` and
`modelChangedFrom` on a run that continues a chain. Read tracking lives on the
chain, not the record: the registry keeps one entry per `delegateSessionId` and a
secondary index from every `delegationId` on that chain to it.

### 3. Context reconstruction is a pure function

A new module (`packages/agent-runtime/src/delegation-history.ts`) owns:

- selecting the chain's rows from the session transcript,
- synthesizing the original `task` as the first user message from the first
  `Task` tool row's persisted arguments,
- converting to `AgentMessage[]` with the delegate's own provider/model binding
  (a pinned delegation model is not the session model). Assistant transport
  identity is `model.provider` / `model.id` — the same values live requests
  use — not the account row id. When `vendorKey` is set, `model.provider`
  differs from `provider.id`; tagging restored history with the account id
  makes pi-ai treat same-model reasoning as foreign and empty
  `reasoning_content` on resume,
- a read-file / line-count budget gate.

`SubagentRun` gains `initialMessages?: AgentMessage[]`; when present it seeds
`initialState.messages` instead of `[]`. The run is otherwise a completely
normal run: it occupies a `MAX_SUBAGENT_CONCURRENCY` slot, inherits the
definition's permission scope, and settles through the existing
`settleDelegation` path with its own `delegationId`, report, and counters.

### 4. Validation is visible, never thrown

`resume` is validated before the run starts; every failure is a tool error the
model can act on:

| Condition | Outcome |
|---|---|
| unknown or evicted id | `Unknown delegation "<id>"` plus the current resumable list |
| still running | `Delegation <id> is still running`, call TaskWait first — a resume is never queued |
| `stopped` / `aborted` | explicit resume permitted after retirement; never automatic |
| `interrupted` (the app closed mid-run) | explicit resume from retained transcript/checkpoint |
| `Task.agent` differs from the chain's agent | name mismatch, lists available |
| `Task.model` present on a resume | not allowed on a resumed run — start a new delegation to change models |
| large retained history | existing model-context seeding bounds call/result pairs; read volume alone does not reject resume |
| the chain resolves but has neither rows nor a validated checkpoint | the chain is dropped and reported as having no recorded history; the same id is never listed as reusable |

No new error codes for "evicted" versus "never existed": both resolve to the
same unknown-id error, because the model's only correct action is identical.

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

### 5. Cancellation ends execution without destroying explicit resume

Completed, failed, stopped, aborted, interrupted and legacy timed_out chains
can be continued explicitly after they retire. Stop still cancels current work
and never triggers a new provider request. This separates permission to run now
from the ability to use saved findings in a later authorized Task invocation.
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

`MAX_RESUMABLE_CHAINS_PER_AGENT = 2`. Chains are exempt from the existing
`pruneFinishedDelegations` oldest-first sweep. Exceeding the bound evicts the
least-recently-used whole chain when a delegation settles — registry entry and
every reverse-map entry together. A chain whose latest run is still working is
never evicted: dropping it would strand the delegate writing into it, so the
bound counts reusable chains and a live chain may momentarily push the group over
it. Tombstones are unnecessary: `delegationId` is a random UUID, so an evicted id
cannot collide with a future one.

### 8. Bound the replay context rather than rejecting large chains

ADR 0299 already bounds seed messages and compacts live delegate context.
Cumulative read volume therefore no longer prevents resume; a 50001-line audit
must not discard its findings just because it was expensive. The existing seed
projection removes old tool call/result pairs together and retains the original
task. The validated report supplements that bounded context. Read counts and
file lists remain telemetry, and the two-chain LRU retention limit is unchanged.

### 9. The parent discovers a resumable list through `TaskList`

`TaskList` reports the current resumable chains: agent name, delegation id, the
one-line objective, and the files the chain has read (capped at 8, truncated).
Only settled, in-budget chains appear — a running chain is never listed, so the
parent is not lured into resuming one.

The list deliberately stays out of the system prompt. It changes on every
settlement, and rewriting instructions mid-session invalidates the request
prefix providers cache on; ADR 0337 records that trade-off and supersedes the
earlier "compose the list into the prompt" decision. A failed resume still names
the reusable ids in its own tool error, so discovery never depends on the parent
having listed first.

The `resume` parameter's own schema description carries the rule that reuse
requires the id; prose alone does not resume anything.

### 10. Same session only

`resume` resolves only against the current session's transcript. There is no
cross-session addressing; sharing facts between conversations stays in the
prompt, as ADR 0165 concluded when it withdrew the peer stack.

### 11. Definition edits take effect on resume, with a diagnostic

A definition edited between two delegations is applied as-is on resume — the
same "editing takes effect on the next prompt" semantics the catalog already
has — and the change is recorded in the delegation's lifecycle details. No
definition snapshot is stored; snapshots would need new persistent state and
would contradict the existing semantics.

### 12. Chain index is rebuilt from the transcript on startup

The chain registry is in memory, but the chain relationship is recoverable:
`Task` tool rows are persisted with their arguments, including `resume`. At
session launch the runtime scans the transcript's `Task` rows, groups them by
their `resume` links into chains, and rehydrates the secondary index. Restart
does not lose resumability.

Two details make a rebuilt chain behave like a live one. Agent names are
normalized on rebuild (`Explorer` and `explorer.md` both mean `explorer`), so the
rebuilt chain still selects its own rows and still matches `Task.agent`. And each
call carries the status its own `Task` row recorded: the settlement projection
rewrites that row in place, so a chain knows whether its last run was `completed`
or `failed`. A run the app closed while it still worked never settled: its row
still says `running`, which rebuilds as `interrupted` and is explicitly
resumable, rather than staying open forever. A row that records no status at all is trusted as
settled, because every `Task` row this app writes carries one. The model binding
itself is not persisted as a key, so a rebuilt chain is matched to a configured
binding by model id; two accounts offering the same model id are
indistinguishable at that point.

### 13. The transcript renders a chain as one continuous conversation

A resumed delegation's card shows the whole chain's rows as consecutive turns
(task → reply → task → reply) with no special "resumed" badge. The new run's
counters start at zero; `details.resumedFrom` keeps the link auditable.

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

- `Task`'s parameter schema widens by one optional field. Every existing call is
  unchanged: `resume` omitted is exactly today's behavior.
- The delegate→parent context boundary is untouched. Reconstructed rows seed the
  delegate's own context only; the parent still receives nothing but reports
  through `TaskWait`, and `parentToolCallId` rows are still skipped when the
  parent's context is rebuilt.
- No new storage schema, tables, or event types. Chain identity, read tracking,
  and the model binding live on the in-memory chain; `resumedFrom` and
  `modelChangedFrom` ride the existing lifecycle details projection.
- A resumed run is billed and bounded exactly like a fresh one — same concurrency
  slot, same permission scope, same fallback models, same abort sources.
- Large histories use bounded seeding; partial results remain explicit and resumable.

## Out of scope (二期)

- In-chain compaction or placeholder substitution for old tool results.
- Task queuing / work append on a running delegation.
- Cross-session resumption.
