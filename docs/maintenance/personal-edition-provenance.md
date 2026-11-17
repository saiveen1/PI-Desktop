# Personal-edition change provenance

## Audit boundary

This is the evidence map for the root bilingual README, not release notes or a
claim of exclusive invention of the underlying product. It includes local
features, refinements of inherited features, and meaningful local fixes.

Audit performed on 2026-11-12 against these immutable revisions:

- Personal source: `1c206631ba53337a47808f63c0783e192aa4c705`.
- Locally recorded `upstream/main`: `7841a9828249e5f93c9aa1a85e3a096776bfe1b8`.
- The upstream revision is an ancestor of personal source. The difference has
  85 commits: 61 non-merge commits and 24 merges. `git cherry` marks all 61
  non-merge commits as non-equivalent, but that alone does not establish feature
  origin; individual hunks and current behavior were inspected as well.
- No fetch, remote capability check, application launch, or provider call was
  performed for this audit. This is not a claim about un-fetched upstream work.
- README and policy edits were already uncommitted when this audit began.
  Product comparisons use the committed revisions above, not those doc edits.

The tables describe **local increments**. A feature can use upstream foundations
without the foundation becoming a local feature. References to tests identify
existing coverage to inspect; this documentation audit does not rerun those
application tests or establish installed-upgrade, performance, or security claims.

Source links to the personal fork use the published snapshot `58c8ef37b`.
Documentation and supported source-asset links remain site-relative.

The [0.23.0 upstream integration record](upstream-integration-29043af.md)
compares personal `c1d9e306ff473f82d513b7e7a4650177714d8b9c` with upstream
`29043af3371122e256bf265db31651da125d38e3`, records preservation decisions
(including saved role-level skills) and distinguishes documentation reconciliation
from executable validation. The historical audit boundary above is unchanged.

## Local harness and delegation increments

The configurable local output guards start from personal base `722bdf630`,
compared read-only with locally recorded upstream
`aa35fee4b15c354303bb5a0c77c9c33a731d097f` (no fetch). At that revision the
`progressOnlyTurn` branch still requires `autonomousExecution`; the personal
`model-output-repetition.ts`, `unfinished-todo-continuation.ts` and new shared
`agent-output-guard.ts` are absent. The increment is ordinary-Agent advisory/
bounded correction, shared correction accounting, user-configurable thresholds,
exact-paragraph detection and normalized termination evidence. Existing Agent
loops, transport recovery, settings storage and transcript diagnostics remain
foundations. See [the decision](../adr/configurable-local-output-guards.md).
The independently developed Observer plugin is outside this repository and is
not bundled or required by these guards. Offline fixture results do not establish
live-model accuracy, installed behavior or support for un-fetched upstream.

The built-in Observer Guard amendment starts from personal source `ed93df9c8`,
compared read-only with locally recorded upstream
`4d16de71a34b02fd8711c1102a288664b3d171c1` (no fetch). Its tree has no
Observer Guard modules or session-observer migration. This increment moves the
independent advisory idea into explicit per-session Observe/Guard control, with
global model/effort preferences, exact runtime turn ownership, persisted response
diagnostics and bounded shared-budget continuation. The Agent loop, one-shot
completion provider adapters and Host session storage remain existing foundations.
It does not bundle, install or remove the earlier external plugin. See
[the amendment](../adr/builtin-observer-guard.md); live reviewer accuracy and
installed upgrades are not established by source-level tests.
The observer reliability amendment on personal base `8240316b9` rechecks the
same locally recorded upstream revision (no fetch): its tree still lacks the
Observer modules above. The local increment repairs post-response diagnostic
refreshes across Main/Host persistence, adds bounded skip/continuation reasons,
and keeps the assessed response discoverable outside folded turn activity.
It retains existing execution gates and storage ownership; it is not a new
safety authority or a promise of reviewer accuracy. Original response data and
legacy unknowns remain intact. Verification uses synthetic provider events and
isolated Host/renderer fixtures, not the daily profile or installed app.

The local tool observer was implemented on personal base `2dea25a27` and checked
against locally recorded upstream `aa35fee4b15c354303bb5a0c77c9c33a731d097f`
without fetching. At that revision, `developer-sections.tsx` contains the developer
mode/DevTools controls, and `diagnostics-ipc.ts` contains log-folder and DevTools
handlers, but neither contains this report/view/reference capability. Existing
Logger and tool events remain inherited foundations. The increment consists of
allowlisted result observations, background settlement telemetry, a bounded log
report reader, developer-mode-gated UI and a user-initiated draft reference. See
[the decision](../adr/local-tool-observer.md); this source claim does not establish
installed behavior, complete error detection, or support for un-fetched upstream.

