# ADR: Current-session subagent entry and history index

- Status: Accepted; isolated component paths verified, installed Desktop not run
- Date: 2026-11-12
- Scope: Renderer navigation and additive delegation-history query
- Amends: [Task-first transcript presentation](task-first-transcript-presentation.md)

## Context

Task rows disappear from view as the parent conversation grows. The session's
index was reachable only by opening a child detail and choosing All tasks.
The permanent clock entry opens global history, not the current session's live
work. Deriving a session total from the visible transcript would also omit
Tasks outside its bounded reading window.

## Decision

Keep a text Subagents entry in the local conversation topbar, also while the
work panel is maximized. Show actual running delegates, pending approvals,
creation, needs-attention or history state without opening a panel automatically.
A session-scoped `subagents` tab is the common destination for that entry and
All tasks in existing child detail tabs. Keep the global clock entry separate.

Extend the existing history query with optional validated `sessionId`. Host
selects that session's candidates before pagination; old queries and the
existing status/project/deletion filtering semantics remain unchanged. There
is no new channel, protocol-version bump, database migration, or execution owner.

One reference-counted renderer history source serves the entry and index.
Merge durable history with live Task evidence by identity, preserving recorded
handles and terminal outcomes against stale creation/running snapshots.
Lifecycle tools and child tools are not extra delegates. Relevant Task
settlement events invalidate old reads even when the Task is not loaded in chat.
Release subscriptions and report data when the surfaces unmount.

Reuse task rows, authorization gates, Stop/Retry and the child transcript.
Missing or partial historical details use bounded local history reads with
explicit earlier/later pagination and retry, independently of the parent chat's
scroll/search range. Retained reports remain visible when their original answer
is outside that range; do not invent completeness or suppress truncation.

### Refresh stability and execution metadata amendment

Initial hydration is distinct from background synchronization for both history
and approvals. Successful empty snapshots are hydrated too. Keep existing rows,
empty states, focus and layout during refresh; indicate manually requested work
only on the refresh button. Preserve failed-read warnings until success, not
just until another request starts. Do not trade freshness for cosmetic throttling.

Task rows and details share robot icons, a Subagent label and passive recorded
model/effort metadata, separate from the Sparkles thinking disclosure. The
original Task message ID supplies the identity accent across live/history reads.
Canonical `off`/`omit` are visible and distinct from missing/invalid values.
This amends the task-first presentation's hidden-model/effort rule without
introducing another display mode or execution owner. Host history may return
optional validated `thinkingLevel` from existing Task result metadata; old
records remain readable and are never filled from Settings. No storage migration,
model-policy change or new IPC channel is required.

## Compatibility and validation

The new query field is optional. Existing global history, source attribution,
approval identity/revision, stored messages and runtime lifecycle are unchanged.
No real model, daily profile, installed application or installer is a test target.

Coverage: `session-delegations.test.mjs`, `session-delegations-ui.test.mjs`,
existing task-reading, search, controls, work-panel and history tests, shared
history query validation, IPC forwarding and temporary-DB Host pagination tests.
The browser fixture exercises keyboard entry, empty/completed states, scoped
approvals, stale responses, historical paging/retry, Stop/Retry and narrow
localized light/dark layouts. Native OS hit testing remains unverified.
