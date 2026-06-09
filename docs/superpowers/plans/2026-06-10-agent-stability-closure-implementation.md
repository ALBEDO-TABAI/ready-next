---
title: Agent Stability Closure 实施子计划
date: 2026-06-10
status: approved v3 — Codex 共识达成（2026-06-10），enforce 生效
revision_history:
  - v1 (2026-06-10): 初稿。
  - v2 (2026-06-10): ①确认 scripted seam 已存在（AgentSdkRuntimeDeps.runAgent 可注入），
    新增共享测试 helper 工单交付物避免每测手写；②S1-2 落点精确化（reflection-service.ts）；
    ③S1-3 gate 范围澄清：S1-2 必须先迁移完全部终态写入方（含 task-projection-sync 的
    sibling-kill），后续工单对 agent-sdk-runtime.ts 的修改不涉终态直写，gate 是强制项而非障碍。
  - v3 (2026-06-10): 吸收 Codex 第 2 轮审查三阻塞项——①S1-1 补 run-close metric 写入
    （经 metrics.ts 既有入口，含 toolCallsUsed/durationMs，闭合 C0.2）；②新增 S4-5 工单
    跟踪 C4.2b（blocked on Plan P WP3+WP5 验收，不排期但有落点）；③AbortInitiator 落点
    改为 run-contracts-internal.ts（run-contracts.ts 禁新增 export）。
owner: 白
author: Claude (Fable 5)
executor: Codex
reviewer: Claude（终审）
enforce: true
note: >
  本文将已达成共识的路线（2026-06-10-agent-stability-closure-roadmap.md v2）
  拆为可执行工单。v3 已与 Codex 达成共识（路线 2 轮 + 计划 3 轮审查），enforce 生效，逐单施工。
  工单纪律：先合同测试（红）后实现（绿）；每单 ≤约 300 行 diff、10 分钟内可自验；
  不顺手重构、不碰无关文件；触碰 agent-sdk-runtime.ts 的工单全部串行。
pairs_with:
  - docs/superpowers/plans/2026-06-10-agent-stability-closure-roadmap.md
related:
  - docs/superpowers/plans/2026-06-09-agent-long-task-budget-resumability-implementation.md（Plan L）
  - docs/superpowers/plans/2026-06-09-browser-observation-probe-layer-implementation.md（Plan P）
---

# Agent Stability Closure 实施子计划

## 0. 总则

1. **轨道与串行约束**
   - 轨道 A（agent-control）：S0 → S1 → S2 → S4 → S5，内部按工单号串行。
   - 轨道 B（browser-engine）：S3，可与轨道 A 并行；与 Plan P 改动同文件时（`content-task-runner.ts`、`browser-collector-actions.ts`）由本计划工单先行，Plan P 后续 rebase。
   - 轨道 L（Plan L 收尾）：§L 工单归 Plan L 合同管辖，列于此仅为追踪；与 S1 并行。
2. **每单交付物**：失败测试 → 实现 → 焦点验证命令绿 → `npm run typecheck` 绿。涉及 SQLite 的工单跑 `npm run verify:native`。
3. **每单提交**：单独 commit，message 引用工单号（如 `feat(agent): S1-1 run finalize channel`）。
4. **新 gate 汇总**：末单 S6-1 新增 `verify:stability` 链（挂在当前链顶 `verify:t` 之后；若届时链顶已变，挂新链顶），收编本计划全部新 gate 与焦点测试。
5. **禁止事项**：不得为旧终止路径保留长期兼容分支（迁移完成即封路）；不得用 source-grep 测试替代行为断言（gate 脚本除外，gate 只做"结构性禁令"）；不得在 renderer 新增任何状态猜测。

---

## S0 阶段：取证卫生与终止可观测

### S0-1 日志测试环境隔离（C0.1）

