---
title: Agent 续跑/续作"可续证明"统一 — 根因分析与修复计划
date: 2026-06-16
status: 诊断完成 / 待实施（仅诊断，未改产品代码）
authors: 白（Claude + Codex 多轮交叉复核）
scope: src/main/modules/agent-control（收口/投影/续作合同）、browser-engine（采集 checkpoint）、claude-bridge（live path）、renderer 任务卡
enforce: false # 计划文档，尚未实施；实施时按工单拆分并转正
related:
  - src/main/modules/agent-control/contracts/resume-handle.ts
  - src/main/modules/agent-control/runtime-core/run-finalizer.ts
  - src/main/modules/agent-control/task-projection/task-projection-sync.ts
  - src/main/modules/agent-control/task-projection/task-projection-resume.ts
  - src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts
  - src/main/modules/browser-engine/content-task-runner.ts
---

# Agent 续跑/续作"可续证明"统一 — 根因分析与修复计划

> 一句话：Ready 现在没有一个**统一可信的续跑事实源**。同一个任务会出现"磁盘还有断点 / 账本说 done / 任务卡说 completed / 续作时却当新任务跑"的四方分裂。根因不是"某个断点丢了"，而是**收口分类、断点语义、投影口径、续作入口、各后端门控**对"这是不是一个用户可续点"各执一词。

## 0. 摘要（TL;DR）

- **触发**：2026-06-16 15:37 的 surf-pro「世界杯视觉设计」搜查任务（research run `req-1781595424687`）跑出一份文档后收口为 `done`，但同时在磁盘写了一个 budget checkpoint（`run_state.json` 206KB，至今存在）。15:43 用户续作「再找找相关图片」（`req-1781595832118`）**7.5 秒 error**，零产出。
- **下游致死点**：续作没接回断点 → 起了全新 run → 工具面按单轮意图重算 → 模型沿用旧轮 `web_search` 习惯，但当轮 SDK 没注册该工具 → `@openai/agents-core` runner 把"工具未注册"当**致命错误**直接打死 run。
- **上游真根因**：未完成但可续的任务被**收口分类成 `done`→`completed`**；投影层一见 `completed` 就**短路判定不可续**并清空续作句柄；续作入口只信任务卡，拿不到句柄就起新 run。
- **更深一层**：Ready 把三种东西混进同一个"budget checkpoint"——**滚动安全快照 / 真正暂停点 / 完成残留快照**——由同一个默认 `budget_exhausted` 的写入器产出，无法区分。
- **修复支点（已被复核修正）**：不是"done 别抹句柄"，而是**"别把未完成且有有效续跑点的任务判成 completed"**，且必须与**断点语义分类**一起做，否则会把滚动快照误暴露成用户可续任务。
- **红线（避免修成"假可续"）**：`degraded ≠ 可续`。未达标但**无有效续跑证明**时只能落失败/阻塞，**不得**造出无物证的继续入口（`run-finalizer.ts:134-138` 本就强制 handle，无 handle 会抛错）。真正 `done` 时滚动 snapshot **不得**作为用户可续 continuationRef 留在 run_meta。语义字段 `resumeKind` 必须有明确数据合同（§6.7），旧 Agent SDK path-pair 数据默认 `snapshot`（不可续）；skill child / detached 等非 path-pair 句柄走自己的生命周期证明，不能被 `resumeKind` 一刀切误杀。浏览器线是独立句柄，证明需**按 kind 分**：共同腿 payload/plan；note/card 区分"从 cursor 接着跑"与"失败项重试"；visible_collect 走 visible checkpoint + URL/tab 重建，其他 kind 明确不可续（§6.5）。
- **好消息**：统一句柄合同（`canResumeShape`/`canResumeWithFs`）**已存在并有 ~12 处调用**，缺的是①Agent SDK path-pair 的语义腿②收口分类③把它铺到所有后端门控；浏览器采集是**独立句柄类型**，需自己的等价"可续证明"。

## 1. 问题观察（现象）

### 1.1 主案例（世界杯搜查任务，同一线程 `conv-d89653ad`）

| Run | 北京时间 | 用户请求 | 结果 |
|---|---|---|---|
| Run 1 `req-1781595424687` | 15:37→15:41 | `@[surf-pro] 找一下最近 3…`（世界杯视觉设计） | **done**；web_search 跑 23 次；存 `世界杯视觉设计研究.md`；写了 budget checkpoint 句柄 |
| Run 2 `req-1781595832118` | 15:43:52→15:43:59 | `再找找相关的图片存档同一个文件夹里…`（续作） | **error / blocked_external / 7.5 秒 / 零产出** |

