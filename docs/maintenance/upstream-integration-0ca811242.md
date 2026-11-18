# Upstream integration: Pi 1.5.2

## Candidate and scope

- Personal parent: `6463d87d99ee1b88110e3d8a32ca513d5f924ec6`.
- Fetched upstream: `0ca811242628fa1f9cf796eee1ca0dd3f645c471`
  (`vastsa/PI-Desktop`, `main`).
- Merge base: `047c4eab1c97a349b3cf8c734229b64ed9d87764`.
- Integrate 16 upstream commits in the current checkout. The starting index and
  worktree were clean. A local merge commit is authorized; remote publication,
  packaging, installation, Desktop startup, and live-provider calls are not.

## Integration decisions

- Keep the personal version `0.23.1-beta.1` consistently across workspace
  manifests, Cargo and shared protocol constants. Retain the additive upstream
  model-discovery highlight in all nine locale catalogs without changing
  personal release history.
- Adopt the exact Pi 1.5.2 release group, its rebased core/coding-agent patches,
  provider-catalog additions, ChatGPT model-discovery client version, and Qwen
  China preset alias. These are inherited upstream features, not local claims.
- Preserve the local Responses terminal-content patch: blank final reasoning or
  answer placeholders cannot erase streamed content, and the exact observed
  orphan DSML suffix cannot replace a full answer. Nonempty corrections,
  refusals, signatures, tool order and terminal/error semantics remain intact.
  The two behavior hunks were ported into the extracted 1.5.2 source and the
  patch regenerated with `pnpm patch` / `pnpm patch-commit`, not hand-edited.
- Preserve the direct Photon runtime dependency and its lock importer for local
  image-integrity checks. Keep upstream's proportional output-token margin,
  Anthropic OAuth identity, message-thread support and Responses `session-id`.
- Preserve local delegation recovery/drain, Observer cancellation, image-output
  handling, output guards and retry accounting in conflict-free runtime merges.
  Upstream compaction/delegate requests disable thread continuation; disposal
  releases Pi session resources after the retained local cleanup.
- One-shot completions also receive a session id through the shared routing
  helper. They must remain independent: neither continue nor replace the main
  Anthropic thread. Cover this through the real adapter and a loopback gateway,
  including the next main turn retaining its original continuation id.
- Keep both sides' provider acceptance scenarios. The new runtime fixture
  declares the personal Host RPCs instead of weakening production behavior.
- Restrict the inherited issue-automation jobs to `vastsa/PI-Desktop`, matching
  the existing upstream-only mirror guard. This fork does not implicitly enable
  a paid provider, comments or issue-label mutations. Correct the inherited
  credential-name and manual-dispatch documentation; no secrets were accessed.

## Verification

- Before restoring the local patch, the Responses regression suite had 15
  failures and 9 passes; the two incoming Anthropic-thread cases passed.
- The one-shot thread regression failed with an unexpected `thread: create`
  before the two-line request-option fix. The focused candidate run then passed
  60 tests across five files, including all Responses and thread regressions.
- The patch-hash fixture's five Windows `EPERM` failures were reproduced with
  the exact pre-merge test file. After restoring and SHA-256-verifying the
  candidate, the fixture now uses absolute Windows junctions instead of
  privileged directory symlinks; POSIX relative links and every assertion remain.

Final candidate checks (Windows, Node 24.12.0, pnpm 12.8.1):

| Check actually run | Result |
| --- | --- |
| `pnpm build:js` | PASS, including Desktop and documentation bundles |
| `pnpm --filter @pi-desktop/desktop typecheck` | PASS |
| `pnpm lint` | PASS |
| Agent Runtime `node node_modules/vitest/vitest.mjs run --maxWorkers=4` | 182 files passed; 2,806 tests passed, 1 skipped in `mutation-recovery.test.ts` |
| `pnpm --filter @pi-desktop/shared test --maxWorkers=2` | 132 files and 1,660 tests passed |
| Desktop Node tests: `anthropic-oauth-retry`, `models-dev-catalog`, `vendor-live-models`, `ci-workflow` | 117 tests passed |
| `node scripts/check-pi-patches.mjs`, `check-pi-dependencies.mjs`, `check-agent-policy-sync.mjs`, `check-release-docs.mjs` | All PASS |
| Node tests: `scripts/pi-patch-hash.test.mjs`, `scripts/check-release-docs.test.mjs`, `scripts/release-version-check.test.mjs` | Final combined run: 31 passed |

The runtime suite includes the runnable image-resize worker/Photon WASM bundle
check. Both installed Pi AI peer variants match the migrated Responses source
by SHA-256. The generated patch SHA-256 is
`cd07f701d28d36b5a52996853d633a08ef1076db9c7cd85e17b32aa8bf02f9da`.
Read-only assertions verified 14 unchanged personal manifest versions, all old
lines retained in nine locale catalogs, unchanged Cargo files and shared
protocol constants, valid integration links, and the pinned merge target.

Non-blocking build output includes large-chunk and `gitignore` highlighter
warnings. Full-workspace tests and Cargo suites were not run: Rust source and
Cargo files are unchanged, and validation follows the affected JS surfaces.
Electron E2E, live-provider calls, packaging, installation and installed-upgrade
verification were NOT RUN; application/profile access needs separate consent.

## Documentation and compatibility

The [Responses diagnosis](responses-terminal-content-loss.md) now points to the
current patch. Upstream's [adoption report](../project/pi-152-adoption.md) remains
historical evidence for its own candidate, not proof of this merge.

No Host protocol, database schema, Plugin SDK or stored-data format changes.
No migration or installed-profile access is required. README updates describe
only the local one-shot isolation increment, not the upstream catalog changes.
