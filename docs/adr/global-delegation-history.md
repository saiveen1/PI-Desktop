# ADR: Global delegation history without a second execution truth

- Status: Accepted, implementation candidate
- Date: 2026-11-08
- Related: [Scheduling and approval](delegation-scheduling-and-approval.md),
  [Truthful delegation delivery and bounded recovery](delegation-terminal-reliability.md),
  [Data storage](../spec/03-runtime/04-data-storage.md),
  [Host RPC protocol](../spec/03-runtime/06-host-rpc-protocol.md)

## Context

Two delegation surfaces were memory-only or per-session scoped:

1. A settled approval prompt lived in the Electron main `pending` map only.
   Settling deleted the entry, and the renderer's terminal projection was an
   in-memory map. Reload lost every receipt, so a user could not review which
   delegate was authorized, skipped, expired, or invalidated, and notification
   history could not be rebuilt from durable state.
2. Delegated runs were visible only through the renderer's current session
   cache. A delegate's canonical result is already the settled `Task` tool row
   in the owning session's JSONL transcript (App runtime republishes it through
   `message_end`; Host rewrites only that tool result). Listing runs globally
   therefore needs a Host query over indexed messages, not a renderer cache and
   not a new execution ledger.

Both demands share one hazard: duplicating authority. An approval receipt must
never act as consent, and a history projection must never claim a status the
transcript does not contain.

## Decision

### 1. Approval receipts are optional, versioned, Host-owned kv records

Terminal `DelegationApprovalPrompt` rows are persisted by Host under the
existing `kv` extension boundary (`delegationApprovalHistory` namespace, `v1`
key, `{version: 1, entries: [...]}`). No second Electron filesystem database is
introduced, and no structural schema migration is required for receipts.

- Identity is `(sessionId, requestId)`; a receipt carries a monotonically
  increasing `revision`. Recording an older or equal revision is a no-op, and a
  newer revision replaces the row while preserving `readAt`.
- At most 200 receipts are retained, newest `settledAt` first.
- Only prompt DTO fields are stored. Provider records are copied through an
  explicit allowlist, so credentials, endpoints, headers, and execution state
  are never persisted; oversized payloads are rejected.
- `markRead` sets `readAt` for one paired identity or for every receipt; the
  input is either both `sessionId` + `requestId` or neither. `clear` deletes only
  the receipt record. Neither operation touches pending approvals, saved
  delegation policy, sessions, transcripts, notifications, or runs.
- A missing receipt record reads as "no receipts"; malformed or unreadable
  data fails visibly. Unknown `version` values fail closed rather than being
  reinterpreted. No invented history is synthesized.

Electron main enqueues the receipt write before publishing the terminal prompt
event. `listHistory` waits for serialized writes and retries retained failed
receipts against their original Host only. The bounded retry backlog never
authorizes or replays work; explicit clear retires its captured entries without
discarding later arrivals. Persistence failures remain visible and retryable.
Pending truth remains the existing approval service; automatic authorization
that never prompted creates no receipt. A replacement Host never receives an
old Host's failed receipt.

### 2. Run history is a read-only projection of canonical `Task` rows

`delegation.history.list` queries the SQLite message index for
`tool_name = 'Task'` candidates in `(created_at DESC, mid DESC)` order, reads at
most one bounded transcript window per candidate, and projects the settled
`toolResult.details` plus the original `toolArgs` already stored in that row.

- `Task` status/task/summary/report/model are preserved as recorded. A row whose
  recorded status is `running` while its owning turn is not `running` (or has no
  owning turn) is reported as `interrupted`; a stale transcript never proves an
  active delegate.
- Soft-deleted sessions are excluded. Older and never-opened sessions are
  included; no renderer session cache participates.
- `task`/`report` and other free text are bounded with explicit
  `taskTruncated` / `reportTruncated` flags. Transcript-native millisecond
  timestamps are converted to canonical UTC ISO strings; string timestamps are
  normalized rather than re-interpreted.
- `offset`/`limit` travel as a candidate cursor; `nextOffset` is returned
  whenever more candidate rows exist, even if the filtered page is empty, so a
  filtered "Load more" cannot stall. `status` (`all`/`running`/`ended`) and
  `projectPath` filter after candidate selection.
- Schema v29 adds one partial index, `idx_messages_task_history`, on
  `messages(created_at DESC, mid DESC) WHERE tool_name = 'Task'`. The migration
  is backed up (`pi.sqlite.v28.bak`) and replays the existing idempotent project
  path repair in the same transaction. Two development candidates used v28 for
  different migrations; this preserves both without guessing their origin.
  The index is rebuildable from existing rows. The v27-to-v28 project repair
  remains a separate versioned step and retains its own backup.
- The subsequent upstream-mode integration uses schema v30 because upstream
  independently assigned v29 to staged-mode storage. A backed-up transactional
  v29-to-v30 reconciliation supplies missing mode objects and the history index
  for either shape while preserving records and existing project-path repair.
  Fresh databases contain both feature sets; repeated opens do not remigrate.

### 3. Renderer-facing contract

New IPC channels are additive: `pi-desktop/delegationHistory/list`,
`pi-desktop/delegationApproval/history/{list,markRead,clear}`, all main-window
sender guarded with strict query/identity validation. Host RPC adds
`delegation.history.list` and `delegation.approvalHistory.{list,record,markRead,
clear}`; `record` is never exposed to the renderer. Protocol version 11 is
unchanged.

## Consequences

- Receipt-loss on crash between publish and write is reduced to one already
  reported failure; the failure is observable and never silently authorizes.
- A user can review terminal approval decisions and runs globally across
  projects after reload, while pending consent and execution authority remain
  where they already live.
- History queries cost one index range scan plus one bounded transcript window
  per returned candidate. `projectPath`/`status` filters may examine candidates
  that produce no entries; the cursor makes that bounded and resumable.
- Downgrading from the integrated schema v30 requires a compatible backup;
  schema-29 and earlier applications refuse that database. Receipt records
  themselves remain additive kv data that older builds ignore.
- `interrupted` is a projection label, not a persisted status; the transcript
  keeps the runtime's original status.

## Alternatives

- A second Electron-managed SQLite/JSON store for receipts: rejected, it would
  duplicate Host persistence ownership and introduce an unsynchronized writer.
- A structural receipts table: not required by query or retention needs, so
  schema churn and migration risk are avoided; the versioned kv record already
  supports bounded history and revision guards.
- A separate run-history table written by the runtime: rejected, it would create
  a second execution truth that can disagree with the transcript.
- Returning `nextOffset` from the filtered row count: rejected, it would hide
  candidates behind a filtered-empty page and stall "Load more".
