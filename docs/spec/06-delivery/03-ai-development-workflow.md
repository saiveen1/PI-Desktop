# 03. AI-Assisted Development Workflow

> Scope: AI agents and human collaborators working on PI-Desktop
> Status: Accepted
> Cross-references: [00-baseline](../00-baseline.md) · [decisions-log](../08-meta/decisions-log.md) · [acceptance-criteria](02-acceptance-criteria.md) · [e2e-test-plan](04-e2e-test-plan.md) · [change-checklist](05-change-checklist.md) · [ADR index](../../adr/README.md)

---

## 1. Core Immutable Rules

These rules implement `AGENTS.md`, which is the authoritative repository policy.
`CLAUDE.md` is only a short entry point that delegates to `AGENTS.md`; it is not
a second policy version. Product behavior, protocols, persistence, and security
contracts stay authoritative in `docs/spec/`. This independently maintained
personal edition develops in place; upstream contribution procedures apply only
when remote delivery is requested against a verified target remote.

### R1 — Spec-first / Spec-sync

> **No behavior change without updating the corresponding spec.**

- Every code, config, or UX change that alters observable behavior must update the relevant `docs/spec/` document before or alongside the change.
- Architectural boundary changes (process model, IPC contract, storage ownership, security boundary) also require an ADR — see `docs/adr/README.md`.
- Pure refactors preserve behavior and API contracts; use the same validation and delivery authorization rules as other changes.

### R2 — Requested commits

Commit only when the user requests it. Review the diff, stage explicit paths,
and use a conventional subject plus body. Otherwise report local changes and
leave them in the current checkout; do not discard work to satisfy a commit rule.

### R3 — E2E coverage doc

> **Every feature/fix that affects user-visible or protocol-visible behavior must update e2e test documentation.**

- "User-visible": anything the end-user sees or interacts with (UI, CLI output, dialogs, notifications).
- "Protocol-visible": IPC messages, RPC methods, plugin API surfaces, event payloads.
- Document the scenario in `06-delivery/04-e2e-test-plan.md` — even before the automated test exists.
- Internal-only changes (logging format, internal variable rename) do not require e2e doc updates.

### R4 — Local checkout and optional isolation

Develop in the current checkout by default, including on local `main`.
Branches and worktrees are optional, not prerequisites for development.

- Inspect `git status --short` before editing and preserve unrelated changes.
- Do not automatically switch branches, fetch/rebase upstream, create a
  worktree, or require a PR merely to implement a local request.
- Use a separate branch/worktree only when requested or concurrency warrants
  isolation. Do not modify or remove another task's work.
- Reuse existing compatible toolchains, dependencies, and build caches.
  Keep mutable test profiles/data, ports, logs, and artifacts separate from
  the daily installation. Install/rebuild only for missing or incompatible
  dependencies, and record why; do not create a new environment solely for E2E.
- Run relevant checks in the current checkout, review the diff, and report
  actual results. A local completion does not require upstream integration.
- Commits, pushes, PRs, remote merges, installation, and application restarts
  each follow the user's authorized scope. Editing code does not authorize
  touching the running Release or its data.
- Dev launchers discard inherited `PI_DESKTOP_DATA_DIR` by default. The explicit
  `pnpm dev --inherit-data-dir` opt-in is for authorized data-dependent debugging,
  preferably an offline profile copy. Real-data use requires stopping all owners
  and a complete backup; it is read/write and not safe concurrent sharing.
- Upstream sync and contribution happen only when explicitly requested, against a
  target remote verified for that request; never assume `origin/main` is
  upstream. For a requested pull request, incorporate the intended target's
  latest applicable base, use the target repository's own base check, and
  validate the actual integration candidate without discarding local work or
  force-pushing shared history.
- Before an upstream merge, compare both histories, implementation, specs and
  regression tests, including conflict-free overlaps. A newer upstream commit
  may still lack an intentional local optimization or fix. Preserve that local
  behavior unless evidence proves it superseded without regression, or the user
  explicitly approves the explained change. Never change local assertions just
  to match upstream; record material decisions and test both retained fixes and
  adopted updates.
- Retire optional worktrees only when authorized and after verifying their
  changes are committed or safely migrated. Delete no unique work.

### R4.1 — Personal packaging is build-only

