# Ready 文档导航

> 核对日期：2026-09-06。当前应用 0.8.0，固定 Codex runtime 0.149.0，发布配置为 macOS arm64；精确值以源码清单为准。

从本页选择当前入口。[全量文档清单](documentation-inventory.md) 记录项目叙述文档的用途、原位置和归档去向；[本轮核对记录](maintenance/2026-09-06-documentation-refresh.md) 说明证据与检查范围。

协作与技能维护：修改技能描述、参考资料或执行停点时，见 [2026-09-13 指引应用记录](maintenance/2026-09-13-skills-and-prompts-refresh.md)。

## 1. 当前长期入口

| 需要了解 | 文档 |
| --- | --- |
| 产品与当前能力 | [PROJECT_OVERVIEW](../PROJECT_OVERVIEW.md) |
| 当前进展、已实现与验收边界 | [PROGRESS](../PROGRESS.md) |
| 开发、测试选择与排障 | [DOCUMENTATION](../DOCUMENTATION.md) |
| 协作红线 | [AGENTS](../AGENTS.md) / [CLAUDE](../CLAUDE.md) |
| 代码入口与状态拥有者 | [代码地图](architecture/codebase-map.md) |
| 当前跨模块运行时约束 | [运行时合同](architecture/current-runtime-contracts.md) |
| 产品视觉原则与 UI 定位 | [PRODUCT](../PRODUCT.md) / [UI 调整导览](../UI_ADJUSTMENT_GUIDE.md) |
| 测试规则与真实验证链 | [测试规约](superpowers/testing-conventions.md) |
| 发布记录、经验 | [CHANGELOG](../CHANGELOG.md) / [LESSONS_LEARNED](../LESSONS_LEARNED.md) |
| 打包与来源记录 | [Packer](../Packer/README.md) |
| 固定运行时资产 | [Codex runtime](../assets/codex-runtime/README.md) |
| Windows 当前限制与移植要求 | [Windows 开发](platform/windows-development.md) |
| 架构方法与大文件记录 | [架构原则](../.claude/architectural-principles.md) / [健康台账](code-health/large-file-health-log.md) |

## 2. 现行专项合同入口

这些文档保留具体合同和历史验收。正文中“待开工”“当前缺口”或旧 `status` 可能属于写作当时，不能单独覆盖今日代码；当前生产边界统一见运行时合同。不同专题的通过不能相互替代。

| 专题 | 合同与验证起点 |
| --- | --- |
| 历史接续、草稿和新上下文恢复 | [历史与草稿](superpowers/plans/2026-09-03-ready-history-continuation-and-composer-repair-implementation.md)；`verify:history-continuation` |
| 已有数据升级 | [升级记录](superpowers/plans/2026-09-03-ready-populated-upgrade-migration-implementation.md)；`verify:native` |
| 微信/飞书远程助手 | [远程可靠性](superpowers/plans/2026-09-05-remote-im-reliability-implementation.md)；`verify:remote-im`，真实账号单独验收 |
| 单一助手与新长期记忆 | [记忆合同](superpowers/plans/2026-08-20-single-ready-agent-and-memory-runtime-implementation.md)；`verify:single-ready-memory`，自动整理仍未开放 |
| 稳定凭据 | [凭据合同](superpowers/plans/2026-08-20-stable-credential-vault-implementation.md)；凭据焦点测试与 `verify:native` |
| 工作面接线 | [工作面合同](superpowers/plans/2026-08-13-codex-workbench-surface-rewire-implementation.md)；`verify:codex-workbench-surface` |
| 书本阅读 | [阅读合同](superpowers/plans/2026-08-04-document-reading-mode-implementation.md) / [纸张与落页](superpowers/plans/2026-09-05-document-reading-paper-implementation.md)；`verify:document-reading` |
| 文档性能 | [性能合同](superpowers/plans/2026-07-17-document-mode-performance-implementation.md)；`verify:document-perf` |
| Widget | [设计语言](superpowers/plans/2026-07-11-document-widget-ready-design-language-implementation.md) / [组件基线](DOCUMENT_WIDGET_BASELINES.md) / [能力表](DOCUMENT_WIDGET_CAPABILITY_MATRIX.md) / [生成字段说明](DOCUMENT_WIDGET_OPENUI_PROMPT.md)；`verify:widget-ready` |
| AI 图片产物 | [图片服务合同](superpowers/plans/2026-07-15-ai-image-generation-service-implementation.md)；按当前清单选择图片专项 |

