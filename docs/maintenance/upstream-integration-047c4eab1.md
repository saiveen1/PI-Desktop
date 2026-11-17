# Upstream integration: 047c4eab1

## Sources and authorized scope

- Initial personal main: `e72fdba94ebb18f754e640747b2441105d156a5f`.
- Common upstream base: `29043af3371122e256bf265db31651da125d38e3`.
- Fetched upstream: `047c4eab1c97a349b3cf8c734229b64ed9d87764`.
- Sidebar preservation commit: `eed8b3231` (20 originally dirty paths).
- Subagent preservation commit: `6cde8ffbf` (42 originally dirty paths).
- Both worktrees originally pointed to `ed93df9c8`; merging their old branch
  tips would not have imported their uncommitted features. The user explicitly
  authorized preservation commits and local integration, not publication,
  worktree deletion, installation or a live Desktop launch.
- Order: preserve both sources, merge sidebar, merge subagent, then merge
  upstream. The local integration tip is `a0d56d6c3`.

## Preservation evidence

Private snapshots used separate objects and indexes in session scratch.
Immediately before preservation, all three original HEADs, branch references,
indexes, status records and dirty-file SHA-256 values still matched capture.
The two preservation commits match their captured trees exactly. Both actual
local merge trees match the sequential preview. The combined local change set
is exactly 59 unique paths: 53 non-overlapping side entries and all five new
files match their source blobs/modes; other main entries remain unchanged.
Shared README and specification additions were retained together.
The final staged audit also retained all 435 locally added paths. Outside the
incoming upstream path set, 4,082 entries match the local integration exactly;
seven intentional repair/test/documentation paths are explicitly accounted for.
Both source worktrees remain clean at their preservation commits, and all 62
originally dirty path entries retain their original file bytes.

## Integration decisions

| Surface | Retained personal behavior | Adopted upstream behavior |
| --- | --- | --- |
| Sidebar | Complete group counts, independent local-group pages, unique pins, visible-row selection and full remote run summaries | Remote project folding and host/project grouping |
| Subagents | Stable hydrated refresh, recorded model/effort, chronological task rows, role skill selection, approvals, recovery and concurrency settings | Reactive chat eligibility from model modalities |
| Compaction | Runtime-owned initiation, active-task evidence, both ends of bounded tool output and image notices | CJK-aware prompt/chunk sizing and sequential delegate summaries |
| Session launch | Observer binding, output guard, retry/idle settings and session-scoped delegation policy | Reject only image-only endpoints, not dual-capability chat models |
| Session ownership | Historical reply branching and local session configuration guards | Stop/navigation and provider-refresh ownership fixes |
| Storage | Observer consent, delegation history index and older personal migration reconciliation | Legacy Goal trigger retirement and safe table rebuilding |
| Policy | Personal in-place development, opt-in commits/publishing/launches and short delegating CLAUDE entry | Shared pnpm shim checks before an authorized worktree removal |
| Modes | Runtime-owned compaction and retained existing runs/snapshots | Editable builtin definitions; new Goal budgets move from the retired Behavior row to mode definitions |
| Plugins/native window | Existing permissions, scoped reads and personal presentation | Marketplace browse metadata/paging, plugin lifetime fixes and native maximize/tiling behavior |

### Required integration repairs

Both histories independently used SQLite version 33 for different changes.
The integrated version 34 must reconcile both shapes rather than treating a
version number as proof that Observer consent and Goal cleanup both ran.
Regression coverage exercises populated old databases, original-version backups,
rollback, preserved consent/history and repeat opens. No daily profile is used.

Remote folding also intersects local multi-selection: hidden remote rows must
leave the selectable order while full project run summaries remain visible.
The production-component fixture covers fold, select-visible, unfold and refold.
Delegate compaction coverage forces multiple CJK chunks and verifies previous
summary chaining, accumulated usage and cancellation on a later chunk.

## Verification status

Pre-preservation source baselines: sidebar 38/38 and subagent 36/36 passed.
Final-candidate checks use the existing Windows toolchain and synthetic data:

| Check | Observed result |
| --- | --- |
| `pnpm build:js` | Passed, including the documentation site; Desktop was rebuilt successfully after the launch import repair |
| Desktop typecheck | Passed after restoring the local Observer image-binding predicate import |
| `pnpm lint` / agent policy | Passed |
| Desktop targeted batch (57 files) | 482 passed, 1 failed, 1 skipped initially; the sole missing-import failure and related launch paths passed in a 25/25 retest |
| Isolated session organization fixture | 2/2 passed, including independent pagination and remote fold/select/unfold/refold |
| Runtime targeted suite (18 files) | 304/304 passed, including Observer, output guards, native image receipts and compaction continuity |
| Runtime compaction-tool contract | 5/5 selected tests passed; 433 other tests were not selected |
| Shared source / Host ports | 830/830 and 8/8 passed |
| Database migration tests | 81/81 passed after repairing orphan creation in the fault-injection fixture |
| Other Rust filters | Mode runs 50, delegation history 10, sessions 160, mode RPC 7, Observer RPC 3, plugins 124, marketplace RPC 4 passed; filters may overlap |
| Rust formatting / Clippy | Passed; Clippy emitted three warnings, not errors |

The plugin test requiring explicit live marketplace authorization remains
ignored (one case). No live marketplace access was inferred from this merge.
An additional mode-run assertion was updated from the old final schema 33 to
34; all prior data/backup assertions remain and its 50-test filter passed.
One independent read-only migration review found no concrete data-safety defect;
it is supplementary evidence, not a substitute for the executed tests.
Both README languages retain the two worktree additions and existing personal
features; this compatibility repair does not advertise upstream work as local.
The full unfiltered platform suites were not run; the targeted checks above
cover the changed and overlapping surfaces.

The desktop skip is the file-symlink security fixture: Windows denied symlink
creation with `EPERM`; it is not counted as a verified security assertion.
The remote-selection failure was reproduced in renderer logs before its fix;
the failing fixture subsequently hit its exit deadline. The corrected fixture
passed without increasing any timeout. Rust fault injection now disables FKs
only to create the deliberately invalid source, then tests restoration of both
original pragma combinations; production enforcement is unchanged.

`pnpm check:release-docs` remains red: the stable catalog has no
`0.23.1-beta.1` entry in nine locales or its version-list test. Running the exact
checker against extracted pre-merge `e72fdba94` files reproduced the identical
ten diagnostics. This is an existing stable-release qualification limitation,
not a new functional regression or permission to fabricate a release catalog.
The source beta version and recorded release history are unchanged.

Not authorized or not attempted: remote publication, worktree deletion,
installer build/install, production-provider calls, real remote-host journeys,
daily-profile migration, full Desktop launch, and native interactive snap
qualification. Isolated synthetic component fixtures are separate from Desktop.
