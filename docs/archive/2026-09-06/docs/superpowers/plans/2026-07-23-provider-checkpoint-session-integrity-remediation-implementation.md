---
title: Provider checkpoint 收口、会话一致性与相关大文件拆分实施计划
date: 2026-07-23
kind: implementation
status: implemented-r0-p14-p15-external-proof-pending
enforce: false
owner: 白
author: Codex
executor: next-session
implementation_gate: 新会话必须从本文档第 2 节完成基线预检，不得直接在当前 P7–P9 未提交改动上叠加补丁
requires:
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-07-22-provider-reliability-and-confirmation-visibility-implementation.md
  - docs/superpowers/plans/2026-07-22-browser-agent-sequential-long-task-and-tab-ownership-closure-implementation.md
  - docs/architecture/current-runtime-contracts.md
  - docs/superpowers/testing-conventions.md
supersedes_claims:
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-07-22-provider-reliability-and-confirmation-visibility-implementation.md §5.5–§5.6 关于 P7/P8/P9 已整体完成的结论
scope: P7 恢复增量完整性、P8 owner-local session 单写者、所有 Browser checkpoint 可见收口、target 级真实接管验收、暂停状态文案、真实长任务验收以及相关超额文件拆分
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Provider checkpoint 收口、会话一致性与相关大文件拆分实施计划

## 0. 文档定位

本文档是 2026-07-22 Provider 可靠性第三批 P7–P9 的纠偏与后续实施权威，供新会话直接 handoff。它不将当前工作树标记为已完成，也不否定已经通过的 P1–P4 与 Claude 第三轮修复；它仅覆盖旧文档 §5.5–§5.6 中被真实复测和对抗审查推翻的 P7/P8/P9 验收结论。

当前基线：

- Repo：`/Users/user/实验田/ready-cowork-newtab`
- Branch：`feature/skill-envelope-floors`
- HEAD：`e4d01490e8`
- 工作树：约 20 个 P7–P9 未提交文件；这些改动是后续的起点，禁止 reset、checkout 或用旧文件覆盖。
- 本计划只处理下文列明的六个功能缺口与相关大文件；不扩展 Browser 并行、多 Agent 或新产品能力。

## 1. 已确认的真实证据

### 1.1 2026-07-23 复测运行

目标运行：

| 字段 | 真值 |
| --- | --- |
| runId | `req-1784736080939-0t99qn` |
| taskId | `task-583dae0d-4a9f-4d4c-a464-39c15b9fae98` |
| scopeId | `conv-13e31e8b-2c4e-49f8-8f7c-692e8911fb09` |
| Agent / Provider | `analyst` / `openai-compatible` |
| Model | `gpt-5.6-terra` |
| 开始 / 结束 | `2026-07-22T16:01:20.960Z` / `2026-07-22T16:26:34.132Z` |
| 结束状态 | `checkpoint / blocked_tool_error / initiator=checkpoint` |
| 时长 | `1513132ms` = `25:13.132` |
| 续跑原因 | `provider_transfer` |

这不是完成态：

- Browser child `browser-task-bb9e14cf-37e3-40c3-800d-6215245aa494` 为 `paused`，进度 `17/55`，`finished_at=null`。
- 两份产物于 00:07:36 和 00:09:29 写入，但是“首批”文件；第一份明确只覆盖 5/18 个关键词。
- 结束前 `browser_research` 报错，随后 Provider 在 `16:25:38` / `16:25:54` / `16:26:13` 连续三次 502，最终进入可续跑 checkpoint。
- `run_meta.last_message_text` 有“模型服务暂时不可用…可以继续这项任务”，但 `chat_messages` 只有 1 条 user 记录，assistant 为 0。
- metrics 同时出现 `renderer_done_without_canonical_terminal` 和 `renderer_send_success_without_canonical_terminal`。
- 界面中“本轮等待中 25:13”的 `25:13` 正好是已结束运行的冻结用时，不是仍在计时的等待。

### 1.2 P7–P9 对抗审查判决

| 项目 | 判决 | 证据结论 |
| --- | --- | --- |
| P7 suspension → clean_base | CONCERN | 四类主路径和事务成立，但 marker identity 只含 `wakeId + itemDigest`；同一恢复增量中内容相同的两项会被压成一项。 |
| P8 漂移根修 | FAIL | `filterAndSyncRunnerSession` 在 SDK input filter 内提前 clear/add 完整输入，SDK 随后又持久化本轮输入与结果，造成双写。 |
| Claude 第三轮修复 | PASS | `prepareRunnerSession` 自愈、checkpoint receipt 线程化、`persistence_failed` 分类、checkpoint-scoped id 和 `lastRequestInputTokens` 均保留。 |
| P9 生产接线 | PARTIAL PASS | 指针、chrome 导航、精确 target 和 `createHumanTakeoverIntent` 事务接线存在。 |
| P9 验收诚实性 | FAIL | 脚本默认读错 metric 文件，文件不存在时仍返回 0；报告 `live.ok=false` / `visibleMessages=[]` 仍判通过；S0 没有贯穿生产全链。 |

P8 还有真实运行反例：

```text
owner_local_runner_session_rebased
previousItemCount=138
checkpointItemCount=69
previousDigest=373fdb1a...
checkpointDigest=69c78ce5...
```

138 正好是 69 的两倍，与“过滤层写一次 + SDK 写一次”的数据流一致。自愈层将任务救回，但不能替代根修。

### 1.3 六个缺口的处置映射

| 编号 | 已确认问题 | 根因层级 | 本计划入口 |
| --- | --- | --- | --- |
| 1 | 工具现场保存后没有最终汇报 | 普通 Browser checkpoint 不写 canonical assistant message，done 只能携空回执 | P10 |
| 2 | fresh-run 第二轮会话漂移 | Ready 在 filter 内先写 session，SDK 收口时又写一次 | P11 |
| 3 | typed resume 可能丢失内容相同的恢复项 | marker 只有 `wakeId + itemDigest`，没有 occurrence 序号 | P12 |
| 4 | target 接管有生产接线，但 S0 与 live proof 不能证明真实全链 | 分层单测被写成端到端证据，报告验证 fail open | P13 |
| 5 | UI 把“已暂停、可继续”显示为“等待中” | 把续跑句柄错当成正在等用户的交互 | P14 |
| 6 | 真实任务只写了首批文件，却被感知成“已做完但没汇报” | Browser child 仍 paused 17/55，产物仅 5/18，缺少交付完整性与最终可见性联合验收 | P15 |

