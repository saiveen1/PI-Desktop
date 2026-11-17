# PI-Desktop · Personal Edition

> **Current release line: 0.23.x.**

An independently maintained, local-first AI agent workspace focused on
**execution-harness hardening, multi-agent collaboration, and everyday usability**.

Based on [upstream PI-Desktop](https://github.com/vastsa/PI-Desktop), this edition
continues to follow upstream updates, reviewing and integrating applicable changes
while preserving local features and fixes. Features and releases evolve independently.

[简体中文](README.zh-CN.md)

## Local additions, hardening, and key fixes

The highlights below describe **local increments to the upstream foundation**, not
the upstream feature catalog. They cover current source, which may be newer than
[recorded releases](CHANGELOG.md). The [provenance map](docs/maintenance/personal-edition-provenance.md)
records the compared revisions, originating commits, implementation evidence, and
excluded upstream features. Current source version is `0.23.1-beta.1`; broader integration
validation remains necessary. A version label is not a stability, published-release
or installed-upgrade guarantee.

### Execution-harness hardening

The harness is the layer that controls agent execution, tool calls, and recovery.
This edition strengthens the existing framework rather than replacing it.

- **Local tool observations.** Developer options summarize retained tool outcomes
  and background completions from bounded local logs. Inspect grouped facts and
  append a sanitized report to a conversation draft without automatic sending,
  model calls, or command replay. Coverage limits and unknown results stay visible.

- **Broader repeated-failure protection.** Extend the existing Edit/patch guard to
  Write and repeated identical Bash failures. Successful file changes allow a
  meaningful retest; new, complete context feedback gets limited recovery room.
  Host capacity refusals have a separate budget instead of looking like bad edits.
- **Admission before execution.** Reserve background-command capacity before
  starting a process, enforce per-session shell limits, and reserve Host handling
  capacity for completion/cancellation controls. Permission waiting no longer
  consumes the aggregate tool-request deadline; execution deadlines still apply.
- **More recoverable tool arguments.** Accept supported legacy Edit replacements
  with a tag or blank optional tag/ops defaults, explain conflicting insertion
  positions, and correct background wait/stop target handling without relaxing
  file-version, context, or authorization checks. Foreground workspace switches
  no longer discard background sessions' recorded read ranges.
- **Configurable correction instead of silent early completion.** Local checks
  can warn when an ordinary Agent promises its next action but stops without a
  tool call, or continue within a selected shared correction allowance. Checklist
  and printed-tool-call corrections use the same ceiling rather than stacking
  fresh budgets. Normal checks add no model context or reviewer call; actual
  continuations may add usage and never guarantee completion.
- **Optional conversation Observer Guard.** Enable Observe or Guard beside the
  composer controls, with an independent model and effort chosen in Behavior
  settings. Observe adds advisory assessments; Guard may continue within the
  existing correction allowance after strict evidence and safety checks. Results
  remain attached to the response for later inspection. Off adds no requests;
  enabled assessments add cost/latency and are not proof of completion.
- **Configurable degenerate-output protection.** Interrupt long whitespace/symbol
  runs or sustained exact narrative-paragraph repetition in model text/thinking.
  Behavior settings expose switches and thresholds; partial results are retained
  without automatic replay. Code and structured samples are excluded from prose
  comparison. This is not a general judge of repetitive prose or answer quality.
- **Explicit waiting and context control.** Main-session model requests gain a
  configurable transport-idle policy rather than treating every output pause as
  a broken request to replay. Local idle termination leaves retry to the user.
  Context compaction remains runtime-controlled rather than a model-triggered
  tool, while existing automatic and user `/compact` paths remain available.
- **Runtime-confirmed main-model identity.** The main Agent receives its exact
  active request model and provider IDs, including after model changes, so it
  can answer identity questions and fill requested `AI-Model` trailers without
  guessing. This identifies the configured request, not undisclosed gateway routing.
- **Execution continuity after compaction.** Main-session active-task checkpoints retain the
  current request plus a budgeted window of recent progress and paired tool
  receipts, including after restart, rather than relying on the summary alone.
  Summary input preserves both ends of long results and identifies omitted images;
  continuation guidance distinguishes completed work from pending or uncertain
  actions. Completed tasks do not regain old prompts. This reduces context loss,
  not a guarantee against all model repetition or duplicate external effects.

### More controllable subagent collaboration

- **Unified model pools and approvals.** Add grouped model approvals, recoverable
  approval controls, live policy updates, and per-conversation candidate pools
  and approval overrides. On-demand model descriptions support task-specific
  selection; configurable failure handling remains within authorized models.
- **Session and global task indexes.** Open the current session's subagents from
  the topbar, or review cross-project history with recorded models, completion
  times, output tokens and explicitly labeled run/request throughput. Missing
  old measurements stay unavailable; throughput is not pure generation speed.
  Retained approval receipts never provide fresh consent to run work.
- **Progress checkpoints and direct follow-up.** Alongside configurable work
  budgets, automatically saved checkpoints retain bounded tool evidence,
  confirmed writes and uncertain pending effects.
  Runtime observations distinguish quiet tools, model waiting and no new evidence
  without imposing a hidden kill deadline or mandatory model progress reports.
  In local Agent sessions, send instructions to a running child or explicitly
  resume a settled task. Viewing history alone does not restart it.
- **More accurate completion and recovery.** Do not treat an old progress message
  or truncated ending as a final report; coalesce duplicate recovery requests
  and support resuming work interrupted by a parent failure on the next user turn.
  Fixed-tool delegates can load skills without inheriting unrelated plugin/MCP
  execution tools. Each role can inherit available skills, select specific IDs,
  or select none; this does not grant the tools or permissions a skill describes.
  Recorded authorization, provider attempts, execution end and report delivery
  can be inspected separately without opening raw logs.

### Conversation organization and notifications

- **Project-scoped groups, colored labels, and deliberate ordering.** Groups
  control placement; multiple labels do not duplicate conversations. Manual moves
  and accepted user sends update activity order, not merely opening a chat or
  receiving streamed output.
- **Visible selection and reversible deletion.** Extend existing modifier-key
  selection with checkboxes, selection controls, and batch archive/unarchive.
  Local Desktop sessions gain a recycle bin with restore and separately confirmed
  permanent deletion; native Pi and remote sessions are outside this trash flow.
- **Unified core notification policy.** Bring approvals, questions, failures, and
  completion under shared channel/sound preferences, with pending actions separate
  from retained history. Notifications return to the relevant controls without
  approving or restarting work for you.
  Delegation sound preferences include a draft-volume preview; restoring pending
  approvals does not replay their initial chime, while configured repeats remain
  active until the request settles.

### Chat, file, and image refinements

- **Task-first reading.** Collapse activity and thinking by default, show concise
  task rows and failure summaries, share parent/child detail presentation, and keep
  recorded file changes accessible during running, stopped, or failed turns.
- **Expanded file actions.** Add Save as and supported text-content copying to chat
  references, and extend Open with beyond HTML to default applications. Local
  sessions, with or without a project, use live references for ordinary disk files
  consistently across drag, paste and the file picker, without copying the file
  or hitting transfer-size limits. Images and generated clipboard content retain
  attachment handling; references still require normal tool permissions and are
  not snapshots.
- **Tool-image continuity.** Add generic tool-result galleries and preserve historical
  previews. Keep ordinary image Reads inside expanded tool details, rather than
  echoing input images as delivered output. Fix image retention and delivery across
  follow-up requests and child-model contexts, with explicit omission notices when
  model capability or image limits prevent delivery.

### Fixes that matter in daily use

- **Fix cascading file-tool blocking under multi-agent concurrency.** Long-running
  searches could hold a Host-wide file lease, causing repeated read/write admission
  timeouts across sessions and preventing agents from editing files. Use per-file
  coordination with cancellation and resource cleanup, retaining same-file protection.
- **Reliable reading restoration and historical reply branching.** Fix session-switch
  and delayed-history races so old restoration results do not replace newer
  reading intent or discard loaded ranges. Branch from paged, searched, or
  restored replies outside the latest-message cache without rewriting the source
  transcript or stopping a later turn.
- **Clearer execution outcomes.** Distinguish failed, denied, skipped, interrupted,
  and context-required tool results; retain phase/retry diagnostics and clear stale
  running indicators and retry badges. Also fix rename-input reselection and
  collapsed approval controls interfering with the composer.
- **Targeted Windows and file-reference fixes.** Resolve bare filenames under an
  explicitly stated Markdown directory, normalize references before worktree
  rebasing, and default runner-child Python standard streams to UTF-8 only when
  no encoding preference is inherited. Git Bash command transport preserves
  literal backslashes and quoted heredoc content across foreground/background
  runners without changing the approved command or replaying failures.
- **Relocation compatibility.** Preserve project capability overrides across
  Windows path normalization and remap local conversation-organization paths when
  moving the data directory, building on the existing migration workflow.

## Run from source

Requirements: Node.js `>=22.19`, pnpm `>=10`, and a stable Rust toolchain;
Windows also needs MSVC Build Tools. From the checkout:

```bash
pnpm install
pnpm dev
```

This edition's `pnpm dev` clears inherited data-directory overrides by default.
Do not point it at a running installation's profile. For checks and opt-in data
reuse rules, see the [development workflow](docs/spec/06-delivery/03-ai-development-workflow.md).

On Windows, [start-local.cmd](start-local.cmd) provides a source-launch console
without packaging or installation. This is an **explicit existing-profile path**:
configure the Git-ignored `start-local.data-dir.local`, stop all profile owners,
and make a complete offline backup first. The launcher asks for confirmation but
does not create the backup or stop processes. Read the
[launcher instructions](docs/spec/06-delivery/03-ai-development-workflow.md#windows-local-source-launcher)
before using it; `start-local.cmd -CheckOnly` checks prerequisites without launching.

## Personal Windows builds

The personal packaging path targets **Windows 10/11 x64** and produces an NSIS
installer with official automatic updates disabled. Each build has a unique ID,
source metadata, Git-derived change notes, and a SHA-256 checksum. Main bundles
retain the Photon decoder WASM needed at startup, and the installer gate rejects
a missing or invalid copy. Build cleanup removes intermediates, not previous installers.

```bash
pnpm dist:personal --check  # Preview the build plan without building
pnpm dist:personal          # Build without changing the app version
```

Outputs go to `apps/desktop/release/personal/`. **Packaging does not install or
launch the app.** Candidate releases, verification limits, and artifact details
are covered by the [personal release runbook](docs/spec/06-delivery/07-personal-release-runbook.md).

### Build in GitHub Actions

The personal fork's [Personal Windows workflow](.github/workflows/personal-windows.yml)
builds code pushes to `main` without changing the version. Successful runs retain
the installer and provenance as downloadable Actions artifacts for 30 days.
For a new beta, use **Run workflow** on `main` and explicitly enter a newer
`release_version`; leaving it empty only builds. A successful manual release
records version/history files and publishes a `personal-v` prerelease in this
fork. It does not enable automatic updates in the installed app. Setup, permissions
and recovery limits are in the [Actions runbook](docs/spec/06-delivery/07-personal-release-runbook.md#github-actions-personal-fork-only).

## Documentation

- [Change provenance](docs/maintenance/personal-edition-provenance.md) — local
  increments, meaningful fixes, and upstream items excluded from these highlights.
- [Release history](CHANGELOG.md) — recorded versions and their source changes;
  generated from release records, not a log of every unreleased source edit.
- [Plugin development](docs/plugin-development.md) — build extensions for this
  workspace; the plugin specifications remain authoritative for API contracts.
- [Specifications](docs/spec/NAV.md) — detailed behavior and architecture.
- [Development workflow](docs/spec/06-delivery/03-ai-development-workflow.md) and
  [change checklist](docs/spec/06-delivery/05-change-checklist.md) — development
  and verification guidance.
- [Agent rules](AGENTS.md) and [policy maintenance](docs/maintenance/agent-workflow.md)
  — repository rules, including keeping this overview current.
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md).

## Upstream and license

Thanks to PI-Desktop's original authors and upstream contributors for the
foundation. This is not an official upstream release; upstream downloads and
support channels are not distribution or support endpoints for this edition.
Following upstream means reviewed source integration, not automatic replacement
of personal builds or unconditional adoption of every upstream change.

Original authorship and project credits are retained. PI-Desktop is licensed
under the GNU Lesser General Public License v3.0; see [LICENSE](LICENSE).
