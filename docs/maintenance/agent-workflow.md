# Agent Workflow Maintenance

How the repository's AI-agent policy and packaging/release wording fit together
in this independently maintained personal edition. This page is a map, not a
second rulebook.

## Policy layout

| File | Role |
| --- | --- |
| `AGENTS.md` | Authoritative repository policy for agents and maintainers |
| `CLAUDE.md` | Short Claude Code / Claude Cowork entry point that delegates to `AGENTS.md` |
| `docs/spec/` | Authoritative for product behavior, protocols, persistence, and security |
| `README.md` / `README.zh-CN.md` | Equivalent current-source overviews of this edition's user-facing enhancements |
| `docs/spec/06-delivery/03-ai-development-workflow.md` | Delivery workflow detail |
| `docs/spec/06-delivery/05-change-checklist.md` | Pre-delivery checklist |
| `pnpm check:agent-policy` | Mechanical gate for the two policy files |

`CLAUDE.md` must not grow into a duplicate policy: the gate fails when it
restates more than two safety anchors, when an anchor disappears from
`AGENTS.md`, when either file references a `.md` document that does not exist, or
when the two `Policy-Sync:` tokens differ.

Durable project rules belong in tracked documents. Do not rely on an untracked
local file or assume a client automatically reads it; configure machine-specific
preferences explicitly at user scope.

## README maintenance

The update criteria live in
[AGENTS.md §13](https://github.com/saiveen1/PI-Desktop/blob/main/AGENTS.md#personal-edition-readme-maintenance), not an
ignored local instruction file. The development workflow and change checklist
route feature and improvement work through that assessment; delivery records
whether the bilingual overview changed and why. The
[personal-edition provenance map](personal-edition-provenance.md) records local
increments and excluded upstream claims, including meaningful fixes and harness
hardening. README is the capability overview, specs define exact behavior, and the
generated changelog records releases. These have different purposes and must not
become copies of one another.

## Build versus release

| Action | Effect on version |
| --- | --- |
| `pnpm dist:personal` | none — beta stays the release state |
| `pnpm dist:personal --check` | none — prints the plan and writes nothing |
| `pnpm dist:personal --release X.Y.Z-beta.N` | applies that explicit candidate version |

Every successful build records a unique build identifier, the exact Git source
and dirty state, and Added/Fixed/Improved/Maintenance notes derived from Git, so
a delivered installer is traceable to the code that produced it. Only an
explicitly requested candidate release selects a new version, and only once
accepted scope, compatibility, and tests justify it.

Packaging is not installation. A build request never authorizes running the
installer, launching Desktop, touching a profile or registration, or creating a
tag, commit, or push. The authoritative operational detail is
`docs/spec/06-delivery/07-personal-release-runbook.md`.

## When you change policy

1. Update `AGENTS.md`; keep the rule single-sourced there.
2. Keep `CLAUDE.md` a pointer, and set the same new `Policy-Sync:` token in both.
3. Verify every referenced path exists.
4. Run `pnpm check:agent-policy` and the desktop policy test
   (`node --test apps/desktop/test/agent-policy-sync.test.mjs`).
5. Synchronize `docs/spec/06-delivery/03-ai-development-workflow.md` and
   `docs/spec/06-delivery/05-change-checklist.md` when the workflow itself
   changed.
