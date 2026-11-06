# Agent Runtime — package rules

Scope: `packages/agent-runtime`. Root `AGENTS.md` still applies; this file adds
the constraints that only make sense here.

These tests run in CI on `ubuntu-latest` (`pnpm -r --if-present test`). Nothing
in this package is exempt on Windows: a failing case here is a real defect, not
a platform quirk. If a case fails only on your machine, it is contention or a
fixture bug — not a "known Windows failure".

## Before analysing a failure

1. Run the suite once and keep the whole output; do not re-run to build a
   baseline.
2. Extract **every** `FAIL` line and map all of them to files in one pass.
3. Compare that file set against `docs/testing/windows-known-failures.md` once.
4. For anything outside it, decide regression vs pre-existing with **one**
   differential experiment (swap the suspect file for its pre-merge version,
   re-run that one file, restore, verify with `sha256sum -c`).

Do not debug failures one at a time, and do not read the implementation before
you know whether the case is even yours.

## Test stubs must declare the Host RPCs the runtime awaits

`promptTurn` performs Host work **before** the first provider request. A stub
that answers only the calls it happens to know about fails the whole turn, and
the symptom is misleading: no assertion error, just a timeout with an empty
request list (it looks like a hang in the model loop).

Known pre-request awaits:

| Call | Why it is awaited | Correct stub answer |
| --- | --- | --- |
| `tools.fileBatchCapabilities` | batch planner negotiation | `{ version: 1, supported: false }` |
| `provider.delegationSnapshot` | session delegation policy refresh | `undefined` (an older Host; the launch policy stands) |
| `session.appendMessage` | system transcript journal | `undefined` |
| `todos.get` | unfinished-checklist continuation | `{ sessionId, todos: [] }` (the runtime only reads `sessionId` and `todos`) |

When you add a `new DesktopAgentRuntime({ host: { call } })` fixture, declare
every RPC on this list, even the ones your assertion does not exercise. If the
runtime starts awaiting a new pre-request RPC, update this table and the
`Row 9 in practice` section of `docs/testing/windows-known-failures.md` in the
same change.

`provider.delegationSnapshot` must return either `undefined` or a valid
snapshot: `{ revision, modelKeys, settings? }` with a non-empty `revision`, a
`modelKeys` array of unique `provider/model` strings, and `settings` that passes
`isDelegationSettings`. Anything else (for example `{ ok: true }`) makes the
policy refresh reject and the turn never starts.

## Budgets for child-process and long-loop cases

Vitest's default is 5 s per test. Cases that run a real bundle, spawn a worker
thread, or drive a 130-call loop need an explicit budget (`{ timeout: 60_000 }`
on the test or `describe`), the way upstream `c41008216` did for
`apps/pi-host`. Raise that budget only when you have identified new work that
legitimately grew; do not raise it to make a red suite green.

## Commands

```bash
cd packages/agent-runtime
node node_modules/vitest/vitest.mjs run            # full suite
node node_modules/vitest/vitest.mjs run src/x.test.ts --no-file-parallelism
pnpm --filter @pi-desktop/agent-runtime typecheck
```
