# Harness compatibility verification — 2026-11-16

## Candidate and provenance

- Source baseline: `cee401bd4`, plus the uncommitted task changes.
- Environment: Windows, existing Rust/Cargo and Node toolchains; synthetic files
  and temporary Host state only. No provider or network request was needed.
- Compared read-only with upstream `29043af3371122e256bf265db31651da125d38e3`
  (no fetch). That revision's legacy Edit accepts an omitted tag/ops pair but
  not blank defaults; its workspace RPCs clear all Hashline sessions; both shell
  launch paths pass the arguments through ordinary `.args(&config.args)`.
- These fixes extend inherited tools. They do not originate line editing,
  session roots, subprocess ownership, or the shell catalog.

## Proven defects and smallest changes

1. **Legacy optional defaults.** A complete legacy replacement with a blank tag
   failed `EDIT_TAG_REQUIRED`. Only that branch now treats blank tags as omitted.
   Nonempty malformed/stale tags, nonempty mixed intents, ambiguous or missing
   old text, unread anchors and line-edit tag requirements remain guarded.
2. **Read evidence lost on navigation.** `workspace.set` (even the same root or a
   rejected remote target) and `workspace.clear` discarded every session's
   snapshots. A later partial Read/Grep recreated incomplete evidence and an Edit
   of previously displayed lines failed. Navigation no longer clears the store;
   session deletion and file rollback retain their scoped cleanup. Canonical
   path/version comparisons, per-session separation and retention bounds remain.
3. **Windows Git Bash argument loss.** CRT quoting collapsed backslash pairs in
   Git Bash/MSYS parsing. A native-boundary encoder preserves the original
   command/config, shared by the foreground test adapter and production hidden
   runner. The length guard counts encoded UTF-16 overhead. Other shells, audit,
   permissions, cancellation, retry policy and nonzero exit semantics are unchanged.

## Executed regression evidence

- Before the Edit/navigation fixes, the `edit_` selection reported 30 passed and
  3 failed: two blank-tag regressions and the actual Host RPC navigation case.
- Before the Bash fix, both `windows_git_bash_command_fidelity` tests failed with
  the expected doubled backslashes reduced to single backslashes, including the
  real hidden-runner function entered through a framed child-process config.
- Final command:

  ```sh
  cargo test -p host-core --locked --offline -- --nocapture edit_ tools::hashline:: tools::harness_regression_tests tools::runner_encoding_tests tools::shell::tests
  ```

  Result: **80 passed, 0 failed, 2 ignored**. The two ignored test entry points are
  invoked explicitly in isolated child processes by the passing parent tests.
  Coverage includes a 16-payload native argument matrix, literal heredocs,
  foreground/background output, stderr and exit 17, encoding defaults/overrides,
  navigation through Read/Grep, isolation, old-text guards and encoded size limits.
- `node --test apps/desktop/test/tool-context-recovery.test.mjs apps/desktop/test/assistant-turns.test.mjs`:
  **21 passed**. Existing context-required presentation and recovered-error turn
  grouping were reused; no new UI success badge or transcript mutation was added.

## Limits

- `cargo fmt --all -- --check` and `git diff --check` passed.
- The existing Markdown structure checker passed for all 11 changed/new Markdown
  files; the newly added relative documentation link resolves on disk.
- `cargo clippy -p host-core --all-targets --locked --offline` passed. It reported
  three warnings in unchanged `computer/backend.rs`, `review.rs` and
  `transcripts.rs`; those unrelated files were not modified.

This is source-candidate verification, not installed-app acceptance. No Desktop
launch/restart, installer, profile mutation, paid provider call, full platform
matrix or full repository test suite was performed. Historical live-session
triggers cannot all be reconstructed; the navigation defect was independently
reproduced rather than attributed to every historical unseen-line error.
