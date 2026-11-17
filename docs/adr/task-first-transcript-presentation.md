# ADR: Task-first transcript presentation

- Status: Accepted; isolated component acceptance verified, integrated Desktop not run
- Date: 2026-11-08
- Scope: Personal-edition renderer presentation only
- Amends: [Turn process and thinking presentation](turn-process-and-thinking-display.md), the presentation portions of [ADR 0062](0062-bounded-subagents-behind-a-task-tool.md), and [component spec](../spec/04-ux/08-component-spec.md) §§4, 5.7, 9.9
- Presentation amendment: [Refresh stability and execution metadata](session-subagent-topbar-index.md#refresh-stability-and-execution-metadata-amendment) supersedes the single-line and hidden-model/effort choices below; other reading and execution invariants remain.

## Context

The execution trace exposed live reasoning, expanded activity groups and a
coordinator graph before the user could scan task progress. The task detail used
a different rendering path and a disabled composer, while a completed-reply
condition hid the changed-files summary during execution or interruption.

The approved Codex-reference direction replaces the personal edition's default
task-reading presentation directly, not by adding a second theme or style mode.

## Decision

### Default disclosure and truthful issue summaries

Keep the outer `TurnProcess`: active-open and untouched-completed-closed, with
the trailing answer, assistant errors, stopped partial answers and pending
approvals outside. Keep `transcriptDisplayMode` values `flat`, `command-first`,
and `fully-folded`; no fourth mode is introduced.

Ordinary activity groups start closed even while streaming when the existing
`autoCollapseSettledGroups` setting is absent or `true`. Rendered reasoning also
starts closed during streaming when `autoCollapseThinking` is absent or `true`.
Explicit `false` remains the opt-out for each level. The labels become **Collapse
activity by default** and **Collapse thinking by default** in all shipped locales.
There is no small-group tier or live-open exception. Independent manual choices,
search reveal, and transient focus/selection protection remain supported.

Reuse the semantic action-category summary and operation count. Closed ordinary
groups also expose their actual failure/denial count; skips, interruptions and
structured context requests are not failures. Classification is cached by
immutable message (`cachedActivityIssues`). Neither an issue count nor a child
tool error makes the whole turn terminally failed.

### Task lists and source-session detail

Replace coordinator topology with accessible task rows. The main conversation
keeps chronological, single-line task activity; the side-panel index groups it
into **Active**, **Needs attention**, and **Completed**, each with counts. Only
Task starts create entries. Lifecycle calls remain normal named compact tool
rows and keep their existing roster/status semantics. Prefer the short description over the
implementation role/name. Four stable identity icon colors are independent of
outcome; completion, failure, denial, cancellation and creation remain explicit
text. Remove the coordinator root, connectors, per-row model/step metadata and
extra enclosing task-group disclosure.

A task row opens or activates the source session's existing subagent work-panel
tab. Multiple tabs retain the current architecture; none opens automatically.
Stop, Stop all and failed Retry keep their existing scoped authorization gates,
source-session attribution, duplicate-request protection and runtime semantics.

The detail header offers **All tasks** back navigation to the same-session index,
the selected task title, passive effective model/thinking text and authorized
controls. Integration with [direct child input](subagent-controls-and-direct-input.md)
keeps the real local composer and admitted failure-policy summary in the detail
footer; the task index has no composer. No placeholder input or model picker
returns. Briefs and
original recorded diagnostics remain available in closed native details
disclosures; failure reasons remain visible outside those disclosures. Missing
historical metadata is not fabricated from current settings.

`SubagentTurnContent` reuses `TurnProcess`, `AssistantTurnParts`, `TurnChangesCard`
and images without parent-message edit/delete/regenerate controls. Keep the full
original child transcript and resume chain; current resumed selection uses the
latest Task handle metadata rather than stale first-call state. Only one visible
panel-body scroll surface owns follow/manual history and shared search reveal.

Direct child user rows split the shared assistant presentation into stable
segments and retain their original order and role. They have no parent-session
edit/delete/regenerate actions. Preempted Tasks keep their Not started outcome,
without a false execution duration or contribution to Active counts.

### Recorded changes during partial work

Mount `TurnChangesCard` whenever recorded turn changes exist, including live,
failed, stopped and no-final-text turns. Start with a compact content-sized file
count, recorded added/deleted lines and caret. `data-expanded="true"` expands a
bounded inline list to at most `min(100%, 520px)`, not a popover. Keep relaxed rows
for at most four files, dense rows above four, at most twelve visible paths and
then View all. Directory count appears only while expanded.

Keep Review routing, file actions and hash-guarded rollback in their existing
owners. Totals sum recorded edits, not net Git diff; scratch and unrecorded edits
are excluded. Child task changes remain available inside their own detail turns.

### Visual restraint

Light/dark palettes keep neutral surfaces, foreground body/progress text and
muted tools. Small lavender/teal/blue/amber identity accents use the four
`--ds-task-*` tokens; semantic failure and diff colors remain. There is no graph
card background or decorative task-entry animation. Existing white/black accent
buttons remain, not a blanket blue skin. Color never substitutes for status text,
focus or error information.

## Compatibility and verification

No protocol, database, provider thinking level, stored transcript, tool payload,
review snapshot, permission, runtime, or Plugin SDK changes. Existing display-mode
and folding settings remain readable, including explicit false opt-outs. Retained
pane disclosure memory remains presentation state, not persisted message data.

Acceptance fixtures are `apps/desktop/test/task-reading-presentation.test.mjs`
(pure helpers plus production-component SSR),
`apps/desktop/test/task-reading-user-path.test.mjs` with
`apps/desktop/test/fixtures/task-reading.jsx` (isolated Electron BrowserWindow,
synthetic messages and a stub Host), and the existing
`apps/desktop/test/turn-changes-disclosure-user-path.test.mjs`.

The isolated component fixture passed on Windows with Electron 43.6.0, including
keyboard disclosure/manual persistence, partial changes, task/detail/index
navigation, visible failure, scoped Stop/Retry, shared search reveal and four
localized light/dark layout cases. Pure/SSR regression covers stable task identity
and the latest resumed handle. The base is `0f7552494`, with uncommitted changes.
No daily profile, live provider, full Desktop launch, installation or upgrade was
tested. Build and broader regression results are reported separately. See
[E2E-CHAT-task-first-reading](../spec/06-delivery/e2e/conversation.md#e2e-chat-task-first-reading).

This ADR is the current development record. A release entry follows the requested
release workflow; do not append to the retired unreleased scratchpad or fabricate
entries in the generated release-history changelog.
