---
title: File Emergence + Tag Forge P5 implementation contract
date: 2026-07-12
status: completed
enforce: false
depends_on:
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-07-12-file-emergence-tag-forge-p4-implementation.md
  - docs/superpowers/plans/2026-07-12-file-emergence-tag-forge-optimization-roadmap.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P5 实施合同：用户反馈与本地校准

## 1. 完成定义

1. “改项目名”、“不相关”、“稍后提醒”、“不再出现”都有真实持久化事实，刷新和重启不丢失。
2. “不相关”只压住当前证据世代，项目产生更新的真实活动后可重新取得资格。
3. “稍后提醒”在到期前完全不出现，到期后自动恢复；“不再出现”按稳定 `projectKey` 隐藏，不能靠改名复活。
4. 全部候选均被上述反馈压住时，空态明确说明“都被隐藏或延后”，不伪装成历史不足或数据异常。
5. 本地评估分两份报告：上线前的事件子集回放，上线后的不可变 prediction snapshot 结果评估；两者不混成一个准确率。
6. 同一无未来泄漏的去标识 fixture 上，新排序 Top-K 命中率高于旧的纯最近使用基线；如无收益，不得为通过验收而修改资格合同。

## 2. 事实与不可破边界

### 2.1 反馈事实

- 新建 `file_emergence_feedback` 账本，至少记录 `projectKey/action/snoozeUntil/evidenceCutoff/createdAt`。
- rename 仍以 `project_identities.source=user` 为名称真值，同时记录反馈事件供本地评估。
- hide/snooze 同步 `project_identities.status`；restore 显式恢复 active。
- 反馈仅作用于当前授权 workspace 的项目，IPC 必须验证 root 归属。
- 反馈后精确标脏包含该 root 的所有缓存组合。

### 2.2 过滤顺序

1. 候选仍按 P1–P4 的资格和排序生成。
2. 稳定项目身份解析后，再应用用户反馈。
3. hidden 永久排除；snoozed 在到期前排除；not_related 仅在 `latestEvidenceAt <= evidenceCutoff` 时排除。
4. 反馈不能改写文档、Tag Forge assignment 或原始活动记录。

### 2.3 评估边界

- 历史回放的每个切点 `t` 只能读 `at <= t` 的活动/阅读事件，outcome 只用 `t < at <= t+1d/7d`。
- 上线前回放不读当前 task projection、可变 frontmatter 或当前 tag。
- 上线后评估只用已落库 snapshot 的 `projectKey/bucket/rank/score/reasonCodes/generatedAt` 与后续真实活动。
- 评估不上传文件名、完整路径、正文或聊天内容。

## 3. 行为验收矩阵

| 行为 | 权威证据 |
|---|---|
| rename 重启保持 | native repository + service 刷新 |
| not_related 证据世代 | 同证据被压制，新活动后恢复 |
| snooze 到期 | 可控时钟 service 测试 |
| hide 稳定 | 改名、刷新、重建候选后仍隐藏 |
| all_suppressed | service + renderer 空态行为测试 |
| 反馈 UI | 四个动作的 renderer 测试和真应用点击 |
| 回放无泄漏 | 切点前后事件交换测试 |
| 基线对比 | 去标识 fixture 上 optimized hit rate > recency baseline |
| 上线后报告 | snapshot + outcome + feedback 聚合测试，与 prelaunch 分区 |

## 4. 非目标

- 不用 P5 反馈重写 P1–P4 资格规则。
- 不做跨设备同步或云端上传。
- 不用用户当前可变元数据伪造历史时点真值。

## 5. Closeout

已完成。

- 用户反馈已落为持久事实：改名、不相关、七天后提醒、不再出现和恢复都经过 workspace 边界验证。
- 真实 Electron 界面点击曾暴露一个深层缺口：延后后的项目身份会因非 active 状态被重建。已修正为 hidden/snoozed 仍参与稳定身份解析，仅 merged 退出，并新增“禁止换 key 复活”真实 SQLite 回归。
- 全部被压制时显示专用空态和逐项恢复入口；恢复列表不会遗漏 not_related。
- 本地评估报告硬分为 `prelaunchReplay` 和 `postlaunchOutcomes`；历史回放只读切点之前事件，真实上线评估只读不可变推荐快照与后续活动。
- 去标识固定样本：持续投入排序 Top-1 命中率 1.0，纯最近使用基线 0.0；添加未来事件不改变切点排序。
- 独立对抗复审后 `npm run verify:file-emergence`：96 项纯行为测试 + 28 项 Electron SQLite 测试通过；72 段迁移连续。`npm run build` 通过。
