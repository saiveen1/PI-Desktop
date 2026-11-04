# ADR: Reversible session deletion with a host-owned recycle bin

- Status: Accepted
- Date: 2026-11-04

## Context

Archive is a renderer-owned organization preference, not deletion. The sidebar
already supported modifier-key selection, but exposed no explicit selection mode
and deleted sessions permanently. Users need batch organization and a recovery
step before irreversible removal, including sessions with isolated worktrees.

The host already persists `sessions.deleted_at` for plugin imports. Its ordinary
session and search projections exclude marked rows. A second renderer-only trash
flag would diverge from host discovery and could let hidden sessions keep running.

## Decision

Reuse `deleted_at` for Desktop session recycling. Add allowlisted Desktop IPC and
host methods for listing trash, marking a session, restoring it, and purging it.
Do not change the existing internal `session.delete`, plugin ownership contract,
or project-delete confirmation flow. The user-facing session menu uses recycling,
not that legacy permanent deletion path.

Trash preserves transcripts, project binding, isolated worktrees and the existing
renderer archive/pin metadata. It has no automatic expiry. Running and pending
work prevents recycling; turns and queue admission reject trashed sessions. Main
holds its existing session-operation lease and drains pending transcript writes
before marking a session. It retires the old runtime context after success.

Permanent deletion is offered only inside the recycle-bin dialog, with explicit
confirmation over a fixed selection. Host checks membership before filesystem
changes and serializes restoration with asynchronous worktree cleanup. The
existing host deletion routines remain the owner of transcript and side-data
cleanup. The dialog exposes failures rather than removing failed rows locally.

Selection becomes explicit and discoverable: checkboxes, selected count, Select
visible and Done, with batch Archive/Unarchive/Move to recycle bin. Modifier-key
selection remains supported and follows rendered order, excluding hidden rows.

## Consequences

- Existing database layouts and protocol v11 remain compatible; no migration or
  transcript rewrite is necessary.
- Desktop users can also recover host-owned plugin-import rows previously trashed
  by their owner. Plugin capabilities and ownership restrictions are unchanged.
- Native Pi and remote session storage are not touched by local recycling.
- Archive remains a presentation preference; restoring an archived session leaves
  it archived. Clearing renderer preferences still resets organization only.
- No automatic purge, project bulk deletion, or new background scheduler is added.

## Verification

The component user path covers selection, archive, partial failures, restore,
confirmation/cancellation and retry. IPC tests cover persistence drains and host
replacement. Rust tests cover restart, retained transcript/worktree data, rejected
execution, and concurrent restore/purge using a temporary Git repository.
