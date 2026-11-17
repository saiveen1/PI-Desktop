# ADR: Built-in per-conversation Observer Guard

- Status: Accepted
- Date: 2026-11-17
- Amends: [configurable local output guards](configurable-local-output-guards.md)
- Related: [runtime](../spec/03-runtime/02-agent-runtime.md),
  [IPC](../spec/03-runtime/01-ipc-protocol.md),
  [storage](../spec/03-runtime/04-data-storage.md),
  [settings](../spec/04-ux/06-settings-ia.md)

## Context

The standalone Observer plugin can only approximate turn membership through
public session reads, and its assessment history disappears on reload. The
requested product behavior is a conversation-level choice alongside Agent/Plan,
with a separate observer model and effort selected in Settings. Guarding a live
turn belongs to the existing runtime, not to a plugin that posts a new request
or executes a reviewer-authored action.

## Decision

Add local session `observerMode: off | observe | guard`, independently of mode
and permission. Missing values, newly created sessions and forks are off. A
fork does not inherit consent to send content to an independent model. Session
configuration retains the existing idle gate. Remote/native sessions do not
expose the local control and do not silently forward it to unsupported hosts.
Rust owns the additive schema migration and durable session value.

The composer displays one compact Observer Guard entry after the delegation
control. Off is neutral, Observe and Guard are explicitly labeled. Settings →
Behavior owns `observerGuard`: explicit provider/model and canonical thinking
level, a bounded deadline, evidence size, recent-tool count and an opt-in for
raw tool-result excerpts. Selecting a model alone never enables any session.
There is no implicit fallback to the main model, default provider or subagent
pool. Unsupported/missing models and effort remain visible rather than silently
remapping. Credentials remain in the existing Host/Main/sidecar boundaries.

The Node runtime observes at most one eligible text-only normal-stop candidate
per user turn, after local correction paths. It makes an independent tool-free
completion against the exact configured model. Its input is a bounded current
user goal, the exact candidate answer and selected current-turn tool receipts;
system instructions, model reasoning and tool arguments are not included.
Tool-result text is opt-in and best-effort redacted. No reviewer transcript,
verdict or raw reasoning is inserted into the main-model context.

Observe records an advisory only. Guard may request a continuation only for a
strictly validated, high-confidence incomplete verdict with matching evidence,
when local task/lifecycle checks also allow it. It consumes the existing shared
corrective allowance, preserves successful tool receipts and uses a fixed
short temporary reminder, never a reviewer-authored command or synthetic user
message. It cannot bypass Stop, user questions, discussion-only scope, approvals,
permissions, unsafe tool effects, pending steering or other active work. Unknown,
low-confidence, truncated, malformed, failed or timed-out assessment does not
authorize an action. Existing local guards remain independent and optional.

Both enabled modes may add bounded completion latency. Show checking state while
the observer is running; keep Stop effective. User-turn cancellation and observer
timeout abort the independent request. No observer retry loop, tool calls or
native search is allowed. Reused runtimes adopt new configuration next turn, and
late results cannot mutate another turn or revive work. There is no assessment
for host completion notices or an inherited historical task.

A bounded `runDiagnostics.observer` record identifies the exact message, mode,
selected model/effort, times, status, verdict/confidence, concise redacted reason,
evidence IDs, usage and whether continuation was authorized/blocked. Optional
skip/continuation reason codes and the first blocking tool's bounded identity
make local gating observable without forwarding tool arguments or output.
The record remains owned by its response, but its summary is displayed once
outside the turn's folded process. Details link to the assessed response and
evidence; continuation is explicitly not a second verification. The composer
remains inspectable during execution while mode changes stay idle-gated.

Post-response diagnostic updates are persisted before whole-turn completion.
The Host's existing idempotent append boundary gains a narrowly validated
diagnostic-only refresh, not a general upsert: immutable response content and
unrelated metadata are preserved, identities must match, and stale checking
cannot replace terminal evidence. This repairs the prior gap between live
observer updates and an already-settled durable response. Extensible metadata
keeps old rows compatible without a new schema/table or reconstructing missing
history. Diagnostics remain separate from primary-model usage and are advice,
not proof of correctness. No new result database or global reviewer dashboard.

## Compatibility and safety

- Old settings have no selected observer model; old messages have no assessment.
- A versioned Host migration preserves existing sessions and defaults them off.
- The original external plugin source/package is preserved, not automatically
  installed, disabled or uninstalled. Users should disable it when choosing the
  built-in feature to avoid duplicate independent assessments.
- Shared validation rejects malformed writes; explicit user selection is model
  authorization for this narrow tool-free feature, not general delegation.
- Sending excerpts may reveal private task content even after best-effort
  redaction. The settings describe the additional model cost and privacy boundary.
- No provider name is hard-coded. Model accuracy, protocol reliability and
  self-reported confidence are not guarantees.

## Verification

Use synthetic provider/Host edges and isolated storage. Verify default/off/no
model, exact binding and effort, no search/tools, input budgeting/redaction,
strict verdict/evidence validation, Observe vs Guard, common corrective ceiling,
Stop/deadline/stale replies, inherited runtime state and session switching,
durable diagnostic roundtrip, migration/reopen/fork defaults, config validation,
composer selection, unavailable model repair and all shipped locales. No real
provider, daily profile, installer or live Desktop is a default test target.