拆分工作不是第七个独立修补，而是上述六项的先置交付条件：每个问题只能在对应职责迁出大文件后修复。

### 1.4 已绿 gate 的正确解读

2026-07-23 对抗审查已复跑：

- `npm run typecheck`：EXIT 0
- `npm run verify:browser-target-claims`：EXIT 0，15/15 + native 19/19
- `npm run verify:agent-continuation-clock`：EXIT 0，56 pass / 2 ABI skip，后续 claims/native 通过
- `npm run verify:stability`：EXIT 0，133 pass / 21 ABI skip；Send IM 141 pass / 1 skip

这些结果证明现有快速回归没有爆炸，不证明 P7 的重复项、P8 真实 SDK 持久化顺序、P9 真实 Renderer 可见性已覆盖。ABI skip 只能由 `npm run verify:native` 和 Electron-native 专项门禁补齐，不得写成“全部通过”。

## 2. 开工前基线预检

新会话必须先完成以下步骤，再改代码。

1. 读完本文档、前置 Provider 计划 §5.3–§5.6、`current-runtime-contracts.md` §5–§6 和测试规约。
2. 核对 `git branch --show-current` 为 `feature/skill-envelope-floors`，`git rev-parse HEAD` 仍以 `e4d01490e8` 为当前未提交 slice 的父基线；若已变化，先记录新 HEAD 和差异来源。
3. 运行 `git status --short` 和 `git diff --stat`，保留现有 P7–P9 改动；不得将未跟踪的四个代码/测试文件（live-proof 脚本、typed-resume native 测试、input bindings、typed-resume marker）当成垃圾删除。
4. 将当前已绿的四项 gate 复跑为拆分前基线，另跑 `npm run verify:native`。如基线新出现失败，先定性是现有回归还是环境问题，不把它混入拆分。
5. 以新失败测试固定下列反例，确认在修复前为红：P7 两个同内容恢复项、P8 真实 SDK 双写、provider_transfer 无 canonical、P9 `live.ok=false` 报告仍通过、可续跑但 `waitingFor=none` 被标成“等待中”。

## 3. 完成标准

只有以下条件同时成立，本计划才能标记 completed：

1. Browser 所有 suspension reason 在同一个 SQLite 事务中同时写入 checkpoint、projection/run 状态与唯一 canonical assistant notice；任一项写入/回读失败时整个事务回滚。
2. Main `done` 事件携带与 DB 同 id/同 digest 的 canonical message；Renderer 以它替换短暂输出，重启后仍能从 DB 读到且不重复。
3. 目标运行的 `renderer_done_without_canonical_terminal` 和 `renderer_send_success_without_canonical_terminal` 均为 0；指标文件必须存在且按 runId 解析，不能用全局字符串计数。
4. SDK Runner 是 owner-local `MemorySession` 运行期输入/结果的唯一追加者；`callModelInputFilter` 只返回过滤结果，不 clear/add session。
5. 真实 `Runner + MemorySession + callModelInputFilter` 至少两轮与一次压缩/重试后，session 内没有重复的本轮输入，`owner_local_runner_session_rebased=0` 且 cursor mismatch=0。
6. typed resume 保留恢复增量的顺序和重数；同内容的两项仍是两项。marker 只在第一个 Provider 边界被消费，不泄漏到后续轮次。
7. 指针输入和 chrome navigate/back/forward/reload 在真实 Electron `webContents` / `BrowserController` 入口进入精确 target 接管事务；不使用 fake persist 或只调纯 helper 代替生产链。
8. 导航回声只在“同一 physical target + 同一 held claim + 正在进行的 Agent action”时抑制；兄弟 target、无活动动作或用户真导航必须接管。
9. 真机报告必须同时证明运行二进制/源码 manifest/profile/DB 身份、`live.ok=true`、DOM 卡片真实可见、done canonical、指标归零和重启 expired。任一字段缺失都必须返回非 0。
10. UI 只在 `waitingFor != none` 时显示“等待”；`waitingFor=none` 且可续跑时显示“已暂停，可继续”，用时明确是已冻结的“本轮用时”。
11. 下文列出的相关超额生产文件完成职责拆分，新业务逻辑不得再进入大聚合文件；模块边界和行数由 CI gate 强制。
12. 在隔离 profile 中重做 18 关键词真实长任务：所有 required work items 完成，Browser child 真正 finished，两份完整产物回读通过，最终 assistant 汇报入库并在界面可见。

## 4. 先合同后代码

### C1. Browser checkpoint 与可见收口不可分离

`role=suspension` 的成功事务必须产出：

```text
checkpoint row
+ Parent checkpoint pointer / projection / run_meta
+ exactly one canonical assistant row
+ canonical receipt returned to turn state
= one atomic result
```

禁止继续使用“只把提示文字写到 `run_meta.last_message_text`”的路径。禁止 Renderer 从 `last_message_text` 或 transient buffer 自己合成终态消息。

### C2. 恢复标记的 identity 必须保留重数

标记身份必须至少包含 `wakeId + recoveryOrdinal + itemDigest`。`itemDigest` 用于校验内容，`recoveryOrdinal` 用于区分同内容的独立项；不得用内容 hash 代替序列身份。

当前日常 DB 中 `final_input_json LIKE '%readyTypedResumeRecovery%'` 为 0 行，因此本次可直接替换尚未提交的 marker v1，不增加 legacy 兼容分支。

### C3. owner-local session 运行期只有一个写者

- Runner 开始前：Ready 可以用 clean checkpoint 校验并必要时重建 owner-local session。
- Runner 运行中：SDK 是输入与 assistant/tool 结果的唯一追加者。
- `callModelInputFilter`：只返回过滤后的 Provider 输入。当前 SDK 会将 filter 产生的 `persistedItems` 交给 session persistence，Ready 不再提前 clear/add。
- 重试：只恢复 Runner 开始前的 `baseItems`，不保留失败 attempt 的部分写入。
- 共享/public session 继续不得被 Browser owner-local 自愈或过滤逻辑修改。

