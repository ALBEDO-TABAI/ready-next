---
title: EP2-K6 真值源边界落地子合同（K6C 评审版）
date: 2026-06-12
status: approved — Codex 波次 0+1 审查通过（2026-06-12，"达到可施工标准"），K6 解锁可开工
owner: 白
author: Claude (Fable 5)
reviewer: Codex
enforce: true
note: >
  评审通过后本文件 status 改 approved、enforce 改 true，K6 按本合同施工。
  上位合同：docs/superpowers/plans/2026-06-11-agent-evolution-phase2-implementation.md（EP2-K6C/EP2-K6）。
  设计出处：docs/agent-evolution/01-分层知识系统设计明细.md §7（真值源迁移边界，须单独立合同）。
pairs_with:
  - docs/superpowers/plans/2026-06-11-agent-evolution-phase2-implementation.md
---

# EP2-K6 真值源边界落地子合同

## 0. 范围与非目标（01 §7.1 硬边界）

- **"文件赢"仅适用于 belief 卡（`knowledge/*.md`、`knowledge/sites/*.md`）与 RULES.md**。
- **非目标（零改动断言）**：SOUL（人设）、`user_profiles`、触发规则维持 DB 优先现状；现有 L0/L1/L2 记忆管理 UI 不动；`loadSOUL`/`loadUSER` 双轨逻辑不动。
- HEAD 基建取证（2026-06-12）：`BeliefCardStore`（状态枚举 staged/active/rejected/invalid，路径守卫 `isAllowedCardPath`）、`belief-card-mirror.ts`（`hashCardContent` sha256、`upsertBeliefCardMirror`、`syncBeliefCards(db, store) → { synced, invalid }`）均已合入（阶段一 K1/K2）；**`syncBeliefCards` 尚无启动接线**（K2 显式移交项，本单兑现）；`knowledge_system_enabled` 全仓零引用（本单新增）。

## 1. 同步模型（file → DB 单向，三个同步点）

| 同步点 | 触发 | 范围 | HEAD 现状 |
|---|---|---|---|
| S1 写入时 | `memory_write_card` 落盘后同步 upsert mirror 行 | 单卡 | 已有（K2） |
| S2 watcher | 用户手改卡片文件 → 增量同步 | 变更文件 | 本单新增 |
| S3 启动/维护 | main 启动接线 `syncBeliefCards` 全量校验；维护任务（C2 调度）每轮全量重建 | 全量 | 本单接线启动；维护轮归 C 轨 |

合同条款：

1. **方向永远 file → DB**；DB 行 `content_hash` 与文件重算不一致时以文件为准重写 mirror 行。任何 DB → file 写路径都是违规（结构断言：knowledge 模块内不得出现写 `knowledge/*.md` 的路径，唯一例外是 `BeliefCardStore` 自身的原子写入口）。
2. **watcher 复用 document-engine additive listener 范式**（`document-engine/ipc/watch-group.ts:180` 取证）：`fs.watch(knowledgeDir, { persistent: false })` + `pendingPaths: Set<string>` 去重 + 可注入防抖延迟（默认 140ms，测试注入 0）。watcher 回调只入队不直接同步；防抖批量执行增量 `syncBeliefCards` 范围内的单文件 upsert。
3. **幂等**：同一文件连续 N 次变更 → mirror 仅一行、`content_hash` 等于末次内容哈希；内容未变的重扫 → 零 DB 写（以 `content_hash` 比对短路）。
4. **竞态**：手改与 agent 写入竞态由文件系统层 mtime 后写赢（单文件原子写无半态，K1 已保证）；watcher 不做合并。

## 2. 坏卡 invalid 链路

1. frontmatter 解析失败（S1/S2/S3 任一同步点发现）→ mirror 行 `status='invalid'`，**不删文件、不删行**；审计行记 `belief_card_invalid`（slug + 原因）。
2. invalid 卡**不进任何注入面**（K3 的 index 渲染只读 active；本单加行为断言：invalid 卡在 index/RULES 注入文本中零出现）。
3. 用户修复文件 → 下一次同步解析成功 → 状态回归 frontmatter 声明值（staged/active/rejected），审计行记 `belief_card_recovered`。
4. 记忆面板"知识卡"页签显示 invalid 行为"格式损坏待修复"（UI 改造按 01 §7.4 边界：仅新增页签，现有 UI 不动；若 UI 页签未在本单排期，则 main 侧字段先就位、UI 推后并在 08 表挂账——不阻塞合同其余条款）。

## 3. 回滚开关 `knowledge_system_enabled`

