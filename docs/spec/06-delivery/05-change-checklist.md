# 05. Change Checklist

> A practical checklist agents must run before finishing work.  
> Cross-references: [ai-development-workflow](03-ai-development-workflow.md) · [e2e-test-plan](04-e2e-test-plan.md) · [decisions-log](../08-meta/decisions-log.md) · [ADR index](../../adr/README.md) · [BOARD](../../project/BOARD.md)

---

## 0. GitHub Issue Intake

When the prompt includes a GitHub issue URL or an unambiguous issue number for
this repository, complete this gate before the request-start checklist:

- [ ] Issue title, body, labels, comments, and state were fetched.
- [ ] The reported problem was independently verified (reproduced or evidenced
  for a bug; confirmed missing or incomplete and in scope for a feature).
- [ ] Implementation started only after the problem was confirmed to exist.
- [ ] If the problem does not exist: the issue received a verification comment
  and was closed when the conclusion was clear, or left open when inconclusive.
- [ ] After a confirmed fix was merged: the issue received a resolution comment
  and was closed.
- [ ] The comment uses the issue's language.
- [ ] No unrelated issue was commented on or closed.
- [ ] Git push was not inferred from the issue link.

See [R5 — Verify linked GitHub issues](03-ai-development-workflow.md#r5--verify-linked-github-issues-before-work-then-reply-and-close).

---

## 0.1 GitHub Pull Request Intake

When the prompt includes a GitHub pull request URL or an unambiguous pull
request number for this repository, complete this gate before rewriting the
change or starting follow-up:

- [ ] Pull request title, body, files, commits, comments, checks, draft
  state, base/head, and linked issues were fetched.
- [ ] The **root-cause bar** was independently judged: real in-scope problem;
  the change actually removes that failure mode at the root; the diff is the
  smallest coherent fix; approach compatible with baseline, security, and
  architecture.
- [ ] Completeness gaps (specs, extra tests, i18n, e2e docs, style, naming)
  were not treated as merge blockers **unless** they are required to prove
  the root-cause fix.
- [ ] If the root-cause bar holds: the pull request was merged first,
  preserving the contributor's commits; landing blockers received only
  smallest-on-top commits.
- [ ] Authorized follow-up preserves the contributor's work and uses the local
  checkout workflow under R4; a new branch/worktree is optional.
- [ ] If the root-cause bar fails or a harm blocker exists: the pull
  request was not merged, was not approved as "direction is fine", and a
  comment recorded the evidence. The idea was not silently reimplemented.
- [ ] A draft pull request was not merged unless the user explicitly asked.
- [ ] The comment uses the pull request's language.
- [ ] No unrelated pull request was commented on or merged.
- [ ] The contributor's branch was not force-pushed. Unrelated remote
  publishing was not inferred from the pull request link.

See [R6 — Land a linked pull request only when it fixes the root cause with a minimal diff](03-ai-development-workflow.md#r6--land-a-linked-pull-request-only-when-it-fixes-the-root-cause-with-a-minimal-diff).

---

## 1. Request Start Checklist

Before editing any file for a new request:

- [ ] Existing uncommitted work is identified and preserved.
- [ ] The current checkout is used by default, including local `main`.
- [ ] Branch/worktree creation or upstream synchronization is not imposed on
  local development; optional isolation is justified by the requested workflow.
- [ ] Existing compatible toolchains, dependencies, and caches are reused.
- [ ] Mutable test profiles, data, ports, and artifacts are isolated from the
  running daily application and unrelated concurrent work.
- [ ] Delivery scope is recorded: commits, remote publishing, installation, and
  application restarts occur only when authorized. Local work requires no PR.

---

## 2. Impact Analysis

Before starting implementation, answer these questions:

- [ ] What behavior changes does this change introduce?
- [ ] Which specs are affected? (list file paths)
- [ ] Does this change touch an architectural boundary? (process model, IPC, storage, security, plugin API)
- [ ] Does this change affect user-visible or protocol-visible behavior?
- [ ] Is local validation necessary for this change's risk and regression
  scope? If so, what is the smallest targeted check set?
- [ ] Which milestone deliverable does this relate to? (M1–M6, or none)

Reference the [spec update matrix](03-ai-development-workflow.md#3-spec-update-matrix) to determine required doc updates.

---

## 3. Spec Sync Checklist

After implementation (or alongside it):

- [ ] Every affected spec file is updated with the new behavior.
- [ ] If `AGENTS.md` changed: `CLAUDE.md` still mirrors the non-negotiables,
  both files share the same `Policy-Sync:` token, and `pnpm check:agent-policy`
  passes. The reverse applies when only `CLAUDE.md` changed.
- [ ] If architectural boundary changed: ADR is written or updated in `docs/adr/`.
- [ ] If an implementation default changed: `decisions-log.md` entry updated.
- [ ] If baseline frozen decisions are affected: baseline bump + explicit ADR (not MVP-normal).
- [ ] Cross-references between specs are still correct (no stale links).

---

## 4. E2E / Test Doc Checklist

- [ ] If user-visible or protocol-visible behavior changed: new or updated scenario in [04-e2e-test-plan.md](04-e2e-test-plan.md).
- [ ] If a scenario was added or updated, it follows the template (ID, title,
  preconditions, steps, expected, specs, acceptance, milestone, status).
- [ ] If a scenario was added or updated, the traceability matrix in §8 is current.
- [ ] Unit tests added or updated when the change's risk makes them necessary.
- [ ] Integration tests added or updated when an IPC/RPC contract change or
  cross-component regression risk makes them necessary.
- [ ] The smallest necessary targeted local checks passed, or local validation
  was assessed as unnecessary with no separate approval or waiver required.
- [ ] Relevant checks/E2E validate the actual candidate source in the current
  checkout or optional worktree. Remote-base/PR integration gates apply only
  when upstream delivery is requested; `verify:ui:*` needs explicit permission.
- [ ] Task-candidate E2E used the host development environment already
  provisioned in the primary checkout; no `pnpm install`/`npm install` or
  second dependency/runtime environment was created solely for E2E. Any
  missing/incompatible-host exception is recorded with its reason.
- [ ] Results apply to the commit the gate ran on, and the affected suites were
  rerun when the landed executable content changed. Any required suite not run
  is recorded with its reason, alternative validation, and remaining risk;
  delivery remains incomplete until that gate passes.
- [ ] Hosting-platform E2E jobs that start before the remote merge were observed
  and reported but do not replace the local `main` gate; a post-merge rerun
  happened when the landed executable content differs from the commit the gate
  ran on. Dispatch or rerun follows the hosting platform's or repository
  workflow's requirements.

---

## 5. Git Commit Checklist

- [ ] Change is one logical unit (or split into focused commits).
- [ ] No secrets, tokens, or local data in the diff.
- [ ] No `node_modules/`, build artifacts, or release packages in the diff.
- [ ] Commit message follows conventional format: `type(scope): description` (English only).
- [ ] Spec updates committed with code when tightly coupled, or adjacent `docs:` commit for pure docs.
- [ ] `git diff --stat` reviewed — nothing unexpected.

---

## 6. Pull/Merge Request Checklist

Apply this section only when remote delivery or a PR/MR was requested.
Local development does not require a remote merge or a dedicated branch/worktree.

- [ ] The intended target base is incorporated without discarding local work;
  `pnpm check:pr-base` passes when targeting `origin/main`.
- [ ] Relevant validation ran against the actual integration candidate, or
  unavailable gates are recorded as `NOT RUN` with reason and remaining risk.
- [ ] Only authorized publishing/merge actions occurred; no direct upstream
  main push, force-push, or bypassed gate was inferred from a local request.
- [ ] Requested integration is verified; affected checks rerun if executable
  content changed, and optional worktree cleanup retains all task changes.
- [ ] Optional branch cleanup is authorized and deletes no unique changes.
- [ ] Issue reference is included when applicable (e.g. `Refs #12` or
  `Closes #12`).

---

## 6.1 Merge Cleanup Checklist

Apply only when cleanup of an optional worktree or branch is requested:

- [ ] All changes are retained in verified commits or the destination checkout.
- [ ] Migrated files were checked for completeness before source removal.
- [ ] Only the authorized worktree/branch was removed.
- [ ] `git worktree list` no longer contains that worktree.
- [ ] No unrelated user or agent changes were removed.
- [ ] A cleanup request did not trigger installation or restart of the daily app.

---

## 7. App version release checklist (stable tag)

Required for every stable app version bump / tag (D164). Skip only for
documentation-only work or non-release chores.

- [ ] `packages/shared/src/changelog.ts` has a newest-first entry for the
      release version under `en` and every shipped product locale (no leading
      `v`).
- [ ] Highlight counts match across locales; English is the source of truth.
- [ ] Bullets are short user-facing product notes (not raw PR/commit lists).
- [ ] Pre-release-only versions are omitted from the product catalog unless
      product explicitly ships in-app notes for that channel.
- [ ] `packages/shared/src/changelog.test.ts` lists the new version first.
- [ ] `pnpm --filter @pi-desktop/shared test` passes catalog alignment.
- [ ] `README.md` and `README.zh-CN.md` state the current
      `<major>.<minor>.x` release line and contain no toolchain, command,
      Highlights, or roadmap claim the release invalidates.
- [ ] `node scripts/check-release-docs.mjs` passes (version surfaces,
      shipped-locale catalog, README release line).
- [ ] Documentation commit is on the release branch **before**
      `node scripts/release.mjs <version> --tag` / `git tag v<version>`.
- [ ] GitHub auto-generated release body is treated as web-only, not the
      in-app source ([06-release-runbook.md §4.1](06-release-runbook.md#41-mandatory-release-version-surface-gate-d164--d260)).

---

## 8. Final Definition-of-Done Gate

Before marking work complete, verify **all applicable** conditions under the
user's delivery scope:

| # | Gate | Source |
|---|---|---|
| 1 | Current checkout inspected, unrelated work preserved; branch/worktree optional | [R4 — Local checkout and optional isolation](03-ai-development-workflow.md#r4--local-checkout-and-optional-isolation) |
| 2 | Code/doc implements the planned change | Step 4 of [development loop](03-ai-development-workflow.md#2-development-loop) |
| 3 | All impacted specs updated | [R1 — Spec-sync](03-ai-development-workflow.md#r1--spec-first--spec-sync) |
| 4 | E2E scenarios documented (or confirmed not needed) | [R3 — E2E coverage doc](03-ai-development-workflow.md#r3--e2e-coverage-doc) |
| 5 | Relevant checks validate the actual candidate; unavailable checks reported as `NOT RUN`; remote gates only for requested publishing | R7 and validation policy |
| 6 | Requested commits use conventional messages; otherwise local changes retained | [R2 — Requested commits](03-ai-development-workflow.md#r2--requested-commits) |
| 7 | BOARD updated if milestone deliverable completed | Step 9 of development loop |
| 8 | No secrets or local data in commit | [§4.4 Never commit](03-ai-development-workflow.md#44-never-commit) |
| 9 | Only requested local/remote delivery and launch actions performed | [R4 — Local checkout and optional isolation](03-ai-development-workflow.md#r4--local-checkout-and-optional-isolation) |
| 10 | Requested optional worktree cleanup retained all changes and removed no unrelated work | [§6.1 Merge Cleanup Checklist](#61-merge-cleanup-checklist) |
| 11 | If a GitHub issue was linked: verified before work; commented in the issue language; closed when conclusive | [R5 — Verify linked GitHub issues](03-ai-development-workflow.md#r5--verify-linked-github-issues-before-work-then-reply-and-close) |
| 12 | If a GitHub pull request was linked: root-cause bar reviewed; merged only when it actually fixes the problem with a minimal diff; follow-up after merge; contributor work not discarded for nits | [R6 — Land a linked pull request only when it fixes the root cause with a minimal diff](03-ai-development-workflow.md#r6--land-a-linked-pull-request-only-when-it-fixes-the-root-cause-with-a-minimal-diff) |

If any applicable gate fails, the requested integration is **not Done**; report
the blocker without weakening the gate.
