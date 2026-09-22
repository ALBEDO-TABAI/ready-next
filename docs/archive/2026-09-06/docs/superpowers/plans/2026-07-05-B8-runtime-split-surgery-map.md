---
title: B8 Runtime Split Surgery Map — runtime.ts + skills-runtime/runtime-manager.ts
date: 2026-07-05
status: proposed
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# B8 拆分手术图（非破坏盘点）

> 只读盘点，不改源文件。所有结论带行号证据，未逐字节核实处标 **待核**。
> 方法学承接 B4–B7（browser-tools.ts 6285→713 薄门面）：能力缝抽组、facade re-export、
> 每组 typecheck+focused 绿、逐字节 cmp。路线预判见 `2026-07-03-agent-mainline-p3-route.md:65`。

## 0. 执行摘要（三分账 + 第一刀）

| 文件 | 总行 | P（纯移动） | D（委托提取） | X（不可拆/facade核心） | imports |
|---|---|---|---|---|---|
| runtime.ts | 4327 | ~300（178–393 顶层块 + 静态 helper） | ~2700（12 个能力簇） | ~1160（constructor/lifecycle/sendScoped 枢纽） | ~177 |
| runtime-manager.ts | 3800 | ~450（顶层 types/helpers + 尾部 helper） | ~2980（11 个松耦合子系统） | ~230（constructor/单例/跨簇胶水） | ~141 |

**架构判断**
- runtime.ts 是 **hub-and-spoke**：`sendScoped`+run-dispatch（1819–2283）+ `start/stop`（787–974）+ constructor（557–673）是重整合枢纽（X），四周挂 12 个能力簇（D）。三条预判缝**已被大量预抽取**（`CrystallizeScheduler`/`RunProjection`/`RunCoordinator` 已是注入类），runtime 里剩薄适配层。
- runtime-manager.ts 是 **subsystem toolbox**：11 个子系统只共享只读路径字段（`runtimeRoot`/`venvRoot`/`cacheRoot`…）+ 几个 Map，彼此几乎不交叉 → D 占压倒多数，是比 runtime.ts **更干净**的拆分对象。

**推荐第一刀**：runtime.ts `178–393`（顶层纯函数+类型块，~216 行）逐字节搬到 `runtime-helpers.ts`，从 runtime.ts re-export。零 `this`、零行为变更、可无人值守，与 B4–B7 同法。紧随其后可再做 runtime-manager 顶层 types/helpers 纯搬（~338 行），两刀合计削 ~550 行且零风险，为后续 D 级监督工作建立 facade 势能。

---

## 1. 对象一：src/main/modules/agent-control/runtime-core/runtime.ts

### 1.1 结构清单

**顶层符号（1–393）**
| 行 | 符号 | 类别 |
|---|---|---|
| 1–177 | imports（含已抽取子服务，见 §1.2） | infra |
| 178–206 | `buildStudioPrerouteActions()` | 纯函数 |
| 209–215 | `UpsertChannelPayload`（export） | 类型 |
| 217–225 | `UpsertSchedulePayload`（export） | 类型 |
| 227–262 | `ActiveChildRunSummaryForRuntime` / `TaskProjectionChildSummaryRow` / `PendingInboundChannel` | 类型 |
| 263–393 | `parseRecordJson` `parseArrayJson` `asRecord` `parsePendingTaskEventPayload` `resolvePendingTaskEventScopeId` `readScopeIdFromPendingEvent` `summarizePendingTaskEvent` `buildPendingTaskNarrationPrompt` `stringFromUnknown` `progressFromUnknown` `artifactMetaString` `childRunSummaryStatusFromProjection` `canRespondToUserInteractionWithoutResumeHandle` | 纯函数 |
| 394–4327 | `class AgentControlRuntime extends EventEmitter` | 主体 |

**私有字段（395–555）— 已按归属簇标注**
| 行 | 字段 | 归属簇 | 说明 |
|---|---|---|---|
| 395 | `db` | **枢纽（共享76次）** | 全类粘合剂，注入引用 |
| 398–404 | `agentRegistry` `settingsRepository` `sidecar` `orchestrator` `toolGateway` `memoryRepository` `memoryLifecycle` | 枢纽/lifecycle | `sidecar` 共享51次 |
| 410–411 | `lastCrystallizeRunAt` `crystallizeScheduler` | crystallize | scheduler 已是独立类 |
| 412–416 | `userProfileRepository` `agentPersonalityRepository` `externalMemoryProviderSlot` `sessionRecallService` `reflectionService` | recall/persona | `sessionRecallService` 已是独立类 |
| 474 | `promptAssembly` | 枢纽 | 已是独立类 |
| 513–518 | `agentManager` `runCoordinator` `runProjection` `taskProjectionStore` `pendingProjectionSyncs` `sessionPrerouteTraces` | 枢纽/projection/preroute | 均已是独立类/repo |
| 519–522 | `knowledgeWatcher` `beliefCardStore` `skillTaskRunRepository` `detachedSkillTasks` | crystallize/detached | `detachedSkillTasks` 已是独立类 |
| 523 | `autoNarrationContinuationRunner` | narration | 已是独立类 |
| 531 | `pendingInboundChannels` | remote-channel | 簇独占 |
| 535 | `pollTimer` | sidecar-poll | 簇独占（定时器） |
| 536 | `scopeRunSummaries` | projection（枢纽共享） | run-dispatch 也读 |
| 537,541,542 | `lastSidecarRestartAttemptAt` `channelStateCache` `lastAdapterRestartAttemptAt` | sidecar-poll/channel | |
| 543 | `heartbeat` | lifecycle/status（共享14次） | |
| 553–555 | `projectionSyncRetryDrainInFlight` `projectionSyncRetryTimer` `projectionSyncRetryTimerDueAt` | **projection（簇独占）** | 定时器三件套，唯一 §3689–3843 区读写 |

