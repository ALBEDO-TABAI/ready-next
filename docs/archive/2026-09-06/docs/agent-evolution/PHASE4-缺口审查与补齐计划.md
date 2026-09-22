---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../documentation-inventory.md)。

# Agent Evolution 阶段四缺口审查与补齐计划

> 日期：2026-06-13
> 范围：`docs/agent-evolution/` 全目录 + 阶段四实施合同 `docs/archive/2026-09-06/docs/superpowers/plans/2026-06-13-agent-evolution-phase4-implementation.md`

## 1. 审查结论

阶段四核心闭环已经补齐：K-mirror / A5 / A6b / A7 / B6 / E5 / G4 均进入 `verify:evolution-p4`，设置页可见并可操作知识系统、staged 卡、站点旁卡、agent 派生与生命周期。继续保留的缺口不属于阶段四主轨，而是两条遗留轨：R-E2（意图流用户面/反馈/权重漂移）与 R-B1（浏览器批量执行与 planner 降级）。

## 2. 已补的验证缺口

| 缺口 | 证据 | 补齐 |
|---|---|---|
| K-mirror 的 watcher / 设置开关边界已由 `knowledge-truth-source-boundary.test.ts` 覆盖，但未进 P4 总回归 | `verify:evolution-p4` 原脚本缺该测试 | 已加入 `verify:evolution-p4` |
| A5 实际发送路径在 `stores.test.ts`，P4 只跑纯路由器测试 | 设置项和会话预路由已接 UI/renderer send path | 已加入 `verify:evolution-p4` |
| E5 文件树消费 prepare/forming 的视图模型测试未进 P4 | `file-emergence-view-model.test.ts` 覆盖 intentCards 注入与 harvest 隐私排除 | 已加入 `verify:evolution-p4` |
| A6b 只有数据层，没有用户确认入口 | 设置页无法从 candidate 卡确认生成新 agent | 已补 `agent:derivation:*` IPC / preload / renderer 类型 / `AgentDerivationPanel`，并以 `agent-derivation-flow.test.ts` 覆盖确认前只读、确认后写入与迁移勾选；以 `agent-phase4-settings-panels.test.tsx` 覆盖创建/驳回按钮 |
| A7 生命周期只有 repository 状态机，没有可见管理面 | 用户不能查看 agent 实体、退休/合并或选择迁移卡 | 已补 `agent:registry:listKnowledge`、设置页 agent 列表、退休/合并确认与逐项迁移勾选，并以 `agent-registry-group.test.ts` 与 `agent-phase4-settings-panels.test.tsx` 覆盖 |
| B6 只接 visible collect 空诊断，浏览器工具失败没有进入站点学习 | 多信源接口存在但运行时未喂信号；宽文本猜测会误学安全拒绝 | 已补浏览器工具错误闭集码接线；CheckIn hook 只接受显式 `site_failure:<kind>` blocker，泛 Q4a blocker 不再被误学；仍保持 active 卡零自动改写、风险只出 staged 建议卡 |
| E5 harvest 默认无用户面时容易被误读为缺失 | harvest 因 R-E2 未解锁不能进意图流 | 已补 `buildHarvestIntentProjection`：默认返回 sanitized deferred cards 并标明 `blockedBy: R-E2`，接口可被后续意图流直接消费 |
| 04 / 08 / PHASE4 计划存在旧口径 | 仍写 per-agent index、`task_projections.agent_id`、candidate `status`、A6b/A7/B6 未接线 | 已同步 root index 只收 global、任务 owner 字段、candidate `stage`、以及当前验收状态 |

## 3. 仍保留的非阶段四缺口

| 编号 | 来源 | 当前现状 | 缺口 |
|---|---|---|---|
| P2-E2/E3/E4 | 10 §2.2-2.4 | resume/follow-up/crystallize 与 E5 内核已在 feed 里；设置页有总记忆面板 | 工作台意图流视图、反馈日志、卡类型开关、权重漂移仍属于遗留轨 R-E2 后续，不应误标为阶段四已完成 |
| P2-B1/B4/B5 | 11 B1/B4/B5 | B6 绕开 B1，可先吃现有失败事实 | 批量执行通道、运行时 locator/snapshot guard、planner 降级/packet 改造仍未解锁 |
| P2-setting-split | 10 §3 | 设置页仍使用 `file_emergence_enabled` 单开关 | 文档要求拆成 `emergence_file_view` / `emergence_intent_feed`；当前只符合旧文件涌现开关，不符合意图流拆分 |

## 4. 已执行的补齐顺序

1. **先收紧验证入口**：`verify:evolution-p4` 覆盖 K watcher、A5 renderer send path、E5 文件树视图模型、A6b、A7、A6b/A7 设置页渲染、B6、E5 harvest projection。
2. **补 A6b 确认派生闭环**：从 candidate staged 卡生成确认数据；确认流允许改名、改 RULES、勾选迁移卡和“立即生效”；拒绝/预览路径不写任何 agent / RULES / routing 卡。
3. **补 A7 生命周期管理面**：设置页展示 agents 实体；退休/合并必须确认；合并迁移清单逐项勾选；资产目录保留。
4. **补 B6 多信源运行时接线**：CheckIn blockers 与浏览器工具错误 `errorKind` 进入 `SiteCardLearningSignal` 归一入口；未知 kind 拒绝、active 卡零改写、风险变更只出 staged 建议卡。
5. **补 E5 harvest 接口边界**：R-E2 解锁时只需消费 `buildHarvestIntentProjection(..., { intentFeedEnabled: true })`，不用重新解释隐私边界。
6. **补文档漂移**：同步 04 / PHASE4 / 08，把已经被 v3 合同推翻的旧说法改成当前真合同。

## 5. 完成标准

- A6b / A7 / B6-source / E5-harvest 各自有实现、焦点测试，并纳入 `verify:evolution-p4`。
- `npm run verify:evolution-p4`、`npm run verify:evolution-p3`、`npm run verify:evolution-p2`、`npm run verify:evolution-p1`、`npm run verify:stability`、`npm run typecheck` 通过；最后跑 `git diff --check`。
- 设置页能看到并操作阶段四需要用户确认的面：知识系统、staged 卡、站点旁卡、agent 生命周期。
- 08 表不把 R-E2 / R-B1 遗留轨写成阶段四已完成；04 / PHASE4 与阶段四 v3 合同不再冲突。
