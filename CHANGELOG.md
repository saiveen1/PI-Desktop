# Personal changelog

This is the personal edition's release record, generated from `docs/releases/history.json`. Ordinary builds do not create releases or change the beta version. Commit-subject categories are traceability aids, not stability or test claims.

## 0.23.1-beta.1 — 2026-11-16

Source: `e83aa74b1f6b16334b39c483e6ec212fa3ddff18`; build: `20261116T095313558Z-ge83aa74b1f6b-8fe51204`; SHA-256: `c3fa89648abd9eca23249d76865236939904205cdcaed436750c41ca5ea99995`.

Verified by offline package checks only; no installation or profile-upgrade claim.

### Added

- feat(subagents): preserve role-level skill selection (`c1d9e306ff47`)
- feat(session-collaboration): send the report as readable text, not JSON (`77d5b7a03603`)
- feat(session-collaboration): let a send choose immediate or queued delivery (`a28bc2eb1ad0`)
- feat(session-collaboration): run a worker's report at the next turn boundary (`6828ff8f3dab`)
- feat(session-collaboration): let the orchestrating plugin own worker concurrency (`6dad8f87c9bb`)
- feat(delegation): add lifecycle observations and approval sound (`bb5eb41303cb`)
- feat(subagents): make role catalog and concurrency limits configurable (`f34f78a0f60a`)

### Fixed

- fix(release): accept stable baselines for beta builds (`e83aa74b1f6b`)
- fix(harness): preserve edit provenance and Git Bash arguments (`7990e86f8d62`)
- fix(plugins): restore the Open panel button on installed cards (`438a1a364bbb`)
- fix(agent-ipc): refuse duplicate compaction and keep ownership of the guard (`2b20dc8a32db`)
- fix(session-ipc): refuse to delete a session with a running turn (`f75d2c27e540`)
- fix(agent-ipc): guard compaction admission without blocking Stop (`bf22dbf3f0de`)
- fix(agent-runtime): treat Volcengine AccountOverdueError wording as terminal (`d03fd1f27cc5`)
- fix(agent-runtime): read Perplexity and MiniMax max\_tokens ceilings (`683f3dbda44d`)
- fix(mods): migrate legacy session mode constraints (`524b0265c91b`)
- fix(sessions): baseline the stale-read guard before workspace alignment (`a3d0610ce1c7`)
- fix(sessions): catch cold-read idle edits with a plain cache-reference compare (`80e25f37f1a9`)
- fix(sessions): keep selectSession from reverting edits made during its detail read (`951a1ad780b4`)
- fix(git-clone): wait for the killed clone to exit before cleaning up (`73da9a375c3c`)
- fix(git-clone): clean up the half-built destination after a timeout (`6dadeebbd466`)
- fix(mods): preserve stale closeout cancellation ordering (`ecb25d2bb742`)
- fix(mods): restore reliable Goal run lifecycle and completion (`652c4067e1d6`)
- fix(chat): align delegation connectors with actual card centers (`1e7239640fe8`)
- fix(desktop): stop the todo shimmer once the session is idle (`9ad666512565`)
- fix(runtime): preserve explicit zero cache usage (`820ad643e50c`)
- fix(transcripts): tolerate terminated torn encoded rows in storage verification (`6de6df6f3935`)
- fix(desktop): keep each project's MCP servers when another project refreshes (`bcaeae6cc19b`)
- fix(window): keep the border suppressed through activation changes (`2b52999879a6`)
- fix(plugins): compare plugin storage names, not raw ids, on install (`ed686dd4cefc`)
- fix(agent-runtime): spell out required on nested tool-schema objects (`7b56da1365fc`)
- fix(agent-runtime): treat Anthropic credit-balance and DashScope Arrearage wording as terminal (`c1970f15bf61`)
- fix(agent-runtime): bound retained CJK text to the token budget (`f9ff833c252f`)
- fix(window): restore native Windows snapping without frame insets (`463a025d46af`)
- fix(transcripts): classify torn prefixes by typed EOF, not Display text (`4534e9fe981a`)
- fix(markdown): render CJK punctuation emphasis (`9fef3ba4da9a`)
- fix(plan): preserve the owning session permission on approval (`7a7827727091`)
- fix(plugins): refuse plugin ids that alias another plugin's directory (`c01177006d14`)
- fix(composer): restore preview focus after the selection (`047748de868b`)
- fix(composer): reference pasted disk files with sizes (`46c6788c888b`)
- fix(plugins): preserve JSON setting strings across saves (`e9f88e2855b6`)
- fix(plugins): refuse plugin ids that collide after sanitizing (`e2e1105addde`)
- fix(runtime): preserve restored tool pairs across compaction boundaries (`4a663eaafb73`)
- fix(models): retry failed model discovery with a backoff (`a68642675926`)
- fix(composer): keep the turn running when Stop fails (`fd88dccf8f50`)
- fix(interactions): keep ask and permission cards when an answer fails (`62af05bad0de`)
- fix(transcripts): skip terminated torn prefixes instead of failing every read (`fe68b42b40c5`)
- fix(agent-runtime): thread the delegate's prior summary past the system row (`7e9b377a0f5b`)
- fix(mcp-oauth): settle the login when the token exchange fails after the callback (`4ac79d7f98ea`)
- fix(chat): preserve source-owned text across history layout repairs (`7aa385a0e251`)
- fix(runtime): use proxy-safe headers for custom completions (`49a3e2e70367`)
- fix(chat): show output-token truncation warnings (`84de669cf7d7`)
- fix(host-core): confirm macOS stopped group disappearance (`6cadb0e36084`)
- fix(host-core): retain identifiable background command prefixes (`c9974f542662`)
- fix(agent-runtime): interrupt canceled TaskStop waits (`d5e81b94c1a0`)
- fix(modes): preserve approval transitions and create snapshots atomically (`f25a7e4be02f`)
- fix(modes): claim persisted runs before catalog lookup (`056ec3e4d29e`)
- fix(modes): retain snapshot-free Agent and Plan dispatch (`c671b12a224a`)
- fix(modes): preserve definitions through session creation and dispatch (`953c2b5e6d3a`)
- fix(agent-runtime): accept redundant Bash job defaults (`67d9225a06da`)