**类内方法群分段（构造/生命周期/各能力簇 + 引用字段集）**

| 簇 | 方法（行） | 主要私有字段 | 共享度 |
|---|---|---|---|
| **constructor / host 装配** | `constructor`(557–673)、`getDomainAdapters`(779) | 全部注入类 | X：闭包捕获 this |
| **accessor facade** | `getOrchestrator`(674)…`getBeliefCardMirrorDb`(725)、`getExternalMemoryProviderSlot`(783)、`getTaskProjectionStore`(1023)、`getRunMetaRepository`(1027)、`getAgentRegistry`(1033)、`getSpecialistContentEditProposalStore`(1037)、`applyKnowledgeSystemEnabled`(1041) | 返回 this.X | X：facade 表面 |
| **crystallize/decay** | `runCrystallizeRoundOnce`(736–778) | `db` `lastCrystallizeRunAt` `crystallizeScheduler` `beliefCardStore` | D（薄，重逻辑已在 crystallize-gate/belief-decay） |
| **lifecycle** | `start`(787)、`stop`(848)、`startSidecar`(869)、`getRuntimeStatus`(884)、`getCapabilityRuntimeSnapshot`(936) | `heartbeat` `sidecar` `orchestrator` `db` `pollTimer` `knowledgeWatcher` `crystallizeScheduler` | X：boot 指挥（启动所有子系统） |
| **channel-config** | `listChannels`(975)、`isChannelTypeAvailable`(980)、`upsertChannel`(2284)、`deleteChannel`(2312)、`setChannelEnabled`(2320)、`sendChannelProbe`(2342)、`recordChannelDeliveryResult`(2364)、`testChannel`(2377)、`startWechatLogin`(2398)、`getWechatLoginStatus`(2424)、`submitWechatLoginVerifyCode`(2431)、`mapChannelRow`(3269) | `db` `sidecar` `channelStateCache` | D |
| **session-preroute** | `evaluateSessionPreroute`(1058)、`simulateSessionPrerouteForStudio`(1108)、`listRecentSessionPrerouteTraces`(1191) | `sessionPrerouteTraces`（独立类） | **D（低风险）** |
| **narration-continuation** | `hasActiveNarrationContinuationRun`(1195)、`startNarrationContinuationFromPending`(1208)、`markNarrationContinuationFailure`(1310)、`resolvePendingTaskEventScopeId`(1333) | `autoNarrationContinuationRunner`（独立类）、`db` `orchestrator` | D |
| **task-projection 查询** | `listScopeRuns`(999)、`listRecentTaskProjections`(1353)、`listTaskProjections`(1357)、`listTaskProjectionsByOwner`(1378)、`getTaskProjection`(1383) | `taskProjectionStore` | D |
| **session-recall** | `searchSessionRecall`(1395)、`listRecentSessions`(1408)、`getSessionRecallCapsule`(1420)、`listAttachedSessionRecallContexts`(1424)、`attachSessionRecallContext`(1617)、`detachSessionRecallContext`(1633)、`resumeSessionCandidate`(1649)、`maybeAutoAttachSessionRecallOnResume`(3492) | `sessionRecallService`（独立类）、`db` | **D（低风险）** |
| **reference-hint** | `getReferenceSkillHint`(1428)、`persistReferenceHintAfterAssistantMessage`(1483)、`restoreReferenceHintFromScope`(3464)、`maybeArmReferenceHintFromCapsules`(3524)、`persistReferenceHintToScope`(3559) | 内存 hint 状态字段 **待核**、`db` | D |
| **detached-skill** | `startDetachedSkillAction`(1490)、`inspectDetachedSkillTask`(1504)、`listDetachedSkillTasks`(1512)、`cancelDetachedSkillTask`(1516)、`publishRestoredDetachedSkillTasks`(3590)、`buildDetachedSkillArtifacts`(3598)、`publishDetachedSkillTaskUpdate`(3630) | `detachedSkillTasks`（独立类）、`skillTaskRunRepository` | **D（低风险）** |
| **child-runs** | `listActiveChildRuns`(1524)、`listActiveChildRunsWithDiagnostics`(1535)、`listProjectionBackedChildRunSummaries`(1552)、`cancelChildRun`(1613) | `taskProjectionStore` `orchestrator` `db` | D/X 边界（projection-truth 耦合 **待核**） |
| **conversation-scope CRUD** | `listConversationScopes`(995)、`getConversationScope`(1656)、`getConversationScopeMessages`(1661)、`deleteConversation`(1665)、`createLocalScope`(1785)、`createLocalScopeWithMode`(1798)、`mapConversationRow`(3299)、`mapMessageRow`(3320)、`ensureChannelScope`(3331)、`refreshScope`(3396)、`createConversationMessage`(3402)、`parseScopeMeta`(3433)、`extractTextFromMessage`(3477) | `db`（重，76 次中大量在此） | D（db 重共享，**Phase C 会话生命周期落点**） |
| **scope-attachments** | `listScopeAttachments`(1677)、`getScopeAttachment`(1701)、`getRemoteAttachmentCacheStats`(1707)、`clearRemoteAttachmentCache`(1756) | `db` | D |
| **run-dispatch（枢纽核心）** | `sendScoped`(1819)、`recoverUndeliveredAnswerForRun`(2010)、`finalizeStaleWithoutHandleProjectionsForScope`(2021)、`suspendRun`(2041)、`reportInfrastructureTimeout`(2120)、`resumeRun`(2188)、`respondToInteraction`(2231)、`resolveTaskControlTarget`(3871)、`buildContinuationIntent`(3909) | `orchestrator`(7) `runCoordinator` `taskProjectionStore` `db` + 调入 ~15 簇 | **X：整合中心** |
| **schedule** | `listSchedules`(2438)、`upsertSchedule`(2443)、`pauseSchedule`(2469)、`resumeSchedule`(2477)、`deleteSchedule`(2485)、`runScheduleNow`(2492)、`executeSchedule`(2620)、`mapScheduleRow`(3283) | `db` `sidecar` | D |
| **sidecar-poll** | `syncDatabaseToSidecar`(2498)、`ensurePollLoop`(2529)、`pollSidecarEvents`(2536)、`reviveErroredAdapters`(2598) | `pollTimer` `lastSidecarRestartAttemptAt` `lastAdapterRestartAttemptAt` `heartbeat` `channelStateCache` `db` `sidecar` | D（定时器风险） |
| **remote-channel / inbound-IM** | `handleInboundChannel`(2634)、`getInboundCoalesceWindowMs`(2654)、`enqueueInboundChannelEvent`(2660)、`markInboundChannelEvents`(2707)、`describeInboundChannelFailure`(2723)、`collectOutboundChannelAttachments`(2753)、`channelSupportsOutboundAttachments`(2815)、`channelAttachmentTypeFromPath`(2820)、`maybeEmitRemoteCalendarSuggestions`(2848)、`flushInboundChannel`(2897)、`parseInboundChannelCommand`(3105)、`handleInboundChannelCommand`(3117)、`startNewRemoteChannelSession`(3161)、`completeInboundChannelCommand`(3180)、`formatRemoteCommandHelp`(3217)、`formatRemoteCommandStatus`(3227)、`formatRemoteModelCommand`(3247)、`formatAIModelConfig`(3263)、`getRemoteChannelSessionSettingKey`(3376)、`getScopedRemoteThreadKey`(3385)、`parseChannelAttachments`(3982)、`describeChannelAttachments`(4009)、`formatChannelAttachmentSummary`(4026)、`buildInboundChannelPayload`(4042)、`tryInlineChannelAttachment`(4075)、`mimeTypeFromExt`(4123)、`splitLongText`(4156)、`sendChannelReply`(4169)、`sendLongTextToChannel`(4209)、`toChannelKey`(4323) | `pendingInboundChannels`（独占）、`db` `sidecar` `runCoordinator` `getDomainAdapters` + conversation helpers | D（**最大可削块 ~880 行**，注入面最宽 → 高风险） |
| **projection sync** | `emitConversationEvent`(3689)、`emitScopeRunEvent`(3693)、`publishScopeRunEvent`(3698)、`recordScopeRunEvent`(3702)、`handleProjectionSyncFailure`(3717)、`clearProjectionSyncRetryTimer`(3760)、`scheduleTerminalProjectionSyncRetryDrain`(3768)、`drainTerminalProjectionSyncRetries`(3797)、`recordRunProjectionEvent`(3824) | **`pendingProjectionSyncs` `projectionSyncRetryTimer/DueAt/DrainInFlight`（簇独占）**、`runProjection`（独立类）、`taskProjectionStore` `scopeRunSummaries` | **D（干净，仅缺注入 emit 回调）** |
| **boot/misc** | `maybeAssertSkillTaskRunInvariant`(3844)、`cleanupLegacyCopawSettings`(4266)、`reflectOnConversation`(4286)、`tryParseJson`(4238)、`getSettingBool`(4246)、`parsePortSetting`(4255) | `db` / 纯 | X（boot）+ P（后三个纯 helper） |

