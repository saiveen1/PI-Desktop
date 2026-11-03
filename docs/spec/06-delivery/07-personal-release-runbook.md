# Personal Windows Installer Runbook

## Contract

Use **the current checkout**. The only personal-release entry point is:

```bash
pnpm dist:personal
```

Both root and Desktop package aliases invoke `scripts/build-personal-release.mjs`.
This lane produces **one Windows x64 NSIS installer EXE**. It does not produce
ZIP/portable distributions, install anything, launch Desktop, or stop processes.
The ordinary upstream multi-platform release scripts remain unchanged.

**A packaging request never authorizes installation or application startup.**
Do not run the generated installer, even with `/S`, `/D=...`, or a scratch target.
NSIS installation identity is shared: a scratch install can replace the existing
installation, change uninstall registration/shortcuts, and disrupt the running app.
A separate filesystem directory is not installer isolation.

## Preconditions and read-only check

- Use the existing Windows x64 Node/pnpm, Rust/MSVC toolchain and dependencies.
- Read `git status --short`; preserve unrelated work and build that checkout.
- Do not fetch/merge, switch tags, create worktrees, copy generated binaries from
  another checkout, map drives, or install a second dependency tree for packaging.
- Do not inject `NODE_OPTIONS` monkey patches, change package-manager collectors,
  disable security tools, change installer identity, or silently bump versions.
- If dependencies are missing, stop and report the concrete prerequisite. Dependency
  provisioning is separate; the build script does not automatically install them.

```bash
pnpm dist:personal --check
```

This checks local configuration/tool paths and prints the source version and exact
commands **without building, creating profiles, or executing an installer**. It also
rejects long NSIS template paths rather than creating another build directory.
The script reports the checkout's version as-is. A different release tag label is
not evidence that a Host handshake timeout is caused by schema incompatibility.
Packaging success is not permission to downgrade or proof of profile compatibility.

## Fixed build sequence

1. Build Desktop's workspace dependencies via pnpm's real executable/JS entry,
   passing the dependency selector as one argv token, without a `cmd.exe` wrapper.
   Zero matching projects is an error. Do not invoke the old single-quoted
   `build:deps` shell string or build the documentation site as a workaround.
2. Compile Host with `cargo build --release --locked` into the current `target/`.
3. Bundle `packages/agent-runtime/dist-bundle` from current source.
4. Build Desktop's production Main/preload/renderer output.
5. Run the offline updater-controller regression tests (Electron/updater are stubs).
6. Invoke the installed electron-builder CLI once with
   `--win nsis --x64 --publish never --config electron-builder.personal.cjs`.
7. Inspect the archive and bundled resources offline, then publish the EXE and hash.

The child environment removes inherited Desktop data overrides and `NODE_OPTIONS`.
The pnpm executable directory comes first on PATH so dependency collection can use
native pnpm instead of layered cmd shims. Do not modify installed `node_modules`.

`electron-builder.personal.cjs` preserves appId, productName, executable/shortcut
identity and storage bootstrap. It fixes the target to NSIS x64, writes boolean
`piSelfManaged=true` and `piDistribution=installed`, and turns off installer
`runAfterFinish`. The current updater controller must actually honor the marker;
a marker added to unmodified upstream code alone is not an update-disable feature.

## Outputs and progress

```text
apps/desktop/release/personal/
  PI-Desktop-Personal-Setup-<checkout-version>.exe
  PI-Desktop-Personal-Setup-<checkout-version>.exe.sha256
  build-info.json
  .build/                 # builder intermediates, not another install
.artifacts/personal-release/
  build.log               # combined stage output
  build.lock              # present only while building (or after abnormal abort)
```

Only the installer EXE is an installation deliverable. The checksum and build-info
are audit metadata. Intermediates stay at the same fixed location; no numbered
retry directories or scratch installations. A failed build does not replace the
previous verified deliverable. Consult `build.log` before using an existing EXE.

The entry point streams every stage to the terminal and log. On Windows, agents
must launch the fixed entry through the workstation's required WMI process path,
with captured output/exit status; do not manufacture alternative build scripts.
A host-specific launcher may wrap this exact entry for logging, but must not alter
its stages, source, targets, or validation scope.

At a no-progress checkpoint inspect that build's log/owned compiler or archiver
activity; do not blindly restart, increase timeouts, or kill unrelated processes.
A stale `build.lock` is a reason to inspect, not permission to kill its PID.

## Allowed verification and delivery

- Test the runner with synthetic fixtures, a real ASAR parser, and stubbed external
  build commands; test failure/lock/missing-output paths.
- Check bundled version, boolean self-managed marker, installed distribution,
  Host executable, Main/renderer outputs, runtime sidecar and ESM manifest.
- Reject empty outputs and tiny installer stubs; generate SHA-256.
- Inspect signatures without executing the EXE when signing verification is needed.
  A log line saying `signing with signtool` is not evidence of a signed package.
- Report exact output path, source version, checks actually run and limitations.
- **Stop after delivery. The user installs it themselves.** No desktop/Electron
  smoke, `verify:ui:*`, silent installation, registry edits, profile copying,
  uninstall, process shutdown or restart under a build-only request.

Focused checks for changes to this pipeline:

```bash
node --test apps/desktop/test/personal-release.test.mjs apps/desktop/test/auto-update.test.mjs apps/desktop/test/updater-controller.test.mjs apps/desktop/test/agent-policy-sync.test.mjs
pnpm check:agent-policy
pnpm dist:personal --check
```

Do not claim that these checks prove a real full-profile upgrade works.

## If a previous agent installed into scratch

Cancel any installer showing an unexpected scratch installation path. Inspect
only the exact installation registration, shortcut targets and executable paths.
Never assume a directory named `smoke` is disposable: it may now be the running
installation and the current agent's own host.

Cleanup is a separate, explicitly authorized maintenance task. Remove only proven
unused build worktrees, fixtures and ad-hoc scripts. Preserve live installations,
actual data/browser roots, backups and unrelated changes. Do not call an uninstaller
or edit registration as a shortcut. Do not delete or repoint the registered
installation while it is running. If the original executable no longer exists,
restoring only a registry path cannot repair it. Report the remaining installation
repair for the user to perform in a separate maintenance window.
