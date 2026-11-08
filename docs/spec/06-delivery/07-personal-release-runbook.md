# Personal Windows Build and Beta Release

## Entry and safety boundary

Use the current checkout and existing toolchain. The only personal packaging
entry is `pnpm dist:personal`. It builds a Windows x64 NSIS installer, verifies
it offline, and never installs, launches Desktop, stops processes, touches a
profile, commits, tags, pushes, or publishes to a remote.

**A packaging request never authorizes installation or application startup.**
Do not run an installer, including `/S` or a scratch `/D` target: NSIS retains
shared installation identity and may replace the daily app and registration.

## Build is not release

```bash
# Read-only preflight; no outputs or source version changes.
pnpm dist:personal --check

# Development package; retain the source version, even when rebuilding it.
pnpm dist:personal

# Preview an explicitly selected beta candidate without writing anything.
pnpm dist:personal --check --release 0.23.0-beta.1

# Build and record that candidate only after offline verification succeeds.
pnpm dist:personal --release 0.23.0-beta.1
```

The candidate above is an example, not an instruction to bump this checkout.
Choose versions from accepted scope, compatibility and relevant test evidence,
not build counts or the number of commits. Keep `X.Y.Z-beta.N` while the project
is in preview. A new candidate within one target line advances `beta.N`; a new
feature milestone may advance the minor line and restart at `beta.1`.

Ordinary packaging never changes `package.json`, Cargo versions, `APP_VERSION`,
README release lines, `CHANGELOG.md`, or the tracked release history. Every
successful build has a unique timestamp/commit/random build identifier in its
filename, metadata and packaged `piBuildId`. Repacking a version preserves its
previous installers. Build identifiers are not updater version precedence.

An explicit `--release <version>` requires a clean source checkout and a beta
version newer than the current version and recorded personal releases. A
locally existing `v<version>` tag is refused. No remote is contacted. Preflight
shows the exact proposed version files and Git-derived change list. It does
not allocate a build identifier, reserve a version, or write a release.

## Preconditions and provenance

- Inspect `git status --short`; preserve unrelated work. Ordinary builds can
  include dirty source, but metadata must say so. Commit intended work before
  an explicit release; do not auto-commit someone else's changes to get clean.
- Use existing Windows x64 Node/pnpm, Rust/MSVC, Electron and dependencies.
  Do not install a second environment solely for packaging.
- Do not fetch/merge, switch tags, create another checkout, copy binaries from
  another checkout, map drives, inject `NODE_OPTIONS`, change app identity,
  disable security guards, or silently bump versions.
- Git history is required. Preserve `.git` when moving/re-uploading this project.
  A missing/non-ancestor release baseline is an error, not permission to invent
  release notes. No GitHub connection is needed.
- Source snapshots record HEAD, tree, dirty state, changed paths and a SHA-256
  fingerprint of Git changes plus nonignored untracked files. Ignored files,
  live profiles and credentials are not searched for release notes. Large
  untracked source files fail explicitly rather than being silently omitted.
- Source changes after preflight or during packaging reject delivery. A release
  records its approved version override separately from its source commit; it
  does not pretend uncommitted version edits were already in that commit.

## Fixed build sequence

1. Acquire the build lock and recheck source identity.
2. For an explicit release only, apply the guarded shared workspace version plan.
3. Clean regenerable `.build` intermediates and the old fixed log; retain prior
   installers and metadata. `pnpm clean:personal-release` remains the standalone
   cleanup entry and preserves a live/stale lock for inspection.
4. Build Desktop dependencies with pnpm's real executable/JS entry and the exact
   `--filter @pi-desktop/desktop^... --fail-if-no-match run build` argv.
5. Build Host with `cargo build --release --locked` using the current `target/`.
6. Bundle the Node agent runtime and build Desktop Main/preload/renderer.
7. Run the offline updater regression tests, then installed electron-builder once
   with `--win nsis --x64 --publish never --config electron-builder.personal.cjs`.
8. Verify the ASAR/resource metadata, version, unique build ID and source commit;
   verify source has not changed, hash the installer, and write its audit files.
9. Only for an explicit release, update the tracked history and generated
   changelog. Update the latest-build pointer after successful delivery.

The existing six toolchain stages remain observable in the fixed log. Child
environments drop inherited profile overrides, `NODE_OPTIONS`, Cargo targets,
and untrusted personal build/source identifiers. The runner supplies its own
build ID and source commit only to its children. App ID, product/executable
identity and storage bootstrap are unchanged; the self-managed updater marker
still prevents official automatic updates.

## Outputs and change records

```text
apps/desktop/release/personal/
  PI-Desktop-Personal-Setup-<version>-<build-id>.exe
  PI-Desktop-Personal-Setup-<version>-<build-id>.exe.sha256
  PI-Desktop-Personal-Setup-<version>-<build-id>.exe.changes.md
  PI-Desktop-Personal-Setup-<version>-<build-id>.exe.build-info.json
  build-info.json             # latest successful build pointer
  .build/                     # regenerable builder intermediates
.artifacts/personal-release/
  build.log
  build.lock                  # never discard blindly after an abnormal exit
```

Only the installer EXE is installed. The other files are audit metadata.
`docs/releases/history.json` is the tracked personal release source of truth;
`CHANGELOG.md` is its generated human-readable view. The initial imported
personal-development baseline has no invented release version. The historical
mixed notes under `docs/project/unreleased.md` are retained for reference.

Notes state their Git comparison baseline. `feat`, `fix` and `perf` subjects
map to Added, Fixed and Improved; other subjects map to Maintenance. Every item
retains its commit ID. Empty categories say no changes were recorded. Dirty
changes are fingerprinted but never invented as feature descriptions. These
mechanical summaries need human review and do not prove complete feature
verification, stability, signing or upgrade compatibility.

Do not reuse/change an issued version or substitute an artifact under an old
build ID. Explicit-release source edits and release records remain uncommitted
for the maintainer to review. A failed build restores only its own unchanged
version edits, records no release, keeps prior outputs, and removes its lock.
Concurrent edits are preserved; an incomplete rollback is an actionable error,
not a reason to overwrite files or run `git reset`.

## Progress and validation

On this workstation, launch long builds through the established WMI/CIM process
path with scratch logging and the real exit status. The wrapper may invoke only
this fixed entry; it must not replace stages or sources. Inspect new log stages,
compiler/archiver activity and artifacts at bounded checkpoints. Do not sleep,
blindly restart, increase timeouts or kill unrelated processes.

Relevant offline checks for this workflow:

```bash
node --test apps/desktop/test/personal-release.test.mjs apps/desktop/test/personal-release-history.test.mjs apps/desktop/test/workspace-version.test.mjs apps/desktop/test/auto-update.test.mjs apps/desktop/test/updater-controller.test.mjs
pnpm check:agent-policy
pnpm dist:personal --check
```

A simulated runner test or read-only preflight is not a real installer build.
A successful offline package build is not an installation, first-launch,
Authenticode or existing-profile upgrade test. Stop at delivery; installation,
profile access, Git tags and remote publication require separate authorization.
