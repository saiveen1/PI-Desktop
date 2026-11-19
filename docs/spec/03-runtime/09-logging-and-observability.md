# 09. Logging and Observability

## 1. Goals

1. Diagnose failures quickly.
2. Audit sensitive tool and plugin actions.
3. Avoid leaking secrets.
4. Keep the MVP local-first and quiet during normal operation.

### On-demand performance diagnostics

Developer mode alone does not start the on-demand sampler. The expanded, visible Settings
panel requests single-flight process snapshots. A separate explicit capture is
owned by Main and continues when the panel is closed. It aims for one process
snapshot per second for 30 seconds, retains at most 64 process rows per snapshot
and 32 manual timestamps, and stops on request or deadline. Main-frame reload,
renderer exit, window destruction, and developer-mode revocation discard the
recording. Only one in-memory capture is retained; no timing log is revived.

Rows identify live local processes by PID and creation time when known. CPU is
percent of all logical CPUs over successive samples, not percent of one core.
The first interval and unavailable counters are `null`. Working set and private
memory are distinct (KiB in JSON, MiB on screen); do not sum working sets as
unique RAM. A CPU interval longer than five seconds starts a new baseline.
Core child roles come from the local supervisors. Main identifies its primary
renderer, registered plugin workers, docked/floating plugin pages, and live browser
pages (including background tabs) without reading page titles or URLs. Multiple
plugin owners on one PID do not imply exclusive attribution to any one plugin.
Windows sidecars expose process times and memory when the native query succeeds;
Linux x64/arm64 uses procfs for sidecar CPU/RSS and approximate start time. On
macOS, a sidecar not covered by Electron has a PID/role but unknown counters.
This is not a machine-wide, remote-host, or shell-descendant process inventory.

Main and visible UI timer lateness are scheduling indicators, not input-to-paint
latency, GPU memory or definitive root causes. The UI reports bounded numerical
counts and maxima from instrumented rendering stages, session switches and
opened tool details; unsent partial intervals or unavailable stages may be
absent. In particular, normal production React need not emit Profiler commits;
this does not disable instrumented Markdown parsing or code highlighting.
The JSON contains build/platform, peak measured processes, timing and
coverage counts. It excludes transcript text, file paths, commands, credentials,
URLs and window titles. Preview and explicitly save to share; nothing is
uploaded, appended to a prompt or persisted automatically.

### Automatic performance incidents

Independent of developer mode and manual recording, Main keeps up to 15
samples (roughly one every two seconds, at most 30 seconds of history at write
time) for its own process and the primary-window renderer. Each has the PID,
process start time, cumulative CPU seconds, and working set/private memory in
KiB when available. An unavailable value is `null`. No routine samples go to disk.

Main writes an incident for at least 500 ms of Main timer lateness or a
validated visible-renderer heartbeat round trip of at least 500 ms. These
timing hints are rate-limited to one per kind per 30 seconds. A single
heartbeat may be outstanding, and hiding, minimizing or navigating the window
invalidates it. Observed suspend/resume and clock discontinuities are excluded
from delay attribution.
Main also records native unresponsive/then-responsive transitions that started
while the primary window was visible. An unexpected primary-renderer exit
records the cached last known renderer PID, Electron reason and exit code
before the existing recovery reload. Normal close, quit, and clean exit do
not generate incident records.

Open **Settings → Info → Developer → Performance diagnostics → Open
diagnostics → Open logs folder**. Inspect `app/performance.log` in that
folder (`<dataDir>/logs/app/performance.log`, plus `performance.1.log` and
`performance.2.log` when rotated). The file starts at the first incident and
uses standard app log rotation (5 MiB per file, plus the last appended record).
Unlike manual captures, these records persist after a renderer or app restart.
Events use the `performance.incident.*`
prefix. They contain only fixed incident labels, timestamps, process IDs and
numeric timing/resource counters, not transcript data, URLs, paths, window
titles, or credentials. Nothing is uploaded.

This is best-effort evidence, not a profiler or exact input-to-paint/heap/stack
attribution. Short stalls between probes can be missed. A renderer may die
before Main learns its PID, and a hard Main/OS kill or unwritable disk may
prevent an incident write.

## 2. Log levels

- `debug`
- `info`
- `warn`
- `error`

Default runtime level:

- development: `debug`
- release: `info`

## 3. Channels