致死日志：
```
[07:43:59.733Z] agent:sendScoped done req-1781595832118 success=false
  error=Tool web_search not found in agent butler::conv-d89653ad...
```

### 1.2 工具面随单轮意图抖动（同一线程对照）

```
Run 2 (07:43:52, 失败):  suppressed=browser_interaction|browser_content_tasks   exposure=false   general_research 可见但 web_search 最终未注册
07:52 (后续):            visible=browser_interaction|browser_content_tasks       exposure=true    用 browser_search/collect_images/download 搜图
```
注：07:52 那轮**并非干净恢复**——它在 `run_meta` 里没有终态行、directchat 无 `done`，5 分 52 秒后被 15:57 的新 run（`req-1781596675119`）顶替，后者才 `done`。

### 1.3 不止世界杯（扩大观察）

- `run_meta` 中 **3 条 `done` 但带 continuation_ref** 的 research 记录；对应任务卡全为 `completed` 且无续作入口。其中 **2 条（06-12）的磁盘 `run_state.json` 已被清掉**（临时目录回收）。
- 浏览器采集线：`card_loop` 21 failed / 12 cancelled / 3 completed；`visible_collect` 7 failed；`note_collect` 2 failed。失败采集任务因后端 status 门控普遍续不了（详见 §4）。
- 历史账本里还有 `note_collect not resumable across app restart (agent tab gone)`（断点在、tab 没了），06-10 已对 agent 续跑路径加 `ensureAgentTab` 缓解。

## 2. 前因后果（完整因果链）

```
① Run 1 跑研究，中途写"budget checkpoint"（实为滚动安全快照，预算 23/60 未耗尽，
   warningLevel=none，却被默认标成 budget_exhausted）
        │  agent-sdk-runtime.ts:5970/5974/6001-6002
        ▼
② Run 1 产出文档，收口为 terminalReason='done'
   （质量判据其实 degraded、criteria 0/4 未满足，但判据是 shadow 旁路，不挡 done）
        │  run-finalizer.ts:127-129/190 + task-adjudicator.ts:83
        ▼
③ 投影同步：'done' → resolveTerminalStatus → 'completed'
   completed 在 resolveContinuationRef 直接 return null（不回填句柄）
   resolveTerminalResumableActions 对 'done' 返回 null（无续作动作）
        │  task-projection-sync.ts:349/461/383-399
        │  → 覆盖了写检查点时本来带的 resumableActions+句柄（5994-6006）
        ▼
④ 任务卡 canResume 派生：projectionAllowsResume 见 status='completed' 直接 false（短路在句柄检查之前）
        │  task-projection-resume.ts:13/35
        │  → 即使磁盘句柄有效，canResume 仍为 false，卡上无"继续"
        ▼
⑤ 用户发"再找找图片"：buildContinuationIntent 从【任务卡投影】取句柄，
   投影已无句柄 → canResumeShape 失败 → 返回 null → 不带 continuationState
        │  runtime.ts:2962/2983（注意：此处只做 canResumeShape 形状检查）
        ▼
⑥ Orchestrator → AgentSdkRuntime.sendMessage 无 continuationState → loadBudgetCheckpointState 无可恢复
   → 工具面按单轮意图重算（浏览器被压制、web_search 最终未注册）
   → 模型沿用旧轮 web_search 习惯发起调用 → SDK runner 校验工具名未注册 → 硬抛致命错误 → run 秒死
        │  orchestrator.ts:392 / agent-sdk-runtime.ts:3699
        │  @openai/agents-core/dist/runner/modelOutputs.js（"not found in agent" 抛点）
```

### 2.1 四账本分裂（同一任务，四种说法）

| 账本 | 说法 | 落点 |
|---|---|---|
| 断点文件 `run_state.json` | `kind=agent_sdk_budget_checkpoint` / `terminalReason=checkpoint_budget` — 我像可恢复检查点 | agent-sdk-runtime.ts:5974/5981 |
| `run_meta` | `status=done, terminal_reason=done`，却挂了 `blockerType=budget_exhausted` 的 continuation_ref（450B） | run-finalizer 写 done + 孤儿句柄 |
| 任务卡投影 | `status=completed`，`continuation_ref=NULL`，`canResume=0` — 已完成、无可续 | task-projection-sync.ts:461 + resume.ts:13 |
| 质量判据 | `degraded`，criteria 0/4 未满足 — 但只是 shadow 记录，没挡 done | task-adjudicator.ts:83 |

**没有任何一方是"这是不是用户可续点"的单一真值源。**

## 3. 根因分层