The [2026-11-16 compatibility verification](../testing/harness-compatibility-2026-11-16.md)
compares personal base `cee401bd4` with upstream
`29043af3371122e256bf265db31651da125d38e3`. The local increment accepts blank
optional tags only for supported legacy Edit replacements, keeps session read
ranges across foreground workspace navigation, and preserves Windows Git Bash
command bytes at the native argument boundary. Existing Edit guards and shell
ownership remain inherited; the record separates red/green source tests from
unperformed installed-application verification.

The main-model identity addition starts from personal source `d0f4fd890`,
compared read-only with locally recorded upstream
`dd66ca037391da7378be25becb1a8bcb8054298f` (no fetch). That upstream's
`composeSystemPrompt` carries persona, tools and project context but no active
main-model identity. The local
[prompt](../../packages/agent-runtime/src/runtime-model-identity.ts) adds only
request-binding IDs and their limits; existing provider selection, chronological
system state and checkpoints remain inherited. The
[offline user path](../../packages/agent-runtime/src/runtime-model-identity.test.ts)
checks provider-visible identity, not live backend weights or routing.

The execution-continuity amendment was added on personal base
`58c8ef37b`, compared read-only with the same locally recorded upstream
`7841a9828249e5f93c9aa1a85e3a096776bfe1b8`. That upstream's
`runtime.ts` keeps only the latest user on successful active compaction, and
`pi-runtime-messages.ts` retains only tool-output prefixes. This local change
adds budgeted current-task execution pairs, head/tail summary excerpts and
explicit continuation guidance; automatic compaction and checkpoint storage
remain inherited foundations. See the
[decision and regression scope](../adr/compaction-execution-continuity.md),
[selector](../../packages/agent-runtime/src/compaction-continuity.ts) and
[offline user path](../../packages/agent-runtime/src/compaction-continuity-user-path.test.ts).
This comparison does not claim anything about un-fetched upstream changes or
installed/live-model behavior.

The delegation-observation amendment starts from personal source `fa809a755`
and was compared read-only with locally recorded upstream
`30dd376e23a02a378d3f0f43f2eee8cc135ac0a0` (no fetch). That revision lacks the
personal `subagent-progress.ts`, `subagent-diagnostics.ts`, scheduling editor
and canonical `delegation_history.rs` surfaces, as verified by `git ls-tree`.
The underlying Agent loop, tools and resumable delegation remain inherited.
This amendment extends the existing local checkpoints (`c2a651ff9`) and terminal
integrity (`4da7b50ef`) with bounded runtime observations and consumer-delivery
metadata; it does not claim to originate delegation or token accounting.
See the [recorded-facts contract](../spec/03-runtime/delegation-observability.md),
[observer](../../packages/agent-runtime/src/subagent-observability.ts),
Host projection `crates/host-core/src/delegation_history_observation.rs`,
and production diagnostics `apps/desktop/src/components/workpanel/SubagentObservationSummary.tsx`.
These two paths identify repository source, not documentation-site pages.
The sound increment is draft-volume preview and refresh/reopen hydration
deduplication on top of the existing core notification preferences, not a new
notification subsystem. Source-level tests and isolated fixtures do not establish
physical audio, installed-app behavior or pure model-generation performance.

The native-image receipt fix starts from personal source `f28653e41`, compared
read-only with locally recorded upstream `047c4eab1c97a349b3cf8c734229b64ed9d87764`
(no fetch). That revision has no native `image_generation_call` receiver in the
runtime/image-generation/subagent binding surfaces. The local increment uses Pi's
existing raw-event hook and the inherited Markdown preview/persistence contracts;
it does not originate image generation or the viewer. See the
[decision amendment](../adr/image-generation-capability.md),
[receiver](../../packages/agent-runtime/src/image-generation/hosted-images.ts) and
[public-path regression](../../packages/agent-runtime/src/image-generation/hosted-image-runtime.test.ts).
This describes current source, not an installed release or a live-provider test.

