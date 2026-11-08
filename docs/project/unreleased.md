# Unreleased changes

> Historical mixed upstream/personal development notes, retained without
> reconstructing releases. New personal release records live in
> the repository-root `CHANGELOG.md`, generated from
> [release history](../releases/history.json). Do not append new release entries here.

- Harden tool recovery: normalize background-job selectors before schema checks,
  separate Host admission pressure from edit failures, and recognize bounded
  progress from newly revealed lines. Context-required edits have a neutral,
  localized status without changing their stored results. Shell guidance separates
  execution deadlines from observation intervals and forbids automatic replay
  after uncertain command effects.

  Windows Python standard streams default to UTF-8 without changing file encoding
  or explicit overrides. Blank Edit ops can use a valid legacy replacement pair;
  insertion conflicts identify both operations before any write.

- Keep bounded RPC capacity available for approval/completion/cancellation even
  when ordinary requests are saturated. Reserve background capacity before
  launching commands, exclude approval waiting from aggregate tool deadlines,
  and enforce the documented two-foreground-shell limit per session.
- Resolve inline-code filenames below an explicit absolute directory in assistant
  Markdown, including export tables split into separate render blocks. Click and
  context-menu actions share the composed exact path; headings and ambiguous
  directory declarations clear context, and missing paths never redirect to an
  unrelated same-name file.

- Present conversation labels as collapsible full-row groups within project,
  temporary and remote history. Multi-label conversations have multiple shortcuts
  to the same data; visible selection deduplicates IDs and global pins stay flat.
  Replace sidebar seconds counters with localized Now/minute ages and one shared,
  visibility-aware minute clock that updates time components instead of Sidebar.

- Distinguish tool calls skipped for new input and explicit interruptions from
  real failures. Muted status labels expose localized hover/focus reasons;
  actual failures retain bounded error details, and timeouts/nonzero command
  exits stay red. Preserve original tool results and plugin status contracts.

- Fix conversation-specific subagent customization: selected models now have
  editable Automatically allowed / Approval required rules saved for that
  conversation, rather than read-only global approval labels. Launch and live
  admission share the same effective policy. Global eligibility remains enforced;
  legacy pools inherit approval until saved, and Follow global clears both overrides.

- Require a current final report before a delegation can complete; stale progress,
  thinking-only replies and empty truncated endings no longer count as delivery.
  Preserve partial findings and expose live counters, model selection/fallback
  details and terminal report diagnostics. Scheduling offers one optional,
  bounded report-only recovery; Behavior offers a separate 0-3 retry limit for
  unexplained upstream 400/422 wrappers. Both new recovery options default off,
  preserve completed tool effects and remain cancellable. Task context minimum
  zero now means no minimum consistently, and malformed admission input fails
  before cycling through the model pool. Final integration validation is pending.

- Add persistent conversation activity order with same-project drag ordering;
  accepted user messages raise a conversation while reading and assistant output
  preserve its position. Add editable global labels, multiple labels per
  conversation, independent color marks and combined filters.
- Add a per-conversation subagent model pool. Custom pools match individual
  tasks to model descriptions, retrieved on demand through TaskModels; inherited
  pools retain existing policy. Approval and fallback stay inside the effective
  pool. Ordinary delegation details retain the original selection rationale and
  show actual model and scheduling decisions separately. Candidate validation
  is pending at the user's request.

- Show recent session updates in seconds, minutes or hours instead of zero days,
  and align message clocks with full local date/time/timezone details without
  rewriting stored timestamps. Running statuses expose a shared details dialog
  with stable whole-turn elapsed time, cumulative retry counts, actual backoff,
  separate model-event/answer-text ages and current context estimates. Final
  diagnostics remain available on completed replies without changing retry policy.

- Add installation-local Notifications settings for delivery channels, categories,
  sound and volume, plus inheritable delegation reminder overrides. Questions,
  permissions, plans, delegation approvals and structured admission failures use
  application-owned reminders and safe source navigation. The bell separates
  live Needs action from durable task history; read/clear never settles consent.
  Repeats are opt-in and stop with the request. Existing model authorization and
  fallback rules are unchanged; no extra model requests or notification tools.
  Native API acceptance is reported as a request, not proof of an OS banner.

