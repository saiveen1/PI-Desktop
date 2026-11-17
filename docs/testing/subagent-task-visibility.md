# Subagent task visibility and refresh stability

## Candidate and scope

- Base: `ed93df9c8b57aaaa46bd6430e7dc658a484daef7`.
- Candidate: isolated `fix/subagent-ux` worktree, including uncommitted changes.
- Scope: session-index hydration feedback, task identity and recorded model/effort
  presentation; additive history projection of existing effort metadata.
- Settings defaults, execution policy and stored message semantics are unchanged.
  No migration, installed Desktop/profile access or provider request was performed.

## Provenance

Read-only comparison used locally recorded upstream
`4d16de71a34b02fd8711c1102a288664b3d171c1`; no fetch or merge was performed.
That revision has neither `SessionDelegationsPanel.tsx` nor `SubagentTaskList.tsx`.
The surviving personal task-list and session-index surfaces originate in
`717b22ae4` and `869bc1d18` respectively. This candidate only claims the local
increment: hydration-aware refresh feedback, clearer task identity, and visible
recorded execution metadata. It does not claim to originate delegation itself.

## Regression evidence

Before the implementation, the isolated production-component browser fixture
failed with `Background refresh inserted a loading paragraph above retained tasks`.
New metadata tests also failed because the list did not show the execution model,
`off` was discarded, and live/history task accents used different identities.

The fixture holds IPC responses at explicit synchronization points. It covers
history refresh, lifecycle-triggered refresh, approval refresh, successful empty
snapshots, manual refresh feedback, stale-warning retention and recovery, keyboard
focus, row geometry, source-session navigation and Stop/Retry. Model/effort
rendering includes canonical `off`/`omit` and missing legacy values. Long names
are checked in narrow localized light/dark layouts without provider traffic.

## Verification

All checks below completed against this worktree's candidate, including its
uncommitted changes, on Windows Git Bash with Node 24.12.0 and Rust 1.93.0.

| Check | Result |
| --- | --- |
| Desktop targeted Node tests (refresh, approval state, metadata, task reading, transcript, panel, topology) | 69 passed |
| Additional session-index/history projection and IPC tests | 16 passed |
| Final affected renderer subset after visual refinement | 16 passed; final browser-only rerun also passed |
| Shared delegation-history contract | 5 passed |
| Complete i18n package suite | 37 passed |
| `cargo test -p host-core --locked --offline delegation_history` | 10 passed |
| Desktop `tsc -p apps/desktop/tsconfig.json --noEmit` | Passed |
| Shared and i18n package TypeScript builds | Passed |
| Desktop `electron-vite build` (main, preload, renderer) | Passed |
| Configured Biome lint and style-token check | Passed |
| `cargo fmt --all -- --check` | Passed |
| `cargo clippy -p host-core --all-targets --locked --offline` | Passed with three warnings in unchanged code |
| `git diff --check`, new document references and amendment anchor | Passed |

Desktop targeted commands used the existing test files:
`session-delegations-refresh`, `delegation-approval-state`,
`subagent-task-metadata`, `task-reading-presentation`, `subagent-transcript`,
`subagent-panel`, `subagent-topology`, and `session-delegations-ui`, plus
`session-delegations`, `delegation-history`, and `delegation-history-entry`
under `apps/desktop/test/` (all `.test.mjs`). Final affected subsets were rerun
after the label/layout refinements. The last fixture also verifies that handle
arrival preserves a creating task's row, color and keyboard focus.

Browser fixtures use an isolated Chromium profile under session scratch and WMI
launch on Windows. Six layout combinations passed: 1280px light English, 1280px
light/dark Chinese, 800px dark English, 360px light Chinese and 360px dark German.
Chinese light/dark screenshots were visually inspected; copies are local ignored
artifacts, not tracked source. These results do not claim installed-Desktop or
native-OS hit-testing coverage.

The build retains large-chunk notices. Clippy warnings are in unchanged
`computer/backend.rs` (`unused_mut`), `review.rs` (`too_many_arguments`) and
`transcripts.rs` (`filter_next`); no warning suppression or unrelated fix was added.
No full repository test suite, installer, live application, paid provider or
`verify:ui:*` command was run. The main checkout's concurrent work was not merged.

Dependency setup reused existing installations with candidate-local workspace
bindings and package outputs. The first pnpm build invocation automatically
linked 53 cached packages (zero downloads); dependency declarations and lockfile
stayed unchanged. Later builds called installed binaries directly. Mutable Vite
and pnpm task caches were kept local to the worktree; test profiles/logs used
session scratch. Existing Cargo targets were reused for offline compilation.