Use `pnpm dist:personal` in the current checkout and follow
[the fixed personal release runbook](07-personal-release-runbook.md).
Deliver only the Windows x64 NSIS EXE with offline verification and SHA-256.
Do not switch tags, create worktrees, inject hooks, or improvise build pipelines.
A packaging request never authorizes installing, launching, stopping/restarting
Desktop, editing installation registration/shortcuts, or copying live profiles.
An NSIS scratch installation is not isolated: it shares the application's identity.

An ordinary `pnpm dist:personal` build never changes the app version: beta stays
the release state, and packaging never guesses or bumps a version. Every
successful build records a unique build identifier, the exact Git source and
dirty state, and Added/Fixed/Improved/Maintenance notes derived from Git, so a
delivered installer is traceable. Only an explicitly requested candidate release
selects a new version, once accepted scope, compatibility, and tests justify it.
Do not claim stability, installed-upgrade success, or test coverage that was not
verified, and do not create tags, commits, or pushes on your own initiative.

### R5 — Verify linked GitHub issues before work, then reply and close

> **A linked GitHub issue is not a task until the reported problem is shown to exist. After the outcome is conclusive, reply on that issue and close it.**

This rule applies when the user prompt includes a GitHub issue URL or an
unambiguous issue number for this repository.

- Fetch the issue (title, body, labels, comments, and state) before editing
  files for the claimed problem.
- Independently verify the claim against the current codebase. For a bug,
  reproduce it or cite concrete code/spec evidence. For a feature or
  improvement, confirm the requested behavior is actually missing or incomplete
  and in scope.
- Do not start implementation until verification confirms the problem exists.
- If the problem does not exist (already fixed, invalid, or a
  misunderstanding): comment with the verification evidence and close the issue
  when that conclusion is clear. If verification is inconclusive, comment with
  what was tried and leave the issue open.
- If the problem exists: follow R4, implement the smallest coherent change, and
  after the fix is accepted (merged, or landed in the authorized delivery
  target), comment with the resolution and close the issue.
- Write the GitHub comment in the language of the original issue title and
  body. Code, commits, specs, and other repository documentation stay English.
- An issue link authorizes commenting on and closing **that** issue only. It
  does not authorize a git push. Remote publishing remains opt-in per R4 and
  `AGENTS.md`.
- Do not comment on or close unrelated issues. Do not reopen a closed issue
  unless the user explicitly asks.

### R6 — Land a linked pull request only when it fixes the root cause with a minimal diff

> **A linked GitHub pull request lands only when it actually removes the reported failure mode at the root, with the smallest coherent change. A sound direction is not enough. Completeness nits may follow after merge; an incomplete fix may not.**

This rule applies when the user prompt includes a GitHub pull request URL or
an unambiguous pull request number for this repository.

- Fetch the pull request (title, body, files, commits, comments, checks, draft
  state, base/head, and linked issues) before creating a replacement
  implementation or requesting a rewrite.
- Independently verify all of:
  1. The reported problem is real and in scope (same bar as R5).
  2. The change must fix the reported root cause with the smallest coherent
     change — not a nearby symptom, a docs-only restatement, a config
     contract test, or a partial workaround that leaves the original path
     intact.
  3. Extra files, refactors, and spec theater do not compensate for an
     incomplete fix. The approach must still be compatible with the
     baseline, security boundaries, and architecture (or be a justified
     spec-backed amendment).
- Do not reimplement the pull request as a replacement, close it for nits, or
  ask the contributor to start over when (1)–(3) hold.
- If (1)–(3) hold:
  1. Merge **that** pull request first, preserving the contributor's commits.
     Use a repository-permitted merge strategy that keeps the contributor as
     author of the landed work.
  2. Missing additional test coverage, documentation, naming cleanup,
     formatting, and other non-blocking polish are follow-up work **only
     when they are not required to prove the root-cause fix**. Build,
     typecheck, relevant existing test, required E2E, security, data-safety,
     protocol-compatibility, and merge-conflict failures remain landing
     blockers.
  3. Landing blockers that would break `main` (the change does not compile,
     fails existing tests for the changed area, or has merge conflicts) may
     receive the smallest commits **on top of** the author's work so the pull
     request can land. Do not squash away the author. Do not rewrite the
     design. Do not expand the diff beyond the root-cause fix.
  4. After the pull request is in `main`, follow R4 for any follow-up
     improvements from the updated `main`.
  5. Comment on the pull request in its language: acknowledge the
     contribution, state what was merged, and list follow-up if any.
