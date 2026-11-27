# 02. Agent Runtime

Trusted-extension `setThinkingLevel` updates both the runtime's public value and
the Pi Agent state used by subsequent provider requests. Capability clamping
remains authoritative; a reported change must not leave request effort stale.

Consumed steering closes any pre-steering streaming reservation and separates
the next assistant reply, including during provider/overflow/silent/progress
recovery. Recovery stays within the durable turn but never replaces a reply
located before the steering user row (Refs #1699).

On history rebuild, the latest top-level user prompt marked `excludePreviousTurns`
is included; earlier turns are not. Apply the boundary before attachment reads,
delegation recovery, compaction replay, or constructing provider messages. This
does not change trusted runtime instructions. A post-cut checkpoint records
`details.contextBoundaryMessageId`; a checkpoint from a different boundary
cannot supply a summary or retained tail. With no marker, existing unstamped
checkpoints retain their original behavior.

## 1. Goal

Applied decisions: **D002/D003/D008/D158/D189/D190/D193/D194/D278/D378**.


Wrap pi into a product runtime that desktop layers can consume safely.

Core packages:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`

## 2. Runtime placement

Agent loop runs in a **Node/TypeScript pi sidecar**, not in renderer.

```text
packages/agent-runtime/*
apps/desktop/electron/* (supervisor)
crates/host-core (tool execution + permissions)
```

## 3. Core objects

### 3.1 PiRuntime (Node)
- init models/providers
- create Agent
- bind tool bridge
- subscribe/normalize pi events

### 3.2 AgentHostFacade (Electron main)
- session routing
- process supervision
- IPC translation

### 3.3 Host Tool Bridge (Rust)
- receives tool call requests
- applies permission policy
- executes builtin/plugin tools
- returns normalized tool results

The Node runtime normalizes text and image content from host tool results,
including MCP `content` blocks, bare plugin content-block arrays, and Host
`Read` image results. `Read` remains line-windowed for text and also describes
its local PNG/JPEG/GIF/WebP inspection path. The original accepted source bytes
remain in the result details (`images`, MCP `content`, or plugin `blocks`) for
the transcript/UI; binary bytes are never stringified into model text.

Every candidate image is admitted at the shared provider boundary: recognized
PNG/JPEG/GIF/WebP bytes with matching MIME, the 10 MB byte ceiling, the 8000 px
longest-edge ceiling, complete raster decoding, and the selected model's
image-input capability. Photon (the already pinned Rust/WASM decoder) validates
pixels after byte/dimension checks; complete container boundaries also prevent
permissive decoding of a truncated final chunk. Original bytes are never repaired,
re-encoded, or replaced. A process-local cache holds at most 128 MIME/byte SHA-256
digests and verdicts, not image data or decoded pixels, to avoid decoding the same
history on every request. Successful decoder allocations are freed immediately.
The model-visible content retains only admitted image blocks. Invalid or incomplete
images produce `IMAGE_INVALID` and make a live tool result an error; oversized and
text-only-model candidates retain their existing explicit omission behavior.
Restored user/tool history is checked again at the final request projection with
an explicit invalid-image notice, without rewriting or deleting stored content.
No image block with invalid bytes is sent. A result that had candidates records
`details.imageInput: { imageCount, includedCount, issues }`, where each issue
is `{ index, code: "MODEL_NO_VISION" | "IMAGE_TOO_LARGE" | "IMAGE_INVALID", message }`.
`index` is the zero-based candidate order and `includedCount` means prepared for
the model, not that an image was analysed. Restored history uses the same source
normalization, and the final provider projection reapplies the active model's
capability so a text-only replay gives the model the same clear omission notice.
The existing `details.imageCount` remains available as the admitted-image count.
Delegated tools resolve capability from the invoking delegate, including a
fallback model, through an async execution scope rather than the parent model.
Parallel calls cannot inherit another delegate's capability. The final request
projection still checks the active model independently.
Transport contract tests (`tool-image-input.test.ts`) capture actual Responses,
Chat Completions and Anthropic request bodies at a stub fetch boundary. They do
not call a real provider or claim that a model completed image analysis.
Embedded MCP text resources contribute their `resource.text`, and MCP resource
links contribute a one-line `[resource link]` reference, to the model-visible
text alongside sibling text blocks; binary resources are not inlined. When no
text block is available, the JSON fallback likewise keeps image `data` and
resource `blob` bytes out of the model-visible text.

## 4. Runtime API (package-level)

```ts
interface AgentRuntime {
 prompt(input: PromptInput): Promise<{ turnId: string }>
 steer(input: RuntimePrompt, expectedTurnId: string, message: UiMessage): { accepted: boolean; turnId: string }
 requestGracefulStop(): { requested: boolean }
 abort(turnId?: string): Promise<void>
 getStatus(): RuntimeStatus
 dispose(): Promise<void>
 subscribe(handler: (event: NormalizedAgentEvent) => void): () => void
}
```

`requestGracefulStop()` is a one-shot request for the active runtime. The pi
loop evaluates it after `turn_end`, once the current assistant response and
tool batch have completed, and emits a normal `agent_end` before another model
request. It does not cancel an active provider stream or running tool. An idle
runtime returns `{ requested: false }`; immediate `abort()` remains the
separate cancellation path. `abort()` resolves only after the named active
operation has completed its cancellation cleanup, so the same runtime can
accept a follow-up prompt as soon as the abort request returns.
Cancellation remains busy until both the parent operation and all running
delegates have retired. Concurrent aborts join that same cleanup. A parent's
terminal event cannot make a new prompt admissible while a child is still
retiring. Graceful turn-boundary stop remains a separate operation.

On a headless Host, prompt and approved-plan admission share a per-session
operation queue with immediate abort and its durable settlement. An abort
received during launch resolution, turn creation, transcript append, or sidecar
history restoration waits for that admission before canceling its runtime.
The abort intent for an already-active turn is recorded before waiting, so a
racing terminal event cannot report completion instead. A delayed abort keeps
its original turn identity and cannot cancel a later turn. Other sessions can
continue admitting work independently.

### 4.0 Active-turn steering

`steer` validates the current turn identity before changing any state, then
queues user input through pi-agent-core's native steering queue in `all` mode.
The current provider request and any started tool batch finish first; all
accepted input is included at the next model-request boundary within the same
durable turn. A live provider request is not rewritten or aborted. Main owns
attachment validation and transcript persistence as for ordinary prompts.

Queued input retains its renderer message id when pi consumes it, including
when another input arrives before the initial user message has been consumed.
An admission after pi's last queue poll suppresses the terminal event and
continues once pi has released the run, with the same turn identity and without
a second public `agent_start`. Existing context/provider recovery takes
precedence over that continuation. Steering wakes both a parent that is idle
waiting for background delegates and an active `TaskWait`; it does not cancel
those delegates. `TaskWait` returns `details.status: "interrupted"`, includes
the current delegation states, and tells the parent to handle the new user
input before waiting again. The same durable turn and pending reports remain.

Abort, graceful stop, fatal errors and terminal settlement close admission.
Accepted but unconsumed input remains transcript/context history and is removed
from pi's steering queue so it cannot execute independently on a later turn.
An ordinary follow-up stays in the separate Host-owned FIFO until durable turn
finalization. A steering failure must not terminate the active run.

### 4.1 Session title generation

The core keeps new sessions readable without any model call. Sending the first
prompt into a session whose stored title is still a recognized placeholder asks
the host for a deterministic fallback title through `session/deriveTitle`. The
renderer collapses whitespace and caps its request at 48 characters; host-core
accepts it only while the stored title is still a placeholder with the `default`
source, so the fallback never replaces a manual rename or an earlier automatic
title, and the write does not change `updated_at`.

That fallback keeps the source `default`: the derived text is not a user choice,
so the session stays eligible for automatic replacement. An optional standalone
plugin may subscribe to `session:turnEnded`; with the dedicated
`session.autoTitle` permission it can read only the first user prompt and first
assistant reply for a session whose title is still default, then use
`agent.complete` with its configured prompt, model, and thinking level.

The plugin writes through a host compare-and-set that succeeds only while the
exact title it read is still current. Manual renames and another generated
title therefore win concurrent updates. Host-core owns the title source in
schema v23; this state survives renderer restart and does not expose a general
transcript-read API. The core runs no title completion of its own.

### 4.2 Output-token truncation (#2277)

A visible text answer ending with `stopReason: "length"` and no tool calls
retains its original content and records `UiMessage.outputTruncated: true`.
Host-core round-trips the optional flag through transcript record metadata;
legacy messages without the flag remain unchanged. No database migration is needed.
The transcript renders a localized output-token-limit warning below that answer,
including after history restoration. This annotation is not a terminal error,
does not enter model context, and does not automatically retry or continue the
answer. Subsequent prompts remain available. Normal replies, aborts, context
overflow recovery, empty-response recovery, and Pi's rejection/recovery of
truncated tool calls retain their existing behavior.

## 5. Prompt flow

1. load the durable session and reject a missing session
2. resolve that session's mode/provider/model and project binding (app/current
   workspace defaults are legacy fallback only)
3. resolve the complete Pi catalog metadata record for the exact provider/API
   URL and model and clamp the durable session thinking level to its nearest
   supported value; an ID absent from the snapshot uses the explicit generic
   fallback
4. validate model/secret availability
5. reject if session busy; the renderer queues a user-facing next prompt and
   does not call this path until the current session reaches `agent_end`
6. validate structured attachments at Electron main's session-bound path
   boundary, persist image bytes by SHA-256, and retain only attachment refs in
   the durable user message. Only an image that is within the 10 MB inline
   bound for a vision model is read into memory; larger images use streamed
   hashing/copying and the existing safe path fallback. An image whose header
   reports a longest edge above 8000 px (D675) also takes the path fallback
   A `pi-desktop://session/<id>` link in the draft is resolved in the same step
   into a bounded excerpt attachment: the same project only, the current
   conversation dropped before any read, and the runtime quotes it to the model
   as one `<session_reference name="…" session="…">` block ahead of the user's
   own words
   A validated File Manager `lineRange` travels as file attachment metadata.
   Inclusive line numbers are positive 32-bit signed integers and each range
   spans at most 4,000 lines, matching the Host Read line budget. Unsupported
   clipboard selections retain plain-text paste rather than changing the range.
   Main and runtime reject malformed references or more than four references
   with `INVALID_ARGUMENT` before any prefetch; neither silently drops a chip.
   The runtime executes one workspace-only Read per distinct range through
   the normal tool hooks and quotes its bounded result as file context for
   the provider turn. Permission blocks and read failures use a separate
   `file_reference_error` block with a `blocked` or `failed` status. The
   prefetch runs outside assistant tool batches and creates no tool transcript
   row. Restoring the reference preserves its path and range metadata.
7. snapshot the effective shell ID and dialect for the turn
8. start pi turn with the resolved session configuration and effective
   thinking level; HTTP 429 setup and stream failures use the runtime-owned
   silent ten-retry budget, while other transient transport/provider failures
   share a runtime-owned bounded ten-retry budget across the setup and stream
   phases (D127, D186, D245, D258, D378)
9. stream normalized answer and thinking events to UI
10. on tool calls, delegate to Rust host bridge with the durable `sessionId`;
    host resolves the session-bound workspace root
11. if pi finishes a message with `stopReason: "error"`, finalize any partial
    assistant bubble with a structured `UiMessage.error`, persist it in the
    transcript, and emit a normalized lifecycle `error` event carrying the
    same provider `AppError`; even a failure with no answer text remains a
    visible assistant error message
12. finalize and persist successful answer/thinking blocks independently

While an active turn has no new transcript row, the runtime emits a normalized
`status` event that names the quiet interval: `starting` for the prompt
handoff, `waiting-model` while a provider request waits for its first assistant
event, `preparing` after a tool batch and before the next request,
`compacting` during a context checkpoint, `recovering` during a silent-turn
re-run, `retrying` during a bounded provider backoff, and `waiting-subagents`
while the parent waits for delegated work (including each running target's
latest coarse child action). The renderer keeps the phase scoped to the session
and clears it when assistant or tool activity starts, or when the turn
terminates. This is observability only; it does not add a second agent loop or
a completion percentage.

Main-session statuses and assistant snapshots may carry `runDiagnostics`.
The runtime owns this factual snapshot: turn identity/start/end, logical request
count, actual provider attempts, cumulative rate-limit/transient retries, and
actual elapsed retry waits (including only elapsed time when cancelled). A new
provider attempt clears its recent-event timestamp, while the most recent new
answer-text timestamp remains turn-scoped. Thinking/search events are not answer
text and do not prove useful progress. Context size is the current request's
estimate, not accumulated billing usage. The last retry stores stable sanitized
codes/status only, never provider bodies or prompts. Final snapshots are frozen
and persisted with the assistant row; legacy rows omit them. Stale attempts and
delegated runs must not overwrite the main turn. This metadata does not change
retry budgets, watchdogs, cancellation, or model-report policy, and adds no
dedicated timing log stream (ADR 0212).
The event clock observes the raw provider stream before the local idle watchdog;
synthetic timeout/abort errors never masquerade as a recent model update. The
terminal full `message_update` refreshes the last settled assistant row before
the existing end/error event, without repeating `message_end` or usage. Host
persistence rejects a refresh belonging to a different active turn.

The runtime constructs exactly one pi `Agent` per durable session. Plan does
not select a second model, planner service, permission implementation, or
runtime. The same Agent changes its planning state and tool registry after a
host-confirmed transition.

### 5d. Bounded provider recovery and diagnostics (D186, D245, D259, D378, ADR 0091, ADR 0128, ADR 0206)

Provider request setup and stream delivery are separate failure phases, but
throughput-limit HTTP 429s use one response-recovery policy. pi-ai's nested
adapter retry is disabled for this path so the runtime can share one budget
across both phases.

`PROVIDER_RATE_LIMITED` receives at most ten retries after the initial
attempt, for eleven provider attempts total. A setup 429 is retried inside the
provider stream adapter. A mid-stream 429 removes the failed assistant from
the next model context and calls `continue()` in the same turn. Both phases
claim the same counter, so a setup 429 followed by a stream 429 cannot reset or
multiply the budget. The captured response status is applied before classifying
the provider message in both phases, so a generic 429 body still enters the
429 budget while known non-retryable classifications remain terminal. Explicit
billing/account exhaustion (including `insufficient_quota`, spend-limit
codes, Zhipu/Z.ai usage-limit code `1308`, Anthropic "credit balance is too
low", DashScope `Arrearage` / "access denied … account is in good
standing", and Volcengine Ark `AccountOverdueError` / `overdue balance`)
is terminal `PROVIDER_ERROR` even with HTTP 429. The main session and
builtin subagents use the same controller and policy.

429 retries are silent at the transcript lifecycle: no intermediate assistant
error, lifecycle `error`, `turn_end`, `agent_end`, or duplicate assistant
bubble reaches the UI. A normalized `status` event identifies the retry
backoff so the user can tell that the turn is still active. The visible
assistant message id is reused when a retry starts, replacing any partial
content in one bubble. End events are emitted once by the final successful or
exhausted attempt. An abort during the wait cancels the timer and prevents the
next provider request.

The delay follows the OpenCode-style order `retry-after-ms`, `retry-after`
seconds, `retry-after` HTTP-date, then exponential backoff. The fallback starts
at 2 seconds and grows exponentially with up to 25% positive jitter; every
server or calculated value is capped at 30 seconds. The runtime captures the
failed response status and headers from fetch because pi-ai's ordinary response
callback only covers an established response.

The main turn's idle watchdog ([decision](../../adr/provider-stream-idle-policy.md))
measures each active provider attempt separately;
retry backoff is outside that clock. `providerStreamIdleTimeoutMinutes` is an
optional application preference (integer 0-60, default 10); zero disables the
automatic idle cutoff, not user cancellation. It is refreshed at the next turn,
including reused runtimes. A valid explicit preference takes precedence over
the legacy `PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS` override; older callers without
the preference retain that override and its 30-second positive minimum.

For fetch-capable adapters, response headers and nonempty response-body chunks
reset the transport clock, including SSE comments/heartbeats. The observer is
an inline backpressured transform, never a tee or retained response buffer.
Adapters that reject custom fetch keep their original transport and use raw
provider events, falling back to normalized model events when no raw event is
observable. A successful long stream has no total-duration cap. Three minutes
without a normalized model event shows `waiting-model` with `slow: true`; this
is only a waiting hint, never a failure, retry, or proof of model progress.
New model activity clears the hint. Heartbeats cannot clear it.

A transport idle expiry aborts only that attempt and returns the terminal local
`PROVIDER_STREAM_IDLE_TIMEOUT`, even when infinite provider retry is enabled.
Text/thinking already received remains visible as an incomplete error response;
unfinished tool calls are never executed. The user chooses whether to retry.
Safe diagnostics retain the idle limit, last transport/model event timestamps,
response byte count, and whether transport activity was observed, not content.
Completion, failure and user cancellation clear both timers and the listener.
Tool timeouts, compaction and subagent lifetime policies are unchanged.

Non-429 transient failures share their own bounded response-recovery budget of ten
retries after the initial attempt, for eleven provider attempts total. The budget
is shared by request setup and stream delivery, so a fault that moves between
phases cannot reset or multiply it, and it is separate from the 429 budget. It
admits exactly `NETWORK_ERROR`, `TIMEOUT`, `STREAM_FAILED`, and retryable
`PROVIDER_ERROR` — including a gateway `502`/`503`/`504` that arrives before
headers or mid-stream. Authentication, model-selection, malformed-request,
context, and other non-retryable errors do not enter either provider replay
path, and a non-retryable `PROVIDER_ERROR` from a malformed 400/422 request
stays terminal.

Settings > Behavior also exposes `unknownUpstreamRetryLimit`, an integer from
0 to 3, default 0. This independent, opt-in response budget applies only to a
generic JSON `upstream_400` or `upstream_422` wrapper that contains no explicit
permanent rejection. Such an error remains `PROVIDER_ERROR` with
`recoveryCategory: "unknown-upstream"`; the wrapper is evidence that its cause
is unknown, not that the request is valid or retry will succeed. Explicit
invalid-option, credential, quota/billing and context failures keep their
existing classifications and recovery paths. Main sessions and builtin
subagents share the same configured limit, abortable backoff and failed-request
replay rules. A complete successful model response resets this budget; partial
output and request/stream phase changes do not. `infiniteProviderRetry` never
removes this limit. Exhaustion produces the original terminal provider error
and safe child cleanup once; an admitted retry keeps the owning turn open.

Rate-limit, transient and unknown-upstream retry budgets reset after a complete,
non-error, non-aborted model response,
including a response that requests tools. The next model request starts with
fresh counters and backoff, even within the same user turn. Receiving HTTP
headers, partial text, or changing failure phase does not reset any budget.
This rule applies to the main session and builtin subagents: a long task with
independent recovered outages must not eventually stop because earlier tool
rounds consumed the budget. One-shot completions still use one bounded budget
for their single response. Persistent failures remain bounded and abortable.

When compaction has already replaced a failed assistant with a summary or
retained user message, a retry uses that current compacted transcript. It
removes any trailing assistant rows if present, but does not require an
assistant message at the transcript tail before calling `continue()` (issue
#1768).

Complete assistant responses are checked for malformed tool calls before any
call in that response can execute. Missing or blank names/IDs, an empty
Responses wire ID, and non-JSON-object arguments produce the existing terminal
local `context-validation` error. The unexecuted batch is excluded from model
context; visible text/thinking and the error remain available in the transcript.
This does not guess a tool identity, repair arguments into an executable call,
or spend the transport retry budget. Ordinary tool-schema failures still return
tool feedback through Pi's existing validation path.

Continue must also recover a runtime retained from an earlier failure. Model
context projection removes malformed tool calls and their associated results,
including retained compaction tails and resumed delegates, while preserving
valid sibling calls/results, system updates, user messages and useful assistant
content. The durable transcript is unchanged and completed tools are not
re-executed. Other malformed context remains subject to strict validation.
Tool token estimates are optional telemetry: an invalid call identity must not
prevent the corresponding terminal tool event from being delivered.

Complete Qwen-style `<tool_call><function=Name><parameter=...>...</parameter>
</function></tool_call>` blocks emitted as assistant text for a known tool,
and DSML call envelopes or orphaned tails with line-anchored `parameter`,
`invoke`, and `calls` tags ending in the closing invoke/calls pair, receive a
visible, retriable `TOOL_CALL_NOT_EXECUTED` diagnostic. The original text and
completed tool results remain intact. Fenced, inline, quoted and indented
examples, lone DSML tags, unknown Qwen tool names and incomplete Qwen blocks
are not diagnosed. This is a conservative format diagnostic, not a general
markup parser or a semantic task-completion judge.

For a normal main-Agent `stop` with diagnosed text and no structured tool
calls, `finishTurn` permits a correction in the same durable user turn,
subject to the configurable shared allowance in §5e.3 (default one).
A replaceable system section explains that the text executed no action,
asks for a valid structured call within the original scope and permissions,
and forbids repeating successful actions or guessing missing arguments. It
expires on the following request; summary compaction retains the active task while
the correction is pending. No synthetic user message or new turn is created.

The allowance is not replenished by successful tools, provider retries or
steering. Once the shared allowance is spent, a further diagnosed text-only stop
is terminal even if a checklist is unfinished, leaving manual recovery available. Cancellation,
graceful stop, mode closeout, pending steering/delegation work, non-Agent modes,
and provider errors/aborts/length stops do not trigger this correction. Approved
Plan execution uses the Agent rule; its progress-only heuristic does not add
another nudge for diagnosed markup. Valid structured sibling calls execute
normally without a correction nudge. Text is never parsed into executable
arguments, tools are never silently activated, and no transport retry budget
is spent.

### Repetitive model-output circuit breaker

Desktop main-Agent and delegated provider streams inspect text and thinking
incrementally before forwarding deltas to the agent loop. Settings → Behavior
exposes `agentOutputGuard`; shared defaults/validation own all configurable
thresholds. `repetitiveOutputEnabled` defaults to true. A contiguous run of
whitespace (including common invisible separators), punctuation and symbols
trips at `symbolMinChars` (default 4,096) with `symbolMinLines` (default 512),
or at `symbolSingleLineChars` (default 8,192) without a newline requirement.
Meaningful characters reset the run. Markdown fenced code is excluded.

`repeatedParagraphsEnabled` (default true) adds exact consecutive narrative
paragraph comparison after whitespace normalization. It requires both
`repeatedParagraphMinRepeats` (default 4) and `repeatedParagraphMinChars`
(default 1,200). The original output is never normalized or rewritten. Samples
are bounded to 8,192 characters per paragraph; longer paragraphs, fenced or
indented code, tables, lists, quotes, short items and machine-oriented lines
are not prose candidates. Changed content resets the streak. The final
unterminated paragraph is checked once. Turning off the master switch disables
both detectors; disabling only paragraphs retains symbol protection.

This is not a semantic judge of answer quality or task completion. Deliberately
repeated narrative can trigger it; alternating or rephrased loops may be missed.
Tool-call arguments and tool results are never inspected or rewritten.

Each request owns its detector and abort controller. Detection cancels only
that provider attempt and emits terminal `MODEL_OUTPUT_REPETITION`, with local
provenance, the text/thinking channel and counts, never raw diagnostic content.
The received text/thinking is retained unchanged for inspection, but tool calls
in that unfinished response are removed before execution. Earlier successful
tools are not replayed. No provider retry, checklist continuation or silent
recovery is scheduled, even when infinite provider retry is enabled. A user
Stop wins as cancellation; a new explicit prompt starts with fresh detectors.
Already-failed provider responses keep their original error classification.

Delta inspection consumes only newly appended text; terminal snapshots receive
one full check so adapters delivering only a final response are covered. A
single large provider frame may exceed the detection threshold before it can
be interrupted, which is why bounded renderer previews remain mandatory.
History and user messages are not cleaned or changed by this guard. Native Pi
sessions and one-shot plugin/summary requests retain their existing behavior.

See E2E-RUNTIME-repetitive-model-output and E2E-UI-bounded-repetitive-output.

Before surfacing a pre-stream `PROVIDER_ERROR` for HTTP 400/422 whose message
ends in `(no body)`, the runtime makes at most one silent repair attempt with
the generated output-limit fields removed: `max_tokens`,
`max_completion_tokens`, and `max_output_tokens`. The same one attempt clamps
those fields down to the ceiling when the body states one (`at most N
completion tokens`, `max_tokens: N > M, which is the maximum allowed number of
output tokens`, `expected a value <= N`, a `max_tokens` range such as
DeepSeek's `valid range of max_tokens is [1, N]` or DashScope's `Range of
max_tokens should be [1, N]`, or Groq's `max_tokens must be less than or equal
to N`) instead of deleting them.
Anthropic rejects a request that omits `max_tokens`. A field that is absent or
already within the ceiling is left unchanged. Credit exhaustion and context
overflow stay on their existing terminal paths. This repair does not consume
the transient retry budget or add backoff, and the caller's `onPayload` rewrite
remains active. A second opaque failure of the same kind is terminal, and an abort
before the repair starts prevents the repair request. The reserved delegate report
request disables this repair as well as ordinary provider retries, so its
one-request limit cannot acquire a hidden second call.


The non-429 delay honors the server first: `retry-after-ms`, `retry-after`
seconds, then `retry-after` HTTP-date, capped at 8 seconds. Captured headers are
retained for every status that can carry a usable delay (429, 408, 409, and
5xx), not for 429 alone. Without a usable header the wait is a plain doubling
schedule of 1, 2, 4, then remains at the 8-second cap for later retries. The
schedule is identical in the request and stream phases so a fault that moves
between them keeps one predictable rhythm. It is deterministic — no jitter —
because it paces one failed request rather than a synchronized rate-limit burst.
A server-stated delay wins outright, including one shorter than the scheduled
wait.

Only the failed request is replayed. The session, its transcript, and its tool
state are untouched: the failed assistant is removed from the next model context
and the same visible message id is reused, so a retry never restarts the turn or
re-runs a completed tool call.

The application setting `infiniteProviderRetry` is off by default. When enabled,
the main session and its builtin subagents skip only the ten-retry ceiling for
`NETWORK_ERROR`, `TIMEOUT`, `STREAM_FAILED`, retryable `PROVIDER_ERROR`
(including 5xx gateway failures), and `PROVIDER_RATE_LIMITED`. The same backoff,
`Retry-After` precedence, visible retry status, and abort/Stop path remain in
force. Non-retryable errors, context recovery, compaction, tool execution, and
one-shot completions are unchanged. The setting can keep billing requests alive
indefinitely until the user stops the turn.
Settings reads expose an explicit boolean for this flag: absent or disabled
values normalize to `false`. Read-modify-write operations on unrelated settings
must remain valid without enabling retries; non-boolean writes stay invalid.
Each retry is abortable and reports its current backoff through the normalized
status event. The `retrying` activity carries the classified error code, the
bounded/redacted provider message, and the HTTP status when known. The main
session, builtin subagents, and plugin one-shot completions use the same
codes, budget size, and precedence.

When the retry budget is exhausted, the final assistant error and lifecycle
`error` are emitted once. Provider failures carry bounded diagnostics in
`AppError.details` when available: `phase` (`request` or `stream`),
`providerStatus`, `providerCode`, `providerWaitMs`, `streamMs`,
`retryAttempt`, the network diagnosis (`networkCategory`, `networkCode`,
`networkSyscall`, `networkHost`, `networkRoute`) and the request correlation
(`requestMessages`, `requestBytes`, `compactionGeneration`). For a persistent
429 or non-429 transient failure,
`retryAttempt` is `10`, derived from the exhausted error class's budget rather
than temporary retry activity state. Credentials and unrestricted response bodies never
enter the event or log. The active-turn status shows the remaining backoff and
the retry budget as `Retrying in 0s · attempt 9/10` in English.

Each retry builds a new request, stream, and `AbortController`; the one piece of
state a retry shares is the process-wide undici dispatcher. When the same origin
fails twice in a row without any response and no fresh attempt reaches it, the
transport is rebuilt once (throttled to one rebuild every 30 seconds, never for
`dns`) before the next attempt, so the retry does not replay into a pool whose
connection is already dead. The rebuild installs the replacement before closing
the previous dispatcher and closes it gracefully, and it reproduces the
configured route, so another session's in-flight request finishes on the pool it
started on and a proxy is never silently dropped.

### 5e. Silent-turn recovery

An ordinary turn that ends with no tool call and no visible assistant text is invisible
to the user: reasoning is never rendered, so a conclusion written only there
did not arrive. 15 of 255 recorded sessions ended a turn that way, and the
user's only recourse was typing "继续".

The runtime detects it at `message_end`: the stop was neither an error nor an
abort, the message requested no tools (no `toolCall` content part), and the
visible text is blank after trimming. Reasoning content does not exempt a turn
— a thinking-only turn is exactly the case that needs recovery.

Recovery mirrors §5d and is bounded the same way: at most one re-run per run.
The silent assistant is dropped from the model context (`continue()`
refuses a transcript ending in an assistant message, and an empty one is not
worth resending), a short no-output instruction is appended to the system
prompt for that one continuation, and the bubble id is reused so a recovered
turn leaves no empty row behind. The silent attempt's `turn_end` and
`agent_end` are suppressed; the re-run emits the single terminal lifecycle.

Recovery is armed inside `message_end` and carried out once the loop is idle,
so it belongs to every entry point that drives the loop — a user prompt and an
approved plan or goal execution alike. Each entry point clears the recovery
state before it starts and runs the pending recovery after `waitForIdle`,
through one shared implementation of each half. The shared drain also handles
recoveries armed by a recovery attempt before it returns, so a chained failure
cannot leave lifecycle suppression active with no recovery or terminal event.
Skipping either half ends the run with its lifecycle still suppressed and no
recovery attempted, which reaches the user as a session that stopped mid-work
with no error and no retry action. §5d overflow and provider-stream retry ride
the same contract, and a suppression flag left behind would swallow the
*next* run's terminal events.

The one-shot instruction rides on the agent's system prompt rather than the
`prepareNextTurn` hook, because that hook only shapes turns inside a live run
and this run has already ended. It is removed afterwards unless a path-scoped
instruction reload rewrote the prompt meanwhile, in which case the newer
rebuild wins.

If the re-run is silent too, the turn ends as a visible assistant error with
retriable `EMPTY_MODEL_RESPONSE`, which gives the transcript its normal retry
action. No empty assistant message is persisted in either case.

A Host-ledger completion notice (ADR 0239, D446) is the narrow exception:
its prompt already permits no acknowledgement. Main resolves the queued message
by ID, verifies its target session, and constructs provenance from the ledger.
The runtime accepts silence only for `kind: completion` targeting the current
session with nonempty message and reply-to IDs. A silent notice reply emits its
normal completed message and terminal lifecycle without a recovery request or
`EMPTY_MODEL_RESPONSE`. Provider errors and aborts retain their normal handling,
and a provider retry of the same attempt keeps the exception. The original
task/result is not rewritten, and completion notices never request another
callback.

The exception covers exactly the notice's own reply: the first settled
assistant response of the run spends it, whether that response is silent,
textual, or a tool batch. A reply that follows tool results is therefore
ordinary work under this section, and the exception is revoked as soon as an
accepted steering message enters the model context, so a reply to the user
keeps its full re-run and error path. Every new run recomputes it from the
prompt's provenance. Ordinary user input, task/message deliveries, copied
source framing, and restored history cannot enable it.

An accepted silent reply is still not worth resending. Main persists it as an
empty completed row (the transcript hides it and the host stores no text), but
the runtime keeps it out of its entries and out of pi's transcript state, and
the context projection drops any assistant with no content blocks, exactly as
a restored transcript already did. The next provider request therefore carries
no empty assistant message.

Decision D193 and D446 (ADR 0239 amendment); see E2E-146 and
E2E-SESSION-completion-notice-allows-silence.

### 5e.1. Progress-only recovery for approved Plan/Goal execution

An approved Plan or Goal can still stop after a visible progress update when
the model puts its narration in a text-only assistant message and emits the
tool call in a later message. Ordinary Agent prompts do not use this recovery.
The runtime only arms it for a successful, non-aborted message with no tool
call whose visible text has a clear forward-looking action signal such as
"Writing the remaining note" or "the next step is ...". A normal completion
report such as "Implemented the approved plan" is terminal and is not nudged.

The recovery is bounded to one attempt per approved execution and the shared
correction allowance in §5e.3. The progress
text remains in the current assistant bubble, while its assistant message is
removed from model context before `continue()` so the provider never receives
an invalid assistant-to-assistant transcript. The first attempt's
`agent_start`, `turn_start`, `turn_end`, and `agent_end` are suppressed; the
continuation reuses the same bubble id and emits the single terminal lifecycle.
The progress nudge is attached to the system prompt for that continuation and
removed afterwards. If the continuation produces a tool call, the normal
autonomous loop proceeds; if it produces another text-only response, that
response is terminal and cannot trigger a second progress nudge. A silent
recovery that already ran in the same execution also prevents the recovered
final report from being misclassified as progress.

See E2E-146a.

### 5e.2. Continue an unfinished current-task checklist

Settings → Behavior → Execution exposes `autoContinueUnfinishedTodos`, enabled when
absent and disabled only by an explicit `false`. Main passes the resolved
preference to both new and reused Desktop runtimes on the next user turn.
Native Pi sessions and delegated agents do not use this guard.

After a successful main-Agent `TodoWrite` in the current user turn, a normal
visible assistant response with no tool call may end before the work does.
At the loop's `finishTurn` boundary, the runtime reads `todos.get` for that
session. If its committed snapshot still contains `pending` or `in_progress`
items, the runtime requests one continuation in the same durable user turn.
The prior response remains in the transcript and model context; no synthetic
user message is added. A replaceable system reminder asks the model to advance
the existing task within its original scope and permissions, keep checklist
states truthful, and ask for user input or explain a concrete blocker when
necessary. The reminder expires on the following provider request.

Checklist corrections consume the shared user-turn allowance in §5e.3 (default
one), even if further tools update the list. A new user turn resets it and requires
its own successful checklist write; a stale persisted list alone cannot trigger
execution. Empty, completed, and cancelled lists do not trigger it. Failed or
aborted responses, truncated output, a failed latest tool batch, explicit Stop,
pending steering, pending recovery, and running delegates keep their existing
lifecycle. The runtime rechecks cancellation and turn ownership after the Host
read; a failed read logs a diagnostic (numeric RPC code when available, never
raw Host error details) and preserves normal completion. If
context compaction is needed before the continuation, it retains the active
user task. No completed tool batch is replayed and only the final loop exit
emits `agent_end`.

This can add model requests and cost. It does not guarantee task completion
when the model stops again, and it cannot infer unfinished work without a
checklist written in that turn. See E2E-RUNTIME-unfinished-todo-continuation.

### 5e.3. Configurable local early-end guard and shared correction budget

`agentOutputGuard.earlyEndMode` offers `off`, `warn` (default), and `continue`.
An ordinary Agent task can end with an immediate action promise but no structured
tool call, even without a current-turn checklist. A conservative local check
combines the current task and execution evidence with the final response. Explicit
discussion-only requests, completed/optional-follow-up reports, waiting for user
input, blockers, unsafe tool outcomes and cancellation/steering/delegation states
do not authorize continuation. Text is never converted into executable arguments.

Warn mode annotates the matching settled message without an additional model
request. Continue mode may add a short, temporary system correction to advance the
same task using retained receipts, or explain a concrete blocker. It adds no
synthetic user message and does not replay completed tools. The normal path has
no additional model instructions, tools or reviewer request. This heuristic is
advisory and may miss ambiguous early stops; it does not prove completion.

`agentOutputGuard.recoveryLimit` is a shared user-turn ceiling (integer 0-3,
default 1) for early-end, checklist, text-tool-protocol and approved-execution
progress corrections. Existing eligibility rules remain, as does the legacy
approved-execution one-shot limit; tool activity never replenishes the allowance. Zero
disables these automatic corrections. It does not disable transport recovery or
make a repetitive-output failure retryable. The existing checklist toggle still
controls whether its path is eligible. Budget exhaustion remains visible rather
than permitting another guard to restart the same work.

The settings apply on the next user turn, including runtime reuse. No provider
name is hard-coded and no third-party assessor is needed. Optional normalized
termination facts ride on existing `runDiagnostics.termination`: message ID,
stop reason and its `normalized` source, available token figures, early-end
warning/recovery state and correction count. Old rows remain valid without this
field; raw provider reasons are not fabricated from normalized values. See
[the decision](../../adr/configurable-local-output-guards.md).

### 5e.4. Optional built-in Observer Guard

Local Desktop sessions explicitly select `observerMode: off | endless | guard`.
Off is the default. Stored Observe migrates to off, never to active continuation;
old assessments remain readable. Native/remote and scheduled runs stay disabled.

Both modes use `observerGuard.maxContinuations` (integer 1-100, default 3)
and replace legacy checklist/early-end nudges while enabled rather than
stacking another normal-stop allowance. Off preserves the existing local
guards. Tool-call repair and built-in provider recovery are unchanged.

Both modes let each eligible ordinary local main Agent turn settle with its
final answer intact. Only the live Desktop turn owner can submit a visible,
automatically sent user-role **Continue** through ordinary new-turn admission
for that session, after settlement. Neither mode injects a same-turn reminder
or reopens the final answer. Endless marks an eligible non-empty normal-stop
reply without reviewer configuration, a reviewer call, or text judgement.
Guard requires the independent review decision below. Neither terminal record
is a dispatch or evidence that a follow-up was sent.

Admitted automatic follow-up turns and opt-in extra transient recovery claims
draw from one original limit per human input. Auto turns do not replenish the
balance; ordinary provider retries and tool calls neither spend nor reset it.
When no capacity remains, do not send a follow-up. A new human input supersedes
the old chain, and queued human work takes priority. Deduplicate by live turn
and response ownership. Recheck current consent, ownership, and admission before
sending. Stored messages and historical markers cannot trigger dispatch; reload,
replay, or restart cannot enqueue a duplicate or resume an old chain. The normal
prompt path retains existing context, permission checks, scope and completed
receipts. Neither mode adds approval authority or I/O capability; Endless can
follow even a normal "done" and add main-model usage.

Stop, steering, mode closeout, pending work, unsafe tool state, and real
input/approval waits remain authoritative. A plain-text question is not a
structured wait. Error, abort, length, and empty endings are ineligible. Off
revokes either enabled mode, including a send pending admission, without
aborting the current main Agent turn. An already started review may finish;
its stale result cannot send. Ordinary Stop interrupts active work, including
review, and prevents its automatic sequel.

**Guard** independently assesses each new eligible final reply at most once
while chain capacity remains. At zero remaining capacity, it does not review
or send. The reviewer is the exact configured independent provider/model and
uses only the reply plus a user-editable `prompt`. Empty prompt restores the
shipped default; maximum prompt length is 8,000 characters. The default requests
continue for unfinished work or a concrete worthwhile improvement, and stop for
completion, genuine input/approval needs or refusal. Accept exactly `continue`
or `stop` (case/outer whitespace normalized). Remove task-history tracking,
confidence/evidence-ID validation, tool-name whitelists and answer-keyword vetoes.
Earlier user/history prose, system instructions, reasoning and tool data are not
sent. Deprecated tool-output settings are accepted for old files but ignored.

The Guard reply-size bound stays 2,000-20,000 characters (default 8,000), separate
from the prompt cap. Oversized replies stop visibly instead of judging fragments.
Deadline is 5-90 seconds (default 30); output caps are 512 tokens without thinking
or 8,192 with thinking. Invalid/empty review output, timeout, cancellation or
failure stops without retry. No model fallback, reviewer tools, native search,
parent provider-side thread or reviewer-authored executable command is used.
Redaction remains best effort. Stop/stale state is rechecked after the await.
A terminal `continue` decision can qualify for Desktop admission; `stop`, a
review error, stale ownership, or a blocked turn cannot dispatch.

Guard configuration is snapshotted per turn. Both modes retain optional
`observerGuard.continueOnTransientError` (boolean, default false). An eligible
main Agent request may claim an extra attempt after built-in network/transient-
service or rate-limit retry exhaustion. Both modes spend their remaining chain
balance on extra recovery and admitted follow-ups.
The extra recovery stays within the ongoing turn's transport retry path and
does not send a Continue message or call a reviewer. Request-setup and mid-stream
recovery use the same claim path. Existing backoff, receipts, permissions and
context-preserving recovery remain authoritative. Success does not replenish
the allowance; the retry indicator includes the remaining allowance when an
extra attempt is admitted. Off, Stop, steering, Plan/mode closeout, unsafe latest
tool state, permanent/local errors and certificate failures cannot claim it.
Built-in retries, including the separately selected infinite retry policy, are
unchanged and do not depend on the continuation cap. Host notices, restored
history and opening historical details never start work.

`runDiagnostics.observer` stays bound to its owning response. It uses the
existing `continuationCount` and `maxContinuations` fields; Guard records its
decision and independent model/effort/usage when available. A terminal recovery
count describes only extra claims in that turn, not all provider retries or the
chain total (both modes use the existing `endlessRecoveriesUsed` wire field).
Neither eligibility nor a Guard `continue` asserts a send; only the admitted
visible follow-up shows cumulative allowance consumed, including that follow-up.
Legacy records remain readable. Diagnostic refreshes preserve immutable
response content and separate primary-model accounting. See
[the decision](../../adr/builtin-observer-guard.md), E2E-RUNTIME-observer-guard
and E2E-RUNTIME-endless-follow-ups. Neither mode verifies task completion.

### 5.1 Context checkpoint protection (D158/D203, ADR 0030/0049/0061/0064)

The complete visible transcript and the model context are separate views of
the same session. A durable checkpoint summarizes older model context while
the renderer continues to show every original user, assistant, and tool row.

Responses text explicitly marked `commentary` is progress, not a subagent
report, one-shot result, or final answer. Signed transcript rows retain the
provider's original text for replay. Unmarked text is treated as before.

When restoring a checkpoint, tool-call reconstruction respects its
`throughMessageId` boundary. A surviving tool row must not attach its call to
an assistant that the checkpoint removes. Legacy checkpoints can cut through
a tool batch; the surviving rows reconstruct a carrier after the boundary from
their stored call ids, names, and arguments, retaining the original carrier's
provider/model identity and function-call signatures. A call-only assistant
with no remaining content still anchors the checkpoint. This changes only the
model projection: stored history is not rewritten, results are not discarded,
and historical tools are not executed again (issue #2306).

PI-Desktop uses pi-agent-core for the agent loop and stable agent/event/tool
types, and pi-ai for provider-facing requests and message estimation. The
runtime owns its context projection, LLM-message conversion, token-estimation
adapter, compaction cut-point selection, and summary generation because the
older experimental pi-agent-core harness APIs have been removed. These helpers
preserve the existing session/checkpoint behavior while keeping the Rust host
as the only durable session owner; OpenCode DCP remains an AGPL-3.0 behavioral
reference only, not a linked or copied dependency.

Compaction is runtime-owned (ADR 0064 as amended by
[runtime-owned context compaction](../../adr/runtime-owned-context-compaction.md)):
it remains inline at turn boundaries and begins automatically at
`floor(hardLimit * 0.9)`. There is no background pre-computation or model-facing
compaction tool.

pi 0.84.4+ invokes `prepareNextTurn` only when the loop will start another
assistant turn in the same run — including between a completed tool batch and
the follow-up model request. A new user prompt is checked before its first
provider request through `automaticCompactionNeeded` in `prompt()`, including
the pending user message.

For every pi loop turn:

1. pi emits and awaits `turn_end` after the assistant message and all tool
   results for that turn are complete
2. PI-Desktop rebuilds the context from the full transcript plus the newest
   valid checkpoint and estimates the next request budget
3. below `floor(hardLimit * 0.9)`, and with no pending trusted-extension
   request, the next turn proceeds unchanged (a budget reminder may be added)
4. at or above that trigger, or after trusted-extension `ctx.compact()`,
   compaction runs synchronously before the next provider request. In the
   summary family, generation is mandatory; the runtime preflights the summary
   input against the model window, reduces it once, and then splits a range that
   still does not fit into chunks that each do, so a prompt too large for one
   request is summarized by several (ADR 0302). An automatic summary failure
   first attempts a deterministic retained-tail checkpoint. If a soft-trigger
   compaction fails but the request remains below `hardLimit`, the unchanged
   context may proceed; once the hard boundary is reached, failure is terminal.
5. successful generation or deterministic recovery first appends the
   checkpoint through host-core, then installs its summary plus the applicable
   retained tail as the runtime context for the next provider request; every
   checkpoint is re-estimated before persistence and continuation, and cannot
   authorize a request at or above the hard budget

Checkpoint generation and installation are separate operations.
`buildCheckpoint` runs the preparation, budget preflight, and summary request
without persisting anything or changing the active checkpoint; installation
re-estimates, appends through host-core, updates the active checkpoint, and
emits `compaction_end`. The blocking path composes the two back to back.

**What survives a checkpoint.** A successful active-turn checkpoint leaves the
summary, the active run's user goal, steering and a bounded execution window from that
task (see [execution continuity](../../adr/compaction-execution-continuity.md)).
Assistant/tool batches retain original names, call IDs, arguments, result order
and error flags; missing-result calls and orphan results are not reintroduced.
The boundary batch may have text shortened at the middle, preserving both ends;
opaque content that cannot fit is omitted as a unit, never mutated. Retained
assistant usage is cleared because it measured the old context. The complete
range still enters the summary input; visible messages are never rewritten.
The existing run-start boundary keeps same-turn steering with its prior execution
evidence. When that live boundary is unavailable, preparation conservatively
starts at the latest user message. Steering never separates a retained call from
its result. Existing wire-ID repair runs before pairing. The tail is also capped
at 16 MiB serialized bytes; duplicate non-provider result details are omitted,
but ToolSearch activation markers survive. User images are preserved when text
truncation alone makes the goal fit; otherwise their omission is explicit.

A **retained-tail fallback** preserves its existing recovery behavior because no summary covers its
range: it keeps the real recent window — the newest contiguous messages of the
compacted range, every role, bounded by the keep-recent target and by what the
safe budget leaves once the carried-forward summary and the recovery notice are
paid for — and records `details.retainedTailShape` as `recent_window`, so a
rebuild replays that window instead of narrowing it back to one user message
(ADR 0302, issue #827). It drops the assistant messages pi drops from the
rebuilt context anyway (error, aborted, deferred) and any tool result whose tool
call is not in the window, because a provider rejects a result whose call is
missing. An `active_turn` fallback also keeps the active task's user message
ahead of the window when the window itself cannot hold it, so the continuation
never loses its goal.

The retention mode is selected from the lifecycle that requested compaction. It
decides what a *successful* checkpoint leaves behind:

- An `active_turn` checkpoint is created while the provider must continue the
  current task after a tool result, a `toolUse` turn, or overflow recovery. It
  carries the current run's user goal, steering and recent complete assistant/tool batches,
  within the keep-recent budget below. The goal receives at most half that
  budget and the existing active-user cap. Truncated text is explicitly marked
  (`[checkpoint truncated: this message crossed the retained context budget]`).
  When the summary is nonempty and the retained tail contains only the request
  with no reasoning to replay, the request precedes the checkpoint; newer
  messages follow it. Reasoning replay stays between the summary and user tail.
  The older upstream-only single-user retention is superseded by the budgeted
  execution window described here.
- A `completed_turn` checkpoint is created at a terminal turn boundary, before
  a new user prompt, or for manual compaction. It carries no naked historical
  user messages. The summary is authoritative for completed work, and the next
  user prompt is the only new task after the checkpoint.
- A retained-tail fallback carries its recent window in both modes, because the
  alternative is an empty context; the mode still decides whether it has to
  keep the active task's user message as well.
  Its recovery notice precedes that window even if only the user message fits.
- The `fresh_window` family remains the deliberate no-summary exception from
  ADR 0064 and always carries an empty tail.

The retained-tail mode and shape are stored in the checkpoint's opaque `details`
field, so a restart preserves the same task boundary and the same treatment of
the tail. New successful active-turn records and fallback records use
`recent_window`. Unmarked legacy checkpoints retain the older normalization:
at most the latest user message for an active turn, no tail for a completed
turn. They are not rewritten or expanded from old transcript messages.
Assistant/tool pairs remain provider-valid, and raw tail messages are selected
before summary-only file-operation name normalization. Assistant
thinking shares the same character budget as text. Answer text is reserved
first; a thinking block that has to be shortened drops its provider signature,
so the replay is not a mutated signed trace. A block that still fits keeps its
signature, and redacted thinking is left unchanged. The retained tail
is re-estimated with the summary before persistence and before continuation, so
an oversized request still cannot pass the guard. A fallback also records
`details.failureReason` — `no_new_history`, `summary_budget`,
`summary_provider`, or `checkpoint_oversized` — a closed vocabulary rather than
provider error text, which can carry endpoint details.

**Two compaction families.** Both run the same lifecycle — budget
re-estimation, host-core append, `compaction_end`, transcript row, warning:

- `summary` (the default) requests a summary from the model;
- `fresh_window` requests nothing and installs a checkpoint with an empty
  retained tail and a fixed marker text saying the history was reset without
  being summarized.

The family is resolved from a construction option, then
`PI_DESKTOP_COMPACTION_STRATEGY`. It is not a setting, is absent from
`AppSettings` and i18n, and exists so the no-summary mechanism is implemented
and testable.

**Initiators.** The runtime alone initiates automatic compaction. `new_context`
is neither an active tool nor ToolSearch-discoverable, and system prompts contain
no reminder asking the model to compact. The user may initiate the existing idle
`/compact` command, and trusted extensions may use `ctx.compact()`; both follow
the existing compaction lifecycle. Historical `new_context` and `CompactContext`
calls remain readable transcript data only and cannot reactivate either name.

The existing two-tier budget reminders remain, once each per checkpoint window:
at `clamp(hardLimit * 0.15, 8k, 32k)` tokens remaining, then at 2,000 tokens.
They ask the model to preserve durable work while continuing the current task;
they do not offer or invite a model-controlled context switch. Automatic
compaction still runs first when its threshold has already been reached.
A reminder never rewrites the request prefix (issue #2458): where the model
keeps mid-conversation system messages in place it is a `context_budget` system
section that expires at the next checkpoint; elsewhere, because pi-ai folds
every system update into the leading system message, it is a request-only user
message that is neither persisted nor carried into the next run. Neither
reminder is shown in the transcript.

The hard boundary is the model context window minus request headroom. Automatic
compaction starts at 90% of `hardLimit`; this deterministic margin is not
configurable. Headroom is the maximum of a 16,384-token reserve floor, model
maximum output capped at 25% of the context window, and a 5% safety margin. The
reserve floor is itself capped at half the window. The cut-point target used by
the runtime-owned preparation is derived from the model window as 20% of the hard budget clamped to
8,000–64,000 tokens, then capped at half the hard budget. It also bounds the
combined successful active-turn tail. The user goal receives at most half this
tail budget and the 20,000-token active-user cap, leaving room for execution
evidence. A fallback's window is capped by
25% of the hard budget and by the room the carried-forward summary and the
recovery notice leave, so recovery cannot install a checkpoint the guard
rejects. None of these values are configurable.

**Estimate calibration (D606).** Every threshold above is compared against one
number, corrected against observed request usage. The runtime estimator anchors
on the last assistant usage and delegates provider-message estimation to
pi-ai, whose 1.1.0 text estimate is 3.5 characters per token; text truncation
starts from that ratio, then shrinks the cut until the output-cap estimate
(chars/4 plus the CJK correction) fits the same token budget. Retained tails,
checkpoint user messages, and a delegate's retained task brief share that
bound. Desktop-only rows keep the existing
character heuristic. With no usage
anchor, the budget also computes the output-cap estimator
over non-system conversation messages plus the current system prompt and active
tool schemas. System-transcript rows are chronological updates, already covered by that
folded prompt/tool floor, and are excluded from this component, so the request estimate counts the prompt
and schemas exactly once. The budget uses the larger of this full-request
estimate and the calibrated message estimate. This is a hard floor before the
first calibration sample and prevents counting overhead twice after an
unanchored residual has learned it.

For a usage anchor, the runtime takes the larger of the reported total and the
request's input, output, cache-read and cache-write buckets. The inspector
shows the bucket sum; reasoning is already included in output. This prevents a
gateway's total that omits cached input from delaying compaction, while keeping
the total-based guard when bucket details are incomplete. Billing totals remain
unchanged.

Pi usage conversion retains explicitly supplied finite, nonnegative cache-read
and cache-write counts, including zero, through physical-request observation,
history replay and operation deduplication. Missing or invalid cache counts
remain absent, so consumers can distinguish a known zero from unavailable
usage. Previously stored missing fields are not backfilled as zero.

The calibration still measures the two errors separately — per-character bias
as a scale-free ratio over the guessed tail, and an unanchored residual as a
ratio only for observations taken at a comparable scale (0.5×–2× of the
message estimate), otherwise as the observed overhead capped at 32,000 tokens.

The correction is asymmetric because this number gates compaction: upward
applies once three observations exist, downward needs three agreeing samples,
is capped at 15 % per step and can never take the value below 85 % of the raw
estimate, so a projection at 1.18× the hard limit (`1 / 0.85`) still compacts.
A report outside 0.5×–3× of what the calibration predicted is treated as a
misreport, and two consecutive misreports freeze the downward direction until a
usable report arrives.


The provider request layer also caps the concrete output budget before every
parent, subagent, and one-shot request. It estimates the serialized input with
the pi-ai chars/4 baseline plus a CJK correction, then reserves the larger of
4,096 tokens or 1% of the effective window. The effective window is the smaller
of the configured value and the published catalog window when both are known;
this prevents an oversized user override from bypassing compaction and output
protection. Unknown windows preserve the configured output budget. The estimate
measures the transcript the adapter sends: unless the bound model declares
mid-conversation system support, later system-transcript updates are folded
into one leading message carrying the current instructions and tools, and the
parent and subagent paths hand that folded transcript to pi-ai as well, so its
own `streamSimple` clamp agrees. Superseded instruction snapshots are never
charged against the output budget.

The incoming user prompt participates in budgeting before the first provider
request. The automatic summary request retries transient provider failures
under a bounded pi-ai retry policy (3 retries, 2s/4s/8s backoff, cancelled by
Stop); deterministic failures such as quota or auth return at once. The
preflight guard sizes the actual serialized prompt rather than raw messages,
including the CJK correction shared with the output-cap estimator (Han, kana,
and Hangul are charged near one token per character, not the chars/3.5 baseline).
Tool results keep both ends within 2,000 characters; one reduced pass uses
500 characters and drops thinking without removing messages. User images are
marked as present but not visually included in the text input. Summary and
continuation prompts distinguish completed work from plans, failures and unknown
outcomes: a checkpoint is not a new task, and uncertain side effects require
reconciliation rather than blind replay. This reduces context loss but is not
an exactly-once execution or model-compliance guarantee. If the input still does not fit, the range
is split into contiguous chunks that each do: at most 16 requests, each carrying
the previous chunk's summary through pi's update-the-summary prompt, with the
range's file list appended on the last one, and the checkpoint reports the summed
usage of the requests that produced it. A budget therefore decides how many
requests a summary takes, not whether the model is asked at all (ADR 0302); only
an empty range, or one past that request bound, still gives up on the summary
(ADR 0282). If normal compaction still fails during an automatic threshold or
overflow recovery, the runtime persists a short recovery checkpoint with the
previous summary (when available) and the bounded recent window described above.
The complete transcript remains durable and visible, while the next model
request receives only that recovery checkpoint and applicable tail. The
lifecycle event marks this as `fallback: "retained_tail"`, and the checkpoint's
mark carries the same `fallback`, so the renderer shows a warning and labels
the transcript row as a failed summary rather than a false success. The window
is sized from the local estimate while installation re-estimates with the
calibrated one, so a window the calibrated estimate still puts at or above the
safe budget is halved and retried, down to 1/128 of its first size, before the
recovery gives up (issue #2494). If the fallback cannot be prepared, persisted,
or kept below the safe budget, the user row and an assistant error remain
durable and no provider request starts. That `CONTEXT_COMPACTION_FAILED` error
is classified as local (`details.origin: "local"`), so it carries no stream
timings or HTTP status from an earlier request, and its message names the
checkpoint failure that caused it.
Provider-reported context overflow is the last recovery layer: omit the failed
assistant from model context, compact once, and retry once. A second overflow
remains terminal and is reported as `CONTEXT_TOO_LARGE`: the error classifier
recognizes every overflow wording pi-ai's `isContextOverflow` recognizes, so a
provider such as DashScope/Qwen or z.ai is not recovered as an overflow and then
reported as a generic `PROVIDER_ERROR`. Bedrock's
`prompt is too long: N tokens > M maximum` form maps to this path.

Automatic protection is always enabled and is not user-configurable. The
runtime still accepts a construction-time override that disables it, used by
tests; persisted `contextCompaction` settings are ignored so a session cannot
be left with the guard off and no way to restore it. Manual `/compact` remains
available while the session is idle. Checkpoint generation is abortable and
counts as running state until durable persistence completes.

The file list a checkpoint carries is read out of the summarized range by pi's
own collector, which recognizes the lowercase spellings `read` / `write` /
`edit` — the names pi's tools carry. PI-Desktop registers `Read` / `Write` /
`Edit`, so the runtime converts exactly those three on the way into pi's
preparation (`withPiFileOpToolNames`): nothing stored changes, and every other
tool name is left spelled the way we register it. Without that conversion a
checkpoint's `readFiles` / `modifiedFiles` and the `<read-files>` section of a
summary were always empty (D618). Codex-shaped compaction folds pi's retained
tail into that same summary, and the runtime records file operations from the
folded tail as well, so a file touched only inside the recent-token window
still appears in the checkpoint lists and summary tags. The stored tool call keeps
the argument spelling the model sent, because `normalizeToolParams` folds
alias names only when the call executes (D273). The collector therefore reads
the path from `path` or from the same aliases (`file_path`, `filepath`,
`filePath`, `filename`, `fileName`, `file`), with the same precedence.
Calls on an assistant that stopped with `error`, `aborted`, or `deferred` are
not counted: pi returns before executing them, and the rebuilt context drops
the same turns, so they never read or changed a file.

A delegate (§5f) runs the same derivation against its own resolved model and
compacts at its own turn boundaries, without a durable checkpoint chain of
its own (ADR 0299).

## 5b. Operating mode and planning state

- Default product mode: **Agent**
- The product selector is **Agent | Plan | Goal**; the internal conversation page
  may still use `page = "chat"`
- Mode is session-scoped and persisted with session metadata
- Thinking level is session-scoped and persisted with session metadata
- Host configuration is mutable only while the session is idle. The renderer
  keeps mode/provider/model/thinking/permission controls editable during a run,
  treats the latest selection as next-turn state, and flushes one full
  configuration after the terminal event.
- Changing mode/provider/model/thinking level applies to the next turn and
  recreates the pi runtime when any runtime-affecting configuration changes;
  no in-flight runtime observes a queued renderer choice.
- The live planning indicator follows the turn that is actually running. A
  mode choice staged while a turn runs never flips the projected
  `planning`/`inactive` state mid-turn: the renderer keeps the state of the
  in-flight turn and only moves it to the staged contract mode after the
  terminal event flushes the configuration, so `Plan / planning` surfaces
  when the next prompt starts under the new mode. The Composer mode chip
  pulse and the compact transcript Planning row are that same live
  projection: the chip label may already show the staged mode, but it does
  not pulse until the in-flight turn projects `planning`.

The live planning state is derived and projected as:

```ts
type OperatingMode = "agent" | "plan" | "goal";
type ProposalKind = "plan" | "goal";
type PlanningState =
  | "inactive"
  | "planning"
  | "awaiting_approval";
type PlanExecutionState = "queued" | "running" | "completed" | "interrupted";
```

Plan and Goal are the two **contract modes** (D198). They share one durable
approval table, one projected `PlanningState`, one approval surface, and one
execution queue; a `kind` discriminator (`plan` | `goal`) on the proposal selects
the prompt, the artifact directory, and the user-facing copy. `Agent` is the only
mode with no kind, and is the only mode that executes freely. Because the
projection is shared, `planning` and `awaiting_approval` are always read together
with the kind to know which durable mode a session is in.

`Agent / inactive` enters `Plan / planning` either when the user selects Plan
while idle or when the Agent calls `EnterPlanMode`. In Plan, the Agent can
inspect, use context controls, run Bash through the selected permission mode,
and call `SubmitPlan(title, markdown, question)`. Host-core preserves the
submitted Markdown bytes in a new immutable
`.pi/plan/<unique-name>.md` artifact, records its relative path/hash/size and
structured title/question in `plan_approvals`, and moves the live state to
`awaiting_approval`.

Plan/Goal requests retain Write/Edit and TaskWait/TaskList/TaskStop declarations,
plus Task when subagents are configured. They are marked
unavailable in the active mode. The execution allowlist remains unchanged:
prohibited calls are blocked before extension call hooks and handlers, and a
handler retained across a mode change rechecks that mode before executing.
The model receives an ordinary error tool result with the original call id;
no editing, delegation, fake user message or transcript deletion occurs.
Other deferred/plugin tools keep their existing visibility rules. See
[the declaration/permission decision](../../adr/plan-tool-declarations-and-execution-denials.md).

Plan/Goal entry remains available without a project workspace. A submission
requires a persisted session workspace for its approval artifact.
`PLAN_WORKSPACE_REQUIRED` from submission is a recoverable tool error: it
explains how to bind a workspace and directs the agent to present the proposal
in chat without retrying until a workspace is bound. It does not terminate the
model loop, create an approval, or authorize execution. Successful submission
still terminates for approval; other submission failures retain their existing
termination behavior.

Approval has only `approve` and `reject`. Approval commits `mode = agent`, the
explicit permission mode, an execution ID, and `execution_state = queued` on
the same `plan_approvals` row in one host transaction. The
same Agent then receives a fresh model turn with the Agent tool set. Reject,
absolute expiry, a pending interruption, stale response, or persistence
failure closes the approval row and returns the live state to editable
`Plan / planning` without granting execution tools. A later accepted Plan prompt
is a new turn: earlier `SubmitPlan` calls remain historical immutable
checkpoints, and the Agent must call `SubmitPlan`
once with a new complete Markdown snapshot to create a new artifact. If approval
already committed and a queued/running execution is interrupted, durable mode
remains Agent and the execution is not replayed.


Historical SubmitPlan/SubmitGoal rows render read-only contract cards with an
expandable exact Markdown snapshot, authoritative approval status, an artifact
opener, and a superseded badge when a later submission of the same kind exists.
The live approval bar remains the only approval surface. Host history metadata
and planning events reconcile by proposal identity/revision, so delayed pending
tool echoes cannot undo approval. Plans remain readable after continued chat,
compaction, session reselection, and host restart; deleting an artifact does not
remove the stored Markdown. Hosts without approval metadata show snapshot text
with unavailable status rather than presenting a stale pending result as truth.

Manual mode and configuration selection may be staged by the renderer while a
turn runs, but host persistence remains idle-only. Selecting Agent is an
intentional user override and does not synthesize a plan or approval. Each
session has one active turn, one pending approval, and one queued/running
execution; a second prompt or execution is rejected, while staged
configuration is submitted only after the session is idle.

`Agent / inactive` enters `Goal / planning` the same two ways, by user selection
while idle or by the Agent calling `EnterGoalMode`. Goal has the identical tool
surface as Plan, except that its submit tool is
`SubmitGoal(title, markdown, question)` and its artifact is written to
`.pi/goal/<unique-name>.md`. The submitted Markdown is a **goal contract** — the
outcome to reach, the acceptance criteria that prove it was reached, and the
boundaries that must not be crossed — not a list of implementation steps. A
submit tool is rejected with `PLAN_KIND_MISMATCH` when the session's active kind
is the other one, and with `PLAN_NOT_ACTIVE` when no contract is active.

Goal approval commits exactly what Plan approval commits: `mode = agent`, the
explicit permission mode, an execution ID, and `execution_state = queued` on the
same row. The queued execution instruction differs by kind. An approved plan is
replayed as steps to follow; an approved goal instructs the Agent to choose its
own approach, verify every acceptance criterion by running the checks the
contract names, keep working while a criterion is unmet and an untried approach
remains, stop early only when a boundary blocks it, and close with a
criterion-by-criterion report of what was met and the evidence observed.

## 5c. Thinking capability and stream contract

- Canonical levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`,
  and `max`. Session (and subagent) selectors also accept `omit`, which is
  not a catalog/binding capability: the runtime keeps agent bookkeeping at
  `off` and uses the low-level provider stream so no thinking override is
  synthesized (ADR 0194 / ADR 0295).
- The bundled Pi catalog release snapshot is authoritative for published
  reasoning support, thinking-level mapping, limits, input/output modalities,
  pricing, and other model metadata. pi-ai remains responsible for request
  serialization and adapter compatibility.
- Provider configuration cannot override published reasoning, thinking,
  limits, or other model metadata. The explicit attachment capability fields
  are the exception: `supportsImages` and `supportsDocuments` are effective
  binding overrides for the endpoint.
- Unsupported requested levels use the selected Pi catalog model's
  nearest-supported-level rule: scan upward first, then downward. A
  non-reasoning provider always resolves to `off`.
- Vision support starts from the same published model record. An absent or
  `null` `supportsImages` follows its image input; `true` or `false` explicitly
  enables or disables image transport for the configured binding. Unknown or
  custom ids remain conservative text/path models unless their binding
  explicitly enables image input.
- A model binding's optional `supportsReasoningEffort` controls the Chat
  Completions `reasoning_effort` parameter only. An absent or `null` value keeps
  existing catalog/provider compatibility; an explicit boolean takes precedence
  over automatic compatibility detection, including DeepSeek-family defaults.
  This does not enable reasoning, select a level, or change Responses/Anthropic
  request serialization. Published compatibility alone is not an explicit opt-in.
- The effective level is passed to the pi `Agent`; provider-specific request
  serialization remains pi-ai's responsibility.
- Pi `thinking` blocks become `UiMessage.thinking` and
  `message_update.deltaThinking`. They never append to `content` or
  `deltaText`.
- Append-only `message_update` events set `stream: \"delta\"` and carry only the
  new chunk. The runtime keeps the full `currentAssistant` in memory, coalesces
  deltas every 16ms, and flushes before tool/terminal/abort/error/retry
  boundaries. `message_end` is the authoritative snapshot (D412).
- The shared pi-ai Responses compatibility patch reconciles terminal items before
  this snapshot: a final reasoning summary containing only whitespace or Unicode
  default-ignorable characters (such as U+200B) cannot overwrite
  meaningful streamed thinking, and meaningful final reasoning content remains a
  fallback. An empty, missing, or whitespace-only terminal message cannot erase
  meaningful streamed answer text from the same output item. An orphan DSML
  terminal tail preserves the full streamed text, including the diagnostic tail,
  only when it is an exact suffix. Other nonempty revisions, including shorter
  answers, and explicit refusals, including blank refusals, remain authoritative;
  this is not longest-string-wins and prose is never parsed into tool calls. Item
  isolation, replay signatures, tool ordering, usage, and stop/error/cancellation
  semantics remain unchanged. See the [diagnosis](../../maintenance/responses-terminal-content-loss.md).

- Restored assistant history reconstructs separate text and thinking blocks
  before the next turn. Assistant transport identity is `model.provider` /
  `model.id` (same as live requests), not the account row id — including when
  `seedDelegateMessages` rebuilds a Task(resume) history — so same-model
  Completions reasoning stays in `reasoning_content` under a vendorKey binding.
- Restored history also reconstructs tool call/result pairs from persisted
  tool rows (`toolCallId`/`toolArgs`/`toolResult`), so a recreated runtime
  keeps its full working context — file contents read, command output —
  instead of collapsing to bare chat text (D127). An interrupted tool row
  restores as an errored result; a tool row whose assistant row was lost
  gets a synthesized call-only assistant carrier so call/result pairs stay
  well-formed for every provider API. A model system record saved while a
  call ran restores between that call and its result without ending the
  assistant's calls, so the call stays on the assistant that made it, as in
  the live request.
Vision runtimes hydrate persisted image refs only from the session-bound
attachment, scratch, and project roots. Each image remains subject to the 10 MB
safety bound, and restored history has a 30 MB aggregate raw-byte budget.
The newest refs are considered first; all eligible images remain image blocks
when the history fits, while over-budget or oversized images become safe
`@path` fallbacks; so do images whose header reports a longest edge above
8000 px (D675). A pixel-limit rejection does not consume the aggregate byte
budget, so an older image that still fits is inlined. Every provider request also replaces any image block past that
pixel limit, in user prompts and tool results alike, with a text notice naming
its size, so a session that already holds one recovers. An image whose message names it inline (`inlinePath`) is
spliced back into the prompt at that position, so a restored turn keeps the
order the user wrote. Reads are bounded by the admitted file size. Base64 is
transient and never restored into durable UI messages or transcript records.
- Failed assistant messages remain durable diagnostic transcript entries but
  are never restored into pi model context on a later turn.
- Tool-call ids remain unique in each provider request. Before Pi executes a
  streamed response, the parent runtime and each delegate assign fresh local
  ids to calls that reuse an earlier wire-visible id (the part before `|`).
  Each runtime retains its identity set across context compaction; the parent
  seeds it from the full restored transcript, and delegates keep it across
  model fallback. This prevents reused provider ids from losing real results
  when the runtime journals entries by id (issue #1815).
- The final request guard drops a repeated call only while the earlier call is
  still waiting for its result, and drops a repeated result only without a
  pending call. An independently completed same-id pair is retained under a
  fresh request-local id with its result remapped to match. A renamed Responses
  call does not reuse its old item id. No source messages are mutated; unchanged
  requests retain their identity. Drops are logged with the session and ids
  (D608). Composite result ids are aligned even without a duplicate drop.
- A replayed assistant snapshot whose calls are all pending elsewhere is
  removed whole: retaining its text would separate the call from its result
  and make pi-ai synthesize a second output (D620). A partial snapshot retains
  its new calls in place; the guard does not reorder messages.
- The agent loop owns its context array. `prepareNextTurn` hands pi a copy of
  the live state — for a delegate turn boundary too — exactly as pi's own
  `createContextSnapshot()` does for `prompt()` and `continue()`: pi's loop
  appends each streamed assistant message and each tool result to the array it
  was given, while its `message_end` listener appends the same message to
  `state.messages`, so handing over the live array stored every message of a
  run's later iterations twice. The next turn's first request was built from
  that array, and the duplicate of an assistant message carrying text plus a
  tool call survived as a text-only clone between the call and its result —
  pi-ai then closed the still-pending call with a synthesized output next to the
  real one, and the endpoint rejected the turn with
  `Duplicate tool output for call_id`. In a delegate the same doubling doubled
  the estimate at the following boundary and left the trailing row a fallback
  carries onto a model it cannot resume from (D620).
- Restored checkpoints clear provider usage from retained assistant messages
  for budgeting. That usage measured the pre-compacted request and must not
  make the summary + tail appear as large as the discarded context.
- Runtime recreation and model changes restore the newest valid checkpoint.
  Truncation keeps it only when its boundary remains in the live transcript;
  a fork copies/remaps it only when the child includes that boundary.
- A forked session receives a new session id and no shared runtime. Its first
  prompt creates a fresh pi runtime and restores context only from the child
  transcript, including the remapped tool call/result pairs.
- Message-scoped Fork stops the independent child at the selected reply.
  Editing its last turn (or the last turn of the original idle conversation)
  invalidates that session's cached runtime. Before rebuilding provider or
  delegation history, `historyForModelContext` projects version-1 context
  overrides without altering original `UiMessage` records. Excluded tool rows
  contribute neither a call nor its result. Changed text, thinking and arguments
  lose only their invalidated signatures. User-edited thinking is sent as labeled
  ordinary assistant text, never forged provider-signed reasoning. Original
  transcript records remain unchanged; affected checkpoints are invalidated.
  Legacy final-only edits still rebuild from their replaced transcript text.
- `UiMessage.excludeThinkingFromContext === true` leaves the stored/displayed
  reasoning intact but omits its thinking content from restored model messages.
  This also filters signed, redacted and encrypted reasoning blocks; text and
  function-call signatures remain where needed for tool-pair replay. The same
  exclusion applies to history-based context seeding. DeepSeek's existing empty
  or placeholder reasoning-field compatibility remains, never the excluded text.

## 5f. Subagent delegation (D201, ADR 0062, ADR 0089)

The additive [delegation observation contract](delegation-observability.md) defines
bounded lifecycle evidence, diagnostic-only non-progress observation, historical
usage/timing measurements, and approval sound hydration/preview semantics.

The session Agent can hand separable pieces of work to delegates that run in
their own context, in the background, and report back on demand.

**Unified scheduling policy.** Settings → Subagents → Scheduling stores optional
`AppSettings.delegation` version 1. Its model rows identify exact provider/model
pairs, enabled state, priority 1–100 (lower first; ties allowed), `auto | ask`
approval, and selection guidance up to 1000 characters. The pool contains at most
128 unique pairs. `approvalTimeoutSeconds` is an integer 0–300; zero skips
approval-required candidates for unattended work. New/default settings seed 300
seconds; existing saved values, including zero, are never rewritten. Invalid
settings are rejected by Host without overwriting the saved policy. Until the
first save, legacy opt-ins and definition defaults remain unchanged. After save,
the enabled pool governs defaults, explicit choices, pins, resume and fallback;
the legacy model checkbox becomes a link to this single source of policy.

Saved policy, catalog availability, descriptions and priorities apply to later
Task admissions in the same long parent turn, later resumes, pending approvals
and naturally triggered fallback. The additive `provider.delegationSnapshot`
callback returns `DelegationPolicySnapshot` (`settings?`, opaque string `revision`,
`modelKeys`, optional derived `selectionMode: "task-fit"`); runtime resolves model
keys independently. Refresh runtime authority at a provider-request boundary,
never by rewriting an in-flight payload. The full directory is returned only by
the read-only `TaskModels` tool when the parent is preparing delegation; it is
absent from the system prompt and the Task declaration.
Already-started children retain their provider and resolved execution policy;
saving settings neither interrupts/recreates them nor forces a model switch.

Task's declaration carries the role catalog and a short instruction to query
TaskModels as needed. A batch may reuse the retrieved descriptions. A custom
session pool requires an explicit model and concise `modelReason` for each new
Task, and honors task fit ahead of numeric priority. Missing session overrides
retain global/legacy ordering. `modelSelection: prefer | require` defaults to prefer; require never
substitutes another model. Optional `minContextWindow` and `requiresImages` filter
candidates before approval. These model-authored fields do not grant permission.
`minContextWindow` accepts an integer from 0 to 10000000: zero and omission
both mean no minimum. The scheduler validates it before considering models
and normalizes zero to omission at the authorization boundary. Host metadata
accepts only an omitted value or a positive safe integer within the same upper
bound. Invalid input returns `DELEGATION_INVALID_REQUEST`; it is not retried
against every model or presented as an exhausted authorized pool. The Host
returns `invalid` for malformed metadata and `unavailable` when its authorizer
is absent, preserving distinct scheduling decisions.
Natural-language model choices continue through `Task.model`; when the chosen
model requires approval, only the host's human UI decision grants it.

The independent host model gate applies even in Auto mode and rereads policy
before use and after waiting. Approval is scoped to this invocation and exact
provider/model; resume needs fresh authorization. The dedicated core approval
center exposes `allow` (displayed candidate once), `skip` (authorized alternative),
`select` (exact picked provider/model), and `cancel` (end this invocation).
Runtime independently resolves and validates a selected target against current
authority and capabilities; failure never silently chooses another model, and
`modelSelection: require` never permits substitution. Model-authored text cannot
grant consent. Ordinary plugin/extension prompts cannot impersonate core consent.

Each request has one host-owned deadline. Manual extension adds exactly 300
seconds to that live deadline without changing settings. Viewing, scrolling,
collapse or new arrivals never renew it. After expiry, only compatible candidates
already authorized by `auto` may run in the same Task; otherwise return a clear
timeout result, without starting another full approval wait. Runtime decisions
carry an additive machine-readable `code` and optional `selectedModel` identity;
reason prose is not used to distinguish consent, timeout or cancellation.
Explicit cancellation and Stop never authorize fallback or same-task retry.
Collapse/close/Escape only hide the center and send no denial. Host rechecks
request state, deadline, revision and current eligibility before granting consent
or extending; expired, cancelled, replaced or stale requests cannot revive work.

Acknowledged approval is distinct from waiting for capacity or execution start.
Provider fallback keeps successful tool history and checks the next model before
any request. `Task` results and settlement snapshots record requested model, original
`modelReason`, and selection/skip reasons in additive `scheduling` details.
Ordinary delegation views display the original explanation separately from
actual model identity and scheduling decisions; old records never acquire an
inferred explanation. Main conversation model
selection and ordinary tool permissions are unchanged. Plugin collaboration
uses the same model gate; an existing target session is not silently rebound.
See [the scheduling ADR](../../adr/delegation-scheduling-and-approval.md),
[core IPC](01-ipc-protocol.md#52c-delegation-model-approval) and
[approval UX](../04-ux/03-permission-ux.md#9a-delegation-model-approval-center).

The remaining legacy selection/fallback rules below apply when no unified
policy has been saved; under a saved policy, its membership and approval rules
take precedence.

**Catalog.** Definitions are Markdown documents from two sources: the five
builtins shipped inline in `agent-runtime` (`explorer`, `code-reviewer`,
`test-runner`, `fixer`, `ui-designer`) and the global user documents under
`~/.agents/subagents/*.md`. There is no project-level subagent directory and
`.pi/agents` is not scanned for capabilities. User documents are filtered by
the app-local enabled state before they reach the loader, and the shipped
builtins are filtered by that same app-local state inside it (ADR 0270).
Electron main loads
`subagentProviders` in the sidecar params; definition edits take effect on the
next catalog load. Saved scheduling guidance and model availability also refresh
at the request/admission boundaries above. The catalog uses
`AppSettings.delegation.limits.maxDefinitions` (integer 1–128, default 16).
Each launch merges unique names with user definitions before builtins, then
caps the catalog and diagnoses dropped names; files are never deleted. This is
a role-menu limit, not cumulative Task creation or a window-wide quota.
A malformed or unreadable document becomes a launch diagnostic, not a launch failure.

Frontmatter adds `permission: inherit | ask | accept-edits | auto` (default
`inherit`), which controls the scope the delegate's tool calls resolve under
instead of the session mode (§5f.1). `tools: inherit` (alone or with assignable
extras) opts a definition into the parent session's live tool catalog minus a
deny list (ADR 0246 / D415). Fixed-tool definitions, including builtins, also
receive `Skill` when present in the parent catalog, without any other implicit
tool inheritance. Optional frontmatter `skills` restricts the direct child
catalog and loader to the selected exact IDs intersected with the parent's
available skills; omission inherits all and `skills: []` selects none, even
with `tools: inherit`. Unknown IDs remain inert; malformed IDs/lists are
rejected, IDs are trimmed/deduplicated, and selections are bounded to 256 IDs
of 1–256 ASCII characters (letters/digits plus `._:/-`, starting alphanumeric).
The executor refuses non-selected or no-longer-available IDs before the Host
load. Settings reuses the workspace-scoped composer skill source, keeps missing
saved IDs removable, and saves `skills: null` to restore omission; absent RPC
input preserves the list on update. Skill allocation never grants executable
plugin/MCP tools or bypasses Host checks (ADR 0246). Bodies load on demand.
`idle-timeout` and `max-duration`
still parse for compatibility but no longer kill a run
(D328). Only builtin and user definitions may declare a permission scope —
both express a choice the user already made, whereas a project definition
arrives with the repository, so honoring its scope would let cloned code grant
itself `auto`. A project document that declares a non-`inherit` scope keeps
loading with a warning and its delegates run under the session's effective
mode; a user who wants the scope copies the document into their own agents
directory. Builtins, including the write-capable `fixer` and `ui-designer`, do
not override the parent session by default: they follow `auto` completely
(including explicit external paths) while `ask` and `accept-edits` retain
their normal approval behavior. An explicit builtin or user scope remains an
intentional override.

**Tools (ADR 0089).** Task requires a non-empty effective role catalog. Its
job controls belong to the core set, not the on-demand catalog of §7.1.
Execution requires an agent-level mode or stage:

- `Task(agent, task, description?, model?, effort?, resume?, userRequest?, scope?)` — validates its arguments (an
  unknown `agent`, an empty `task`, an unresolvable model pin and a definition
  whose tools are all unavailable each return a tool error explaining the
  failure rather than throwing), starts the delegate **in the background**, and
  returns immediately with a `delegationId`. Starting fails with a tool error
  when the session reaches the current `delegation.limits.maxConcurrent`
  (integer 1–64, default 10). It counts only running delegates in that session;
  completed/stopped tasks free slots, and later Tasks can keep being created.

  The optional `limits` object extends the existing version-1 settings JSON.
  Missing fields keep 16/10 without rewriting old settings or changing the
  database schema. Renderer/shared and Host validate integers and reject null,
  unknown keys and out-of-range values. The live policy snapshot carries limits;
  Task rechecks concurrency after model authorization. Lowering the saved cap
  never stops active tasks; it blocks new starts/resumes until enough retire.
  Catalog capacity applies on the next Desktop runtime launch/catalog preview.
  Task guidance exposes the effective concurrency cap. Global history retention,
  model authorization, child work budgets and standalone headless launch policy
  remain unchanged.

  The `Task` tool accepts an optional `model` parameter
  (`"provider/modelId"`) that overrides the delegate's model for that run.
  Resolution priority: Task.model parameter → definition frontmatter pin →
  session model. The parent reads a model directory through TaskModels when needed,
  listing models marked `availableForSubagents` in provider settings. The
  empty-catalog TaskModels result and Task description explain default-model
  behavior. The rejected-override error points to Settings → Models → edit
  service/account → model Advanced → "Available for AI delegation" → save,
  and requires an exact catalog key
  rather than guessed provider/model keys. If
  the delegation catalog is empty, the prompt tells the model to omit `model`
  and use the definition pin, or inherit the session model when unpinned; an
  explicit key that exactly names the current session provider/model is treated as the same inheritance case. Other
  explicit model keys must be configured and enabled for delegation. Electron
  sends `subagentModelKeys` separately from `subagentProviders`: the latter may
  include definition-only pins, while only the former authorizes cached
  overrides and the model summary. Missing keys default to an empty list;
  successful on-demand resolution is cached separately from launch opt-in and
  does not rewrite definition pins or runtime reuse matching. Grants expire at
  each new parent prompt or approved plan/goal execution; late responses from
  an older turn cannot repopulate the cache. On-demand
  provider matching uses the same unique id/vendor/name rule as pin resolution.
  A changed opt-in list retires the idle runtime on the next launch. Pins remain usable
  by their own definitions when `model` is omitted or when `Task.model` repeats
  that definition's own pin key, even without an opt-in.
  The Task definition catalog displays each default model and treats omitting
  or repeating that key as keeping the default. See
  [ADR subagent-model-opt-in](../../adr/subagent-model-opt-in.md).
  For a YAML mode bundle, the private role list is the entire default catalog.
  Explicit global inclusion adds only active, project-authorized definitions;
  private names win. A role pin is not a dispatcher permission: switching away
  from a private role's primary pin requires explicit approval for that task,
  in addition to model availability. Each fallback may select its own thinking
  level. Neither the bundle nor a task can change the parent session model.
  Electron Main keeps the bundle in the catalog and complete Host snapshots.
  The sidecar receives the mode's execution definition without bundle metadata
  on prompt dispatch and run release; resolved skill and subagent catalogs
  travel separately on launch.
  When a model key is not pre-resolved, the runtime asks Electron main to resolve it
  on-demand via the `provider.resolveSubagentModel` RPC. The started `Task`
  result details record the effective `modelId` and resolved `thinkingLevel`
  used for that run. For a new or resumed invocation, an explicit role level
  (including `omit`) wins over optional `Task.effort`, which otherwise overrides
  the parent session level for this invocation only. The parent's level is not a
  ceiling. Approval uses the requested selection, and each admitted model clamps
  it independently; `omit` records that no provider thinking override was sent.
  A resumed chain reuses its recorded requested model, model-selection rationale,
  and requested effort when the new `Task(resume)` omits those fields; the active
  model may still clamp the requested effort to its capabilities. The Task result
  records `resumedFrom`, so renderer history presents the run as a continuation,
  not a new unrelated delegation. A resumed chain retains its original role and
  write boundary. An explicit `model` on resume may confirm the recorded
  binding, not replace it. For a scoped chain the recorded binding and role
  must still be authorized; if either is unavailable, start a new Task rather
  than attach its history to a different model or a broader role. Legacy
  unscoped chains retain their existing approval and fallback rules.
  When the user names an expert, `userRequest` contains only the original words
  addressed to that expert. `task` supplies the coordinator's separate context.
  A quote does not grant permission. A new task may set `scope.write` to a list
  of workspace paths. Omission preserves existing access, an empty list denies
  all writes, and opaque tools are withheld when their writes cannot be checked.
- `TaskSend(delegationId, instruction)` queues a correction for the same running
  child in this conversation. `TaskList` and `TaskWait` distinguish queued,
  delivered at a child boundary, and undelivered at cancellation or settlement.
  Sending a correction never replaces the role, its model, or its permissions.
- `TaskWait(delegationIds?, mode?, minCompleted?, timeoutSeconds?)` — converges
  on running delegations (defaults to all of them) and returns their reports;
  `mode: "any"` with `minCompleted` converges as soon as the first N settle.
  Settled delegations return immediately, so re-reading a report by id is
  cheap. The joined result is bounded to `MAX_TASKWAIT_RESULT_CHARS` (50k); if
  the bound omits finished reports, those reports remain undelivered and the
  runtime sends them on the idle resume (or they can be re-read by id).
  `timeoutSeconds` defaults to 600 and is clamped to 900: the wait blocks the
  turn, so the ceiling is what bounds how long a session can look hung. Expiry
  is not a failure and does not stop the delegates (D328) — the wait returns a
  heartbeat (agent, status, elapsed, turns, last tool) plus any finished
  reports. The runtime keeps the parent turn open and delivers remaining
  reports when they finish, even if the parent already stopped calling tools.
  TaskWait expiry does not spend or reset the separate delegate work budget.
- `TaskList()` — reports every delegation of the session with status and a
  running heartbeat, plus the resumable chains (`details.resumable`) the parent
  can continue with `Task(resume: ...)`; this is the only read path for that
  list (ADR 0337).
- `TaskStop(delegationIds?)` — stops running delegations (defaults to all);
  waits for each abort to settle, then persists `status: "stopped"` with
  `completedAt` on `details.stopped[]`. Stopped delegations read as `stopped` and remain available through `Task(resume: ...)` when their transcript history is retained.

**Explicit desktop cancellation.** A running delegate can be stopped from its
card or detail panel. The subagent group header also offers session-wide stop-all.
These controls call the same cancellation routine as `TaskStop` without a model
round trip. Cancellation is cooperative: the UI shows a pending state until
termination is confirmed, preserving partial output and existing parent Stop
semantics. A completed delegate is not relabeled by a late stop request.

**Live settlement.** When a delegate settles, the runtime refreshes its original
`Task` transcript row with the terminal delegation summary (`status`,
`completedAt`, counters, and failure details when present), using the existing
full `message_end` snapshot. This does not depend on the parent calling
`TaskWait` / `TaskList` / `TaskStop` or on other delegates finishing. The
snapshot retains the Task call's identity, arguments, tool timing, and token
usage; it does not execute the tool again or add usage to the parent turn.
The initial Task result is emitted first even if the delegate settles before
that result arrives. Electron persists the refreshed row through the normal
message outbox so session switching and history reload preserve the outcome.
An outbox write acknowledges only the snapshot sent to the host; a newer
snapshot replacing the same message ID during that write remains queued.
No new event type or storage schema is required.

**Delegate loop.** A `SubagentRun` is a second pi `Agent` in the same sidecar
process with the definition's system prompt, its (possibly pinned)
provider/model, its declared tools, and the same host connection. A pinned or
explicitly selected delegation model uses the exact provider/model binding
saved in Settings for its effective thinking capability; Pi catalog supplies
the baseline only. It runs under
the same bounded provider retry policy as the parent. User-authored
`idle-timeout` and `max-duration` values do not terminate a run, but each run
uses the optional resource limits below (both work limits are disabled by default). Reaching a configured
ceiling stops new work-tool admission. The call budget lets already admitted
tools retire; the duration budget requests cooperative cancellation. The
runtime then allows one tool-free report request with the configured deadline (default 60 seconds),
without retries or model fallback, and settles `failed` with
`SUBAGENT_BUDGET_EXHAUSTED`. All model-requested tool admissions, including
optional TaskReport calls, spend the configured tool budget. Automatic state
persistence does not. User Stop cancels immediately and never starts that extra request.
`Task(resume: ...)` starts the
next run with a fresh safety budget. A delegate otherwise ends when it finishes,
when the parent calls `TaskStop`, when the user Stops, or when a terminal parent
error aborts it (ADR 0253). A document that
still declares `maxTurns` loads normally and the key is ignored like any other
unrecognized frontmatter key. `maxTokens` is an optional per-definition
output cap (maximum 200000); omitted, `none`, or `0` follows the model's
published limit. It overrides `maxTokens` on the model built for that delegate,
so the adapter's derived `max_tokens` / `max_completion_tokens` /
`max_output_tokens` carry it, and it binds that delegate's own responses only —
the session's requests keep the model binding. A value past the ceiling is a
typo and is clamped rather than forwarded to the provider.
The built-in `explorer` declares `Read`,
`Glob`, `Grep`, and `Bash`, while `code-reviewer` remains read-only;
`fixer` and `ui-designer` write inside the workspace, and `ui-designer` adds
`BrowserPreview` so it can open and inspect its rendered result before reporting.
`BrowserPreview` only opens a live-reloading workspace HTML page; responsive,
keyboard-focus, and reduced-motion checks require project-provided browser
tests or other tooling. Its statuses are `completed`, `failed`,
`aborted`, `timed_out` and the registry-only `stopped`;
the terminal ones surface through `TaskWait`, whose text is
the report (bounded to `MAX_SUBAGENT_REPORT_CHARS`, 12k; when exceeded, persisted to session scratch with a pointer notice per ADR 0062) and whose details
carry `delegationId`, `agent`, `modelId`, `thinkingLevel`, `status`, `startedAt`,
`completedAt` when settled, `turns`, `toolCalls`, and `scratchReportPath` when
the report was saved to scratch; on failure or timeout they carry
`error` (including resume ID hints on `SUBAGENT_OUTPUT_TRUNCATED`), plus
`checkpointPath` when the session scratch is available and `checkpointError`
when the best-effort checkpoint write failed. The same effective model and
thinking fields are included in the
immediate `Task` result and in lifecycle snapshots so live and restored
delegation views do not re-derive them from definitions or parent settings.
`startedAt` and `completedAt` are runtime timestamps in milliseconds and are the source of
truth for renderer delegation duration; the immediate `Task` tool-call
duration only covers starting the background work.

**Progress reports and bounded lifetime (ADR 0279 amendment).**

Settings → Subagents → Scheduling → Execution and recovery stores optional
`AppSettings.delegation.runPolicy` fields within the existing version-1 policy.
Absent fields use the shared visible defaults; merely opening Settings does not
write them. Rust and TypeScript reject unknown keys, null, fractions and out-of-range
values without changing the saved policy. No SQLite migration or IPC channel is added.

| Field | Default | Allowed values |
| --- | --- | --- |
| `maxToolCalls` | 0 | integer 0–10000; 0 disables the work-tool admission limit |
| `maxDurationSeconds` | 0 | integer 0–21600; 0 disables the exploration deadline |
| `finalReportTimeoutSeconds` | 60 | integer 1–300 seconds for the one final report request |
| `reportRecoveryAttempts` | 0 | integer 0 or 1; 1 permits one report-only recovery after ordinary termination without a deliverable |

The retired trial fields `checkpointInterval` and `maxCheckpointRequests` remain
accepted as legacy data so old settings and checkpoint files stay readable. They
are ignored by execution, omitted from resolved new task snapshots, and removed
on the next settings save. Existing explicit call/time limits are preserved;
changing defaults does not overwrite a user's saved budget.

Each new or resumed Task captures an immutable resolved snapshot of the current
saved policy at admission, including within an already-running parent turn.
Active children keep their starting values; provider fallback does not reset
them. A resumed Task uses current settings, not an old checkpoint's policy. Immediate Task,
TaskList, TaskWait, settlement and checkpoint metadata carry the full effective
`runPolicy`. The child detail tab renders that snapshot, never current global
settings; missing/incomplete historical snapshots remain absent. The parent and
child model instructions also describe the effective policy. These execution
limits apply to Task delegates; other delegation routes retain their execution
behavior and continue to use the independent model authorization policy.
Historical snapshots containing the original three execution fields remain
valid; an absent `reportRecoveryAttempts` is not invented as a recorded old
policy. Newly admitted runs resolve it to 0 unless explicitly enabled.

### Delegation admission failure reminders

Exhaustion of authorized compatible models returns one failed Task result with
additive `details.code: "DELEGATION_NO_AUTHORIZED_MODEL"` and
`details.scheduling: { requestedModel?, decisions }`. Decisions preserve the
scheduler's existing reason/selection metadata. Explicit Stop/cancellation has
no such classification. Selection order, approvals, deadlines and automatic
fallback behavior remain unchanged; no child provider request starts on failed
admission. The application observes this structured result once and applies
core notification preferences. Agents gain no notification tool, retry or todo
obligation, and notification failures never resubmit a Task or provider request.

The child-only
`TaskReport({ report })` tool accepts up to 32000 characters describing findings,
evidence, checked scope, remaining work, and next steps. It grants no general
filesystem capability. This summary tool is optional: ordinary work never waits
for a periodic report, and there is no missing-report counter that terminates a
working agent. State persistence at event boundaries is independent of model
summarization. A failed optional scratch write is returned as a reporting warning;
the report remains in the transcript and work may continue. A terminal report
must come from the current assistant response, end normally with `stop`, contain
non-empty text and request no tools. Earlier progress narration, optional
TaskReport text and earlier model-failure explanations remain recovery evidence;
they cannot satisfy final delivery on behalf of an empty or thinking-only
response. A tool-call ending without calls is not successful delivery either.
Finish/truncation classification is independent of the amount of visible text.
This is a structural delivery check, not a semantic evaluation of task quality.

If `reportRecoveryAttempts` is 1, ordinary termination without a deliverable
may spend one report-only request using the already-authorized model and
retained context. The same `finalReportTimeoutSeconds` deadline applies. This
request exposes no tools, performs no provider retry, repair or model fallback,
and never replays completed tools. A valid recovered final report can complete;
otherwise settlement remains failed and partial. Explicit cancellation and
terminal provider/local failures never start this recovery. Budget exhaustion
keeps its existing one-report closure and `SUBAGENT_BUDGET_EXHAUSTED` result;
it does not additionally spend ordinary report recovery.

Live turn and tool counters reflect the child loop while it runs, without
forwarding child turn-end events as parent lifecycle completion. Counts, paths,
read-only exploration and elapsed time alone do not establish semantic progress.
Only user-configured work budgets bound a running delegation; zero remains
unlimited. No periodic TaskReport duty or automatic quality evaluator is added.

Local runs save version-1 `checkpoint.json` and `report.md` beneath
`<scratchDir>/delegations/<stable-chain-id>/` at startup, assistant/tool boundaries,
and settlement. The JSON is authoritative; both files use separate atomic
replacements, not a two-file transaction. Snapshots include task/run/session
identity, counters, the saved report, effective run policy, partial status and termination reason.
Existing context-compaction summaries also join the recovery report as plain
text, without another model request. The host-owned transcript retains the
underlying tool history; the scratch report supplements it.
Pending tools are labeled as requiring verification, never assumed undone.
Task lifecycle snapshots expose the live checkpoint path and safe write errors.
Terminal snapshots retain a small `terminal` diagnostic: normalized stop reason,
an allowlisted raw stop reason when known, text/thinking/tool block counts,
provider retry count,
report outcome and report-recovery attempt count. These facts travel with the
existing Task lifecycle/result record and checkpoint, not empty assistant
bubbles or raw provider payloads. Child details can distinguish requested and
actual model, selection/skipped attempts, fallback failures and final delivery.
No thinking text or credentials are copied into this diagnostic. Historical
records without these fields remain readable without inferred measurements.
TaskStop returns retired workers' partial reports along with status. It still
reports uncooperative workers as pending, not stopped.

The child model's workspace write scope does not disable these runtime-owned
recovery files. A report supplies content, not a filesystem destination or new
permission; a scoped or read-only child still cannot write an arbitrary path.

Scratch restoration accepts only the expected session/agent/chain/run and a
bounded regular JSON file, rejecting escaping links and unknown formats. It
never restores arbitrary serialized context or authority from that file. Missing
or invalid scratch falls back to retained transcript; a missing transcript AND
checkpoint fails visibly. Remote runs have no local scratch and keep transcript
reports only. Checkpoints are session artifacts, removed with session scratch.
Legacy idle/max-duration/maxTurns frontmatter remains ignored; the runtime work
budgets above are independent. Cancellation never automatically resumes a chain.

When the parent stops calling tools while delegates are still running, the
runtime swallows that `agent_end`, keeps the durable turn open, waits for the
delegates, and prompts the parent with their reports. Every terminal result
resolves the parent wait before best-effort transcript publication; a failed
`SubagentRun` initialization returns a tool error and never leaves a running
record. User Stop and runtime disposal also abort the parent wait signal, so
they can end the parent turn even if a delegate ignores its abort. Ending the
parent loop does not otherwise abort delegates.

Fatal provider/stream errors (including exhausted HTTP 429) and parent aborts
retain their existing `failed` and `aborted` outcomes. A latest terminal response
at the provider's output-token limit (`stopReason: "length"` or `"max_tokens"`),
including with no text, settles as `failed` with `SUBAGENT_OUTPUT_TRUNCATED` and
`outputTruncated: true`; its bounded partial report remains under the failure
explanation for diagnosis. A subsequent recovery response is classified on its
own finish state; a valid normal final report can complete, while a new error,
missing report or cancellation keeps its corresponding outcome. A
terminal parent error also aborts leftover delegates, skips the resume prompt,
and returns the session to idle so Continue is not `AGENT_BUSY` (D352). The
interrupted delegates settle as `failed` with `SUBAGENT_PARENT_FAILED` and keep
their transcript-backed resume eligibility. On the user's next ordinary Agent
prompt, the runtime rejoins only that preceding failure's interrupted chains,
using the same resume admission as the retry control. It waits for old workers
to retire, preserves completed tools and validated checkpoints, and gives the
new parent turn the recovery identities and eventual reports. Restored sessions
select only SUBAGENT_PARENT_FAILED tasks in the latest failed parent turn;
unrelated failures, older turns, completed tasks and cancellations are excluded.
No provider request is made automatically at failure time or on application boot.
Aborted and stopped delegates remain explicitly resumable; cancellation never
automatically restarts them. SubagentRun terminal results save the retained
partial output when local scratch is available; initialization failures before a
child exists retain the existing visible error path.
See [the terminal reliability ADR](../../adr/delegation-terminal-reliability.md)
for the delivery, admission and optional recovery trade-offs.

**Resumable delegations (ADR 0279).** `Task` accepts an optional `resume`
parameter carrying the `delegationId` of a settled delegation in the same
conversation. The resumed delegate is a new `SubagentRun` seeded with the
chain's prior messages — the original `task` brief plus every row the chain
produced — and then prompted with the new `task`, so a delegate that already
read or changed a file continues from that context instead of starting cold.
Seeding is transcript-backed: the chain's rows are exactly those carrying
`parentToolCallId` for one of the chain's `Task` calls, and they are converted
into provider messages with the delegate's own binding (a pinned delegation
model is not the session model). A validated scratch report supplements this
seed and can replace missing child rows, but the original Task record is still
required. Completed tool calls are history, never automatically executed again.
No SQLite schema, IPC channel, or parent Task parameter changes are needed.

A chain is the sequence of `Task` calls that share one delegate session: the
first call, plus every later call that passed the earlier `delegationId` as
`resume`. The runtime rebuilds the chain index from the persisted transcript at
launch — each `Task` row carries its own `delegationId` and settled status in
`toolResult.details` and the resumed id in `toolArgs.resume`, with the agent
name normalized on rebuild — so resumability survives a sidecar restart.
Chain identity (`delegateSessionId`) stays internal; the parent only
ever passes a `delegationId`, and the reverse map resolves it.

`completed`, `failed`, `aborted`, `stopped`, and `interrupted` chains are
resumable; a resumed run is always a new `SubagentRun` seeded from the retained
transcript and validated checkpoint and receives a fresh work budget. Cumulative
read volume is telemetry, not a resume veto: the existing seed/context budget
trims old call/result pairs together to fit the selected model. The registry keeps at most
`MAX_RESUMABLE_CHAINS_PER_AGENT` (2) reusable chains per definition name and
evicts least-recently-active ones whenever a delegation settles; a chain that is
still working is never evicted, so the bound counts reusable chains and a live
chain may sit above it until it settles. `TaskList.details.resumable` lists current
candidates (latest ID per chain); historical Task results alone do not. A
retained chain still accepts its earlier IDs and must pass normal admission.

When the chain lookup misses, an issued ID in this runtime's delegation records
or a parent `Task` result in this session's transcript proves prior existence,
not why the chain is missing. The failed `Task` returns the existing
`details.error` plus `details.code: "DELEGATION_RESUME_NOT_RETAINED"`. Without
that evidence it returns `DELEGATION_RESUME_UNKNOWN`, including for foreign IDs;
requested IDs in tool arguments or error text are not evidence. Neither result
issues a `delegationId`, starts a replacement, or replays tools. Check current
candidates for the intended objective or use prior findings. Legacy errors
without a code remain valid; a failed child run keeps its own ID and outcome.

Resume is strictly same-session and never queues: resuming a running
delegation is a tool error telling the parent to converge with `TaskWait`
first, and a chain has at most one live record at a time. Prefer omitting `model`
on resume. A nonempty `model` is accepted only when it exactly repeats the
chain's retained `providerId/modelId` key (after trimming outer whitespace), or,
for a transcript-restored chain without that key, the binding independently
resolved by the existing resume rules. That redundant field is not a model
override and cannot influence provider resolution, selection, or authorization.
A different model, another account with the same model id, a bare model id, or
an unverifiable identity is a tool error directing the caller to omit `model`
or start a new delegation. The chain's recorded binding remains preferred and
reauthorized on demand when its turn grant has expired. A chain rebuilt from the
transcript is matched
by model id only among the current definition pin/fallbacks, the session binding,
and currently authorized overrides. Other definitions' private pins are excluded.
A known key never falls through to another account just because its model id
matches. When nothing authorized resolves it the run
continues on the definition's current binding and records the previous model id
as `modelChangedFrom` in its lifecycle details. Changing models on purpose means
starting a new delegation. An unknown id, an id belonging to another definition,
an unsupported status, and a chain with neither retained rows nor a checkpoint
each return a tool error naming the reason and, for an unknown id, the reusable
ids when there are any. After restart, TaskWait can read a persisted terminal
report or a matching checkpoint without launching a child; a formerly running
record is reported as interrupted and partial.
TaskWait and the idle-delivery path append an explicit `Task(resume: "<id>")`
hint to failed reports; if the existing resume validation rejects the chain for
missing history, the hint directs the parent to start a new delegation instead.

The parent discovers reusable chains through `TaskList`, whose result lists
each chain's latest `delegationId`, its objective, and up to
`MAX_RESUMABLE_LISTED_FILES` (8) of the files it read (with a `(+N more)`
suffix past that). The list never enters the system prompt: it changes on every
settlement, and rewriting instructions mid-session invalidates the request
prefix providers cache on (ADR 0337). A resumed run is an ordinary delegation for
`MAX_SUBAGENT_CONCURRENCY`, `TaskWait`, `TaskList`, `TaskStop`, and lifecycle
snapshots. The immediate `Task` result and the lifecycle details add
`resumedFrom` for audit; the transcript renders a chain as one continuous
multi-turn conversation under its latest `Task` card, with no separate
"resumed" marker.
The Desktop-only `agent/retry-subagent` control can force a retry of a settled
`failed` chain without asking the parent model to emit another `Task` call. An
active parent turn admits the retry in place without resetting its configuration,
input or usage. An idle session creates a new durable recovery turn. Both paths
emit a synthetic `Task` row and use the same authorization, worktree, history,
and context-budget gates. Automatic recovery and repeated clicks share one
chain admission; an already recovered run is returned instead of duplicated.
The retry is available only for local failed delegations with retained history;
missing-history, remote, and native sessions remain unavailable. A stale active
turn identity is rejected, never silently replaced with a new turn. Pending
authorization keeps the owner alive until admission or rejection settles. A
budget-exhausted run is a failed delegation and can use the same retry/resume
path when its history remains available. While that child runs, the same durable
turn accepts parent steering without cancelling it or starting a second parent
loop. Child settlement delivers its report once to the parent continuation,
which incorporates the result and finalizes the durable turn exactly once.
Steering admitted during settlement is retained; explicit Stop still cancels
the child and joins cleanup without starting a parent continuation.

**Model pins.** `model: <provider>/<model>` in the frontmatter is resolved once
per launch in Electron main, where credentials and the Pi catalog snapshot live, against
provider id, vendor key or display name, and capped at
`MAX_SUBAGENT_PROVIDERS` (8) distinct providers. An unresolvable pin is omitted
from the binding map on purpose; the runtime turns the missing entry into a tool
error naming the pin, and never falls back to the session model. A definition's
`thinkingLevel` is clamped against the resolved model with the same
nearest-supported rule as §5c, except that the special `omit` value deliberately
sends no thinking override and leaves the provider adapter's own default in
control.
`agents.create` and `agents.update` accept the pin only in that
`<provider>/<model>` shape; a value without a provider half is rejected with
`SUBAGENT_INVALID` rather than written, because the runtime could never resolve
it. Only the slash is structural — the provider half is matched by a normalized
alias, so a display name containing spaces is valid.


**Ordered model fallback.** A definition may declare `fallbackModels` as an
inline list (`fallbackModels: [provider/model, other/model]`) or a block list.
The managed host `agents.create` / `agents.update` inputs and records expose
`fallbackModels?: string[]`; omission preserves a list on update and `[]`
clears it. Existing `model` pins and Task override priority remain unchanged.
A missing primary pin still fails before launch. Alternatives are resolved in
Electron with the definition pins and count toward the existing eight-provider
ceiling. They authorize only that definition, including when Task overrides
its primary, and do not enter the independent `Task.model` opt-in catalog.

After a provider failure exhausts that model's retries, or is non-retryable,
the same child Agent advances through these alternatives in order. Actual
provider-id/model-id duplicates are skipped; an unresolved alternative is
reported and skipped. The runtime removes only the terminal failed assistant
from model context, preserving the original user task and completed tools,
then continues with the next provider's adapter, credentials, request headers,
output cap, and re-clamped original thinking selection. `omit` stays omitted.
The completed tool history is never replayed by the fallback controller.
Host/tool failures, unexpected thrown errors, no-report outcomes, and Stop do
not trigger fallback. The run's original owner and abort signal govern every
attempt, and usage/counters include all attempts. No configured alternatives
means the existing single-model behavior.

Failure diagnostics remain in the child transcript, bounded parent report,
and additive `modelFailures` lifecycle detail. Lifecycle model/thinking fields
track the effective alternative, including after settlement and reload. If all
alternatives fail, the result remains `failed` with the final provider error.
See [ADR subagent-model-fallback](../../adr/subagent-model-fallback.md).

**Context budget and compaction (ADR 0299, D623).** A delegate has the same
window protection the session has, derived the same way. The budget comes
from the model the run actually resolved — a `Task.model` override, a
definition pin, or the inherited session model — through the shared
derivation of §5.1, so `hardLimit` is that window minus the same request
headroom and a per-definition `maxTokens` cap participates as the output
budget. At a delegate turn boundary the run re-estimates its own context and
starts compaction at `floor(hardLimit * 0.9)`, before the next provider
request. A compaction result must still fit below `hardLimit`; that remains
the non-negotiable provider-request guard. The retention mode follows the
same lifecycle rule as the session, and there is no pre-computation.

When a summary cannot be generated or installed below the hard limit, the run
degrades: it keeps the original task brief plus the most recent message(s),
discards the rest of its history, continues, and records that it was degraded,
so the report and lifecycle details say the delegate lost history rather than
presenting a complete answer. Empty or whitespace-only extracted summary text
(including a thinking-only or output-limited reply with no text blocks) counts
as "cannot be generated" — it must not install an empty successful checkpoint. When even that does not fit, the run fails with
`SUBAGENT_CONTEXT_OVERFLOW` (not retriable) naming what the parent can change —
narrow the task, delegate to a model with a larger window, read less at once —
instead of forwarding the provider's overflow text.

An ordered alternative (**Ordered model fallback**, above) is re-evaluated
against its own window before it is attempted: an alternative whose budget
cannot hold the carried context is skipped and recorded in `modelFailures`
with that reason rather than retried into the same failure. A resumed chain
is seeded within the budget — `seedDelegateMessages` preserves the original
task brief and the recent turns and drops the oldest tool results first — so
a resume starts below `hardLimit` instead of overflowing on its first
request.

The delegate's working-context rewrite remains local. It rewrites no
persisted transcript row, writes no host-core checkpoint, and adds no
compaction row, warning toast, or context-inspector line; the delegate keeps
its complete visible rows and the parent still sees only reports. Delegate
compaction is entirely automatic; no model-facing compaction tool exists.

**Events and context.** Every event a delegate emits carries
`parentToolCallId` and `agentName` on its envelope, and Electron main copies both
onto the persisted row. When the runtime rebuilds model context it skips every
row with `parentToolCallId`: the parent only ever saw reports through
`TaskWait` or the runtime's completion prompt (D328), and replaying delegate
rows would both contradict that and reintroduce the context cost delegation
exists to avoid.

**Turn ownership.** A delegate's lifecycle never reaches Electron main's turn
handling. The parent may keep working or talk to the user after `Task`. If it
stops calling tools while delegates still run, the runtime keeps the durable
turn open and delivers the reports when they finish. User Stop, `TaskStop`,
runtime dispose, or a parent fatal error (D352) abort a still-running
delegate.

**Isolated worktrees (ADR 0329).** In an isolated session, a delegate whose
tools include `Write` or `Edit` gets its own worktree before its first turn
(`worktree.delegate.create`, keyed by the delegation chain id, so a resumed
delegate reuses it), and its `tools.execute` calls carry that id as
`delegationId`. When the run ends the runtime calls
`worktree.delegate.settle` before publishing the report: a completed run is
merged back into the session worktree, a failed or stopped run keeps its
changes, and the outcome (merged, no changes, conflict with files, not merged
with reason, or kept) is appended to the report so the parent knows whether to
resume the delegate. Host-core briefly holds the session's own tools while it
commits and merges in the session worktree, waiting at most a few seconds for
tools already running. Read-only and Bash-only delegates, and every delegate
of a non-isolated session, are unchanged.

### 5f.1 Delegate permission scope (ADR 0089)

A delegate's tool calls flow through the same host `tools.execute` path as the
parent's. When the definition declares a non-`inherit` `permission` **and its
source is `builtin` or `user`**, the sidecar attaches the scope to the
delegate's tool RPCs and host-core resolves the call under that mode instead of
the session's effective permission mode. With no declared scope — the default,
and the policy used by the builtins — no override is attached, so the delegate
inherits the parent's effective permission mode, including `auto` for explicit
external paths. A `project` definition's declared scope is dropped at parse
time with a warning, so opening an untrusted repository cannot escalate its
own delegates past the session mode. Two gates stay above any explicit scope,
exactly as they stay above the session mode: the contract modes' hard deny
(delegation only exists in Agent mode) and the external-path gate. An explicit
`accept-edits` still means "Write/Edit inside the workspace resolve without a
prompt; external paths and other tools keep their normal approval behavior";
an explicit scope remains an intentional override.

The surrounding contracts live in `03-tools-and-permissions.md` §10.2 (what a
delegate may call), `04-data-storage.md` §4.7a (persisted attribution),
`04-ux/03-permission-ux.md` §6a (more than one pending request) and
`04-ux/08-component-spec.md` §9.9 (how a delegation reads).

### 5f.2 No in-process sibling or parent-to-parent Task channel (D326, ADR 0165)

Concurrent `Task` delegates do not message each other, and the parent Task
runtime does not address other conversations. The in-process `Peer` mailbox
(ADR 0138 / ADR 0140) and the host-core A2A broker (ADR 0147 / ADR 0162 /
ADR 0164) are withdrawn.

Coordination stays on the existing delegation contract: the parent writes
independent briefs, starts `Task`s, and collects self-contained reports through
`TaskWait` / `TaskList` / `TaskStop`. A later round of work, if needed, is a
new `Task` whose brief includes earlier reports. `A2A` and `Peer` are not
assignable tools; a definition that names either is treated as an unknown
tool name and dropped with a parse warning.

### 5f.3 Plugin-mediated session collaboration (D409, ADR 0239)

The official `pi.session-orchestrator` plugin is the reviewed exception for
durable cross-session communication. Its `desktop.control` calls are composed
outside the `Task` runtime and are admitted only from the plugin's active
Agent tool invocation. Host-core owns the source/target Session IDs, durable
delivery ledger, permission ceiling, actual target turn, completion callback,
cancellation, restart fence, and transcript provenance. Existing sessions keep
their own project, model, context, and permission configuration; a newly
spawned worker inherits the initiating session's project and permission
ceiling.

Session messages are framed as agent-provided task data and never become new
human authorization. A completion callback is durable and at-most-once, and
does not automatically trigger another callback. This path does not restore
the withdrawn `A2A` or `Peer` tools and does not change `Task`, `TaskWait`,
`TaskList`, or `TaskStop` semantics.

## 6. Providers & models

> Full policy: `11-provider-model-system.md`, `12-provider-config-schema.md`, `13-model-catalog-and-selection.md`.

Coverage strategy:

1. **Native providers** exposed by pi-ai (OpenAI, Anthropic, Google, and others available at pin version)
2. **OpenAI-compatible** first-class path for gateways and long-tail vendors
3. **Custom providers** with protocol profiles
4. **Refreshable model catalog** + **free-form model IDs** (no closed allowlist)

MVP UI always includes at least:
- OpenAI
- Anthropic
- Google Gemini
- OpenAI-Compatible (generic)
- Custom provider entry

Runtime responsibilities:
- resolve `(providerId, modelId)`
- resolve and serialize the complete Pi catalog record, or label an absent ID
  with the unknown generic fallback
- resolve model reasoning capability and effective thinking level from the
  Pi catalog record
- fetch secrets via host (never cache raw secrets in logs)
- translate vendor failures into provider AppError codes
- stream tokens/events to orchestrator
- support abort/cancel mid-stream

Local models are supported through OpenAI-compatible endpoints (Ollama, LM Studio, vLLM, etc.).

### 6.1 Plugin-owned Composer transforms

Composer text transforms are contributed by explicitly installed plugins
through the permission-gated `composer.transform` capability. The host sends
the selected draft and optional model key to the plugin, without transcript
history or attachment data. A plugin may use the generic `agent.complete`
capability to request a one-shot completion; that path creates a separate
completion context and does not instantiate a session agent, expose tools, or
persist a turn. API keys and vendor refresh credentials remain in Electron
main. OpenCode Go one-shots reuse the conversation id as `x-opencode-session`
when a session is present; otherwise the runtime synthesizes a per-call id.

### 6.2 OpenCode session routing headers

Chat, subagent, context-compaction summary, plugin-owned prompt-enhancement,
and other plugin one-shot completions whose provider is `apiStyle: opencode_go`, whose
`vendorKey` is `opencode` or `opencode-go`, whose pi-ai provider id is one of
those values, or whose base URL host is `opencode.ai` send:

- `x-opencode-session`: the durable conversation id, or a per-call UUID when
  the caller has no session
- `x-opencode-client: pi-desktop`
- `User-Agent: pi-desktop/<APP_VERSION>`

Caller-supplied headers override the client and User-Agent defaults. An empty
session header is restored from the conversation id so OpenCode Go cannot
return `MissingSessionID`. A provider-row `headers` map is applied after this
merge (headers plus a fetch wrapper) so custom values win over the OpenCode
default and over adapter last-writes. The Google adapters take the merged
`headers` without the wrapper, because they reject any other `fetch`
(issue #1072). Reserved keys cannot smash
`x-opencode-session`. This is an agent-runtime concern, matching the
official Pi coding-agent attribution layer; pi-ai's `sessionId` stream option
does not emit `x-opencode-session`.

The context-compaction summary is a provider request of the same kind, but the
harness assembles its own stream options and never passes the session's stream
function, so agent-runtime applies the header merge to the model collection it
hands to compaction. That request carries the session's conversation id rather
than the per-call id the harness would otherwise mint, so a summary reaches the
same gateway backend as the conversation it summarizes.

The same seam restores the conversation key itself. pi-agent-core asks for
`cacheRetention: "none"` on a summary, and the Responses-shaped adapters read
that as "no `prompt_cache_key`", so the summary alone drops the identity every
other turn sends; a gateway fronting a Codex backend rejects such a request with
400 `invalid_responses_request`. For `openai-responses` and
`openai-codex-responses` the summary payload therefore carries the session id as
`prompt_cache_key` (clamped to the adapter's 64-character limit) unless the
adapter or a caller already set one. Every other wire API keeps its payload
exactly as the adapter built it, apart from the unrecognized-endpoint key of
§6.3, and the key is added on a copy, so a caller's
payload hook keeps its own object and its return value still wins.

### 6.3 Session identity for endpoints the adapters leave anonymous (issue #1634)

pi-ai supplies a conversation id by itself only where a vendor published one:
the Responses adapters send `session_id` and `x-client-request-id` on each
request, and the Chat Completions and Anthropic Messages adapters send their
session headers only while `compat.sendSessionAffinityHeaders` is set, which
defaults to OpenRouter. The Chat Completions body key is narrower still,
gated on `api.openai.com`. A provider row the user pointed at their own gateway
or relay would therefore send every session of one credential with nothing
reliable to tell them apart: reverse proxies commonly discard `session_id`
because its name contains an underscore, while many gateways do not recognize
`x-client-request-id` as a stable session key.

Agent-runtime stamps that identity itself for a row whose base URL host is not
a published vendor host (`NAMED_ENDPOINT_PRESETS`), on the
`openai-completions`, `anthropic-messages`, and `openai-responses` wire APIs,
and not on the OpenCode path that already carries its own session header
(§6.2):

- For Completions, the built model's `compat` gains
  `sendSessionAffinityHeaders: true` with
  `sessionAffinityFormat: "openai-nosession"`, so the adapter writes
  `x-session-affinity` and `x-client-request-id` without `session_id`. Strict
  gateways can reject the underscore header before authentication (issue
  #2278); the two hyphenated headers preserve session routing. Anthropic keeps
  `sendSessionAffinityHeaders: true` with `sessionAffinityFormat: "openai"`,
  which emits only `x-session-affinity` on that adapter. These defaults are
  spread under the row's own `compat`, so an explicit catalog entry still wins,
  including an explicit Completions `openai` format requiring `session_id`.
- A custom Responses endpoint keeps the adapter's existing `session_id`,
  `x-client-request-id`, and `prompt_cache_key`; agent-runtime adds the stable
  `x-session-affinity` alias through stream options so a reverse proxy can
  route the session after dropping underscore headers.
- A Chat Completions request body that carries no `prompt_cache_key` gains the
  session id as one, clamped to the adapter's 64-character limit. The key rides
  a copy of the payload and is appended after every other payload hook, so an
  extension that rewrites the payload cannot drop it.

The identity reaches session turns, subagent turns, context-compaction
summaries, and plugin one-shots that were handed a session id. A published
vendor host keeps its current request bytes, and a caller with no session id
gains no affinity header or body key.


## 7. System prompt composition

```text
[selected session persona + scoped precedence, otherwise SYSTEM.md or base identity]
+ [Desktop operational rules]
+ [tool activation and skill catalog]
+ [optional APPEND_SYSTEM.md and on-demand tool guidance]
+ [global/project instruction chain and optional project-group context]
+ [memory, workspace facts, and runtime model identity]
+ [selected operating-mode and stage instructions]
```

### 7.0.0 Chronological system state (issue #1285)

The Pi agent loop owns `toolsAdded` / `toolsRemoved` declarations, including
same-name schema replacement. Desktop never moves an update ahead of the user
or ToolSearch result that preceded it. Instruction composition uses independent
`runtime`, `skills` (loading instructions), `skill:<exact-id>` (one catalog
entry each), and `context` sections. Refreshing an idle skill catalog appends only
changed entries, uses null to revoke removed entries, and updates the executable
catalog. Unchanged entries and loading instructions are not repeated. Restoring
an older aggregate `skills` section upgrades it once at the continuation
boundary; checkpoints retain the effective per-entry state. Bodies remain
on-demand and permission-checked. Different plugin tool schemas/permissions
invalidate idle reuse even when their names are unchanged.

The host-owned activation state for bundled skills is read when a session
catalog is built. A disabled built-in is omitted from the prompt and slash
catalog, and a stale direct load through `Skill` is refused. This switch governs
the skill document only; associated agent tools keep their independent
registration and activation behavior.

Before model dispatch, Desktop acknowledges new system records through Host's
existing transcript writer. Restart replays these provider-neutral records in
order. An old history without records receives the current declaration at its
continuation boundary; Desktop does not invent historical instructions. Explicit
compaction saves the effective system state once before summary and retained
tail; it does not replay old tool deltas or preserve removed tools.

Mid-conversation instructions, tool additions and full tool changes are separate
capabilities. Desktop accepts catalog opt-ins only for the same published model,
wire API and effective endpoint (including path and port). Unknown models,
changed bindings and unverified relays use Pi's conservative request projection.
Partial support keeps instruction updates but folds tools as required; removals
and redefinitions use the adapter's supported fallback. Model switching never
rewrites the canonical journal. Cache savings depend on the actual provider;
unsupported routes may still rebuild the request prefix.

Published model limits, prices and modalities remain owned by models.dev. Its
runtime projection separately carries Pi's exact published transcript capability
flags and original binding. An enriched metadata source does not grant native
support by itself, and account overrides never replace that original binding.

The pinned Pi patch declares mid-conversation system support for
`deepseek-flash` on its published `openai-completions` binding at
`https://api.deepseek.com`. Skill changes on this binding append system updates
without rewriting the previous request prefix. This does not enable native tool
additions or changes, and does not apply to unverified gateways, aliases or APIs.
The declaration comes from the patched Pi catalog, not provider settings or a
second Desktop model catalog.

When restoring assistant history, map the current local account ID to the Pi
model's provider identity and retain recorded model IDs. A different recorded
account or model remains distinct. Legacy rows without identity retain the
current-model fallback. Same-model Completions reasoning stays in its native
reasoning field, never appended to visible answer text because of an account
UUID/vendor-name mismatch. The same rule applies when `seedDelegateMessages`
rebuilds a Task(resume) history: tag restored assistants and synthetic
tool-call carriers with `model.provider` / `model.id`, not the account row id.

### 7.0.1 User custom system prompt files (issue #542)

An explicitly selected [session persona](session-personas.md) takes the identity
opening instead of SYSTEM.md and supplies scoped identity/tone/style precedence.
Absent selection preserves the following file-based behavior. Operational,
permission and workflow contracts are not replaced by either mechanism.

The `[optional user custom instructions]` layer is the pi-compatible file pair
`SYSTEM.md` / `APPEND_SYSTEM.md`, discovered per session launch from
`<workspace>/.pi/` (project) and `~/.pi/agent/` (global), each kind picking a
single winner with project over global, exactly like pi CLI. A change to the
resolved content retires the runtime through the reuse match, so the next
prompt recomposes; the files are not re-read per tool call like the project
instruction chain. Native-pi sessions keep resolving them through the upstream
`DefaultResourceLoader` as before.

Two deliberate deviations from pi CLI's semantics:

- `SYSTEM.md` replaces only the base product persona line, not the whole
  prompt: the operational rules below (collaboration, search, edit contract,
  scratch, delegation, skills) are desktop mechanics a persona file must not
  remove.
- `APPEND_SYSTEM.md` is appended after the composed base prompt and before
  the project instruction chain, matching pi's ordering, so the user's own
  `AGENTS.md` keeps the last word.

Both files are capped at 64 KiB, and a whitespace-only file counts as absent.
Native `SYSTEM.md` / `APPEND_SYSTEM.md` resolution in a native-pi session is
unaffected: it stays with the upstream loader.

The base prompt states collaboration rules explicitly, because omitting them
is what produced silent sessions: "prefer concise, actionable answers" was the
only relevant line, and a reasoning model executed it as saying nothing at all.
Required behaviours, each one an observed failure inverted:

- answer in the language the user writes in
- one sentence before each tool batch in the same assistant message as the
  tool calls, and no silence longer than one tool batch or 60 seconds of work
- anything the user asked is answered in visible text; reasoning is not shown
  to them and does not count as an answer
- the final message is self-contained
- work is carried through end to end rather than stopping at analysis
- tool calls go through the native tool-call interface; a call written as prose
  (notably an OpenAI-style `multi_tool_use.parallel` wrapper) does not run, and
  the runtime logs it when a model emits one

It also states a search preference that matches the host-side budgets in
[16-tool-result-limits](16-tool-result-limits.md): scope `Read`, `Grep`, and
`Glob` with their own parameters instead of hand-rolling `cat`/`sed`/`grep`/
`find`. `Read` accepts only an existing regular text file. When a file name is
uncertain or a directory must be listed, an Agent activates `Glob` for the
current prompt through `ToolSearch` instead of guessing a name or reading the
directory. `Glob.path` is a directory, while `Grep.path` may be one file or a
directory tree. Calls use `Read.offset/limit`, `Glob.path/limit`, and
`Grep.path/include/outputMode/headLimit`; `filesWithMatches` or `count` avoids
unneeded content. Workspace-relative paths remain the portable default, with a
bounded command in the active shell only when native tools are insufficient.
Coordinated local Grep uses the in-process scanner with per-file Host leases;
uncoordinated callers may use an installed system `rg`. The agent calls Grep
rather than shelling out to `rg`, and Bash must not assume `rg` is present.
The agent must not repeat a search whose
answer is already in context.

The edit-discipline block carries the line-anchored `Edit` contract of
[18-line-anchored-edit-contract](18-line-anchored-edit-contract.md): the op
table, the `+`-only body rule, "ranges name changed lines only", "re-ground on
the tag returned by every successful write", and the worked anti-patterns. The
sidecar's `Edit` schema is `{ path, tag, ops }`; `old_string` and `new_string` no
longer exist, and the sidecar's tool description must stay byte-identical in
substance to host-core's `builtin_tool_defs()` entry, because a model taught one
grammar and validated against another fails every call.

### 7.0.2 Main-agent request identity

Desktop-managed main agents receive a `Current runtime model identity` block in
the existing trailing `context` section. It contains the exact active request
model ID and configured provider/account ID as JSON-quoted data, not the display
name, delegation catalog, or a historical assistant's model. It explicitly
permits using the decoded model ID for identity answers and an `AI-Model` trailer
when requested by repository policy; it does not itself authorize a commit.
The block is request-configuration evidence, not proof of upstream weights,
provider-reported response identity, or undisclosed gateway routing. No key,
endpoint, headers, or full provider configuration is included.

Persona replacement/append files retain the block. Runtime reconstruction with a
new binding updates the effective context at the continuation boundary without
rewriting old records; a trusted-extension agent activation refreshes it in place.
Unchanged bindings do not introduce per-request timestamps or identity churn.
Compaction retains it through the existing system checkpoint. Native Pi prompts
and delegate prompts are unchanged, as are trusted extensions' explicit prompt
replacement hooks. This adds no RPC, settings, or persisted schema.

Coverage: `runtime-model-identity.test.ts` exercises the real main Agent loop
with synthetic Host/provider boundaries; E2E-RUNTIME-main-model-identity records
the user path and live-provider verification limits.

### 7.1 Active tool context and on-demand loading (D185, ADR 0048)

The sidecar builds one complete tool registry. By default, each provider request
declares the mode's core set plus activated deferred tools. The verified Flash
binding uses the fixed-declaration policy below, while preserving the same
execution activation rules:

- Agent: `Read`, `Bash`, `Edit`, and `Write` (matching pi's coding-agent core)
- Agent: `Skill` whenever the skill catalog is non-empty (D404, ADR 0230) — the
  `# Skills` section and a user-typed `/skill:<skill-id>` both ask the model to call
  it, and a tool that is missing from the schema cannot be called at all
- Agent: `TaskWait`, `TaskList` and `TaskStop` for session jobs, plus `Task`
  when the subagent catalog is non-empty (§5f)
- Plan: `Read`, `Glob`, `Grep`, `BrowserPreview`, and `Bash`
- both modes: `ToolSearch` when at least one deferred capability exists

In Agent mode, `Glob` and `Grep` join `BrowserPreview`, plugin tools,
and plugin-development helpers in the deferred set. Both contract modes keep
their read/inspection core available, while the kind's submit tool
(`SubmitPlan` or `SubmitGoal`) is exposed only during the planning state, and
only for the active kind. Deferred tools are registered but their names and
compact
one-line descriptions appear in an `# On-demand tools` catalog; parameter
schemas do not. The catalog is bounded so a plugin with many tools cannot
recreate the original prompt bloat.
The model calls `ToolSearch` with an exact name or a short capability query.
The sidecar activates up to four matches, records their names in the canonical
`details.addedToolNames` field, and rebuilds the next-turn context with those
schemas. Providers with native deferred-tool search receive the definitions at
that load point; other providers receive the active definitions normally.

Deferred activation is sticky for the live runtime. At restoration, recorded
system messages (including a compaction checkpoint) define the active baseline
for ordinary on-demand histories. Only successful results after the latest
system record can add activation; older results must not resurrect removed
tools. Legacy histories without system records use successful results throughout
their effective context. ToolSearch accepts canonical `details.addedToolNames`
and historical `details.activated` / top-level `addedToolNames`; successful
results from deferred tools also restore their names. Failed results,
missing-result placeholders and assistant/user prose never activate tools.
Only names in the current mode's deferred catalog are eligible.

For the exact official `deepseek-flash` Chat Completions binding with verified
mid-conversation system support, the runtime instead declares the complete
catalog in deterministic name order on the first request. ToolSearch changes
activation without changing the declared schemas. A visible schema does not
permit execution: inactive deferred calls are rejected before extension hooks
and the Host; activated calls still require the existing mode and Host checks.
ToolSearch remains local and never grants approval or bypasses permissions.

Fixed declarations persist separately from activation. A version-1
`tool_activation` section records active names and a fingerprint of the account,
model, API, endpoint, schema catalog and deferred set. Activation changes append
at the continuation boundary, and the existing system journal/checkpoint saves
both declarations and activation. Restore only validated activation for a
matching fingerprint, plus successful ToolSearch results newer than that state;
never activate tools merely because the full snapshot declared them. Malformed,
unknown-version and mismatched activation state fail closed. A catalog/schema,
mode, account, model or route change creates a new epoch and requires new
activation. Removal immediately removes the tool from executable registration.

If the full catalog exceeds 128 functions or its prompt/schema estimate cannot
leave the normal retained-tail budget below the compaction threshold, retain
on-demand declarations and emit a diagnostic explaining that ToolSearch cache
stability is not guaranteed. Do not truncate tools. Other models and unverified
routes retain the existing Pi projection. First-request schema overhead increases;
cache stability does not imply that short conversations become cheaper.

For user-visible HTML deliverables, the default system prompt asks the agent to
activate `BrowserPreview` once after creating the page or making its first
meaningful visual edit, using a workspace-relative path. The agent reuses the
live-reloading preview while iterating instead of issuing repeated preview
calls. Generated, test-only, and non-visual HTML files are excluded. When the
tool is deferred, `ToolSearch` must activate it before the preview call.
### 7.2 Plan prompt requirements

The Plan prompt tells the same Agent to understand the request, inspect the
relevant repository/specification/test context, identify impacted files and
risks, include focused validation and migration/recovery implications, surface
open questions. When any initial or revised plan is ready, it must call
`SubmitPlan` immediately exactly once in the current turn with one complete
Markdown snapshot. An accepted new Plan prompt has no prior pending approval;
earlier submissions in the transcript are historical immutable checkpoints.
After reject, expiry, or interruption, the Agent may revise in the new turn and
must follow the same one-SubmitPlan rule. It must not claim that changes were
made. The host writes the immutable `.pi/plan/*.md` artifact; the Agent does
not write or edit it itself and does not receive a request-changes flow.

The prompt may describe Bash as permission-gated and potentially mutating. It
must not describe Plan as a strict read-only security boundary.

### 7.2a Goal prompt requirements

The Goal prompt tells the same Agent to negotiate a goal contract before any
autonomous work. It asks for what to achieve rather than how: the outcome, the
acceptance criteria, and the boundaries. It must not enumerate implementation
steps, because the Agent decides those itself after approval. Every acceptance
criterion must be objectively checkable by the Agent after execution — a command
that must pass, or an observable behavior. The Agent inspects the workspace and
asks about anything ambiguous first, then calls `SubmitGoal` immediately exactly
once in the current turn with one complete Markdown snapshot.

The one-submit rule, the historical-checkpoint rule, the revise-after-close rule,
the no-chat-confirmation rule, and the host-writes-the-artifact rule are the same
as Plan's, with `SubmitGoal` and `.pi/goal/*.md` in place of their Plan
equivalents. The prompt additionally states that once approved, the contract is
the standard the Agent works against: it pursues the goal autonomously, chooses
its own approach, and stops only when every acceptance criterion is verified or a
boundary blocks it.

### 7.2b Subagent prompt composition (D201, ADR 0062)

Without an inherited [session persona](session-personas.md), a delegate's system
prompt is composed in the sidecar from three parts, in this
order: the delegation framing, the definition's Markdown body, and the tool
guidance its resolved tools earn. The body sits ahead of the workspace guidance
so a project's own instructions still have the last word.

The framing states the shape of the delegate's situation, which is not
inferable from the body: it is one delegated task, the delegate cannot see the
user, ask a question, or delegate further, it has exactly the listed tools, and
its final message is the only thing the main agent receives. Listed names are
the spawn-time resolved set, including the available `Skill` loader for fixed
tool lists and the broader catalog when `tools: inherit` is on. A read-only
definition is additionally told never to report an edit it could not have made;
a write-capable one is told to touch only the files the task is about.
Mutation framing uses the resolved set, not the raw frontmatter extras.

Guidance blocks are the same text the session prompt uses, included only when
the resolved tools include the matching name: search/read scoping for
Read/Grep/Glob, edit discipline for Edit/Write, the command shell contract for
Bash, the `# Skills` catalog when `Skill` is present, and the scratch-directory
rule when the session has a scratch directory and the delegate can write. The
project instruction chain (§7.3) is appended last, so a delegate follows the
same project rules as its session.

### 7.3 Project instruction chain

The Electron main process first resolves the global
`~/.pi/agent/AGENTS.md`, then project instruction files inside the
session-bound project root when a runtime starts. For each project directory it
uses at most one non-empty file in this order: `AGENTS.override.md`, `AGENTS.md`,
`CLAUDE.md`, then `.claude/CLAUDE.md`. Entries are concatenated from project
root to the target directory, so the closest file appears last and takes
precedence. The initial chain targets the project root. Before a `Read`,
`Write`, `Edit`, or `BrowserPreview` call, the sidecar asks Electron main to
resolve the target path and replaces the active instruction section with that
path's complete chain before the tool executes. This keeps rules lazy and
prevents sibling-directory rules from persisting after the agent moves to a
different file tree.

The session-bound project root is passed with the runtime launch metadata and
registered by Electron main before each prompt or compaction request. The
sidecar cannot select a different root. During one prompt, path-resolution
claims are cached by project root and target directory, so repeated file tools
in the same directory do not perform another IPC request. Claims are discarded
at the next prompt, allowing edits and newly created instruction files to take
effect without a stale cross-message cache.

Path-specific resolution is best-effort and has a 2-second deadline. If the
resolver or its host RPC is unavailable or exceeds that deadline, the file
tool continues with the runtime's base/root chain rather than waiting for the
general host RPC timeout. A failed resolution never leaves a previously
resolved sibling-directory chain active.

All discovery stays within the session project root. A target path outside the
project root, or the root path itself, resolves to the root's own chain instead
of an empty result. File tools on attachments or other locations therefore
keep the root chain (which may itself be empty). Empty, unreadable, and
out-of-root files are skipped. The global file and the combined project
entries have independent 32 KiB UTF-8 budgets, so an oversized global file
never removes project instructions. A file that exceeds its remaining budget is
cut on a UTF-8 character boundary and followed by a
`[PI-Desktop truncated <source>: loaded the first <n> of <total> bytes; ...]`
notice; project files after a truncated one are not loaded. Source paths are
labelled under `# Project instructions`.
The sidecar never reads workspace instructions directly. A changed root chain
recreates an idle runtime on its next prompt; nested instructions are resolved
again when a relevant file tool runs. The resolver's timeout and fallback
are operational safeguards; they do not emit a separate timing log record.

Settings provides dedicated management for the fixed global path. The Projects
view project-list menu provides an `AGENTS.md` editor for its corresponding
registered project root. Its IPC does not accept arbitrary renderer file paths.
Saves affect the next prompt without restarting the application.

For an isolated session (ADR 0329) the launch metadata carries a separate
`workspaceRoot`, its git worktree: the instruction chain and its path
resolution are rooted there, so the agent follows the worktree's own
`AGENTS.md` files. `projectPath` stays the project identity for memory,
skills, plugins, MCP servers, subagent definitions, the custom system prompt,
and group context. The system prompt adds a short isolated-workspace note
(work only in the worktree, use the `PI_PORT` block, leave branch changes and
merging to the user, and how to resolve a merge conflict).

## 8. Concurrency

| Scope | MVP policy |
|---|---|
| same session | single turn serial |
| different sessions | limited parallel |
| tools | sequential by default |
| `Task` calls in one assistant message | parallel; 10 running delegates per session (ADR 0089) |

Tool concurrency uses pi's ordered preparation and source-order result contract.
Read/Glob/Grep remain parallel; Write/Edit join only after the local Host
file-batch capability handshake. Legacy and remote Hosts keep write batches
sequential. Eligible batches register calls in source order and seal before
execution. Host permission checks precede identity resolution; Host orders
conflicting same-batch calls by source ordinal and atomically grants resources
with capacity. Native file identities cover aliases across parent/delegate and
session calls. Unknown identities and namespace changes fence conservatively.
The actual blocking task retains its permit after transport cancellation.
Searches retain capacity/source-order ownership without a whole-tree execution
fence. Grep borrows that slot for per-file leases through tag generation; Glob
enumerates metadata. Blocking searches cooperatively stop after waiter
cancellation. See ADR `search-file-lease-isolation`.
Supported calls bypass sidecar PathMutex; legacy calls retain it. Existing
mutation-recovery rules remain in force. See `03-tools-and-permissions.md` §0
and ADR `host-file-batch-admission` for identity, lifecycle and scope limits.
Task-only fan-out and Task/file mixed-batch completion barriers are unchanged;
parent and child path instruction preparation only updates their own prompt.

Selecting another project tab affects only the visible shell workspace. It
does not dispose, abort, or re-root a runtime belonging to another session.

## 9. Abort semantics

- stop model stream
- attempt cancel interruptible tools
- do not auto-rollback completed writes
- mark turn aborted in UI/storage
- preserve elapsed response duration; when provider final usage is unavailable,
  estimate visible thinking plus answer output at four Unicode code points per
  token and persist it as `responseOutputTokens` so stopped-turn throughput is
  still available and visibly approximate
- preserve request-to-first-response wait and streamed thinking/answer duration
  on assistant messages when available; stopped streams retain the elapsed
  streamed duration captured before cancellation
- renderer smart-stop transcript undo and structured Composer restoration are
  reconciliation after abort; they do not change runtime cancellation or roll
  back completed tool effects

## 10. Explicit non-goals

- no DOM knowledge
- no direct FS access bypassing Rust host
- no secret leakage into events/logs

## 11. Implementation status (M5)

Implemented: streaming turns over the OpenAI-compatible protocol path
(universal escape hatch, D024); one active turn per session enforced with
`AGENT_BUSY`; real `turnId` returned per accepted prompt; provider failures
mapped to `PROVIDER_UNAUTHORIZED` / `PROVIDER_RATE_LIMITED` /
`MODEL_NOT_CONFIGURED` / `STREAM_FAILED` / `TURN_ABORTED` where detectable.
The desktop development lifecycle rebuilds `packages/agent-runtime/dist`
before Electron starts so the spawned sidecar always executes the current
normalization and error-mapping source.

Tracked gaps (post-MVP backlog): richer system prompt composition (§7) and
provider/model catalog discovery beyond the currently wired paths.

## 12. Native Pi continuation runtime (ADR 0254)

The sidecar selects runtime by session source. Desktop-owned ids continue to use
`DesktopAgentRuntime`, host turn rows, and the host persistence outbox unchanged.
Opaque `native-pi:` ids use a dedicated coding-agent `AgentSession` constructed
with the original v3 `SessionManager`, Pi `ModelRuntime`, `SettingsManager`, and
`DefaultResourceLoader`. Native context is built by the SDK from the active tree
leaf, compaction, model/thinking changes, and context-bearing custom messages;
it is never reconstructed from renderer `UiMessage` rows.

The Pi 1.1.0 SDK also applies append-only `context_edit` entries to this model
projection. An edit can omit or replace an earlier message for later provider
requests without rewriting its raw JSONL entry or the visible native history.
Native Pi extensions use the SDK's boundary hooks; all entries they append,
including context edits, pass through the sidecar's lease and parent-chain
guard. This native extension lifecycle is separate from the Desktop Agent
extension adapter described in [trusted extensions](../07-plugins/16-trusted-extensions.md).

The first native slice supports text prompt **without model tools**, stop/abort,
and explicit refresh. `createAgentSession` receives `noTools: "all"`; neither
built-in nor extension tools may bypass Desktop permissions. Tool parity awaits
an explicit permission bridge. Native extension startup/resource discovery binds
with the SDK headless UI and unsupported session-control actions; guards and
listeners are installed before startup appends. Binding failure disposes the
session and releases ownership. Pi extensions remain trusted local code, not
Desktop plugins.

A native fork (`native.session.fork`) branches the parent snapshot in memory:
the SDK extracts the anchored branch using its native label/compaction
re-chaining rules, drops later and sibling entries, and never touches the parent
file or its manager. When the anchored branch recorded no model, the child
records the parent session's saved provider/model; when it recorded no
thinking-level change, it records the parent's saved level, while an explicit
branch value (including off) wins. The child is published as a complete new
file whose staged and published bytes must still match the captured
device/inode/size/hash before it is projected or registered; an altered file
fails closed without returning a child. A fork is a data-only copy: it executes
no model and loads no project resources, so it stays available while the parent
is provider-unavailable or project-untrusted, without granting prompt

ModelRuntime performs its public offline initialization to restore the local
catalog and auth snapshot. Native Composer readiness uses native `canPrompt`,
not Desktop provider or secret availability. Owned idle leases remain usable;
active turns stay stoppable through retries/compaction, reject overlap without
disposal, and publish exactly one terminal event after SDK prompt settlement
and final persistence (including `agent_settled` hooks). An error rejection
uses the error terminal path instead.

The native dispatcher carries the optimistic `userMessageId`; a
`user_message_persisted` event acknowledges the SDK-assigned durable entry ID
after the guarded append. No caller ID is written into native JSONL. The
renderer reconciles active, retained, and cached rows by identity, never text.
Native abort refreshes the original transcript instead of smart-stop rewrite.

The saved provider/model and configured Pi auth must resolve exactly; there is
no Desktop provider fallback. Missing cwd, required project trust, unsupported
format, repair-needing newline, unavailable provider/auth, active lease, or
external byte change makes continuation fail closed while detail remains
browseable.

### Provider certificate trust (issue #714)

The desktop sidecar's effective trust set is the union of Node's bundled
roots, the inherited `NODE_EXTRA_CA_CERTS` set, and non-expired entries from
the OS trust store, with chain and hostname validation on. Expired entries in
the OS store are omitted because platform stores may retain stale certificates;
bundled and `NODE_EXTRA_CA_CERTS` entries are unchanged. On Windows and Linux
the launcher passes Node's `--use-system-ca` to obtain the system roots. On macOS the Electron
build applies that flag by replacing the bundled roots instead of adding them
and its system enumeration misses public anchors (issue #1187), so the
launcher omits the flag and the sidecar merges the three sets into the default
CA set itself at startup (`agent-runtime system-ca`). Restart after updating
local trust or the extra-CA startup environment. Headless pi-host launch
behavior and System/Direct/Custom proxy routing are unchanged.

Explicit certificate verification errors are terminal for both setup and
stream recovery in main sessions and built-in delegates. Their structured
cause survives adapter message flattening, remains on the final error row,
and never triggers a provider transport rebuild. Protocol errors such as
`EPROTO` keep their existing retry behavior. See
[certificate trust ADR](../../adr/provider-system-certificates.md).

## Pi 1.1.0 execution boundary

Published model metadata and account entitlement come from one account-scoped
Pi Models collection. Effective binding projection is shared by launch, delegates
and compaction. Dispatch thinking normalization uses the resolved physical Pi
model; native null/unsupported mappings remain unavailable without mutating
saved preferences. Agent bookkeeping and omitted request reasoning are distinct.

Every physical stream attempt has an operation identity before dispatch. Usage
survives stream/result projection and events through Host/remote/renderer paths;
retries and images retain physical account/model attribution. Nested immediate
parent and owning Task remain distinct. The migration does not add coding-agent
AgentSession, Codemode or virtual routing. See the coding-agent design review for
future adoption conditions.


### Session job controls

Agent-mode TaskWait, TaskList and TaskStop are available even without configured
subagents. Task itself still requires a subagent catalog. Plan/Goal retain the
declarations for conversation compatibility and reject their execution.

Bash background startup and Task startup return an additive `job: {kind, id}`
reference, where kind is `bash` or `delegation`; their original identifiers
remain available. TaskList preserves `delegations` and `resumable` and adds
`backgroundJobs: {supported, tasks}`. Delegation summaries also include job
references. Bash summaries contain no logs. The command preview retains the
first 1 KiB at a UTF-8 boundary. `commandTruncated` marks a shortened command
independently of output truncation; older Hosts may omit the field.

TaskWait and TaskStop accept one explicit `job`. With a delegation job and no
`delegationIds`, TaskWait observes that job alone. When both fields are present,
TaskWait uses the explicit list if it contains `job.id` and consists of distinct,
nonblank IDs. The redundant job neither narrows nor expands the list; `mode`,
`minCompleted` and `timeoutSeconds` retain their existing behavior. TaskStop still
requires exactly `[job.id]` when both selectors are present. Empty, disjoint or
malformed lists are rejected before dispatch with a job-only retry example.
A Bash job ID is the sole target for that call; delegation-only selectors
(`delegationIds`, `mode` and `minCompleted`) accompanying it are removed from a
copy of the call by pi's `prepareArguments`, before schema validation. This
also tolerates irrelevant values such as `minCompleted: 0` without weakening
delegation, job identity, timeout or ownership validation. Raw call arguments
remain unchanged for diagnostics. Matching a delegation job's ID remains a
runtime check. Omitting `job` preserves the existing delegation defaults,
including stop-all-delegates. A Bash job never joins those implicit target sets.
A legacy backgroundTaskId can be addressed as `{kind: "bash", id: backgroundTaskId}`.

For Bash, TaskWait returns a snapshot with state, nullable exitCode,
stopRequested, separate stdout/stderr tails and truncated. Each stream is
bounded to 8 KiB at UTF-8 boundaries; truncation also reflects Host ring loss.
Reads are repeatable and do not consume desktop output. The wait defaults to
600 seconds and accepts 1–900 seconds. `details.status` describes the wait
(completed/timeout/interrupted), independently of the job's state. New input
interrupts the wait; cancelling the parent releases it without stopping Bash.
TaskStop returns completed or stopPending based on the actual snapshot. A
stopRequested flag alone does not confirm termination. Cancelling TaskStop
before dispatch leaves the job alone. After dispatch, cancellation releases
the caller's wait while Host continues processing the stop request.

The wait deadline includes capability discovery and in-flight requests.
On timeout the tool returns its last observed snapshot. If the first
observation has not arrived, it returns the job reference with
`snapshotAvailable: false` and no process state. Transcript rows identify
explicit Bash targets and include background commands in mixed job lists.

Bash is still owned by Host and does not keep the parent turn open. Completion
is not auto-delivered by default; the opt-in continuation contract below is separate. Delegation report delivery and resumability retain their
existing lifecycle. Runtime capability probing is connection-scoped; older
Hosts and remote workspaces explicitly report Bash controls unavailable,
while delegation controls remain usable. Transport and Host failures propagate.

## Subagent controls: failure policy and direct conversation

Scheduling may persist `failurePolicy: { mode, maxRetries, maxFallbacks }`.
Modes are inherit/stop/retry/fallback. Missing or inherit preserves the prior
session policy. Explicit modes override infinite provider retry: stop disables
retry and switching, retry caps same-model retries, and fallback additionally
caps authorized model switches. Limits are integers 0–10 retries and 1–10
switches. The UI's unset defaults are inherit with limits of two and two, not
an implicit opt-in. Each admitted child snapshots the policy; saved edits affect
subsequent admissions. Exact-model constraints, compatible model pools and
approval remain mandatory. Only provider failures can lead to model switching;
ordinary tool errors or time without tool calls do not trigger it.

The local direct-input API routes user text to an existing chain. Active children
queue it through the same Agent's steering mechanism without aborting tools;
settled chains resume using bounded retained history and checkpoints. A stable
message ID coalesces retries, conflicting reuse is rejected, and distinct inputs
to a chain serialize through admission. Accepted input is recorded in child
history even when Stop precedes its processing. Direct resumed Task inputs are
projected back as child user history on later resumes. Parent context receives
a notification and subsequent reports rather than the full child conversation.
Admission keeps the durable parent owner alive and remains cancellable.

This adds no database table or tool authority. The existing transcript/outbox
owns persistence, and ordinary cancellation never causes automatic restart.
Opening a transcript is read-only; sending after Stop is an explicit resume.
See [the ADR](../../adr/subagent-controls-and-direct-input.md) and
[the IPC contract](01-ipc-protocol.md#direct-subagent-input).

## Shared prefix and scratch identity (#1926)

The base runtime system section keeps shell dialect, scratch-variable syntax and temporary-file policy stable across sessions. The exact scratch directory is appended after project/memory context rather than embedded twice in the leading runtime rules. Bash tool descriptions retain their exact path guidance. This preserves a shared system-text prefix, without promising provider cache hits or changing history reconstruction.


### Opt-in background completion continuation (#2143)

`backgroundJobContinuationEnabled` defaults to false, including absent legacy settings.
When enabled, local parent Agent Bash exposes optional `notifyOnExit` alongside
`runInBackground`. The assistant may register follow-up for finite tests/builds;
this is not another human approval. Existing session tool permissions still apply.
Servers/watchers keep ordinary background behavior unless a continuation is explicitly
registered. Remote, native-pi, delegated and contract-mode execution are out of scope.

Host retains the original result while pending (at most 64 intents per Host). Both
process exit/output drain and successful completion of the originating turn are
required. Main uses trusted in-process identity through AgentHost admission; active
work and queued user input win. Before dispatch Host atomically checks the intent,
setting, source turn and destination turn, then marks it started. Results enter the
transcript/context as a TaskWait tool result, not as a new user instruction. Output
remains untrusted data and does not grant additional authority.

A terminal TaskWait/TaskStop result observed by Main consumes pending delivery;
raw RPC reads, UI log reads and timeouts do not. Failed acknowledgement suppresses
local dispatch while it is retried. Stop, source-turn cancellation, session loss,
leaving Agent mode, explicit cancellation and disabling the setting withdraw pending
continuation. Withdrawal does not kill the process. Started turns are not interrupted
by disabling the setting. Failed/ambiguous dispatch is not automatically retried;
the original result remains available via TaskWait. Intent lives only with the Host.
