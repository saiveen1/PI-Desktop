# Test failures by design: the Windows (Git Bash) known-issues ledger

Read this **before** trying to "fix" desktop test failures on this machine, and
before running the full suites outside the CI-mandated platform.

## How to use this file (do this, not something else)

The expensive mistake is re-deriving the same conclusion per failure. Follow the
order below and do **not** improvise a per-case investigation first.

1. Run the suite with a machine-readable reporter and save the output:
   * `cargo test -p host-core --locked` →
     `cargo test -p host-core --locked > "$PI_SCRATCH_DIR/cargo.log" 2>&1` and read
     the `failures:` block (it lists every failing test name).
   * desktop → `node --test --test-reporter=spec test/*.test.mjs` from
     `apps/desktop`, then extract the `✖` lines.
   * agent runtime → `node node_modules/vitest/vitest.mjs run` from
     `packages/agent-runtime`, then extract the `FAIL` lines.
2. Map **all** failing test names to their test files in one pass (a single
   `grep -lF` loop over the failure list), not test by test.
3. Compare that file set against the tables below **once**. Everything inside the
   listed suites is platform-limited by definition: record the counts and move
   on. Do not open the implementation for those.
4. Only files outside the listed suites get real debugging. For those, decide
   "regression" vs "pre-existing" with one differential experiment (see
   *Proving a failure is not a regression*), not by reading code until it makes
   sense.

If a run shows a failing test file that belongs to a listed suite **and** a new
signature, update this ledger in the same change instead of reporting it twice.

### Expected counts on this machine (audited 2026-11-06)

| Suite | Observed | Composition |
| --- | --- | --- |
| `cargo test -p host-core --locked` | 4 fail / 1204 pass | rows 1–2 below |
| `apps/desktop` `node --test test/*.test.mjs` | 56 fail / 4890 pass / 23 skip | rows 3–8 below (11 files) |
| `packages/agent-runtime` `vitest run` | 0 fail | — (see row 9) |

A run whose failures are a subset of these rows needs no further analysis. A run
with **more** failures is investigated, because a count increase with an
unchanged ledger means either a regression or a new platform-only case that
belongs in this file.

## Why this file exists

On 2026-11-05 the full local suites were audited (HEAD `2e5f39dc8`, Windows 11,
Git Bash host): 21 of 1202 `cargo test -p host-core` cases and 41 of 4918
`node --test test/*.test.mjs` cases fail **by design or by environment**, not by
product defect. Roughly two agent-hours were spent re-deriving that conclusion
from scratch, then re-proving it against a pre-merge baseline (failure lists
were byte-identical before and after a 41-file merge). Do not repeat that work.

On 2026-11-06 the same audit was repeated against a merged tree (61 upstream
commits) because the ledger's counts were stale (41 → 56 desktop cases) and
because it did not cover the `packages/agent-runtime` vitest suite at all. That
run cost another couple of agent-hours: the counts above and row 9 are the
result. Use them; do not regenerate them.

The authoritative platform for both suites is CI: `cargo test -p host-core
--locked` runs on `ubuntu-latest` (`.github/workflows/ci.yml`, the `rust` job),
and `node --test` runs under the `pnpm -r --if-present test` job on
`ubuntu-latest`. The `rust-windows` CI job intentionally runs only the
transcript-cache E2E subset. CI has been green with these same cases excluded
by platform ever since they were written.

## Decision rule for a failing case

1. Reproduce the exact assertion (or error) from the failure output.
2. Check the tables below. If the file (or the signature) matches, stop — record
   it and move on. Do not open the implementation looking for a bug.
3. Only a failure that is **not** listed here, or that appears on Linux/macOS
   CI, is a real regression.

## Proving a failure is not a regression

One experiment, then stop. Never conclude "pre-existing" from the assertion text
alone, and never conclude "regression" from `git log` alone — local commits can
be older than the failure.

* Cheapest: swap only the suspect implementation file for its pre-merge version,
  re-run the failing file, restore it, and verify the restore with a checksum:

  ```bash
  sha256sum path/to/impl.ts > "$PI_SCRATCH_DIR/impl.sha"
  cp path/to/impl.ts "$PI_SCRATCH_DIR/impl.merged.ts"
  git show <pre-merge-rev>:path/to/impl.ts > path/to/impl.ts
  node --test test/target.test.mjs            # or vitest run src/target.test.ts
  cp "$PI_SCRATCH_DIR/impl.merged.ts" path/to/impl.ts
  sha256sum -c "$PI_SCRATCH_DIR/impl.sha"
  ```

* If the failure needs a dependency tree that the other revision never had,
  swap the test/fixture file instead of building a second install.
* If the failure disappears when the file runs alone but reappears in the full
  suite, it is resource contention, not a defect: re-run it alone to record the
  truth, and do not chase it.

