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
- **Local performance diagnostics.** Significant stalls and unexpected main-window
  renderer exits preserve recent process samples in local incident logs without
  starting a recording. Find them in Settings → Info → Developer options →
  Performance diagnostics. An optional 30-second recording provides a more detailed
  preview and explicit export. Missing metrics are not zero, and chat content
  is neither logged nor uploaded.

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
  fresh budgets. The checklist check reads the host-bound session, even when it
  has no project. Normal checks add no model context or reviewer call; actual
  continuations may add usage and never guarantee completion.
- **Bounded automatic continuation.** Choose Guard or Endless beside the composer.
  Both keep each answer final and can send a visible **Continue** in a new turn
  after an eligible reply settles. Guard asks the exact configured independent
  model to review the last reply with an editable prompt; Endless skips review.
  One cap of 1–100 (default 3) per human input covers follow-ups and opt-in extra
  transient-error recovery after built-in retries exhaust. Recovery stays in the
  current turn and sends no message; built-in retries and permissions are unchanged.
  Switch either mode Off to prevent future sends without interrupting current
  work; an already started review may finish but cannot send. Use Stop to
  interrupt active work. Reloading does not resume the chain.
  Old Observe sessions become off. Both modes can add model usage; neither
  verifies task completion.
- **Configurable degenerate-output protection.** Interrupt long whitespace/symbol
  runs or sustained exact narrative-paragraph repetition in model text/thinking.
  Behavior settings expose switches and thresholds; partial results are retained
  without automatic replay. Code and structured samples are excluded from prose
  comparison. This is not a general judge of repetitive prose or answer quality.
  For DeepSeek replies, the transcript also hides repeated bare thinking-end
  markers in prose without changing the stored answer or provider replay.
- **Explicit waiting and context control.** Main-session model requests gain a
  configurable transport-idle policy rather than treating every output pause as
  a broken request to replay. Local idle termination leaves retry to the user.
  Context compaction remains runtime-controlled rather than a model-triggered
  tool, while existing automatic and user `/compact` paths remain available.
- **Runtime-confirmed main-model identity.** The main Agent receives its exact
  active request model and provider IDs, including after model changes, so it
  can answer identity questions and fill requested `AI-Model` trailers without
  guessing. This identifies the configured request, not undisclosed gateway routing.
- **Conversation personas.** Instructions settings shows the read-only built-in
  identity opening and lists reusable identity/tone/style templates for direct
  editing. Select a persona beside the composer mode picker. Selection snapshots
  replace the default identity opening without changing modes or
  permissions. Optional child inheritance is off by default; resumed child chains
  retain their original persona even after the parent selection changes. Template
  edits require reapplying a selection. This is prompt guidance, not guaranteed
  model adherence; native extension-agent and remote backends are not supported.
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
  model selection. A Task can also request more or less reasoning effort than
  its parent unless the role fixes the level. Failure handling remains within authorized models.
- **Session and global task indexes.** Open the current session's subagents from
  the topbar, or review cross-project history with recorded models, completion
  times, output tokens and explicitly labeled run/request throughput. Missing
  old measurements stay unavailable; throughput is not pure generation speed.
  Retained approval receipts never provide fresh consent to run work.
  Inline tasks and the session index use distinct subagent icons/labels and show
  recorded model/effort without expansion. Background refresh keeps the list in
  place; failures retain previous information with an explicit warning.
- **Progress checkpoints and direct follow-up.** Alongside configurable work
  budgets, automatically saved checkpoints retain bounded tool evidence,
  confirmed writes and uncertain pending effects.
  Runtime observations distinguish quiet tools, model waiting and no new evidence
  without imposing a hidden kill deadline or mandatory model progress reports.
  In local Agent sessions, send instructions to a running child or explicitly
  resume an eligible settled task. Per role, the most recent two settled chains
  remain resumable; running chains do not count against that limit. Older reports
  can remain readable even when their chains can no longer be resumed. A known
  unavailable chain is distinguished from an unknown ID; neither is automatically
  redispatched. Resumes retain recorded model, selection rationale and requested
  effort and appear as continuations rather than new tasks. Viewing history
  alone does not restart it.
- **More accurate completion and recovery.** Do not treat an old progress message
  or truncated ending as a final report; coalesce duplicate recovery requests
  and support resuming work interrupted by a parent failure on the next user turn.
  Batch waits tolerate a redundant job reference when its ID is already in the
  batch, avoiding model retries without relaxing stop targeting.
  Fixed-tool delegates can load skills without inheriting unrelated plugin/MCP
  execution tools. Each role can inherit available skills, select specific IDs,
  or select none; this does not grant the tools or permissions a skill describes.
  Recorded authorization, provider attempts, execution end and report delivery
  can be inspected separately without opening raw logs.

### Conversation organization and notifications

- **Adjust the sidebar lists independently.** Fold Pinned, Recent, or Projects
  by clicking its heading, or drag its bottom edge to set its height. Each
  section remembers its own layout when the app reopens.
- **Read past folded work in long chats.** At the top of a folded run, one
  upward gesture reaches the preceding reply, or the prompt that started the
  run if there is no preceding reply. Current answers and expandable details
  stay in the conversation.

- **Edit an answer's model context.** In an idle local conversation, edit or
  exclude intermediate prose, thinking, tool arguments/results and the final
  answer before continuing. Preview the proposed context, exclude all thinking,
  keep only the final answer, or restore originals. The pencil opens on the
  final answer; expand the process to edit other blocks. After Save, the chat
  shows the edited answer with its original one click away. Excluded answers
  are labeled. Tool receipts stay original; edits never rerun or undo tools. Earlier
  turns are unchanged; fork an older answer first. Oversized editing snapshots
  are refused instead of silently truncated.

