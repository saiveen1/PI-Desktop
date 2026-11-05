# Test failures by design: the Windows (Git Bash) known-issues ledger

Read this **before** trying to "fix" desktop test failures on this machine, and
before running the full suites outside the CI-mandated platform.

## Why this file exists

On 2026-11-05 the full local suites were audited (HEAD `2e5f39dc8`, Windows 11,
Git Bash host): 21 of 1202 `cargo test -p host-core` cases and 41 of 4918
`node --test test/*.test.mjs` cases fail **by design or by environment**, not by
product defect. Roughly two agent-hours were spent re-deriving that conclusion
from scratch, then re-proving it against a pre-merge baseline (failure lists
were byte-identical before and after a 41-file merge). Do not repeat that work.

The authoritative platform for both suites is CI: `cargo test -p host-core
--locked` runs on `ubuntu-latest` (`.github/workflows/ci.yml`, the `rust` job),
and `node --test` runs under the `pnpm -r --if-present test` job on
`ubuntu-latest`. The `rust-windows` CI job intentionally runs only the
transcript-cache E2E subset. CI has been green with these same cases excluded
by platform ever since they were written.

## Decision rule for a failing case

1. Reproduce the exact assertion (or error) from the failure output.
2. Check the table below. If the signature matches, stop — record it and move
   on. Do not open the implementation looking for a bug.
3. Only a failure that is **not** listed here, or that appears on Linux/macOS
   CI, is a real regression.

## Known platform-limited cases (do not fix, do not re-investigate)

| Suite | Cases | Root cause | Why it stays |
| --- | --- | --- | --- |
| `cargo test` `session_worktrees`/`rpc::worktree_rpc` | 12 | Fixed 2026-11-05: `init_repo` now pins `core.autocrlf=false`/`core.eol=lf` in `test_support.rs` | — |
| `cargo test` `data_relocation` | 3 | Fixed 2026-11-05: assertions use `canonical_project_path`, and `rewrite_capability_state` now stores normalized keys (real Windows fix) | — |
| `cargo test` `rpc::remote_tools` (2), `background_tasks::windows_tests` (1), `tools::tests` (2) | 5 | Git Bash host: `sh`-re-written argv, `ps`/job-object topology under `cargo test`, machine registry `cmd.exe AutoRun` | The guarded behavior is Windows-production code paths whose test harness cannot exist under `cargo test` on this host; they pass on Linux CI where applicable |
| `test/remote-host-ssh-transport`, `-ssh-password`, `-artifact-transfer`, `-bootstrap-script` | ~23 | Spawn `sh`/`ssh` fixtures, `chmod 0o755` as exec bit, `tar -C C:\` parsed as rsh host | POSIX remote-host tooling; CI runs them on Linux |
| `test/remote-provider-sync` | 1 | `ADMIN_UNAVAILABLE` thrown deliberately on `win32` (`apps/pi-host/src/admin-socket.ts`) | Product decision: unix-socket permission model does not exist on Windows |
| `test/macos-release-verification`, `macos-signing-diagnostics`, `macos-signing-watchdog` | 12 | macOS-only notarize/staple scripts invoked through `URL.pathname` (POSIX shape), `kill(-pid)` process groups, `codesign` fixtures | macOS release machinery |
| `test/computer-use-permission-user-path`, `config-sync-user-path`, `jev-service-setup-user-path` | 3 | Chromium profile teardown races Windows file locks (`EBUSY` on `Network/Trust Tokens`) or exceeds the 50 s test timeout when Electron cold-starts | Pass individually / on CI; not deterministic locally |
| `test/open-attachment-video` | 1 | Needs a real file symlink; this host has no Developer Mode, so `symlink` → `EPERM` | The guarded behavior (alias via symlink) is unreachable on unprivileged Windows anyway |
| `test/macos-signing-diagnostics` symlink-cycle cases | (in the 12) | Same EPERM on fixture links | macOS inventory feature |

## Conventions introduced 2026-11-05 (use these for new tests)

- **Link fixtures**: use `apps/desktop/test/helpers/link-fixture.mjs`
  (`createLinkOrSkip` / `createLinkOrSkipSync`). Directory links become
  junctions on Windows, genuinely refused file links `t.skip()` with the OS
  reason, and `{ relative: true }` targets skip on Windows because junctions
  cannot express them. Never call `fs.symlink*` bare in a desktop test.
- **Path expectations**: assert with the same module the implementation uses
  (`node:path` join/resolve), or an explicit `path.posix`/`path.win32`
  parameter — never a hand-typed `/`-separated literal.
- **URL → path**: use `fileURLToPath(url)`, never `url.pathname` (which yields
  `/D:/...` on Windows and broke `plugin-prompt-enhancement-migration` until
  fixed).
- **POSIX-only semantics** (permission bits, process groups, exec bits, unix
  sockets): guard with `if (process.platform !== "win32") { ... }` or
  `{ skip: POSIX_ONLY }` with a one-line why, as in
  `remote-host-supervisor.test.mjs` and `storage-maintenance.test.mjs`.

## When you believe a listed case is actually broken

Re-check the table against current source first (this ledger can go stale when
features move). If the implementation genuinely changed so that a listed case
should now pass, delete its row **in the same change** and explain why in the
commit body. Never delete a row to make a red suite look green without running
the case on a platform where it is expected to pass (Linux CI or a privileged
environment).
