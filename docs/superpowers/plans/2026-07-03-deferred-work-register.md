---
title: 暂缓工作登记（P1-b / P2-2 前置 / P2-6 decay）—— 有意暂缓，精确修法已定
date: 2026-07-03
status: register
enforce: false
note: >
  这三项在 2026-07-03 夜间自主推进中被有意暂缓（renderer/中枢/删除类高危，
  无人值守不宜动），非遗漏。根因均已确认、修法已定，留待可监控会话按此实施。
---

# D1 — 标签不显示（P1-b）

**现象**：agent 新建的浏览器标签不进标签条，要切换/新建才出现。

**根因（已用探针 + 代码确认）**：
- 可见性本身正常（`scripts/probe-agent-tab-visibility.cjs` 证：离屏/detached WebContentsView 仍 `visibilityState=visible`，渲染/采集不受影响）。这是纯 UI 呈现问题。
- `browser:tabOpened` 事件**只在 popup 路径发**：`src/main/modules/browser-engine/ipc-handler.ts:653`。
- 通用 `tab-lifecycle-service.ts` 的 `createTab`（`ensureAgentTab` 建 agent tab 走这条）**从不发 tabOpened**。
- renderer 侧用户自建 tab 走 `openWebpageInBrowser.ts:34` 客户端直接更新 store；agent/main 建的 tab 无 renderer 通知 → 不进标签条，直到 `switchTab` 触发 getTabList 刷新。

**修法（已定，未实施）**：
1. `tab-lifecycle-service.createTab` 建 agent/background tab 后发 `browser:tabOpened`，payload 带 `activate:false`（新增字段）。
2. renderer `useBrowserRuntimeEffects.ts:275`（现无条件 `setActiveTabId`）在 `activate===false` 时只 `addTab/updateTab`，**不抢占 active**。

**为何暂缓**：含"不抢焦点"门控，做错会变成更糟的抢焦点回归；renderer 焦点行为 headless 无法验证，需真机。无人值守不宜动浏览器 UI 焦点。

**验证方式**：真机建 agent tab → 应立即出现在标签条且不抢当前 active tab。

---

# D2 — criteria 前置注入模型面（P2-2 剩余半）

**已完成的半**：criteria 落库——finalizer 已把解析后的验收 criteria（items + satisfied/total）写入 projection（`run-finalizer.ts` 的 terminal `store.update`）。数据侧就绪，daily-task-index criteriaProgress 有数据源。

**未完成的半**：把 criteria 注入模型可见面，让 agent **事中自检**（"裁决从事后打回变事中自检"）。

**根因/障碍（已确认）**：
- criteria 依赖 `taskType`（`resolveCriteria(taskType, module)`，`criteria-templates.ts:108`）。
- `prompt-assembly.ts` **无 taskType**（grep 确认无匹配）——不能直接在系统提示里加 criteria 段。
- live-path reminder 是散点 steer（`agent-sdk-turn-orchestrator.ts` 里 `createSystemReminderRegistry()` 按事件临时建），**无单一 per-turn 注入点**。
- taskType 在 live path 可得：`agent-sdk-turn-orchestrator.ts:1211` `liveTaskBudgetRuntime?.taskType`。

**修法（两选一，未实施）**：
- A) 把 `taskType/module` 穿到 `prompt-assembly` deps，加一个"本轮完成标准（自检）"段，渲染 `resolveCriteria(taskType, module).items` 的 `text`。
- B) 在 turn-orchestrator 首轮注册一个 `criteria-self-check` reminder（新 `ReminderTopic`），文本由 `resolveCriteria` 渲染。
- criteria `text` 已是模型可读中文散文（如"至少一个产物或状态变更 proof"），适合直接注入；注意部分含内部术语（如"assistant_response digest"），注入前可只取括号前主句。

**为何暂缓**：两条路都改中枢文件（prompt-assembly / turn-orchestrator），无人值守高危。

**验证方式**：多步任务运行时，模型上下文应出现本轮验收标准；agent 宣告 done 前自检是否满足。

---

# D3 — belief-decay 生产接线（P2-6 剩余半）

> **2026-07-03 已完成**（P5d 确定性迁移）：decay 轮已接进 `runtime.runCrystallizeRoundOnce`，带 `belief_decay_round_fired` 账本 + 正向 gate 覆盖（现由 `check-mandated-capability-is-live.cjs` 的 live-required 条目守护）。以下为历史记录。

**已完成的半**：archiveOldL2 定时雷已拆——`memory-lifecycle.ts:archiveOldL2Memories` 按 `category='belief'` 排除信念卡镜像（防 90 天静默归档）。真正的"丢卡"风险已消除。

**未完成的半**：把确定性衰减轮 `runBeliefDecayRound` 接进生产，让信念卡按龄/使用度**优雅衰减**（H→M→L→mark_decayed→delete）。

**现状（已确认）**：
- `belief-decay.ts` 全套确定性纯函数已存在：`decideBeliefDecay`、`runBeliefDecayRound(cards, effectors, now)`、`BeliefDecayEffectors{setConfidence,markDecayed,deleteCard}`。
- `collectBeliefDecaySignals(store, readMirror, now)`（`maintenance-llm-round.ts:242`）已存在，`readMirror` 需返回 `{accessCount, wasUsefulCount}`。
- **仅在 `maintenance-llm-round.ts` 内被调用**（LLM 维护轮，需注入 deps），生产是否真跑取决于该轮是否被调用并传 decay deps——未接。

