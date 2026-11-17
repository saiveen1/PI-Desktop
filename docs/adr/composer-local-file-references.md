# ADR: Pasted local files are live references

- Status: Accepted
- Date: 2026-11-13
- Related: composer-pasted-directory-references, issue #2314

## Context

Copying disk-backed clipboard files into session scratch eagerly allocates and transfers
their full contents, and the transfer bound prevents attaching a large file even when the
task needs only a bounded read.

## Decision

Native clipboard files use the existing sender-bound, one-shot selection token to register
live references in the owning local project: Main creates a UUID record under
`<data_dir>/composer-file-references/` holding only the canonical path, project path, and
originating session id, with no file bytes and no tool access. Drafts, queued input, and
messages carry the additive `localReference` id and byte size shown as name and size, and on
dispatch Main revalidates the record and project, rejects a changed or unavailable target,
and refreshes the size before the agent receives path and size as context to read through
normal tool permissions, requesting referenced images through its Read path. Input history
restores references without reads or snapshots, screenshots and generated payloads keep the
existing scratch materialization, and records without `localReference` are unchanged.

## Consequences

- Transfer byte limits still protect actual transfers, while native references keep the
  20-item selection limit and the attachment-root validator.
- A restored reference observes current file contents and can become unavailable after
  deletion, movement, or project relocation; there is no snapshot and no implicit upload.

## Alternatives

- Keep eager scratch materialization: the transfer bound still refuses large files.

## Amendment: automatic native file intake

Composer now requests `reference: "auto"` for native clipboard selections,
file-picker selections and disk-backed browser File objects. In a local project,
Main classifies canonical paths once: ordinary files (including SVG source) use
the existing metadata reference records; raster images retain the bounded image
copy/vision flow. There is no user-facing reference/upload choice or size threshold
for ordinary files. Without a local project, or in a remote workspace, automatic
intake preserves the existing bounded copy behavior rather than presenting a local
path as remotely readable. Explicit legacy `true`/`false` requests retain their
original semantics, including metadata-only images for explicit `true`.

The private `pi-desktop/composer/nativeFileSelection` channel is not exposed by
the generic IPC whitelist or MCP. Its only renderer bridge takes File objects;
preload resolves them with Electron webUtils, rejects generated/forged inputs,
and registers native paths with Main. Main validates the sender and bounded
absolute-path list, then issues the existing sender-bound, expiring one-shot
selection token. It neither grants tool access nor accepts renderer path strings
through the public bridge. Native clipboard metadata remains the fallback for
OS items that Chromium does not expose. Generated files still use byte transfer.

Picker/drop cards preserve `localReference` and size through drafts, queues and
dispatch. All three entry points rebase pending insertions onto newer source
edits and discard results for removed sessions. A pending picker captures its
source draft before opening the dialog; navigating away from a home draft cannot
create a session in a different project.
Actual byte-transfer bounds and the overall 20-file selection bound stay intact.