### C4. Renderer 不猜“等待”

| 结构真值 | UI 状态 | 计时 |
| --- | --- | --- |
| live phase | 本轮进行中 | 继续跳动 |
| checkpoint + `waitingFor != none` | 本轮等待中，并显示具体等待对象 | 冻结本轮用时 |
| checkpoint + `waitingFor=none` + 有续跑句柄 | 本轮已暂停，可继续 | 冻结本轮用时 |
| checkpoint + 无有效续跑句柄 | 本轮未完成 | 冻结本轮用时 |
| done/error/cancelled | 对应终态 | 冻结本轮用时 |

`taskContinuation` 或 `resumableActions` 只表示“可续跑”，不表示“正在等人”。

### C5. target 级接管必须贯穿生产边界

合法证明链是：

```text
real webContents input / BrowserController chrome navigation
→ exact physical target + held claim
→ echo decision
→ createHumanTakeoverIntent runtime port
→ repository transaction
→ claim=user_owned + suspension checkpoint + projection/readback
```

仅调 `createAgentTabUserInputTakeoverHandlers`、`persistAgentTabUserTakeover` 或直接 repository 的测试只是分层单测，不得命名为“真实输入链验收”。

### C6. 真机证据 fail closed

真机验收必须复用已有 Browser live-proof 设施：

- `browser-live-proof-manifest.cjs` 生成包含当前 tracked + untracked 源码的 digest。
- `READY_BROWSER_LIVE_PROOF_NONCE` + `browserLiveProofHandshake` 校验进程、二进制、asar、manifest、profile 和 DB 身份。
- 验收驱动自己启动并关闭当前 build，不附着到不明来源的已运行 Ready。
- metrics 从该进程 `TMPDIR/ready-agent-metrics.log` 读取。文件不存在、JSON 行无法解析或 runId 不匹配都是失败，不是 0 次。
- 报告 validator 与 driver 分离，并有负例测试证明 `live.ok=false`、空可见消息、错 metric 路径、缺 handshake 时必须拒绝报告。

### C7. 大文件只保留组合职责

本计划不用“减空行”制造余量。所有拆分都必须保留原导出和行为，先做 move-only 拆分、单独验证，再修功能。新叶子模块不得反向依赖 facade。

## 5. 相关文件健康基线与拆分目标

### 5.1 当前体量

| 文件 | 当前行数 | 判断 | 本计划是否必须处理 |
| --- | ---: | --- | --- |
| `agent-session-checkpoint-resume.ts` | 1478 | 危险：接管、确认、owner crash、typed resume 事务混合 | 是 |
| `run-finalizer.ts` | 1314 | 危险：终态事实、投影、裁决、持久化和产品收口混合 | 是 |
| `browser-engine/ipc-handler.ts` | 2829 | 危险：BrowserController 状态/服务/接管/导航/捕获与 IPC 注册混合 | 是 |
| `runtime.ts` | 3148 | 危险：全局 runtime 组装过度集中 | 只迁出本次 Browser/continuation 职责，不顺手拆日程/渠道/记忆 |
| `renderer/modules/agent/runtimeDriver.ts` | 1884 | 一般但已妨碍终态事件定位 | 是 |
| `agentPanelTestHarness.ts` | 1483 | 一般：类型、快照、诊断和驱动混合 | 是 |
| `agent-session-checkpoint-native.test.ts` | 1595 | 一般：多种 checkpoint 生命周期共用一套件 | 是 |
| `run-finalizer-checkin.test.ts` | 1327 | 一般：来源证明与终态裁决混合 | 是 |
| `runtime-driver-terminal-unlock.test.ts` | 1283 | 一般：解锁、canonical 和暂停变体混合 | 是 |
| `agent-sdk-turn-execution.ts` | 893 / 900 | 硬上限仅余 7 行 | 禁止新增业务逻辑 |
| `agent-sdk-turn-orchestrator.ts` | 1000 / 1000 | 零余量 | 本计划不修改 |

### 5.2 checkpoint repository 拆分

删除巨型 `agent-session-checkpoint-resume.ts` 的多职责实现，`AgentSessionCheckpointRepository` 的公开方法名与返回类型保持不变。`agent-session-checkpoint-resume.ts` 改为目标 ≤ 250 行的窄 facade，分别委派到：

- `agent-session-checkpoint-takeover.ts`：`createHumanTakeoverIntent` / `completeHumanTakeover`，目标 ≤ 750 行。
- `agent-session-checkpoint-confirmation-lifecycle.ts`：读取/过期 power 与 permission confirmation，目标 ≤ 300 行。
- `agent-session-checkpoint-owner-recovery.ts`：owner-crash 读取与结算，目标 ≤ 350 行。
- `agent-session-checkpoint-typed-resume.ts`：typed wake 校验、suspension → clean_base 晋升、wake receipt 消费，目标 ≤ 600 行。

另外从 `agent-session-checkpoint-store.ts` 迁出 `agent-session-checkpoint-canonical-notice.ts`，只负责在 store 已开启的同一事务中写入/回读 canonical notice，目标 ≤ 250 行。它不经 resume facade 调用，也不自行开第二个事务。

共享 SQL/codec 只能下沉到已有 `browser-workflow-*` 工具，不复制一套新 repository 抽象。

### 5.3 run finalizer 拆分

`run-finalizer.ts` 保留 `finalizeRunOutcome()` 组合入口与稳定 re-export，目标 ≤ 500 行；其余职责迁出：

- `run-finalizer-contracts.ts`：outcome/deps/receipt 类型，目标 ≤ 260 行。
- `run-finalizer-projection.ts`：终态与暂停 projection patch，目标 ≤ 260 行。
- `run-finalizer-task-facts.ts`：任务类型、coverage/proof 与有效事实解析，目标 ≤ 420 行。
- `run-finalizer-adjudication.ts`：终态裁决与派生效果，目标 ≤ 500 行。
- `run-finalizer-persistence.ts`：canonical/core 收口、run_meta 与 close metric，目标 ≤ 500 行。

