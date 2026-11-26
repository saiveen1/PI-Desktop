# Image generation and editing

The desktop exposes `AppSettings.imageGeneration` as the current default image-generation binding and `AppSettings.imageGenerationModels` as the optional list of models marked for image generation. The legacy single binding remains supported: when the list is absent, it is treated as the only candidate. A null or empty current binding means no default; host-core validates and persists both fields through the existing settings store. No schema bump is needed. A reference that no longer matches an existing provider row is not persisted: host-core drops the current binding and the matching candidate on every settings read and write, mirroring the reference rule config sync applies when it applies a bundle, so a deleted provider cannot leave behind a default the runtime must reject. Each candidate is independent of the conversation default and references an existing enabled API-key or no-auth provider and one of its configured models.

## Configuration

Saving a provider confirms the provider was saved or updated, including when
image capabilities were marked or unmarked. It must not claim that an image
model was selected after deselection. Choosing an image default from the
summary menu retains the image-selection confirmation. A pick the menu can no
longer offer — the stored candidate list changed between the menu rendering and
the click — reports that the image model could not be saved instead of silently
keeping the previous default.

Model Advanced exposes **Set as image model** alongside the image and document attachment capabilities in the model capability group, not as a separate control row. The checkbox is multi-select: saving a provider persists every checked model in `imageGenerationModels`; Cancel leaves settings unchanged. Saving candidates does not replace the default conversation model. Unchecking every image model on the provider that holds the current default clears that default, even when another provider still has a runnable candidate. The Models page drops the check and does not select the other candidate automatically. Unchecking the current model while another model on the same provider stays marked moves the default to the first runnable marked candidate. The unmarked model is available for chat again after saving and reopening settings. Saving another provider preserves a still-runnable image default. Below the default model row in the same defaults panel, **Image generation model** shows the current default and offers a menu to choose one from all marked candidates. When no candidate is configured, or none of them can be selected, the summary row is hidden. A candidate whose provider still exists but is disabled, credential-less or otherwise unusable displays only **Currently unavailable** while another marked candidate can still be selected; a candidate whose provider row is gone is dropped from the stored list on the next settings read or write instead of staying listed. A signed-in ChatGPT (Codex) account is eligible for its own image model, which its provider row offers next to the models it configures; every other OAuth account is not, and there is no fallback.
Only a pure image-generation endpoint is excluded from the default conversation picker, provider quick-default action, and Composer model menu; a marked model that also supports conversation keeps its chat eligibility everywhere, because the image binding is host-owned and independent of the conversation route (#2253). A pure image-generation endpoint is recognized by a model id its family reserves for image generation (for example `gpt-image-*`, DALL·E or Imagen ids) or by published output modalities that name no text output; unknown custom metadata stays chat-eligible. Other providers with the same model ID remain independent. Existing conversation bindings and history are preserved; a conversation still pinned to a pure image candidate must select a chat model before sending. Runtime launch rejects a marked pure image-generation model before inference.

The marking checkbox has localized help explaining chat/default-menu exclusion
after saving and distinguishing image generation from image input. A marked model
also carries an image-model badge in its collapsed settings row. Unknown custom
models remain manually configurable; the help asks users to mark only models
their endpoint supports for generation (#1789).

### Provider model removal

Saving a provider after explicitly removing a configured model also removes
that model's image candidate, even if the image capability checkbox was not
touched. If it was the active image default, clear the default, even when another
runnable candidate remains on this or another provider. Cancel preserves
both the provider models and the image settings. Legacy single bindings follow
the same rule. Unchanged image selections retain the ordinary provider-save
path. External provider changes can still leave an unavailable binding visible until the next settings read or write, which drops a binding whose provider row is gone.
The existing chat-default repair still runs if the saved provider no longer
contains its selected chat model; otherwise the chat default is preserved.

## Agent contract

`GenerateImages({items: [{prompt, count?, images?}]})` is an Agent-mode tool.
`count` defaults to 1. Both distinct prompts and same-prompt variants are supported,
with 1–10 output images total. An optional `images` array supplies 1–4 local source
files per item for editing; a previous generated path supports iterative edits.
Prompt length is bounded at 32,000 characters. Unsupported or excessive input is
rejected rather than truncated. Plan and Goal cannot execute the tool.

The bundled `pi-desktop/imagegen` skill is discoverable in ordinary sessions and
loads through the existing Skill tool. It teaches prompting, batches, reference
edits, preserving originals, partial-failure handling and project asset delivery.
It does not grant permission or carry credentials.

The trusted desktop bridge first calls host-core `tools.execute` with the same
identity, arguments and permission scope. Host-core applies the existing high-risk
tool policy and returns authorization only. The bridge executes the image service
only after approval. The host authorization audit is distinct from the actual
sidecar tool result. Runtime cancellation reaches both pending approval and the
network request; host loss or sidecar disposal aborts local work.

## OpenAI Images adapter

Only OpenAI-compatible Images is supported. A root base URL acquires `/v1`; an
explicit path prefix is retained. Generation uses `POST images/generations` with
`model`, `prompt`, `n: 1`. Editing uses `POST images/edits`, multipart image files,
the prompt, model and `n: 1`. No browser mask editor is included. A configured
service may implement generation without editing; its error is reported without
silently switching to generation or another model.
For exact DALL-E 2/3 model IDs, generation requests explicitly ask for
`response_format: b64_json`; the same form field is used for DALL-E edits where
supported. GPT Image and unknown compatible model IDs omit that parameter.
Editing retains binary multipart uploads (`image` for one reference, `image[]`
for multiple), with the transport generating the Content-Type boundary.

Each batch snapshots the binding and provider before dispatch, uses two workers,
and returns results in input order. Each output has a 180-second request budget.
Requests are never automatically retried. Authentication failure stops queued
work. Cancellation stops queued work and aborts active HTTP; it cannot promise the
upstream provider stopped processing or billing. Completed output files survive.

Responses accept exactly one Base64 image or HTTPS image URL per request. JSON and
download bodies are bounded; image files are capped at 16 MiB and restricted to
PNG, JPEG and WebP signatures. Downloads use checked, pinned public DNS addresses,
reject redirects and private destinations, and never receive provider headers. When
Settings > General > Network explicitly enables proxy fake-IP support, a
benchmark-range fake-IP answer uses the app's proxy-aware transport; real private,
loopback, link-local and metadata addresses remain blocked.
Input edits accept the session project, that session's scratch directory and the
attachment store after realpath containment. Each edit input set is capped at
32 MiB, with a 64 MiB input cache budget for the batch. Credentials remain outside the renderer and tool results.

## Results and recovery

Successful results and per-item failure states remain outside collapsible process
details. Standalone results remain visible. Multiple generated batches in one
assistant turn share an overview with status counts derived from result metadata
before previews load; tool details do not duplicate the gallery. Previews load
lazily near visibility. Thumbnail selection opens the shared conversation viewer,
which navigates across the turn's images. Only thumbnail presentation crops fully
transparent margins; the original canvas remains intact in the viewer and saved
file. Loading, missing, restricted, too-large, invalid and unavailable previews
are distinguishable. A reduced-resolution preview is labeled as such.

The modal viewer keeps keyboard previous/next, thumbnails, zoom, fit and a file
panel action. A blank-space dismissal requires both press and release on the
backdrop; Escape and close also dismiss and return focus without scrolling. Image,
thumbnail and control clicks do not dismiss except explicit close or file actions.
Switching images must not show the previous image under the new selection; loaded
images remain visible without a blank frame, fitted dimensions stay stable while
another decodes, and the latest navigation wins. Selection remains in chat after
closing. The contained `fs/reveal` action reports errors for missing files.
Save As is a separate action that saves the original file when the preview is
reduced. For a local session's generated raster in its own scratch directory,
the user may request the full-resolution original inside the viewer, return to
the reduced preview, and see an error if the read fails. The opt-in original
read is bounded to 16 MiB and 16 million pixels and checks the signature, decoded
dimensions and realpath containment; it never falls back to preview bytes or opens
a system application. These actions do not move or overwrite the original.

The renderer owns successful-result previews in the conversation. The bundled
imagegen skill confirms generation in text and reports failures, but does not
embed those same result paths as Markdown images; doing so duplicates the
renderer preview.

Each result records index, status (`succeeded`, `failed`, `cancelled`), successful
path/MIME type or a safe error code. New files get unique names in session scratch;
editing never overwrites its source. The tool result and transcript retain file
references, not Base64. Existing bounded image reads and file viewers serve previews.
Thrown local-tool errors preserve stable `errorCode` values across the real
sidecar RPC boundary, independently of ordinary structured tool-result failures.
Existing RPC code, message and data are retained; arbitrary Error properties
are not serialized. The sidecar receiver exposes the code alongside its data.
Successful images and per-item failures render even when only part of a batch
completed. Missing configuration returns a structured error and a Settings → Models
navigation action. The same references render after session reload/restart.
Image results and setup actions remain visible outside the turn's collapsible
process details; opening tool details does not duplicate the image gallery.
Markdown image references to generated absolute paths, including Windows drive
paths, use the existing bounded host image reader. URL sanitization stays enabled;
the host still rejects files outside its permitted workspace/scratch/attachment roots.

Validation: `node scripts/e2e-image-generation.mjs` covers host/stdio/HTTP/storage;
`node scripts/e2e-image-generation-ui.mjs` covers real React/Chromium interactions
with an API-boundary fixture. Unit/service tests cover limits, cancellation,
partial failures, authentication, timeout, unsafe paths, and bounded downloads.
`node scripts/e2e-image-chat.mjs` exercises the full isolated desktop with local
model/image HTTP fixtures: adjacent default settings, composer submission, batch
previews, editing a generated file, collapsed results, and setup navigation.
Live verification is opt-in via `scripts/test-image-generation-live.mjs`, limited
to one generation plus one edit and never a default test command.

## Tool image inspection results

The default transcript recognizes actual image content and typed references in
tool results, not a `GenerateImages` tool-name allowlist. Host `Read.images`, MCP
`content` blocks, bare plugin content arrays and restored runtime envelopes share
one compact presentation. Generated-result contracts retain their existing card,
download, setup navigation and partial-failure behavior.

Inspection results show a localized image count, the originating tool and
80-pixel thumbnails. Ordinary `Read` results are input/process context: their
images and image-input diagnostics appear at the visible call without expanding
its raw details. Folding the containing activity or process hides these previews
and closes their viewer; they never appear in the turn's delivered-image gallery.
This applies to live and restored messages,
standalone rows, all transcript display modes and subagent turns. Generated
result contracts remain outside process details even if their tool is named
`Read`; MCP/plugin image outputs retain their existing turn-level galleries.
Expanding details never duplicates a delivered gallery or dumps typed Base64.
Mirrored copies inside one result are displayed once; separate calls are never
deduplicated against one another. Thumbnails retain source message/call identity
and accessible filenames, wrapping without shrinking at narrow widths.

The count means images returned by the tool, not model analysis completed. Image
input diagnostics explicitly distinguish unsupported vision, invalid data and
input limits. Failed reads without image content never produce a success count.
The original retained image remains viewable when model input is unavailable.

Thumbnails reuse the floating image preview and its dismissal, focus,
navigation, zoom and download behavior. Typed inline raster bytes are displayed
without rereading the source file. File references use the existing session-bound
contained image reader; no network URLs or arbitrary text paths are inferred as
images. Missing/unreadable previews have a visible unavailable state. Viewer
selection is tied to the owning session and source call/image identity. Appending
images to an output preserves selection, zoom and pending decode/navigation;
switching sessions closes the viewer. Presentation never merges underlying tool
messages or provider content.

History uses the existing lossless tool-result storage and decoded image blocks;
there is no new attachment store, persistence format or migration. When a local
history projection omits valid inline image bytes, the visible gallery may load
that same session and message with the existing 256 KiB single-message content
limit. Recovered original bytes take precedence over path-only previews, so the
image remains viewable after the source moves or when its path is outside the
project. Images that still do not fit can use an existing contained file reference;
without one they remain unavailable. Model-input diagnostics and archived bytes
are unchanged.

Local generated images above the ordinary 5 MiB preview limit can use a PNG
thumbnail, bounded to a 1024 px longest edge. Source reads and decodes are
serialized, limited to the generator's byte budget and 16 million pixels, and
use the same contained image path rules. The card and viewer share the preview
cache. Saving a thumbnail-backed image opens the existing contained Save As
flow for the original file; it never downloads the preview bytes as the original.
Tests use isolated profiles and synthetic images, not the installed Desktop or a
paid provider.

## Pi 1.1.0 operation boundary

Image generation and edits execute through account-scoped Pi `Models.generateImages`.
Use native OpenRouter images or a registered compatible OpenAI-images adapter,
with JSON generations and multipart edits preserved. Each prompt is one physical
operation; no automatic retry may duplicate a billable image request. Batch
workers preserve output order, propagate cancellation/timeouts, and bound download
sizes and URL safety. Returned text, response ID and operation usage survive the
artifact projection. Multiple images from one response count as one operation.

A signed-in ChatGPT (Codex) account is the one OAuth candidate: its
`gpt-image-2.5` and `gpt-image-2` models are offered next to the models a
provider configures, even though the account's chat model list never carries
them. Such a request goes to the
vendor's Codex image routes (`{baseUrl}/codex/images/generations` and
`.../images/edits`) with the account's own OAuth token, JSON on both routes and
input images inline as data URLs. Every other OAuth account stays ineligible,
and the adapter cannot fabricate entitlement or fall back to another account.
The candidate disappears as soon as the account's credential is removed.
Unknown pricing remains unknown. Configured Images operations never route through
the chat selector; provider-hosted image output in a chat response is separate.

## Native Responses image output

Main sessions and subagents preserve `image_generation_call` items returned by
Responses-compatible chat providers. This is receipt of an existing hosted
operation, not a call to `GenerateImages`: it neither injects a hosted tool nor
selects an image model, changes approval policy, or issues a second request.

The runtime observes raw provider events before Pi projects them to chat content.
It accepts completed items from `response.output_item.done` and terminal response
output arrays (including Codex `response.done`), deduplicates repeated item
identities within each request, and
ignores partial-image previews. At most ten outputs are retained per response.
Each image is standard Base64, at most 16 MiB decoded, and PNG/JPEG/WebP identified
from its bytes. Shared dimension limits and complete raster decoding apply before
writing. Provider filenames, paths, URLs and format labels never select a target.

Validated bytes are saved with exclusive UUID filenames under the Host-supplied
session scratch directory after realpath containment checks. No scratch directory
means an explicit storage failure, not a fallback to cwd or an installed profile.
Completed files survive cancellation. The assistant's text receives local Markdown
image references, reusing existing transcript persistence, contained preview reads,
file actions and model-context replay without embedding Base64. The current 5 MiB
inline-preview limit is unchanged: larger retained files use the existing file-chip
fallback. Deleting the referenced file makes the preview unavailable; no automatic
regeneration occurs. There is no database or message-schema migration.

Image-only success is visible output, never a silent-response retry. Invalid,
oversized, incomplete or unsavable results surface a bounded local diagnostic;
completed siblings remain linked. A failed response after hosted-image activity
cannot automatically replay generation. Cancellation retains its aborted status,
and events arriving after finalization cannot save additional files.

Offline coverage: `hosted-images.test.ts` drives the actual Responses parser and
filesystem; `hosted-image-runtime.test.ts` enters the public prompt path, checks
one-request delivery/recovery, history projection and subagent bindings. No paid
provider or daily Desktop profile is required.
