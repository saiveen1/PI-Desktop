# Responses terminal-content loss: diagnosis and recovery playbook

## Incident and evidence boundary

On 2026-11-18 (UTC+08:00), a user reported that assistant answers and thinking
appeared while streaming and then disappeared, alongside repeated
`TOOL_CALL_NOT_EXECUTED` diagnostics containing DSML parameter/closing-tag
fragments. Investigation was read-only: no provider request was replayed, no
live session was interrupted, and no installed runtime or provider settings
were changed. Private session IDs, endpoints, task text, credentials, and raw
provider replay material are deliberately omitted from this public record.

The affected binding used OpenAI Responses. Several durable assistant records
contained exactly one whitespace character of thinking. Their saved reasoning
signatures decoded to completed provider reasoning items whose `summary_text`
also contained exactly one whitespace character. The installed parser captures
that signature from `response.output_item.done.item`; this is evidence of the
endpoint's terminal representation, not just a renderer visibility decision.

The installed parser replaced accumulated reasoning with that truthy whitespace
summary. It also unconditionally replaced accumulated answer text with the final
message item's content, including empty content. Runtime settlement accepted
these present final channels and emitted a replacement `message_end` snapshot.
The renderer and durable transcript consequently received the shortened values.

A network-free reproduction directly exercised the installed parser:

| Synthetic terminal representation | Streamed/final thinking | Streamed/final answer |
| --- | --- | --- |
| Complete, consistent terminal | 58 / 58 characters | 55 / 55 characters |
| Whitespace reasoning, empty answer | 58 / 1 characters | 55 / 0 characters |
| Whitespace reasoning, DSML tail only | 58 / 1 characters | Answer replaced by the 103-character tail |

These are synthetic counts, not estimates of lost user content. The incident's
whitespace reasoning terminal is directly evidenced. The original pre-terminal
answer deltas were not retained in the inspected files, so the precise lost
answer and the server-side component producing inconsistent items remain
unproven. The diagnosis does not claim that Sub2API, a model, or an upstream
conversion layer was independently proven to originate every malformed field.

Separately, DSML diagnostics may annotate a response that also contains valid
structured tools. Successful tool completion records prove those tools ran;
"no action was executed from this text" must not be interpreted as "nothing in
this turn ran." Tool exit code zero does not establish success of every nested
business operation. Never replay an already successful action to restore text.

## Repeatable read-only investigation

1. Confirm the exact session/turn and the known data root. Inspect only that
   session's tail, inflight checkpoint, relevant revision window, and correlated
   completion logs. Do not dump conversations or complete `meta` objects.
2. Extract allowlisted metadata: message/call IDs, event/status/stop reason,
   timestamps, text/thinking lengths, whitespace-only flags, reset flags,
   recovery counters, and tool completion/exit status. Keep diagnostic artifacts
   in session scratch, not the repository or live data directory.
3. Distinguish three cases before blaming the UI:
   - Stored content remains intact: inspect process disclosure, Show thinking,
     and renderer grouping.
   - The same message shrinks during retry: inspect same-ID bubble reuse and
     stream reset events.
   - The message shrinks at settlement: compare cumulative provider content
     against final `output_item.done`, `message_end`, and persisted lengths.
4. Inspect the actual provider API style, not the model's name or an endpoint
   mentioned inside a tool command. Read only the necessary connection metadata;
   never print keys, secrets, cookies, or complete provider configuration.
5. Before asking the user for packet captures, check existing evidence. A
   Responses thinking signature may contain the final reasoning item. Parse it
   locally and emit only its type/status, summary/content lengths, whitespace
   flags, and encrypted-content presence. Never print opaque signatures or
   reasoning text; do not attempt to decrypt encrypted provider material.
6. Compare the executing installation with source. Locate the executable using
   read-only process metadata; inspect bounded parser snippets and active call
   sites, not giant minified lines. Source alone does not prove installed behavior.
7. Reproduce using synthetic SSE and the real provider adapter with a fake fetch.
   Assert intermediate deltas, end events, final messages, replay metadata,
   stop reason, usage, and legitimate sibling tools. No paid/model network call,
   server restart, or live-profile write is required to prove this overwrite.
8. State observed facts, offline reproductions, and remaining attribution limits
   separately. Stop once the root cause and fix boundary are established. A
   cleared inflight checkpoint does not recover previously overwritten text.

## Ordinary turns: diagnose layout separately

A provider compatibility change must not change which rows a turn disclosure
owns. Commit `afa278182` kept every intermediate message visible when the process
was closed and hid only activity rows. Its condition tested for *any message*,
not a DSML fragment. Consequently even an ordinary turn without one protocol tag
showed a wall of progress paragraphs while its tool rows remained hidden. The
regression tests for that change incorrectly treated this layout as success.