1. **断点类型混在一起**：滚动安全快照、真正暂停点、完成后的残留快照，没有清楚分开（同一写入器、同一 `budget_exhausted` 默认标签）。
2. **完成判定太强**：质量未达标 / 仍有真实续跑点时，仍能被收成 `done`/`completed`（判据是 shadow，不具强制力）。
3. **投影太有损**：一旦 `completed`，`resolveContinuationRef` 丢句柄、`projectionAllowsResume` 短路判不可续。
4. **续作入口太依赖任务卡**：任务卡丢了句柄，就不回头查底层账本/磁盘；且现有入口末端部分只做形状（`canResumeShape`）不做文件存在校验。
5. **多模块复制"按状态判能否续"**：浏览器、技能子任务、文档任务、任务投影各有一份 status 门控（详见 §4）。
6. **工具面缺最后观测与软恢复**：新 run 工具表不一致时系统自己看不见，直到 SDK 抛死；`missingToolNames` 观测只在恢复路径有、fresh-turn 没有。

## 4. 扩大审查：系统性缺口清单

### 4.1「按 status 判续跑资格」被复制到多处（应改为按"可续证明"判）

| 入口 | 文件:行号 | 判据 | 缺口 |
|---|---|---|---|
| 浏览器采集 resumeTask | `content-task-runner.ts:834` | `status==='failed'\|'completed'` 直接 early-return | failed 任务即使 checkpoint（cursor+partialResults）完好也被拒 |
| 技能子任务 resume | `skill-child-runner.ts:542` | `isSkillChildRunResumable(status)`（仅 recoverable_paused/budget_paused） | failed 子任务即便有 handle 也走拒绝路径 |
| 技能子任务 UI 动作 | `skill-child-runner.ts:2548` | `failed → ['retry','cancel']` 纯按 status | 与后端 542 口径不一致 |
| 投影动作 | `task-projection-sync.ts:428` | `failed → ['retry']` 不看 handle | 动作与 canResume 各算各的 |
| 文档任务 | `document-task-pipeline-executor.ts:1652` | `failed → ['retry','cancel']` 纯按 status | 无 handle 校验 |

正确范式已存在并在用（应统一收口到此）：`resume-handle.ts` 的 `canResumeShape`（形状）/`canResumeWithFs`（形状+文件存在），约 12 处调用，含 `task-projection-resume.ts:35`、`runtime.ts:2983`、`startup-run-reconciler.ts:131`、`skill-task-supervisor.ts:622` 等。`vea-resume-action.ts` 也是按 stage+artifact 判，正确。注意：`canResumeWithFs` 只对 `outputDir+runStatePath` 做文件校验；`childRunId` / `detachedTaskId` 的物证来自 child/detached 生命周期账本，不能混用 path-pair 的 `resumeKind` 判据。

### 4.2 断点语义未分类（误标源）

`agent-sdk-runtime.ts:5954` 单一写入器：
- `terminalReason = params.terminalReason || 'checkpoint_budget'`（5970）
- `kind: 'agent_sdk_budget_checkpoint'`（5974，硬编码）
- `blockerType: params.blockerType || 'budget_exhausted'`（6001）
- `pauseReason: params.pauseReason || 'budget_exhausted'`（6002）
- `blockedReason || '本轮工具预算已用完…'`（5971）

→ 任何经此写的检查点（含滚动快照）默认被标成"预算耗尽、用户可继续"，与真正耗尽无法区分。

### 4.3 done 收口不以判据为门

`run-finalizer.ts:127-129` 对 `kind==='done'` 直接 `writeTerminalOutcome('done')`；`recordShadowAdjudication`（190）只是**影子**；`task-adjudicator.ts:83` 注释自承"unsatisfied criteria on a done candidate: degraded (shadow)"。→ degraded/criteria 未满足**不挡 done**。

### 4.4 续作入口信"投影"不信"真值"，且形状≠文件存在

`buildContinuationIntent`（`runtime.ts:2962/2983`）句柄来自投影、且该门只做 `canResumeShape`（形状）。→ ① 投影丢了句柄就取不到；② 若直接把 run_meta/磁盘候选接到此入口，会**放过悬空指针**（如 §1.3 那两条磁盘已丢的旧记录）。

### 4.5 浏览器采集是独立句柄类型（不能直接套 Agent 合同）

浏览器 checkpoint 是 `{stage:'note_collect_round', cursor, partialResults}`，写在 `browser_tasks.checkpoint_json`，**不是** `ResumeHandle`（childRunId/detachedTaskId/outputDir+runStatePath）。前端浏览器卡（`TaskCard.tsx:626`）按 `interactionState==='suspended' || waitingFor==='verification'` 显示"继续"、**不走 canResume、不做文件校验**；后端 `resumeTask`（834）又直接拒 completed/failed。→ 浏览器线是任务卡"窄口子撒谎"的唯一真实位置，需要**自己的等价可续证明**。

