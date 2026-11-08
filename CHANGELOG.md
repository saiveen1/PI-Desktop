# Personal changelog

This is the personal edition's release record, generated from `docs/releases/history.json`. Ordinary builds do not create releases or change the beta version. Commit-subject categories are traceability aids, not stability or test claims.

## Unreleased personal development baseline

No personal beta candidate has been recorded by the new release workflow. The following is historical development, not a fabricated release.

Snapshot: `75a1923872f60a1326ec27c965140cde11140f96`.

### Added

- feat(sessions): organize conversations and scope delegation models (`b3c40e482960`)
- feat(desktop): unify notifications and normalize Windows references (`a746f4b69395`)
- feat(delegation): add recoverable approval center and live policy (`7262a96f7947`)
- feat(subagents): retain checkpoints and configurable run policies (`c2a651ff9dd7`)
- feat(release): clean personal-build intermediates before each build (`59feb539f3a3`)
- feat(delegation): add direct failed subagent retry (`aad05230f0ff`)
- feat(files): expand chat file actions and Save as (`25faf73afb42`)
- feat(sessions): add multi-select and recycle bin (`df3cd25f14d9`)
- feat(runtime): continue unfinished task checklists once (`6f8d77f50d9b`)
- feat(delegation): add unified model scheduling and approval (`a286c46aceb1`)

### Fixed

- fix(harness): separate admission pressure from tool recovery (`75a1923872f6`)
- fix(desktop): resolve chat filenames under explicit directories (`cf99680b24eb`)
- fix(agent-runtime): honor explicit bash job targets (`43db88d7d113`)
- fix(agent-runtime): constrain background job selectors (`c7ab4b2169a5`)
- fix(desktop): clarify tool outcomes and conversation organization (`10d2bd753e00`)
- fix(desktop): preserve rename input selection (`81258199871e`)
- fix(desktop): hide stale retry badges (`178f7721efdf`)
- fix(host-core): isolate search file leases across sessions (`b6a57c418ea2`)
- fix(delegation): retain active and parent-interrupted recovery (`637a28be196e`)
- fix(delegation): enforce truthful reports and bounded recovery (`4da7b50efc68`)
- fix(desktop): clarify session times and retain run diagnostics (`d4465f3fd00b`)
- fix(agent-runtime): accept coherent delegation job selectors (`608123cdcaa0`)
- fix(delegation): keep the collapsed approval entry clear of the composer (`78088ebda65e`)
- fix(runtime): guard repeated mutation and command failures (`d9bf50fa1654`)
- fix(chat): preserve reading position across session switches (`d20de06ab5f9`)
- fix(delegation): expose failed subagent resume hints (`0a4e5c36fba6`)
- fix(desktop): tighten delegation approval and scheduling editor (`f4146ae8e405`)
- fix(tools): accept the legacy Edit shape when a tag is also sent (`09c15a314d0a`)
- fix(desktop): isolate personal builds and dev data (`15943ccd08d2`)

### Improved

- No changes recorded in this category.

### Maintenance

- docs(agents): point the routing table at documents that exist (`2d19b08aa4e4`)
- docs(agents): add package rules for agent-runtime test fixtures (`9bae7cdc99de`)
- test(agent-runtime): give two child-process suites a realistic budget (`e8c41aa9b9bf`)
- test(agent-runtime): declare the delegation policy RPC in host fixtures (`462391cde859`)
- docs(readme): describe the personal fork and its additions (`b90fbd04fd58`)
- test: make the desktop suites Windows-honest and ledger the rest (`c9e63290d705`)
- docs(release): catalog the 0.22.0 release notes (`9c967142f40b`)
- chore(release): sync 0.22.0-beta.3 metadata (`3c903f8842a4`)
- build(personal): fix the installer-only release workflow (`2855929bb58c`)
- Update .gitignore (`b97e9aacf2b4`)
- chore(git): ignore test artifact scratch directories (`df6f8605393a`)