- If (1)–(3) fail, or a harm blocker exists (secrets, sandbox or privilege
  bypass, malicious or clearly destructive changes, out-of-scope reversal of
  a frozen decision, unrelated drive-by payload): do not merge, do not
  approve as "direction is fine, follow up later", and comment with the
  evidence in the pull request's language. Prefer a minimal completion of
  the author's approach when that approach can actually reach the root
  cause. Do not silently reimplement the same idea as if the pull request
  never existed unless the user asks to take the work over.
- Do not merge a draft pull request the author has not marked ready, unless
  the user explicitly asks to merge the draft. Comment with the review and
  wait until it is ready.
- A pull request link authorizes reviewing, commenting on, and merging
  **that** pull request when this rule applies. It does not authorize
  force-pushing the contributor's branch or publishing unrelated branches.
  Follow-up still follows R4's opt-in remote publishing rule.
- Do not comment on or merge unrelated pull requests. An already-merged pull
  request is not reopened; remaining gaps become ordinary follow-up.
- When both an issue and a pull request are linked, R6 applies to the pull
  request and R5 still applies to the issue after the merged outcome.

#### R6.1 — No local outside-contribution policy

This personal edition has no outside-contribution policy of its own. The
temporary upstream pull-request type restriction therefore does not apply here;
it only describes how upstream handles its own intake. R6 still governs any
linked pull request that this repository explicitly acts on.

### R7 — Validate the actual candidate

Code-bearing changes require the relevant tests for their regression surface,
including E2E where real process/filesystem/browser boundaries require it.
Run task-candidate validation from the current checkout or an optional worktree.
Local validation does not require fetching or rebasing onto upstream `main`.

Record the tested revision and uncommitted changes, commands, results, and
environment. Keep temporary test state separate from the user's running daily
application; do not use live providers or the running desktop without explicit
authorization. `verify:ui:*` still requires the user's explicit request.

For requested remote delivery, validate a candidate that includes the intended
target's latest applicable base before the PR and validate its actual integration
candidate before landing. Re-run affected checks if executable content changes.
Do not merge into a particular local branch merely to satisfy a test gate.

If a required check cannot run, report `NOT RUN`, why, alternative evidence,
and remaining risk. Do not claim an untested package is safe to install.

### GitHub issue templates

`.github/ISSUE_TEMPLATE` is the only public intake path (`blank_issues_enabled:
false`). English is the source label language; Chinese remains on the same
fields.

- **Bug report** requires: description, reproduction steps, expected behavior,
  actual behavior, app version, and OS. Logs, extra environment, and
  screenshots are optional. Settings → Info prefills version, OS, and
  environment when opened from the app (D313).
- **Feature request** requires: problem and proposed change. Alternatives and
  extra context are optional.

Do not weaken these required fields. Blank issues stay disabled.

---

## 2. Development Loop

Every change follows this sequence. Steps may be iterated if the implementation reveals new requirements. If the prompt includes a GitHub issue, complete R5 verification before step 1. If the prompt includes a GitHub pull request, complete the R6 root-cause review (and merge only when the change actually fixes the problem with a minimal diff) before starting a replacement or follow-up implementation.

```text
0. Verify linked issue/PR claims when applicable (R5/R6)
1. Inspect the current checkout and preserve existing changes
2. Read baseline, relevant specs, and source/tests
3. Plan the smallest change and required validation
4. Implement in place; update affected specs and E2E documentation
5. Run relevant checks and review the diff
6. Commit only if requested; update BOARD if milestone-related
7. Perform remote delivery or launch only if explicitly authorized
8. Report results, limitations, and remaining steps
```

Branches/worktrees are optional under R4. Remote contribution gates apply only
to requested upstream delivery, not ordinary local development.

### Local Validation and E2E Execution Policy

- Choose the lowest test level that can prove the changed behavior. Follow
  `AGENTS.md` §12 and the affected surface's test plan; do not weaken tests.
