# ADR 0062: Bounded Subagents Behind a Task Tool

- Status: Accepted for implementation (definition roots amended by ADR 0112;
  timeout policy amended by ADR 0119; delegation presentation amended by D265;
  opt-in parent-tool inherit amended by ADR 0246; resumable delegations amended
  by ADR 0279; report spillover amended by RFC #1196)
- Date: 2026-08-06
- Related: ADR 0041, ADR 0048, ADR 0053, ADR 0112, ADR 0119, ADR 0246,
  ADR 0279, D123, D138, D198, D201, D265

> **Renderer presentation superseded on 2026-11-08:**
> [Task-first transcript presentation](task-first-transcript-presentation.md)
> replaces §6's delegation cards/coordinator topology and live-open disclosure
> with Active / Needs attention / Completed task lists and source-session detail
> tabs. Only Task starts become entries; lifecycle rows remain named compact
> tools. Runtime limits, attribution, report-only parent context, lifecycle
> precedence, permission queues, and capability gates are not changed by this
> presentation decision. Historical card/graph language below is not the current
> UI contract; see component spec §§5.7 and 9.9.

## Context

A single agent loop pays for everything it reads: wide searches, long build logs,
and multi-file surveys land in the session context and stay there for the rest of
the task, and compaction can only recover space afterwards. Delegation runs the
separable piece in its own context and returns a report, so the open questions
are the boundaries: where definitions come from, what a delegate may do to the
workspace, how its rows relate to the parent, and what happens when several
delegates need the user at once.

## Decision

### 1. Definitions are Markdown documents, builtin plus global user documents

A definition is frontmatter plus a Markdown body used as the delegate's system
prompt (D123), stored at `~/.agents/subagents/<name>.md`. The original three
builtins (`explorer`, `code-reviewer`, `test-runner`; expanded by ADR 0089) merge
with the global user catalog by name on each launch. There is no project-level
definition source. Malformed documents yield diagnostics without losing the turn.

The 2026-11-12 capacity amendment replaces the fixed 16-definition cap with
`AppSettings.delegation.limits.maxDefinitions` (1–128, default 16), exposed in
Subagents → Scheduling. User precedence, unique names and dropped-name diagnostics
remain; files are never deleted. Omitted settings preserve the default.

Frontmatter includes `name`, `description`, `tools`, `model`, `thinkingLevel`,
permission and output limits. Historical `maxTurns`, `idle-timeout` and
`max-duration` no longer impose hidden lifetime limits; ADR 0253 and ADR 0279's
Scheduling policy supersede them. ADR 0246 adds optional role-level `skills`.

### 2. A definition declares its tools, and is read-only when it does not

`tools` names `SUBAGENT_ASSIGNABLE_TOOLS` (file, search and shell tools).
Omitting it grants `Read, Glob, Grep`; `tools: "*"` expands only that set.
ADR 0246 adds explicit parent-catalog inheritance and a separately scoped Skill
loader: omitted `skills` inherits available skills, a list restricts them, and
`skills: []` supplies neither loader nor catalog. Skill instructions do not grant
execution permissions. Calls use `tools.execute`; a delegate cannot submit a
plan, change mode, or nest `Task`.


### 3. A definition may pin its own provider and model

`model: <provider>/<model>` binds a delegate regardless of the session model,
resolved once per launch in Electron main and capped at
`MAX_SUBAGENT_PROVIDERS` distinct providers, matching on id, vendor key, or
display name. An unresolvable pin is left out of the binding map and the `Task`
call fails with a tool error naming it, so a cheap definition never silently
spends the expensive model.

### 4. Delegation is one Agent-mode tool, and parallel by construction

`Task` takes `agent`, `task`, and an optional `description`, carries its
delegate catalog in the tool description, and executes only in Agent mode, where
Plan and Goal keep their Task-family schemas declared but deny execution before
a delegate exists (D198). Concurrency comes from pi's execution modes, so only
an all-`Task` batch fans out, bounded by `MAX_SUBAGENT_CONCURRENCY`, with a
sidecar `PathMutex` serializing same-path mutations and the parent's bounded
retry policy applied to every delegate.

### 5. The parent's context gains the report, and only the report

The delegate's final message becomes the `Task` result, capped at
`MAX_SUBAGENT_REPORT_CHARS`, with `agent`, `status`, `turns`, `toolCalls`, and
`usage` as details; an oversized report is preserved under the session scratch
`delegations/<parentToolCallId>/report.md` and returned as a pointer notice.
Delegate rows persist with `parentToolCallId` and `agentName` for review but are
skipped when model context is rebuilt, so only the report reaches the parent and
a delegate's termination collapses into the tool result.

### 6. Attribution is persisted, and the transcript derives its topology from it

> The attribution/model-context invariants below still apply. The card, inline
> nesting, and topology presentation is historical; the task-first ADR replaces
> it with grouped task rows and full child transcripts in work-panel tabs.

host-core stores `parentToolCallId` and `agentName` in the message `meta`
object, so a reloaded session nests exactly like a live one, with attributed
rows rendered one level in under the spawning `Task` row while the turn stream
and minimap see only parent rows. Every `Task` call draws as a delegation
summary (D265) whose header derives counts and status from those tool messages,
and live and reloaded views derive the same topology from the persisted ids
without adding a graph record, edge, IPC field, or storage schema.

### 7. Permission requests queue per session

Pending requests become a per-session queue, oldest first, where only the head is
answerable, answers match by request id, a host-expired request is removed by
tool call id, and an abort denies the whole queue. The card names the delegate
that asked and how many requests wait behind it.

## Consequences

- Wide searches, reviews, and command runs leave the session context at the price
  of one report each, and a user can add a delegate under `~/.agents/subagents`
  without a rebuild.
- Two capability surfaces exist for the same tools: a delegate can be strictly
  weaker than its session, never stronger.
- Delegate rows lengthen transcripts on disk but stay collapsed and out of model
  context, while review and rollback still see them.

## Alternatives considered

- Serial delegates in v1: rejected; fanning out a survey is most of the value,
  and retrofitting concurrency would redo the transcript and permission work.
- Feed delegate messages back into the parent's context: rejected; that is
  exactly the cost delegation removes.