### Improved

- perf(host-core): keep per-turn revision saves off the full transcript (`914559a2b0b3`)
- perf(desktop): shrink packaged app and load transcription natively (`1def4c58dcb5`)

### Maintenance

- docs(adr): rewrite the decision records by hand (`d5736010d977`)
- docs: slim the documentation tree (`b1882735080a`)
- docs(plugin-center): drop Vercel from the service architecture (`c9f74ae22900`)
- chore(docs): remove the Vercel documentation-site deployment (`c88cf311f582`)
- docs(readme): drop the Early Preview label (`1d4914d9d30c`)
- chore(release): prepare v0.23.0-beta.1 (`d519ac2f667c`)
- test(plan): qualify session permissions through native approval (`2ddd1997a202`)
- docs(window): clarify native scenario isolation (`3e1808cf0fd1`)
- test(window): isolate keyboard restore from native resize history (`e1b71f688084`)
- test(window): retain native keyboard restore bounds on failure (`7c25180ab3d4`)
- test(window): wait for native drag activation before sweeping (`0f066a37c555`)
- test(window): deliver each verified drag point to the input queue (`5bfa4a2f91a6`)
- test(window): verify native cursor movement during physical drags (`1a7c5be18cd4`)
- test(window): provision native desktop geometry on hosted runners (`92b56a56e63a`)
- test(window): publish clean-source native activation replay evidence (`e45ac351547f`)
- test(window): verify evidence and report desktop capability failures (`bf82fee87128`)
- test(window): build replay dependencies and retain early job failures (`f88f25cbb8a9`)
- test(window): retain actual native Host replies and stderr (`4eb55e781ab9`)
- test(window): retain DWM border attributes in native geometry evidence (`695732198d16`)
- test(window): collect desktop metadata without a WMI dependency (`16261e493ee0`)
- test(window): reindex the preserved native stream without conversion (`049189c92749`)
- test(window): preserve original native output bytes (`19c1f79ab3f0`)
- test(window): retain native evidence and add independent Windows replay (`ebf2800f7e8f`)
- docs(window): record native snap reproduction and Windows qualification (`38c5a5bd77ef`)
- test(window): avoid sharing violations in native probe state exchange (`f1f6a44aa778`)
- test(window): publish native probe commands atomically (`8343132a3c9a`)
- docs(plan): satisfy the ADR catalog format (`9e9b95a482fe`)
- Revert "Merge pull request \#2322 from vastsa/v0/settings-redesign" (`c2a58a855604`)
- Redesign settings layout: grouped panels, centered column, lighter header (`a2cfd932b77c`)
- Restore ripple running mark in sidebar session rows (`05a023b22567`)
- Simplify sidebar project run badge and activity rail (`a86aa4e6922f`)
- Redesign sidebar session status marks and project run badge (`e63a181e9890`)
- test(composer): validate file references through Electron and restart (`7740cba792a9`)
- chore(composer): complete file reference validation gates (`852911aef80f`)
- chore(release): record personal beta.10 installer (`fa809a7550e8`)
- test(fs): wait for fallback IO after the mocked Git deadline (`be6c23393f0a`)
- test(chat): verify latest ownership without discarding connected pages (`fbf975a3520e`)
- test(chat): reproduce clamped and reconstructed reading anchors (`d0e18ba45225`)
- ci: retry after runner network recovery (`77b595be5df8`)
- ci: retry after runner network recovery (`b629107c0888`)
- ci: retry after runner network recovery (`96f30f0aaae8`)
- test(agent-runtime): retain plain Bash job lifecycle coverage (`7b706ce26580`)
- ci: retry checks after Ubuntu mirror DNS failure (`8667cdd1a860`)
- ci: retry checks after Ubuntu mirror DNS failure (`ceb7fa9612d2`)
- ci: retry checks after Ubuntu mirror DNS failure (`d05364e98cd7`)
- docs(e2e): describe Bash job default selector coverage (`46569f99e22a`)
- docs(runtime): clarify explicit Bash job selector defaults (`6b4c24393128`)
- test(runtime): exercise Bash defaults in background job E2E (`4115296fc1de`)
- test(agent-runtime): cover redundant Bash job selectors (`0288807c1232`)