- **改动文件**：`src/main/utils/rotating-logger.ts`、`src/main/utils/platform.ts`（日志路径解析处）、新增 `scripts/check-log-test-isolation.cjs` + `scripts/__tests__/check-log-test-isolation.test.cjs`、新增 `src/__tests__/rotating-logger-test-isolation.test.ts`
- **实施要点**：日志/metrics 路径解析时检测 `process.env.VITEST === 'true' || process.env.NODE_ENV === 'test' || process.env.READY_TEST_LOG_ISOLATION === '1'` → 切到 `<tmpdir>/ready-test-logs/`。生产路径零改动。gate 脚本断言 logger 模块存在该分支且测试文件未 mock 掉它。
- **测试（先红）**：`rotating-logger-test-isolation.test.ts`——在测试环境下创建 logger，断言写入路径前缀为 `ready-test-logs`，且向生产日志名路径写入为 0 字节增量。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/rotating-logger-test-isolation.test.ts && npm run typecheck`
- **完成判据**：跑 `npm run test` 后 `<tmpdir>/ready-{tools,agent-sdk,agent-metrics,directchat,browser}.log` 无新增行（人工抽查一次并在 PR 描述记录）。
- **规模**：~80 行。

### S0-2 run_meta 扩列：initiator 与 duration（C0.2 上半）

- **改动文件**：`src/main/modules/migrations.ts`（新迁移，沿用 049 幂等模式）、`src/main/modules/agent-control/task-projection/run-meta-repository.ts`、`src/main/modules/agent-control/contracts/run-contracts-internal.ts`（`AbortInitiator` 类型：`'user_stop'|'preempted'|'timeout'|'host_unavailable'|'budget'|'error'|'process_exit'`——注意 `run-contracts.ts` 文件头禁止新增 export，内部类型一律进 internal 文件）、新增 `src/__tests__/migration-run-meta-initiator.test.ts`
- **实施要点**：run_meta 增列 `initiator TEXT`、`duration_ms INTEGER`。repository 的 upsert/close 路径接受并落这两个字段。本单只扩列+repository，不改 runtime 调用方（S1-1 接线）。
- **测试（先红）**：迁移幂等（双跑不炸）；repository 写入后能读回 initiator/duration_ms。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/migration-run-meta-initiator.test.ts src/__tests__/run-meta-long-task-observability.test.ts && npm run verify:native && npm run typecheck`
- **规模**：~140 行。

### S0-3 Abort initiator 贯穿（C0.2 下半）

- **改动文件**：`src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts`（abort 包装，最小侵入：一个 `createInitiatorAbort(initiator)` 辅助 + 各 `abort()` 调用点带因）、新增 `src/__tests__/abort-initiator-threading.test.ts`
- **实施要点**：抢占、用户停止、超时三个现有 abort 点改为带 initiator；initiator 暂存于 run 句柄，供 S1-1 finalize 读取。不新增行为。
- **测试（先红）**：触发 stopGeneration / 抢占（用现有可注入点或最小 seam），断言 run 句柄上记录的 initiator 正确。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/abort-initiator-threading.test.ts && npm run typecheck`
- **规模**：~120 行。

---

## S1 阶段：Run 终止合同

### S1-1 建通道：`finalizeRunOutcome()`（C1.1 第一步）

- **改动文件**：新增 `src/main/modules/agent-control/runtime-core/run-finalizer.ts`、`agent-sdk-runtime.ts`（done 正常路径接入）、`run-meta-repository.ts`（终态写入仅暴露给 finalizer 的入口）、新增 `src/__tests__/helpers/scripted-agent-runner.ts`（**共享 scripted seam helper**：基于既有 `AgentSdkRuntimeDeps.runAgent` 注入点，支持多轮脚本 `[{text?, toolCalls?, failWith?}]` 与逐轮回调断言——后续所有 S 系工单测试复用，禁止每测手写 fake runner）、新增 `src/__tests__/run-finalizer-channel.test.ts`
- **实施要点**：`finalizeRunOutcome(outcome)` 入参：`{ runId, taskId, scopeId, kind: 'done'|'error'|'cancelled'|'preempted'|'checkpoint_budget'|'checkpoint_steered'|'interrupted', initiator, visibleClosure: { kind: 'message', messageId } | { kind: 'exempt', reason: 'preempted_by_same_user' }, terminalReason, budgetSnapshot? }`。原子序列：run_meta 终态（含 initiator/duration_ms）→ projection 终态 patch → 校验 visibleClosure（无消息且无豁免 → 在 finalize 内部补发兜底收口消息，并打 `closure_fallback` metric——失败要响亮，不允许静默通过）→ **写 run-close metric**（经 `src/main/modules/agent-control/metrics.ts` 既有入口，记录 `{runId, terminalReason, initiator, toolCallsUsed, durationMs}`，闭合 roadmap C0.2 的 metrics 侧承诺）。**写顺序约束**：checkpoint 类 outcome 必须在调用 finalize 前已完成 continuation state 落盘（对齐 Plan L WP3；finalize 内部断言 handle 已存在，否则拒绝该 outcome 并降级为 error 收口）。本单只迁移 done 路径。
- **测试（先红）**：scripted seam（Plan L WP0 的模型 seam）跑一个正常 run → run_meta 终态非 `working`、有 initiator/duration；run-close metric 行存在且含 toolCallsUsed/durationMs；人为构造"无消息 + 无豁免" → 断言兜底消息 + `closure_fallback` metric。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/run-finalizer-channel.test.ts && npm run typecheck`
- **规模**：~280 行。