- E2E documentation (R3) and actual E2E execution are separate requirements.
- Run checks against the source being delivered, in the current checkout.
  An optional worktree may be used, but is not a prerequisite for validation.
- Reuse the existing compatible toolchain and dependencies; isolate mutable
  test state. Missing/incompatible dependencies may be provisioned with the
  reason recorded. Do not reinstall an environment solely for each E2E run.
- Report required checks that cannot run as `NOT RUN`, including alternative
  evidence and residual risk. Never report skipped checks as passing.
- For requested PR delivery, refresh and test the applicable integration
  candidate. Re-run affected checks when landing changes its executable content.

### Marketplace/update diagnosis gate

Plugin update incidents require an evidence-first prompt flow before code
changes:

1. Capture the exact plugin ID, installed version, displayed version, expected
   release, catalog URL, and observation time.
2. Fetch the live catalog and inspect the exact entry, then inspect the local
   catalog cache and installed registry independently.
3. Classify the failure boundary: publisher/catalog data, fetch/cache fallback,
   host version comparison, IPC propagation, or renderer presentation.
4. Run `pnpm check:marketplace -- --url <catalog-url> --plugin <id>`. Missing
   `shasum`, `url`, positive `sizeBytes`, or `permissions`, or a catalog
   `author` that is not a string (for example `{ name, url }` copied from a
   plugin manifest), is a release-data failure, not evidence of a stale
   renderer. Incomplete releases remain non-installable.
5. Reproduce with a fixture containing unsorted versions and incomplete
   metadata before changing host or renderer code.

The agent must state which boundary failed and what evidence rules out the
other boundaries. A client-side fallback may preserve safe discovery, but it
must not be used to conceal an invalid marketplace release.

---

## 3. Spec Update Matrix

Which change types require which doc updates.

| Change type | Spec update | ADR | Decisions-log | E2E doc | BOARD |
|---|---|---|---|---|---|
| New feature (user-visible) | Related domain spec | If architectural boundary | — | New scenario | If milestone deliverable |
| Bug fix (user-visible) | Related spec if behavior clarified | — | — | New or updated scenario | — |
| Bug fix (internal) | — | — | — | — | — |
| Refactor (behavior preserved) | — | — | — | — | — |
| Architectural change | Related specs + baseline | **New ADR** | Update entry if default changes | Update affected scenarios | — |
| New IPC/RPC method | `03-runtime/01-ipc-protocol.md` or `06-host-rpc-protocol.md` | If contract boundary | — | New protocol scenario | — |
| Plugin API addition | `07-plugins/03-plugin-api.md` | If boundary change | — | New plugin scenario | If M4 deliverable |
| Security change | `05-security/01-security.md` | If boundary change | Update if D001–D010 touched | New security scenario | — |
| UX change | Related `04-ux/` spec | — | — | New UI scenario | — |
| Spec-only update | The spec itself | — | — | — | — |
| Chore (deps, tooling) | — | — | If tooling decision | — | — |
| **App version release / stable tag** | `06-delivery/06-release-runbook.md` (mandatory version-surface gate before tag: shipped-locale `packages/shared/src/changelog.ts`, its test list, all workspace/Cargo/`APP_VERSION` versions, and the release line in `README.md` + `README.zh-CN.md`) | — | If release policy changes | Confirm E2E-067B still accurate | If milestone ship |

---

## 4. Git Commit Rules

### 4.1 Conventional Commits

Format: `type(scope): description`

| Type | Use for |
|---|---|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation-only change |
| `test` | Adding or updating tests |
| `chore` | Build, deps, tooling, CI |
| `refactor` | Code restructuring, no behavior change |
| `perf` | Performance improvement |
| `build` | Build system or external dependency change |
| `ci` | CI/CD configuration change |

**Scope** is optional but encouraged — e.g. `feat(host-core):`, `fix(ui):`, `docs(spec):`.

### 4.2 Language

- Commit messages: **English only** (matches baseline language policy).
- Body: optional; use for non-obvious context.

### 4.3 One logical change per commit

- Prefer small, focused commits.
- Spec updates that are tightly coupled to the code change should be in the same commit.
- Pure doc changes (spec rewrite, ADR) may be a separate adjacent `docs:` commit.

### 4.4 Never commit