| channel | content | location |
|---|---|---|
| app | boot, IPC, window, process supervision | `~/.pi-desktop/logs/app/<category>.log` |
| host | Rust host-core events (stderr capture) | `~/.pi-desktop/logs/host/<category>.log` |
| agent | pi sidecar events (stderr capture) | `~/.pi-desktop/logs/agent/<category>.log` |
| audit | sensitive permission, tool, and plugin actions | host-core SQLite `audit_log` table |
| plugin | per-plugin logs | `~/.pi-desktop/plugins/logs/<id>.log` |


The `~/.pi-desktop` paths above are the packaged installation's. A development
build writes the same tree under `~/.pi-desktop-dev`, and `PI_DESKTOP_DATA_DIR`
replaces either root (D599).
`app`, `host`, and `agent` are NDJSON files written by the Electron main
`Logger` (`apps/desktop/electron/main/logger.ts`). Host and agent stderr lines
are wrapped into records on their channel. The audit channel is stored in
SQLite, owned exclusively by host-core, so it remains queryable independently
of rotating diagnostic files.

### 3a. Category routing

The three process channels are directories, not aggregate files. Main-process
call sites choose a category. Host and agent stderr uses marker-based
classification; unknown child output uses `runtime`.

The application categories are:

- `lifecycle` — boot, shutdown, and application supervision
- `session` — prompts, turns, session lifecycle, and compaction
- `tool` — tool execution outcomes and interruptions
- `permission` — permission requests and decisions
- `plugin` — plugin loading, services, and plugin tool execution
- `provider` — provider/model discovery, retries, and cache failures, plus
  live voice call failures: one `live voice call failed` `warn` per root cause
  carrying `callId`, `adapterId`, `phase`, `stage`, `code`, `retriable` and the
  Logger-redacted raw `reason` (including Gemini WebSocket close code and UTF-8
  reason), and one `live voice microphone release
  unconfirmed` `error` when a release could not be confirmed and the lease is
  quarantined. Call views carry the `code` only.
