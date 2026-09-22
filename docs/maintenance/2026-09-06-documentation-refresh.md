---
enforce: false
date: 2026-09-06
kind: documentation-audit
baseline_commit: b3dd9f731c125cf9d0ff02ca987a4d9ee9106a01
---

# 2026-09-06 项目文档事实核对与归档

## 范围与完成标准

依据当前源码、清单、近期提交与原验收记录更新项目说明。完成标准是：现行入口不再混用旧主链、旧功能承诺或旧发布状态；历史材料能定位；归档不破坏代码/检查消费者和固定证据；路径、命令与相关文档检查通过。

本轮只改 Markdown。没有改应用行为、依赖、版本、数据库或已安装应用，也没有提交、打包、发送远程消息或修改个人凭据。开工时已有的 `build/release-skill-runtime/` 生成目录保留。

## 核对事实与修正文档

| 事实 | 当前依据 | 文档处置 |
| --- | --- | --- |
| 应用 0.8.0、Codex 0.149.0、macOS arm64 | `package.json`、`electron-builder.yml`、`assets/codex-runtime/source-lock.json`、`runtime-manifest.json` | 更新总览、导航、进展和平台要求；移除把 0.7.1 当成当前发布的说明 |
| 四工作面与统一助手 | `src/renderer/stores/useMode.ts`、`src/main/modules/agent-control/runtime-core/runtime.ts` | 保留 Browser/Document/RSS/Calendar；明确旧循环、专项人格和定时任务退役 |
| 技能在进入回合前冻结 | `src/main/modules/agent-control/codex-runtime/codex-tool-surface.ts` | 根指引不再要求模型在同轮调用 `use_skill`；明确发现技能不代表脚本准入 |
| 手动新记忆，自动整理禁用 | `src/main/modules/agent-control/ready-memory/ready-memory-production-provider.ts`、`src/renderer/pages/settings/ReadyMemorySettingsPanel.tsx` | 移除旧进展中的旧人格/旧记忆保留承诺；归档旧领域资料库提案 |
| 历史接续按具体操作判断，草稿编辑独立 | `codex-runtime-compatibility.ts`、`codex-action-surface.ts`、`codex-context-boundary.ts`、`composer-state.ts` | 修正运行时合同中仅按摘要或 legacy 标签要求重置的旧叙述；保留明确恢复边界 |
| 远程通信已经接到当前助手 | `remote-channel-service.ts`、`remote-codex-turn.ts`、`src/python/ready_sidecar/event_store.py` | 增补开发导航与进展；区分本地协议夹具和真实账号验收 |
| 只读书本阅读及近期纸张改进 | `src/renderer/components/document/book/`、`src/renderer/modules/document/book/`、提交 `b3dd9f73` | 更新产品、UI 导览与阅读专项入口 |
| Widget 由结构编译与主题令牌生成 | `src/shared/document-widget-openui.ts`、共享 skeleton/theme/dot-charts | 替换过时的“SVG/Chart.js 优先”建议；历史样例仍保留为测试资源 |
| 发布包绑定编译前源码 | `scripts/build-with-source-identity.cjs`、`scripts/release-package-identity.cjs` | 更新 Packer；说明真实目录/符号链接均可能存在，移除固定目录计数与体积承诺 |
| 实际验证链已经改变 | `package.json` | 测试规约明确 `verify:native` 含真实数据库测试，`verify:cloud` 也会经阶段链进入 native 验证 |

表中缩写文件位于代码地图列出的对应模块；长期详细约束只维护在 [运行时合同](../architecture/current-runtime-contracts.md)。

## 归档结果

[全量文档清单](../documentation-inventory.md) 共登记 788 份：原有项目叙述文档 782 份，另登记本轮新增导航、核对记录和固定 runtime 说明。

- 333 份旧设计、计划、诊断和交接迁入 `docs/archive/2026-09-06/`，保留原目录层级并注明 `enforce: false`。
- 77 份因代码、检查或固定历史文档引用而保留原位，顶部明确“原位归档”。它们的旧阶段状态不是今日待办。
- 322 份固定证据与既有档案保持原文逐字不变，包括审计报告、实验合同和原有归档。附属 JSON、截图、代码与来源摘要也未改写。
- 17 份专项合同继续保留其具体用途和原验收范围；其余为当前入口、归档索引和组件/测试资源。
- 运行时技能正文、提示词、生成 schema、第三方材料和本机生成物不按日期归档。生成的 Widget 说明与 schema 已从当前组件重建，结果无差异。

迁移前检查了 Markdown、脚本、测试、CI、生成器与固定证据引用；来源清单中的历史文件名继续描述当时快照，不重写成当前路径。相对链接、未带目录的文档引用及可识别的旧工作站绝对文档链接已调整。

## 本轮验证

- `npm run typecheck`：Main/Preload 与 Renderer 均通过。
- `verify:version`、`verify:meta-paths`、`verify:codex-runtime-source`：通过；runtime 仍为固定 0.149.0。
- 根指引正文同步、测试规约、Stage R/T、全目录 plan pairing：通过。
- Stage Y 历史证据目录、能力标记与 P7 历史合同消费者检查：通过。
- 文档 gate 的回归测试 39/39 通过，无跳过。
- UI 导览、Widget 说明/生成/编译、历史验收清单与保留路径消费者共 96/96 通过，无跳过。首次普通 Node 有一项 ABI 跳过，随后整组改用 Electron 执行，以上为最终结果。
- 文档存在性、归档唯一去向、现行源码路径与命令、Markdown 链接和固定证据一致性核对：788 份全部有明确去向；333 份迁移目标存在且原位已移除；322 份固定证据与原文一致；通过 Markdown 语法解析核对的仓库内链接无失效项，现行入口所列具体源码路径与命令均存在。
- `git diff --check`：通过；非 Markdown 文件无改动。

上述测试检查文档消费者和相关局部行为，不代表重跑完整产品回归、真实外部账号或最新安装包验收。旧报告的失败和通过都保持原适用范围。
