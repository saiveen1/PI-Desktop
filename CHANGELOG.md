# Personal changelog

This is the personal edition's release record, generated from `docs/releases/history.json`. Ordinary builds do not create releases or change the beta version. Commit-subject categories are traceability aids, not stability or test claims.

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
