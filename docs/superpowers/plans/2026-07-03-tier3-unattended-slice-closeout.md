---
title: 梯队三无人值守切片收尾 — D5 run-feedback 后端全通道
date: 2026-07-03
status: done
enforce: false
parent: 2026-07-03-HANDOFF-agent-module-rework.md
purpose: >
  用户要求"继续梯队三里无人值守能做的部分"。本文记录切分决策（哪些能做、
  哪些明确不做及原因）、D5 后端切片实施与验证证据。
---

# 1. 切分决策（梯队三 × 无人值守）

| 项 | 决策 | 依据 |
|---|---|---|
| **D5 RunFeedback 后端**（IPC/preload/类型/测试） | **做** | 纯主进程+类型+headless 行为测试；UI 是唯一需真机的部分 |
| D5 renderer 评分控件 | 不做 | renderer UI 白屏高危 + 真机验证（handoff §6） |
| Emergence feed 通电 | 不做 | 通电=gate-flip 出 UNWIRED，而无 UI 消费面的 producer 是"半活"——恰好复制 built-but-dark 反模式；等 UI 一起 |
| P5d LLM 维护回合 / candidate-maintenance | 不做 | handoff 明标"最后做"，需 LLM 预算 + staged 写监控 |
| D2+D4 合并设计 | 未动 | 改模型可见面的合同设计应与实施同会话评审，避免无反馈闭环的纸面合同 |

# 2. D5 后端切片交付

- `claude-bridge/ipc/run-feedback-group.ts`：`agent:runFeedback:submit/list`。校验全在代码：rating 必须 1-5 整数、signal≤120、comment≤2000、空反馈拒绝（`empty_feedback`）、缺 runId 拒绝；缺省反馈槽 `fb_<runId>`（每 run 一个可修改槽，复交走 repo 的 upsert，形状由既有 `check-feedback-upsert-shape.cjs` 钉住）；list 过滤 runId/taskId、limit 收敛 [1,200] 缺省 50。依赖是结构化最小面 `RunFeedbackRepositoryLike`（生产传真 repo，测试传内存假体）。
- `ipc-handler.ts` 三点接线（import / dispose 变量+两处对称释放 / 注册），repository 按需 `getDatabase().getRawDb()` 构造，SQLite 不可用回结构化 `sqlite_unavailable`。
- preload `runFeedback` API + `electron.d.ts`（`RunFeedbackRecordData` / `ElectronRunFeedbackAPI` + electronAPI 字段）——IPC 合同 gate 的 A 面（invoke 双侧）与 D 面（expose↔类型字段）同步满足。
- **顺修根因一处**：repo 构造器 `Database.Database`（better-sqlite3 直依）→ `DatabaseConnection`（项目结构化 DB 惯例，与 RunMetaRepository 一致）。这是该文件 dark 期间从未暴露的类型失配，接线即现形——"接线才能暴露真缺陷"的又一实例。
- CLAUDE.md §7 六件套：Main IPC ✓ / Preload ✓ / Renderer 类型 ✓ / 行为测试 ✓ / 文档 ✓（本文 + D5 登记更新）；Renderer 组件 = D5 仅剩项（能力在 `check-mandated-capability-is-live.cjs` 保持 dark-defect，UI 落地时 gate-flip）。

# 3. 验证证据（全部真实退出码）

- `npm run typecheck`（node+web 全量）EXIT=0
- `run-feedback-group.test.ts` 6/6（假 ipcMain+假 repo 行为面：校验矩阵/复交/limit 收敛/sqlite_unavailable/dispose 对称）
- `migration-036-feedback.test.ts` host-Node 按 sqlite-skip 设计跳过；真实 SQLite 路径由 `npm run verify:native` EXIT=0 覆盖
- `npm run verify:stability` EXIT=0
- `node scripts/check-mandated-capability-is-live.cjs` ok（D5 条目维持 dark-defect，锚点+工单一致）
- `check-ipc-contract.cjs` EXIT=1 为 **base 既有 26 条**（6 handled-only：agent registry/personality/specialistBlueprint 簇；20 non_literal_push：browser-engine 行号漂移）——与本切片改动前后违规集合逐条一致，`agent:runFeedback:*` 零违规（handled/used 各 +2 配对成功）。既有 26 条属身份两表拆分与 vertical-tabs 分支的已知清单，不在本切片修

# 4. 剩余（按序）

1. D5 UI：评分控件挂 `window.electronAPI.runFeedback`（任务卡或质量面板），真机回归后翻 registry 条目为 live-required（wiring 证据 = renderer 调用点 + IPC 通道）。
2. Emergence feed（producer+IPC+UI 一体做，gate-flip 迁移）。
3. D2+D4 合并设计与实施（criteria 注入模型面 + 模型声明标准回传）。
4. ipc-contract 26 条既有违规清理（allowlist 重锚 + 6 个 handled-only 补 renderer 调用或登记）——独立维护项。
