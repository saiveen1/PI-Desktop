# Contributing to PI-Desktop

Thanks for helping improve PI-Desktop. This guide applies to human and AI
contributors working on the repository.

PI-Desktop is released software with real users. Prefer small, reviewable
changes that preserve existing behavior, user data, security boundaries, and
public interfaces.

## Before You Start

Read the documents relevant to your change:

- [`AGENTS.md`](AGENTS.md) — repository rules for contributors and agents.
- [`CLAUDE.md`](CLAUDE.md) — Claude Code / Cowork mirror of the non-negotiables.
  When you change either policy file, update the other, set the same
  `Policy-Sync:` token, and run `pnpm check:agent-policy`.
- [`README.md`](README.md) — product overview and development context.
- [`docs/spec/00-baseline.md`](docs/spec/00-baseline.md) — frozen architecture
  and product decisions.
- Relevant documents under [`docs/spec/`](docs/spec/) and
  [`docs/adr/`](docs/adr/).
- [`docs/spec/06-delivery/03-ai-development-workflow.md`](docs/spec/06-delivery/03-ai-development-workflow.md)
  — development and delivery workflow.

For a suspected security vulnerability, do not open a public issue. Follow
[`SECURITY.md`](SECURITY.md) instead.

## Collaboration Rules

- Develop in the current checkout by default, including local `main`.
- Branches and worktrees are optional, used when requested or concurrency needs
  isolation; they are not prerequisites for local work.
- Preserve unrelated user/contributor changes. Do not automatically switch
  branches, fetch/rebase upstream, or impose a PR on local development.
- Remote publishing is opt-in. For a requested upstream PR, incorporate its
  applicable target base and run `pnpm check:pr-base` for `origin/main`.
- Retire optional worktrees only after changes are committed or safely migrated,
  and remove only the authorized worktree/branch.
- Use English for code, identifiers, comments, commits, repository
  documentation, and specifications. GitHub discussions may use the language
  of the original author.

## Start a Local Request

Inspect the current checkout before editing:

```bash
git status --short
git branch --show-current
```

Continue here unless the user requests another workflow or concurrency needs
isolation. Do not discard, stash, move, or overwrite unrelated work. Local
development does not require a new branch, worktree, or upstream integration.

## Plan and Implement

Before editing:

1. For a linked GitHub issue, verify that the reported problem exists and is in
   scope. Do not implement an unverified claim.
2. For a linked pull request, review the direction and preserve a sound
   contributor change rather than reimplementing it.
3. Identify observable behavior, persistence, protocol, security, and
   architecture impacts.
4. Read the relevant specification and list the validation needed.

While editing:

- Keep one logical concern per change and avoid unrelated cleanup.
- Preserve the process boundary: Renderer → Preload IPC → Electron Main → Rust
  host core / agent runtime.
- Keep SQLite ownership in Rust host core and keep Electron Main a thin
  orchestrator.
- Update the relevant specification when behavior changes.
- Add or update an E2E scenario for user-visible or protocol-visible behavior.
  New scenario IDs use a semantic form such as
  `E2E-SESSION-switch-does-not-show-stale-transcript`; do not allocate a new
  global numeric counter.
- Add an ADR when changing an architectural boundary, public contract,
  security boundary, or frozen decision.

## Validate the Change

Choose checks based on the affected surface and risk. Do not hide or weaken a
failing test.

Typical checks include:

```bash
pnpm build:js
pnpm typecheck
pnpm lint
pnpm -r --if-present test
cargo fmt --check
cargo test -p host-core --locked
cargo clippy -p host-core --all-targets
```

Run only the relevant subset when the change is low risk. Documentation-only
changes normally need no runtime tests; at minimum, review the rendered
Markdown and run `git diff --check`.

Validate the actual candidate source with relevant checks/E2E. Local tests do
not require upstream refresh or another checkout. For requested remote delivery,
also validate the applicable PR integration candidate. Record unavailable
required suites as `NOT RUN` with reason, alternative evidence, and remaining risk.

## Pull Request Acceptance Scope (temporary)

Effective 2026-09-26, until this section is removed, outside contributions are
limited to pull requests whose change type is `perf` or `fix`:

```text
fix(host-core): preserve session ownership during restart
perf(composer): stop re-rendering the transcript on every keystroke
```

An outside pull request of any other type is not accepted for now. A `feat`,
`refactor`, `docs`, `test`, `chore`, `build`, or `ci` pull request is closed
without review and without merge, and is not reimplemented as a replacement
while this window is in force.
Relabelling other work as `fix` or `perf` does not qualify it.

The restriction governs outside contributions only. Maintainers — accounts with
write access to this repository, plus the branches and automated agent work they
direct — keep every change type. A `feat`, `refactor`, `docs`, `test`, `chore`,
`build`, or `ci` pull request for planned maintainer work remains a valid
delivery path under `AGENTS.md` R1–R7.

- Feature ideas: open an issue with the feature request form instead of a pull
  request. Features are planned and delivered by the maintainers here; an
  unsolicited `feat` pull request is not a delivery path during this window.
- Bug fixes and performance regressions: `fix` and `perf` pull requests stay
  welcome and are reviewed under the root-cause and minimality bar of R6 in
  [`docs/spec/06-delivery/03-ai-development-workflow.md`](docs/spec/06-delivery/03-ai-development-workflow.md).
- Mixed changes: land the `fix` part first and describe the rest in an issue.
  Do not hide other work inside a `fix` or `perf` pull request.
- Documentation, tests, refactors, dependency updates, and tooling are handled
  by the maintainers while this window is in force.

The restriction is temporary and recorded as R6.1 in
[`docs/spec/06-delivery/03-ai-development-workflow.md`](docs/spec/06-delivery/03-ai-development-workflow.md).
It is lifted by removing this section and that subsection, not by arguing scope
inside a pull request.

## Commit and Pull Request

Use one logical commit where practical and follow Conventional Commits:

```text
docs(security): clarify vulnerability reporting
fix(host-core): preserve session ownership during restart
feat(composer): add model selection shortcut
```

Before committing, review the complete diff. Never commit:

- API keys, tokens, passwords, credentials, or private user data.
- Local databases, logs, configuration, or machine-specific paths.
- `node_modules/`, build artifacts, release packages, or unrelated changes.

Outside contributions are limited to `fix` and `perf` pull requests while the
temporary Pull Request Acceptance Scope above is in force; maintainer-planned
work keeps every change type.

Only when an upstream PR is requested, refresh its applicable target base,
run the relevant checks and `pnpm check:pr-base` for `origin/main`, then open
the authorized pull request with:

- a concise summary and rationale;
- affected specs, ADRs, and E2E scenarios;
- An outside pull request of any other change type — `feat`, `refactor`,
  `docs`, `test`,
- compatibility, migration, security, and remaining-risk notes when relevant.

Do not force-push contributor branches, bypass required checks, or merge a
failing change. Keep review feedback and follow-up commits focused on the
request.

## Optional Cleanup

Local work needs no upstream merge. When cleanup of an optional branch/worktree
is requested, first verify all changes are committed or retained in the destination
checkout, then remove only that worktree/branch. Never delete unique work.

For requested remote delivery, verify the integration result and rerun affected
checks when its executable content differs from the tested source. Do not restart
or replace the user's daily Release merely because source changes are complete.

## Issue and Security Reports

Use the repository issue forms for reproducible bugs and feature requests. Do
not use public issues for vulnerabilities, credential exposure, sandbox or
permission bypasses, or other security-sensitive reports. Send those reports
privately as described in [`SECURITY.md`](SECURITY.md).
