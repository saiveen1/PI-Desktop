# Unreleased: long-context provider waiting

These notes describe the local candidate, not a published or installed release.

## Added

- Settings > Behavior > Model connection idle timeout, defaulting to ten minutes
  with longer waits and a Disabled choice. Saved preferences apply next turn.

## Fixed

- SSE heartbeats no longer look like a stalled model connection on fetch-capable
  adapters. Three minutes without new model content displays a waiting hint
  instead of restarting the request.
- Local idle expiry stops without automatic replay, including when infinite
  provider retry is enabled. Partial text remains visible as incomplete.

## Compatibility

Existing settings and conversation data remain intact. Ordinary network-error
recovery is unchanged. Disabling idle cutoff can require manual Stop; a gateway
may continue processing or billing after the client cancels.
