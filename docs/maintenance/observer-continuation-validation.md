# Observer continuation-context validation

Date: 2026-11-18 (UTC). Base revision: `e4af2c4ff`, with uncommitted task changes
and preserved unrelated work. This is source-candidate validation, not an
installed-build or live-profile upgrade test.

## Reproduced defect and scope

The independent reviewer previously received only the latest user input, final
answer and a small current-turn tool window. A request such as "continue; report
only when finished" omitted the earlier completion criteria. The reported
session's persisted assessment was Guard / unknown / low, without truncation.
Its reason explicitly identified missing earlier task context.

The fix retains a bounded task-evidence window with real transcript IDs,
distinct historical roles, shared input limits and redaction. It does not make
unknown judgements actionable or bypass Stop, Plan, permissions, shared
correction limits, unsettled tools, or input/approval waits. Object-preservation
clauses remain in the evidence and must not erase compound execution bans.

The original five regression cases produced three failures before history was
wired into the runtime: restored continuation, repeated live continuation, and
inherited discussion scope. Those cases subsequently passed. Further tests
cover task replacement, current-answer citations, attachment omission, bounded
history, Unicode/redaction, continuation synonyms, preflight-retained inputs,
and Stop-retained/restored steering.

## Explicitly authorized real-model simulation

- Exact requested/listed model: `gpt-6-luna`.
- Transport: Responses, using the existing `completeOneShot` adapter and
  `ObserverGuard.assess`; no separate hand-written completion protocol.
- Thinking level: `medium`; per-completion deadline: 30 seconds; retries disabled.
- Eight completion requests plus one model-directory request; 8,273 reported
  tokens across completions. Monetary cost was unavailable, not zero.
- Synthetic inputs only. No original conversation, workspace contents, tool
  execution, real task replay, or production effects were sent or performed.
- Temporary credential file was deleted after all real calls settled.

The synthetic task required display deduplication plus normal/duplicate/empty
input validation while preserving original records. The follow-up merely asked
to continue and report only after completion. Candidate answers varied by case.

| Case | Actual verdict / confidence | Continuation | Observation |
| --- | --- | --- | --- |
| Old input shape, no task history | incomplete / high | Not exercised | The model inferred unfinished work from the answer alone; this sample did not reproduce unknown. |
| Required validation pending, first run | incomplete / high | Blocked | Exposed a local false negative: the original-record preservation clause looked like discussion-only scope. |
| All work claimed complete, no execution receipts | unknown / low | No | Safe abstention; did not match the harness's initially strict `complete` expectation. |
| Required samples missing | needs_input / high | No | User-input boundary retained. |
| Only explanation authorized | incomplete / high | No | Local discussion-scope gate retained. |
| Oversized historical task | incomplete / high | No | Local truncation gate retained despite the confident model verdict. |
| Remaining validation explicitly optional | complete / high | No | Optional work did not expand scope. |
| Required validation pending, after local-intent fix | incomplete / high | Yes | Targeted retest passed in 3,073 ms. |

The initial six-case batch's strict verdict assertions were 4/6: one local
false negative fixed and retested, and one safe unknown rather than complete.
Do not relabel that batch as uniformly passing or infer a general accuracy rate.
The targeted real retest preceded the final attachment/steering/preflight and
compound-ban hardening; those later changes were validated offline without
additional provider spend. The provider's configured model identity is not
independent proof of undisclosed backend routing.

## Final offline checks

- Runtime focused Vitest: 192/192 passed across `observer-guard-runtime`,
  `observer-task-context`, `observer-guard-evidence`, `observer-continuity`,
  `observer-one-shot`, `turn-correction-policy`, and `early-end`.
- Locale Vitest: 39/39 passed across all five existing locale test files.
- Runtime and locale `tsc -p tsconfig.json --noEmit`: passed.
- Repository `pnpm lint`: passed within its configured scope.
- `git diff --check`: passed. Task-source credential-pattern scan: no match.

Tests used the checkout's existing toolchain through WMI-started Node processes,
with bounded logs and state files in session scratch. A single read-only review
identified six concrete boundary defects; each was fixed and covered by the
final focused tests. No second broad review was performed.

## Validation boundaries

Real calls exercise judgement and the observer's continuation decision, not the
subsequent main-model work. Deterministic runtime fixtures exercise the real
Agent loop with synthetic external provider/Host edges. The preflight fixture
enters the public prompt path to trigger a real context-budget rejection, then
checks retained evidence at the public observer boundary; it does not claim a
full installed-runtime recovery test.

Repository Biome configuration excludes the runtime and locale paths. A targeted
lint attempt processed zero files and is not a passing lint result. The normal
repository `pnpm lint` entry passed its configured 167-file/style-token scope;
runtime and locale coverage comes from TypeScript and focused tests instead.
No Desktop launch, daily-profile mutation, installer, packaging, commit, push,
full-workspace build, or unrelated long test suite was performed for this task.
