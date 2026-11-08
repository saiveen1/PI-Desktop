# Notification and global delegation candidate validation

Date: 2026-11-08

This records the original standalone candidate. Subsequent integration keeps
the notification behavior while moving running-first ordering into exclusive
conversation groups and retaining all roots of a logical project. Schema 29
combines the history index with the main branch's project-path migration; the
schema-28 description below is historical, not the integrated storage contract.
Combined-candidate checks are recorded separately with the integration delivery.

## Candidate

- Worktree: `worktrees/notification-delegation-eaee0dfc`
- Branch: `fix/notification-delegation-eaee0dfc`
- Base: `75a1923872f60a1326ec27c965140cde11140f96`
- Candidate includes uncommitted changes. Nothing staged, committed, merged,
  pushed, installed or launched as Desktop by this task.

## Delivered behavior

1. The notification popover has one bounded scroll container below fixed
   controls. Successful outcomes are visible, keyboard navigation reaches both
   ends, and history refresh does not move the current scroll position.
2. Read task outcomes remain in All. Terminal approval receipts are separately
   persisted by Host, capped at 200, and can be read after restart. Reading,
   expanding or clearing history never authorizes or replays work. Clear requires
   confirmation and does not settle pending requests.
3. Pending reminders use warning presentation, task success uses success, and
   failure uses error. Delegation approvals use a delegate icon and explicit
   source/status text. Approval accepted is not execution completed.
4. A permanent conversation/home toolbar entry opens all-project delegation
   history, independent of the selected session and its work panel. It supports
   status filters, bounded pagination and source-aware task/report details.
   Only explicit Open source navigates. View approval hands the exact live
   request/revision to the existing approval center without navigation.
5. Project headers classify distinct sessions as needs-action, running, latest
   unread completed or latest unread failed (in that precedence). Folded,
   paginated and label-filtered rows do not reduce the counts.
6. Running sessions appear first within their existing labels, with a stable
   idle order. Unclassified only reorders internally. Pagination considers
   running rows before slicing; labels, global pins and saved manual order do
   not change, and no project-level running section is added.

All nine locale catalogs include the new copy. UX, IPC, Host RPC, storage and
E2E scenario specifications are synchronized with the
[history decision](../adr/global-delegation-history.md).

## Verification actually performed

All parent-run processes used the existing toolchain and WMI-owned command
jobs, with scratch TEMP/TMP and no live application profile.

| Check | Result |
| --- | --- |
| Ten workspace package builds using existing TypeScript entry points | PASS |
| Final shared/i18n rebuild and Desktop `tsc --noEmit` | PASS |
| Final `electron-vite build` (main, preload, renderer; no launch) | PASS; existing large-chunk warnings |
| Configured `biome lint` | PASS, 145 configured files; not a claim that every source is included by Biome |
| `check-style-tokens.mjs` | PASS |
| Notification/delegation/sidebar Node regression batch | 103 passed |
| Final affected Node subset after receipt-recovery changes | 44 passed, including 4 retry/clear-concurrency tests; overlaps the 103 batch |
| Shared history, approval and protocol contracts | 40 passed |
| i18n full package suite (locale delegate) | 37 passed across 4 files |
| Final isolated production-component browser suites | 2 passed, no skips |
| `cargo test -p host-core --locked --offline delegation` | 19 passed, 0 failed |
| `cargo fmt --check` | PASS |
| `cargo clippy -p host-core --all-targets --locked --offline` | PASS; 3 existing warnings outside changed modules |
| `git diff --check`; staged-file check | PASS; staged set empty |

Browser coverage includes 1280×900, 360×640 and 360×320 notification viewports,
Home/End, a single scroll owner, refresh position, stale responses, expanded
read receipts under Unread, operation retry, clear confirmation, clear after
unreadable history, and unchanged pending consent. Global history covers stale
filter responses, multiple projects, empty pages with continuation, renewed
refresh cursors, details without navigation, explicit source navigation,
deleted-source errors, retry, exact approval handoff, Escape/focus return,
light/dark surfaces and reduced motion.

Host coverage includes canonical old Task rows, deleted-source exclusion,
interrupted projections, filtered candidate cursors, UTF-16 text bounds,
receipt restart/read/retention/revision behavior, and schema-27 migration backup
and index rebuild. Receipt service tests cover failed-write retry, later writes
not hiding earlier failures, original-Host ownership, and a new receipt arriving
while an earlier clear is queued.

Red baselines were retained separately: success-history/unread-count tests
failed before the inbox fix (2 failures), and failed-receipt recovery tests
failed before retry support (2 failures). Intermediate browser fixture failures
were diagnosed rather than accepted as passes.

## Environment and validation limits

- The reused pnpm hoist junction was incompatible with pnpm's automatic workspace
  preparation; direct installed compiler/test entry points were used instead.
  No dependency installation or lockfile change was required.
- A concurrent checkout changed the main installation's React type links,
  producing duplicate type identities in an untouched Markdown component.
  Only this candidate's `@types` junction was replaced with local per-package
  links to the existing consistent cache. The original junction was retained
  in scratch; main and other checkout links were not changed. Final typecheck
  passed after isolation.
- No installed Desktop, daily profile, real provider, native OS banner/audio,
  installer upgrade or full Electron application E2E was exercised.
- The backend delegate reported a broad Rust run with 1256 passes and four
  Windows failures in ledger-listed remote/tool suites. Its full raw output was
  not retained for parent re-audit, and it predates final refinements; this is
  not claimed as a full-suite green result. Acceptance uses the final targeted
  runs above. Full Desktop/runtime suites were not part of final acceptance.
- Clippy warnings remain in `computer/backend.rs`, `review.rs` and
  `transcripts.rs`; these files were not changed by this task.

## Compatibility and delivery boundaries

Schema 28 adds only the rebuildable Task index; schema-27 migration makes a
backup and preserves source rows. A schema-27 build cannot open the upgraded
schema directly: downgrade needs a compatible backup. Terminal receipt kv data
is additive and does not restore live consent. Old approval decisions never
persisted by previous builds cannot be reconstructed retroactively.

Execution history is a bounded projection, not a second execution ledger.
Live refresh re-queries the first page because offset cursors can become stale;
older pages can be loaded again. No app version or release artifact was changed.
The candidate remains separate from concurrent main-checkout work; integration
and any installation are subsequent user-authorized actions.

## Principal implementation surfaces

- [Notification center](../../apps/desktop/src/components/NotificationCenter.tsx),
  [receipt hook](../../apps/desktop/src/hooks/use-delegation-receipts.ts),
  [notification presentation](../../apps/desktop/src/lib/notification-presentation.ts).
- [Global history dialog](../../apps/desktop/src/features/delegations/DelegationHistoryDialog.tsx),
  [sidebar grouping](../../apps/desktop/src/lib/session-organization.ts),
  [project summary](../../apps/desktop/src/lib/sidebar-project-runs.ts).
- [Receipt service](../../apps/desktop/electron/main/services/delegation-approval-history.ts),
  [Host run projection](../../crates/host-core/src/delegation_history.rs),
  [Host receipts](../../crates/host-core/src/delegation_approval_history.rs),
  [shared contracts](../../packages/shared/src/delegation-history.ts).