### 1.2 能力缝判定（逐条核实预判 + 补充实测缝）

路线预判（`2026-07-03-agent-mainline-p3-route.md:65`）：runtime.ts 缝 = **crystallize/decay 调度、projection 接口、host 装配**。核实结论：**三条皆真，但重逻辑已预抽取，runtime 里剩薄适配。**

**缝① crystallize/decay 调度 — 真，但已大半抽走（低价值）**
- 涉及方法：`runCrystallizeRoundOnce`(736–778，43 行)。私有字段：`db` `lastCrystallizeRunAt` `crystallizeScheduler` `beliefCardStore`。
- 证据：调度器 `CrystallizeScheduler` 是 field 411 的独立注入类；方法体 736–778 全部委托 import 的自由函数 `runCrystallizeRound`/`createCrystallizeEffectors`/`runBeliefDecayRound`/`collectBeliefDecaySignals`/`createBeliefDecayEffectors`（import 见 `runtime.ts:134`、`:52`）。
- 共享度：`beliefCardStore`/`db` 与 lifecycle 共享；`lastCrystallizeRunAt` 簇独占。
- 外部调用者：无直接外部调用；由 `start()`(787) 与 `crystallizeScheduler` tick 内部驱动。
- 判定：缝真，但只剩 43 行胶水 → 拆出收益低，列 D（可选）/近 X。

**缝② projection 接口 — 真，且是最干净的 D 级候选**
- 涉及方法：`emitScopeRunEvent`/`publishScopeRunEvent`/`recordScopeRunEvent`/`handleProjectionSyncFailure`/`clearProjectionSyncRetryTimer`/`scheduleTerminalProjectionSyncRetryDrain`/`drainTerminalProjectionSyncRetries`/`recordRunProjectionEvent`（3693–3843，~155 行）。
- 私有字段：**`pendingProjectionSyncs`、`projectionSyncRetryTimer`/`DueAt`/`DrainInFlight` 为本簇独占**（grep 确认所有读写都在 3717–3843）；`runProjection`(87 已是类)、`taskProjectionStore`(共享注入)、`scopeRunSummaries`(与 run-dispatch 共享)。
- 共享度：低。唯一外向依赖是 `this.emit('scopeRunEvent'|'conversationEvent'|'projectionSyncFailed')`（EventEmitter）与 import 的自由函数 `syncTaskProjection`(88)/`drainPendingProjectionSyncs`。
- 外部调用者：`publishScopeRunEvent`/`recordScopeRunEvent` 被 constructor 注入给 `runCoordinator`(590)、`configureSkillChildRunner`(634)；`ipc/task-projection-group` 读投影查询。事件被 `claude-bridge/ipc-handler` 转发 renderer。
- 判定：**真缝，D 级最佳首选**。抽 `ProjectionSyncCoordinator`：持 `{pendingProjectionSyncs, retry 三件套}`，注入 `{taskProjectionStore 引用, emit 回调, syncTaskProjection, drainPendingProjectionSyncs}`。风险点：`setTimeout`+`unref`(3773–3781)、fire-and-forget catch(3708)、emit。

