---
kind: implementation
status: completed
enforce: false
date: 2026-07-12
scope: file-emergence-p0
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# 文件涌现与 Tag Forge：P0 生产信号修复实施合同

## 1. 本阶段边界

本阶段只修复文件涌现已有信号的真实性、缓存失效、诊断和空态。它不修改项目命名规则、四桶主要评分权重、Tag Forge 写回，也不提前建设 P1 之后的身份与长期统计。

完成不是“现有单测仍通过”，而是以下生产形状均可由行为测试证明：

1. Markdown、PDF、EPUB 的本地阅读进度能从真实 Web Storage 读取；
2. 页面读取的进度能随阅读会话写入 repository，并由 snapshot 消费；
3. 一次用户打开手势不会因 FileTree 与 DocumentMode 两个来源写成两条事实；
4. 持久化但长期未激活的 tab 不会被 renderer 强行放入“今天”；
5. 任一 root 的活动会使所有包含该 root 的单根与多根缓存同时失效；
6. snapshot 的项目 `updatedAt` 表示最近证据时间，`generatedAt` 只表示本次生成时间；
7. 生成结果带隐私安全的聚合诊断，不记录正文、聊天原文、完整路径或外部 URL；
8. 文件树在零候选时仍显示涌现区，并区分“无可信候选 / 数据源异常 / 历史不足”；
9. `npm run verify:file-emergence` 覆盖上述合同并进入相关阶段验证链。

## 2. 明确合同

### 2.1 阅读进度

- 调用 Web Storage 方法时必须保留原生 receiver；测试使用 JSDOM 的真实 `localStorage`，不能只用箭头函数替身。
- session 的 `progressStart/progressEnd/progressKind` 继续由现有 renderer -> IPC -> repository 通道写入，不新增旁路。
- 损坏的单类本地进度只降级该类读取，不得让其他类型全部消失。

### 2.2 打开事实幂等

- 同一路径、同事件、同一短时间窗内的用户打开事实跨 renderer source 合并；来源只作为该事实的补充元数据，不再决定是否重复。
- save 与 watcher/document write 语义不在本阶段合并，避免改变保存权重。
- renderer 对同一次 FileTree 选中不再额外由 DocumentMode 重复上报。

### 2.3 tab 新鲜度

- `DocTab` 保存最近被打开或激活的时间；旧持久化数据没有该字段时按“未知且陈旧”处理，不伪造为当前时间。
- active/split tab 只有在本次会话确实激活后才可进入“今天”；dirty tab 保留当前工作信号。
- 普通后台 tab 超过 24 小时不再以 `current_document` 注入“今天”。

### 2.4 缓存、时间和诊断

- cache entry 显式记录 roots；`markStale([root])` 标脏所有 roots 集合与其相交的 entry。
- `updatedAt` 取候选真实证据的最大有效时间，不用生成时刻兜底覆盖。
- snapshot 诊断只包含来源计数、候选/可见/拒绝数量、分桶数量、降级来源与缓存状态。

### 2.5 空态

- `no_trusted_candidates`：来源正常且历史量足够，但没有通过资格的项目；
- `sources_degraded`：关键来源读取异常，当前结果不可完整判断；
- `insufficient_history`：可用 activity + reading history 都不足以形成判断；
- 空态是 snapshot 的结构字段，由 renderer 直接展示，不通过本地猜测重新分类。

## 3. 最小改动面

- shared：snapshot 诊断、空态和 tab 新鲜度所需字段；
- renderer：Storage 绑定、tab 最近激活时间、空态展示与手动刷新时重新读取进度；
- main：activity 幂等、multi-root stale、证据时间、聚合诊断；
- tests/scripts：真实 Storage、repository、service、view model 与 UI 行为测试，以及独立 verify 命令。

不新增数据库迁移；P0 使用现有 activity 与 reading session 表。

## 4. 验收顺序

1. 先写会失败的生产形状测试；
2. 做最小实现并跑 `npm run verify:file-emergence`；
3. 跑 `npm run typecheck`，涉及真实 SQLite 的测试前后跑 `npm run verify:native`；
4. 在真实 Electron dev 的文件管理中观察三类空态、手动刷新、当前/陈旧 tab 与阅读进度；
5. 检查所有新增行涉及的代码文件总行数并更新健康度台账；
6. P0 真机通过后关闭本文 `status`，再开始 P1。

## 5. 失败条件

以下任一情况出现都不能宣告 P0 完成：

- 测试仍以理想 fixture 绕过 renderer/IPC/repository；
- 零项目时整个涌现区消失；
- 诊断包含正文、聊天原文、完整文件路径或完整外部 URL；
- 为让未来/遥远出现而调整主要评分阈值；
- 为兼容旧行为保留第二套去重、缓存或空态真值；
- 只通过 host Node 的 SQLite skip，没有完成 native gate；
- 没有在真实文件管理界面观察结果。

## 6. 2026-07-12 验收结果

- `npm run verify:file-emergence` 通过：59 条纯行为检查与 10 条 Electron 原生数据库检查全部通过，无跳过；
- `npm run typecheck` 通过；
- Electron 原生数据库加载检查通过；
- 隔离 Ready dev 的文件管理中实际观察到 `insufficient_history`、`no_trusted_candidates`、`sources_degraded` 三类空态；
- 手动刷新后状态与聚合诊断同步更新；诊断只包含来源数量、候选/拒绝/分桶数量与缓存状态；
- P0 没有修改项目命名规则或四桶主要排序权重；
- 真机验收使用 `/private/tmp/ready-file-emergence-p0-live` 隔离数据目录和 `/private/tmp/ready-emergence-p0/workspace` 隔离工作区，没有改动用户现有 Ready 数据。
