# Harness recovery hardening — 2026-11-08

## Candidate and scope

Base: `cf99680b2`, current checkout, initially clean. Validation covers the
working-tree candidate delivered with this note. No daily installation/profile,
conversation content, paid provider, or production command was used. Tests use
synthetic model responses, isolated Host state, and temporary files/processes.

## Delivered behavior

- TaskWait/TaskStop remove inapplicable Bash delegation selectors in pi's
  `prepareArguments`, before validation. Original arguments remain intact;
  delegation, job identity and timeout validation stay enforced.
- Host admission failures have an independent three-failure owner/class budget.
  They neither spend nor clear mutation recovery; termination reports
  HOST_OVERLOADED with capacity guidance, not a malformed-edit message.
- Complete unseen-line reveals with genuinely new line/content pairs earn at
  most eight progress graces per file. Repeated, reordered, truncated or malformed
  reveals do not earn more. Successful writes reset progress; no patch is
  automatically applied. The tool row shows a localized neutral context request.
- Empty/whitespace Edit ops can use a complete legacy replacement pair. Empty
  replacement text is valid deletion. Populated legacy fields plus nonempty ops
  are rejected as ambiguous. Tag, match uniqueness and seen-line gates remain.
- Duplicate insertion gaps report both operation numbers and locators, with
  single-PUT guidance. Conflicting operations remain atomic failures.
- Windows runner children default Python standard streams to UTF-8 only when
  no preference is inherited. Explicit overrides remain effective; file encoding
  defaults and global process environment are unchanged.
- Bash guidance distinguishes observation intervals from execution deadlines.
  Explicit timeouts are not rewritten, and uncertain side effects never trigger
  automatic replay.

## Additional audit findings fixed

The read-only audit identified four concrete source defects, independently
verified by the Host implementer. These are not claims about the cause of any
particular historical production incident.

1. Ordinary RPC saturation could block the controls needed to release it.
   Parsed-stdio dispatch now has 32 ordinary slots plus a bounded four-slot
   existing-work completion/cancellation reserve, with normal validation intact.
2. Background commands were spawned before checking session/capacity admission.
   RAII reservations now precede executable dispatch and release on failure,
   cancellation and shutdown; the AppState lock is not held across spawning.
3. Tool request aggregate deadlines included indefinite permission waiting.
   `tools.execute` and `tools.workspaceExecute` now exclude that aggregate clock;
   actual tool execution and admission deadlines remain in force.
4. The documented two-shell per-session limit was not enforced. Symmetric shell
   reservation/release now keeps one session from taking all four global slots.

## Verification

| Surface | Entry / outcome |
| --- | --- |
| Agent-loop failure baseline | Five new tests failed on the original runtime at the intended assertions; corrected implementation passes. |
| Runtime recovery | Local Vitest: `harness-recovery-user-path`, `harness-recovery-guard`, `runtime-tool-recovery`, `mutation-recovery`, `background-job-tools`, `tool-schema`: 65 passed, one existing POSIX filename test skipped on Windows. |
| Runtime compatibility | Nine selected `runtime.test.ts` cases passed: mutation guidance, Bash timeout/background forwarding, steering/abort waits, and delegation selector recovery. Other cases in that file were deliberately filtered out. |
| UI baseline and candidate | Original context-request presentation failed the new assertion. `tool-context-recovery.test.mjs` and `tool-status.test.mjs`: four production-component tests passed. |
| Localization | All i18n tests: 31 passed. i18n build passed. |
| Type/build | Agent-runtime TypeScript build passed; Desktop typecheck exited 0. |
| Rust tool layer | `tools::harness_regression_tests` 8; Windows Python encoding integration 1 (three isolated child configurations); `tools::hashline::` 18; `tools::tests::edit_` 11; tool declaration test 1: 39 passed, rerun after Host integration. |
| Host admission | `tool_budget::` 41; `admission_tests::` 10; `rpc::tests::budget_` 5; `rpc::tests::tool` 8; `background_tasks::tests::` 7: 71 passed. |
| Host regression sensitivity | Four old admission behaviors temporarily restored in a controlled experiment each produced the intended failure; all changes were restored and the final gates passed. Not a pristine-baseline or historical-causality claim. |
| Rust static gates | Scoped rustfmt and `cargo clippy -p host-core --all-targets --locked` passed. Existing warnings remain in computer/backend.rs, review.rs and transcripts.rs. |
| Repository gates | `pnpm lint` and `git diff --check` passed. Biome's configured scope does not include agent-runtime; its coverage comes from typecheck and tests. |

## Limits and follow-up

No installer, daily-app launch/restart, live-provider acceptance or full repository
suite was run. Source completion is separate from installed-version acceptance;
packaging and user installation remain a distinct pending task. Windows legacy
programs and explicit non-UTF-8 subprocess overrides are not silently transcoded.
Historical overload logs without holders/queue reasons cannot establish which
request caused a particular incident. The original conversations were not replayed.
