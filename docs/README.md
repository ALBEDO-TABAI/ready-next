# Ready 文档导航与维护规则

> 更新时间：2026-07-14

本文是 `docs/` 的入口。代码、`package.json` 与机器校验结果始终优先于叙述性文档；如果两者冲突，应修正文档，而不是为旧文档保留兼容实现。

## 1. 根目录只放长期入口

- `AGENTS.md` / `CLAUDE.md`：协作方式、不可破红线、必读索引；两份正文必须同步。
- `PROJECT_OVERVIEW.md`：产品与技术基线，不记录阶段流水账。
- `DOCUMENTATION.md`：开发入口、变更流程和排障路径。
- `PROGRESS.md`：当前状态看板，只保留仍有决策价值的近期信息。
- `CHANGELOG.md`：发布记录与历史开发快照。
- `LESSONS_LEARNED.md`：经真实故障验证、可跨阶段复用的经验。

专项导览、平台交接、模块地图和详细合同不再新增到根目录。

## 2. 当前有效文档

| 目的 | 文档 |
| --- | --- |
| 当前代码入口、模块与依赖 | `docs/architecture/codebase-map.md` |
| Agent、Browser、Skill、Widget 等运行时硬合同 | `docs/architecture/current-runtime-contracts.md` |
| 架构原则的反例与自检 | `.claude/architectural-principles.md` |
| 测试边界与 SQLite 验收 | `docs/superpowers/testing-conventions.md` |
| UI 修改入口 | `UI_ADJUSTMENT_GUIDE.md` |
| Windows 开发与交接 | `docs/platform/windows-development.md` |
| Windows x64 支持方案（范围待确认） | `docs/superpowers/plans/2026-07-14-windows-x64-support-implementation.md` |
| 大文件健康台账 | `docs/code-health/large-file-health-log.md` |

## 3. 目录职责

- `docs/architecture/`：仍在生效的跨模块边界、代码地图和维护导览。
- `docs/superpowers/specs/`：目标设计与产品规格。只有被当前指引或实施计划引用时，才可视为当前约束。
- `docs/superpowers/plans/`：架构级改动的实施合同与验收清单。
- `docs/superpowers/audits/`：一次性审计、复审和证据；它们记录当时事实，不自动成为长期真值。
- `docs/diagnostics/`、`docs/performance/`：专项调查与性能证据。
- `docs/release/`：发布操作和发布验收材料。
- `docs/archive/`：清扫前全文或旧主链迁移档案，必须标 `enforce: false`，仅供追溯。
- `docs/widget-fixtures/`：Widget 测试材料，不是产品说明。
- `outputs/`、`fix/`、`plans/`：历史工作产物。除非当前入口明确引用，不应据此推断现状。

## 4. 文档状态口径

带 frontmatter 的文档按以下规则解释：

- `enforce: true`：仍是执行合同，修改对应行为时必须同步更新并跑配套校验。
- `enforce: false`：历史、审计、反提案或只读快照，不得覆盖当前代码事实。
- 没有 frontmatter：先看当前入口是否引用，再核对代码和日期；不能仅因文件名像“最终版”就采信。

## 5. 维护规则

1. 同一事实只设一个详细真值源；其他文档用链接和短摘要，不复制整段合同。
2. 手工模块清单不记录文件数和易变路径；需要精确结构时直接从工作区生成。
3. `PROGRESS.md` 不保存测试流水账、长提交列表或已结束阶段全文；历史由 Git、`CHANGELOG.md` 和阶段计划承担。
4. 旧计划和审计可以保留当时文件名，不要求伪装成现行入口；当前文档不得引用已删除路径。
5. 版本、依赖和命令以 `package.json` 为准；日志路径以主进程实现和根指引为准。
6. 新增长期规则时，优先配机器校验；只能靠人读的规则必须说明为什么无法自动验证。
7. 根文档改动必须检查 `AGENTS.md` / `CLAUDE.md` 同步、相对链接、引用路径和命令是否存在。

## 6. 快速核对

```bash
cmp <(tail -n +2 AGENTS.md) <(tail -n +2 CLAUDE.md)
npm run verify:version
npm run verify:meta-paths
node scripts/check-testing-conventions-doc.cjs
node scripts/check-stage-r-verify-switch.cjs
node scripts/check-stage-t-verify-switch.cjs
```

文档中出现的源码路径还应逐一确认存在；不要把 source grep 当作产品行为测试。