**缝③ host 装配 — 真，X 级（this 闭包纠缠），但 boot 断言已抽走**
- 涉及方法：`constructor`(557–673，117 行)。装配：`orchestrator`/`runCoordinator`/`runProjection`/`detachedSkillTasks` 均以注入回调构造（回调闭包捕获 `this.*`）；调 `configureSkillChildRunner`(619)、`registerDetachedSkillTaskTracker`(614)、`registerPendingTaskEventListener`(672)。
- 已抽取：boot 断言 `maybeAssertSkillTaskRunInvariant`(3844)+`assertStageNChildLoopInvariants`+`defaultToolRegistry.listToolDefinitions()` 均已是自由函数/独立方法。
- 判定：装配本体 X（不可无损搬）；但 `maybeAssertSkillTaskRunInvariant`(3844–3870) 只用 `this.db.getRawDb()`，可降为收 db 参的 P 级自由函数（低价值）。

**补充实测缝（预判未列，实测发现）**
- **缝④ remote-channel / inbound-IM（最大缝，~880 行）**：`handleInboundChannel`…`sendLongTextToChannel`+附件 helper（见 §1.1 表）。字段 `pendingInboundChannels` 独占。外部调用者：`pollSidecarEvents`(2536) 内部驱动；无 IPC 直连。共享 `db`/`sidecar`/`runCoordinator`/`getDomainAdapters`/conversation helpers（注入面最宽）。D（高风险高收益）。
- **缝⑤ 能力簇⇔IPC 组一一对应（强证据）**：runtime 公有方法表面**已按能力分组**，与 `claude-bridge/ipc/*-group.ts` 精确对齐——
  - `channel-management-group` → channel-config（`upsertChannel`/`deleteChannel`/`setChannelEnabled`/`sendChannelProbe`/`testChannel`/wechat 三件套）
  - `conversation-group` → conversation-scope+attachments（`createLocalScopeWithMode`/`getConversationScopeMessages`/`listConversationScopes`/`listScopeRuns`/`listScopeAttachments`/`getScopeAttachment`/`*RemoteAttachmentCache`）
  - `recall-group` → session-recall+reference-hint（`attach`/`detach`/`getReferenceSkillHint`/`getSessionRecallCapsule`/`listAttached`/`listRecentSessions`/`resumeSessionCandidate`/`searchSessionRecall`）
  - `detached-task-group` → detached-skill（`start`/`inspect`/`list`/`cancel DetachedSkillTask`）
  - `schedule-group` → schedule（`upsert`/`list`/`pause`/`resume`/`runScheduleNow`/`delete Schedule`）
  - `task-projection-group` → task-projection 查询（`getTaskProjection`/`listTaskProjections`）
  - 意义：每个 D 簇的外部调用面 = 单一 IPC 组调其公有方法。facade 保留公有名委托子服务即行为不变，且 IPC 组是天然的整簇集成验证面。
- **缝⑥ session-preroute / narration / detached / projection = 「已备类」薄适配簇**：这四簇的重逻辑已在独立类（`SessionPrerouteTraceRingBuffer`/`AutoNarrationContinuationRunner`/`DetachedSkillTaskTracker`/`RunProjection`），runtime 方法是薄 adapter → **D 级最低风险**。

### 1.3 拆法分级

**P 级（纯移动，可无人值守）**
| 内容 | 行 | 预计行数 | 备注 |
|---|---|---|---|
| 顶层解析/类型 helper 块 | 178–393 | ~216 | 已全是 module 自由函数/类型；搬 `runtime-helpers.ts`+`runtime-preroute-actions.ts`，re-export |
| 静态 helper 降级（`mimeTypeFromExt`,`splitLongText`,`formatRemoteCommandHelp`,`formatAIModelConfig`,`describeChannelAttachments`,`formatChannelAttachmentSummary`,`tryParseJson`,`getSettingBool`,`parsePortSetting`,`toChannelKey`,`buildContinuationIntent`?） | 散见 3217/3247/3263/4009/4026/4123/4156/4238/4246/4255/4323/(3909待核) | ~85–160 | 私有方法体不含 `this` 者可降自由函数（改 `this.x`→`x` 调用点）。`buildContinuationIntent` 纯度**待核** |
| **P 小计** | | **~300（保守）–~400（含降级）** | |

