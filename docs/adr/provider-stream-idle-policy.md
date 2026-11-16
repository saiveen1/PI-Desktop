# ADR: Configurable provider transport idle policy

- Status: Accepted for personal beta implementation, 2026-11-12.

## Context

A main-session request could return HTTP 200 and reasoning, then produce no
normalized model events for 180 seconds. Desktop cancelled the request and
replayed it through the ordinary ten-retry transport budget. Long-context
reasoning and SSE heartbeats are not equivalent to a broken connection, and
replay does not resume an upstream generation checkpoint.

## Decision

Add optional `providerStreamIdleTimeoutMinutes` to the existing Host-owned
application settings JSON (integer 0-60; default 10; zero disables the local
cutoff). Desktop and headless launchers pass the preference to the next main
turn; reused runtimes refresh it without changing active attempt budgets.
The additive field uses the existing settings/config-sync contract and requires
no table migration or protocol version bump.

Observe successful response bytes inline for adapters supporting custom fetch.
Adapters refusing it retain their transport and use provider-event fallback.
Keep a separate 180-second model-event silence hint on `waiting-model` via the
optional `slow` flag. Older status consumers may ignore that additive flag.
Neither clock bounds total generation time. No request or response content is
stored by the observer.

Local transport silence ends once as `PROVIDER_STREAM_IDLE_TIMEOUT`, outside
all automatic retry budgets. Keep partial text/thinking visible but never
execute incomplete tool calls. Explicit user cancellation remains immediate.
Ordinary transport errors, rate limiting, tool timeouts, compaction and child
agent lifetime policies are unchanged.

## Consequences and verification

A heartbeat-only connection may remain open until the user stops it. The UI
must not present heartbeats as productive model work. Disabling automatic
cutoff requires manual intervention for a truly stuck request. Cancellation
cannot guarantee that a remote gateway stops billing.

Controlled-clock runtime tests cover heartbeats, partial-output retention,
non-replay with infinite retry enabled, cancellation, next-turn settings reuse,
and timer cleanup. Settings boundary, component callback, desktop/headless
launch, Host persistence and config-sync tests cover producers and consumers.
Installed-profile upgrades and real-provider behavior are not inferred from
these isolated tests. See the runtime and settings specifications for behavior.
The [unreleased change notes](../releases/unreleased-provider-stream-idle.md)
record the user-visible changes without modifying historical release records.
