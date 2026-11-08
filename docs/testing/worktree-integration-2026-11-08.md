# Worktree integration: 2026-11-08

## Candidate and retained history

The upstream owner completed merge `f9fdf16d01ac220233fb622601e139acc1b596a2`
before this task changed the main checkout. The reading task was received only
after its final completed response and cleared inflight checkpoint. Every source
worktree's complete tracked and untracked changes were saved without splitting
overlapping agent edits.

| Source | Preservation commit | Merge into main |
| --- | --- | --- |
| `fix/notification-delegation-eaee0dfc` | `3ab65cd3e` | `d93315ce1` |
| `fix/subagent-controls` | `dd6d43b66` | `f8b436f8a` |
| `feat/task-reading-c49895e4` | `717b22ae4` | `8c950d9c0` |

The tested executable candidate is merge `8c950d9c0`, tree
`65e6a6ad401e0096933d557a7cef973142019f66`. This report is a later documentation-only
addition. All three source tips and the upstream merge are ancestors of that
candidate. The original branches and worktrees remain, with clean source indexes
and working directories. No remote publishing, installation, or daily-profile
writes were performed.

## Conflict decisions and behavior retained

1. **Two different schema-28 migrations.** Main repaired project path aliases;
   notifications added the Task history index. Schema 29 preserves the explicit
   27-to-28 project step, then backs up version 28 and performs idempotent project
   reconciliation plus index creation in one transaction. Both historical v28
   shapes work. Existing sessions, schedules, current-project ownership and
   conflicting memory records remain intact; failed upgrades roll back.
2. **Older sidebar structure.** The notification branch still used label-based
   groups. Its running-first projection was moved into main's exclusive session
   groups, preserving descriptive labels, persisted manual order and all roots
   of a logical project. Header counts use the complete project session set,
   including pinned and paginated rows. Obsolete label-grouping files stay
   deleted and their useful regression assertions moved to the current surface.
3. **Task reading and real child input.** The task list replaces the old topology
   component, while the detail retains the functional child composer and admitted
   failure-policy summary. Direct input targets the latest resumed handle. User
   rows retain their role and chronology between stable assistant segments, with
   no parent-session edit/delete controls. A final user row does not leave the
   preceding assistant segment falsely active.
4. **Truthful preemption.** Tasks displaced by new input retain `not_started`,
   have no invented duration, and do not count as active work. They remain in
   history and never redispatch automatically. Ordinary skipped tools retain
   their own status.
5. **Main runtime and reading fixes.** Pi 1.5 imports and patches, exact job
   selectors, bounded output-limit repair, response-model diagnostics, usage
   costs, content windows, reading position/navigation and stateful prose remain
   alongside the worktree additions. Auto-merged duplicated `latestCall`
   declarations were removed without dropping either branch's chain behavior.
6. **Documentation.** Both feature contracts and their E2E scenarios are retained.
   Conflicting claims that the task detail has no input were amended to describe
   the real composer. Source links outside the documentation site's root became
   explicit repository paths. New mirror-table discrepancies were corrected;
   pre-existing translation debt remains listed below.

## Preservation checks

Private snapshots and merge previews did not change source files, real indexes
or refs. Each source's final staging tree matched its verified snapshot before
its preservation commit.

- All **59 added source files** are present in the integrated candidate:
  notifications 26, controls 25, reading 8.
- Of 4,119 main files outside the worktrees' changed-path union, **4,111 retain
  exactly the same Git blob and mode**. The other eight are the reviewed session
  organization helper and its two regression suites, project migration and its
  regression suite, and three synchronized specification mirrors. None was lost.
- Disjoint worktree paths retain their exact content except reviewed integration
  adaptations: notifications 46/51 exact, controls 37/39, reading 22/30. The
  adaptations are migration compatibility, current-structure tests, composed
  child reading/input, fixture isolation, and synchronized documentation.
- Shared-path changes received semantic review and behavior tests. Blob equality
  is preservation evidence, not a claim that static comparison proves every
  product behavior.

## Validation actually performed

