---
title: File management and Tag Forge module split implementation contract
date: 2026-07-15
status: completed
enforce: true
depends_on:
  - docs/architecture/current-runtime-contracts.md
  - docs/superpowers/plans/2026-07-12-tag-forge-boost-batch-closure-implementation.md
---

# 文件管理与 Tag Forge 拆分实施合同

## 1. 完成定义

本次重构只有在以下条件同时成立时才算完成：

1. `file-management-tools.ts` 继续作为唯一公开执行入口，但不再持有 Tag Forge 批次状态、审核状态、文件整理计划或回滚日志。
2. Tag Forge 的 `prepare_batch -> apply_batch -> host review` 行为、持久续跑、revision 冲突、目录边界和卡片绑定保持不变，不保留第二套兼容实现。
3. 文件整理的 preview、显式确认、apply、undo、rename、copy、move 行为保持不变，公共路径边界与持久 JSON 原语只有一个实现。
4. 原入口和所有新拆出的实现文件都不超过 1000 行；结构合同进入自动测试，后续增长不能悄悄把状态重新塞回总入口。
5. Tag Forge、文件涌现、文件整理、类型、完整验证、生产构建与真实应用启动全部通过。

## 2. 机器可验证合同

- `src/__tests__/file-management-module-boundaries.test.ts` 检查所有相关实现文件存在且不超过 1000 行，并禁止总入口重新声明 Tag Forge 批次或文件整理状态。
- 既有 `tag-forge-batch.test.ts`、`tag-forge-folder-capability.test.ts` 从原公开入口验证批次、授权、续跑、审核、冲突和失败语义。
- 既有 `file-management-organizer-tools.test.ts`、`file-management-copy-contract.test.ts`、`file-management-section-anchor.test.ts` 从原公开入口验证普通文件行为。
- `verify:tag-forge`、`verify:file-emergence`、`verify:native`、`verify`、`build:dir` 共同作为交付门禁。

## 3. 目标归属

- `file-management-tools.ts`：公开导出、工具路由、搜索/读取类无状态执行。
- `file-management-runtime.ts`：上下文类型、工作区边界、真实路径校验、原子 JSON 状态原语、共享目录盘点。
- `file-management-organize-tools.ts`：新建目录、整理预览/执行/撤销、重命名、复制和移动。
- `tag-forge-batch-tools.ts`：批次准备、批次写回、审核决策、持久状态和续跑回执。

## 4. 非目标

- 不改变工具名称、参数、模型可见面、确认规则或数据库结构。
- 不新增 legacy 转发层、双写状态或临时兼容路径。
- 不借重构调整标签策略、文件搜索排序或界面设计。

## 5. 收口证据

- `file-management-tools.ts` 从 2037 行降到 819 行；共享运行层、文件整理层、Tag Forge 批次层分别为 240、507、577 行，结构合同通过。
- 文件管理聚焦测试 16 项通过、2 项按声明交给原生环境覆盖；Tag Forge 纯逻辑 149 项通过、1 项按声明跳过，原生 87 项全通过；文件涌现纯逻辑 96 项和原生 87 项全通过。
- `npm run verify` 通过：并行 7142 项、串行任务 154 项、性能 11 项均无失败；本轮相关 SQLite 行为另由两条专项中的原生 87 项覆盖，Electron ABI 146 检查通过。
- `npm run build:dir` 成功生成 `exports/mac-arm64/Ready.app`；打包版启动检查确认真实 `app.asar` 页面加载完成、126 个可交互元素、无启动错误。
- 架构计划配对门禁修正了长 frontmatter 被截断后的误判，5 项检查与全仓计划配对均通过；没有通过改历史文档来绕过门禁。