### S1-2 迁移其余退出路径 + kill/preempt 可见收口（C1.1 第二步 + C1.4）

- **改动文件**：`agent-sdk-runtime.ts`（error/cancel/抢占/进程关闭路径）、`src/main/modules/claude-bridge/direct-chat.ts`（抢占点）、`src/main/modules/agent-control/task-projection/task-projection-sync.ts`（sibling-kill 路径产出收口 patch——**本单必须迁移完该文件全部终态 patch 构造**，这是 S1-3 gate 的前置）、`src/main/modules/agent-control/reflection-service.ts`（:222 附近"Completed task using N tools"——零工具 run 不写成功记忆）、新增 `src/__tests__/run-finalizer-all-paths.test.ts`
- **实施要点**：全部退出路径改走 finalizer。抢占豁免类登记 `preempted_by_same_user`；用户主动停止产出"已手动停止，进度已保存至…"收口消息；sibling-kill 产出"已被新消息接管"胶囊。记忆捕获守卫：`toolTrace.length===0 && kind!=='done_conversational'` 的 run 不得写 "Completed task" 类记忆。
- **测试（先红）**：五条路径各一用例：done/error/user_stop/preempt/sibling-kill → 全部断言 run_meta 终态 + projection 终态 + 收口消息或豁免；零工具 run → 断言记忆捕获未写成功条目。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/run-finalizer-all-paths.test.ts && npm run typecheck`
- **规模**：~300 行。

### S1-3 封旧路 gate（C1.1 第三步）

- **改动文件**：新增 `scripts/check-run-finalize-funnel.cjs` + `scripts/__tests__/check-run-finalize-funnel.test.cjs`
- **实施要点**：仿 `check-ledger-writer-funnel.cjs`——run_meta 终态写入方法与 projection 终态 patch 构造只允许出现在 `run-finalizer.ts`（及其测试）中；其余出现即 fail。**前置**：S1-2 已迁移完全部既有写入方（含 task-projection-sync sibling-kill）。**与后续工单的关系澄清**：S1-4/S2-2/S4-2/S5-x 会继续修改 `agent-sdk-runtime.ts`，但均不直写终态（S1-4 改的是 finalizer 自身的前置检查；S2-2 是提醒注入；S5-x 经 finalizer 收口）——gate 对它们是强制保护而非顺序障碍，无需把 gate 后移。若某后续工单确需新增终态出口，修改 `run-finalizer.ts` 本身并扩展该 gate 的用例，而不是绕过。
- **验证**：`node scripts/check-run-finalize-funnel.cjs && node --test scripts/__tests__/check-run-finalize-funnel.test.cjs`
- **规模**：~120 行。

### S1-4 行动宣告守卫（C1.2）

- **改动文件**：`run-finalizer.ts`（done 前置检查）、新增 `src/main/modules/agent-control/system-reminders/action-announcement-steer-reminder.ts`（经 `SystemReminderRegistry` 注册）、`agent-sdk-runtime.ts`（一次有界续轮）、新增 `src/__tests__/action-announcement-guard.test.ts`
- **实施要点**：三条件判据（见 roadmap C1.2，注意不是空输出判据）：(a) 末段助手文本以行动宣告句式收尾（正则集中在守卫模块，含"让我|我现在|我马上|接下来|现在去|I'll now|let me"+句尾冒号形态）；(b) 末段零工具调用；(c) TurnFrame 存在未完成任务指涉。命中 → 注入 steer 提醒并允许一次续轮；二次命中 → 转 `checkpoint_steered` outcome（复用 Plan L checkpoint writer 写 durable handle）+ honest 收口消息（"我准备执行 X 但未能启动，已保存断点，回复'继续'可恢复"）。守卫每 run 至多触发一次（防循环）。
- **测试（先红）**：scripted seam：模型只输出"让我先打开这篇笔记："→ 断言一次 steer 续轮；续轮仍零工具 → 断言 checkpoint_steered + 收口消息 + handle 可过 `canResumeShape()`；正常对话回答（无任务指涉）→ 断言不触发。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/action-announcement-guard.test.ts && npm run typecheck`
- **规模**：~280 行。