- Secrets, API keys, tokens, passwords
- Local-only data (user configs, session data, logs)
- `node_modules/`, build artifacts, release packages
- Generated files that should be rebuilt per CI

### 4.5 Pre-commit checklist

Before committing, verify:

1. Change is one logical unit (or clearly split).
2. No secrets or local data in the diff.
3. Specs updated per §3 matrix.
4. E2E doc updated if behavior changed.
5. `git diff --stat` review — nothing unexpected.
6. Commit message follows conventional format.

---

## 5. Branching Model

The current checkout, including local `main`, is the default development
workspace. Inspect its state first:

```bash
git status --short
git branch --show-current
```

Do not create a branch/worktree, switch branches, or update upstream simply
because a new request arrived. Branches and worktrees remain available for
explicit requests or concurrency isolation; they are not delivery gates.

Remote publishing is opt-in. When an upstream contribution is requested, use
the selected target repository's PR checks and integration validation, without
discarding local changes. No upstream contribution is required for self-maintained
local development. Do not force-push shared history.

If an optional worktree is retired, verify all changes are retained in commits
or the destination checkout before deleting it, and remove only the authorized
worktree and branch. A migration is not permission to remove anyone else's work.

---

## 6. Definition of Done

A change is **Done** when all applicable conditions are true, respecting an
explicit branch-only or draft-only delivery scope:

1. The current checkout was inspected and unrelated changes preserved;
   optional isolation follows the user's requested workflow.
2. Code (or doc) implements the planned change.
3. All impacted specs are updated.
4. E2E scenarios are documented (or confirmed not needed per §3).
5. Relevant checks passed against the actual source or required unavailable
   checks are reported as `NOT RUN` with reason and residual risk.
6. Any requested commit uses a conventional message; otherwise local changes
   remain available in the current checkout.
7. BOARD is updated if a milestone deliverable completed.
8. No secrets or local data are present in the commit.
9. When remote integration was requested, its applicable PR/base checks and
   integration validation passed; no remote publishing is inferred for local work.
10. Any requested worktree cleanup retained all task changes and removed only
    the authorized worktree/branch.
11. If a GitHub issue was linked: the claim was verified before implementation;
    the issue received a comment in its language; and the issue was closed when
    the outcome was conclusive.
12. If a GitHub pull request was linked: the root-cause bar was reviewed; the
    pull request was merged only when it actually fixed the problem with a
    minimal diff; follow-up landed after merge; the contributor's work was
    not discarded.
13. Any requested launch uses the validated source/build and authorized profile;
    the daily Release is not restarted without explicit permission.

This edition stays on its beta release line between candidate releases. An
ordinary personal packaging build does not change the version; it only records
build identity plus Git-derived change notes (R4.1). A version change requires
an explicitly requested candidate release; tags and remote publication require
separate authorization. Personal beta history follows the personal runbook below.

### Release / version-tag gate

The following requirements apply only to an explicitly requested stable
multi-platform release, not an ordinary build or personal beta candidate.
Personal candidates use `docs/releases/history.json` and `CHANGELOG.md` as
specified in [the personal release runbook](07-personal-release-runbook.md).

