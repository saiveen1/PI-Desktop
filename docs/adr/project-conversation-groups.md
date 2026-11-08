# ADR: Project conversation groups and display-only labels

- Status: Accepted, implementation candidate
- Date: 2026-11-08
- Amends: [Session organization](session-organization-and-scoped-delegation.md)
  and [logical projects](0249-chatgpt-style-logical-project-groups.md)

## Context

Projecting every label as a sidebar container repeats conversations with multiple
labels. Users need exclusive placement independently from descriptive marks.
Multi-root projects must share organization without rebinding conversations.

## Decision

Keep organization in renderer-local sidebar preferences, with an additive
version-1 organization record. Each project scope owns ordered groups and a label
catalog. A conversation has at most one group ID; unknown or deleted groups
render under Ungrouped. Moving changes placement only. Deleting a group clears
membership, never conversations. Labels remain multi-valued descriptive chips,
not headings or filters. Catalog editing is reached through Manage, separately
from project folder editing and global Conversation settings.

Logical projects use their stable Host group ID across root/primary changes;
legacy path projects, standalone sessions and remote Host/project identities
have separate scopes. Existing global labels and their associations remain
readable as the fallback catalog until a scope is edited. No label-to-group
assignment is guessed. Per-project catalog edits do not mutate other scopes.

A project title exposes a compact folder-count popover for multiple roots;
folders do not become conversation containers. The primary root is first and
remaining roots retain Host order. Color selection accepts legacy semantic
colors and validated hexadecimal RGB colors, with presets and a custom picker.

## Consequences

Host SQLite, session bindings, execution roots, permissions, IPC/RPC and plugin
contracts do not change. Clearing renderer preferences removes organization,
not conversations. Old profiles require no database migration; new metadata is
additive and old label fields are retained for compatibility. Existing labels
are not silently converted, so old conversations initially remain ungrouped.