| Local increment | Originating local commits | Contrast with the audited upstream | Current implementation / coverage evidence |
| --- | --- | --- | --- |
| Broader repeated mutation/command failure protection | `d9bf50fa1` | Upstream already guards repeated Edit and shell-patch failures. Local work extends accounting to Write and identical ordinary Bash failures while preserving upstream owner isolation, and permits meaningful retests after successful file changes. This is not a blanket three-command limit. | [Guard](../../packages/agent-runtime/src/mutation-recovery-guard.ts), [runtime coverage](../../packages/agent-runtime/src/runtime-tool-recovery.test.ts). |
| Independent admission-pressure accounting and bounded context progress | `75a192387` | Upstream already has Host admission and error-code recovery grace. Local work gives capacity refusals a separate owner/class budget, and grants limited extra recovery for genuinely new complete unseen-line reveals without treating them as malformed edits. | [Guard](../../packages/agent-runtime/src/mutation-recovery-guard.ts), [user-path coverage](../../packages/agent-runtime/src/harness-recovery-user-path.test.ts), [historical scope record](../testing/harness-recovery-2026-11-08.md). |
| Control capacity, permission waiting, and admission-before-spawn fixes | `75a192387` | Upstream has RPC limits and background tasks, but uses one RPC slot pool and starts a background runner before admission checks. Local work reserves completion/cancellation capacity, reserves background admission before spawn, enforces per-session shell limits, and separates indefinite permission waiting from aggregate request deadlines. It does not remove actual tool timeouts. | [RPC admission](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/crates/host-core/src/rpc/mod.rs), [background admission](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/crates/host-core/src/background_tasks.rs), [RPC coverage](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/crates/host-core/src/rpc/admission_tests.rs), [spawn coverage](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/crates/host-core/src/background_tasks/admission_tests.rs). |
| Legacy Edit compatibility and conflict diagnostics | `09c15a314`, `75a192387` | Upstream already supports legacy replacement without a tag. Local work accepts a supported replacement pair with a tag/empty ops and improves duplicate-gap diagnostics; nonempty conflicting formats, stale tags, ambiguous matches and unread context remain guarded. | [Tool parser](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/crates/host-core/src/tools/mod.rs), [hashline operations](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/crates/host-core/src/tools/hashline/apply.rs), [regression coverage](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/crates/host-core/src/tools/harness_regression_tests.rs). |
| One main-turn correction for printed tool protocol | `0008cb59f` | Upstream `18eb37ba4` already diagnoses text-form tool calls. Local work adds one finish-turn reminder rather than ending silently; it does not execute printed text, replay completed tools, or indefinitely retry correction. | [Recovery](../../packages/agent-runtime/src/text-tool-call-recovery.ts), [coverage](../../packages/agent-runtime/src/text-tool-call-recovery.test.ts). |
| Degenerate-output circuit breaker and bounded preview refinements | `5b4fd2c28` | Adds incremental detection of long whitespace/symbol runs in model text/thinking, partial-result retention and non-replay termination, plus bounded display fallbacks. Not general semantic repetition detection; fenced code and tool arguments/results are outside the detector. | [Detector](../../packages/agent-runtime/src/model-output-repetition.ts), [stream guard](../../packages/agent-runtime/src/model-output-guard.ts), [user-path coverage](../../packages/agent-runtime/src/model-output-repetition-user-path.test.ts), [display coverage](../../apps/desktop/test/markdown-output-preview-user-path.test.mjs). |
| Main-session transport-idle policy and no automatic replay on local cutoff | `bf47f63d4` | Upstream already has an event-idle watchdog. Local work observes transport activity where supported, separates model-silence hints, adds a settings preference, and makes local idle termination non-retriable with partial output retained. Not a universal timeout for native sessions, all providers or every operation. | [Idle policy](../../packages/agent-runtime/src/provider-stream-idle.ts), [decision](../adr/provider-stream-idle-policy.md), [coverage](../../packages/agent-runtime/src/provider-stream-idle.test.ts). |
| Runtime-owned context compaction trigger | `5d332f0d4` | Upstream already has automatic compaction and durable context checkpoints, but also exposes a model-facing `new_context` tool. Local work removes that model-triggered path while preserving automatic/user/extension compaction. | [Decision](../adr/runtime-owned-context-compaction.md), [runtime](../../packages/agent-runtime/src/runtime.ts), [runtime coverage](../../packages/agent-runtime/src/runtime.test.ts). |
| Fixed-tool delegates can load available skills | `a6f1e8010` | Upstream provides skills, but a fixed-tool delegate only receives its declared tools; Skill can otherwise require inheriting the parent catalog. Local work includes the available Skill loader without importing unrelated executable tools. | [Tool resolution](../../packages/shared/src/subagent-definition.ts), [user-path coverage](../../packages/agent-runtime/src/delegation-skills-user-path.test.ts). |
| Exact job selection and Bash-argument normalization | `608123cdc`, `c7ab4b216`, `43db88d7d`, `75a192387` | Upstream `275748889` independently accepts redundant consistent delegation selectors. Local differences require exactly one matching delegation ID, preserve wait parameters, and remove irrelevant delegation arguments for an explicit Bash job before validation. Background controls themselves are inherited. | [Job routing](../../packages/agent-runtime/src/background-job-tools.ts), [coverage](../../packages/agent-runtime/src/background-job-tools.test.ts). |
| Persisted local subagent progress checkpoints and configurable work budgets | `c2a651ff9`, `4da7b50ef` | Upstream already has transcript-backed resume/history. Local work adds automatic scratch checkpoints/reports and configurable call/time budgets. Current work-budget defaults are unlimited and TaskReport is optional; do not describe historical periodic-report requirements as current behavior. | [Progress](../../packages/agent-runtime/src/subagent-progress.ts), [checkpoint storage](../../packages/agent-runtime/src/subagent-checkpoint.ts), [coverage](../../packages/agent-runtime/src/subagent-checkpoint.test.ts), [amended resume decision](../adr/0279-resumable-subagent-delegations.md). |
| Final-report integrity and coordinated recovery | `4da7b50ef`, `637a28be1`, `0a4e5c36f`, `aad05230f` | Upstream already rejects missing/truncated reports and permits manual resume of parent-interrupted work. Local work checks the current terminal response rather than old progress text, supports bounded optional report recovery, active-parent manual retry and coalesced next-user-turn recovery. Explicit Stop does not auto-resume; no boot-time redispatch or semantic quality guarantee. | [Terminal classification](../../packages/agent-runtime/src/subagent-terminal.ts), [recovery](../../packages/agent-runtime/src/delegation-recovery.ts), [decision](../adr/delegation-terminal-reliability.md), [terminal coverage](../../packages/agent-runtime/src/delegation-terminal-user-path.test.ts), [manual recovery coverage](../../packages/agent-runtime/src/manual-recovery-user-path.test.ts). |
| Unified scheduling/approval, session pools and failure policy | `a286c46ac`, `7262a96f7`, `b3c40e482`, `dd6d43b66` | Upstream has model pins, opt-in and fallback. Local work adds unified pools/priority/consent, recoverable grouped approval, live admission rechecks, session-scoped pool/approval overrides, on-demand TaskModels and explicit failure policies. Policy changes do not silently replace an already running child's admitted snapshot. | [Scheduler](../../packages/agent-runtime/src/delegation-scheduler.ts), [scheduling decision](../adr/delegation-scheduling-and-approval.md), [session decision](../adr/session-organization-and-scoped-delegation.md), [hot-policy coverage](../../packages/agent-runtime/src/delegation-hot-policy-user-path.test.ts). |
| Direct child input and resume-binding compatibility | `dd6d43b66`, `9272af765` | Adds local-Agent child steering and explicit settled-chain follow-up on top of upstream resume. Redundant matching model fields no longer reject resume, but conflicting fields do not override retained identity. Message IDs deduplicate retries; this is not exactly-once external side-effect execution. | [Conversation policy](../../packages/agent-runtime/src/subagent-conversation.ts), [resume tool](../../packages/agent-runtime/src/delegation-tool.ts), [decision](../adr/subagent-controls-and-direct-input.md), [user-path coverage](../../packages/agent-runtime/src/subagent-conversation-user-path.test.ts). |
| Consistent live/restored tool images and actual child vision capability | `5f1d0229a` | Upstream already restores image blocks and Read images. Local work unifies live/restore admission, preserves original source data, handles mixed result containers and child-model capabilities, and reports omissions. It does not guarantee that a model sees every historical image. | [Content normalization](../../packages/agent-runtime/src/tool-result-content.ts), [child image context](../../packages/agent-runtime/src/tool-image-context.ts), [adapter coverage](../../packages/agent-runtime/src/tool-image-input.test.ts). |
| One unfinished-checklist continuation | `6f8d77f50` | The checklist is inherited; the local addition is one configurable follow-up based on a successful current-user-turn checklist write. Old persisted todos alone do not trigger it, failures/Stop remain terminal, and it can add model usage. | [Continuation](../../packages/agent-runtime/src/unfinished-todo-continuation.ts), [coverage](../../packages/agent-runtime/src/unfinished-todo-continuation.test.ts). |
| Windows Python standard-stream encoding default | `75a192387` | Local runner setup defaults PYTHONIOENCODING to UTF-8 only when not inherited. It does not set global Python/file encodings, override explicit preferences, or transcode arbitrary legacy programs. | [Runner environment](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/crates/host-core/src/tools/runner_environment.rs), [encoding coverage](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/crates/host-core/src/tools/runner_encoding_tests.rs). |