拆分后 `finalizeRunOutcome()` 仍是唯一公开终态通道，`check-run-finalize-funnel.cjs` 不得放宽 allowlist。

### 5.4 BrowserController / IPC 拆分

`ipc-handler.ts` 只保留 `setupBrowserIPC()` 和稳定 `BrowserController` re-export，目标 ≤ 250 行。当前类逻辑迁入：

- `browser-controller.ts`：公开 facade、共享 tab 状态与窄委派，目标 ≤ 900 行。
- `browser-controller-composition.ts`：构造 Browser 子服务和端口接线，目标 ≤ 650 行。
- `browser-human-takeover-runtime.ts`：真实输入监听、精确 claim、回声判断、持久接管与 pending fence，目标 ≤ 400 行。
- `browser-controller-tab-runtime.ts`：tab 创建/物化/导航/切换/关闭与 view intent，目标 ≤ 750 行。
- `browser-controller-host-runtime.ts`：BrowserHostView、preview、bounds、show/hide 与 popup host 生命周期，目标 ≤ 650 行。
- `browser-controller-automation-runtime.ts`：CDP debugger、键鼠输入、JS/frame 执行和 viewport 换算，目标 ≤ 750 行。
- `browser-controller-capture-runtime.ts`：page content、screenshot、background/live capture、archive 与 download 委派，目标 ≤ 750 行。
- `browser-controller-interaction-runtime.ts`：dialog、permission、origin data、upload/file chooser 与站点提示，目标 ≤ 650 行。
- `browser-live-proof-runtime.ts`：环境受控的 P7C/live-proof 辅助能力，目标 ≤ 300 行，生产默认不激活。

禁止多个子服务各自保有 `tabs` / `activeTabId` 副本。状态仍只有一个 owner，子服务通过窄 port 读写。现有近 30 个对 `ipc-handler.ts` 的 `BrowserController` import 保持可用，不在本轮做全库 import churn。

### 5.5 AgentControlRuntime 定向拆分

从 `runtime.ts` 迁出相关的 Browser/continuation 组合域到 `browser-continuation-runtime.ts`，包括：

- `createHumanTakeoverIntent`
- `suspendRun` / `resumeRun`
- `completeHumanTakeover`
- `resumeBrowserTargetClaim`
- `resumeBrowserWorkflowFromCheckpoint`
- Browser checkpoint 相关的 control-target 解析与 continuation intent 组装

新模块目标 ≤ 700 行，`runtime.ts` 只保留对外委派。本计划不顺手迁移定时任务、渠道、记忆或人格域，因此不伪称 `runtime.ts` 会在本轮整体降到 1000 行以下；验收目标是 Browser/continuation 业务不再回流大宿主，且建立依赖方向 gate。

### 5.6 Renderer 终态桥与真机 harness 拆分

`runtimeDriver.ts` 目标 ≤ 800 行，拆出：

- `runtime-driver-session-state.ts`：session slice / active mirror 纯状态转换，目标 ≤ 320 行。
- `runtime-driver-watchdog.ts`：基础设施看门狗，目标 ≤ 400 行。
- `runtime-driver-canonical-terminal.ts`：canonical 回读、digest 校验、transient 替换与 send/done 收口，目标 ≤ 500 行。
- `runtime-driver-stream-events.ts`：`onStream` 事件桥，目标 ≤ 700 行。
- `runtime-driver-scope-events.ts`：scope/projection 事件桥，目标 ≤ 700 行。

`agentPanelTestHarness.ts` 保留安装 facade 与 re-export，目标 ≤ 180 行，拆出：

- `agent-panel-test-harness-types.ts` ≤ 320 行
- `agent-panel-test-harness-snapshot.ts` ≤ 600 行
- `agent-panel-test-harness-diagnostics.ts` ≤ 300 行
- `agent-panel-test-harness-driver.ts` ≤ 700 行

真机脚本仍从原路径 import `installAgentPanelTestHarness`，不变更外部调用面。

### 5.7 大测试文件拆分

先提取共享 fixture，再按行为域拆分；每个新测试文件 ≤ 900 行，不删断言、不改名掩盖覆盖下降：

- `agent-session-checkpoint-native.test.ts` → store / confirmation / takeover-resume / owner-recovery 四组 native 套件。
- `run-finalizer-checkin.test.ts` → task-facts / adjudication / canonical-checkpoint 三组。
- `runtime-driver-terminal-unlock.test.ts` → canonical-terminal / checkpoint-unlock 两组。

新增 `provider-checkpoint-test-fixtures.ts` 只放稳定 fixture builder，不放产品判断逻辑。

### 5.8 机器强制的模块边界

新增 `scripts/check-provider-checkpoint-module-boundaries.cjs`，并接入 `verify:stability` 和 `verify:browser-target-claims`，至少强制：

1. 上述新生产模块行数不超目标，任一文件硬上限为 1000。
2. facade 不重新拥有已迁出的 SQL、Electron 监听、canonical 替换或交互驱动内部。
3. checkpoint 叶子不依赖 `AgentSessionCheckpointRepository` facade；Renderer 叶子不反向 import `runtimeDriver.ts`。
4. `agent-sdk-turn-execution.ts <= 900`、`agent-sdk-turn-orchestrator.ts <= 1000` 继续由现有 gate 强制。
5. `runtime.ts` 不得重新实现 Browser checkpoint/takeover 事务；`ipc-handler.ts` 不得重新实现 BrowserController 业务方法。
6. 新建 `scripts/run-provider-checkpoint-native-tests.cjs` 统一持有 checkpoint/session 的 Electron ABI 测试清单；现有 `run-browser-grounded-orchestration-native-tests.cjs` 只保留 Browser target 清单。`verify:browser-target-claims` 在上层依次调用两个 runner，同一 native 测试文件只由一份清单拥有。
7. `package.json` 增加不触网的 `verify:provider-checkpoint`，组合模块边界、小型行为套件、report validator、Electron native runner 与 typecheck。真实 Provider/站点验收仍单独运行，不伪装成 CI 必然可用。

这是结构 gate，可以读源码和统计行数；功能正确性仍必须由行为测试和真机证据证明。