- `persistence` — transcript and outbox persistence failures
- `updater` — updater diagnostics and errors
- `diagnostics` — blocked navigation, menu, template, and outbound-fetch
  diagnostics. The skill market's two channels record one
  `skillMarket.sourceFailed` / `skillMarket.documentFailed` record per source
  or document that produced nothing, with `source`, `host`, `kind`, `address`
  and — for a guard refusal — `reason`, `addressKind` and `route` in `data`. `kind`
  is `policy` when the guard judged the target's own address, `fake-ip` when it
  judged a placeholder the local proxy invented for the name (Clash's
  `198.18.0.0/15`), `unresolved` when the local resolver returned no answer, and
  `network` otherwise; `code` is `NETWORK_POLICY_BLOCKED` for the first two and
  `NETWORK_RESOLVE_FAILED` for the third, so one log line separates "the address
  is not public" from "a proxy answered with a fake-IP" from "the resolver
  answered nothing". `reason` names the guard's own branch (`url-syntax`,
  `resolve-failed`, `non-public-address`, `redirect-limit`), `addressKind` the
  class of the refused address (`benchmark` for a TUN fake-IP, `private` for
  RFC1918), and `route` the route that address was judged on (`proxied`, `direct`,
  or `unknown` when the transport reported no readable route), so a fake-IP
  refusal on a direct route reads apart from one on a route nobody could read
  (ADR 0272). The record carries the host name, the address it resolved to, that
  class and that route — never the URL, its path, query or credentials — because a
  catalog source URL is user-supplied and the refused host and address are the
  whole diagnostic value (issue #419). After a Chromium-process crash, the next
  launch writes one `crashDumpsFound` record (`error` if any new dump is the
  browser/main process, `warn` otherwise) with `count`, `total`,
  `byProcessType`, `directory`, and `newestMtimeMs`. A recovered renderer crash
  is therefore not reported as the previous app run aborting. A scan failure is
  one `crashDumpReportFailed` warn and never blocks the first window (D602).
  Each renderer `render-process-gone` event records one `renderer.process.gone`
  entry with the Electron exit `reason` and `exitCode`, plus whether the current
  main window was reloaded. Clean exits are informational; unexpected exits are
  warnings.
- `performance` — incident-only evidence for primary-window stalls and
  unexpected exits (see [automatic performance incidents](#automatic-performance-incidents)).

- `runtime` — host/sidecar lifecycle, uncategorized child output, and
  main-process `uncaughtException` / `unhandledRejection` records

There is no dedicated `timing` category. Timing files from older application
runs are left untouched, but current code does not create or append to them.
Flat legacy `app.log`, `host.log`, and `agent.log` files are also left untouched.

## 4. Required fields

Every structured log line should include:

```ts
type LogRecord = {
  ts: string
  level: "debug" | "info" | "warn" | "error"
  channel: string
  category: string
  event: string              // stable dot-separated machine-readable name
  message: string
  traceId?: string
  requestId?: string
  sessionId?: string
  turnId?: string
  toolCallId?: string
  parentToolCallId?: string
  agentName?: string
  pluginId?: string
  executionId?: string
  code?: string
  data?: unknown
}
```

Format: NDJSON files.

`event` is the stable query key; `message` is a short human-readable summary.
Correlation fields are emitted at the top level so a failed tool, its
permission request, and its parent/child agent can be joined without parsing
free-form text. `data` is diagnostic metadata, not a transcript or command
output: it is redacted, depth/collection bounded, and capped at 8 KiB per
record.

## 5. What must be logged

### Always

- app boot and shutdown;
- the confirmed shutdown record is synchronously appended before any awaited
  teardown; cancelling the quit does not write it;
- host/agent spawn, handshake, and unexpected exit;
- session create/delete;
- prompt accepted/aborted;
- failed context compaction: one `session.compaction.failed` record and one
  `session.compaction.request_shape` record per summary request. The failure
  record carries only provider/model identifiers, closed-vocabulary failure
  reason, bounded token budgets, status/error codes, and a request-shape state
  (`observed`, `not_sent`, or `unobserved`). The shape record carries the wire
  API, bounded top-level field names, role counts, tool count, and numeric
  output limit (or `omitted`). It never carries prompt text, tool schemas,
  endpoint URLs, credentials, or provider error prose. Retries and chunked
  summaries use a fresh request id at every request boundary.
- tool completion/failure/interruption and permission request/decision/cancellation;
- Plan artifact creation, approval, expiry, rejection, execution transition,
  and startup interruption;
- shell identity, timeout, abort, and process-tree shutdown;
- plugin enable/disable/load/error;
- tool admission rejection, queue/resource exhaustion, and updater errors.

These records should identify the relevant session, turn, tool call, plugin, or
stable error code when available. A normal tool call emits one completion or
failure record after `tool_end`; an unexpected sidecar exit emits one
interruption record for each still-active tool. The sidecar protocol still
uses `tool_start` and `tool_end` unchanged for execution and transcript
correctness. Normal successful operations should not emit per-phase or
per-request latency records.

### Never

- API keys or raw secrets;
- full secure-storage payloads; or
- unnecessary full file contents for large reads in audit records.

## 6. Redaction rules

1. Keys matching token, secret, password, API key, authorization, cookie,
   credential, private key, or client secret are redacted.
2. Bearer/Basic credentials, URL user-info, and common provider token formats
   are redacted even when they occur inside a string.
3. Home, application-data, and log-directory prefixes are normalized to
   placeholders; raw local paths are not retained in diagnostic records.
4. Arbitrary strings are bounded. Structured data is bounded by depth and
   collection size and then capped at 8 KiB per record, including host-core
   audit payloads after shaping.
5. Tool arguments and results are never copied wholesale into normal logs.
   Tool results retain only safe metadata such as outcome, error code,
   duration, field names, content-block count, and stdout/stderr sizes.
   Long command output is counted or truncated in audit records.
6. Child stderr is stored as a bounded, ANSI-free `data.output` field under a
   stable `child.process.stderr` event; it is not used as the record message.

## 7. Trace correlation

Use one `traceId` per user-visible action when possible:

- prompt → `turnId`;
- tool call → `toolCallId`; and
- permission flow → `toolCallId` / `requestId`.

Renderer, Electron, host, and agent should propagate these identifiers.

## 7a. Functional duration metadata

The application still preserves bounded duration metadata needed by product
features: `ToolsExecuteResult.duration_ms`, transcript `toolDurationMs` and
`responseDurationMs`, delegation start/completion timestamps, and bounded
provider diagnostics. Completed assistant responses use pi-ai 1.1.0's
monotonic request duration when available; interrupted responses retain the
sidecar stopwatch estimate. These values support the transcript, context inspector,
throughput display, and audit records; they do not create timing log lines.

Host-core audit rows may retain the existing permission and execution timing
fields for forensic inspection. They are structured audit data, not a separate
`timing.log` stream.

Settled replies may retain `runDiagnostics.termination` with the owning message
ID, normalized stop reason, `reasonSource: normalized`, available token figures,
early-end advisory state and corrective-continuation count. These bounded facts
do not contain prompts or provider prose and are not added to the model context.
The message ID prevents a turn-level snapshot from attaching a warning to a
different bubble. Missing historical values remain unknown. A normalized reason
does not establish the raw wire `finish_reason` or whether an adapter received
every terminal frame; neither is fabricated. A normal stop is not task success.

## 8. User-facing diagnostics

The optional built-in Observer adds `runDiagnostics.observer` on the exact
candidate message: mode/status, selected model/effort, start/end, bounded verdict,
confidence, redacted short reason, evidence IDs, continuation decision and its
own usage. Optional skip and continuation reason codes distinguish local gating
from model judgement; a bounded blocking-tool identity identifies the first
unresolved receipt without exporting arguments or output. No raw reviewer
prompt/reasoning or provider error prose is logged. The transcript presents one
summary outside the folded execution process and restores it from the candidate's
persisted metadata, not a fresh assessment. It explicitly labels requested
continuations as not reassessed in that turn. These facts remain separate from
main-provider attempt counters and the developer tool-observation report.
Missing old data remains absent, missing reasons are unknown, and an advisory
verdict is never a verified task outcome.

MVP provides:

1. in-app error text with a stable code;
2. an “Open logs folder” command; and
3. optional copy of error details (code and `traceId`).

There is no remote telemetry pipeline or cloud crash analytics in the MVP.

## 9. Retention

- app/host/agent category logs: rotate each category file at 5 MB and keep two
  rotated files beside it (`<category>.1.log`, `<category>.2.log`);
- audit log (SQLite): retained with the database and pruned according to the
  host retention policy;
- Crashpad minidumps in `<data_dir>/crash-dumps` are not rotated by the
  logger; they remain until the user deletes them; and
- rotation and logging failures must never fail the caller.


Session transcripts are user data and are not deleted by log rotation.

## 10. Local tool observer

The developer section in Settings exposes a read-only view of retained tool
observations (see [the decision](../../adr/local-tool-observer.md)). Collection
reuses normal `app/tool` records and does not inject context or call a model.
`data.observation` contains only known tool/shell identifiers, correlation IDs,
Desktop platform, application version, outcome, numeric exit/duration and
truncation status. It does not contain command arguments, output, file contents,
paths, environment values, or free-text error messages. Unknown extension names
and unrecognized codes are not copied into the report.

Structured `details` scalars are inspected without parsing text blocks. Outcomes
separate success, command nonzero, tool error, timeout, cancellation,
interruption, background launch and unknown. Native-session events are observed
without changing their canonical transcript ownership. Host background jobs emit
a distinct terminal notification after authoritative settlement; launch/terminal
records are correlated by task and session so the report counts one settled job.
No outcome alone establishes a harness defect or successful recovery.

`diagnostics/toolObservations` accepts only `{ days: 1 | 7 | 30 }`. Main checks
developer mode before and after reading. It opens only `app/tool.log`,
`app/tool.1.log`, and `app/tool.2.log` within its own data root, rejects redirected
log paths, and bounds each file to 5 MiB + 64 KiB and the scan to 20,000 nonempty
lines. The report deduplicates observation IDs, preserves success counts,
returns at most 100 issue groups, five examples per group and 200 recent records.
Partial lines, limits, malformed/legacy records and read errors are visible in
coverage metadata. Missing old metadata is never invented; the requested time
window is not a retention guarantee. Concurrent identical reads are coalesced.

Settings provides day selection, refresh, loading/error/empty states and bounded
examples. A reference action appends a selected sanitized snapshot to the active
eligible conversation draft, preserves existing content/attachments, and returns
to chat without sending. Unavailable sessions and pending draft replacement are
not silently overridden. Report references are facts for review, not execution
authorization. No new stored setting, database schema, telemetry upload, automatic
retry or model observer is added.

## 11. Acceptance

1. Failed and interrupted tool calls can be traced by `toolCallId` across key
   logs, with one outcome record per normal execution.
2. Secrets never appear in log files during normal flows.
3. The logs folder can be opened from the app/command palette.
4. Boot, host, sidecar, plugin, updater, and renderer paths emit only their
   lifecycle, state-change, error, or security-relevant records; no timing
   category files are created for normal operation.
5. Logging or console mirroring never crashes the main process when stdout is a
   broken pipe.
6. Host restart, permission failure, shell timeout, and process abort remain
   diagnosable from stable lifecycle records and error codes.
