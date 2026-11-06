# ADR: Unified core notification delivery

- Status: Accepted, implementation candidate
- Date: 2026-11-06

## Context

Core questions, permissions, plans and task outcomes had separate presentation
paths. Delegation approvals already had an application-wide authorization
surface, but no shared reminder policy. Treating every reminder as an inbox row
would mix transient consent with durable outcomes; asking agents to deliver
reminders would add execution and retry obligations unrelated to their work.

## Decision

Store optional version-1 preferences under `AppSettings.notifications`, using
the existing settings boundary, shared validation/resolution and strict Rust
validation. Defaults resolve in memory; opening settings does not persist them.
Preferences are installation-local and excluded from configuration sync.

Settings → Notifications owns the global master, channel, sound/volume and
needs-action/failure/completion categories. Subagents → Scheduling owns only
`notifications.delegation`: inheritance or a custom reminder policy. Both entry
points use one serialized read/merge/write service. The global master always
wins. No notification preference grants model consent or changes scheduling.

The renderer runtime owns event subscriptions, safe localized summaries,
in-app presentation, audio and the live pending projection. Electron Main owns
final native policy checks, typed target validation, stable identities,
activation and native object disposal. Host/runtime services remain authoritative
for requests and task state. Admission exhaustion adds a machine-readable error
classification without changing selection, fallback, cancellation or model calls.

Automatic selects application-wide in-app reminders while focused and system
requests otherwise. In-app-only never requests native delivery; System may
request it while another chat is foregrounded. Exact-visible task outcomes
remain suppressed. Explicit unsupported/failed native delivery falls back in-app;
an accepted API request is not proof that the OS displayed a banner.

The bell separates live Needs action from the bounded durable task inbox. Bulk
read/clear affect history only. Notifications navigate to existing controls,
rechecking liveness around asynchronous navigation; they never approve, revive
or resubmit a request. Stable source/session/request/host identities deduplicate
snapshots, events and remounts. Repeats are opt-in (0 or 10–300 integer seconds),
only while pending, and never extend an approval deadline.

Keep plugin-native notifications permission-gated and separate. Their extension
contract and ordinary toast feedback do not inherit core preferences. Native
sound remains silent when the application supplies its existing soft chime.

## Consequences

There is one reminder preferences source without a new database table or durable
approval-history schema. Source state and history remain usable with reminders
disabled or delivery failures. Every timer, subscription and native object has
an owner and retirement path. Verification uses isolated production components,
synthetic events, controlled clocks and mocked native/audio boundaries; actual
Windows banners, Do Not Disturb and physical audio are not inferred from tests.

## Alternatives

- Agent-authored notification tools/prompts: rejected because presentation must
  not introduce provider requests, retries or notification-specific obligations.
- Persist pending consent as task history: rejected because read/clear semantics
  must never settle an authoritative request.
- Merge plugins into core preferences now: deferred to avoid changing existing
  extension permissions and notification behavior.