## 6. 实施工单（严格按序）

### R0 反例锁定与 move-only 拆分

目标：在修功能前保留当前行为，并让后续改动进入健康边界。

步骤：

1. 先添加第 2 节的五个失败反例，记录修复前失败文本。五例分别放入新的 canonical-checkpoint native、Runner 单写者、typed-resume multiplicity native、live-report validator 和 paused-duration 小套件；在对应修复提交前不把这些已知为红的新文件接入公共 gate，也不继续操胖三个已超限测试文件。
2. 先按 5.2 → 5.3 做 checkpoint repository 与 run finalizer 的独立 move-only 拆分，并同步迁出 5.7 中的 checkpoint native 与 finalizer 大测试；Browser / Renderer 部分留到 P10–P12 之后的 R1，避免一个巨型纯重构批次遮住功能修复。
3. 每一个拆分小步都运行 `git diff --check`、`npm run typecheck` 和该域快速套件；不把多个巨型文件一次性重写后再统一调试。
4. 拆分阶段不改错误文案、不改状态映射、不改 SQL 条件、不改 marker schema。反例应在拆分后保持同样失败，其余基线保持绿色。
5. 此时的模块边界脚本先强制 5.2/5.3 的最终目标，并将尚未拆分的 Browser / Renderer 大文件锁在第 5.1 节的基线行数，不允许 R1 前继续增长。

反例文件名固定为：

- `src/__tests__/provider-checkpoint-canonical-terminal-native.test.ts`
- `src/__tests__/agent-session-runner-single-writer.test.ts`
- `src/__tests__/agent-session-typed-resume-multiplicity-native.test.ts`
- `scripts/__tests__/check-provider-confirmation-live-proof-report.test.cjs`
- `src/__tests__/agent-run-duration-meter-paused.test.ts`

R0 gate：

```bash
node scripts/check-provider-checkpoint-module-boundaries.cjs
npm run typecheck
npm run verify:browser-target-claims
npm run verify:stability
git diff --check
```

### P10 Browser checkpoint 正式收口

根因：`agent-session-checkpoint-store.ts` 只为 confirmation 和 human_takeover 生成 canonical notice；普通 `provider_transfer/budget/incomplete/steering/...` 返回 null。`run-finalizer` 又故意不为 checkpoint 生成普通 core closeout，因此提示语只留在 run_meta/transient output。

实施：

1. 在 `agent-session-checkpoint-canonical-notice.ts` 建立唯一事务内 writer，复用 `buildCanonicalCoreCloseoutMessage()` 的 checkpoint-scoped id。
2. 为 `writeCleanBoundary(role=suspension)` 建立必填的 public-notice 合同。confirmation/human takeover 继续从结构化 request 派生提示；其他 reason 由 `agent-sdk-browser-suspension.ts` 把本轮已确定的 `message` 显式传入 `persistSuspension()`，repository 只验证非空并在同一事务写入，不反向依赖 runtime-core 文案表。
3. `steering` 和 verifier-recovery 即使不能对外暴露恢复细节，也要由调用方传入通用“已保存，可继续”提示，不得用空字符串跳过 canonical。
4. `AgentSessionInputController.persistSuspension()` 在 repository 返回后立即用同一个私有 helper 将 canonical receipt 写入 turn runtime context，覆盖普通 typed suspension，不再只覆盖 `browserSuspensionRequest`。
5. Browser checkpoint 进入 `finalizeRunOutcome()` 前如没有 canonical receipt，必须 fail loud，不得带 `success=true` 发出无消息 done。
6. Renderer 仍只接受 Main canonical；无 canonical 时保留指标与错误可见性，不增加本地兜底伪消息。

行为矩阵：

- 13 个 `BrowserCheckpointSuspensionReason` 每类一例：assistant row 恰好 1，done receipt 与 DB 同 id/digest，projection/run/checkpoint 一致。
- 事务中注入 chat write/readback 失败：checkpoint pointer、run_meta、projection 均不得部分提交。
- 同一 checkpoint 重放：`ON CONFLICT` 不生成第二条消息，但回读 digest 必须相同，否则失败。
- provider_transfer 端到端例：本地可控 Provider 连续返回 502，生产管道最终显示可续跑暂停消息，两个 missing-canonical 指标为 0。

### P11 P8 owner-local session 单写者根修

实施：

1. 删除 `filterAndSyncRunnerSession()` 在 `callModelInputFilter` 中的 `clearSession/addItems`。
2. `agent-session-input-bindings.ts` 只暴露 pure filter 和 `prepareRunnerSession`；不再将 `ownerModelSession` 交给 filter callback。
3. 保留 `prepareRunnerSession` 作为 Runner 边界自愈，但重建后必须记录 previous/checkpoint count+digest，不记不可审计的空指标。
4. 利用当前 Agents SDK 对 `callModelInputFilter` 返回的 filtered `persistedItems` 支持，让 SDK 在 session persistence 阶段写入一次。如升级 SDK 改变此行为，真实 Runner 集成测试必须先失败。
5. retry 继续以 Runner 开始前 `baseItems` 恢复；测试断言失败 attempt 的输入/结果都不残留。

必须使用真实 `@openai/agents` `Runner` 和 `MemorySession`，只替换 ModelProvider 为确定性本地模型，不得手工模拟 SDK 的写入顺序。至少覆盖：

- fresh run 第一/第二 Runner iteration。
- filter 删除 confirmed-fact / observation-gap 变体。
- SDK 追加 assistant/tool 结果后没有重复的 new turn。
- 自动压缩后实际 Provider input 与 checkpoint/session 前缀一致。
- 一次 provider retry restore。
- 长轮次/滚动 checkpoint 触发点的 rebased/mismatch 为 0。

### P12 P7 恢复增量保重与一次消费

实施：

1. marker 改为唯一 schema：`{ version, wakeId, recoveryOrdinal, itemDigest }`。不保留当前未发布 v1 兼容分支。
2. `recoveryOrdinal` 是恢复 suffix 中的稳定序号，不是全量 input index；既能保留同内容项，又不因 clean prefix 长度改变身份。
3. `appendWithoutDuplicateDurableFacts` 对 typed-resume 项只按完整 marker identity 阻止“同一 recovery occurrence 被重复拼接”，不对内容相同的不同 occurrence 去重；现有 steering/verifier fact 的独立身份合同保持不变。
4. 第一 Provider 边界只删 marker metadata，不删 item；第二 Provider 边界不得重新注入。

