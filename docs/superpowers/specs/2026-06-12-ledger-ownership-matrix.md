# 账本所有权矩阵（EP2-T1 成文，07 §1 设计落仓）

> 本表是写方向 gate（EP2-T2 `check-ledger-write-direction.cjs`）的白名单依据。
> 修改所有权必须先改本表，再改 gate，最后改代码。

## 所有权矩阵

| 账本 | 所有的事实 | 唯一写入者 | 别人怎么用 |
|------|-----------|-----------|-----------|
| `run_meta` | run 级：终态/initiator/terminal_reason/时长/token | run-finalizer（`finalizeRunOutcome()`，C1.1 已强制） | 只读 |
| `task_projections` | task 级：状态/步骤/Criteria/Proof/CheckIn/预算视图 | task-projection-sync + finalizer（CheckIn，Q4a）+ 登记的 UI 点 + proof sink（Q3） | UI 只读消费；任务索引（X1a/X1b）从此生成 |
| `browser_tasks` | 采集执行级：进度/游标/单项结果 | browser-engine | 终态只经 TaskEventBridge 上行为 proof，不直接改 projection |
| `skill_task_runs` | 技能执行级：子进程状态/产物路径 | skills-runtime | 同上 |
| `run_state.json` | 进程间续跑句柄 | skill 子进程 | finalize 时收割，不作为 task 状态源 |

## 写方向铁律

执行级账本 → 事件 → task 级账本 → run 级账本，**永远单向上行**；下行只有"创建任务/下发参数"。任何模块跨级直写（如 browser-engine 直接改 projection status）即违规，由 T2 gate 锁死。

## 冗余字段口径源（EP2-T1 落地）

- `task_type` / `budget`：**口径源 = task_projections**。`run_meta` 对应列为"收口快照"——finalize 时经 `run-meta-snapshot.ts` 包装层从 projection 抄录，**永不独立更新**；run 中途对这两列的任何写入都是临时草稿，收口快照覆盖之。
- 一致性回归：`src/__tests__/ledger-consistency.test.ts`（同 run 双账本口径一致，经真实 `finalizeRunOutcome()` 通道验证）。
- 迁移列：本单零新增（`run_meta.task_type`/`budget_json` 既有列直接降级为快照语义）。

## malformed ignored

消费端（UI 投影、任务索引、维护回合）遇字段非法的行：跳过 + `ledger_malformed` metric，不带病显示也不崩溃（EP2-T2 实现）。

## 写方向 gate 存量违规清单（EP2-T2 warning 模式收集，2026-06-12）

| # | 账本 | 位置 | 处置 |
|---|------|------|------|
| 1 | task_projections | app-control/startup-run-reconciler.ts:102 | T3 reconcile 泛化时改走 finalizer 通道 |
| 2 | task_projections | app-control/startup-run-reconciler.ts:114 | 同上 |
| 3 | run_meta | app-control/startup-run-reconciler.ts:83 | 同上 |
| 4 | browser_tasks | app-control/startup-run-reconciler.ts:154 | 同上（启动收尸对执行级账本的直写） |
| 5 | browser_tasks | app-control/startup-run-reconciler.ts:164 | 同上 |
| 6 | browser_tasks | database.ts:2116 | 评估迁移至 browser-engine 或加入 owner 白名单（属历史初始化路径） |
| 7 | browser_tasks | database.ts:2171 | 同上 |

清单收齐后转 `--strict` 走单独小单（合同 T2 风险条款）。测试 `ledger-malformed-ignored.test.ts` 钉死清单数量=7——新增违规即测试红。（Codex 波次 3 P1：gate 初版只记每文件每表首个匹配，已修为 matchAll 全量。）