**D 级（委托类提取，需在场/主会话监督）**
| 候选子服务 | 字段迁移面 | 方法清单（行） | 需注入接口 | 风险点 | 预计行数 |
|---|---|---|---|---|---|
| `ProjectionSyncCoordinator` | `pendingProjectionSyncs`,`projectionSyncRetryTimer/DueAt/DrainInFlight`（独占） | 3693–3843 | `{taskProjectionStore, emit(evt,payload), syncTaskProjection, drainPendingProjectionSyncs, scopeRunSummaries}` | setTimeout+unref、fire-and-forget、emit | ~155 |
| `SessionPrerouteService` | `sessionPrerouteTraces`（独立类） | 1058–1194 | `{db, agentRegistry, buildStudioPrerouteActions(P)}` | 无（低） | ~137 |
| `DetachedSkillService` | `detachedSkillTasks`,`skillTaskRunRepository`（独立类/repo） | 1490–1523,3590–3688 | `{emit/publishScopeRunEvent}` | emit | ~132 |
| `NarrationContinuationService` | `autoNarrationContinuationRunner`（独立类） | 1195–1352 | `{db, orchestrator/sendScoped}` | 事件监听(672) | ~158 |
| `SessionRecallFacade` | `sessionRecallService`（独立类） | 1395–1428,1617–1655,3492–3523 | `{db}` | 无（低） | ~130 |
| `ReferenceHintService` | hint 内存字段 **待核** | 1428–1489,3464–3476,3524–3589 | `{db}` | TTL/scope 状态 | ~140 |
| `ChannelConfigService` | `channelStateCache` | 975–994,2284–2437,3269 | `{db, sidecar, emit}` | sidecar 重启 | ~174 |
| `ScheduleService` | — | 2438–2497,2620–2633,3283 | `{db, sidecar}` | cron | ~74 |
| `SidecarPollService` | `pollTimer`,`lastSidecarRestartAttemptAt`,`lastAdapterRestartAttemptAt`,`heartbeat`(共享),`channelStateCache` | 2498–2633 | `{db, sidecar, handleInboundChannel 回调, reviveErroredAdapters}` | 定时器+重启单例 | ~135 |
| `ConversationScopeStore` | 无独占（全 `db`） | 995,1656–1818,3299–3475 | `{db}`（重） | db 重共享 | ~340 |
| `ScopeAttachmentService` | — | 1677–1784 | `{db}` | 缓存 | ~108 |
| `RemoteChannelService` | `pendingInboundChannels`（独占） | 2634–3260,3982–4237 | `{db, sidecar, runCoordinator, getDomainAdapters, conversation helpers, settings, emit}` | 注入最宽、合并定时器、外发附件 | ~880 |
| `CrystallizeRoundRunner`（可选） | `lastCrystallizeRunAt`,`crystallizeScheduler`(独立类) | 736–778 | `{db, beliefCardStore, mirrorDb}` | 已大半抽走，收益低 | ~43 |
| **D 小计** | | | | | **~2700** |

**X 级（不可拆/不值得拆）**
| 内容 | 行 | 原因 |
|---|---|---|
| 字段声明块 | 395–555 | 与全类状态；~10 字段随各 D 簇迁走，其余（db/sidecar/orchestrator…）留守 |
| constructor / host 装配 | 557–673 | 注入回调闭包捕获 this |
| accessor facade | 674–736,783,1023–1057 | 就是对外表面，须留守委托 |
| lifecycle start/stop/status | 787–974 | boot 指挥，串联启动所有子系统 |
| run-dispatch 枢纽 | 1819–2283,3871–3981 | `sendScoped` 调入 ~15 簇，整合中心 |
| child-runs | 1524–1616 | projection-truth 耦合（D/X 待核） |
| boot/misc | 3844–3870,4266–4285,4286–4322 | boot 断言/一次性清理/reflection |
| **X 小计** | | **~1160** |

---

## 2. 对象二：src/main/modules/skills-runtime/runtime-manager.ts

### 2.1 结构清单

**顶层符号（1–508）**
| 行 | 符号 | 类别 |
|---|---|---|
| 1–141 | imports + `electronModule`(15)/`app,session`(19) | infra |
| 142–166 | 常量：`execFileAsync` `INSTALL_STATE_FILENAME` `EMBEDDED_SYNC_STATE_FILENAME` `PYTHON_RUNTIME_STATE_FILENAME` `CUSTOM_VENV_MARKER` `DOMESTIC_PIP_INDEX_URL` `MAX_COMMAND_BUFFER` `DIRECT_ACTION_INMEMORY_CAP` `DEFAULT_TIMEOUT_MS` `SCHEDULER_INTERVAL_MS` | 常量（P） |
| 171–221 | `SkillDeploySpawn` `SkillRunStatus` `normalizeSkillRunStatus`(179) `mergeSkillRunStatus`(189) `envNumber`(198) `RETIRED_EMBEDDED_SKILL_IDS`(218) `SkillTriggerType` `SkillId` | 类型+纯 helper（P） |
| 223–244 | `hashDirectoryContents`(223) | 纯 helper（P） |
| 245–461 | `SkillState` `SkillsRuntimeInfo` `SkillInstallState` `PythonRuntimeState` `SkillsRuntimeManagerOptions` `SkillInstallResult` `SkillRunResult` `SkillRunRequest` `SkillJobRow` `SkillScheduleRow` `DatabaseStatement` `DatabaseConnection` `SkillJobRecord` `SkillScheduleRecord` `CreateSkillScheduleRequest` | 类型（P） |
| 463–508 | `asString` `asNumber` `asBoolean` `truncateOutput` `getInstallStatePath` `requirementsDigest` | 纯 helper（P） |
| 509–3669 | `class SkillsRuntimeManager` | 主体 |
| 3671–3712 | `runtimeManager` 单例 + `getSkillsRuntimeManager`(3673) + `__setSkillsRuntimeManagerForTests`(3686) | 单例胶水（X） |
| 3714–3800 | `StartSkillChildRunAndWaitParams`/`Result` 类型 + `startSkillChildRunAndWait`(自由 async helper，lazy import) | P（自由 helper） |

**私有字段（510–559）**：只读路径 `runtimeRoot`(510) `skillsRoot` `customSkillsRoot` `venvRoot` `customVenvsRoot` `runtimeBin` `cacheRoot` `modelscopeCache` `pipCache` `outputsRoot` `packagedRuntimeRoot` `packagedRuntimeManifest` `embeddedSkillsRootOverride` `hostControllerOverride` `retiredEmbeddedSkillIdsOverride` `externalServiceStore`(527) `skillConfigurationStore`(528) + 槽 `loader`(530) `runtimeProvisioner`(531) + Map/Set `installLocks`(532) `runningScheduleIds`(538) `modelPackDownloads`(541) `modelPackDownloadStatuses`(542) `skillInstalls`(546) `skillInstallStatuses`(547) + 定时器 `schedulerTimer`(533) `referenceHintBootTimer`(534) `referenceHintIntervalTimer`(535) `outputDirSweepBootTimer`(536) `outputDirSweepIntervalTimer`(537) + `orphanCleanupRan`(539) `defaultDeploySpawn`(550) + static `REFERENCE_HINT_*`(558–559)。

