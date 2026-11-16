# ADR 0246: Opt-in subagent inheritance of the parent tool catalog

- Status: Accepted
- Date: 2026-09-14
- Deciders: PI-Desktop core
- Related: ADR 0062, ADR 0089, ADR 0100, D201, D415, issue #215, PR #319

## Context

ADR 0062 made a subagent a bounded worker: it could only receive tools from
`SUBAGENT_ASSIGNABLE_TOOLS` (Read, Glob, Grep, BrowserPreview, Bash, Edit,
Write). Plugin tools, `Skill`, `ToolSearch`, mode tools, and `Task` were out of
reach on purpose so a definition remained the place a reader could see what a
delegate may do.

Permission mode (`permission: inherit`) and the session model (empty `model`
pin) already follow the parent. Tool capability did not. A parent that had
loaded `Skill`, MCP, or plugin tools could not give any of that to a worker it
just spawned. Builtins that stay on today's whitelist (explorer, code-reviewer)
are still the right default; user-defined workers that *should* share the
parent catalog had no opt-in.

Always inheriting would make every delegation as dangerous as the session.
Putting `Skill` alone on the assignable list would still leave MCP and plugin
tools as a second catalog.

## Decision

1. Frontmatter may opt a definition into parent-tool inheritance:

   ```yaml
   tools: inherit
   # or
   tools: [inherit, Bash]
   ```

   `inherit` sets `SubagentDefinition.inheritTools`. Extra names still have to
   be on `SUBAGENT_ASSIGNABLE_TOOLS`. Builtins do not opt in.

2. At `Task` spawn, `resolveSubagentToolNames` unions the session runtime's
   **live `toolCatalog` keys** (including deferred plugin/MCP tools the parent
   is allowed to call) with any declared extras, then drops
   `SUBAGENT_INHERIT_DENY_TOOLS`:

   | Never inherited | Why |
   |---|---|
   | `Task` / `TaskWait` / `TaskList` / `TaskStop` | no nested fan-out |
   | `EnterPlanMode` / `EnterGoalMode` | mode stays the parent's |
   | `asktool` | a delegate has no user |
   | `new_context` | compaction is a parent-runtime flag |
   | `ToolSearch` | activates deferred tools on the parent catalog |

   The child receives the full allowed catalog without `ToolSearch`. Inherit
   is stronger than the parent's first-request active set; that is the point
   of handing Skill/MCP/plugin tools to a worker.

3. Spawn-time resolved names drive the delegate tool list, mutation framing,
   search/edit/Bash guidance, and — when `Skill` is present — the same
   `# Skills` catalog the parent already received. The Task catalog prints
   `inherit` (plus extras) rather than dumping every MCP name.

4. host-core's user-subagent scanner keeps the `inherit` token in `tools` so
   `tools: inherit` alone still appears in `agents.active` and round-trips
   through Settings. The editor exposes an inherit checkbox; saving must not
   strip the token.

5. Default documents that omit `tools` stay read-only (`Read, Glob, Grep`).
   `tools: "*"` still means the seven assignable tools, not the session
   catalog. A session cannot lend mutation to a read-only delegate unless that
   definition opted into inherit.

This amends ADR 0062 §2 and the rejected alternative "Let delegates inherit
the parent's tools": inherit is now an explicit document opt-in with a deny
list, not silent session equality.

## Consequences

- A user-owned worker can call Skill/MCP/plugin tools the parent already had,
  without turning explorer into a nested Agent.
- Inherit of Bash/Edit/Write is inheriting mutation. Permission mode and the
  external-path gate are unchanged; `permission: inherit` still follows the
  session.
- Definitions remain the readable grant: `tools: inherit` is visible in the
  Markdown and in Settings.
- Child `ToolSearch` / `new_context` cannot mutate parent runtime state.

## Alternatives considered

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