## Local interface, organization, and host fixes

The projectless-reference follow-up starts from personal `f28653e41`, compared
read-only with recorded upstream `047c4eab1c97a349b3cf8c734229b64ed9d87764`
(no fetch). That upstream's reference registry requires `projectPath: string`
and only writes version 1 project-owned records. The local follow-up adds version 2
session-owned records for projectless local sessions and explicit remote rejection
in normal/steering preparation, without rewriting existing records or changing
tool-read permissions. This extends the inherited reference registry rather than
claiming that registry as a local invention.

The automatic local-file intake amendment starts from personal source `a402d2cec`,
compared read-only with recorded upstream `4d16de71a34b02fd8711c1102a288664b3d171c1`
(no fetch). Both already contain `46c6788c8` and its native clipboard references.
At that upstream revision, `useComposerAttachments.ts` still buffers dropped
files with `arrayBuffer()` and imports picker selections with the copy default.
The local increment unifies these entry points and the browser-File paste fallback
under automatic reference/image classification, adds a preload-only File selection
bridge, and preserves selection metadata and picker session ownership. The
reference registry, draft/history support and image pipeline are inherited, not
new local inventions. See the [amended decision](../adr/composer-local-file-references.md)
and targeted Composer import/selection tests; source coverage does not establish
installed-release or live-provider behavior.

