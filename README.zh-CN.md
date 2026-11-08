# PI-Desktop

> **当前发布线：0.22.x（beta）。**

本地优先的 AI Agent 桌面工作台：项目、会话、模型、插件和 Agent 工作流都留在同一个
Electron 应用里。

本仓库是 PI-Desktop 的**个人独立维护版本**，不是上游官方发行版，也没有自己的公开下载
或支持渠道，使用 beta 发布线。它基于[上游 PI-Desktop](https://github.com/vastsa/PI-Desktop)，
保留原项目署名与 [LGPL-3.0 许可证](LICENSE)；上游仍是原始产品设计与文档的来源。

[English](README.md)

---

## 这个版本包含什么

- **会话与项目**：会话多选、批量归档/取消归档、回收站恢复，以及需明确确认的永久删除。
- **Agent 委派**：子代理的模型调度与分组审批、策略热更新、保留检查点、显式重试/恢复，
  以及有界的恢复流程，而不是无声停滞。
- **聊天文件**：打开方式、另存为、复制文件内容、在文件夹中显示，并规范化 Windows 路径引用。
- **通知**：审批、提问与完成信号统一到同一套通知。
- **任务续跑**：当前任务清单未完成时最多续跑一次，停止操作始终有效。
- **个人 Windows 构建**：单一固定的 NSIS x64 安装包流程，其产物禁用官方自动更新。

其中部分流程较新，仍在日常使用中做集成验证。请把 beta 线当作可用状态，而不是稳定产品
承诺。变更内容、时间与对应提交记录在 [CHANGELOG.md](CHANGELOG.md)，它由 Git 历史生成，
不是手写的宣传文案。

## 环境要求

- 个人安装包流程：Windows 10/11 x64
- 源码构建：Node.js `>=22.19`、pnpm `>=10`、稳定的 Rust 工具链（Windows 还需 MSVC Build Tools）

## 从源码运行

在已有的源码检出目录、并安装必要工具链后执行：

```bash
pnpm install
pnpm dev
```

`pnpm dev` 默认隔离数据目录，不读写已安装版本的配置。使用
`pnpm dev --inherit-data-dir` 前请先读 `AGENTS.md` §5。

常用检查：

```bash
pnpm typecheck
pnpm lint
pnpm -r --if-present test
pnpm check:agent-policy
```

## 构建个人安装包

```bash
pnpm dist:personal --check                          # 只打印计划，不构建
pnpm dist:personal                                  # 普通构建：版本不变
pnpm dist:personal --check --release 0.23.0-beta.1  # 预览候选版本（仅示例）
pnpm dist:personal --release 0.23.0-beta.1          # 构建该候选版本
```

构建会在 `apps/desktop/release/personal/` 下产出一个 Windows x64 NSIS 安装包 EXE 和
SHA-256 校验文件，同时写入构建元数据：准确的 Git 来源、工作区是否脏、唯一构建标识，以及
从 Git 历史生成的 Added/Fixed/Improved/Maintenance 变更说明。普通构建不会改变应用版本，
只有明确申请候选发布时才选择新版本。上面的 `0.23.0-beta.1` 只是示例，不代表当前应升级到
该版本。

**打包流程不会安装或启动 PI-Desktop。** 安装 EXE 是你自己的步骤。固定的流水线、产物结构
与限制见[个人发布说明](docs/spec/06-delivery/07-personal-release-runbook.md)。

## 文档

- [插件开发指南](docs/plugin-development.md)：构建 `.piplug` 包；插件规格仍是 API 契约的
  权威来源。
- [规格索引](docs/spec/NAV.md)与[架构基线](docs/spec/00-baseline.md)。
- [个人发布说明](docs/spec/06-delivery/07-personal-release-runbook.md)。
- [变更检查清单](docs/spec/06-delivery/05-change-checklist.md)与
  [Agent 开发流程](docs/spec/06-delivery/03-ai-development-workflow.md)。
- [E2E 测试计划](docs/spec/06-delivery/04-e2e-test-plan.md)。
- [AGENTS.md](AGENTS.md)：面向贡献者与 AI Agent 的权威仓库规则。
- [规则维护说明](docs/maintenance/agent-workflow.md)：项目规则放在哪里，以及如何校验入口。
- [CONTRIBUTING.md](CONTRIBUTING.md)与 [SECURITY.md](SECURITY.md)。

## 本版本的范围

本版本独立于上游维护。重新上传仓库后再补充个人版的下载、Issue 和社区入口；上游的相关
渠道不是本版本的支持入口。上游同步与贡献只在明确要求、并核实目标远程仓库后进行。

## 目录结构

```text
apps/desktop/       Electron 应用（main、preload、React 渲染层、测试）
crates/host-core/   Rust 宿主：持久化、原生状态、宿主 RPC
packages/           共享契约、i18n、Agent 运行时、宿主运行时、Plugin SDK
docs/               规格、ADR、指南
scripts/            仓库自动化、E2E、打包
```

## 许可证

PI-Desktop 使用 GNU Lesser General Public License v3.0，详见 [LICENSE](LICENSE)。
保留原项目署名与上游贡献者信息。
