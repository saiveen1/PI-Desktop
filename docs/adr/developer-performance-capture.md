# ADR: Opt-in local performance captures

- Status: Accepted (personal edition)
- Scope: developer-only Desktop IPC; no persistence, provider or Plugin SDK change

## Context

The main window's DevTools and tool outcome logs cannot attribute resource
usage across local processes while a user reproduces a stall away from Settings.

## Decision

Use the existing developer gate and keep the sole recording in Electron Main,
not in the settings component. The user must be able to navigate to a slow
conversation while recording it. Only the trusted main frame can request a
capture; only a completed, previewed capture can be saved through a native
dialog. No general tracing API, arbitrary process lookup, renderer-supplied
path, upload or always-on timing log is introduced. This preserves the normal
logging decision in [ADR 0212](0212-remove-diagnostic-timing-log-streams.md).

## Consequences

A snapshot uses fixed process roles and runtime-owned PIDs. Release render
stages contribute numerical counts and durations only during a bounded recording;
the richer development/test samples remain separate. Working sets can contain
shared pages, unavailable metrics stay unknown, and timer delay is a clue to
investigate rather than proof of a faulty thread or function. Existing DevTools
remains the next step for a detailed flame chart or heap investigation.

See [logging and observability](../spec/03-runtime/09-logging-and-observability.md#on-demand-performance-diagnostics)
and the [local IPC contract](../spec/03-runtime/01-ipc-protocol.md#developer-performance-diagnostics-local-desktop-only).