### 4.6 工具面观测/软恢复缺失

`missingToolNames`（`agent-sdk-runtime.ts:580`）只在 checkpoint 恢复路径算；fresh-turn 路径无等价检查。SDK 对未注册工具**硬抛致命**（`@openai/agents-core` runner），绕过了 Ready「工具错误转结构化 ToolExecutionOutput 回灌、只有 Abort/host 不可用才冒泡」的合同。

## 5. 关键澄清（已被推翻/收窄的假设，避免误修）

1. **live path 是 AgentSdkRuntime，不是 DirectChat/TurnEngine。** `orchestrator.ts:88-124`（Stage U PR U1.3，DirectChat 已退役、只 bind sdkEngine 事件）+ `orchestrator.ts:392`（live `send` 调 sdkEngine.sendMessage 并传 continuationState）。**修复不要落到 turn-engine/DirectChat 这条 dormant 路径上。** 恢复机制（`loadBudgetCheckpointState`@3699 / `restoreCheckpointToolSurface`@552）本身是好的，只是输入被饿死。
2. **run_meta 不能当唯一真值。** 3 条 done-with-continuation 中 2 条磁盘已丢；候选恢复必须做文件存在 + 任务归属 + 语义校验，不能"优先信 run_meta"。
3. **主任务卡有 canResume 保护，不是纯状态驱动。** `TaskCard.tsx:587/596/652/701` 均要 `canResume===true`；`taskCardViewModel.ts:426-444` 的 `gateActionsByCanResume` 明文"continue/retry 必须 canResume===true、undefined 默认 false"。→ "任务卡撒谎"的说法收窄到**仅浏览器卡**（§4.5）。
4. **"done 别抹句柄 + canResumeWithFs"单点修不成立。** `task-projection-resume.ts:13` 在句柄检查**之前**就因 `status==='completed'` 短路返回 false。所以保留句柄也没用——**支点是收口分类**：别让未完成可续的任务先变 completed。

## 6. 优化修复思路

### 6.1 一个核心合同：统一"可续证明"

把"这是不是一个用户可续点"收敛为单一可机器验证的判据，三腿缺一不可：

1. **句柄形状**：是合法 durable handle / 浏览器 checkpoint（已存在：`canResumeShape`）。
2. **物证存在**：磁盘 run_state.json 在 / 浏览器 cursor+partialResults+源数据在（已存在：`canResumeWithFs`；浏览器需等价物）。
3. **语义类型（新增第三腿）**：该检查点是"真正暂停点"，而非"滚动安全快照"或"完成残留"。

### 6.2 支点：收口分类（不是事后补账本）

未完成且持有"真正暂停点"的任务，**在收口时**就必须分到「可续终态」（如 `checkpoint_*`/`paused`），不能先判 `done`/`completed`。这一步必须与 §6.1 第三腿（断点语义）一起做，否则会把滚动快照误暴露成用户可续任务。

**关键：degraded ≠ 可续（必须拆开三类，否则造出"无物证的继续入口"）。**

| 收口情形 | 终态归类 | canResume |
|---|---|---|
| 达标完成 | `completed` | false（无续作入口） |
| 未达标/degraded + **持有有效 paused 续跑证明**（句柄+文件+语义=paused） | 可续终态 `checkpoint_*` | true |
| 未达标/degraded + **无有效续跑证明** | **失败/阻塞（非 completed、非可续）** | false |

最后一类是红线：现有 `run-finalizer.ts:134-138` 的 checkpoint 分支**本就强制** `isValidContinuationHandle`，无 handle 会直接 `checkpoint_degraded_error` 抛错。所以"degraded 无证明"绝不能路由到可续终态——只能落 error/blocked，且任务卡不显示继续。

### 6.3 投影只读派生、单向收敛

「可续终态」才保留句柄并给 continue/retry；真正 `completed` 不带任何续作入口。任务卡继续只消费 `canResume` 派生位，不新增本地猜测。

### 6.4 续作入口可回查底层，但强制校验

任务卡无句柄时，允许从 run_meta/磁盘找候选恢复，但必须走 §6.1 全三腿（复用 `startup-run-reconciler.ts:131` 已有的"扫描+canResumeWithFs"模式）+ scope/task 归属校验，禁止把悬空指针捞起来。

### 6.5 浏览器线独立合同

浏览器 checkpoint 是 `{stage,cursor,partialResults}` 写在 `browser_tasks.checkpoint_json`，**不是** Agent 的 `ResumeHandle`，不能直接套 `canResumeWithFs`。且**不同浏览器任务类型有不同的真实恢复路径**——证明必须**按 kind 分**，否则会把 visible_collect 误判不可续、或把 note/card 的重试账本硬套过去。

