# ADR: Local performance captures and incident records

- Status: Accepted (personal edition)
- Scope: Desktop Main and primary-window preload; no Host storage, provider or Plugin SDK change

## Context

The main window's DevTools and tool outcome logs cannot attribute resource
usage across local processes while a user reproduces a stall away from Settings.

## Decision

Use the existing developer gate and keep the sole recording in Electron Main,
not in the settings component. The user must be able to navigate to a slow
conversation while recording it. Only the trusted main frame can request a
capture; only a completed, previewed capture can be saved through a native
dialog. No general tracing API, arbitrary process lookup, renderer-supplied
path or upload is introduced.

A separate primary-window recorder runs without developer mode or an explicit
capture. Main retains a small, short-lived ring of Main and renderer counters
and writes it only on a significant delay, responsiveness transition or
unexpected renderer exit. The sandboxed main preload echoes one outstanding
heartbeat at a time; no page-callable channel, renderer content or tracing
session is needed. Unexpected exits are written before recovery reloads, using
the PID observed while the renderer was alive. The existing rotating app logger
owns retention. This does not revive continuous timing logs removed by
[ADR 0212](0212-remove-diagnostic-timing-log-streams.md).

## Consequences

A snapshot uses fixed process roles and runtime-owned PIDs. Release render
stages contribute numerical counts and durations only during a bounded recording;
the richer development/test samples remain separate. Working sets can contain
shared pages, unavailable metrics stay unknown, and timer delay is a clue to
investigate rather than proof of a faulty thread or function. Existing DevTools
remains the next step for a detailed flame chart or heap investigation.
An abrupt Main or OS exit, an unavailable disk, or a crash before the first
measurement can leave incomplete or no evidence. Heartbeat round-trip and
sampled process counters do not identify a particular stack, allocation or heap.

See [logging and observability](../spec/03-runtime/09-logging-and-observability.md#on-demand-performance-diagnostics)
and the [local IPC contract](../spec/03-runtime/01-ipc-protocol.md#developer-performance-diagnostics-local-desktop-only).