### S1-5 启动 reconcile 泛化（C1.3）

- **改动文件**：新增 `src/main/modules/app-control/startup-run-reconciler.ts`、`src/main/index.ts`（启动调用点）、`content-task-runner.ts`（吸收 note_collect 特判入统一入口）、复用 `skill-task-run-repository.reconcileRunningRowsOnStartup()`、新增 `src/__tests__/startup-run-reconciler.test.ts`
- **实施要点**：单一启动入口顺序处理：run_meta `working`→`interrupted(initiator=process_exit, terminalReason=main_process_restarted)`；task_projections 活跃行→按 `canResumeShape(continuationRef)` 分流 `recoverable_paused` / `interrupted`；browser_tasks `running`→有有效 checkpoint 则 `paused` 否则 `cancelled(restart)`。三类各出 reconcile 计数 metric。**不重复造轮子**：skill 行复用 Plan L WP8 已落的 reconcile，仅由统一入口调度。
- **测试（先红）**：临时 SQLite 种入三类 stale 行 → 跑 reconciler → 断言终态与 metric 计数。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/startup-run-reconciler.test.ts && npm run verify:native && npm run typecheck`
- **规模**：~280 行。

---

## S2 阶段：后台任务事件桥

### S2-1 事件桥发布侧（C2.1）

- **改动文件**：新增 `src/main/modules/browser-engine/task-event-bridge.ts`、`content-task-runner.ts`（终态/阻塞迁移统一经桥发布；scheduleTask 无注册路由时运行时断言）、`task-persistence-service.ts`（终态写入点挂桥）、新增 `src/__tests__/task-event-bridge.test.ts`
- **实施要点**：桥 = 进程内单例，双消费者注册：既有 projection sink（搬迁现有调用，不改行为）+ `agentNotifier`（S2-2 实现，先注册空实现）。消费侧按 `taskId+终态` 幂等去重。发布点覆盖：completed/failed/paused/needs_attention/waiting_human。
- **测试（先红）**：任务终态 → 两个消费者各收到一次；重复发布 → 去重；未注册路由的 scheduleTask → 断言抛出。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/task-event-bridge.test.ts && npm run typecheck`
- **规模**：~220 行。

### S2-2 活跃 run 内提醒注入（C2.2 上半）

- **改动文件**：新增 `src/main/modules/agent-control/system-reminders/background-task-terminal-reminder.ts`、`agent-sdk-runtime.ts`（scope 活跃 run 查询 + 下一模型调用前消费 pending 提醒）、新增 `src/__tests__/background-task-reminder-injection.test.ts`
- **实施要点**：agentNotifier 实现之一：scope 有活跃 run → 把任务终态摘要（含 S2-4 的失败明细）写入该 scope 的 pending reminder 队列；SDK 循环在每次模型调用前 drain 队列经 `SystemReminderRegistry` 组装注入。
- **测试（先红）**：scripted run 进行中 → 桥发布任务完成 → 断言下一轮模型输入含终态提醒文本。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/background-task-reminder-injection.test.ts && npm run typecheck`
- **规模**：~200 行。

### S2-3 无活跃 run：pending 事件 + 有界自动播报续跑（C2.2 下半）

- **改动文件**：`src/main/modules/migrations.ts`（新表 `pending_task_events`）、`src/main/modules/agent-control/runtime-core/runtime.ts`（自动续跑入口）、`src/main/modules/agent-control/domain-adapters/run-capability-controller.ts`（`narration` 能力档：禁浏览器 resume/写分类工具/高风控动作）、新增 `src/__tests__/auto-narration-continuation.test.ts`
- **实施要点**：scope 无活跃 run → 落 `pending_task_events` 行 → 触发 `taskType=continuation` 的播报续跑（走 Plan L WP3 续跑机制 + 单飞守卫）。**硬权限边界**（roadmap C2.2）：续跑 run 的能力解析强制 narration 档，由 `resolveRunCapabilities` 单点裁决（不在上游加挡板）；执行类动作只生成建议文本。播报完成后 pending 行标记 consumed。若续跑自身失败 → pending 行保留 + projection 红点，不静默。
- **测试（先红）**：无活跃 run 时任务完成 → 自动出现一条播报消息且 run 能力为 narration 档（断言浏览器写工具不在暴露面）；并发两次触发 → 单飞只跑一个；续跑失败 → pending 保留。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/auto-narration-continuation.test.ts && npm run verify:native && npm run typecheck`
- **规模**：~300 行。

