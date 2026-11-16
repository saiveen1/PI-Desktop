# ADR 0196: Show provider retry causes in the active-turn status

- Status: Accepted
- Date: 2026-09-08
- Related: ADR 0175, D358, US-UI-60d
- Note: first filed as ADR 0186, then ADR 0195.

## Context

The live `retrying` status row says a provider request is being retried but not
why, even though the classified cause already becomes a structured assistant
error once the retry budget is exhausted. Users should be able to inspect the
cause during backoff without a duplicate transcript error.

## Decision

Extend the shared `AgentActivity.retrying` payload with optional bounded error
details: the stable error code, the already-redacted and length-limited provider
message, and the HTTP status when known. The runtime supplies the details for
both request-setup and mid-stream retries.

The renderer keeps a compact retry row at rest. Run diagnostics now share one
neutral opaque, portaled details dialog across ordinary running, retrying and
completed summaries. Hover/focus reveals it, click pins it, and Escape or an
outside click dismisses it; ArrowDown enters the details action. During backoff
the dialog retains the localized error summary, stable code/status and bounded
provider message. After recovery, cumulative retry counts and the latest stable
failure code remain available without retaining provider prose. The final
assistant error and outcome surfaces remain the only terminal error presentation.
This supersedes the original retry-only error-tinted tooltip without changing
runtime retry policy or adding intermediate transcript errors.

## Consequences

- Users can identify rate limits, timeouts, network failures, and provider
  errors while waiting, with retry behavior unchanged.
- Only diagnostics the runtime already classified and redacted cross the
  protocol boundary.
- Older status payloads without `error` still render the ordinary retry label.

## Alternatives

- Use only a native `title`: rejected; it cannot match the error presentation or
  give consistent keyboard access.
- Add an assistant error row for every retry: rejected; a successful same-turn
  retry would look like a failed turn.