**类内方法群分段（子系统 + 引用字段集）**
| 子系统 | 方法（行） | 独占字段 | 共享（注入面） |
|---|---|---|---|
| **constructor/dirs** | `constructor`(561–593)、`ensureRuntimeDirs`(3177)、`resolveEmbeddedSkillsRoot`(3188)、`getSkillRuntimePath`(3241)、`resolveOutputDir`(3538) | 路径字段 | — |
| **listing/config** | `getSkillLoader`(685)、`toSkillState`(692)、`listSkills`(717)、`getSkillConfiguration`(730)、`updateSkillConfiguration`(737)、`getRuntimeInfo`(744) | `loader`,`skillConfigurationStore` | 路径 |
| **model-pack** | `getModelPackStatus`(755)、`listModelPacks`(771)、`startModelPackDownload`(775)、`cancelModelPackDownload`(916)、`selfTestModelPacks`(938)、`runModelPackIntegrityScratchCheck`(1079)、`getModelPackTargetDir`(1130)、`getModelPackPartialDir`(1134)、`getModelPackDownloadState`(1138)、`getMissingModelPackFiles`(1142)、`finalizeModelPackDownload`(1157)、`describeModelProvider`(1179)、`probeEndpointLatency`(1187)、`buildFunasrNanoRuntimeEnv`(1206)、`buildFunasrFallbackModelEnv`(1226)、`buildModelPackDownloadEnv`(1250) | `modelPackDownloads`,`modelPackDownloadStatuses` | `cacheRoot`,`modelscopeCache` |
| **external-env/cookies** | `resolveConfiguredAgentContext`(1267)、`requiresExternalEnv`(1274)、`resolveExternalEnv`(1281)、`exportBrowserVideoCookies`(1353)、`cleanupExportedVideoCookieFile`(1391) | — | `externalServiceStore` |
| **host-prep** | `getHostController`(595)、`shouldPrepareSkillHost`(1404)、`runEmbeddedPython`(1450) | `hostControllerOverride` | getBaseEnv |
| **install pipeline** | `getSkillInstallStatus`(1507)、`resolveSkillSource`(1517)、`installSkillFromSource`(1624)、`cancelSkillInstall`(1795)、`describeSkillMirror`(1812)、`stagedSkillRequiresPython`(1822)、`fetchInstallDocText`(1839)、custom-venv（`getCustomSkillVenvDir`1861/`getCustomVenvPython`1865/`peekCustomSkillVenv`1874/`resolveCustomVenvBasePython`1891/`ensureCustomSkillVenv`1907/`buildCustomSkillDeployEnv`1938/`deploySkillRequirements`1954/`skillInstallAbortError`2003）、`installSkillInternal`(3055) | `skillInstalls`,`skillInstallStatuses`,`installLocks` | 路径,`defaultDeploySpawn` |
| **custom-skill CRUD** | `importCustomSkill`(2009)、`removeCustomSkill`(2045)、`updateCustomSkillDescription`(2050) | — | `customSkillsRoot`,`loader` |
| **ensure/provisioner 胶水** | `ensureSkillInstalled`(2072)、`getRuntimeProvisioner`(2091) | `runtimeProvisioner` | 跨簇 |
| **execution engine** | `runSkillFromChildRunner`(2175)、`runSkill`(2179)、`invalidParams`(2316)、`buildActionArgs`(2329)、`resolveSkillForExecution`(2359)、`runDefinitionActionDirect`(2375)、`runDirectScript`(2504)、`createStructuredResultPath`(2535)、`executeProcessWithStructuredResult`(2541)、`toDirectRunResult`(2729) | — | getBaseEnv,outputs,structured-result |
| **jobs/schedules** | `listJobs`(2799)、`listSchedules`(2807)、`createSchedule`(2814)、`updateScheduleEnabled`(2858)、`deleteSchedule`(2869)、`getRawDatabase`(2877)、`mapJobRow`(2885)、`mapScheduleRow`(2905)、`parseJson`(2920)、`recordJobStart`(2928)、`recordJobFinish`(2956)、`startScheduler`(2987)、`runSchedulerTickSoon`(2995)、`tickSchedules`(3001)、`runScheduledTask`(3018) | `schedulerTimer`,`runningScheduleIds` | DB |
| **embedded-sync** | `syncEmbeddedSkill`(3202)、`assertPackagedRuntimeCoversEmbeddedSkill`(3399) | — | `packagedRuntime*` |
| **python-runtime** | `ensurePythonVenv`(3245)、`ensurePythonRuntimeReady`(3314)、`getVenvPythonPath`(3348)、`findPythonExecutable`(3355)、`resolvePackagedPythonPath`(3381)、`readPythonRuntimeState`(3406)、`writePythonRuntimeState`(3427)、`getPythonVersion`(3441)、`getPythonVersionText`(3446)、`getPythonSslVersionText`(3455)、`installRequirements`(3468)、`linkIfFound`(3495)、`getBaseEnv`(3510)、`runPythonScript`(3623) | — | `venvRoot`,`runtimeBin`,`cacheRoot`,`packagedRuntimeRoot` |
| **sweeps** | `startReferenceHintSweep`(607)、`stopReferenceHintSweep`(630)、`startOutputDirSweep`(641)、`stopOutputDirSweep`(674)、`cleanupOrphanedSkillArtifactsOnce`(3560) | `referenceHint*Timer`,`outputDirSweep*Timer`,`orphanCleanupRan` | `outputsRoot` |

### 2.2 能力缝判定

runtime-manager 未被路线文档预判缝（标"结构未知，先盘"）。实测：**这是一个子系统工具箱**，11 个子系统仅共享只读路径字段（可按引用注入）+ 各自 Map，彼此几乎不交叉 → 缝多且干净。