When the change is a **stable app version release** (version bump + tag),
Definition of Done also requires, **before** the tag, that every
version-bearing surface describes the new version: the shipped-locale in-app
changelog entries in `packages/shared/src/changelog.ts` (English and every
shipped product locale, with aligned highlight counts) with its `changelog.test.ts` list, every workspace
`package.json` (including `docs/package.json`), the Cargo workspace version and
`host-core` lockfile entry, `APP_VERSION`, and the release line stated in
`README.md` + `README.zh-CN.md`. `node scripts/check-release-docs.mjs` must
pass; `scripts/release.mjs` runs it and refuses to tag otherwise. See
[06-release-runbook.md §4.1](06-release-runbook.md#41-mandatory-release-version-surface-gate-d164--d260),
D164, and D260. GitHub release notes are not a substitute.

---

## 7. Forbidden Practices

| Practice | Why |
|---|---|
| Committing secrets | Security violation |
| Discarding local changes to satisfy a workflow step | Loses user work; R2 permits an uncommitted local handoff |
| Changing behavior without spec update | Violates R1; specs become unreliable |
| Skipping e2e doc for user-visible changes | Violates R3; traceability gap |
| Claiming required validation passed when it was skipped or failed | Violates R7 and misrepresents the tested candidate |
| Treating the full local test/check suite as an automatic pre-push requirement | Ignores risk-based validation and delays delivery without evidence of need |
| Switching branches or creating worktrees as a compulsory first step | Violates R4's in-place development default |
| Overwriting another task's changes or deleting unique work | Violates data safety and collaboration boundaries |
| Opening or updating a requested upstream PR on an unvalidated/stale base | Violates the optional remote-delivery gate |
| Modifying baseline frozen decisions without ADR + version bump | Baseline is frozen; changes need formal process |
| Committing generated artifacts that CI should rebuild | Repo bloat, merge conflicts |
| Mixing multiple logical changes in one commit without clear message | Loss of history granularity |
| Implementing a linked GitHub issue without verifying the problem exists | Violates R5; wastes work on invalid or already-fixed claims |
| Closing a linked GitHub issue without a comment in the issue language | Violates R5; leaves no public record of the outcome |
| Closing, rewriting, or requesting a restart of a linked pull request that already fixes the root cause with a minimal diff, solely for nits | Violates R6; discards the contributor's work |
| Blocking merge of a root-cause-complete linked pull request solely for missing specs, extra tests, style, or agent-workflow completeness | Violates R6; those are follow-up after merge |
| Merging a linked pull request that only has a sound direction, leaves the original failure mode, or is larger than the smallest coherent fix without a stated reason | Violates R6; direction is not enough |
| Merging a linked pull request that introduces a harm blocker | Violates R6 |
| Force-pushing a contributor's branch to land a linked pull request | Violates R6; landing fixes go on top of the author's commits |
| Tagging a stable app release without updating `packages/shared/src/changelog.ts` for every shipped locale | Violates D164 / D345 / release runbook; in-app What's new is empty for that locale and version |
| Tagging a stable app release while `README.md` / `README.zh-CN.md` still state an older release line, or bypassing `scripts/check-release-docs.mjs` with `--skip-docs-check` | Violates D260 / release runbook; published documentation advertises a version the release no longer matches |
| Installing a candidate or restarting the daily Release without authorization | Source development does not authorize production operations |

---

## 8. Acceptance Criteria for This Workflow

This workflow spec itself is accepted when:

- [ ] R1/R2/R3/R4/R5/R6/R7 are stated clearly and cross-linked to relevant specs.
- [ ] Development loop is documented and referenced by `AGENTS.md`.
- [ ] Spec update matrix covers all change types in the baseline.
- [ ] Git commit rules match existing repo commit style (`docs:`, `chore:`).
- [ ] Local development defaults to the current checkout, including local `main`.
- [ ] Branches/worktrees are optional and unrelated changes are preserved.
- [ ] A requested upstream PR contains its intended target's latest applicable
      base and passes that repository's own base check before review.
- [ ] Remote publishing requires authorization and uses PR/MR gates before
      remote `main` integration and local synchronization.
- [ ] Remote-base refresh and PR integration checks apply only to requested
      upstream contributions, not local implementation or validation.
- [ ] Optional worktree cleanup first verifies all changes are retained.
- [ ] Relevant tests/E2E validate actual executable source; unavailable checks
      and their residual risk are reported without touching the live daily app.
- [ ] Local validation is risk-based; unnecessary checks may be skipped without
      blocking commit, push, or PR/MR creation.
- [ ] Definition of Done is complete and actionable.
- [ ] Forbidden practices list covers known risk areas.
- [ ] `AGENTS.md` points to this doc, `04-e2e-test-plan.md`, and `05-change-checklist.md`.
- [ ] Linked GitHub issues are verified before implementation, then commented
      on in the issue language and closed when conclusive.
- [ ] Linked GitHub pull requests land only when they fix the reported root
      cause with a minimal diff; contributor work is not discarded for nits.
- [ ] `AGENTS.md` is the single authoritative policy and `CLAUDE.md` only
      delegates to it (`pnpm check:agent-policy`).
- [ ] An ordinary `pnpm dist:personal` build reports a unique build identifier,
      exact Git source and dirty state, and Git-derived change notes without
      changing the app version.

- [ ] All indexes updated (NAV, delivery README, spec README, docs README, BOARD).