1. settings 表布尔惯例由 knowledge 模块自身封装（`getSetting(key) !== 'false'`，默认开）。键名 `agent.knowledgeSystemEnabled`。旧自动播报设置范式已退役，不是可复用入口。
2. **关闭语义**：停止 index/RULES 注入（prompt-assembly 检查开关）+ `memory_read_card`/`memory_write_card` 工具不暴露 + watcher 停止 + 启动同步跳过。**文件零触碰**——回滚无损。
3. **重新打开**：下一次启动/下一轮注入恢复，无需迁移。
4. 开关读取点必须收敛在 knowledge 模块单一入口函数（防散落判断漂移）。

## 4. 启动接线（K2 移交项兑现）

1. main 进程启动序列加 `syncBeliefCards` 调用（在 DB ready 之后、首个 agent run 之前；放 ipc-handler/模块 init 的现有 boot 路径，不另起启动阶段）。
2. **对存量库零破坏**：启动同步只 upsert/标 invalid，不删除任何 `agent_memory_metadata` 行；对不存在对应文件的 mirror 行不动（孤儿 mirror 行归维护任务 C1 标记，不在本单删除）。
3. 启动同步失败响亮：log + metric，不阻塞启动主流程（与 J 合同日志生命周期一致）。
4. electron 导入纪律：模块若被 host-node 测试链可达，用 createRequire 惰性模式（X3/B3 踩坑记录）。

## 5. k/v 存量导出（一次性迁移脚本）

1. `scripts/export-agent-knowledge-to-cards.cjs`：读 `agent_knowledge` 表（migration 001 schema：agent_name/key/value）→ 每行生成一张 `status: staged` 卡片文件（slug 规则 `kv-<agent_name>-<key>` 规范化；正文含原 value + 来源注记）。
2. **不删源行**——迁移期共存；staged 状态保证导出卡不进注入面，人工过目采纳后才晋升 active（01 §7.6）。
3. 幂等：重跑脚本对已存在的同 slug 卡跳过（不覆盖人工已编辑内容）。
4. 脚本只在用户显式运行时执行，不进启动路径。

## 6. 与 memory-lifecycle 的边界

1. L1（30 天）/L2（90 天 + minAccessCount）时间归档路径（`memory-lifecycle.ts:119/140`）**不得归档 `category='belief'` 的 mirror 行**——belief 衰减由 C6 的 access_count/was_useful 驱动升降档接管（与时间衰减并存一个版本的开关语义归 C6，本单只立排除断言）。
2. mirror 行删除唯一合法来源：用户在 UI 删除卡片文件后的同步（文件没了 → 行走维护任务 C1 的孤儿标记流程，仍不直删）。

## 7. 验收断言（机器可验证，先红测试 → 实现）

新增 `src/__tests__/knowledge-truth-source-boundary.test.ts`（fake DB + 临时目录 + 注入防抖 0）：

| # | 断言 | 对应条款 |
|---|---|---|
| A1 | 手改卡片文件 → watcher 同步后 mirror 行 content_hash=文件重算值；连改两次仅一行 | §1.2/1.3 |
| A2 | 内容未变触发 watcher → 零 DB 写（spy upsert 不被调） | §1.3 |
| A3 | frontmatter 损坏 → status=invalid + 文件保留 + 审计行；修复 → 状态回归 + 审计行 | §2.1/2.3 |
| A4 | invalid 卡不出现于 index 注入文本（行为断言，复用 K3 注入入口） | §2.2 |
| A5 | 开关关闭 → 注入文本无 knowledge 段 + 工具不暴露 + watcher 不启动；文件 mtime/内容不变；重开恢复 | §3.2/3.3 |
| A6 | 启动同步对预置存量 mirror 行零删除；新文件 upsert、坏文件标 invalid | §4.2 |
| A7 | 导出脚本：k/v 两行 → 两张 staged 卡；重跑跳过已存在 slug；源表行数不变 | §5 |
| A8 | L1/L2 归档对 category='belief' 行零触碰（fake 时钟拨 91 天） | §6.1 |

验证命令：`npx tsx@^4.19.2 --test src/__tests__/knowledge-truth-source-boundary.test.ts && npm run verify:native && npm run typecheck`

## 8. 规模与回滚

- 预计 ~260 行 diff（含测试；脚本另计 ~60 行）。超 300 行则拆"watcher+invalid"与"开关+接线+导出"两单。
- 回滚 = 关 `agent.knowledgeSystemEnabled`（运行时无损）或 revert 单 commit（文件真值源不受影响——文件从未被本单写过）。