### S2-4 设置开关 + 失败明细 payload + waiting_human 回路（C2.2 开关 + C2.3 + C2.4）

- **改动文件**：`src/main/modules/settings-engine/*`（键 `agent.autoNarrationContinuation`，默认 true）、`src/preload/index.ts`、renderer 类型声明、`src/renderer/pages/Settings.tsx`（开关项）、`src/main/modules/tools/browser-tools.ts`（`browser_get_task` payload 增 `failedItems[{url,reason,attempts,retryable}]` 与 `suggestedNextAction`）、`content-task-runner.ts`（waiting_human 的用户确认经桥回原任务）、新增 `src/__tests__/auto-narration-setting-and-payload.test.ts`
- **实施要点**：跨进程功能最小闭环七件套齐全（IPC/preload/类型/UI/测试/文档）。waiting_human：用户在会话说"好了/已验证"（S4-1 分类为 continue_task）→ 经桥对原 browser-task 调 resume（对齐既有 L2 规则与 Plan L WP6.6 显式 continue）。
- **测试（先红）**：开关 off → 仅 pending+红点不续跑；payload 含明细且 retryable 标注正确；waiting_human 确认后任务恢复。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/auto-narration-setting-and-payload.test.ts && npm run typecheck`
- **规模**：~280 行（如超限，把 Settings UI 拆为 S2-4b）。

---

## S3 阶段：采集终态判定矩阵（轨道 B，可与 S1/S2 并行）

> 定位：**Plan L WP6 的扩展而非替代**。WP6 已落的 partial-resume 语义与 `browser-collection-partial-resume.test.ts` 既有断言保持不变；S3 在其上补判定条款。

### S3-1 判定矩阵单源化（C3.1/C3.2 骨架）

- **改动文件**：新增 `src/main/modules/browser-engine/collection-verdict.ts`（纯函数 `resolveCollectionVerdict()`）、`content-task-runner.ts`（visible_collect 与 note_collect 终态判定改为消费该函数）、新增 `src/__tests__/collection-verdict-matrix.test.ts`
- **实施要点**：真值表（输入：collected/expected/stopReason/failures/cursor 有效性；输出：终态+是否保留断点+用户解释文案 key）：
  - `collected=0` → `needs_attention`（永不 `completed`），附诊断槽位（S3-2 填充）。
  - `0<collected<expected` 且 cursor 有效 → `recoverable_paused`（保留 cursor/partialResults——**修正现状 failed 即清空的行为**）。
  - 余项不可推进（终态跳过原因）→ terminal partial success（解释性 completed_partial）。
  - `collected≥expected`（或 expected 未知且 stopReason 自然完结）→ `completed`。
  - 真值表测试穷举上述象限 + 06-06 实例回放（62/69+7 失败 → recoverable_paused 且断点保留）。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/collection-verdict-matrix.test.ts src/__tests__/browser-collection-partial-resume.test.ts && npm run typecheck`（后者必须保持绿——证明"扩展非替代"）
- **规模**：~280 行。

### S3-2 0 项诊断 + no_new_content 滚动升级探测（C3.1 诊断 + C3.3）