- **Project-scoped groups, colored labels, and deliberate ordering.** Groups
  control placement; multiple labels do not duplicate conversations. Local project
  groups show complete counts and page independently. Folded groups can show running,
  waiting and unread results. Use the project's **+** to choose a group, or a group's
  **+** to create there directly. Creation reveals its destination; opening an
  existing conversation preserves group disclosure. Forking a conversation or a
  reply keeps the new conversation in the source's group. Manual
  moves and accepted user sends update activity order, not merely opening a chat
  or receiving streamed output. Mark a conversation read or unread from its row
  menu; unread markers are saved on this device and clear when you reopen the chat.
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
  Submitted questions and answers stay together in the main chat even when
  surrounding tool activity is folded.
- **Expanded file actions.** Add Save as and supported text-content copying to chat
  references, and extend Open with beyond HTML to default applications. Local
  sessions, with or without a project, use live references for ordinary disk files
  consistently across drag, paste and the file picker, without copying the file
  or hitting transfer-size limits. Images and generated clipboard content retain
  attachment handling; references still require normal tool permissions and are
  not snapshots.
- **Tool-image continuity.** Add generic tool-result galleries and preserve historical
  previews. Show image counts and thumbnails at the Read call without opening its
  details or repeating inspected images below the answer. Fix image retention and delivery across
  follow-up requests and child-model contexts, with explicit omission notices when
  model capability or image limits prevent delivery. Native Responses image results
  are now saved and linked instead of being silently discarded; image-only replies
  and delivery failures do not automatically repeat generation. Tool and generated
  images open over the conversation and close with a click in the surrounding
  space. History restores retained tool-image bytes when they fit a bounded
  single-message read, even if the source file is outside the project. Oversized
  local generated images use a bounded thumbnail while downloads keep the original.

### Fixes that matter in daily use

- **Responses stream content preservation.** The local compatibility repair
  protects meaningful streamed thinking and answers from blank terminal items,
  including zero-width-only reasoning summaries. Invisible placeholders no longer
  produce empty thinking disclosures; later real thinking remains visible,
  while retaining authoritative corrections and refusals. An exact orphan DSML
  suffix keeps the streamed text and its diagnostic. In chat, recognizable trailing
  markup folds into **Protocol details**; tool cards report actual execution.
  See the [diagnosis and limits](docs/maintenance/responses-terminal-content-loss.md);
  previously lost content cannot be recovered by this change.

- **Fix cascading file-tool blocking under multi-agent concurrency.** Long-running
  searches could hold a Host-wide file lease, causing repeated read/write admission
  timeouts across sessions and preventing agents from editing files. Use per-file
  coordination with cancellation and resource cleanup, retaining same-file protection.
- **Reliable reading restoration and historical reply branching.** Fix session-switch
  and delayed-history races so old restoration results do not replace newer
  reading intent or discard loaded ranges. Branch from paged, searched, or
  restored replies outside the latest-message cache without rewriting the source
  transcript or stopping a later turn.
  Opening or restoring a long conversation no longer starts paging backward. Scroll
  up or choose **Show earlier messages** to read more, even when the tail fits on one screen.
  If search lands on a page that cuts off a turn, the transcript does not
  claim completion or invent a duration; jump to the latest page from the pager.
- **Clearer execution outcomes.** Distinguish failed, denied, skipped, interrupted,
  and context-required tool results; retain phase/retry diagnostics and clear stale
  running indicators and retry badges. Also fix rename-input reselection and
  collapsed approval controls interfering with the composer.
- **Targeted Windows and file-reference fixes.** Resolve bare filenames under an
  explicitly stated Markdown directory and open Git Bash links (`/d/...`) on
  Windows, including the branch copy in an isolated worktree. Runner-child
  Python standard streams default to UTF-8 only when
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

Develop in the current checkout by default; worktrees are optional for genuine
concurrent edits. Reuse caches, not cross-checkout links to mutable source or
dependency directories. Authorized cleanup must detach directory links before
Git removal; follow the [isolation and teardown rules](docs/spec/06-delivery/03-ai-development-workflow.md#isolation-is-a-reason-not-a-ritual).

On Windows, [start-local.cmd](start-local.cmd) builds the necessary current source
and launches in the same console, without packaging, installation or a typed
confirmation. Configure the Git-ignored `start-local.data-dir.local` and exit all
profile owners first. **Backups are off by default.** Pass `-BackupConfig` to
export application preferences and user provider/model definitions to
`<data-directory>.config-backups`; this does not copy the database, conversations,
attachments or credentials. Workspace dependencies rebuild before launch, and
an empty dependency selection stops startup. It never stops processes. Read the
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
builds code pushes to `main` without changing the committed version. When the version
stays the same, successful runs only upload the installer and provenance as Actions
artifacts for 30 days. A push that advances the version to a newer beta also
publishes a `personal-v` prerelease for the exact commit after the build passes.
You can still run the workflow manually: leave `release_version` empty to build
only, or enter a newer beta to bump and publish it from Actions. Neither path
enables automatic updates in the installed app. See the
[Actions runbook](docs/spec/06-delivery/07-personal-release-runbook.md#github-actions-personal-fork-only).

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
of personal builds or unconditional adoption of every upstream change. Run
`pnpm check:personal-merge` on the merge candidate to verify protected local
behaviors, and test any other affected local features before landing.

Original authorship and project credits are retained. PI-Desktop is licensed
under the GNU Lesser General Public License v3.0; see [LICENSE](LICENSE).
