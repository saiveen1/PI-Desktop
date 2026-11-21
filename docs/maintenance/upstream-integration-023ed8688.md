# Upstream integration: 023ed8688

## Candidate

- Personal parent: `942ee99135a9e1994c466743749339acc07fbfc8`.
- Fetched upstream `vastsa/PI-Desktop` `main`:
  `023ed86884b20104015fde256143fdf1fd5fc556` (139 incoming commits).
- Merge base: `0ca811242628fa1f9cf796eee1ca0dd3f645c471`.
- Clean starting index and worktree. The integration does not publish a release,
  install Desktop, use the daily profile, or contact a real model provider.

## Integration decisions

- Keep the personal `0.23.1-beta.1` version on every source surface. Keep the
  inherited upstream changelog and both sides' additions in all nine locales.
  Automatic personal-beta validation selects the newest compatible inherited
  stable entry (`0.23.0` here); explicit stable checks still require the exact
  version at the head of its catalog. Both personal READMEs keep the existing
  personal release line rather than treating a Git merge as a release.
- Combine the Pi Responses patch: terminal placeholders cannot erase locally
  retained streamed content, and upstream's phase captured at item start
  survives a done item that does not repeat it. Explicit refusals and nonempty
  revisions still win. The offline frozen install verified the patch hash and
  the real patched adapter test exercises both fixes on the same output item.
- Keep runtime-owned compaction and the removal of the model-facing
  `new_context` tool. Adopt the upstream request-tail placement of context
  budget reminders without changing which actor controls compaction.
- Adopt upstream's Settings dialog, startup overlays and sidebar navigation
  without removing personal conversation organization, notifications or
  delegation controls. Reconcile scenario documents with the resulting shell.
- Keep background-job continuation opt-in, behind the owning session and turn
  admission. Trashing a session cancels pending continuation without reviving
  it on restore. Project relocation moves the active workspace without
  clearing unrelated sessions' Hashline edit provenance.
- Update the notification settings and tool-observer draft handoff to use
  Settings modal state. Opening the dialog captures the mounted composer's
  current draft without introducing per-keystroke serialization.

## Verification

Windows, Node 24.12.0, pnpm 12.8.1, using the candidate in this checkout:

- Frozen offline install, workspace JS build, Desktop typecheck, lint,
  agent-policy and release-doc checks passed. The release-check regressions
  passed 25 assertions; the Responses terminal adapter passed 25 tests.
- Runtime: 2,832 passed and one skipped; Shared: 1,712 passed; i18n: 40
  passed. The shared suite needed reduced parallelism, not a longer timeout.
- The isolated process-level background-continuation E2E passed against the
  candidate Host executable and a deterministic loopback provider.
- Host formatting and Clippy passed; 42 focused Host tests passed. The full
  Host run reported 1,506 passes, four ledger-listed Windows failures, three
  failures reproduced against the immutable personal parent, and three ignored.
- A documentation path-separator assertion reproduced on the personal parent.
  Two unchanged Host Runtime file-index cases timed out in the workspace run
  and passed with their original timeouts when run without file parallelism.
- Desktop focused regression runs: 230 passed, then 54 passed in a separate
  final pass covering the Settings search, Composer draft and notification work.
- `pi-host` is unchanged from the personal parent. Its Windows run reported
  22 passes, five skips and 42 POSIX-oriented fixture failures (Unix sockets,
  permissions, symlinks, paths and packaging). Linux qualification was not run.
- The full Desktop / installed-app suite and packaging were not run.