- **改动文件**：`content-task-runner.ts`（emptyRounds 停止前的升级探测）、`agent-browser-collect.ts`（探测辅助）、`page-state-service.ts`（空态原因探针：登录墙/空列表/选择器失配/加载中——与 Plan P 的统一 capturePageState 协调：只消费现有探针接口，不抢跑 Plan P 的重构）、测试并入 `collection-verdict-matrix.test.ts` 增补用例
- **实施要点**：`no_new_content` 将停时执行一次有界升级探测（滚动步长 ×2 + 等待加载指示消失，时限 5s）；探测后仍无新内容才允许停。`expected` 已知且 `frozenCount<expected` 时 discoveryStatus 不得为 `complete`（带 `partial` + 续采句柄）。0 项终态附页面诊断（probe 结果枚举）。
- **测试（先红）**：fake 页面序列：滚动两轮无新（但升级探测出新）→ 继续采；升级仍无新 → 停且 0 项时为 needs_attention+诊断。
- **验证**：同 S3-1 命令。
- **规模**：~240 行。

### S3-3 单项失败账本与重试（C3.4）

- **改动文件**：`src/main/modules/browser-engine/agent-collection-plan.ts`（failures 带 attempts/retryable；末轮重试游标）、`browser-collector-engine.ts`（末轮 retry pass）、`content-task-runner.ts`（整任务重试消费失败账本：只重试失败项）、新增 `src/__tests__/collection-item-retry.test.ts`
- **实施要点**：单项失败分类 retryable（超时/导航失败/临时风控）vs 非（已删除/权限/终态跳过）；retryable 末轮重试 ≤2 次/项；重试仍败记终态原因。`browser_resume_task` 对含失败账本的任务 → 只跑失败项。
- **测试（先红）**：5 项中 2 项首轮失败（retryable）→ 末轮重试后 1 项成功 → 终态 4/5 recoverable，失败账本含 attempts=3 的 1 项；重试整任务 → 只执行失败项。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/collection-item-retry.test.ts && npm run typecheck`
- **规模**：~280 行。

### S3-4 轮播多图采集（C3.5）

- **改动文件**：`src/main/modules/browser-engine/browser-collector-actions.ts`（collectCardNote 轮播检测 + 逐帧采集，受 max_images 约束）、新增 `src/__tests__/carousel-image-collection.test.ts`
- **实施要点**：检测轮播指示器（swiper dots / 翻页按钮 / `aria-roledescription=carousel` 等选择器集中常量化）；逐帧切换-等待-采集；每帧媒体 URL 去重合并；高风控平台帧间延时沿用现有 pacing 策略。
- **测试（先红）**：fake 页面 10 帧轮播 → 采集 10 图；非轮播页 → 行为不变；max_images=4 → 截断为 4。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/carousel-image-collection.test.ts && npm run typecheck`
- **规模**：~240 行。

---

## S4 阶段：跟进意图与计划持久化

### S4-1 跟进意图四分类器（C4.1）

- **改动文件**：新增 `src/shared/agent-followup-intent.ts`、`agent-sdk-runtime.ts`（替换 `isBareContinuationInstruction` 调用点）、`src/shared/browser-collection-intent.ts`（旧函数标记废弃并由新分类器内部复用其词表）、新增 `src/__tests__/agent-followup-intent.test.ts`
- **实施要点**：`classifyFollowupIntent(text, ctx) → { kind: 'new_task'|'continue_task'|'status_query'|'correction', confidence, negations }`。启发式快路径（词表+句式+否定词扫描："不要|别|先不|不用"压制对应意图）；`confidence<阈值` 且 ctx 有未完成任务 → 模型判断题兜底（注入式 judge 接口，生产实现走现有 LLM 通道，测试用 fake）。**路由仍在代码**：分类结果→能力暴露/任务指涉映射为纯代码查表。
- **测试（先红）**：真值表 ≥20 例："继续/接着弄/怎么样了/还在跑吗/不要采集了，先看看/重新来/第一篇少了图（correction）/帮我查天气（new_task）"等；否定词用例必含"不要采集"不得触发 collection。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/agent-followup-intent.test.ts && npm run typecheck`
- **规模**：~280 行。

### S4-2 status_query 路由与能力暴露保持（C4.4）

- **改动文件**：`agent-sdk-runtime.ts`（status_query 分支：读 projection/事件桥生成状态播报，不重启任务）、collection exposure 判定改为消费 S4-1 分类（替换正则白名单路径）、新增 `src/__tests__/status-query-routing.test.ts`
- **实施要点**：status_query → 走 narration 档播报（复用 S2-3 能力档）；continue_task → 维持上轮能力暴露与任务指涉（TurnFrame 读取，不再每轮正则重猜）。
- **测试（先红）**："怎么样了" → 状态播报且不新建 browser task；"继续" → 原任务恢复且浏览器工具暴露保持（复演 99f c8 修过的场景，防回归）。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/status-query-routing.test.ts && npm run typecheck`
- **规模**：~220 行。