## 0.22.0-beta.10 — 2026-11-12

Source: `27b3fe481e2b3008795c886665d4c938306e4b3e`; build: `20261112T223739070Z-g27b3fe481e2b-08fa430e`; SHA-256: `92a3ec28adb86a0713558e368ed65b7541f6dc1a094a44bc2210282bc01b2b04`.

Verified by offline package checks only; no installation or profile-upgrade claim.

### Added

- feat(ci): automate personal Windows builds and explicit beta publication (`58c8ef37b2c7`)
- feat(desktop): surface current-session subagents in the topbar (`869bc1d18076`)
- feat(dev): add fixed Windows source launcher (`001c3215e4f7`)

### Fixed

- fix(runtime): expose the main agent request model identity (`27b3fe481e2b`)
- fix(desktop): allow branching from historical replies (`d0f4fd890372`)
- fix(runtime): preserve execution continuity across compaction (`c191a980a00b`)
- fix(agent-runtime): chain before\_provider\_request payloads across handlers (`fcaba495a5ce`)
- fix(plugins): save untouched json settings without stringifying them (`f0a5f562f53f`)
- fix(desktop): preserve image previews and group adjacent reads (`59a49cdb9d73`)
- fix(agent-runtime): guard the retained-tail file-op collection by executed calls (`1fa106889fa0`)
- fix(outbox): timestamped non-overwriting quarantine and fail-closed quarantine failures (\#2284 review) (`7987bab0cb8f`)
- fix(runtime): make skills available to fixed-tool delegates (`a6f1e80109c0`)
- fix(outbox): quarantine corrupt session outbox instead of fatal exit (`7ef2b21595ae`)
- fix(agent-runtime): guard split-turn prefix calls by execution results (`b6afc4a4ceba`)
- fix(outbox): atomically persist empty recovery snapshots (`3a61e4cde1ad`)
- fix(runtime): guard repetitive model output and previews (`5b4fd2c28eed`)
- fix(agent-runtime): keep length-stopped and mid-batch-interrupted calls out of compaction file ops (`4d8d4a89e0d9`)
- fix(agent-runtime): recover text-form tool calls once per turn (`0008cb59f39e`)
- fix(delegation): accept redundant model bindings on resume (`9272af7659c1`)

### Improved

- No changes recorded in this category.

### Maintenance

- docs(readme): center personal enhancements and verified provenance (`d4cc2151a843`)
- test(outbox): cover double corruption and failed-quarantine fail-closed boot (\#2284 review) (`5c24dc83768e`)
- test(outbox): cover zero-byte, torn and dead-letter corrupt recovery (`5196448124f0`)
- chore(release): record 0.22.0-beta.9 personal candidate (`7b18ec7d9903`)

## 0.22.0-beta.9 — 2026-11-11

Source: `bf47f63d43b38d84c960262d829f240d7381dfd0`; build: `20261111T184751186Z-gbf47f63d43b3-117c5691`; SHA-256: `ce4d8ef239fb54dce03e1920f8f10aa72d94624d437e205e7688d2753583c67d`.

Verified by offline package checks only; no installation or profile-upgrade claim.

### Added

- feat(runtime): add provider stream idle policy (`bf47f63d43b3`)
- feat(chat): show a transcript file reference in its folder (`8d153dc3bbbd`)
- feat(modes): complete Goal run controls from the original proposal (`a209a2ca8220`)
- feat(modes): introduce user-defined staged mode workflows (`1131ce966084`)

### Fixed

- fix(desktop): clear stale session running indicators (`aa5f26085046`)
- fix(runtime): keep context compaction under runtime control (`5d332f0d4452`)
- fix(mcp-control): expose agent/pendingInteractive in the reviewed catalog (`c5c5db146002`)
- fix(agent-runtime): parse OpenAI "Error code: NNN" statuses (`9f0cd68502f6`)
- fix(agent-runtime): leave unexecuted calls from failed turns out of compaction file ops (`8dfd8db57aa7`)
- fix(agent-runtime): read DeepSeek, DashScope and Groq max\_tokens ranges as output ceilings (`aad6054f6c26`)
- fix(agent-runtime): skip failed and aborted turns when retaining reasoning (`8a601f0dc273`)
- fix(storage): skip non-directory entries when scanning browser partitions (`d785b89d8743`)
- fix(agent-runtime): send a Claude Code identity subscription models accept (`564854d33420`)
- fix(mcp): retry project-scoped server connections (`61add8835b5b`)
- fix(agent-runtime): treat insufficient balance wording as terminal (`0b4ea82c9abe`)
- fix(agent-runtime): classify Incorrect/expired API-key wording as unauthorized (`b41191bf9e2c`)
- fix: 防止旧队列读取恢复已送出的提示 (`cbec768c91f2`)
- fix: 保留有界读取期间更新的会话缓存 (`81e5f136a3de`)
- fix(composer): keep clipboard child stdout binary (`ca6cd58ecc54`)
- fix(composer): pipe Finder metadata to plutil (`4746dbf46e56`)
- fix(composer): replace execFileSync with async execFile to prevent main-process hang (`c870341daf5d`)
- fix: 停止请求失败时保留会话运行状态 (`3717ef36c197`)
- fix: 防止旧全量历史读取覆盖新会话缓存 (`20cdaef74fcf`)
- fix: 让扩展思考强度调整进入实际请求状态 (`1a59b6a81361`)
- fix: 按会话顺序写入空闲模型配置 (`71d07c14f30d`)
- fix: 文件索引在 Git 截止时间直接回退 (`f13c792dc043`)
- fix(launcher): show real macOS application icons (`157092d87d0a`)
- fix(theme): refresh plugin appearance after system changes (`1db9f9b83c7b`)
- fix(modes): settle a closed run's return mode against the catalog (`39384a7cc4b0`)
- fix(modes): keep catalog file operations on the mode's real file (`226be74a8fbe`)
- fix(chat): resolve POSIX-rooted Windows drive file refs (`8a1f7e5889f5`)
- fix(sidebar): show label colors before conversation titles (`14f17caf8961`)
- fix(delegations): restore pointer input for global history (`4ffdf771a3b0`)
- fix(release): retry transient stapler validation failures (`2bbab2524a3a`)
- fix(session-launch): apply the stored binding to the session's model config (`5a0d9ca9470c`)
- fix: 截图粘贴时跳过原生目录扫描等待 (`0271ec35d443`)
- fix: 在 steering 后为恢复回复分配新消息身份 (`71cee3a78d09`)
- fix: 保留系统通知之前子代理的运行状态 (`5d6e14e5ce77`)
- fix: 让文件管理器 Git 截止时间直接结束等待 (`7f058a9d9fc5`)
- fix: 修复 native Pi 会话文件访问来源路由 (`a5e3b3626cf1`)
- fix(modes): validate integrated workflows and approval fixtures (`990442fb8c3d`)
- fix: 将会话 scratch 路径移到系统提示末段 (`d06c4436ebee`)
- fix: 激活分支时清除旧会话切换状态 (`4e7bbcbbf549`)
- fix: 明确提示 macOS 远程 Host 安装包尚未提供 (`eb5850d53b99`)
- fix: 修复文件管理器创建和重命名的名称校验 (`aed1107f42b5`)
- fix: 按 MCP 编辑器目标项目校验重复配置 (`922058705921`)
- fix: MCP 全部筛选下使用所选项目创建配置 (`e9af6fa36d6d`)

### Improved

- perf(desktop): read only session metadata where the transcript is unused (`211cae52a495`)

### Maintenance

- test(mcp): compare the stdio cwd against the resolved temp root (`9d82ec2abea8`)
- docs(spec): keep the match-null sentence intact around the drive-path note (`392e0319914f`)
- docs(files): write the git deadline comment in English (`a79b03fa6f68`)
- test(agent-runtime): keep the structured-status case free of balance wording (`5b4292dc3f2e`)
- test(e2e): show the composer window while probing (`12850d7b6f85`)
- test(composer): cover PowerShell clipboard adapter (`4e8bc09af7ca`)
- Preserve spacing between integrated E2E scenarios (`31d4cb3c3a69`)
- test: 排除 native 文件路由回归中的 Host 更换干扰 (`16a2cd6bb633`)
- docs(modes): render workflow placeholders literally in VitePress (`5a5c63ee44d4`)
- test: 补充原生图片粘贴的兼容性验证 (`b87d68049663`)
- test: 对齐系统通知和真实重启的子代理状态断言 (`fb5ad1a9c7f3`)
- docs: 修正文件访问回归验证命令格式 (`9ebe54860d78`)
- chore(release): record 0.22.0-beta.8 personal candidate (`06926bc7d100`)
- test(modes): preserve Plan coverage and reject legacy Goal activation (`233022a49997`)
- docs(files): refresh bundled mutation repair provenance (`1bae9d69c551`)
- test: 补充 MCP 导入和编辑归属的交互验证 (`9ec4a942d24f`)

## 0.22.0-beta.8 — 2026-11-08

Source: `5f1d0229a82a997156968d38c77248e6d8e663c4`; build: `20261108T145322250Z-g5f1d0229a82a-ab8c9bf8`; SHA-256: `aaafcfa043670b64a1de0d7d34fa6940c7d35df10f68ce9370e237067c3d0816`.

Verified by offline package checks only; no installation or profile-upgrade claim.

### Added

- feat(images): retain tool result images in chat context (`5f1d0229a82a`)
- feat(transcript): preserve task-first reading and shared detail views (`717b22ae490c`)
- feat(subagents): preserve failure policies and direct child input (`dd6d43b666ea`)
- feat(notifications): preserve delegation history and outcome controls (`3ab65cd3ea5d`)
- feat(sessions): separate project groups from display labels (`75ac982460d3`)
- feat(release): establish traceable personal beta delivery (`0f7552494aa2`)
- feat(chat): show turn and session cost in usage surfaces (`969b7f47abaf`)
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

- fix(runtime): accept redundant delegation job selectors (`275748889e78`)
- fix: 压缩后按上下文所属模型计算窗口容量 (`028bece76e27`)
- fix: 末尾分页保留最后消息后的压缩检查点 (`4d4a17d7eaa7`)
- fix: 显示生图标记对聊天模型选择的影响 (`4cd88649ca1b`)
- fix: 清理关闭浏览器标签后的工具连接 (`93bee3bb26cc`)
- fix(sidebar): retain project layout outside Chromium storage (`b7d03c6576ae`)
- fix(scheduled): recover editor options after Host invalidation (`7d5abca832a6`)
- fix(review): isolate the session-focus correction (`a15dda3d32bf`)
- fix(chat): outline only user messages in the conversation minimap (`5caa0c227b27`)
- fix(scheduled): render task lists independently and retain route snapshots (`dda598c6f7e4`)
- fix(review): synchronize disclosure, session focus, and syntax (`1fc3736a20c6`)
- fix(test): preserve remote transcript retention coverage (`c0d36c925bc4`)
- fix(test): align transcript checks with current rendering (`b3acaae97b25`)
- fix(chat): retain stateful Markdown while recycling prose (`dc3c29dee8ab`)
- fix(agent-runtime): classify DashScope status envelopes before retrying (`11a0da858875`)
- fix(plugins): align workspace discovery with invoking sessions (`89c2921083b3`)
- fix(agent-runtime): bound thinking text in a retained compaction tail (`969c3c04b97e`)
- fix(agent-runtime): keep pixel-rejected images off the history byte budget (`bfc69c73ac27`)
- fix(agent-runtime): clamp max\_tokens to a stated output ceiling (`76ed6ca5e48c`)
- fix(e2e): answer file batch negotiation in the offline fixture host (`6c6d0ff7fdab`)
- fix(composer): isolate task dock tab content (`28d5d07de18f`)
- fix(agent-runtime): surface unexecuted text tool calls (`18eb37ba43b9`)
- fix(projects): reconcile native path aliases before removal (`b55628bf4415`)
- fix(chat): preserve reading anchors before painted layout changes (`11fa50d372ad`)
- fix(chat): stabilize transcript navigation and adaptive history loading (`1283c8bd5c17`)
- fix(chat): stabilize transcript navigation and adaptive history loading (`9eb23cb2b7e3`)
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

- docs(testing): record worktree integration and preservation evidence (`e995188b8afa`)
- test(sidebar): await bootstrap snapshot after recovery (`398f6d6388d9`)
- docs(project): record Pi 1.5 candidate validation (`a72d4da1f690`)
- chore(models.dev): refresh catalog for GPT-6.1 Terra (`4dc1c10e9cde`)
- chore(deps): upgrade Pi runtime to 1.5.0 and adopt its features (`a28baea56615`)
- test(projects): require versioned backups in the native alias probe (`e89807ba0e0d`)
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