仍被根指引或阶段检查保留的 Research、Provider、MCP、安全和历史账本合同：

- [R / Research](superpowers/plans/2026-05-08-R-stage12-implementation.md)、[S / Provider](superpowers/plans/2026-05-09-S-stage13-implementation.md)、[T / MCP 与 sandbox](superpowers/plans/2026-05-09-T-stage14-implementation.md)。它们不恢复旧 Agent 循环。
- [稳定性](superpowers/plans/2026-06-10-agent-stability-closure-implementation.md)、[历史 Phase 1](superpowers/plans/2026-06-11-agent-evolution-phase1-implementation.md)、[历史 Phase 3](superpowers/plans/2026-06-12-agent-evolution-phase3-implementation.md)。阶段检查只证明对应切片，不代表旧专项 Agent、自动学习、handoff 或公开续跑仍存在。

## 3. 目录与归档

- `architecture/`：当前代码地图和运行时合同；其中旧 child-loop 说明已经原位归档。
- `superpowers/plans/`：现行专项合同和必须保留原路径的历史参考；归属看全量清单及文件顶部说明。
- `superpowers/audits/`：固定历史证据，保留原文与附属数据；[审计说明](superpowers/audits/README.md)。
- `archive/`：迁移后的旧设计、路线图、诊断、一次性交接和此前全文备份；[归档入口](archive/README.md)。
- `widget-fixtures/`：历史解析和视觉样例，属于测试输入，不冒充当前新建 Widget 的默认方案。
- `code-health/`、`platform/`：按专题维护的当前记录与平台要求。
- `maintenance/`：文档整理本身的核对和检查记录。
- `outputs/`、`build/`、`exports/`、`Packer/output/`：本机生成物与验收产物，不是源码文档权威；本轮不清理这些目录。
- `assets/embedded-skills/`、提示词、生成 schema、`.agents/skills/`、`.claude/skills/`：运行或协作资产，保留其消费结构，不按日期归档。

## 4. 状态规则

1. 生产调用方、类型、清单与实际检查优先；文档漂移应修正文档，不能为旧文复活代码。
2. `enforce: true` 的当前合同只约束明确仍生效的范围；不等于全产品已经验收。`enforce: false` 不取消现有测试或授权边界。
3. “原位归档”仍是历史资料。固定证据为保持摘要关系可能没有新增 frontmatter，其身份由归档清单和上级说明给出；旧日期与原状态不改写。
4. 归档不表示计划已完成，也不丢弃当时的失败、未实现项或原始来源。重启旧方案须重新检查现状。
5. 同一事实只维护一份详细合同。其他入口给短摘要和链接，不重复复制阶段流水账。
6. 移动前检查 Markdown、脚本、测试、生成器、固定证据和目录消费者；移动后核对链接。不可移动的证据保留原位，不改源码来迎合归档。

## 5. 快速检查

```bash
cmp <(tail -n +2 AGENTS.md) <(tail -n +2 CLAUDE.md)
npm run verify:version
npm run verify:meta-paths
node scripts/check-testing-conventions-doc.cjs
node scripts/check-stage-r-verify-switch.cjs
node scripts/check-stage-t-verify-switch.cjs
node scripts/check-plan-pairing.cjs --all
```

另检查文档内具体路径、相对链接和命令是否存在。以上是文档与结构检查，不能当成产品行为、联网或安装验收。