**共同腿（所有可续类型）**：
- **payload/plan 在**：后端 `content-task-runner.ts:830 resumeTask` 取不到 payload 直接 `return null`；note/card 还必须 `parseCollectionPlan(payload.plan)` 成功。
- **运行面可重建**：按 kind 判断，不是统一套 `ensureAgentTab`。note/card 走 `ipc-handler.ts:910 ensureAgentTab`（重建 + 回写 payload）；visible_collect 走 payload 中的 `url/tabId` 与 `openTarget`/`navigateTargetTab` 路径重建目标页。

**按 kind 的 checkpoint 腿**：

| kind | checkpoint 腿 | 恢复机制 |
|---|---|---|
| `note_collect` / `card_loop`（暂停/租约丢失） | stage=`note_collect_round` + `cursor` + `partialResults`(CollectionLoopState) | `runNoteCollect`（1321-1326）从保存 cursor/state 接着跑 |
| `note_collect` / `card_loop`（失败项重试） | 上一行基础上 + `retryableCollectionFailures(state)` 非空 | `prepareFailureLedgerResume`（841-862）只重试失败项 |
| `visible_collect` | stage=`visible_collect_round` + `partialResults`(数组) + `cursor`(round) | `content-task-runner.ts:1065-1076` 从上轮 round 续，**不走 retry ledger** |
| 其他（如 `download_urls` 等无真实续作机制） | — | **明确不可续**（不给继续入口，避免假可续） |

前端浏览器卡（`src/renderer/components/agent/chat-panel/task/TaskCard.tsx:626`，现按 suspended/verification 裸显示）与后端 `resumeTask`（现按 status 裸拒）统一走"共同腿 + 该 kind 的 checkpoint 腿"，消除"前端显示 / 后端拒绝"不对称。

### 6.6 兜底与观测

每轮落最终工具名单；模型调到未注册工具时，不直接打死 run，而是转结构化 `tool_not_registered` 回灌、引导模型换可用工具继续；把 `missingToolNames` 观测铺到 fresh-turn。

### 6.7 语义字段数据合同（第三腿的"在哪/怎么默认/谁校验"）

第三腿要稳定可用，必须先把数据合同钉死（否则 EP-4 没有稳定输入）。当前 `ScopeRunTaskContinuation`（`contracts/types.ts:243`）**没有语义字段**，只有 `blockerType`/`pauseReason`（且被默认成 `budget_exhausted`）。约定：

- **字段名**：新增 `resumeKind: 'snapshot' | 'paused' | 'done_residual'`（`snapshot`=崩溃恢复用、非用户可续；`paused`=真正暂停、用户可续；`done_residual`=完成后残留、不可续）。
- **适用范围**：`resumeKind` 是 **Agent SDK path-pair 检查点**（`outputDir + runStatePath`）的语义腿，不是所有 `continuationRef` 的全局准入条件。`childRunId` / `detachedTaskId` 走 skill child / detached 生命周期合同；`superseded`、auto narration、metadata-only ref 默认不是用户可续点，除非其所属合同另行证明。
- **写两边（Agent SDK path-pair）**：
  - 写进 `run_state.json`（磁盘真值，恢复时可复核）——扩展 `agent-sdk-runtime.ts:5972-5989` 的 state 对象。
  - 写进 `ScopeRunTaskContinuation`（`contracts/types.ts:243`）并经投影落 `continuation_ref_json`——供 canResume 派生先做语义过滤。
- **归一化/边界传播**：`contracts/continuation-state.ts:153-203`、`normalizeContinuationIntent`（211-238）、`claude-bridge/ipc/run-control-group.ts:72-94`、`src/renderer/types/electron.d.ts:370-389` 必须保留 `resumeKind`；否则用户点击继续时语义腿会在 IPC/normalize 途中被剥掉。
- **旧 Agent SDK path-pair 数据默认（保守）**：缺 `resumeKind` 的历史 path-pair 记录一律按 **`snapshot`（不可续）** 处理，绝不默认 paused。这直接挡住 §1.3 那两条旧 done-with-continuation 被候选扫描捞起来。非 path-pair 的 child/detached 旧数据不因此失效，由对应生命周期证明决定。
- **文件存在校验不可省（修正：不存在"快速派生不读文件"这回事）**：
  - 任务卡 canResume **保留现有 `canResumeWithFs`（statSync 确认 run_state 文件在）不变**，`resumeKind` 只作**额外**过滤（先排除 snapshot/done_residual）。即
    `canResume = projectionAllowsResume(record) && canResumeAsUserPoint(handle, ref)`；其中 path-pair 分支要求 `canResumeWithFs(handle) && resumeKind === 'paused'`，child/detached 分支保持现有生命周期合同并可选接受 `resumeKind='paused'`，但不能因为旧 child/detached 缺字段而误判不可续。
  - **不能只靠 resumeKind 判 true**：否则丢文件的句柄会亮"继续"，违反既有保护 `task-projection-resume.ts:35` 与 `startup-run-reconciler.ts:129-131`（"a handle whose run_state file vanished … must NOT be advertised as recoverable"）。
  - **真正发起续作前**：再复核磁盘文件内 `resumeKind === 'paused'` + scope/task 归属一致；两边语义不一致时以磁盘文件为准并判不可续。
  - 注：`canResumeWithFs` 的 statSync 很轻量，且既有代码本就每次派生都在做，不构成性能问题，无需"省读文件"。

