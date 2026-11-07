# ADR: Per-file search leases instead of Host-wide search fences

- Status: Accepted
- Date: 2026-11-07
- Amends: [Host file admission](host-file-batch-admission.md)

## Context

A directory search held a shared Host-wide file-domain lease for its complete
traversal. Every writer conflicted with it. Writer fairness then held later
readers behind that writer, including readers in unrelated projects. Slow
searches caused repeated 30-second admission failures across sessions. Cancelling
the RPC waiter did not stop the blocking traversal, so its lease could survive
visible cancellation. Raising capacity or timeouts does not remove that cycle.

## Decision

Keep source-order dependency claims separate from execution conflicts. A search
remains a conservative read dependency within its registered batch, but its
outer permit owns only the existing execution capacity and lifecycle. Glob is
metadata enumeration, not a directory transaction. Grep acquires a shared lease
for each actual file using the existing permission-aware identity resolver,
revalidates it, and holds it through content scanning and Hashline tag creation.
Other sessions may mutate unrelated files between these observations; there is
no whole-tree snapshot guarantee. Same-file and cross-root hard-link exclusion
remain intact, as do unknown-identity and structural-write fences.

The file read borrows the running search's capacity and keeps its parent permit
alive. It must not acquire another session/global slot, nor wait for a pending
session-exclusive operation that is itself waiting for the search to drain.
Runnable conflicting writers retain queue priority. A borrowed read may pass a
writer that cannot obtain capacity, or an unready source-order successor; that
writer must not create a dependency on the search's own completion. This does
not bypass an active writer or any resource lock.

A missing leaf with a trusted existing parent uses the pinned parent object ID
and leaf name, plus its resolved address, instead of a Host-wide fence. Windows
entry comparison is conservative for uncertain names. A changed binding is
rejected before writing, not silently reclassified or retried. Missing ancestors
and unsupported identities still fall back to the conservative fence.

The async search waiter owns a cancellation channel. Blocking traversal checks
it between entries, content scanning between buffered chunks, and file-lease
waiting selects on cancellation. The blocking task still owns its permit until
it actually exits. Cancellation cannot interrupt an individual kernel I/O call;
no premature lease release or forced mutation replay is introduced.

Coordinated Grep uses the existing in-process scanner because a whole-directory
external rg invocation cannot acquire Host leases per file. Uncoordinated callers
retain the optional system-rg backend. Result modes, path/include filtering,
newest-first ordering, budgets and tag/edit contracts remain unchanged. This
trades rg throughput for file-level isolation; it is not a claim of faster
single-search execution.

Admission limits, 30-second queue deadline, IPC schemas, permissions, remote
fallback and persistence formats remain unchanged. Timeout diagnostics include
initial/current wait reason and active/queued/resource counts, without paths or
file contents.

## Alternatives and validation

- Increasing limits leaves the cross-project conflict graph unchanged.
- Session/project-only locks miss aliases to the same physical file.
- Letting all readers bypass writers can starve actual mutations.
- Releasing a cancelled blocking task's permit early allows concurrent writes
  while that task is still reading.

Deterministic budget and real-tool tests cover independent writes during search,
per-file hard-link exclusion, writer fairness, saturated session capacity,
pending session-exclusive work, same-batch ordering, cancellation and queue
cleanup, plus Grep-to-Edit using the returned tag. Existing RPC, rollback and
alias tests remain applicable. No running desktop or production profile is used
for validation.
