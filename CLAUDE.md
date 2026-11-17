# CLAUDE.md

Policy-Sync: 2026-11-17.personal-edition.1

Claude Code / Claude Cowork entry point for PI-Desktop.

## Authoritative policy

[`AGENTS.md`](AGENTS.md) is the authoritative policy for this repository. Read
`AGENTS.md` before any non-trivial work, then follow it. If this file and
`AGENTS.md` ever disagree, `AGENTS.md` wins; for product behavior, protocols,
persistence, and security boundaries the specifications under `docs/spec/` stay
authoritative.

This file exists only to delegate. It deliberately does not restate the rules,
and a condensed copy must not be added back — one policy file keeps the rules
from drifting into two versions.

## Start here

1. `git status --short` — inspect the checkout and preserve unrelated work.
2. Read the nearest `AGENTS.md` for every package you touch
   (`apps/desktop/src/AGENTS.md`, `packages/agent-runtime/AGENTS.md`,
   `docs/plugin-plan/AGENTS.md`); a deeper file can tighten root rules.
3. Read `docs/spec/00-baseline.md`, then the domain documents indexed in
   `docs/spec/NAV.md`.
4. For delivery rules read `docs/spec/06-delivery/03-ai-development-workflow.md`
   and `docs/spec/06-delivery/05-change-checklist.md`.

Report only checks that actually ran.

## Maintaining this file

Change `AGENTS.md` and this entry together, keep the same `Policy-Sync:` token,
and run `pnpm check:agent-policy` (`scripts/check-agent-policy-sync.mjs`). The
gate rejects a broken delegation, a missing safety anchor in `AGENTS.md`, a
referenced document that does not exist, or a `CLAUDE.md` that grew into a
duplicate policy.