### 6.8 迁移/回填策略（已决策：方案 A — 仅修未来）

§6.7 的保守默认（旧记录无 `resumeKind` → 一律 `snapshot` → 不可续）安全但有副作用：当前已存在的断点也保持不可续，包括世界杯这条磁盘上仍在的 `run_state.json`（206KB）。既有 `startup-run-reconciler.ts:127-141` 只处理重启时 `running` 的任务、不碰 `done`，也不会捞回这条。

**决策（2026-06-16）：采方案 A — 仅修未来，零迁移、零回填。**
- 旧数据全按 snapshot 不可续；世界杯这条历史断点**不接回**，用户如需可重新发起搜查（surf-pro 会重建机制图与证据库）。
- **不引入回填 EP**；不改 `startup-run-reconciler` 去扫描 `done` 记录。
- 放弃的备选（备查）：方案 B 会新增"保守一次性回填 + 用户显式确认续作"（仅对 `done`-with-continuation 且文件仍在、重判语义为 paused 的记录）；本次不做。

> 验收口径据此固定：§8 中"新产生的 paused 断点 + 磁盘在 → canResume=true"；**所有历史断点（含世界杯，即便文件仍在）→ canResume=false**（旧数据无 `resumeKind`，默认 snapshot）。

## 7. 开发计划（分阶段工单）

> 顺序经多轮复核确定：**先分清语义 → 再改收口分类 → 再改投影 → 再补合同第三腿 → 再处理浏览器线 → 最后统一其余口径与兜底**。每阶段独立可验收，避免"先保留句柄反而暴露滚动快照"的误修。

### EP-1 断点语义分类（前置，必须先做）
- 落实 §6.7 数据合同：在 `run_state.json`（`agent-sdk-runtime.ts:5972-5989`）和 `ScopeRunTaskContinuation`（`types.ts:243`）增加 `resumeKind`；改 `agent-sdk-runtime.ts:5970/5974/6001-6002` 停止无条件默认 `budget_exhausted`，只有预算真耗尽（查 warningLevel/usage）才标 `paused`，否则 `snapshot`。
- **止住脏账（Gap 关键）**：真正 `done` 收口时，滚动 `snapshot` **不得**作为用户可续 `continuationRef` 写进 run_meta——`finally` 里 `persistRunMetaSnapshot(continuationRef: runMetaContinuationRef)`（`agent-sdk-runtime.ts:5271-5286`）须在 done 成功路径清空该 ref 或写成 `resumeKind=snapshot`，保证后续候选扫描（EP-6）永不采纳。
- 验收：① 未耗尽预算写检查点 → `resumeKind=snapshot`、不进用户可续入口；真耗尽 → `paused`。② done 成功且中途写过滚动 snapshot 的任务 → run_meta **不**留用户可续 continuationRef（或仅留 `resumeKind=snapshot`，候选扫描忽略）。

### EP-2 收口分类（支点）
- 改上游设 `outcome.kind` 处 + `run-finalizer.ts:127-140`，按 §6.2 三分类收口（**不要把 degraded 一律导向可续**）：
  - 达标 → `done`/`completed`。
  - degraded/未达标 **且持有有效 `paused` 续跑证明** → 可续终态 `checkpoint`（注意 `run-finalizer.ts:134-138` 已强制 `isValidContinuationHandle`，无 handle 会 `checkpoint_degraded_error` 抛错）。
  - degraded/未达标 **且无有效续跑证明** → **失败/阻塞（非 completed、非可续）**，不得造出无物证的继续入口。
- 让 `task-adjudicator`（shadow，`task-adjudicator.ts:83`）对 done/checkpoint/failed 分叉具备强制力，而非旁路记录。
- 明确修改 AgentSdkRuntime 成功路径：`agent-sdk-runtime.ts:5008-5020` 是正常成功 run 送 `kind:'done'` 的实际落点；该处必须先拿强制 adjudication + paused 证明分叉，再决定调用 done/checkpoint/error。只改 `run-finalizer.ts` 不足以改变 live path 的成功分类。
- 验收：① degraded + 有 paused 证明 → 可续终态、canResume=true。② degraded + 无证明 → 终态 ≠ completed **且 canResume=false、任务卡不显示继续**。③ 达标 → completed 无续作入口。