- Keep the parent conversation usable during a manual subagent retry. Retained
  history and checkpoints continue the child work; steering leaves it running,
  and its report returns through one parent continuation and turn completion.
- Add a grouped delegation approval center with source navigation, asynchronous
  arrivals, a full-task reader, exact model selection and explicit selected-item
  actions. Failed submissions remain visible for retry; collapsing never rejects
  work. New/default policies wait five minutes without rewriting saved waits;
  explicit extension adds five minutes and expiry uses only authorized automatic
  alternatives. Saved scheduling changes apply to later admissions and pending
  approvals during the same turn while active children keep their starting
  provider and execution settings. Phase-2 integration verification is pending.

- Preserve subagent progress reports through cancellation and restart. Explicit
  resume reuses retained findings; long runs reserve a bounded report phase
  when their work budget is exhausted, and TaskWait can recover saved reports.
  Optional work budgets and final-report timing live in Subagents → Scheduling;
  both work limits default to disabled. State is saved automatically without
  requiring periodic model reports. Child details show the actual task settings,
  including after reload; previous trial report-gate fields no longer affect work.

- Add explicit session multi-selection with checkboxes, visible-only select all,
  batch archive/unarchive and Move to recycle bin. The sidebar recycle bin
  supports batch restore and confirmed permanent deletion. Trashed local
  sessions keep their history, isolated worktrees and original archive/pin
  state until permanently deleted; there is no automatic expiry. Running or
  queued work is protected, and failed batch items stay selected for retry.
- Show chat file links as blue document-icon labels. Their context menu now
  offers Open file, Open with, Save as, Copy file contents, and Show in folder
  alongside the existing path-copy actions. Save as copies the original bytes
  through a native destination picker; source navigation and remote-file
  restrictions are preserved.
- Fixed the composer context ring staying at the pre-compaction figure after
  `/compact` or an automatic compaction until another turn ran (#2015). The
  ring now shows the compacted context's estimated size as soon as the
  checkpoint is installed, and after reopening the session.
- Fixed prompt cache misses after a conversation's agent runtime is rebuilt
  (#1972). Rebuilding happens after a restart or when the thinking level, mode,
  project rules, or model settings change. Assistant replies now keep the
  provider's thinking, reasoning, and Gemini function-call signatures in the
  transcript, so Claude, OpenAI Responses, Gemini, and other reasoning models
  receive the same history as before the rebuild instead of a rewritten one.
- Fixed duplicate `/、` when opening slash commands with a Chinese IME in an
  empty composer. Keep pre-edit text intact and apply the slash alias only
  after composition commits, preserving recovery from a missing end event.
- Add OpenAI Fast mode (#1657). Allow it per model in Settings → Models for a
  ChatGPT subscription or an OpenAI Responses connection, then type `/fast` to
  turn it on for the current conversation. Requests ask for the priority
  service tier, which replies faster and spends plan limits faster or bills
  more per token; the Composer model chip shows a Fast mark while it is on.
- Fixed an older regenerated prompt appearing after the latest reply when its
  branch archive completed outside the loaded history window (#1870). Pager
  acknowledgements now update existing rows without appending historical roots.
- Generate inline visualizations faster. The visualization shell now preloads
  the bundled D3 and a `viz` chart helper layer (container sizing, resize and
  theme redraw, axes, tick overlap, legends, and a declarative `viz.render`
  for bar, line, area, point, heatmap, and donut charts), so model-written
  fragments are shorter. The `visualize` skill asks for a single write
  followed by the reply instead of reading the file back. Fragments written
  under the earlier skill keep rendering. When a fragment's script fails, the
  card now says so and shows the error instead of staying blank, and the
  model's write result flags syntax errors and missing chart containers so it
  can fix them with one edit.
- Fixed cramped inline visualizations. The visualization shell now places a
  fragment in the kit's `#widget` container, which spaces its top-level blocks
  12px apart, and the `visualize` skill asks for the title, controls, chart,
  legend, and captions as top-level blocks instead of one wrapping element.
  Inline controls, block styling, and roots that lay themselves out keep their
  geometry; cards written earlier inside one wrapping element render as before.