Gate：budget/incomplete/steering/provider_transfer 四类各至少一例“压缩暂停 → typed 续跑 → clean_base 晋升 → suspension 指针清空 → 恢复顺序/重数保留 → 两次 Provider 边界 → rebase/mismatch 为 0”。至少一类放入两个完全相同的 recovery item，期望数量仍为 2。

### R1 Browser / Renderer move-only 拆分

P10–P12 全绿后，再对 5.4–5.6 的 BrowserController、AgentControlRuntime 相关域、Renderer 终态桥和真机 harness 做 move-only 拆分，同时完成 `runtime-driver-terminal-unlock.test.ts` 的套件迁移。这一批不改接管规则、UI 文案或 live-proof 判定；拆分前后 Browser 与 Renderer 基线必须一致。

R1 通过后，将 `scripts/check-provider-checkpoint-module-boundaries.cjs` 从“未拆文件不得继续增长”升级为第 5.8 节的最终边界和行数合同。不保留旧/新两套 BrowserController 业务实现。

### P13 P9 真实 target 接管与诚实 live proof

生产链：

1. `browser-human-takeover-runtime.ts` 合并当前两组重复的 agent-tab/target supervision listener，每个 `webContents.id` 只安装一组用户输入监听。
2. pointer/keyboard 事件不 `preventDefault`，但在异步持久前先关闭该 target 的 Agent 写栅栏。
3. navigate/back/forward/reload 共用一个 `requestNavigationTakeover()` 入口，输入 exact tab/physical target/claim/action identity，不用 active tab 兜底到另一 target。
4. `createHumanTakeoverIntent` 事务失败时保留 physical fence 并显示可见错误，不将写权退还旧 Agent。
5. 启动过期覆盖 held/user_owned/suspended 与 pending takeover，不依赖 TTL 等待。

真实信号 gate：

- Electron-native 测试创建隐藏 BrowserWindow 和真实 BrowserController/tab `webContents`，发送用户 pointer/key 输入，断言真实 repository 出现 takeover intent/checkpoint/claim 状态。
- 直接调用 BrowserController 的 navigate/back/forward/reload 公开方法，断言只接管指定 target。
- 同 target 活动 Agent action 的导航回声被抑制；无活动 action 和兄弟 target 不被抑制。
- 重启后旧 boot claim 全部 expired，新 target 可正常获得所有权。

live proof 改造：

1. `run-provider-confirmation-live-proof.mjs` 复用 `run-browser-live-grounded.mjs` 的 build/launch/nonce/manifest/asar/profile/DB handshake，不再附着未证明进程。
2. metric 路径从 handshake 运行的 `TMPDIR` 得出，文件缺失直接失败。
3. 报告必须断言 `live.ok=true`、非空 scope/run/task、非空 sendResult、可见 canonical message、可见确认卡、DOM 中允许/拒绝按钮与精确 target。
4. 指标按目标 runId 解析 JSON line，同时断言两个 missing-canonical metric 增量为 0。
5. restart 使用同一隔离 profile 和新 boot nonce，断言 confirmation expired、pending request 清空、旧按钮无法放行。
6. 新增独立 report validator 与负例测试；历史 `/tmp/ready-p9-live.3LxYLr/provider-confirmation-report.json` 必须被新 validator 拒绝。

### P14 暂停、等待与用时的 UI 真值

实施：

1. `RunDurationMeter` 的 checkpoint 标签只用 `waitingFor` 判断等待，不再将 `taskContinuation` / `resumableActions` 视为等待证据。
2. 可续跑但无用户交互时显示“本轮已暂停”；任务卡保留“继续”动作。
3. 时间数值继续在 terminal/checkpoint 时冻结，但 aria label 和可见文案明确它是“本轮用时”，不表示暂停已等了多久。
4. 不根据 `blockedReason` 自由拼文案；如需展示具体原因，走 `task-status-vocabulary.ts` 的穷举映射。

Gate：

- `waitingFor=confirmation/input/clarification` 显示等待；human takeover 使用当前合同的 `waitingFor=confirmation + interactionState=human_takeover`。
- `provider_transfer/budget/incomplete` + `waitingFor=none` 显示已暂停。
- checkpoint 无续跑句柄显示未完成。
- 三类都使用 `updatedAt-startedAt` 冻结用时，不脉冲。

### P15 18 关键词真实长任务最终验收

两层证明分开：

1. 确定性管道验收：隔离 profile + 本地可控 Provider/fixture，证明压缩、滚动 checkpoint、provider_transfer、typed resume、canonical 和 Renderer 状态链。
2. 真实外部验收：用用户授权的 novacode + 真实小红书页面重做 18 关键词任务。外网/Provider 不可用时只能标记 external proof pending，不得用本地 gate 代替。

真实验收使用新的时间戳目录或新文件名，不覆盖已有“首批”文件。通过条件：

- 18/18 required work items 都有匹配当前页面和目标字段的有效证据。
- Browser child `status=completed`，`progress_completed=progress_total`，`finished_at` 非空。
- 两份最终文件均回读成功，内容明确覆盖全部任务，不再声称“首批 5 个”。
- run `status=done`，Browser closeout seal 与 fresh verifier acceptance 齐全。
- 目标 run 只有一条 `run_close`，其 status 语义、terminal reason、initiator 与 duration 与 DB 终态一致。
- `chat_messages` 中恰好一条本 run 的最终 assistant canonical message，Main done 与 Renderer 显示同 id/digest。
- 目标 run 的 rebase/mismatch/missing-canonical 指标全为 0。
- 报告记录二进制 handshake、run/task/scope/checkpoint/message id、文件 path/hash/mtime、DB 回读和关键 metric 行。

## 7. 测试与验收矩阵

### 7.1 修复内循环