- **缝 A：model-pack 子系统（自足，~512 行）**。独占 `modelPackDownloads`/`modelPackDownloadStatuses`；仅依赖 `cacheRoot`/`modelscopeCache` 路径。外部调用者：`ipc-handler`（下载/自检 UI）、`model-pack-manager.test.ts`。**D 级最强候选**。
- **缝 B：python-runtime 供应（~560 行）**。无独占状态字段，纯读路径 + 子进程；`getBaseEnv`(3510) 是共用入口（12 次）。外部：`skill-python-runtime-contract.test.ts`。D 级（`getBaseEnv` 需保共用 → 注入或留 facade）。
- **缝 C：install pipeline（~630 行）**。独占 `skillInstalls`/`skillInstallStatuses`/`installLocks`；`defaultDeploySpawn`(550) 是可注入子进程种子。外部：`skill-install-*.test.ts`（多）。D 级。
- **缝 D：execution engine（~624 行）**。`runSkill` 入口，无独占状态。外部：`runSkillFromChildRunner`←`skill-child-runner`；`skill-runtime-structured-result.test.ts`/`skill-action-output-overflow.test.ts`。D 级。
- **缝 E：jobs/schedules（~256 行）**。独占 `schedulerTimer`/`runningScheduleIds`。外部：`skill-schedule-tick-outcome.test.ts`。D 级（定时器风险）。
- **缝 F：sweeps（~140 行）**。独占 4 个 sweep 定时器 + `orphanCleanupRan`。外部：`skill-reference-hint-sweep-independent.test.ts`/`output-dir-lifecycle.test.ts`。D 级（定时器）。
- 共同注入依赖：`getRawDatabase()`(2877，10 次)、路径字段组、`getBaseEnv`。这些是全 manager 的公共底座，抽任何子系统都以注入这几项为代价。

### 2.3 拆法分级

**P 级（纯移动）**
| 内容 | 行 | 预计行数 |
|---|---|---|
| 常量块 | 142–166 | ~25 |
| 顶层类型（`SkillState`…`CreateSkillScheduleRequest`） | 171–221,245–461 | ~250 → `runtime-manager-types.ts` |
| 纯 helper（`normalizeSkillRunStatus`/`mergeSkillRunStatus`/`envNumber`/`hashDirectoryContents`/`asString`/`asNumber`/`asBoolean`/`truncateOutput`/`getInstallStatePath`/`requirementsDigest`） | 179–241,463–508 | ~120 → `runtime-manager-helpers.ts` |
| 尾部自由 helper `startSkillChildRunAndWait`+类型 | 3714–3800 | ~87 → `start-skill-child-run-and-wait.ts` |
| **P 小计** | | **~450** |

**D 级（委托类提取）**
| 候选子服务 | 字段迁移面 | 方法（行） | 注入接口 | 风险点 | 行数 |
|---|---|---|---|---|---|
| `ModelPackManager` | `modelPackDownloads`,`modelPackDownloadStatuses` | 755–1266 | `{cacheRoot, modelscopeCache, providers}` | 子进程句柄、下载取消 | ~512 |
| `PythonRuntimeProvisioner` | — | 3245–3268,3314–3623 | `{venvRoot,runtimeBin,cacheRoot,packagedRuntimeRoot, getBaseEnv}` | 单例 venv、子进程、包内路径 | ~560 |
| `SkillInstallPipeline` | `skillInstalls`,`skillInstallStatuses`,`installLocks` | 1507–2008,3055–3176 | `{paths, defaultDeploySpawn, provisioner}` | AbortController、锁 | ~630 |
| `SkillExecutionEngine` | — | 2175–2798 | `{getBaseEnv, outputsRoot, structuredResult}` | 子进程、超时、溢出 | ~624 |
| `SkillJobScheduler` | `schedulerTimer`,`runningScheduleIds` | 2799–3054 | `{getRawDatabase, runSkill 回调}` | cron 定时器 | ~256 |
| `MaintenanceSweeps` | 4×sweep 定时器,`orphanCleanupRan` | 607–684,3560–3622 | `{outputsRoot, referenceHint TTL}` | 定时器×4 | ~140 |
| `ExternalEnvResolver` | — | 1267–1403 | `{externalServiceStore}` | cookie 临时文件 | ~135 |
| `SkillHostPrep` | `hostControllerOverride` | 595–606,1404–1506 | `{getBaseEnv}` | host 生命周期 | ~115 |
| （listing/config、custom-CRUD、embedded-sync 可并入门面或小服务） | | | | | ~300 |
| **D 小计** | | | | | **~2980** |

**X 级**
| 内容 | 行 | 原因 |
|---|---|---|
| 字段 + constructor | 510–593 | 路径派生 + startBackgroundTasks 装配 |
| `ensureSkillInstalled`/`getRuntimeProvisioner` | 2072–2174 | 跨子系统胶水 |
| 单例 + `__setForTests` | 3671–3712 | 模块单例合同 |
| **X 小计** | | **~230** |

---

## 3. 推荐执行序

### 3.1 P 级先行（可无人值守，B4–B7 同法，byte-for-byte cmp）
1. **runtime.ts 178–393 → `runtime-helpers.ts`**（~216 行，第一刀）。验证：`tsc --noEmit` + 5 个 runtime 测试（见 3.3）。
2. **runtime-manager.ts 顶层 types/helpers/consts → `runtime-manager-types.ts`+`runtime-manager-helpers.ts`**（~370 行）。
3. **runtime-manager.ts 尾部 `startSkillChildRunAndWait` → 独立文件**（~87 行）。
- P 级先行合计：runtime.ts 削 ~216–300、runtime-manager.ts 削 ~450，两文件即离 4327/3800 明显后退，且零行为风险。