### S4-3 计划持久化与回注（C4.2a）

- **改动文件**：`src/main/modules/agent-control/domain-adapters/browser-task-planner.ts`（plan 序列化）、`src/main/modules/agent-control/runtime-core/turn-frame.ts`（frame-state 计划槽位，经既有 framePatch 通道写入）、`task-projection-sync.ts`（steps_json 落列）、新增 `src/main/modules/agent-control/system-reminders/active-plan-step-reminder.ts`、新增 `src/__tests__/plan-persistence-reinjection.test.ts`
- **实施要点**：计划写入走 TurnFrame 既有 patch 通道（红线：frame 单源，两条写通道之一）；每轮回注"当前步骤 + 完成判据 + verify=weak 标注"；步骤推进暂以"该步骤声明的工具结果存在"为弱判据（C4.2b 等 Plan P WP3+WP5 验收后另行开单，本计划不含）。
- **测试（先红）**：多步计划 run 第 1 轮生成 → 第 2 轮（新 turn）模型输入含当前步骤提醒；steps_json 非空且与 frame 一致；弱判据推进一步后提醒更新。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/plan-persistence-reinjection.test.ts && npm run typecheck`
- **规模**：~290 行。

### S4-4 记忆注入限域（C4.3）

- **改动文件**：`src/main/modules/agent-control/session/session-recall-service.ts` 或 L1 组装处（按现源码定位）、`prompt-assembly.ts`、新增 `src/__tests__/memory-injection-scoping.test.ts`
- **实施要点**：当天记忆注入按 scope/任务谱系过滤；硬性合同：**其他任务的 checkpoint 祈使文本（"请继续这项任务"类）不得出现在当前 scope 的模型输入**。保留跨任务的事实型摘要（不带祈使）。
- **测试（先红）**：构造含两个 scope 的当天记忆 → 当前 scope 模型输入不含另一 scope 的祈使行，仍含本 scope 摘要。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/memory-injection-scoping.test.ts && npm run typecheck`
- **规模**：~160 行。

### S4-5 证据化步骤完成判定（C4.2b）——**blocked，不排期**

- **前置条件**：Plan P WP3+WP5 验收通过（roadmap §5 依赖边）。在此之前本单不得开工、不计入任何阶段门。
- **改动文件**（预估）：S4-3 的 plan-step 推进判据处、Plan P 的动作后复查证据接口（以 Plan P 落地后的实际合同为准）
- **实施要点**：把 S4-3 的 `verify=weak`（工具结果存在性）升级为消费 Plan P 页面证据的强判据；移除 weak 标注。开工前需对照 Plan P 实际接口重写本单细节并经一次轻量复审。
- **登记目的**：保证 roadmap 合同条款 C4.2b 有可追踪落点，不因"暂缓"而脱离合同闭环。

---

## S5 阶段：会话快照与 provider 重试

### S5-1 scope 会话快照与懒恢复（C5.1）