```bash
git diff --check
node scripts/check-provider-checkpoint-module-boundaries.cjs
node --test scripts/__tests__/check-provider-confirmation-live-proof-report.test.cjs
npm run typecheck
npx tsx --test --test-concurrency=1 \
  src/__tests__/agent-session-cursor-selfheal.test.ts \
  src/__tests__/agent-session-runner-single-writer.test.ts \
  src/__tests__/agent-run-duration-meter.test.ts \
  src/__tests__/agent-run-duration-meter-paused.test.ts
node scripts/run-provider-checkpoint-native-tests.cjs
```

SQLite 测试不得放在普通 Node 命令中靠 ABI skip 混过；它们只由最后一行的 Electron native runner 持有。

### 7.2 专项 gate

```bash
npm run verify:native
npm run verify:provider-checkpoint
npm run verify:browser-target-claims
npm run verify:agent-continuation-clock
npm run verify:browser-orchestration
npm run verify:browser-reliability
npm run verify:streaming
npm run verify:provider-checkpoint
npm run verify:stability
```

### 7.3 构建与真机

```bash
# handshake 驱动会先执行 build:dir
node scripts/run-browser-live-grounded.mjs --handshake-only
READY_BROWSER_LIVE_ACCEPTANCE_PROFILE='/absolute/path/to/dedicated-provider-profile' \
  node scripts/run-provider-confirmation-live-proof.mjs
node scripts/check-provider-confirmation-live-proof-report.cjs <report-path>
```

provider_transfer 还需一个可控 502 的真实管道验收；确认卡还需允许/拒绝两分支和重启 expired。真实 18 关键词外部运行在上述稳定 gate 全绿后才能开始。

### 7.4 硬失败条件

任一条出现即不得宣布完成：

- 目标 run 出现 rebase/mismatch 或 missing-canonical 指标。
- 报告 `ok/live.ok` 不是 true，或可见消息/任务卡/DOM 证据为空。
- metric 文件不存在却被解读为 0。
- native/SQLite 关键用例 skip。
- 拆分后 facade 再次吸收业务逻辑，或新模块超过行数上限。
- `agent-sdk-turn-execution.ts > 900` 或 `agent-sdk-turn-orchestrator.ts > 1000`。
- 只证明文件存在，但 Browser child/research state 仍是 paused/incomplete。
- 外部 Provider/站点运行失败却用本地 fixture 冒充外部验收通过。

## 8. 提交与工作树纪律

建议按以下独立 slice 提交，每个 slice 都能独立复审、回退并保持已有 gate 为绿。新反例先在工作树中证明为红，但与对应修复一起提交，不制造故意红的中间 commit：

1. `refactor(agent): split checkpoint and finalizer domains`
2. `fix(agent): persist canonical closeout for every browser checkpoint`
3. `fix(agent): restore owner-local session single writer`
4. `fix(agent): preserve typed resume recovery multiplicity`
5. `refactor(browser): split controller takeover and live proof domains`
6. `refactor(renderer): split terminal bridge and agent panel harness`
7. `fix(browser): prove real target takeover and fail-closed live acceptance`
8. `fix(renderer): distinguish paused runs from user waits`
9. `test(agent): close provider checkpoint live acceptance`

如当前 P7–P9 未提交改动需要先封装为一个基线 commit，必须先完成 slice 审计，不得带入无关 dirty files。本文档不授权自动 commit、push 或覆盖用户现有产物。

## 9. 最终文档收口

实施完成后只更新三个权威入口：

1. 本文档：每个工单的完成状态、精确测试数、EXIT code、真机报告路径和未通过项。
2. `docs/architecture/current-runtime-contracts.md`：只补充稳定的 checkpoint canonical 原子性、owner-local 单写者与暂停/等待 UI 真值。
3. `docs/code-health/large-file-health-log.md`：写入拆分后实际行数与健康判决；不用计划行数代替实际 `wc -l`。

旧 Provider 计划 §5.5–§5.6 保留为历史实施记录，但必须引用本文档的纠偏判决，不得再作为当前验收真值。

## 10. 新会话 handoff 文本

```text
Repo: /Users/user/实验田/ready-cowork-newtab
Branch baseline: feature/skill-envelope-floors, parent HEAD e4d01490e8, with the existing uncommitted P7–P9 slice preserved.

Read and execute, in order:
docs/archive/2026-09-06/docs/superpowers/plans/2026-07-23-provider-checkpoint-session-integrity-remediation-implementation.md

Start with §2 baseline preflight and the five failing regressions. Then execute the strict sequence R0 → P10 → P11 → P12 → R1 → P13 → P14 → P15, using the document's hard contracts and fail-closed gates. Do not trust the older plan's §5.5/§5.6 completed claims; this document supersedes them. Do not reset or discard the current uncommitted P7–P9 work. Do not commit/push unless explicitly requested.

The delivery is not complete until deterministic native gates, packaged runtime handshake, honest confirmation/provider-transfer live proofs, and the real 18-keyword external run all satisfy §3 and §7 with zero target-run rebase/mismatch/missing-canonical metrics.
```

## 11. 2026-07-23 实施记录

### 11.1 工单状态

| 阶段 | 状态 | 当前证据 |
| --- | --- | --- |
| §2 基线预检 | 完成 | 确认 branch `feature/skill-envelope-floors` / HEAD `e4d01490e8`，保留既有 P7–P9 dirty slice；五个反例先证明修复前失败，后续均进入公共 gate。 |
| R0 | 完成 | checkpoint repository、run finalizer 与三个超限测试套件按职责 move-only 拆分，稳定导出保留。 |
| P10 | 完成 | 13 类 Browser suspension reason 都在同一事务写入 checkpoint/projection/run/canonical notice；写入失败回滚，重放不生成第二条消息。 |
| P11 | 完成 | SDK Runner 是 owner-local session 唯一追加者；filter 不再 clear/add session。两轮真实 Runner 与 SDK 持久会去除瞬时 protocol id 的变体均为 rebase/mismatch 0。 |
| P12 | 完成 | typed resume identity 使用 `wakeId + recoveryOrdinal + itemDigest`，内容相同的两项保留两次并各自消费一次。 |
| R1 | 完成 | BrowserController/IPC、Browser continuation、Renderer terminal bridge 和 live harness 拆分；边界脚本强制依赖方向与行数上限。 |
| P13 | 完成 | 真实 BrowserController `webContents` 指针/键盘信号贯穿 exact target、claim、runtime port 和 repository 事务；report validator 对空可见消息、错 metric 路径、缺 handshake 和 `live.ok=false` 全部 fail closed。 |
| P14 | 完成 | Renderer 只用 `waitingFor` 区分等待，用续跑句柄区分已暂停/未完成；本轮用时在 checkpoint 冻结。 |
| P15 确定性部分 | 完成 | §7.2 九条 gate 在最后一次产品代码修正后全部 EXIT 0；Electron native ABI 146 实跑。 |
| P15 外部部分 | 待外部验证 | 真实小红书页面返回 `website-login/captcha` “安全验证”，要求用已登录账号的小红书 App 扫码。未用本地 gate 冒充通过，也未将该 run 记为完成。 |

