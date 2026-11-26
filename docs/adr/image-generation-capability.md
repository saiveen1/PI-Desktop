# ADR: Image generation as a configured Agent capability

- Status: Accepted
- Date: 2026-09-21
- Related: ADR 0101, ADR 0172, ADR 0281;
  [image generation spec](../spec/03-runtime/21-image-generation.md)

## Context

The desktop understands image input and previews but has no image production
path. Users need one selectable image model, conversational generation and
editing, and batches without changing their default chat model, which a Skill
alone cannot execute and pure image endpoints cannot serve as chat adapters.

## Decision

Keep a separate optional settings binding referencing existing provider
credentials, exposing one Agent tool plus a bundled, lazily loaded imagegen skill,
with an independent OpenAI Images adapter and batch scheduler in agent-runtime
while the desktop service coordinates host-owned settings, credentials, contained
source files, and saved output. Because the local-tool shortcut performs no host
permission check, this billable tool obtains host-core authorization through
`tools.execute` before invoking the local service, so host-core never performs
the HTTP call, and local tools gain an abort signal for cancellation, timeout, and
process loss.

## Consequences

- Optional settings preserve stored data and conversation defaults, with no
  schema migration, plugin API change, or direct renderer credential access.
- Partial results stay useful and nothing retries automatically, avoiding
  duplicate paid work, and headless hosts without the image runner do nothing.

## Alternatives

- An independent image workspace: rejected; it would duplicate conversation and
  history ownership.
- A shell or API-only skill: rejected; it would bypass model settings and require
  scripts to handle credentials, files, and retries.

## 2026-11-17 amendment: receive provider-hosted image results

Responses chat providers can return native `image_generation_call` items even
when no local image tool runs. Pi's chat projection currently discards those
items, so tool-count history is not evidence that no billable image was produced.

Use the existing raw provider-event hook in the main/delegate runtime to validate
and save completed hosted images into the Host-supplied session scratch directory.
Deliver contained local Markdown references through existing assistant text,
history and preview contracts. Keep bytes out of provider replay and avoid a new
message type, attachment store, IPC method or dependency patch. The configured
GenerateImages operation and its approval boundary remain unchanged.

The receipt wrapper does not advertise or request hosted generation. It preserves
completed output on cancellation and makes delivery failures terminal to automatic
replay. Existing inline-preview limits still apply; larger files remain accessible
through the file-chip fallback. This accepts providers' native output without
pretending that a local function tool executed.

## Amendment: opt-in local original viewing

The existing image IPC gains an opt-in original read for the owning local
session's scratch raster only. It retains realpath containment, validates the
generated format and decoded dimensions, and caps source bytes and pixels at
16 MiB and 16 million. It returns the original bytes, not a reduced preview,
only after an explicit viewer action. Other reads keep their existing 5 MiB
limit. This does not authorize a generic file read, OS shell open, regeneration,
remote session read or new persistence; Save As remains a distinct action.
