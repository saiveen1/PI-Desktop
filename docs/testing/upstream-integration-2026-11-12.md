# Upstream integration — 2026-11-12

## Candidate and scope

- Local parent: `aa5f26085046d1f9e8af305ce22f556b420ae829`.
- Fetched `upstream/main`: `d128b12e2cac8a97d671f1f5db84c62f865dd4ef`.
- Common ancestor: `fc734a201115c4eb52f354d46cba314613e9a782`.
- Preflight: clean `main`; 74 local-only and 140 upstream-only commits;
  254 incoming paths and 25 textual conflicts.
- User approved preserving local fixes and a compatible v30 migration before
  the non-fast-forward merge. No rebase, push, installation, live profile,
  real provider request or application restart was performed.
- Environment: Windows/Git Bash, Node 24.12.0, pnpm 12.8.1, existing dependencies
  and Cargo caches. Local execution crossed midnight on November 11–12.
- App version remains `0.22.0-beta.8`; no release record or tag was created.

## Material resolution decisions

1. **Context ownership:** retain local removal of the model-facing
   `new_context`/`CompactContext` tools. Integrate staged-mode permissions and
   artifact injection with automatic, manual and trusted-extension compaction.
2. **Lifecycle:** retain scoped delegation policy, dynamic tool declarations,
   unfinished-todo continuation, recovery guards and diagnostic timing. Paused
   staged-mode closeout takes precedence over continuation and recovery.
   A regression reproduced five requests against a four-request closeout limit;
   recovery admission now respects exhaustion.
3. **Storage:** local v29 held delegation-history support, upstream v29 held
   staged-mode tables. Schema v30 transactionally reconciles either shape after
   backup, preserving historical migration steps and existing records. Tests
   cover both variants, older upgrades, fresh storage, reopen, backup retention,
   future-version rejection and late-failure rollback. Older builds require a
   compatible backup, not opening a v30 database.
4. **Configuration:** mode snapshots and local delegation model pools/approvals
   share the configuration transaction. Both existing configuration entry points
   remain compatible; omission/null semantics and rollback have RPC tests.
5. **Desktop:** retain Subagents settings, local running-state cleanup,
   notification behavior, Save as/copy/open/reveal actions and remote restrictions.
   Add upstream modes, session/queue race fixes and clipboard changes. Restore
   local HTTP-menu and translated-label assertions during final review.
6. **Paths:** retain the exported `normalizeChatRefPath`, backslash support,
   Windows-only normalization and unchanged UNC/double-slash handling. Adopt
   upstream uppercase drive normalization. The incoming lowercase-drive test
   failed before that integration correction and passed afterward; existing
   local assertions were not weakened.
7. **Dependencies/docs:** retain personal version/policy/release surfaces and both
   sets of specifications. Refresh the changed Pi AI patch with
   `pnpm install --offline --frozen-lockfile --ignore-scripts`: 4 cached packages
   reused, no downloads. Patch mapping/lock/install checks pass.

## Executed validation

Counts below are runner executions, not a deduplicated total.

| Check | Result |
| --- | --- |
| `pnpm build:js` | Passed, including package, Electron and documentation builds |
| Host Runtime + Desktop rebuild after the final path correction | Passed |
| Agent Runtime and Desktop normal package typechecks | Passed; Desktop repeated after menu resolution |
| `pnpm lint` | Passed, including the final rerun |
| Shared `vitest run --maxWorkers=2` | 126 files, 1596 passed; includes source and generated test copies |
| Agent Runtime targeted source tests | 19 files, 804 passed; OAuth identity 1 passed separately |
| Agent Host `vitest run --maxWorkers=2` | Passed |
| Host Runtime `vitest run --maxWorkers=2` | 191 passed, 3 skipped |
| Desktop initial core batch | 40 passed |
| Desktop upstream offline batch | 106 passed, 2 skipped |
| Desktop 18-file integration batch | Final rerun: 180 passed, 1 skipped, 0 failed |
| Path/menu/Save-as tests after correction | 79 passed |
| Rust targeted tests | 301 passed across filters listed below |
| `cargo fmt --check -p host-core` | Passed |
| `cargo clippy -p host-core --all-targets --locked --offline` | Passed with three warnings in untouched files |
| Agent-policy and Pi-patch checks | Passed |
| `node scripts/check-release-docs.mjs 0.22.0` | Passed using the script's documented beta-preview mode |
| `node --check scripts/e2e-composer-paste.mjs` | Passed |
| Conflict-marker and staged whitespace checks | Passed before final commit |

Rust commands used `cargo test -p host-core --locked --offline <filter> --
--test-threads=4`: `db::` (64), `mode_runs::` (27), `rpc::modes_rpc::` (7),
`delegation` (21), `sessions::tests::` (121), `plans::` (19), `todos::` (16),
`binary_` (26). Temporary databases, not user profiles, were exercised.

Runtime targets included `runtime`, mode definitions/prompts/notices/tool access,
`modes/*`, unfinished-todo continuation, file operations, error/retry/reasoning,
hot delegation policy, manual recovery, parent-stop retirement and provider
recovery. A scratch-only source-alias configuration was used while shared
artifacts were stale; the final normal build/typecheck verified package wiring.

Desktop integration targets cover file menus/resolution/Save as, mode source and
renderer models, mode-run coordination, model write order, transcript cache
races, failed Stop, staged configuration, forks, launch bindings, subagent
launch, clipboard handling, delegation notices, notifications and running state.

## Failures investigated and limits

- Initial Shared default-parallel run: 1594 passed, two dynamic-import timeouts
  (source/generated copies of the same test). Isolated tests passed 28/28;
  the full two-worker rerun passed without changing timeouts or assertions.
- Initial Desktop integration run: 179 passed, one lowercase-drive failure,
  one skip. The path implementation was corrected; focused rerun passed 79/79.
- Unqualified stable release-doc checking rejected beta changelog entries.
  Its script and changelog files were identical to the local parent. The existing
  documented stable-preview invocation passed; no fabricated beta catalog added.
- Windows storage relative-junction cases are skipped per the existing ledger.
  Skips are not claimed as verified assertions.
- Full Rust/Desktop suites, native Electron E2E, paid-provider checks, packaging,
  installed upgrades and real-profile migration were not run. Targeted checks,
  source build and temporary-data migration coverage do not establish those.
- Build size/highlighting warnings and clippy warnings remain observable; they
  were not removed through unrelated cleanup.
- No model-ID trailer is added to the merge commit because the parent runtime
  did not expose a confirmed model identifier.