## Known platform-limited cases (do not fix, do not re-investigate)

| Suite | Cases | Root cause | Why it stays |
| --- | --- | --- | --- |
| `cargo test` `session_worktrees`/`rpc::worktree_rpc` | 12 | Fixed 2026-11-05: `init_repo` now pins `core.autocrlf=false`/`core.eol=lf` in `test_support.rs` | — |
| `cargo test` `data_relocation` | 3 | Fixed 2026-11-05: assertions use `canonical_project_path`, and `rewrite_capability_state` now stores normalized keys (real Windows fix) | — |
| `cargo test` `rpc::remote_tools` (2), `background_tasks::windows_tests` (1), `tools::tests` (2) | 5 | Git Bash host: `sh`-re-written argv, `ps`/job-object topology under `cargo test`, machine registry `cmd.exe AutoRun` | The guarded behavior is Windows-production code paths whose test harness cannot exist under `cargo test` on this host; they pass on Linux CI where applicable |
| `test/remote-host-ssh-transport`, `remote-host-ssh-password`, `remote-host-artifact-transfer`, `remote-host-bootstrap-script` | 22 cases (2026-11-06) | Spawn `sh`/`ssh` fixtures, `chmod 0o755` as exec bit, `tar -C C:\` parsed as rsh host | POSIX remote-host tooling; CI runs them on Linux |
| `test/remote-provider-sync` | 1 | `ADMIN_UNAVAILABLE` thrown deliberately on `win32` (`apps/pi-host/src/admin-socket.ts`) | Product decision: unix-socket permission model does not exist on Windows |
| `test/macos-release-verification`, `macos-signing-diagnostics`, `macos-signing-watchdog` | 26 cases (2026-11-06) | macOS-only notarize/staple scripts invoked through `URL.pathname` (POSIX shape), `kill(-pid)` process groups, `codesign` fixtures | macOS release machinery |
| `test/computer-use-permission-user-path`, `config-sync-user-path`, `jev-service-setup-user-path` | 3 | Chromium profile teardown races Windows file locks (`EBUSY` on `Network/Trust Tokens`) or exceeds the 50 s test timeout when Electron cold-starts | Pass individually / on CI; not deterministic locally |
| `test/open-attachment-video` | 1 | Needs a real file symlink; this host has no Developer Mode, so `symlink` → `EPERM` | The guarded behavior (alias via symlink) is unreachable on unprivileged Windows anyway |
| `test/storage-maintenance` junction cases | 0 (skipped) | `{ relative: true }` targets cannot be expressed by junctions; the helper `t.skip()`s them | Skipped, not failed — count them under `skipped`, never as red |
| `packages/agent-runtime` `vitest run` | 0 fail / 1846 pass / 1 skip (2026-11-06) | Nothing in this suite is platform-limited, so a failure here is a real defect. Two files drive real child processes or 130-call loops: `scripts/bundle-assets.test.mjs` and `src/subagent-recovery.test.ts`. They pass in isolation but used to overrun Vitest's default 5 s per-test limit under full-suite parallelism, so both now declare a 60 s budget, mirroring upstream `c41008216` for `apps/pi-host`. Do not "fix" a future timeout there by raising that budget again; find the work that grew | — |

### What was actually verified

The audited 2026-11-06 desktop run reported `fail 56` across **11 failing test
files**, and every one of those files appears in the rows above. That is the
durable fact: compare by **failing file set**, not by re-deriving case counts,
which shift whenever a locale list, a fixture, or the spec reporter changes.
The per-suite case numbers above are the observed values of that one run and are
informational.

### Row 9 in practice: host fixtures must declare `provider.delegationSnapshot`

`promptTurn` awaits a session delegation-policy refresh before every provider
request, and that refresh calls the Host RPC `provider.delegationSnapshot`. A
test host stub that only knows `tools.fileBatchCapabilities` and
`session.appendMessage` therefore fails the whole turn *before the first
request*, which looks like an infinite hang: the loop retries, `prompt()` never
settles, and `vi.waitFor`/`await received` time out with an empty `requests`
array (2026-11-06: this cost 8 wasted red cases in `mode-tool-access.test.ts`
and `parent-stop-retirement.test.ts`).

Recognize the signature — **first provider request never arrives, no assertion
error, only a timeout** — then check the fixture's host stub. An older Host
answers `undefined` for this RPC and the launch policy stands, so the correct
stub is one line:

```ts
if (method === "provider.delegationSnapshot") return undefined as T;
```

New runtime tests that build a `DesktopAgentRuntime` with a hand-written host
stub must include it. `runtime.test.ts` already does. Do not "fix" this by
raising a timeout or by swallowing the policy refresh: a Host failure there is
supposed to fail the turn.

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