The historical-reply fork lookup amendment is based on personal source
`d8f10f6ecc1e1d1e693d8717a3a2bf1f07af3ffe`, compared read-only with the
locally recorded `upstream/main` revision
`dd66ca037391da7378be25becb1a8bcb8054298f`; no fetch was performed for this
comparison. That upstream's `forkAssistantMessage` searches only
`state.messages` and silently returns when an older displayed reply is absent.
The local [action](../../apps/desktop/src/stores/slices/session-slice.ts) uses
the same reading-range projection as the transcript. Independent session forks,
Host-owned canonical-prefix copying, and running-turn prefix guards remain
inherited foundations, not local inventions. The
[regression scenarios](../../apps/desktop/test/session-fork-running.test.mjs)
cover upward paging, search navigation, and reading-position restoration with
both idle and running sources, preserving source caches and reading ranges.
Offline tests do not establish installed-application or live-model behavior.

The Read-preview placement follow-up starts from personal `855ea422b` and
compares with locally recorded upstream `b5418cea3818dd3b13c79c9786af322019cbdd7a`
(no fetch). That upstream has neither `ToolResultImages.tsx` nor
`tool-image-groups.ts`. Local `59a49cdb9` added the adjacent-Read promotion;
`a402d2cec` removed it but required opening raw details to see any thumbnail.
The row now shows its own previews while visible, without changing the footer,
image reader/viewer, or generation contracts. See the component coverage below.

