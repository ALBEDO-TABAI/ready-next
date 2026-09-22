---
title: File Emergence + Tag Forge P4 implementation contract
date: 2026-07-12
status: completed
enforce: false
depends_on:
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-07-12-file-emergence-tag-forge-p3-implementation.md
  - docs/superpowers/plans/2026-07-12-file-emergence-tag-forge-optimization-roadmap.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P4 实施合同：受控标签与双涌现投影

## 1. 完成定义

P4 只有在以下五件事同时成立时才算完成：

1. 文件涌现只读受控且已生效的 Tag Forge assignment，不读 raw `tags` 表或正文 `#token`。
2. 标签只修正已有注意力/意图候选，任何标签都不能单独让从未使用的文件取得涌现资格。
3. 同一生产 snapshot 产生文件桶和 `prepare/forming/harvest` intent cards；Agent feed 复用这些事实，不再要求测试手填信号。
4. 同一 `projectKey` 在文件树和 Agent feed 中共享名称、成员和行动定位；`open_project/open_artifact/open_project_group` 都有真实、可见失败的 renderer 出口。
5. Tag Forge 的执行责任从超大 `file-management-tools.ts` 拆出，行为不变且专项 gate 仍通过。

## 2. 不可破合同

### 2.1 标签边界

- metadata port 按 `fileKey/path` 返回 `file_tag_assignments` 中 `suppressed=0` 的受控 assignment。
- `ready_project` 是独立项目字段；`entity` 不得被解释成项目名。
- `domain/use/form` 只能增强相关性、使用方式和解释，不能自行创建候选。
- `待整理` 只能与近期投入组合支持 future；`已精读` 降低继续阅读；`精选` 增强长期价值；`已归档` 在无显式恢复时排除。
- CSS 色值、未受控标签、pending 词和 suppressed assignment 对排序为零影响。

### 2.2 共享投影

- `FileEmergenceIntentCard` 显式携带 `projectKey` 和结构化行动 ref。
- `future + 明确下一步` 产生 prepare；`today + 多文件/多证据仍在形成` 产生 forming；`最近完成 + 真实产物` 产生 harvest。
- 只有文件价值、没有行动出口时，只留在文件树。
- Agent feed 组装时按 `projectKey + card type` 去重，不重新创建项目真值。

### 2.3 行动出口

- `open_artifact` 打开 workspace 内真实文件。
- `open_project` 打开项目最合适的成员文件。
- `open_project_group` 在文件树展开/定位同项目成员，并打开主文件。
- 目标缺失、越界或打开失败必须在卡片上显示，不得静默无事发生。

## 3. 验收证据

| 要求 | 必须有的证据 |
|---|---|
| 标签 facet 作用 | 服务行为测试覆盖 entity/project 分离及四种 state |
| raw tag 隔离 | CSS 色值只存在 raw 索引时 snapshot 不变 |
| 无独立资格 | 只有 assignment、没有活动/阅读/意图的文件不出现 |
| 生产 intent card | 从真实 service deps 生成 prepare/forming/harvest |
| Agent feed | 生产 deps 读取共享投影并返回三类卡 |
| 行动 | 三种 action 的 renderer 行为测试 + 真应用点击 |
| 回归 | `verify:file-emergence`、`verify:tag-forge`、`typecheck`、`build` |

## 4. 非目标

- P4 不实现“不相关/稍后/不再出现”持久反馈；它属于 P5。
- P4 不引入 LLM 到涌现刷新。
- P4 不用 tag 反向批量改写旧文件。

## 5. Closeout

已完成（2026-07-12）。

- 生产 metadata port 只读 `file_tag_assignments` 的未抑制受控标签，真实 Electron SQLite 测试证明 raw `tags` 中的 CSS `fff` 不会进入涌现。
- `ready_project` 与 entity 分离；form/domain/use 只增强已有候选的召回和解释；四种 state 修正与表 8.7 一致。
- 生产 snapshot 直接生成 `prepare/forming/harvest`，携带共享 `projectKey`、真实目标和成员路径；Agent feed 通过同一 FileEmergenceService 获取并按项目去重。
- 三种行动出口已打开实际文件/项目成员，目标缺失会在卡片上显示失败。
- Tag Forge executor 已从 `file-management-tools.ts` 拆至独立模块，原有自动/显式写回、回执、索引读回与失败语义保持。
- `verify:file-emergence`：89 项纯行为 + 21 项真实 Electron/SQLite，全部通过。
- `verify:tag-forge`：60 项纯行为 + 21 项真实 Electron/SQLite，全部通过。
- 迁移 1–70 连续通过；`typecheck` 和生产 `build` 通过。
- 真实开发版 Electron 在隔离用户目录和安全测试工作区中验证：空态、四个时间桶、刷新、文件打开均可见；打开文件后实时生成 today 项目，无白屏或死入口。
