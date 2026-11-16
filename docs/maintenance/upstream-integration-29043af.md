# Upstream integration: 29043af

## Candidate and authorization

- Common base: `dd66ca037391da7378be25becb1a8bcb8054298f`.
- Original personal tip: `bb5eb41303cbc346f9d028647b5f61f68f8c724e`.
- Approved preservation commit: `c1d9e306ff473f82d513b7e7a4650177714d8b9c`.
  This retains all 24 originally uncommitted role-skill-selection files.
- Integrated upstream: `29043af3371122e256bf265db31651da125d38e3`.
- The user separately requested source version `0.23.0`. Workspace manifests,
  Cargo metadata, the shared app version and both README release lines agree.
  Historical release records remain unchanged; this merge is not a published
  release, installer qualification or stability guarantee.

## Preservation decisions

| Area | Retained personal increment | Compatible upstream increment |
| --- | --- | --- |
| Compaction | Runtime-owned initiation, current-task execution evidence and paired receipts | Boundary-aware tool-carrier reconstruction, prior-summary handling and conservative CJK budgets |
| Job controls | Explicit Bash targets ignore unrelated delegation selectors; explicit delegation selectors must identify the same single delegation | Interruptible capability lookup and stop waits, without replaying the stop request |
| Delegations | Model approval/pools, configurable roles/limits, checkpoints, direct input, lifecycle observations and exact request identity | Additional restore and provider-error handling |
| Role skills | Omission inherits available skills; an explicit list restricts them; an empty list removes loader/catalog; update null restores inheritance | No implicit executable plugin/MCP grants |
| Session UI | Groups, labels, recycle bin, historical reply branching, reading ownership, image continuity and notifications | Stale-detail protection, accepted Goal state/turn attribution, composer focus and file references |
| Task presentation | Flat, chronological task rows and grouped task index | The upstream topology connector patch is inapplicable to the replaced markup; obsolete tree CSS is not restored |
| Storage | Personal delegation/history and path-normalization migrations and indexes | Schema 32, Goal completion reports and elapsed accounting, closed-suffix revision saves |
| Packaging | Personal workflow, release provenance and opt-in installation boundary | Native transcription loading and compatible package-size changes |

Personal schema 30 predates upstream elapsed/queued-Goal columns. The merged
v30-to-v31 transaction reconciles those missing columns before the report-table
migration; schema 32 follows. Fresh initialization uses the same column setup.
The local history index is restored idempotently, including for upstream v30–32
files. Tests cover populated old databases, backup/reopen and preserved values.
No live profile was opened or migrated during this integration.

A pre-validation inventory found all 326 personal-only source/test paths still
present. This is a structural preservation check, not proof of every behavior.
Tests also exercise concrete overlapping local and upstream contracts.

## Documentation migration

The upstream eight-domain E2E catalogs replace the monolithic scenario body.
The migration preserves 28 local-only named scenarios, reconciles 39 locally
modified named scenarios, and retains the changes to `US-UI-56` and `US-UI-67`.
The resulting catalog has 706 named E2E scenarios, including an explicit ID for
an existing Windows snapshot-clock scenario. The bounded migration check found
no missing local/upstream scenarios or duplicate heading IDs. The index records
the eight disambiguated legacy IDs; live references use their new destinations.

The eight Chinese modify/delete spec bodies follow upstream's entry-point-only
layout. Their local contracts remain in canonical English specifications.
Historical changed-file manifests are not rewritten to imply that retired paths
still exist. `docs/project/unreleased.md` remains because the personal release
runbook deliberately retains that historical reference.

ADR rewrites retain local amendments rather than choosing either side wholesale.
The README pair remains a personal-edition overview, not an upstream feature
catalog. Earlier provenance comparisons remain historical; this record does not
relabel upstream-only work as a personal addition.

## Verification record

The integration checks use the existing Windows toolchain and synthetic data.
The lockfile required five new packages; installation used frozen-lockfile mode
with lifecycle scripts disabled. No toolchain upgrade was performed.

Before merging, the preservation candidate passed 43 shared definition tests,
13 delegate-skill loop tests, 2 editor tests, 20 Rust user-subagent tests,
desktop typechecking and Rust formatting.

Integration evidence includes shared-source tests (813 passed), cross-package
contracts, Rust migration/session/transcript/mode/plugin tests, typechecking,
lint, and focused local/upstream regression tests. Final command results and
remaining limitations are recorded in the delivery report, not inferred from
successful textual conflict resolution.

The first highly parallel runtime run exposed native-session fixture timeouts;
those cases passed serially. A baseline differential reproduced the existing
parent-stop fixture failure: the output guard can end its outer stream before a
raw provider stream finishes. The repaired fixture gates the real awaited Host
worktree-settlement boundary and retains both retirement assertions without
changing production cancellation or increasing timeouts.

Desktop fixture reconciliation preserves internal wiring and assertions. File
reference security checks execute separately from the symbolic-link case; only
an OS-refused file-link setup is explicitly skipped. The task-layout regression
assertions remain unchanged. Range-selection checks compare selected IDs with
independently observed rendered order, not a stale hard-coded ordering. Plugin
JSON save tests synchronize on the public completion callback rather than hidden
window animation frames.

Not performed: production-provider calls, daily-profile access, application
installation/restart, installer packaging, publishing, interactive native Windows
snap qualification, or Linux/macOS execution. Platform skips and warnings are not
reported as successful verification of the unavailable behavior.