| Local increment | Originating local commits | Contrast with the audited upstream | Current implementation / coverage evidence |
| --- | --- | --- | --- |
| Current-session subagent entry and history-backed task index | `869bc1d18` | Upstream has child transcripts, but not this topbar entry or session-filtered history projection. | [Session index](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/apps/desktop/src/features/delegations/SessionDelegationsPanel.tsx), [decision and coverage](../adr/session-subagent-topbar-index.md). |
| Global delegation history and retained approval receipts | `3ab65cd3e`, `4ffdf771a` | Extends existing task records with cross-project history and durable terminal approval receipts; it does not invent a second execution truth or preserve pending consent as authorization. Pointer handling in the history surface is a local follow-up fix. | [History query](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/crates/host-core/src/delegation_history.rs), [history UI](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/apps/desktop/src/features/delegations/DelegationHistoryDialog.tsx), [decision](../adr/global-delegation-history.md), [UI coverage](../../apps/desktop/test/delegation-history-ui.test.mjs). |
| Unified core notification preferences and actionable presentation | `a746f4b69`, `3ab65cd3e` | Upstream already has notifications/inbox infrastructure. Local work unifies approval, question and outcome delivery policy, channel/sound settings, pending/history separation and retained outcomes. Plugin notifications remain separate. | [Notification runtime](../../apps/desktop/src/stores/runtime/notification-runtime.ts), [decision](../adr/unified-core-notifications.md), [user-path coverage](../../apps/desktop/test/core-notification-user-path.test.mjs). |
| Explicit selection mode, batch organization, local-session recycle bin | `df3cd25f1` | Modifier-key selection, archiving, and a plugin soft-delete field already exist upstream. Local work adds visible checkboxes/selection controls, batch actions and Desktop trash/restore/purge workflows. Native Pi and remote sessions are outside local recycling. | [Selection](../../apps/desktop/src/features/sessions/useSessionSelection.ts), [batch operations](../../apps/desktop/src/features/sessions/session-organization.ts), [trash UI](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/apps/desktop/src/features/sessions/SessionTrashDialog.tsx), [decision](../adr/session-recycle-bin.md), [IPC coverage](../../apps/desktop/test/session-trash-ipc.test.mjs). |
| Project-scoped conversation groups and display labels | `b3c40e482`, `75ac98246`, `14f17caf8` | Extends upstream logical projects and sidebar preferences; it does not originate multi-root projects. Conversations have one display group and independent multiple color labels; labels do not duplicate sidebar containers. Named groups start folded and opening a conversation leaves disclosure unchanged in the same locally owned projection (`SidebarSessionGroups.tsx` is absent at `upstream/main` revision `047c4eab1`). | [Catalog editor](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/apps/desktop/src/features/sessions/SessionCatalogEditor.tsx), [organization dialog](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/apps/desktop/src/features/sessions/SessionOrganizationDialog.tsx), [decision](../adr/project-conversation-groups.md), [coverage](../../apps/desktop/test/project-session-organization.test.mjs). |
| Manual conversation read/unread | Sidebar manual-read-state change | At `upstream/main` revision `047c4eab1`, task outcomes were acknowledged from the inbox or by opening a conversation, with no manual sidebar unread action. The local increment is the row action and a device-local marker, not the inbox or automatic outcome handling. | [Sidebar read-state contract](../spec/04-ux/01-ui-ia.md#32-sidebar-project-groups), [isolated user path](../spec/06-delivery/e2e/conversation.md#e2e-session-manual-read-state-mark-a-sidebar-conversation-read-or-unread). |
| Activity ordering, relative times and rename selection fixes | `b3c40e482`, `10d2bd753`, `d4465f3fd`, `812581998` | Local ordering reacts to accepted user sends/manual moves, not merely opening or receiving output. Relative times gain minute/hour precision; rename no longer repeatedly selects input on parent rerender. These are refinements, not new conversations or rename capability. | [Ordering](../../apps/desktop/src/lib/session-activity-order.ts), [organization contract](../adr/session-organization-and-scoped-delegation.md), [date formatter](../../apps/desktop/src/lib/sidebar-session-date.ts), [rename dialog](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/apps/desktop/src/components/SessionRenameDialog.tsx), [rename coverage](../../apps/desktop/test/session-rename.test.mjs). |
| Task-first presentation and partial-turn change summaries | `717b22ae4` | Upstream already has activity groups, thinking, child detail, and changed-file cards. Local work changes default disclosure, replaces the coordinator presentation with task rows, shares detail rendering, and shows recorded changes before a successful final reply. | [Decision](../adr/task-first-transcript-presentation.md), [change summary](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/apps/desktop/src/features/chat/transcript/TurnChangesCard.tsx), [presentation coverage](../../apps/desktop/test/task-reading-presentation.test.mjs). |
| Session-switch reading-position recovery fixes | `d20de06ab` | Upstream already remembers reading position and supports history/search. Local work distinguishes deferred paging, superseded restoration and missing anchors, preserving loaded ranges and refusing stale completions. | [Restoration hook](../../apps/desktop/src/hooks/use-transcript-reading-position.ts), [reading runtime](../../apps/desktop/src/stores/runtime/transcript-reading-runtime.ts), [coverage](../../apps/desktop/test/transcript-reading.test.mjs). |
| Tool-result image gallery and historical preview preservation | `5f1d0229a`, `59a49cdb9`; Read-placement follow-up above | Upstream image generation, image reading and generated-image viewing remain inherited. Local work adds generic tool-result image presentation, preserves bounded history previews and recovers intact mirrors. Ordinary Read previews stay with the call instead of becoming delivered images. | Gallery source: `apps/desktop/src/features/chat/transcript/ToolResultImages.tsx`, [placement](../../apps/desktop/src/lib/tool-image-groups.ts), [projection](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/crates/host-core/src/sessions/display_preview.rs), [coverage](../../apps/desktop/test/tool-result-images-user-path.test.mjs). |
| Expanded chat file actions | `25faf73af` | Upstream has HTML Open with, path copying and Show in folder. Claim only Save as, supported text-content copying, and extending Open with to non-HTML files/default applications. Native actions retain resolution, containment and session checks. | [Menu](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/apps/desktop/src/hooks/use-chat-file-menu.tsx), [actions](../../apps/desktop/src/hooks/use-chat-file-action.ts), [Save as](../../apps/desktop/electron/main/fs-save-as.ts), [coverage](../../apps/desktop/test/chat-file-open-with-menu.test.mjs). |
| Explicit-directory file references and worktree normalization | `cf99680b2`, `a746f4b69` | Generic Windows POSIX-rooted drive resolution overlaps upstream. The distinct local increments are carrying an explicitly stated Markdown directory to bare filenames, and normalizing before worktree rebasing. Do not claim all Windows path normalization as local. | [Directory context](../../apps/desktop/src/lib/markdown-file-directory.ts), [worktree rebasing](../../apps/desktop/electron/main/worktree-ref.ts), [directory coverage](../../apps/desktop/test/markdown-file-directory.test.mjs), [worktree coverage](../../apps/desktop/test/worktree-ref-rebase.test.mjs). |
| Factual tool outcomes and retained run diagnostics | `10d2bd753`, `d4465f3fd`, `178f7721e` | Upstream has tool status and active retry hints. Local work distinguishes failure, denial, input-driven skip, interruption and missing edit context; persists detailed phase/retry evidence and expires stale retry badges. Diagnostics are not proof of productive work. | [Tool classification](../../apps/desktop/src/lib/tool-status.ts), [run detail](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/apps/desktop/src/features/chat/transcript/RunStatusIndicator.tsx), [coverage](../../apps/desktop/test/run-diagnostics.test.mjs), [tool-status coverage](../../apps/desktop/test/tool-status.test.mjs). |
| Stale running-state cleanup | `aa5f26085` | Local reconciliation clears outdated local/native runtime ownership and pending UI after idle/backend loss, without clearing a still-running remote session or inventing a successful outcome. | [State helper](../../apps/desktop/src/stores/runtime/session-run-state.ts), [regression coverage](../../apps/desktop/test/session-running-state.test.mjs). |
| Search/file-operation isolation across sessions | `b6a57c418` | Upstream's directory-search lease can fence unrelated writes. Local Grep coordinates each actual file, Glob avoids a whole-tree transaction, and traversal/lease waits observe cancellation. Same-file and hard-link exclusion remain; there is no whole-tree snapshot or faster-single-search claim. | [Search implementation](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/crates/host-core/src/tools/search.rs), [cancellation](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/crates/host-core/src/tools/search_control.rs), [decision](../adr/search-file-lease-isolation.md), [real-tool coverage](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/crates/host-core/src/tools/file_lease_tests/search_tests.rs). |
| Approval controls and collapsed-entry interaction fixes | `f4146ae8e`, `78088ebda` | Local follow-ups make the scheduling editor usable in bounded dialogs and keep the collapsed approval entry from intercepting composer input. They refine the local approval surface, not upstream permissions generally. | [Approval center](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/apps/desktop/src/components/delegation-approval/DelegationApprovalCenter.tsx), [entry geometry](../../apps/desktop/src/components/delegation-approval/delegation-approval.css), [scheduling coverage](../../apps/desktop/test/subagent-scheduling-user-path.test.mjs). |
| Project capability overrides after Windows data-directory relocation | `c9e63290d` | Despite its test-oriented subject, this commit also fixes production code: relocated capability identities use the same normalized project paths as lookups, preserving overrides and collision detection. Do not attribute the whole migration feature to this edition. | [Relocation](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/crates/host-core/src/data_relocation.rs), [relocation coverage](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/crates/host-core/src/data_relocation/tests.rs). |
| Conversation organization during data-directory relocation | `f9fdf16d0` (merge integration) | This surviving local hunk remaps project-scoped conversation catalogs and membership keys alongside upstream sidebar relocation. It preserves local groups/labels/order; stable group and external project scopes are not rewritten. | [Relocation](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/crates/host-core/src/data_relocation.rs), [regression coverage](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/crates/host-core/src/data_relocation/tests.rs). |

## Local development and delivery

| Local increment | Originating local commits | Boundary and evidence |
| --- | --- | --- |
| Personal installer lane and self-managed updater policy | `15943ccd0`, `2855929bb`, `59feb539f`, `0f7552494` | Upstream supplies Electron packaging/updater foundations. The local lane restricts personal output to Windows x64 NSIS, disables official updates for marked builds, cleans intermediates without deleting past installers, and records build identity/source/hash/change notes. See [builder](../../scripts/build-personal-release.mjs), [updater](../../apps/desktop/electron/main/updater.ts), [runbook](../spec/06-delivery/07-personal-release-runbook.md), [coverage](../../apps/desktop/test/personal-release.test.mjs). |
| Photon Main startup asset repair | Follow-up to local `2877d6d27` | Against upstream `29043af33`, the Main Vite configuration had no Photon resource emission. Local image-integrity decoding introduced an eager loader; the installed `0.23.1-beta.1` archive at `2877d6d27` omitted its WASM and failed before logging/window/tray creation, reproduced with an empty isolated profile. [Main bundling](../../apps/desktop/electron.vite.config.ts) now retains the pinned WASM beside entry/shared-chunk loaders, [standalone regressions](../../apps/desktop/test/main-wasm-assets.test.mjs) decode a real image, and the [installer gate](../../scripts/build-personal-release.mjs) rejects missing/invalid ASAR assets. This does not establish existing-profile upgrade compatibility. |
| Development profile opt-in and fixed Windows source launcher | `15943ccd0`, `001c3215e`; same-console/config-export follow-up | The local dev launcher clears inherited data-directory overrides by default. Read-only comparison with recorded upstream `047c4eab1c97a349b3cf8c734229b64ed9d87764` confirms the Windows entry is absent there. The current source entry keeps build output and exact exit status in the same console. It performs no backup by default; only explicit `-BackupConfig` exports application preferences and user-owned provider/model definitions through read-only Host Core SQLite access, excluding conversations, whole databases and credential blobs. It checks owners without stopping processes. See [dev launcher](../../scripts/dev-electron.mjs), Windows launcher (`scripts/start-local.ps1`), config exporter (`crates/host-core/src/config_backup.rs`), [dev coverage](../../apps/desktop/test/development-launch.test.mjs), and launcher coverage (`scripts/start-local.test.ps1`). |

## Upstream-origin items excluded from local highlights

| Item | Evidence and decision |
| --- | --- |
| Turn/session token and cost display | `969b7f47a` is reachable from the audited upstream. [Cost logic](../../apps/desktop/src/lib/usage-cost.ts) and [cost KPIs](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/apps/desktop/src/features/chat/context-usage/ContextCostKpis.tsx) have no diff against that revision. Removed from personal highlights. |
| Show a chat file in its folder; existing HTML Open with and path copy | Upstream `8d153dc3b` adds folder reveal; the audited upstream [menu path](https://github.com/saiveen1/PI-Desktop/blob/58c8ef37b/apps/desktop/src/hooks/use-chat-file-menu.tsx) already contains these actions. Keep only the local extensions in the table above. |
| Generic POSIX-rooted Windows drive repair | Upstream `8a1f7e588` implements the generic resolver correction. Local normalization has overlapping work, so README names only the distinct explicit-directory/worktree increments. |
| User-defined staged modes and Goal controls | Upstream `1131ce966` and `a209a2ca8`; their appearance in the personal generated changelog does not make them local features. Excluded. |
| Metadata-only session reads optimization | Upstream `211cae52a`. Excluded rather than relabeling an upstream performance fix. |
| Basic Edit failure budgets, text-call diagnostics, idle watchdogs and consistent redundant delegation selectors | These already exist upstream, including text-call diagnosis `18eb37ba4` and selector acceptance `275748889`. Only the specific extensions and corrected semantics in the harness table are claimed as local. |
| Basic subagents, Task tools, resumption, permissions, plugins/MCP, image generation, project roots, archive, and reading-position memory | Inherited foundations. README must name the specific local extension or correction, not claim these whole capabilities as personal inventions. |

## Maintenance work not promoted into product claims

The local range also includes release metadata/recording, integration merges,
policy routing, fixture corrections, Windows test portability, ignored artifacts,
and validation records. The production relocation fix inside the test-oriented
`c9e63290d` commit is listed above; its other fixture changes are maintenance.
Maintenance alone is not evidence of a new capability or installed-product
reliability guarantee. Examples:
`9c967142f`, `c9e63290d`, `462391cde`, `e8c41aa9b`, `9bae7cdc9`, `2d19b08aa`,
`e995188b8`, `3c903f884`, `06926bc7d`, `7b18ec7d9`, `df6f86053`, `b97e9aacf`,
and the earlier README update `b90fbd04f`.

Future README edits should re-evaluate the relevant row against their actual
source/upstream revisions, retain valid origin credit if upstream later adopts a
local change, and avoid implying that a historical local contribution is still an
exclusive difference. Do not regenerate this inventory from commit titles alone.

### Group pagination follow-up (source candidate)

Against local base `ed93df9c8` and audited upstream `047c4eab1`, the upstream
sidebar still pages the project-wide flat history and has no
`SidebarSessionGroups.tsx` component. This follow-up fixes the local grouping
composition: count complete eligible group membership, then page each local
conversation group independently. It does not claim multi-root projects or the
original paging affordance as local inventions. The production first-render
regression in `sidebar-group-pagination.test.mjs` failed before the fix (a
four-member group appeared as zero); component interaction coverage exercises
independent expansion, stable counts and visible-only selection in
`session-organization-user-path.test.mjs`. This is source-candidate evidence,
not an installed-release verification.
