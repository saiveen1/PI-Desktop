# ADR 0094: Admit one desktop instance per data directory

- Status: Accepted
- Date: 2026-08-18
- Related: D236, D002, D216, ADR 0078, ADR 0090

## Context

Nothing stopped a second process from starting and booting a complete second
copy: another host-core over the same `pi.sqlite`, another outbox, log tree,
agent sidecar, tray icon, launcher shortcut registration, and updater. A second
shell defeats single-writer ownership of SQLite (D002) with silent data
divergence. The data directory is what cannot be shared, but Electron's lock is
scoped to `userData`, not to `PI_DESKTOP_DATA_DIR`, and runs given their own
data directory must stay launchable.

## Decision

Electron main takes `app.requestSingleInstanceLock()` during module evaluation,
after `app.setName` and before anything touches the data directory. A launch
that does not get the lock calls `app.quit()` immediately and boots nothing, so
it creates no window, tray, child process, or log line in the running
instance's data directory. The lock holder handles `second-instance` by
restoring and focusing its window through the tray's Show path, and requests
the lock only when `PI_DESKTOP_DATA_DIR` is unset.

## Consequences

- One installation is one process: one host-core, one SQLite writer, one
  outbox, one tray, one launcher binding, one updater.
- Relaunching is a reliable way back to a tray-hidden or closed window.
- E2E harnesses and side-by-side profiles are unaffected because they set
  `PI_DESKTOP_DATA_DIR`; two runs pointed at the same explicit directory are
  still admitted.

## Alternatives

- Relocate `userData` under `PI_DESKTOP_DATA_DIR`: rejected, it also holds
  renderer `localStorage` (D093), plugin partitions, and browser cookies, which
  would be discarded for existing profile users.
- A lock file in the data directory: rejected, it re-implements the Electron
  lock and has no channel to raise the running window.

## Amendment (D599)

The lock remains scoped to `userData`, not `PI_DESKTOP_DATA_DIR`. Development
uses `PI-Desktop Dev` and `~/.pi-desktop-dev`; shipped installations retain
`PI-Desktop` and `~/.pi-desktop`, so no existing profile moves. An explicit
`--user-data-dir` still wins for isolated Electron/E2E fixtures.

The development launcher clears inherited `PI_DESKTOP_DATA_DIR` by default.
Only `pnpm dev --inherit-data-dir` opts into data-dependent debugging. That is
read/write access, requires stopping every previous owner and backing up its
complete profile, and supplies no concurrent-writer protection.

## Amendment: explicit storage relocation (2026-10-01)

Issue #1213 adds an explicitly confirmed, offline relocation of the complete
app and Chromium profile: the `userData` installation lock is retained while
Chromium `sessionData` may follow the copied browser profile, with no silent
relocation or reset of existing renderer state. See
[Custom storage location](custom-storage-location.md).
