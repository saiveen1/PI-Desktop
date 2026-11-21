# Upstream integration: e89051fc7

- Personal parent: `86e93799230434e8434b5d0d53d2755334522599`.
- Fetched upstream `vastsa/PI-Desktop` `main`:
  `e89051fc7d5955e245e969f4b5e1ff7f6aea9ddd` (19 incoming commits).
- Common base: `023ed86884b20104015fde256143fdf1fd5fc556`.

## Integration decisions

- Apply upstream's endpoint-reported context-window support and endpoint-scoped
  cache fence. A manual binding or OAuth model retains its existing precedence.
  Existing display cache values are not evidence of what an endpoint reported.
- Upstream's 33-to-34 database change is adopted as personal 36-to-37. Backup
  and migration precede normal database use. An upstream v34 database retains
  its recorded values and gains the personal persona table, Observer column and
  delegation history index; personal v36 keeps its existing state and gains the
  nullable column. The new step is additive and older migrations keep their
  original version stamps. The app release version remains `0.23.1-beta.1`.
- Preserve Windows dependency-build filter quoting and the local no-match
  failure guard. Combine upstream Edit diagnostics with the local equivalent
  gap locator, retry classification and unchanged complete-reveal guidance.
- No merge edits to the recycle-bin footer, sidebar section layout or transcript
  scrolling. Their existing tests remain part of the regression checks.

## Verification

- Windows: workspace JS build, Desktop typecheck and `build:deps`, lint, Rust
  format and Clippy, agent-policy and release-doc checks passed.
- Desktop: 188 targeted tests passed; Agent Runtime: 21 targeted tests passed.
  A newly built sidecar passed all five isolated context-usage scenarios.
- Both discovery migration tests passed using temporary SQLite files. They
  cover v33 and v36 cache preservation and a backed-up upgrade, plus upstream
  v34 values, missing personal schema objects and reopening at v37.
- Host full suite: 1,511 passed, 3 ignored and 5 failed. All five also failed
  in the prior integration: four match the Windows ledger and the legacy
  plugin registry fixture was reproduced on the pre-merge baseline. Both
  previously failing legacy Goal migration tests now pass. Provider-cache RPC
  and Edit parse recovery tests also pass.
- Full Desktop, installed-upgrade and packaging checks were not run. No daily
  profile, real provider or installed Desktop was used.