### EP-3 投影单向收敛
- 改 `task-projection-sync.ts:349/383-399/461`：仅「可续终态」保留 continuationRef + 给 continue/retry；真正 completed 清空且不给续作动作（与 EP-2 配套，completed 不再误含可续任务）。
- 验收：可续终态投影 → continuation_ref 非空、resumableActions 含 continue/retry；completed → 均空。

### EP-4 合同第三腿（依赖 EP-1 的 §6.7 数据合同）
- 在 `resume-handle.ts` 增加语义校验（新增 `canResumeAsUserPoint(handle, ref)`），按 handle family 分支：
  - Agent SDK path-pair（`outputDir + runStatePath`，无 child/detached）：要求 `resumeKind==='paused'` + `canResumeWithFs(handle)`，续作前再读磁盘 `run_state.resumeKind==='paused'` + scope/task 归属一致。
  - skill child / detached：保持 child/detached 生命周期证明；未来生产者可写 `resumeKind='paused'`，但旧 child/detached 缺字段不得被默认 snapshot 误杀。
  - superseded / auto narration / metadata-only：不算用户可续点，除非其所属合同另有证明。
- `deriveTaskProjectionCanResume`（resume.ts:35）与 `buildContinuationIntent`（runtime.ts:2983，**升级到带文件存在校验**）都走同一个分支函数。
- 验收：path-pair snapshot/done_residual → canResume=false；path-pair paused + 文件在 + 语义一致 → true；path-pair paused + 文件丢 → false；磁盘与 continuationRef 语义冲突 → 以磁盘为准判不可续；skill child/detached 既有可续任务不回归。

### EP-5 浏览器线独立可续证明（按 kind 分）
- 按 §6.5 定义**按 kind 分**的浏览器证明（共同腿 payload/plan；`note_collect`/`card_loop` 区分 cursor 续跑与失败项重试；`visible_collect` 加 `visible_collect_round` partialResults/cursor + URL/tab 重建；其他 kind 明确不可续）；统一 `TaskCard.tsx:626` 前端显示与 `content-task-runner.ts:830/834` 后端 `resumeTask` 都走它（替换裸 status 门控 + 裸 suspended 显示）。
- 验收：① `note_collect`/`card_loop` paused/failed 且 cursor/state 证明齐全 → 可续；若是失败项重试，按 retry ledger 只重试失败项。② `visible_collect` 有 `visible_collect_round` checkpoint + partialResults/cursor + URL/tab 可重建 → 可续（从上轮 round 续，**不被误判不可续**）。③ checkpoint 在但 **payload 缺失** → 卡不显示继续、后端拒绝口径一致。④ note/card tab 已销毁但可 `ensureAgentTab` 重建 → 续作前自动回写；不可重建 → 判不可续。⑤ `download_urls` 等无续作机制的 kind → 明确不可续。

### EP-6 统一其余口径 + 续作回查 + 兜底观测
- 统一 `skill-child-runner.ts:542/2548`、`document-task-pipeline-executor.ts:1652`、`task-projection-sync.ts:428` 走合同。
- 续作入口无句柄时回查 run_meta/磁盘候选，强制三腿+归属校验（复用 `startup-run-reconciler.ts:131`）。
- SDK 未注册工具软恢复（转结构化回灌，不打死 run）+ fresh-turn 最终工具名单观测（扩展 `missingToolNames`）。
- 补齐所有 continuation normalizer / IPC / renderer wire 字段，防止 `resumeKind` 在继续链路中被剥掉；同时加 skill child / detached 回归，证明非 path-pair 句柄不被新语义腿误杀。
- 验收：见 §8 断言矩阵。

## 8. 回归与验收（断言矩阵）