- **改动文件**：`agent-sdk-runtime.ts`（finalize 时快照）、`src/main/modules/agent-control/session/session-continuity.ts`（存取，复用 Plan L state-directory 模式与 `normalizeSessionSnapshotForSeed()`）、新增 `src/__tests__/session-snapshot-lazy-restore.test.ts`
- **实施要点**：run 正常收口时落 scope 级会话快照（压缩后）；重启后该 scope 首条消息：快照存在且 schema 校验通过 → 懒恢复 + 注入"已恢复上次会话上下文"提醒；校验失败 → 显式"会话已重置"消息。快照随 scope 删除清理。
- **测试（先红）**：run 收口 → 快照存在且无悬空 tool-use；模拟重启（新 runtime 实例）→ 首条消息后模型输入含恢复的上下文 + 恢复提醒；损坏快照 → 重置消息。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/session-snapshot-lazy-restore.test.ts && npm run typecheck`
- **规模**：~280 行。

### S5-2 SDK 主循环 provider 分类重试（C5.2）

- **改动文件**：`agent-sdk-runtime.ts`（模型调用点接 `error-classifier`/`recovery-router` 策略）、新增 `src/__tests__/sdk-loop-provider-retry.test.ts`
- **实施要点**：429/5xx/流中断按既有分类器策略有界重试（与 tool-runtime 同一策略源，禁止第二套配置）；重试耗尽 → 经 finalizer 以 `blocked_external` 收口（可继续）。流中断识别补充 SSE 截断形态。
- **测试（先红）**：scripted provider 先 429×2 后成功 → run 存活且只重试 2 次；持续 5xx → finalize 为 blocked_external 且有收口消息。
- **验证**：`npx tsx@^4.19.2 --test src/__tests__/sdk-loop-provider-retry.test.ts && npm run typecheck`
- **规模**：~220 行。

---

## L 收尾轨（归 Plan L 合同管辖，此处仅登记追踪）

- **L-f1 续跑预算累加**：`rebindTaskBudgetRuntime`/`resumeBudgetRuntime` 恢复 checkpoint 中 usage 并累加（对齐 Plan L I1"同一账本"），禁止续跑重置。测试：耗尽→续跑→剩余预算 = 上限 −已用。
- **L-f2 续跑单飞补全**：补齐 budgetCheckpointFlights 的定义与生命周期；并发"继续"测试收敛为一个 run。
- **L-f3 70/90% 转向注入落地**（WP2.9 若仍未实现）：warning 阈值后下一模型调用前注入 converge-or-ask 转向；测试断言注入时机在干净工具批次后。
- **L-f4 taskType 单源**：run 准入时一次解析，run_meta 与 projection budget_json 同源写入；测试断言两账本一致（修复实测 research/60 vs short_task/24 矛盾）。
- **L-f5 滚动 checkpoint**：每 N 个干净工具批次更新 run_state.json（N=4 起步），耗尽时仅做最终化；测试断言中途 kill 后 checkpoint 不超过 N 批次落后。

---

## S6 阶段：收口

### S6-1 `verify:stability` 链 + 文档同步

- **改动文件**：`package.json`（`verify:stability` 收编本计划全部 gate+焦点测试，挂当前链顶之后）、`CLAUDE.md`/`AGENTS.md`（硬约束增补：run 终止合同、事件桥、判定矩阵单源；两份同步改）、`DOCUMENTATION.md`/`CHANGELOG.md`
- **验证**：`npm run verify:stability` 全绿。

### S6-2 场景级 E2E + dogfood 证据

- **改动文件**：新增 `src/__tests__/e2e/agent-stability-scenarios.e2e.ts`（scripted seam 驱动 roadmap §6 三场景）
- **实施要点**：Henry.L 场景（无声 run 消失/宣告守卫/轮播 10 图/自动播报）、研究预算场景（转向→受控 checkpoint→续跑累加）、重启场景（reconcile + 懒恢复）。E2E 绿后做一次真实 dogfood 并在 PR 记录证据（复用 stage-y dogfood evidence 模式）。
- **验证**：`npm run verify:f:e2e && npm run verify:stability && npm run verify:native && npm run test && npm run typecheck`

---

## 验收与回退

- **阶段门**：每阶段末（S0-3/S1-5/S2-4/S3-4/S4-4/S5-2）跑 `npm run typecheck && npm run test` 全量；涉 SQLite 阶段加 `verify:native`。
- **回退**：每单独立 commit，阶段内可整段 revert；S1-3 gate 封路后如需回退 S1，先 revert gate 再 revert 实现（避免 CI 卡死）。
- **冲突纪律**：`agent-sdk-runtime.ts` 工单串行序：S0-3 → S1-1 → S1-2 → S1-4 → S2-2 → S4-2 → S5-1 → S5-2；`content-task-runner.ts` 串行序：S2-1 → S3-1 → S3-2 → S3-3（S1-5 仅调用入口，插在 S2-1 前）。
- **与 Plan P 协调**：S3-2 消费现有 page-state 探针接口；若 Plan P 统一 capturePageState 先落地，S3-2 改读新合同（工单开工前确认一次）。