**修法（未实施）**：
1. 建 `BeliefDecayEffectors`：`setConfidence/markDecayed` = `store.readCard` 改 frontmatter.confidence/source 后 `store.writeCard`；`deleteCard` = 复用 crystallize effectors 的 deleteCard。
2. `readMirror`：从 belief 镜像读 `access_count`（P2-4 已在注入时递增）；`was_useful_count` 镜像尚无该列——先按 0，或加列（另开）。
3. 把 `runBeliefDecayRound(collectBeliefDecaySignals(store, readMirror, now), effectors, now)` 接进 **确定性 crystallize 轮**（`runtime.runCrystallizeRoundOnce` 内，P2-1 已接线的那个），而非依赖 LLM 轮。

**为何暂缓**：
- decay 会 **demote/delete 信念卡**——无人值守下误降/误删高危。
- P2-4 使用计数刚接通，`access_count` 需时间积累才有意义；此刻按龄衰减会误降"有用但计数未积累"的卡。
- `was_useful_count` 镜像列缺失，信号不全。

**前置条件**：P2-4 数据积累一段时间 + 可监控会话。

**验证方式**：构造老龄+零访问的 staged/low 卡 → decay 轮应按阈值 demote/mark；高访问卡应 keep/promote。务必先在测试里跑 `decideBeliefDecay` 阈值矩阵再上生产。

---

# D4 — appendModelCriteria 接裁决（梯队二复验后缓办，2026-07-03）

**现状（本轮复验确认）**：`appendModelCriteria`（`criteria-templates.ts:179`）纯函数已存在（模板项后追加模型声明标准，m1/m2 命名空间，不可覆盖模板），零调用者。裁决 live 路径 = `run-finalizer.ts:623 resolveCriteria → adjudicateTerminalOutcome`，criteria 已落库（P2-2 前半）。

**为何缓办（比 handoff 预估重）**：**捕获通道不存在**——全仓无任何字段/工具入参/解析点承载"模型规划期声明的验收标准"（grep acceptanceCriteria/modelCriteria/declaredCriteria 零命中；steps/packet 均非验收标准语义，混用会造成裁决漂移）。接线的真实工作 = 设计模型可见的声明通道（规划工具 schema 加字段或 D2 的 reminder 方案捎带）+ 落库 + finalizer merge + 裁决漂移监控。改模型可见面 + 动裁决脊柱，无人值守不宜。

**修法（未实施）**：与 D2 合并设计最佳——D2 把 criteria 注入模型面做"事中自检"时，同一通道天然是模型声明补充标准的回传口；届时 `appendModelCriteria` 在 `resolveCriteria` 后调用并随 P2-2 落库。

**前置**：D2 实施（可监控会话）；实施时把 `check-mandated-capability-is-live.cjs` 的 dark-defect 条目翻成 live-required。

---

# D5 — RunFeedbackRepository 全栈接线（梯队三，登记于 2026-07-03）

**现状（本轮复验确认）**：`task-projection/run-feedback-repository.ts` + migration 036 `run_feedback` 表已存在，主进程零实例化、无 IPC、无 UI。

**待做**（handoff §5 梯队三原文）：实例化 + IPC `agent:runFeedback:submit/list` + preload/electron.d.ts + renderer 评分控件。

**为何缓办**：需 renderer UI + 真机验证，属梯队三"需 UI + 监控"，无人值守不宜。

**前置**：可监控会话；实施时翻 `check-mandated-capability-is-live.cjs` 条目。

---

# D6 — agent-sdk-runtime 三测试与行动宣告闸的合同碰撞（已知红，登记于 2026-07-03）

**现象**：`verify:evolution-p6o` 红，`agent-sdk-runtime.test.ts` 三个用例失败：keeps browser tools hidden for local document attachment tasks / repairs new document turns that mutate without saving / exposes upload browser tools for upload workflow intent。

**根因（已确认）**：行动宣告闸（CLAUDE.md §2"零工具的行动宣告不得直接判 done——先转向、再 checkpoint"）把零工具宣告轮的最终文本包装成 `我准备执行"…"但未能启动，已保存断点…`，而这三个用例仍期望模型原文（如 `我会按文档处理。`）。闸与测试都是前序会话的未提交改动（两文件均 M），碰撞属 base 自带，非梯队一/二引入（本两轮零 sdk/文档道改动）。

**待做**：语义仲裁——这三个场景里宣告闸是否应触发（fixture 是否该带工具调用/是否属"宣告"），按结论改测试 fixture 或闸的豁免条件。涉及文档道/浏览器道行为设计，非机械修复。

**前置**：可监控会话。修复前 `verify:evolution-p6o` 的红以本条为已知原因。

---

# 汇总
| 项 | 已完成 | 待做 | 高危点 | 前置 |
|----|--------|------|--------|------|
| D1 P1-b | 根因确认 | 发 tabOpened(activate:false)+renderer 不抢焦点 | renderer 焦点回归 | 可监控会话 |
| D2 P2-2 | criteria 落库 | taskType→prompt/reminder 注入自检 | 中枢文件 | 可监控会话 |
| D3 P2-6 | **全部完成（P5d）** | — | — | — |
| D4 appendModelCriteria | 复验+挂号 | 声明通道设计（并 D2）+ finalizer merge | 模型可见面 + 裁决漂移 | D2 实施 |
| D5 RunFeedbackRepository | 复验+挂号 | 实例化+IPC+preload+UI | renderer/真机 | 可监控会话 |
| D6 sdk 三测试 vs 宣告闸 | 根因确认 | 语义仲裁后改 fixture 或闸豁免 | 文档/浏览器道语义 | 可监控会话 |
