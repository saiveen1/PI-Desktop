# ADR: Built-in per-conversation continuation modes

- Status: Accepted; both modes amended to use settled-turn follow-ups
- Original date: 2026-11-17
- Amends: [configurable local output guards](configurable-local-output-guards.md)
- Related: [runtime](../spec/03-runtime/02-agent-runtime.md),
  [IPC](../spec/03-runtime/01-ipc-protocol.md),
  [storage](../spec/03-runtime/04-data-storage.md),
  [settings](../spec/04-ux/06-settings-ia.md)

## Context

The earlier Observe/Guard design tried to prove task completion from a bounded
history/tool window. It could discard the actual goal, confuse mentions of a
refusal with a refusal to act, and stop supervising after one correction. The
2026-11-18 task-history amendment did not solve those product limitations.

The requested product is smaller: automate saying "continue", optionally asking
an independent model whether another continuation is useful. It is not an
acceptance system or a new permission authority.

## Decision

Keep explicit local per-session consent, replacing Observe with Endless:
`off | endless | guard`. New sessions and forks are off. Migrate stored Observe
to off rather than turning advisory consent into automatic execution. Keep old
assessment metadata readable. Host owns the versioned transactional migration;
the redesign adds no further migration. Native, remote and scheduled paths
remain disabled. No plugin installation/removal is implied.

`observerGuard.maxContinuations` (integer 1-100, default 3) bounds the chain
in either enabled mode. Both replace legacy normal-stop checklist/early-end
nudges rather than stacking them. Tool-call repair and built-in provider
recovery keep their existing budgets.

- Both leave the main Agent's final answer intact. Only Desktop's live turn
  owner can submit a visible automatic user-role **Continue** through ordinary
  new-turn admission after settlement. Neither mode injects a same-turn system
  reminder. Endless marks eligible replies without a reviewer, even if they
  say the work is complete.
- A chain starts with one human input. Admitted auto turns and opt-in extra
  transport recovery draw from one original cap. Auto turns and successful
  retries do not replenish it; when exhausted there is no follow-up. A new
  human input supersedes the chain. No historical marker, reload, replay, or
  restart can send a follow-up; stale or duplicate completion is not admission.
- Off can revoke either enabled mode while busy, without changing other
  configuration. Revocation wins over a follow-up not yet admitted and does not
  abort the current main Agent turn. A Guard review already started may finish,
  but its stale result cannot dispatch. Ordinary Stop still stops active work.
  Enabling or changing to another enabled mode is idle-only.
- Guard alone sends the latest assistant reply and editable reviewer prompt to
  the exact configured independent model. It accepts only `continue` or `stop`.
  A terminal `continue` is a decision, not a send; it uses the same live
  admission as Endless after settlement. Zero budget blocks review and dispatch.
- Settings expose prompt editing/reset and the continuation count. Blank prompt
  restores the default; prompt length is bounded at 8,000 characters. Existing
  model/effort, deadline and reply-size controls remain Guard-only. Deprecated
  tool-output/count settings can be read but do not forward data.

Remove the historical task tracker, arbitrary tool-name safety whitelist,
confidence/evidence schema and keyword-based refusal/input veto. Semantic
judgement belongs to the configured reviewer prompt. Literal words such as
"refusal", "permission" or a question mark do not decide execution.

Keep actual Stop, Plan/mode closeout, steering, pending tools/delegates and
input/approval workflows authoritative. Endless does not infer a pending user
question from plain text or supply an approval or an answer to an input card.
Error/abort/length/empty replies are not eligible normal-stop continuations.
The normal turn path preserves context and tool receipts without replaying
completed actions or granting new authority, permissions, or I/O capabilities.
Desktop uses existing Host and runtime checks to revalidate admission.
Guard redacts its bounded last-reply input and keeps its provider-side context
independent of the main conversation. Reviewer text cannot become a command;
review failure settles visibly without authorizing continuation.

Built-in provider retries (including the independent infinite-retry policy)
remain unchanged in both modes. Optional `continueOnTransientError` (default
false) allows extra recovery after built-in transient or rate-limit exhaustion.
It uses the same remaining chain allowance as admitted follow-ups in either mode.
Recovery stays in the ongoing turn's transport path, without a Continue
message or reviewer. Backoff, prior receipts, permissions and existing failure
and cancellation boundaries stay intact.

`runDiagnostics.observer` stays on its owning response, using the existing count
and limit fields. Guard retains separate reviewer usage/model details. Terminal
metadata can record per-turn extra recovery claims; it is not a sent receipt.
Only an admitted follow-up appears as a Continue message, with the cumulative
allowance consumed, not the provider retry count. Historical assessments remain
readable and cannot dispatch. Neither mode verifies success.

## Verification and limits

Verify distinct turns, intact prior answers, one cap shared with opt-in recovery,
and zero reviewer calls in Endless. Exercise Stop, Off during the main model or
review and before admission, duplicate terminal events, reload and persisted
history. Verify Guard's exact reviewer, strict reply-only input, prompt/reset,
and that only an eligible live `continue` can lead to admission. Cover busy
revocation without broader config changes, populated migration, fork-off and
historical diagnostics with synthetic providers and isolated Host/renderer fixtures.

No running Desktop, daily profile or real provider is a default test target.
Endless may make unnecessary billed requests; Guard is fallible and a custom
prompt may be less conservative. The count and runtime permission system are
hard limits, not claims about task correctness.