Environment: Windows, PowerShell command orchestration, Node 24.12.0, pnpm 12.8.1,
the existing Rust/toolchain/dependency caches, synthetic providers and isolated
temporary data. No second dependency environment was installed.

| Check | Result |
| --- | --- |
| `pnpm build:js` | PASS after correcting documentation-site source links; includes Desktop and documentation build |
| `pnpm --filter @pi-desktop/desktop typecheck` | PASS |
| `pnpm lint` | PASS; Biome checked its 157 configured files, style-token check passed |
| Agent policy, Pi dependency and Pi patch checks | PASS; installed Pi 1.5.0 is aligned |
| Runtime full suite | 140 files, 2,043 passed, 1 explicit Windows skip, exit 0 |
| Shared full suite | 124 files, 1,556 passed, exit 0; default collection includes source and generated tests |
| i18n full suite | 4 files, 37 passed, exit 0 |
| Notification/history Node batch | 64 passed |
| Sidebar combination batch | 26 passed |
| Child-message/recovery IPC batch | 24 passed |
| Task-reading/controls component and helper batch | 33 passed; added trailing-user assertion also passed in a focused rerun |
| Main reading/prose/navigation/cost regression batch | 179 passed |
| Notification/history isolated browser suites | 2 passed |
| Task-reading isolated Electron fixture | Passed all 6 interaction stages and 4 light/dark/narrow layouts |
| Turn-changes isolated interaction | Passed |
| Real Markdown prose-state fixture | Passed table preview, Mermaid state and ordinary-content recycling |
| Loopback provider/runtime E2E | Passed error, abort, stop and direct-input scenarios with retained continuation |
| Focused Host migration/history/queue tests | 58 passed |
| Rust delegation settings | 12 passed |
| `cargo test -p host-core --locked` | 1,274 passed, 4 known Windows failures, 2 ignored; exit 101, not a green suite |
| `cargo fmt --check` | PASS |
| `cargo clippy -p host-core --all-targets` | PASS with three existing warning categories |
| Documentation structure/index check | PASS after adding the controls ADR index entry |
| English/Chinese locale documentation check | NOT GREEN; same missing page and seven invalid pairs as the upstream candidate |
| Diff, conflict-marker, ancestry and source-worktree checks | PASS |

The Node batches overlap; their counts must not be added into a unique-test total.
Runtime/shared/Host validation started during integration. A final hash comparison
of 447 runtime/shared/validator/lockfile paths proved those sources unchanged when
the reading merge completed.

The combined migration tests first failed in all five cases. The production
Sidebar fixture also reproduced missing additional-root counts before the fix.
Three child-reading regressions first reproduced missing user segmentation,
incorrect preempted outcomes and user input interpreted as thinking.

The task-reading browser fixture initially hit its existing watchdog because
hidden Windows rendering reduced animation frames to about one per second. It
now uses the repository's existing Windows offscreen fixture pattern without a
larger timeout. Its synthetic state also declares the retained session, so the
production eviction guard does not correctly discard an incomplete fixture's
search view. All four final screenshots were inspected for contained content,
accessible controls and composer placement; this is fixture verification, not
full installed-application acceptance.

## Known limits

The four Host failures are the ledger-listed two remote relay assertions in
`rpc/remote_tools_tests.rs` and two Windows shell/process harness cases in
`tools/mod.rs`. They were collected once and compared against
[the Windows ledger](windows-known-failures.md); no new failing file was found.
Clippy retains warnings in computer backend, review and transcript code.

The locale checker still lacks the Chinese personal-release runbook and reports
the existing pairs for IPC, agent runtime, tools/permissions, component spec,
development workflow, E2E plan and release runbook. The documentation build itself
passes. This integration does not claim that translation debt is resolved.

The entire Desktop suite and unrelated workspace suites were not run; the
affected production components, main retained-reading behaviors and actual
runtime/Host boundaries were covered above. Real model accounts, daily profiles,
installed upgrades, native notifications and full installed Desktop acceptance
were not tested. Schema 29 requires a compatible backup for downgrade to an
older schema. No application version changed.

The runtime did not confirm an exact parent model identifier, so commits omit
an invented `AI-Model` trailer.
