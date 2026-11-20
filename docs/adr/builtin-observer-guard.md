# ADR: Built-in per-conversation continuation modes

- Status: Accepted; simplified 2026-11-20
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
configuration remains idle-gated and unsupported remote/native/scheduled paths
remain disabled. No plugin installation/removal is implied.

Both enabled modes use `observerGuard.maxContinuations` (integer 1-100, default
3), a separate per-user-turn count of automatic continuation requests. Tools and
transport retries do not reset it. Enabled modes replace legacy normal-stop
checklist/early-end nudges rather than stacking them. Tool-call repair and
transport recovery keep their own budgets. At the limit, report the limit and
stop; do not make another independent request.

- Endless makes no judgement and never resolves or calls a reviewer. It sends
  the fixed continuation reminder after every eligible normal reply, including
  a completion statement, until the limit or an actual runtime stop boundary.
- Guard sends only the latest assistant reply and an editable reviewer prompt
  to the exact chosen model. It accepts only `continue` or `stop`. Each new final
  candidate can be assessed; the same candidate is never assessed twice.
- Settings expose prompt editing/reset and the continuation count. Blank prompt
  restores the default; prompt length is bounded at 8,000 characters. Existing
  model/effort, deadline and reply-size controls remain Guard-only. Deprecated
  tool-output/count settings can be read but do not forward data.

Remove the historical task tracker, arbitrary tool-name safety whitelist,
confidence/evidence schema and keyword-based refusal/input veto. Semantic
judgement belongs to the configured reviewer prompt. Literal words such as
"refusal", "permission" or a question mark do not decide execution.

Keep actual Stop, Plan/mode closeout, steering, pending tools/delegates and input/
approval workflows authoritative. Endless does not infer a pending user question
from plain text. It never supplies an approval or an answer to an input card.
Error/abort/length/empty replies are not this mode's normal-stop continuation.
No retry loop, provider fallback, native search or reviewer tool use is added.
An optional `continueOnTransientError` setting (default false) lets the existing
provider retry owner use remaining automatic-continuation capacity after its
normal retry budget is exhausted. This applies to classified retriable network,
transient service and rate-limit failures in Agent mode, without a reviewer call.
It preserves backoff, successful receipts and the existing independent infinite
retry policy; it cannot reset the continuation count or retry permanent/local/
certificate failures, Stop or mode closeout.

The fixed one-request reminder continues the same Agent context without a fake
user message, preserving original constraints and completed receipts. Reviewer
text cannot become a command. Guard redacts its bounded last-reply input and
keeps its provider-side context independent of the main conversation. A reviewer
failure settles visibly and does not authorize continuation.

New diagnostic records store decision, continuation count/limit and stop reason
on the owning response; Guard additionally stores independent usage/model data.
Historical Observe/verdict/confidence/evidence fields remain display-compatible.
The latest result is shown as the turn summary; earlier records stay attached
to their responses. Neither "continued" nor "stop" proves task completion.

## Verification and limits

Use synthetic real Agent loops and external provider/Host stubs to verify exact
N+1 main requests, zero reviewer calls in Endless even without configuration,
multiple Guard reviews, limit/no-progress bounds, custom prompt/reset, no history
or tool output forwarding, Stop/disposal/steering and malformed/timeout paths.
Verify IPC/Host writes, populated migration, reopen, fork-off and legacy metadata,
plus isolated renderer settings/picker interactions and every locale.

No running Desktop, daily profile or real provider is a default test target.
Endless may make unnecessary billed requests; Guard is fallible and a custom
prompt may be less conservative. The count and runtime permission system are
hard limits, not claims about task correctness.