Restore the original shared disclosure: intermediate prose and tools fold
and expand together; the final answer stays outside. Only the message bubble
recognizes an orphan DSML tail. Keep terminal-content reconciliation in the
Responses adapter and leave file-change summaries tied to actual review records.
Test plain and malformed input against the **same** fold/order assertions,
including live-to-settled, reopen and reclose. The only expected difference
is an inert, initially collapsed protocol disclosure on the affected message.

## Repair contract

The narrow compatibility repair belongs in the existing pi-ai Responses patch,
shared by the Responses adapters, rather than a renderer workaround:

- A blank final summary must not replace meaningful streamed thinking; a
  meaningful final reasoning content field remains a valid fallback.
- An empty, omitted, or whitespace-only terminal answer must not erase meaningful
  accumulated answer text from the same output item.
- An orphan DSML terminal tail may preserve an already streamed full answer only
  when it is an exact suffix of that answer. Retain the original tail and diagnostic;
  do not turn markup into executable tools or invent text. The transcript folds
  recognizable trailing fragments into protocol details. Expand the disclosure
  to inspect the exact text; use structured tool records, not markup, to check
  execution. This display rule also applies to short parameter-plus-`calls` tails
  that did not trigger a runtime diagnostic.
- Other nonempty final replacements, including shorter corrected answers, remain
  authoritative. Explicit refusals remain authoritative, including blank refusals.
  This is not a global "longest string wins" policy.
- Preserve item isolation, provider signatures, structured tool arguments and
  ordering, usage, stop/error/cancellation semantics, and original permissions.
- Existing lost content is not retroactively restored. Installing a future build
  is a separate user action; a source fix does not change a running installation.

## Implementation and verification references

- Adapter regression: `packages/agent-runtime/src/responses-terminal-content.test.ts`.
- Runtime user path: `packages/agent-runtime/src/responses-terminal-content-runtime.test.ts`.
- Patch: `patches/@earendil-works__pi-ai@1.5.0.patch`.
- Final projection: `packages/agent-runtime/src/runtime.ts` (`nextText`,
  `nextThinking`, and `message_end`).
- Transcript presentation: `node --test apps/desktop/test/dsml-protocol-tail.test.mjs apps/desktop/test/dsml-transcript-rendering.test.mjs`.
  With the existing built renderer assets, `node scripts/e2e-transcript-render.mjs --protocol-details`
  checks native expand, dismiss and collapse in an isolated Electron fixture.
- Diagnostic: `packages/agent-runtime/src/text-tool-call.ts`.
- Optional local operator entry: `.agents/skills/pi-desktop-live-turn-diagnosis/SKILL.md`.
  That machine-local skill directory is ignored by Git; the repeatable procedure
  above is the portable, committed source of truth.

The pre-fix overwrite was reproduced against pi-ai 1.5.0 and the installed
personal-edition bundle. The named upstream Desktop reference
`047c4eab1c97a349b3cf8c734229b64ed9d87764` carries the existing Responses patch but
no terminal-content preservation rule; this repair is a local increment, not an
attribution of the upstream provider transport or streaming system to this fork.

## Delivered validation

- Pre-fix adapter baseline: 11 failures / 9 passes; the two runtime user-path
  regressions also failed with empty/tail-only answers and whitespace thinking.
- The bounded review found a final-closing-tag-only suffix case. Its new regression
  failed before that edge was repaired; the exact-suffix/refusal guards remain.
- Final targeted run: eight files, 107 cases passed, including 22 new adapter
  cases and two new runtime cases. Existing replay, stream-field, stream-terminal,
  text-tool diagnostic, and tool-recovery suites were included.
- `pnpm --filter @pi-desktop/agent-runtime typecheck` and `bundle` passed.
- `pnpm check:pi-patches`, `pnpm check:pi-dependencies`, and
  `pnpm check:agent-policy` passed; `git diff --check` and six diagnosis links passed.
- The repository's normal Biome includes do not cover these runtime files. A
  scratch-only configuration with the same lint rule checked the three new TS
  files successfully; the repository lint scope was not changed.
- Dependency patches were generated by `pnpm patch` / `pnpm patch-commit`; the
  lockfile changes only the pi-ai patch hash. No package versions were upgraded.
- Full-workspace tests, Electron UI checks, real-provider calls, installer builds,
  installation, and historical-content recovery were NOT RUN. No installed files
  or live profile were modified by the repair. Runtime tests use synthetic data
  and a loopback HTTP fixture with mocked Host execution.

The first typecheck caught two fixture typing issues, which were corrected;
only the final successful run is reported as passing. The ordinary ignored-path
Biome invocation is not counted as validation.