### 11.2 最终确定性 gate（产品代码最后修正后）

| 命令 | 结果 |
| --- | --- |
| `npm run verify:native` | EXIT 0，Electron 42.3.0 / ABI 146 |
| `npm run verify:provider-checkpoint` | EXIT 0，小型行为 21/21，native 32/32 |
| `npm run verify:browser-target-claims` | EXIT 0，含真实 BrowserController signal 和 native checkpoint 套件 |
| `npm run verify:agent-continuation-clock` | EXIT 0 |
| `npm run verify:browser-orchestration` | EXIT 0 |
| `npm run verify:browser-reliability` | EXIT 0 |
| `npm run verify:streaming` | EXIT 0，194 pass / 1 非 native skip |
| `npm run verify:provider-checkpoint` | EXIT 0，含 native ABI 和 typecheck |
| `npm run verify:stability` | EXIT 0，主套件 133 pass / 21 条件 skip，Send IM 142 pass / 1 skip |

### 11.3 外部验收纪律

P15 仍不完成。扫码解除安全验证后，必须重新生成当前 source manifest 的安装包，再依次重跑 handshake、confirmation、provider transfer 和 18 关键词真实任务。只有两份新产物、Browser child 19/19、Parent/run/canonical/done/fresh verifier 全部一致，且四项 target-run metric 均为 0，才能把本文档状态改为 implemented 并宣布交付完成。

## 10. 对抗复核判决与双实例根因（2026-07-23，Claude）

### 10.1 判决

独立复核（135 文件、六 gate 本机复跑全绿）：**P8 单写者根修 PASS**（input filter 纯化、`filterAndSyncRunnerSession` 双写类结构性消除）；**P10 原子 canonical 收口 PASS**（全部 suspension reason 单事务 + fail-closed 回读）；**P12 重数 PASS**；**P14 UI 真值 PASS**；**P9/P15 验收诚实性 PASS——连续两轮造假的失败模式已关闭**（checker fail-closed + 11 个负例测试 + 真实打包运行报告，哈希/时间戳/id 均真；XHS 18 词证明为诚实待跑，checker 要求 18/18 否则非零）。Claude 第三轮五处修复全部完好。已提交 `22170d44`。

### 10.2 遗留缺口（编入后续，非运行时回归）

1. **§3.5 验证缺口**：真实 `Runner + MemorySession + callModelInputFilter` 的压缩/重试路径未被真 SDK 测试贯穿（现有真 Runner 测试恒 `compacted:false`、无重试）。filter 纯化使双写在这些路径也结构性不可能，但本计划自设的验收未交付——在曾经造假的领域必须补上。
2. **`rebased=0` 语义弱于宣称**：`prepareRunnerSession` 分支 1/2 静默重建会话不打指标，仅分支 3（有损全量重建）打点。指标语义应明示为"有损重建为 0"，或为静默重建补独立观测。
3. **BrowserController 拆分形态偏离声明**：实现为 10 级线性继承链而非 §5.4 声明的窄端口组合；`browser-controller-contract-base.ts`（760 行）未在 §5.4 申报。行为保持、gate 通过，但形态债务记档，后续拆分不得继续加深继承链。
4. 台账漂移已修正（runtime.ts 2603 仍危险补录；叶子最大 745→760）。

### 10.3 双实例根因与 P16（2026-07-23 实测 55 秒失败）

复测 run `req-1784772669864-9utcs8`（重试轮）取证结论：**provider 全程健康**（6 个正常回合、首字节 3517ms、零重试零 5xx）。02:11:29 第二个 Ready 主进程启动（共享同一 userData/SQLite），其 startup reconciler 把第一进程**在跑**的 run 当"上次进程遗留"清算，boot 过期逻辑清掉活体 claims → 浏览器工具连续失败 → 首进程终态写入被拒 `core_closeout_terminal_retry_conflict` → **幽灵 run**（无 run_close/run_meta/投影），卡片文案继承上一轮 checkpoint 的"模型服务暂时不可用"，与本轮死因无关。前一轮（poac9d）的 3×502→`checkpoint_provider_transfer` 可续跑收口则是 P2 正确工作。

**已修（Claude，commit `7a46c8a5`）**：`boot-entry.ts` 增加 userData 级 `requestSingleInstanceLock`（在 READY_USER_DATA_DIR 覆写之后取锁，隔离验收 profile 各持己锁互不干扰；`READY_ALLOW_MULTI_INSTANCE=1` 供工具链豁免）；`index.ts` second-instance 聚焦既有窗口；启动契约测试 10/10。运行时"启动=上个进程已死"的建模自此有锁背书。

**P16（Codex，后续）**：
1. 冲突败者记账 fail-closed：`core_closeout_terminal_retry_conflict` 等终态写入冲突的败者必须仍写出自身 run_close 指标与 run_meta（interrupted/superseded）终态行，禁止幽灵 run；
2. 重试轮卡片归因：重试 run 的失败文案必须描述本轮真实死因，不得继承上一轮 checkpoint 的原因文案（"可以继续"仍由既有 checkpoint 背书，二者分离呈现）；
3. Gate：注入终态写入冲突 → 败者有终态行 + 卡片归因正确；双实例场景由单实例锁合同测试覆盖，不再作为运行时可达路径。
