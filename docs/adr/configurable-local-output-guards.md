# Configurable local output guards

- Status: Accepted
- Date: 2026-11-17
- Scope: Desktop-managed Agent execution and local output diagnostics
- Related: [runtime](../spec/03-runtime/02-agent-runtime.md),
  [settings](../spec/04-ux/06-settings-ia.md),
  [logging](../spec/03-runtime/09-logging-and-observability.md)

## Context

A normal provider stop can contain a promise to perform an action without an
actual tool call. Current-turn checklist recovery cannot cover tasks that never
wrote a checklist, while the inherited progress-only recovery is limited to
approved Plan/Goal execution. Independent corrective paths must not each
replenish another path's allowance. Long exact prose repetition is also distinct
from the existing whitespace/symbol circuit breaker.

## Decision

Keep these checks deterministic and local. Add optional
`AppSettings.agentOutputGuard` with shared validation/defaults and Behavior
settings. `earlyEndMode` is `off`, `warn` (default), or `continue`. A shared
`recoveryLimit` (0-3, default 1) bounds corrective continuations in a user turn;
transport retries remain a separate policy. Existing eligibility and permission
checks are not relaxed. New settings take effect for the next user turn, including
reused runtimes, rather than mutating an in-flight request's policy.

The ordinary-Agent early-end heuristic combines current task/execution evidence
with a clear action promise, excludes discussion-only tasks, user-input/blocker
reports and unsafe lifecycle states, and never interprets model prose as an
executable call. Warnings are advisory. Continuation retains completed receipts
and adds only a temporary correction, not a synthetic user message, new tool,
constant prompt section or reviewer-model request. A bounded correction may
still fail or add model usage; uncertain side effects must be inspected before
retrying any action.

The repetitive-output switch controls the existing stream guard; a separate
paragraph switch enables conservative exact narrative-paragraph comparison.
Thresholds are shared preferences, not provider/model-name exceptions. Comparison
is bounded, does not modify received text, and excludes structured/code samples.
Detection is terminal for that request, never an automatic replay.

Record normalized termination facts in the existing `runDiagnostics` metadata,
scoped to their actual message ID. A normalized stop reason is not the provider's
raw final frame and is not proof the task succeeded. Show a settled early-end
warning only on its owning message; no warning is injected into model context.

Semantic assessment belongs to an optional external Observer plugin using public
post-turn/read-only session and standalone completion APIs. It is not a runtime
dependency, does not run unless explicitly configured, and cannot grant execution
permission or directly resume the parent Agent. Plugin failures do not block the
main turn. No new privileged plugin API is introduced here.

## Compatibility and ownership

These are optional additive settings and diagnostic fields. Old settings resolve
to defaults; old transcript rows need no synthesized warning. The existing Host
JSON settings and diagnostic metadata already preserve these fields, so there is
no database layout change or destructive migration. Renderer/Main reject invalid
writes; shared normalization handles absent/partial historical values. The
runtime remains execution owner and Rust remains durable-data owner.

## Alternatives and limits

- More global prompt rules: rejected because the normal path must not carry
  additional instructions or token cost.
- Unbounded automatic continuation: rejected because tool success is not a fresh
  recovery allowance and retries can duplicate effects.
- Mandatory secondary-model judging: rejected because it adds cost, latency,
  privacy exposure and another source of false positives to every turn.
- Arbitrary semantic repetition scoring: deferred. Exact repeated paragraphs are
  a conservative subset; alternating/rephrased loops may be missed and deliberate
  repeated prose can trigger the guard. Settings allow disabling/tuning it.

## Verification

Use synthetic provider streams and Host fixtures, shared validation tests,
settings interactions and transcript warning fixtures. Cover no-checklist action
promises, negative discussion/completion/input cases, off/warn/continue, shared
allowance exhaustion, cancellation/steering/reuse, no normal context injection,
paragraph chunk boundaries, final-only snapshots, code/table/list exclusions,
original partial output and no tool replay. Installed-app/live-provider quality
and Observer model accuracy require separate authorized verification.
