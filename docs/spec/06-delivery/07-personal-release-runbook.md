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
version newer than the current version and recorded personal releases. A stable
current version is valid as a comparison baseline; a beta of that same version
is older and is rejected. A locally existing `v<version>` tag is refused. No
remote is contacted. Preflight
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
8. Require Main's `photon_rs_bg.wasm` before packaging and validate the copy in
   the final ASAR. Verify resource metadata, version, unique build ID and source commit;
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
node --test apps/desktop/test/personal-release.test.mjs apps/desktop/test/personal-release-history.test.mjs apps/desktop/test/workspace-version.test.mjs apps/desktop/test/main-wasm-assets.test.mjs apps/desktop/test/auto-update.test.mjs apps/desktop/test/updater-controller.test.mjs
pnpm check:agent-policy
pnpm dist:personal --check
```

A simulated runner test or read-only preflight is not a real installer build.
A successful offline package build is not an installation, first-launch,
Authenticode or existing-profile upgrade test. Stop at delivery; installation,
profile access, Git tags and remote publication require separate authorization.

## GitHub Actions: personal fork only

[Personal Windows](../../../.github/workflows/personal-windows.yml) is restricted
to `saiveen1/PI-Desktop`, branch `main`. Code pushes build the current version;
documentation-only pushes do not. Manual dispatch with an empty `release_version`
also builds without publishing. Ordinary builds accept a stable or beta current
version; explicit publication remains beta-only. The Windows job installs locked
dependencies on the clean hosted runner and calls the same `pnpm dist:personal` entry, with offline
release/policy regression, Desktop typecheck and lint. It never installs or
launches Desktop. No signing credential or personal access token is required for
this unsigned personal lane.

Successful delivery uploads exactly the installer, its SHA-256, change notes and
build-info sidecars as `personal-windows-<run-id>-<attempt>`, retained for 30 days.
The build log is a separate 14-day artifact, including failed builds when the log
exists. Artifacts are downloadable from the completed run; they are not a GitHub
Release, a new version, an updater feed, or proof of installation compatibility.

### Explicit beta publication

In Actions, select **Personal Windows → Run workflow → main** and enter a newer
`X.Y.Z-beta.N` in `release_version`. This explicit action authorizes the workflow's
metadata commit, personal tag and prerelease publication; a push never does.

1. Windows validates the input, builds with `pnpm dist:personal --release`, and
   verifies version, source identity and the installer hash before upload.
2. A separate read/write publication job checks out the exact built source and
   downloads the delivery by the successful build job's artifact ID, not the
   publication attempt number (which can change on failed-job reruns). It rechecks bytes, source/version,
   Git-derived notes and the allowlisted version changes. It reconstructs version
   and release-history files using the existing helpers; no downloaded source
   patch is applied. Build metadata records the original source plus its explicit
   version override, not the later metadata-only commit.
3. The bot commits only those version/history files, then atomically pushes `main`
   and `personal-vX.Y.Z-beta.N`. A changed remote `main` or existing conflicting
   tag fails without force, rebase or overwrite. The personal tag does not match
   the inherited `v*.*.*` release trigger.
4. The job creates a prerelease with the four verified files. Only this job has
   `contents: write`; the build job has read-only access and no persisted checkout
   credentials. Standard `GITHUB_TOKEN` supplies publication permission. A
   repository/ruleset that disallows the bot's push fails rather than bypassing it.

The build script itself remains build-only. The workflow is the separately
authorized publishing layer. After a release, fetch/review its bot commit before
further local work; do not overwrite it with a stale branch or reuse its version.
The workflow never enables the installed app's updater.

### Initial setup and interrupted publication

On a recreated fork, keep inherited workflows disabled and enable only
`personal-windows.yml` for the personal lane. Check the repository's actual Actions
state; copying YAML is not proof that a run started. The Actions page must show a
successful Windows build and its installer artifact before claiming cloud packaging
works. The first build can be manually dispatched with no version to verify setup.

Runs are serialized with running work preserved; GitHub may replace an older
pending run with a newer queued run. If `main` advances during a beta build, inspect
the new source and dispatch a fresh candidate rather than force-pushing. If the
metadata/tag push succeeded but Release creation/upload failed, keep those refs and
the exact run's artifacts. Inspect the existing Release and complete only missing
publication of that same artifact/tag; do not rebuild and overwrite an issued
version, delete tags automatically, or blindly rerun the entire release.

Offline regression: `node --test apps/desktop/test/personal-ci.test.mjs`. It covers
ordinary builds, explicit version/history reconstruction, tampered artifacts,
source mismatch, extra files, dirty checkouts and non-fast-forward atomic rejection
using synthetic packages and temporary local Git remotes. It is not live GitHub
publication or a real installer test.
