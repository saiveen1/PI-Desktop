# Subagent controls — isolated candidate validation

Date: 2026-11-08

## Candidate

- Worktree: `worktrees/subagent-controls`
- Branch: `fix/subagent-controls`
- Base: `75a1923872f60a1326ec27c965140cde11140f96`
- Candidate includes uncommitted changes. It has not been merged, committed,
  packaged, installed, or launched against a daily profile.
- The primary checkout's unrelated release work was not edited. Its HEAD advanced
  separately during this task; this candidate does not claim to include that work.
- Existing installed Node/pnpm dependencies were reused, with workspace package
  links and generated outputs pointing into this worktree. No install was run.

## Delivered behavior

- Configurable subagent failure policy in Scheduling: inherit, stop, retry,
  retry then fallback; bounded retry/switch counters, Host validation, immutable
  task snapshots, all nine locales. Existing settings retain inherited behavior.
- Direct text input to an existing child chain while running or after settlement;
  idempotent request identities, safe-boundary input, retained conversation,
  active/idle parent ownership, model authorization and cancellation preserved.
- Tasks preempted by new parent input are presented as not started, without a
  misleading duration or active coordination count. Historical records remain.

## Executed checks

Commands were run from this worktree using its package-local Node tool entry
points. Vitest batches used `--no-file-parallelism`.

| Surface | Tests / command | Result |
| --- | --- | --- |
| Direct conversation and existing recovery | `subagent-conversation-user-path.test.ts`, `manual-recovery-user-path.test.ts` | 35 passed |
| Provider fallback and child runtime | `subagent-fallback.test.ts`, `subagent.test.ts` | 101 passed |
| Selected existing runtime lifecycle | `runtime.test.ts`, filtered to subagents / parent failure / resume / running ownership | 82 passed; 333 not selected |
| History and idempotence | `delegation-history.test.ts`, `delegation-messages.test.ts` | 47 passed |
| Shared contracts | `delegation-policy.test.ts`, `subagent-message.test.ts`, `protocol.test.ts`, `session-delegation.test.ts` | 44 passed |
| UI and IPC | `subagent-child-message.test.mjs`, `subagent-controls-ui.test.mjs`, `subagent-panel.test.mjs`, `subagent-message-ipc.test.mjs`, `subagent-retry-ipc.test.mjs` | 37 passed |
| Translation catalogs | `packages/i18n/test/catalogs.test.mjs` via Vitest | 12 passed |
| Original Rust validation module | `rustc --test` includes `rpc/delegation_settings.rs`, using existing serde_json dependency cache | 6 passed |
| Parent failure / cancellation integration | `node scripts/e2e-subagent-parent-error.mjs` | Four loopback HTTP/SSE scenarios passed |
| Package builds | Shared, i18n and agent-runtime `tsc -p tsconfig.json` | Passed |
| Type checks | Agent runtime and Desktop `tsc --noEmit` | Passed |
| Desktop compilation | `electron-vite build`, WMI-launched, isolated outputs | Exit 0; large-chunk warnings |
| Static checks | Shared agent types Biome lint; style-token gate; changed Rust module rustfmt; `git diff --check` | Passed |

The direct-input missing-entry regression, restored rejected-message receipt
regression, writable-chain concurrent admission regression, and rejected-first /
admitted-sibling report-loss regression were observed failing before their fixes.
One bounded read-only review identified the last two races; both were fixed and
retested. No second broad review was started.

## Verification limits

- The targeted Cargo test invocation did not complete in its initial observation batch;
  the original changed validator's six tests passed through a direct rustc test
  harness. This is not a full Host build or integration claim.
- The full repository suite, real-provider traffic, installed Desktop, native
  interactive UI and package installation were not tested. Component tests use
  production components with controlled external boundaries.
- Some batched build/typecheck commands hit the tool observation limit. Logs
  identified the completed stages; standalone final checks and the WMI-tracked
  Desktop build subsequently completed successfully. No business timeout changed.
- pnpm's linked task-state safety check prevented that wrapper in the isolated
  environment. Existing package-local compiler/test entry points were used;
  package dependency or permission checks were not weakened.
- No background build or delegate remains running at delivery.
