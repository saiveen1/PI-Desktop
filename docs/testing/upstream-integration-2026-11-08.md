# Upstream integration: 2026-11-08

## Candidate and scope

- Local base: `75ac98246` (`main`), clean before the requested merge.
- Fetched upstream: `fc734a201` (`upstream/main`).
- Common ancestor: `d858250b6`.
- Incoming history: 76 upstream-only commits, including 32 non-merge commits.
- Integration uses the current checkout, retains both histories, and does not
  install or launch Desktop, use a daily profile, or contact an external model provider.

## Semantic decisions

| Overlap | Evidence and retained behavior | Incoming behavior adopted |
| --- | --- | --- |
| TaskWait / TaskStop selectors | Local `608123cdc` intentionally preserves delegation wait options and exact single-target equality. `43db88d7d` and `75a192387` repair repeated failures from irrelevant Bash defaults, including pre-validation normalization. Keep these contracts and their assertions. | Pi 1.5 schema imports. The equivalent-selector bug is already fixed locally; do not replace the local contract with upstream's empty/duplicate-ID acceptance or ignored delegation wait options. |
| Provider output-limit repair | Local delegate reporting forbids a hidden second request. The automatic merge added a ceiling-repair branch without consulting this permission. Two new regression cases reproduced two requests instead of one before the integration fix. | Keep upstream's stated-ceiling clamping for ordinary callers, but apply the same report-only permission guard to both repair branches. Preserve physical-attempt diagnostics. |
| Sidebar recovery | Local `75ac98246` separates project groups from display-only labels and retains activity order. Keep scoped catalogs, membership, colors, activity ordering and normalization. | Application-owned backup, fresh-Chromium recovery, explicit closed-tab retention, trusted-frame IPC, bounded atomic writes and relocation. Add a backup/save/restore test for local organization data. |
| Message metadata | Local run diagnostics remain optional, persisted and round-tripped. | Add response-model identity and cost queries alongside diagnostics; neither field replaces the other. |
| Profile relocation | Read-only review found that upstream only remapped paths/project metadata, stranding the local path-scoped group/label catalog. An extended regression reproduced a missing catalog before the fix. | Remap `project:` catalog keys and session scope references with the existing path normalizer. Keep stable/remote/temporary/external scopes, names, labels, colors and order unchanged; all 9 relocation tests pass. |
| Pi dependency boundary | Local-only delegation modules and tests also require schema-import adaptation; upstream cannot update files it does not have. | Align dependencies and patches at Pi 1.5.0; import Type from the existing direct typebox dependency without altering tool schemas. |
| Release identity and changelogs | Keep the personal beta version, packaging lane, policy and all local release-note entries. | Add upstream release-note entries in all nine shipped locales without replacing local notes. |
| Existing UI fixture drift | The pre-merge Sidebar and fixture were unchanged by upstream, but the fixture still required duplicate label shortcuts and a retired label filter. A controlled esbuild experiment using the matched pre-merge store/preferences reproduced both failures without modifying repository source. | Align only the fixture with the accepted local project-group/display-only-label ADR. Keep archive/trash/restore/permanent-deletion checks and test exclusive groups, label chips, scope-isolated folding, selection and narrow layouts. Both user paths pass. |

The new repository policy requires history, implementation, specification and
regression-test comparison before upstream integration, including conflict-free
auto-merges. A newer upstream commit is not evidence that a local repair is
obsolete. The policy entry points and delivery workflow are synchronized.

## Validation

Validation is against the merged working tree, not the original local or upstream
branch in isolation. Windows Git Bash, Node 24.12.0, pnpm 12.8.1 and Rust 1.93.0;
reuse the existing dependencies and build caches. pnpm synchronized the existing
installation to the merged lockfile during the policy check.

- Policy check and its 8 regression tests passed.
- Pi dependency and patch gates passed at 1.5.0.
- Provider retry and background-job unit tests: 75 passed after the guard fix.
- Sidebar recovery, backup IPC, bootstrap and scoped organization: 21 passed.
  An initial IPC failure used stale shared output with undefined new channel
  constants; rebuilding shared resolved it without changing permissions/tests.
- `pnpm build:js`, Desktop typecheck, and lint passed. Build initially exposed
  local-only Pi schema imports and a repository-root changelog link outside the
  documentation site's root; both were fixed without bypassing checks.
- Agent Runtime full suite: 138 files, 2,001 passed and 1 skipped.
- Shared package: 1,524 passed (the runner collects source and generated tests).
  i18n: 31 passed.
- Desktop affected/retained-feature batch: 421 passed and 4 timeout cancellations.
  Serial isolation passed the image-model and subagent-scheduling cases. The two
  remaining stale organization fixtures were diagnosed against the pre-merge
  boundary, aligned to the existing local ADR, and passed (2/2). No timeout grew.
- Initial Host full suite: 1,260 passed, 5 failed and 2 ignored. Four failures
  are existing Windows remote-tool/process harness limits in the ledger. The
  fifth was an upstream test expecting a verbatim Windows prefix despite the
  existing normalized-path contract; fixing that expectation preserves the
  transaction rollback assertion. Final focused suites: relocation 9/9 and
  project paths 7/7. The full Host suite was not repeated after these scoped fixes.
- Host debug build, Rust formatting and all-target Clippy passed. Clippy retains
  three warnings in unchanged computer/review/transcript code.
- Isolated real-Host/local-provider selector E2E passed all 7 rounds, including
  report re-read and stopping a running delegate, with local wait options kept.
- Documentation structure/index check passed for 631 pages; missing existing ADR
  and personal-runbook index links were added. The release-doc gate passed in its
  documented `0.22.0` prerelease-preview mode for the unchanged `0.22.0-beta.3`.
- `pnpm docs:check` is NOT GREEN: one missing Chinese runbook and seven mirror
  structure mismatches. The same checker run against an archived `75ac98246`
  documentation snapshot produced the identical set: no new missing/invalid pair.
  This existing translation debt was not expanded into a broad rewrite.
- The final checks did not rerun unrelated workspace suites or installed-app
  acceptance. The runtime did not expose a confirmed parent model identifier,
  so no guessed `AI-Model` commit trailer is supplied.

No installer, running Desktop, real-provider, or existing-profile upgrade test is
implied. Full native UI acceptance remains outside this integration's scope.
