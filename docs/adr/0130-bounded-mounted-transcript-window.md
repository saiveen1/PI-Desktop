# ADR 0130: Bounded Mounted Transcript Window

- Status: Accepted
- Date: 2026-08-27
- Related: ADR 0120, ADR 0127, D108, D247, D258, D261, D269, E2E-159
- Amended by: D269, clarified below for demand-driven history continuation

## Context

ADR 0120 bounded the transcript payload crossing IPC and ADR 0127 / D258 bounded
locating a page inside the JSONL file, but neither bounded what the renderer
keeps mounted afterwards: every paged-in row stayed mounted for the session with
its React tree, Markdown AST, Shiki token arrays, and DOM. `content-visibility`
already skips layout and paint for far-offscreen rows, which is a CPU saving and
explicitly not a memory one, and the per-frame memo comparator walked every
mounted entry on each streamed token.

## Decision

### 1. The mounted history is a trailing window

`reduceTranscriptWindow` slices the loaded history per render, using
`TRANSCRIPT_INITIAL_MOUNT` rows for the first commit after a session switch and
`TRANSCRIPT_WINDOW_MIN` in steady state.

### 2. User demand escalates in two stages

`growTranscriptWindow` adds cached rows in `TRANSCRIPT_WINDOW_STEP` increments
while the window is partial, and only a window covering all loaded history calls
`onLoadOlder`, because mounting loaded rows is cheaper than an IPC round trip.
A real upward scroll may prefetch; the top **Show earlier messages** button and
minimap continuation explicitly advance one bounded step. A fetched page must
become reachable in that same action, not remain entirely outside the window.

### 3. Growth and fetched pages share one pre-paint anchor

Window growth and a fetched page both restore the visible message's viewport
offset before paint, preferring a message node over an answer-group marker, and
the anchor is owned through IO and three stable layout frames without ever owning
user input. This replaces the old `prependHeightRef` total-height delta, which
deferred DOM, tail updates, and intrinsic-size estimates made unreliable.

### 4. The window belongs to the pane and shrinks at the live tail

A saved reading position can restore a grown window. A settled return to latest
or a new live turn restores the trailing render budget without deleting history.
At latest, keep at most 200 contiguous older messages as a quick-revisit cache;
release larger reading ranges and reuse the canonical tail cursor on the next read.

### 5. The hydration spacer is scoped to the first commit

Kept in steady state it would put a blank viewport between the user and the
growth trigger.

### 6. Minimap message dashes come from mounted entries

Dashes are built from `transcriptEntryMessages`, and a click resolves the
marker's `data-minimap-id` node inside the scroller, so markers for withheld rows
would render dashes that jump nowhere.

### 6a. Withheld history is represented explicitly (amended by D269)

While `hiddenAbove > 0` or the host reports `hasMoreBefore`, the rail shows one
dotted earlier-history continuation that runs the two-stage escalation of clause
2, and D108's two-marker-plus-overflow rule resumes once no earlier history
remains.

### 6b. Boundary visibility is not user demand (clarifies D269)

An underfilled page or a visible top boundary alone must not advance history.
Opening, revealing, restoring a reading position or bookmark, and layout changes
must not extend older history. An observer may support an active user-initiated
operation, but cannot autonomously repeat growth or requests while stationary.

Upward input blocked at the physical edge while a step is active can request one
more step after it settles successfully, if the viewport is still near the edge.
No continuation survives a direction reversal, a cancelled hold or an empty or
failed read.

### 7. The entry projection arrays are memoized on `entries`

An unchanged message list then hands `TranscriptHistory` a reference-equal array
whose comparator bails on identity instead of walking the mounted rows.

No IPC, storage, host protocol, or pagination change; the
`SESSION_TRANSCRIPT_PAGE_SIZE` and `session.get` window contract are untouched.

## Consequences

- Initial mounting is bounded and expands as the reader moves backward, but this
  is not a ceiling on retained transcript data or addressable row shells.
- Upward travel costs one frame per growth step before pagination resumes, with
  no extra IPC.
- Native find-in-page reaches only mounted rows; in-app search over the full
  transcript is unaffected.

## Alternatives considered

- Rely on `content-visibility` alone: rejected; it retains every row's React
  tree, Markdown AST, and token arrays, so it cannot bound the resource the
  low-memory report was about.
- Full virtualization with measured row offsets: rejected; content-dependent
  heights that change after mount would need a height cache and invalidation for
  all of it.