| 场景 | 期望 |
|---|---|
| 未耗尽预算写检查点 | 语义=snapshot；不进用户可续入口；canResume=false |
| **新产生**的 paused 断点（resumeKind=paused）+ 磁盘在 | 终态=可续；canResume=true；任务卡有"继续"；续作命中 restore，工具面恢复（web_search 在） |
| 新产生 paused 断点 + 磁盘丢失 | canResume=false（`canResumeWithFs` 挡掉）；不显示继续；续作回查时被文件校验挡掉 |
| **历史断点（含世界杯，文件仍在）** | **canResume=false**（方案 A：旧数据无 resumeKind 默认 snapshot，不接回）；任务卡不显示继续 |
| degraded + **有**有效 paused 续跑证明 | 终态=可续；canResume=true |
| degraded + **无**有效续跑证明 | 终态 ≠ completed；**canResume=false、任务卡不显示继续**（不造无物证入口） |
| done 成功任务 + 曾写过 rolling snapshot | run_meta **不**留用户可续 continuationRef（或仅 `resumeKind=snapshot`，候选扫描忽略） |
| 旧 Agent SDK path-pair 记录无 `resumeKind` | 默认按 snapshot 处理 → 不可续；候选扫描不采纳 |
| skill child / detached 既有可续任务缺 `resumeKind` | 不被默认 snapshot 误杀；仍按 child/detached 生命周期证明续跑 |
| superseded / auto narration / metadata-only continuationRef | 不显示用户继续入口；不被 `taskRunId`/`executionId` 空壳误判可续 |
| `note_collect`/`card_loop` paused/failed + cursor/state 证明齐全 | 可续；前后端口径一致；从 cursor/state 接着跑 |
| `note_collect`/`card_loop` failed + retry ledger 证明齐全 | 可续；只重试失败项 |
| `visible_collect` + visible_collect_round + partialResults/cursor + URL/tab 可重建 | 可续（从上轮 round 续，**不误判不可续**） |
| 浏览器任意 kind + checkpoint 在但 **payload 缺失** | 卡不显示继续；后端拒绝；不从零静默重跑 |
| `download_urls` 等无真实续作机制 kind | 明确不可续 |
| 续作选到未注册工具 | 不打死 run；结构化回灌引导换工具；fresh-turn 工具名单可观测 |
| 跨 EP 不回归 | 既有 `canResumeShape/WithFs` 约 12 处调用语义不破；`verify:stability`/`verify:evolution-p4` 绿 |

## 9. 证据附录（可追溯）

- 致死错误：`ready-directchat.log:1238`（`Tool web_search not found in agent butler::…`，success=false）
- SDK 抛点：`node_modules/@openai/agents-core/dist/runner/modelOutputs.js`
- 工具面抖动：`ready-tools.log:3512-3513`（Run2 browser 压制/exposure=false）vs 07:52 行（browser 可见/exposure=true）
- web_search 调用轨迹：`ready-agent-sdk.log` 07:37-07:38 有、07:43 无、07:52+ 又有
- 检查点写入器/误标：`agent-sdk-runtime.ts:5954-6008`（5970/5974/6001-6002）
- done 收口不挡判据：`run-finalizer.ts:127-190` + `task-adjudicator.ts:83`
- 投影丢句柄/短路：`task-projection-sync.ts:349/461`、`task-projection-resume.ts:13/35`
- 续作入口形状门：`runtime.ts:2962/2983`
- live path：`orchestrator.ts:88-124/392`
- status 门控群：`content-task-runner.ts:834`、`skill-child-runner.ts:542/2548`、`task-projection-sync.ts:428`、`document-task-pipeline-executor.ts:1652`
- 收口已强制 handle（degraded 无证明会抛错）：`run-finalizer.ts:134-138`
- done 仍写脏 continuationRef（finally 无条件）：`agent-sdk-runtime.ts:5271-5286`（5282 写 `continuationRef: runMetaContinuationRef`）
- continuation 对象缺语义字段：`contracts/types.ts:243`（`ScopeRunTaskContinuation` 无 `resumeKind`）；`contracts/continuation-state.ts:153-238`、`claude-bridge/ipc/run-control-group.ts:72-94`、`src/renderer/types/electron.d.ts:370-389` 也需保留字段
- 浏览器续作依赖 payload/tab：`content-task-runner.ts:830`（无 payload→null）、`ipc-handler.ts:910`（`ensureAgentTab` 重建+回写 payload）
- 浏览器按 kind 不同恢复路径：`content-task-runner.ts:841-862`（note/card 的 `prepareFailureLedgerResume` retry ledger）、`content-task-runner.ts:1321-1326`（note/card 从 saved cursor/state 续）、`content-task-runner.ts:1065-1076`（visible_collect 从 `visible_collect_round` partialResults/cursor 续，不走 retry ledger）
- 合同与现有用法：`contracts/resume-handle.ts`、`startup-run-reconciler.ts:131`、`task-projection-resume.ts:35`、`skill-task-supervisor.ts:622` 等约 12 处
- 账本：`run_meta` 3 条 done-with-continuation（2 条磁盘已丢）；World Cup `run_state.json` 206KB 现存
- 任务卡 gating：`TaskCard.tsx:587/596/626/652/701`、`taskCardViewModel.ts:426-444`

---

**状态**：仅诊断，未改产品代码。本文档为根因分析 + 修复计划；实施时按 EP-1…EP-6 拆工单，每单配回归断言（§8）。
