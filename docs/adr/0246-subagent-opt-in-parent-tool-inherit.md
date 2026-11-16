# ADR 0246: Opt-in subagent inheritance of the parent tool catalog

- Status: Accepted
- Date: 2026-09-14
- Related: ADR 0062, ADR 0089, ADR 0100, D201, D415, issue #215, PR #319

## Context

ADR 0062 made a subagent a bounded worker limited to
`SUBAGENT_ASSIGNABLE_TOOLS`, deliberately excluding plugin tools, `Skill`,
`ToolSearch`, mode tools, and `Task`. Permission mode and the model pin already
follow the parent, but tool capability did not, so a parent holding `Skill`, MCP,
or plugin tools could not share them with a worker it spawned, and always
inheriting would make every delegation as dangerous as the session.

## Decision

1. Frontmatter may opt a definition in with `tools: inherit` or
   `tools: [inherit, Bash]`. `inherit` sets `SubagentDefinition.inheritTools`, any
   extra name must still be assignable, and builtins do not opt in.
2. At `Task` spawn, `resolveSubagentToolNames` unions the session runtime's live
   `toolCatalog` keys, including deferred plugin and MCP tools, with declared
   extras and drops `SUBAGENT_INHERIT_DENY_TOOLS`: `Task`, `TaskWait`, `TaskList`,
   and `TaskStop` (no nested fan-out), `EnterPlanMode` and `EnterGoalMode` (mode
   stays the parent's), `asktool` (a delegate has no user), `new_context`
   (compaction is a parent flag), and `ToolSearch` (it activates tools on the
   parent catalog). The child receives the allowed catalog without `ToolSearch`,
   and inherit is deliberately stronger than the parent's first-request set.
3. Spawn-time names drive the delegate tool list, mutation framing,
   search/edit/Bash guidance, and, when `Skill` is present, the same `# Skills`
   catalog the parent received; the Task catalog prints `inherit` plus extras
   instead of listing every MCP name.
4. host-core's user-subagent scanner keeps the `inherit` token in `tools` so a
   `tools: inherit`-only definition still appears in `agents.active` and
   round-trips through Settings without the editor stripping it.
5. Documents that omit `tools` stay read-only (`Read, Glob, Grep`), and `tools:
   "*"` still means the assignable tools rather than the session catalog.

This amends ADR 0062 §2 and its rejected "let delegates inherit the parent's
tools" alternative: inherit is now an explicit document opt-in with a deny list.

## Consequences

- A user-owned worker can call Skill, MCP, and plugin tools the parent already
  had, without turning builtins into nested agents.
- Inheriting Bash, Edit, or Write inherits mutation; permission mode and the
  external-path gate are unchanged.
- The grant stays readable in Markdown and Settings, and a child cannot mutate
  parent runtime state through `ToolSearch` or `new_context`.

## Alternatives

- **Always inherit for user agents, never for builtins.** Rejected as a hidden
  default. Markdown opt-in is the same shape as `permission: inherit`.
- **Inherit only currently active tools.** Rejected because MCP/plugin tools
  are deferred behind `ToolSearch`; a worker would still lack the catalog the
  issue asked for, and inheriting `ToolSearch` would activate tools on the
  parent.
- **Add `Skill` to `SUBAGENT_ASSIGNABLE_TOOLS` only.** Rejected: no MCP/plugin
  tools, still a second catalog.

## Amendment — 2026-11-12: Skill loading without broad tool inheritance

Fixed-tool delegates can be instructed to load a skill by project rules while
having neither the `Skill` tool nor its catalog. Searching guessed filesystem
paths is not an equivalent loader and can select the wrong skill document.

At spawn, definitions receive `Skill` once when it exists in the parent's live
catalog and the role has at least one available skill (selection below). For
definitions without a selection, this includes all builtins and non-inheriting
user definitions. The resolved-tool guidance supplies the matching skill index;
bodies load on demand through the session-owned Host bridge. An empty effective
catalog supplies neither the tool nor the index. Host activation, project
scoping, permission checks and error attribution remain authoritative.

This is the only implicit addition to fixed tool lists. Plugin/MCP tools,
mutation tools and parent control tools do not follow it. `tools: inherit`
retains its explicit broader meaning and deny list; `Skill` remains outside
the assignable frontmatter names, so existing documents need no migration.
Read-only delegates remain read-only. Skill instructions do not grant the
tools or permissions they describe.

This amends decisions 1 and 5 above for instruction loading only. Making every
builtin inherit the full catalog was rejected because it would unnecessarily
grant executable plugin/MCP capabilities. Requiring parents to copy bodies or
guess paths was rejected because it bypasses the current skill lookup contract.

## Amendment — 2026-11-13: Optional role-level skill selection

`SubagentDefinition` and the Host-owned user record add optional `skills: string[]`.
Omitting frontmatter `skills` preserves inherit-all behavior. An inline/comma or
block list restricts the child to those exact IDs intersected with the parent's
available catalog; `skills: []` deliberately disables skill loading. IDs are
trimmed and deduplicated in order, limited to 256 entries and 256 ASCII characters
per ID (`[A-Za-z0-9][A-Za-z0-9._:/-]*`). Malformed selections are rejected rather
than widened to inherit-all. Unknown IDs remain saved but inert unless present in
the parent catalog on a later spawn.

The direct child system prompt lists only the effective selection. The scoped
`Skill` executor rejects non-selected or no-longer-parent-available IDs before
calling the existing Host loader; Host activation and permission checks still
apply. `tools: inherit` cannot reintroduce `Skill` for an empty effective selection.
Executable plugin/MCP inheritance and the existing parent-control deny list are
unchanged. This is instruction allocation, not a sandbox against reading files
with separately granted filesystem tools.

Settings → Subagents → Roles exposes inherit-all (default) and zero-or-more skill
selection using the existing workspace-scoped composer command source and shared
settings primitives. Saved unavailable IDs stay visible and removable; catalog
load failures do not clear them. The source is a workspace preview, not a grant:
the parent runtime's available catalog remains authoritative at spawn.

The existing create/update RPC input adds `skills?: string[] | null`: omission
preserves a selection on update; `null` removes it and restores inherit-all; `[]`
saves an explicit empty list. Records omit `skills` for inherit-all and retain
empty arrays. Storage remains additive Markdown frontmatter, with no SQLite,
protocol-version or migration change; existing documents require no rewrite.
Older builds ignore the new field and cannot enforce it, so downgrade is not a
way to preserve the restriction.