### 3.2 D 级按风险从低到高
**runtime.ts（低→高）**
1. `ProjectionSyncCoordinator`（独占字段、仅缺 emit 注入）→ 2. `SessionPrerouteService`/`DetachedSkillService`（已备类薄适配）→ 3. `SessionRecallFacade`/`NarrationContinuationService`/`ReferenceHintService` → 4. `ScheduleService`/`ChannelConfigService`/`ScopeAttachmentService` → 5. `SidecarPollService`（定时器+单例）→ 6. `ConversationScopeStore`（db 重共享，Phase C 落点）→ 7. `RemoteChannelService`（注入面最宽 ~880 行，压轴）。

**runtime-manager.ts（低→高）**
1. `ModelPackManager`（自足、有专测）→ 2. `MaintenanceSweeps`/`ExternalEnvResolver`/`SkillHostPrep` → 3. `SkillExecutionEngine` → 4. `PythonRuntimeProvisioner`（getBaseEnv 共用需保）→ 5. `SkillInstallPipeline`（锁+abort）→ 6. `SkillJobScheduler`（定时器）。

### 3.3 每步验证套件（grep src/__tests__ 实测）
**runtime.ts（`AgentControlRuntime` 直接引用，5 个）**
- `reflection-runtime-contract.test.ts` → reflection/boot（X 保护）
- `remote-im-attachment-contract.test.ts` → **RemoteChannelService** 缝
- `session-recall-agent-scope.test.ts` → **SessionRecallFacade** 缝
- `cold-start-canresume-projection.test.ts` → **ProjectionSyncCoordinator** 缝
- `continuation-intent-rejects-shell.test.ts` → `buildContinuationIntent`（run-dispatch/P 降级）
- 补充：每 D 簇的 IPC 组（channel-management/conversation/recall/detached/schedule/task-projection-group）是整簇集成验证面（§1.2 缝⑤）。

**runtime-manager.ts（40 个测试，按簇映射）**
- ModelPack：`model-pack-manager.test.ts`
- Python：`skill-python-runtime-contract.test.ts`
- Install：`skill-install-dep-deploy`/`skill-install-from-source-end-to-end`/`skill-install-agent-tool`.test.ts
- Execution：`skill-runtime-structured-result`/`skill-action-output-overflow`.test.ts
- Jobs/Schedules：`skill-schedule-tick-outcome.test.ts`
- Sweeps：`output-dir-lifecycle`/`skill-reference-hint-sweep-independent`.test.ts
- Embedded-sync：`embedded-skill-managed-sync`/`embedded-skill-vea-runtime-failure-paths`.test.ts
- 子进程/child：`skill-child-*`.test.ts、`rss-visual-skill-child-run.test.ts`、`e2e/harness.ts`
- 全绿门（承 B7 终验规程）：主会话独立 `tsc` + 目标簇 focused 测试 + 逐字节 cmp（对 HEAD）。

---

## 4. 与 Phase C 的关系（DirectChat 六职责迁移落点）

`claude-bridge/direct-chat.ts`（1093 行）持六职责字段：**域适配器宿主** `domainAdapters`(282，装配 437–454)、**技能上下文** `skillContextOrchestrator`(274,328)、**浏览器控制器** `browserController`(272)、**sidecar** `sidecarManager`(283)、**runtime** `runtime`(284)、**会话生命周期** `sessions` Map(270)。DirectChat 经 `this.runtime?.getConversationScope`(416)/`this.runtime?.publishScopeRunEvent`(417,420) 委托 runtime。runtime 实例由 `ipc-handler.ts:659 new AgentControlRuntime(agentManager, browserController)` 唯一构造。

**受 B8 影响的落点判断（先拆后迁）**
- **runtime（职责5）**：DirectChat 只需 runtime 公有 facade。B8 拆分保留公有方法名委托子服务 → DirectChat 委托不受影响。**先拆不破坏**；且拆后 runtime 公有面按能力分组（=IPC 组），Phase C 迁"runtime 拥有权"目标更清晰。
- **会话生命周期（职责6）**：存在 split-brain——scope 在 runtime（`ConversationScopeStore` 候选簇 995/1656–1818/3299–3475），session 在 DirectChat `sessions`(270)。Phase C 合并的天然落点 = **B8 的 `ConversationScopeStore` 子服务**。建议：**先在 B8 抽出 `ConversationScopeStore`**，Phase C 把 DirectChat 会话生命周期迁入该 typed 服务，而非迁进 4327 行单体。
- **projection 发布**：DirectChat 调 `runtime.publishScopeRunEvent`。B8 的 `ProjectionSyncCoordinator` 是发布路径落点。先抽 coordinator，Phase C projection 相关迁移对接 typed 缝。
- **域适配器宿主 / 技能上下文 / 浏览器控制器 / sidecar（职责1–4）**：这四者在 DirectChat 本地装配，runtime 侧对应 `getDomainAdapters`(779)/`orchestrator`/`sidecar` 字段。B8 不直接搬这四者，但 `RemoteChannelService` 抽取会固化 runtime 侧"域适配器+sidecar"消费接口 → 为 Phase C 宿主归位提供参照契约。

**总建议**：Phase C 六职责中，**会话生命周期**与**projection**两项应"先拆后迁"——先做 B8 的 `ConversationScopeStore`+`ProjectionSyncCoordinator`，给 Phase C 明确 typed 落点；其余四职责与 B8 弱耦合，可并行或后行。

---

## 5. 纪律与限制声明
- 本盘点只读源码，未改任何源文件、未跑改状态命令。
- 行号基于 `feature/vertical-tabs` 分支（runtime.ts 4327 行 / runtime-manager.ts 3800 行，2026-07-05）。
- 标 **待核** 项：`buildContinuationIntent`(3909) 纯度、`ReferenceHintService` 内存字段名、child-runs D/X 归属、各簇精确 byte 计数——落刀前需逐一读体确认。
