import { readTranscriptSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/*
 * A run row's head is the only place its command appears (D226): the body holds
 * output alone, so the head carries the copy affordance and the outcome beside
 * the caret. Those three controls live in markup and CSS, where nothing else
 * would notice them drifting apart.
 */

const transcript = await readTranscriptSource();
const styles = await readFile(
  new URL("../src/styles/messages.css", import.meta.url),
  "utf8",
);
const details = await readFile(
  new URL("../src/components/ToolDetails.tsx", import.meta.url),
  "utf8",
);

test("only a run row outside the topology gets the three-control head", () => {
  assert.match(
    transcript,
    /const runHead = action === "run" && variant !== "topology"/,
  );
  assert.match(transcript, /runHead \? " is-run" : ""/);
  assert.match(styles, /\.tool-row-head\.is-run \{[^}]*display: flex/);
});

test("the head copies the command, unsqueezed", () => {
  assert.match(transcript, /\{runHead && command \? <ToolCommandCopy command=\{command\} \/> : null\}/);
  assert.match(
    transcript,
    /const command = runHead\s*\?\s*getToolSummaryValue\(message\.toolName, message\.toolArgs\)/,
  );
  assert.match(transcript, /onClick=\{\(\) => copy\(command\)\}/);
  assert.match(styles, /\.tool-row-head-copy \{[^}]*opacity: 0;/);
  // Hidden until hover, so tabbing to it has to bring it back.
  assert.match(styles, /\.tool-row-head-copy:focus-visible,[\s\S]*?opacity: 1;/);
});

test("the caret becomes a pointer target beside the copy control", () => {
  assert.match(transcript, /className="tool-row-caret is-toggle"/);
  assert.match(transcript, /aria-hidden="true"\n\s+tabIndex=\{-1\}/);
  // Its reveal rule followed it out of the header.
  assert.match(styles, /\.tool-row-header:focus-visible ~ \.tool-row-caret,/);
  assert.match(styles, /\.tool-row-caret\.is-toggle \{[^}]*width: 20px/);
});

test("a run row states what the command did, not what the call did", () => {
  assert.match(transcript, /<ToolStatusBadge status=\{toolStatus\} label=\{statusLabel\} runHead=\{runHead\} \/>/);
  // The shared classifier preserves command exit evidence; rendered cases live
  // in tool-status.test.mjs, including skips and explicit interruption.
  assert.match(transcript, /const toolStatus = getToolStatus\(message\)/);
  assert.match(transcript, /status.kind === "running" \? "is-running"/);
  assert.match(transcript, /status.kind === "success" \? "is-done"/);
  assert.match(styles, /\.tool-row-state\.is-done \.tool-row-state-dot \{\s*background: var\(--ds-success\)/);
  assert.match(styles, /\.tool-row-state\.is-error \.tool-row-state-dot \{\s*background: var\(--ds-error\)/);
  // Unknown outcomes never claim success. Visible badges own one announcement;
  // ordinary success/running rows retain the hidden live region.
  assert.match(transcript, /if \(!label\) return null/);
  assert.match(transcript, /<span className="sr-only" role="status" aria-live="polite">\{label\}<\/span>/);
  assert.match(
    styles,
    /\.tool-row-state\.is-running \.tool-row-state-dot \{[^}]*animation: tool-row-state-pulse/,
  );
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.tool-row-state\.is-running \.tool-row-state-dot \{\s*animation: none;/,
  );
});

test("the body is the output, with no card around it", () => {
  assert.match(
    transcript,
    /<ToolDetailBlocks blocks=\{blocks\} plain=\{runHead\} streaming=\{status === "running"\} \/>/,
  );
  // No heading, no frame — but the channel keeps a name, so stderr is not told
  // apart by its tint alone.
  assert.match(details, /plain \? \(\s*\/\/[\s\S]*?<span className="sr-only">\{label\}<\/span>/);
  assert.match(details, /\) : \(\s*<BlockHead label=\{label\} copy=\{blockCopyText\(block\)\} \/>/);
  assert.match(
    styles,
    /\.tool-block\.is-plain \.tool-row-content \{[\s\S]*?border: 0;[\s\S]*?background: transparent;[\s\S]*?padding: 0;/,
  );
  // The cap survives the frame: a long build must not bury the transcript.
  assert.match(styles, /\.tool-row-content \{\s*max-height: 260px/);
});

test("the head fill covers the controls it now holds", () => {
  // The header no longer spans the row, so its own hover fill would stop short
  // of the copy control and the caret.
  assert.match(
    styles,
    /\.tool-row-head\.is-run \.tool-row-header:hover \{\s*background: transparent;/,
  );
  assert.match(
    styles,
    /\.tool-row-head\.is-run:has\(\.tool-row-header:not\(:disabled\)\):hover \{\s*background: var\(--ds-bg-hover\)/,
  );
});
