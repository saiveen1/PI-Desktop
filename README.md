# PI-Desktop

> **Current release line: 0.22.x (beta).**

A local-first desktop workspace for AI agents: projects, sessions, models,
plugins, and agent workflows in one persistent Electron app.

This repository is an **independently maintained personal edition** of
PI-Desktop. It is not an official upstream release, has no public download or
support channel of its own, and is used on a beta release line. It is based on
[upstream PI-Desktop](https://github.com/vastsa/PI-Desktop); the original
project credits and the [LGPL-3.0 license](LICENSE) are retained, and
upstream remains the source of the original product design and documentation.

[简体中文](README.zh-CN.md)

---

## What this edition is

- **Sessions and projects** with a multi-select session list, batch
  archive/unarchive, recycle-bin restore, and confirmed permanent deletion.
- **Agent delegation** with subagents: model scheduling and grouped approvals,
  live policy updates, retained checkpoints, explicit retry/resume, and bounded
  recovery instead of silent stalls.
- **Chat files**: open with, save as, copy contents, and reveal in folder, plus
  normalized Windows path references in assistant output.
- **Notifications** unified across approval, question, and completion signals.
- **Task continuation** that offers a single bounded follow-up when the current
  checklist is still unfinished and stops when you stop it.
- **Personal Windows builds**: one fixed NSIS x64 installer lane with
  official automatic updates disabled for its personal installers.

Some of these flows are recent and still under integration verification in
daily use. Treat the beta line as a working state, not a stable-product
promise. What changed, when, and from which commit is recorded in
[CHANGELOG.md](CHANGELOG.md), which is derived from Git history rather than
hand-written marketing notes.

## Requirements

- Windows 10/11 x64 for the personal installer lane
- Node.js `>=22.19`, pnpm `>=10`, and a stable Rust toolchain (with MSVC Build
  Tools on Windows) for source builds

## Run from source

Run from an existing checkout with the required toolchains installed:

```bash
pnpm install
pnpm dev
```

`pnpm dev` isolates its data directory by default; it does not read or write an
installed release profile. See `AGENTS.md` §5 before using
`pnpm dev --inherit-data-dir`.

Useful checks:

```bash
pnpm typecheck
pnpm lint
pnpm -r --if-present test
pnpm check:agent-policy
```

## Build a personal installer

```bash
pnpm dist:personal --check                          # print the plan, build nothing
pnpm dist:personal                                  # ordinary build: version unchanged
pnpm dist:personal --check --release 0.23.0-beta.1  # preview a candidate (example)
pnpm dist:personal --release 0.23.0-beta.1          # build that candidate
```

The build produces one Windows x64 NSIS installer EXE plus a SHA-256 checksum
under `apps/desktop/release/personal/`, together with build metadata that
records the exact Git source, dirty state, a unique build identifier, and
Added/Fixed/Improved/Maintenance notes derived from Git. An ordinary build does
not change the app version; only an explicitly requested candidate release
selects a new one.

**Packaging never installs or launches PI-Desktop.** Installing the EXE is your
own step. Read
[docs/spec/06-delivery/07-personal-release-runbook.md](docs/spec/06-delivery/07-personal-release-runbook.md)
for the fixed pipeline, output layout, and its limits.

## Documentation

- [Plugin development guide](docs/plugin-development.md) — build a `.piplug`
  package; the plugin specs remain normative for the API contract.
- [Specification index](docs/spec/NAV.md) and
  [architecture baseline](docs/spec/00-baseline.md).
- [Personal release runbook](docs/spec/06-delivery/07-personal-release-runbook.md).
- [Change checklist](docs/spec/06-delivery/05-change-checklist.md) and
  [agent workflow](docs/spec/06-delivery/03-ai-development-workflow.md).
- [E2E test plan](docs/spec/06-delivery/04-e2e-test-plan.md).
- [AGENTS.md](AGENTS.md) — the authoritative repository rules for contributors
  and AI agents.
- [Policy maintenance map](docs/maintenance/agent-workflow.md) — where durable
  project rules belong and how the entry points are checked.
- [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Scope of this fork

Maintenance is independent of upstream. Public download, issue and community
endpoints for this edition will be added when the repository is republished;
upstream's channels are not support endpoints for this version. Upstream sync
and contribution happen only when explicitly requested against a verified target.

## Layout

```text
apps/desktop/       Electron app (main, preload, React renderer, tests)
crates/host-core/   Rust host: persistence, native state, host RPC
packages/           shared contracts, i18n, agent runtime, host runtime, plugin SDK
docs/               specifications, ADRs, guides
scripts/            repo automation, E2E, packaging
```

## License

PI-Desktop is licensed under the GNU Lesser General Public License v3.0. See
[LICENSE](LICENSE). Original authorship and upstream project credits are
retained.
