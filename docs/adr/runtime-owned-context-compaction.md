# ADR: Runtime-owned context compaction initiation

- Status: Accepted
- Date: 2026-11-11
- Deciders: PI-Desktop core
- Amends: ADR 0064 / D203

## Context

ADR 0064 made `new_context` a model-facing request path and added per-window
system-prompt reminders inviting its use. Automatic compaction is already owned
by the desktop runtime and guarded by the derived context budget, so exposing a
second model-controlled initiation path adds tool-catalog and prompt surface
without improving the provider-request safety boundary.

## Decision

1. Context compaction initiation is runtime-owned. Automatic compaction remains
   inline at `floor(hardLimit * 0.9)` before the next provider request, and
   `hardLimit` remains the fail-closed provider-request guard.
2. Remove `new_context` from every model-facing catalog. It is neither active
   nor discoverable through `ToolSearch`; no system-prompt reminder invites the
   model to call it. Both budget reminders remain informational: preserve durable
   work and continue the current task while the runtime manages compaction.
3. Preserve explicit trusted initiators: the user's idle `/compact` command and
   the trusted-extension `ctx.compact()` API. They use the existing compaction
   lifecycle.
4. Preserve the `summary` and `fresh_window` families, retained-tail and
   active/completed-turn rules, durable checkpoint chain, transcript divider
   rows, and storage semantics unchanged. This amendment does not change event
   reasons or effective-window calculation.
5. Keep the existing `new_context` subagent deny-list entry. Legacy transcript
   rows, including historical `CompactContext` calls, remain readable data;
   they cannot register or reactivate a removed built-in tool.

## Consequences

The model cannot request an early context rollover. Automatic runtime protection,
manual user compaction, and trusted extension compaction remain available, while
legacy history stays compatible and inert.

## References

- [ADR 0064](0064-codex-parity-context-compaction.md)
- `docs/spec/03-runtime/02-agent-runtime.md`
- `docs/spec/03-runtime/03-tools-and-permissions.md`
- `docs/spec/07-plugins/16-trusted-extensions.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `docs/spec/08-meta/decisions-log.md` (D203, D686)
