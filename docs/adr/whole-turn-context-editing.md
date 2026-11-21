# ADR: Whole-turn model-context editing

## Status

Accepted. Extends the assistant-tail editing amendment in ADR 0023.

## Context

A displayed assistant answer spans intermediate prose, reasoning, tool calls and
results, then a final answer. Editing only the final row cannot clean irrelevant
process text. Replacing durable tool receipts would falsify execution history;
removing call/result halves separately would produce invalid model requests.

## Decision

- The completed, idle local turn offers **Edit context**. Older turns require
  the existing explicit Fork action first. Running, native, remote, imported,
  scheduled or otherwise read-only histories are not editable through this path.
- Rust supplies the canonical current-turn snapshot and its opaque revision.
  Save checks that revision under the Host lock, including turn membership and
  prior overlays. A stale save fails without changing the conversation.
- A versioned optional `meta.contextOverride` stores replacement text/thinking,
  included/excluded channels, or context-only tool arguments/result text. Source
  blocks, execution status, usage, timestamps and tool IDs stay unchanged.
  Plain-text tool result replacements intentionally replace model-visible media
  as well; an untouched result retains its original structured content. Editor
  snapshots replace recognized image/audio payloads and base64 media data URLs
  with explicit placeholders; ordinary business data and prose are not clipped.
- The editor opens on the final answer. Thinking, intermediate text and tool
  pairs are available in a collapsed process section; preview keeps replay order.
  Every block can be edited or excluded; tool calls/results form one include
  unit. The final answer may be explicitly excluded; if included, its effective
  text must be nonblank. Actions to exclude all thinking or retain only the
  final answer modify the draft, not storage.
  A preview and count summary show the proposed current-turn context. Original
  values remain inspectable; row reset and whole-turn reset restore originals.
- After a confirmed edit, the chat bubble shows the saved final-answer text by
  default, including after reload. The original remains available on demand.
  Explicit exclusion is labeled as not sent to the model, not silently hidden
  or mistaken for deletion. Tool rows always show actual execution receipts;
  edited tool inputs and outputs belong only in the context editor/preview.
- Main reuses the session-operation lock, strict persistence drain, rewrite fence
  and acknowledged runtime disposal before saving. Host atomically splices all
  overlays and invalidates compactions covering the earliest change and their
  dependent chain. No model/tool is invoked by an edit.
- Model history projection applies overrides on rebuild. An excluded tool row
  contributes neither a call nor its result. Empty assistant carriers remain
  available for surviving tools. Modified channels do not reuse their old
  provider signatures. User-edited thinking is labeled ordinary assistant text
  rather than impersonating signed provider reasoning.
- Context reads and writes are capped at 8 MiB and 1024 rows. Oversized data is
  rejected rather than partially loaded and silently truncated. Both errors and
  stale-session completions leave drafts and unrelated panes intact.

## Compatibility and consequences

This is additive metadata in the existing open JSONL record format; no SQLite
schema change or destructive migration is necessary. Missing metadata preserves
all existing behavior. Forks and revision snapshots retain overlays. Downgrading
to an older runtime may ignore them, so this is neither redaction nor secure
removal. Existing final-answer APIs remain available for legacy callers, but
must not overwrite a turn with active context overlays. Earlier final-answer
edits made before this feature cannot recover text they already replaced.

Source-of-truth and process ownership stay unchanged. Tools already executed
are not undone. Removing their evidence can cause a model to repeat work; the
editor warns about that limitation without pretending to guarantee no replay.

## Verification

Use synthetic multi-call turns containing prior-turn history, three assistant
stages, thinking-only rows, paired tools and compactions. Verify stale rejection,
role/identity guards, atomic failure, fork/restart, reversible reset, raw-record
preservation and the actual next provider request. Renderer tests cover middle
block edits, preview, both shortcuts, cancel/error recovery, narrow layout and
session-switch races. No live profile or paid provider is a default fixture.
