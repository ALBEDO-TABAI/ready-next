---
title: Agent 模块并行深审——通电普查 + 接线/gate 策略（第一批：3/8 子系统）
date: 2026-07-03
status: audit-findings
enforce: false
coverage: >
  本文=并行深审 workflow 第一批结果，仅覆盖 3/8 子系统成功 finder（学习进化/记忆压缩/
  工具分发授权），得 9 项已对抗验证 CONFIRMED_DARK。另 5 finder（belief-knowledge/
  skill-runtime/run-lifecycle/events-provider-renderer/browser-engine）API 中断失败，
  正 resume 补跑；补齐后合并。refuted=0（无幻觉暗桩被排除）。
---

# Ready Agent 模块「通电普查」权威评估

> 数据来源：agent 模块并行深审的**已对抗验证**结果（confirmedDark 已被反驳幸存）。本评估仅基于给定的已验证数据，未新造未经验证的结论。
> 覆盖：9 项 CONFIRMED_DARK，跨 3 个子系统（学习/进化 2、记忆/压缩 5、工具分发/授权 2）。

---

## 0. 留痕（防幻觉）

- **confirmedDark = 9 项**：全部经反向调用链追踪 + 反驳尝试后幸存，判 `CONFIRMED_DARK`。
- **refuted = 0 项**：本轮无被排除的幻觉暗桩。
- **uncertain = 2 项：未定论**。给定 payload 仅完整包含 `confirmedDark` 数组；题面提到的 `architectureIssues` / `capabilityGaps` 未作为独立字段随数据下发，第 2、3 节据 confirmedDark 证据**归纳**而非直接合并，凡属推断处已显式标注。第 9 项（HostCapabilityDispatcher）的 refutation 文本在 payload 中被截断，但其 `notWiredEvidence` 与 `productionCallPath: N/A` 完整，结论不受影响。
- 置信度分布：high ×7、medium ×1（compressToolTrace/Artifacts）、low ×1（l2-stub，且为**有意暗桩**）。

---

## 1. 通电普查表（核心交付）

### 子系统 A：学习 / 进化 / 反思

| 能力 | 定义位置 | 为何 dark | 接通需要什么 | ROI |
|---|---|---|---|---|
| **Emergence feed**（`assembleEmergenceFeed` + 8 抽取器 resume/followUp/crystallize/agentCandidate/prepare/harvest/forming） | `emergence/emergence-cards.ts:326`（抽取器 :56/:80/:129/:179/:251/:269/:307） | `emergence-cards` 仅被 3 个 test 引用，**零非测试导入方**；目录无 barrel；preload/claude-bridge 无 IPC 通道承载此 feed（同名的 file-emergence 是另一 renderer 功能）。 | 加 live producer（scheduler 或 scope-run 事件调用 `assembleEmergenceFeed`）→ 暴露 IPC + preload → 建 UI 面（今日不存在）。 | **高** |
| **Agent-candidate maintenance**（`maintainAgentCandidates`, EP3-C5） | `emergence/candidate-maintenance.ts:101` | 仅被自身 test 引用；无 barrel/动态 require；**无 live signal producer**——`SimilarRequestSignal/RoutingMissSignal/AgentTrafficSignal` 全树仅出现在本文件+test；文件自声明 `:2 "P5d/C26 unwired"`。 | 从 live run/preroute 路径产出真实 similar-request/routing-miss/traffic 信号，按 scheduler 喂入；产出的候选由 agent-derivation-group 已有的 `emergence-candidate` source 消费。 | **中** |

### 子系统 B：记忆 / 压缩

| 能力 | 定义位置 | 为何 dark | 接通需要什么 | ROI |
|---|---|---|---|---|
| **runMaintenanceLlmRound + collectBeliefDecaySignals**（LLM 维护回合：crystallize LLM 合成 / belief-decay / 候选投影 / 容器钉死子 agent） | `maintenance/maintenance-llm-round.ts:149`（helper :242） | 文件头 `:146 "P5d/C26 unwired"`；仅定义+test 引用。live 回合走的是 `runCrystallizeRound`（crystallize-gate.ts，确定性版），非本候选。唯一 live import 是被动读取端 `getLastMaintenanceRoundStatus`（ipc-handler.ts:81），其读的模块变量只由从不运行的本函数写入→**IPC 生产恒返回 null**。`collectBeliefDecaySignals` 零 caller，已列入 deferred-work-register(2026-07-03)。 | 加 live scheduler tick（镜像 CrystallizeScheduler）构建 `MaintenanceRoundDeps` 并在 EP2-C2 门后调 `runMaintenanceLlmRound`。 | **中低** |
| **ExternalMemoryProviderSlot**（外部/RAG 记忆预取槽） | `memory/external-memory-provider-slot.ts:15` | runtime.ts:413 构造、:842 shutdown，但 `.register()` 生产端从不调用（**无任何具体 ExternalMemoryProvider 实现**）；getter runtime.ts:761 零消费者→`activeProvider` 恒 null→`prefetch()` 从不运行。纯空扩展点。 | 经槽注册具体 provider，并在 prompt-assembly 的 L1/recall 构建中调 `getActiveProvider()?.prefetch()`，把结果织入注入上下文。 | **低** |
| **createLayeredCompactor / LayeredCompactor**（字符预算 L1 + L2 熔断压缩器） | `compaction/layered-compactor.ts:37` | 唯一导入方是**零导入者的 barrel** `compaction/index.ts:4`（+test）。live SDK 压缩用另一个模块 `compactAgentInputItems`（agent-sdk-provider.ts:126 / agent-sdk-runtime.ts:882/907）。L2 tier 更是显式 stub（:134-136 抛 'not implemented'）。 | **删除**（已被 `compactAgentInputItems` 取代），或若确需字符预算/熔断语义再 port 进 SDK 压缩包装。 | **低（负债）** |
| **compressToolTraceForPrompt + compressArtifactsForPrompt** | `compaction/context-compression.ts:61` | 兄弟函数 `compressHistoryForPrompt` 是 live（prompt-assembly.ts:671），但这两个 prompt-assembly 从不调用。唯一被允许的 live 导入方 prompt-assembly.ts:1268-1272 把 `toolTraceCompressed:false / artifactSummaryUsed:false` **硬编码 false**——恰是这两函数本该填的字段。被 CI gate `check-dormant-compaction-not-in-live-path.cjs` 显式围栏隔离出 SDK live 路径。 | 在 prompt-assembly 组装 tool-trace / artifact 段时并排调用（平行于 :671 的 history 调用），或删。 | **中低** |
| **layered-compactor-l2-stub**（`noopBeforeSummarizationHook` + `BeforeSummarizationHook`） | `compaction/layered-compactor-l2-stub.ts:29` | **有意暗桩**：文件头 + CI gate `check-l2-stub-not-in-production-path.cjs` 主动禁止其进入任何生产模块。仅被自身 test 引用。 | **不动**。仅当 L2 summarization 真正实现时才接。列出仅为死压缩清单完整性。 | **低（有意保留）** |

### 子系统 C：工具分发 / 授权

| 能力 | 定义位置 | 为何 dark | 接通需要什么 | ROI |
|---|---|---|---|---|
| **ExecutionLoopOrchestrator + ToolRuntime.executeBatch**（批量/并行工具执行引擎：parallel-safe 分组、`Promise.allSettled` 分块、per-tool recovery、预算感知串行化、abort/cleanup、contextModifier 排序） | `runtime-core/execution-loop-orchestrator.ts:28`/`:45`；`tools-runtime/tool-runtime.ts:199`/`:212` | `new ExecutionLoopOrchestrator` 仅在 2 个 test；`new ToolRuntime(` 仅 :45。live driver 只从 tool-runtime import helper/type，从不 import ToolRuntime 类。`host.executeToolBatch` 仅接口成员 + dormant turn-engine.ts 调用（turn-engine 零非测试导入者，Stage U 起休眠）。live 工具执行走 AgentSdkToolExecutor → OpenAI Agents SDK → `host.executeToolCall`。 | 已被 OpenAI Agents SDK 自身工具循环取代。**删除**，或若确需 Ready 的预算感知/parallel-safe 策略，把 `groupParallelSafeToolCalls` + 预算分块 port 进 SDK 工具包装。 | **低（负债）** |
| **HostCapabilityDispatcher + resolveHostShortcutDecision**（openclaw host-shortcut 分发：检测 `openclaw pairing ...` 命令绕过模型工具循环直发 host） | `domain-adapters/host-capability-dispatcher.ts:16`；`run-capability-controller.ts:45/:166/:119` | `new HostCapabilityDispatcher` **全树零 caller**。字段在 run-contracts.ts:796 声明为 `unknown`，仅 dormant turn-engine.ts:1200/:2829 读取。decision 仅在 dormant `resolveRunCapabilities` 内产出。live SDK 路径从不计算/消费 host-shortcut decision。**今天键入 openclaw pairing 命令经此路径无任何效果**。 | 若仍需 openclaw pairing 快捷路径：live AgentSdkRuntime pre-turn 调 `resolveHostShortcutDecision` 并构造/分发 dispatcher；否则删除。 | **低（需产品决策）** |

---

## 2. 架构债 top 项（据 confirmedDark 证据归纳）

> 说明：payload 未下发独立 `architectureIssues` 数组，以下按证据严重度排序，均可回溯到具体 dark 项。

1. **【高】合同强制的能力未接生产，且无正向 gate 兜底。** CLAUDE.md §2 明确「剩余涌现卡：prepare/harvest/forming 卡必须带 evidence 与行动出口」，但 Emergence feed 整条产线（引擎+8 抽取器+caps）零 producer、零 IPC、零 UI。合同要求「必须 surface」与实现「完全 dark」之间没有任何机器强制拉平——这是最实质的架构裂缝。

2. **【高】现有 gate 全是「负向围栏」，只防误接、不防漏接。** `check-unwired-capability-markers.cjs`、`check-dormant-compaction-not-in-live-path.cjs`、`check-l2-stub-not-in-production-path.cjs` 都在**禁止** dark 代码进入 live 路径。它们成功阻止了「意外接线」，却在结构上**放任「建了永不接」**长期堆积（5 项记忆/压缩 dark 中至少 3 项被这类围栏「合法地」冻结）。

3. **【中】被动状态读取端伪装成 live，制造「看起来接了」的假象。** `getLastMaintenanceRoundStatus` 是 live IPC，但它读的变量只由从不运行的 `runMaintenanceLlmRound` 写入，生产恒返回 null。这类「live 读取端 ≠ live 生产端」的结构最易骗过表层 grep 审查。

4. **【中】死的替代实现与 live 实现并存，形成同名双物。** 压缩有 `LayeredCompactor` vs live `compactAgentInputItems`；维护有 `runMaintenanceLlmRound` vs live `MemoryLifecycleManager.runMaintenance()`；工具循环有 `ExecutionLoopOrchestrator` vs live SDK loop。同名不同物增加误读与误接风险（违反 CLAUDE.md 架构红线 §3「拒绝 legacy 兼容分支和暂时保留的旧路径」）。

5. **【中】空扩展点构造即弃。** `ExternalMemoryProviderSlot` 在 live runtime.ts 构造+shutdown，但 register/getActiveProvider/prefetch 全程不触发——一个被 live 文件持有、却永不产生价值的空槽，属典型「建好没接生产」的扩展点债。

---

## 3. 能力缺口（据 confirmedDark 归纳）

> payload 未下发独立 `capabilityGaps` 数组；下列为从 dark 能力语义反推的「产品侧承诺但实际不可用」缺口。

- **主动涌现卡不可见**：resume/follow-up/prepare/harvest/forming/crystallize 建议卡引擎完备，但用户端**看不到任何一张**（无 UI 面）。这是与 §2 合同直接冲突的能力缺口。
- **专项 agent 自动派生的证据链断裂**：候选维护逻辑（evidence≥3 门）存在，但**无 live 信号采集**，故「从重复请求/路由 miss 派生新 specialist agent」实际不发生。
- **LLM 版维护回合缺席**：live 只有确定性 crystallize/归档；crystallize LLM 合成、belief-decay 编排、候选投影**均不运行**。
- **外部/RAG 记忆召回缺席**：prompt 组装无任何 external/vector recall 注入（槽存在但无 provider）。
- **工具压缩遥测字段恒 false**：`toolTraceCompressed` / `artifactSummaryUsed` 永远报 false，压缩可观测性有洞。
- **openclaw pairing 快捷命令无效**：键入即静默无效。

---

## 4. 接线与 gate 策略（关键）

### 4.1 核心判断：发现**改变了**原本的接线设想

原设想多半是「按需把 dark 模块 import 进 live 文件即可」。但证据显示**这恰恰是现有负向 gate 主动禁止的方向**——三个 `check-*.cjs` 会因 live 文件 import dark 模块而报 ERROR。所以正确姿势不是「偷偷 import」，而是：**接线动作必须与 gate 语义同步翻面**——把某能力从「negative-fenced（禁止进 live）」显式迁移到「positive-asserted（要求有 live 调用路径 + fired 账本）」。这是一次**合同状态迁移**，不是一次 import。

### 4.2 建议引入「通电闸 / `*_fired` 账本 / 正向 gate」三件套

现有 gate 的结构缺陷是**只有黑名单、没有白名单存活断言**。补齐方式：

1. **`*_fired` 运行时账本（可观测）**：给每个「合同强制必须 live」的能力加一个生产侧发火计数/事件（如 `emergence_feed_assembled`、`maintenance_llm_round_fired`、`external_memory_prefetch_fired`）。这与 CLAUDE.md 哲学一致——「失败要响亮」「产品内预算超限必须可观测」。dark 能力的账本恒为 0，一眼可辨。

2. **正向存活 gate（机器强制）**：新增一个 `check-mandated-capability-is-live.cjs`，维护一张**「合同强制能力 → 期望 live 入口/fired 事件」映射表**。对表中每项断言「存在非测试生产调用路径」或「集成测试中 fired 计数 > 0」；缺失即 CI RED。这把 §2 那类「必须 surface」的自然语言合同**降级为机器可验条件**（符合架构红线 §0.5「先合同后代码」「CI 强制优先于文档」）。

3. **暗桩显式登记表（区分「有意 dark」与「漏接 dark」）**：保留一份 `intentional-dark-register`（l2-stub、ExternalMemoryProviderSlot 等有意扩展点入册），正向 gate 只对**不在册**的合同能力报错。这样负向围栏继续防误接，正向 gate 防漏接，两者互补且不互相干扰。

### 4.3 一句话方针

> **负向 gate 防「不该接的接了」，正向 `*_fired` gate 防「该接的没接」；有意暗桩进登记表豁免。三者并存，才能从结构上让「建了没接」无处遁形。**

---

## 5. ROI 排序的执行序

### 第一梯队 · 可较低风险推进（需一次决策，动作小）

- **[负债清理] 删除死替代实现**：`LayeredCompactor`（被 `compactAgentInputItems` 取代）、`ExecutionLoopOrchestrator`/`ToolRuntime.executeBatch`（被 SDK 工具循环取代）。删除前只需确认「预算感知/parallel-safe 策略」不再需要；属**需一次架构决策、执行可无人值守**（删除后跑 typecheck + verify 链即可证伪回归）。
- **[廉价接线] `compressToolTraceForPrompt/compressArtifactsForPrompt` 接入 prompt-assembly**：并排于 :671 的 history 调用，同时把 :1268-1272 硬编码的两个 false 字段改为真实值。改动小、可观测收益直接（补齐压缩遥测）。**需监控**：接入后确认 gate `check-dormant-compaction` 语义同步更新（否则会误报）。

### 第二梯队 · 需监控推进（价值高，工程量中等）

- **[合同强制·最高价值] Emergence feed 通电**：producer（scheduler/scope-run 事件）→ IPC + preload → UI 面。因 §2 合同强制，应**优先于其余接线**。属**需监控**（涉及新 UI 面、灰度上线、配 `emergence_feed_assembled` fired 账本 + 正向 gate 入表）。
- **[进化能力] Agent-candidate maintenance 通电**：先补 live 信号采集（similar-request/routing-miss/traffic），再喂 `maintainAgentCandidates`，产出交 agent-derivation-group 的 `emergence-candidate` source。**需监控**（自动派生 specialist agent 触及生命周期，须遵 §2「无用户确认不得自动派生」）。
- **[记忆增强] `runMaintenanceLlmRound` 通电**：镜像 CrystallizeScheduler 加 tick + `MaintenanceRoundDeps`，走 EP2-C2 门。`collectBeliefDecaySignals` 已在 deferred-work-register(2026-07-03)。**需监控**（涉 LLM 调用预算与 staged 写卡纪律）。

### 第三梯队 · 暂缓 / 有意保留

- **[暂缓] `ExternalMemoryProviderSlot`**：无具体 provider 前不接；待真有 RAG/vector provider 再注册。入「有意暗桩登记表」。
- **[保留] `layered-compactor-l2-stub`**：有意暗桩，L2 summarization 实现前不动。
- **[需产品决策] `HostCapabilityDispatcher`/openclaw pairing**：确认 openclaw pairing 快捷是否为 live 需求——需要则接 live pre-turn 路径，不需要则随 turn-engine 休眠一并删除。

---

## 6. 相关文件路径索引（绝对路径）

- `/Users/user/实验田/ready-cowork-newtab/src/main/modules/agent-control/emergence/emergence-cards.ts`
- `/Users/user/实验田/ready-cowork-newtab/src/main/modules/agent-control/emergence/candidate-maintenance.ts`
- `/Users/user/实验田/ready-cowork-newtab/src/main/modules/agent-control/maintenance/maintenance-llm-round.ts`
- `/Users/user/实验田/ready-cowork-newtab/src/main/modules/agent-control/memory/external-memory-provider-slot.ts`
- `/Users/user/实验田/ready-cowork-newtab/src/main/modules/agent-control/compaction/layered-compactor.ts`
- `/Users/user/实验田/ready-cowork-newtab/src/main/modules/agent-control/compaction/context-compression.ts`
- `/Users/user/实验田/ready-cowork-newtab/src/main/modules/agent-control/compaction/layered-compactor-l2-stub.ts`
- `/Users/user/实验田/ready-cowork-newtab/src/main/modules/agent-control/runtime-core/execution-loop-orchestrator.ts`
- `/Users/user/实验田/ready-cowork-newtab/src/main/modules/agent-control/tools-runtime/tool-runtime.ts`
- `/Users/user/实验田/ready-cowork-newtab/src/main/modules/agent-control/domain-adapters/host-capability-dispatcher.ts`
- `/Users/user/实验田/ready-cowork-newtab/src/main/modules/agent-control/domain-adapters/run-capability-controller.ts`
- live 对照（勿误接）：`.../compaction/compact-agent-input.ts`、`.../memory/memory-lifecycle.ts`、`.../maintenance/crystallize-gate.ts`、`.../tools/tool-executor.ts`
- 现有负向 gate：`/Users/user/实验田/ready-cowork-newtab/scripts/check-unwired-capability-markers.cjs`、`.../scripts/check-dormant-compaction-not-in-live-path.cjs`、`.../scripts/check-l2-stub-not-in-production-path.cjs`
---

# 批次2（resume）：run-lifecycle 3 项 + memory-compaction 复核 + 精炼策略

> 覆盖新增 run-lifecycle（B1 任务包三件套 / B2 appendModelCriteria / B3 RunFeedbackRepository），并把 **A2 belief-decay 升为最高严重度真实泄漏**。仍失败 5 finder：belief-knowledge / skill-runtime / browser-engine / runtime-orchestrator / events-provider-renderer（连接中断），待可靠补审。

以下为权威评估。基于已对抗验证的 confirmedDark 数据（8 项，跨 2 子系统），architectureIssues / capabilityGaps 在移交给我的 payload 中被截断，故此二节由 confirmedDark 证据本身反推并如实标注来源，不另造未验证条目。

---

# Ready Agent 模块「建了没接」通电评估（权威版）

> 数据口径：confirmedDark 8 项（全部经反驳幸存），refuted 0 项（无幻觉被排除），uncertain 3 项（本轮未定论，内容不在移交 payload 内，见 §6）。
> 子系统：记忆/压缩（memory-compaction）5 项、run 收口/裁决/投影（run-lifecycle）3 项。

---

## 1. 通电普查表（核心交付）

### 子系统 A：记忆 / 压缩

| # | 能力 | 定义位置 | 为何 dark（已验证） | 接通需要 | ROI |
|---|------|----------|---------------------|----------|-----|
| A1 | `runMaintenanceLlmRound`（EP3-C3 LLM 维护回合：衰减+结晶 STAGED 信念卡+用户画像合并，"agent 从自身历史学习"主循环） | `maintenance/maintenance-llm-round.ts:149` | 自述 header `:146` "P5d/C26 unwired"；非测试调用者=0，唯一调用者是 5 处单测。runtime.ts 只 wire 确定性轮 `runCrystallizeRound`（crystallize-gate），共享 `decideCrystallizeRun` 门控≠wire 本轮。IPC `getMaintenanceRoundStatus` 只读它写的模块级快照变量→生产恒返回 null（读取器已接、生产者未接） | live driver（CrystallizeScheduler tick / reflection outcome）构建 `MaintenanceRoundDeps` 并在确定性门后调用；绑 `runSubAgent` 容器 + `BeliefCardStore` + `collectDecaySignals` | **中**（价值高但接线面大、LLM 成本、staged 写需重监控） |
| A2 | `runBeliefDecayRound` / `decideBeliefDecay`（信念卡置信度衰减+淘汰，L2 belief-mirror 专属老化生命周期） | `memory/belief-decay.ts:97`（round）/ `:59`（decide） | 唯一非测试上游是 A1 内部 `:198`，而 A1 本身 unwired，且 decay 分支再被 `collectDecaySignals && decayEffectors` 门控，这两 dep 仅测试注入。**真实缺口**：live L2 清扫 `memory-lifecycle.ts:167` 以 "belief 有自己的衰减生命周期" 为由 `continue` 排除 belief 行，而该生命周期永不执行→生产中信念卡既不衰减也不淘汰，单调堆积 | **解耦**：不经 A1，直接从 live 调度器（CrystallizeScheduler / MemoryLifecycleManager）调用 `runBeliefDecayRound`，`collectDecaySignals` + effectors 绑到信念卡 mirror DB | **高**（闭真实泄漏、纯确定性、可无人值守、零/低 LLM 成本） |
| A3 | `createLayeredCompactor`（L1/L2 分层压缩器，与 live 压缩并列的第二实现） | `compaction/layered-compactor.ts:37` | 仅经 barrel `index.ts:4` 再导出且零源码导入者；直接调用者只有单测。live 压缩是完全另一实现 `compactAgentInputItems`（`AgentSdkCompactor.compactMemorySession` / `agent-sdk-provider.ts:126`）。其 L2 直接 throw "not implemented in D phase"（`:135`）。turn-engine 已不再引用它（连 dormant 都不是，纯 test-only） | 无 live 接线目标——这是死并列实现。**应删除**，或统一为单压缩器合同 | **删除高 / 接线负**（切勿再接第二个压缩器） |
| A4 | `noopBeforeSummarizationHook` / `BeforeSummarizationHook`（L2 分层压缩的 skill-bundle 保全前钩，noop stub） | `compaction/layered-compactor-l2-stub.ts:29` | 文件头自述 stub-only / not in production；专用 CI gate `check-l2-stub-not-in-production-path.cjs` + `check-dormant-compaction-not-in-live-path.cjs` 双闸主动禁止 live 导入；仅经无 live 导入者的 barrel 再导出 + 单测可达 | **刻意延后（§6.15 defer L2），非缺陷**。除非放弃 L2，否则维持现状；若 A3 删则可一并清 | **N/A**（列全备考，不是债） |
| A5 | `compressToolTraceForPrompt` / `compressArtifactsForPrompt`（prompt 注入前压 tool-trace / 历史 artifact 列表） | `compaction/context-compression.ts:61` / `:86` | 所在文件 live，但 prompt-assembly 只用同模块的 `compressHistoryForPrompt` + `buildCompressionReport`；这两导出非测试引用=0，且 `buildCompressionReport` 硬编码 `toolTraceCompressed:false / artifactSummaryUsed:false`（`prompt-assembly.ts:1270-1271`）——live 文件内的死能力 | 在 `buildForScopedRun` 把 run 的 tool-trace / artifact 列表喂过这两函数并置对应 report flag。**注：finder 标 confidence=low，接线前先复验** | **中**（接线局部、省 prompt token、确定性可无人值守；先验证低置信） |

### 子系统 B：run 收口 / 裁决 / 任务投影

| # | 能力 | 定义位置 | 为何 dark（已验证） | 接通需要 | ROI |
|---|------|----------|---------------------|----------|-----|
| B1 | 任务包 compile/dispatch/failure 三件套（EP3 PK2/PK3/PK4：`decidePacketCompilation`+编译器+`resolvePacketChannel`/`buildPacketBrief`+`settleChildFailure`(重派≤1/降级/阻塞)+`buildParentPacketAdjudication`+`validateUpstreamReport`≤5 行） | `quality/packet-compiler.ts:44`；`packet-dispatch.ts:40/68`；`packet-failure.ts:80/133` | 三文件头各自 "P5c/C22 unwired"；所有导出非自身 importer=0（仅 3 个单测）；quality/ 无 barrel；live 兄弟 `packet-fields.ts`(validate/depth)反被三件套引用，通电性不回流。**gate 主动反接线**：`check-unwired-capability-markers.cjs` 列三件套为 UNWIRED 并接进 `verify:evolution-p3`，自测断言 runtime.ts 一旦 import 即报错。closeout 文档 `246-P5C-...CLOSEOUT.md` 记录显式停用 | orchestrator/AgentSdkRuntime 加 live 规划步：multi_step/research-多目标时 `decidePacketCompilation`→`parseCompiledPacketTree`→逐子 `buildPacketBrief`/`resolvePacketChannel`→派发→子终态 `settleChildFailure`/`buildParentPacketAdjudication`→`validateUpstreamReport` | **低（近期）**（面大、被 gate 主动封锁、需 orchestrator 规划层；长期价值高但属刻意 defer） |
| B2 | `appendModelCriteria`（把模型规划期声明的 task-specific 验收标准 m1,m2… 合并在确定性模板项之后） | `quality/criteria-templates.ts:179` | 唯一引用是单测（import+2 调用点）。live 裁决漏斗 `run-finalizer.ts:623` 的 `resolveCriteria` 从不调它，`criteria.items` 直送 `adjudicateTerminalOutcome`。git -S 显示引入后从未接。→ 每个 run 100% 按模板判定，"02 §3.1 规划期追加" 路径从未接通 | 在规划/标准解析点（`run-finalizer.ts:623` 上游或任务规划步）捕获模型声明标准，裁决+投影持久化前经 `appendModelCriteria(criteria.items, modelCriteria)` | **中高**（提升裁决保真、接线较局部；但依赖规划期捕获点，confidence=medium） |
| B3 | `RunFeedbackRepository` + `run_feedback` 表（用户 run 质量评分 1-5，upsert/list，机器裁决指标的人类信号对偶） | `task-projection/run-feedback-repository.ts:67`；表 `migrations.ts:1831`（036） | `new RunFeedbackRepository` 仅 3 处、全在单测；非测试符号只有自身定义+migrations 建表。无任何 feedback IPC/preload/renderer（`runFeedback`/`feedbackRating` 全仓 0 命中）。barrel 再导出但无 live 导入者→惰性。live `RunQualityPanel` 读的是机器指标 `runQuality.stats()`，非本 repo。项目自诊 `2026-07-02-...diagnosis.md` 记 "run_feedback 0 行 / 用户反馈回路无数据" | 在 AgentControlRuntime 实例化 repo；加 IPC `agent:runFeedback:submit/list`；preload + `electron.d.ts` 暴露；renderer（任务卡 / RunQualityPanel）加评分控件；可选喂入 `aggregateRunQualityStats` | **中**（清晰人机反馈闭环、标准 CRUD 全栈接线；需 UI，不可无人值守） |

---

## 2. 架构债 top 项（按 severity）

> 移交 payload 的 architectureIssues 数组被截断；下列由 confirmedDark 证据直接反推，按严重度排。

1. **【高】跨模块"排除但孤儿"不变量被违反（真实数据泄漏）**：`memory-lifecycle.ts:167` 的 live L2 清扫以"belief 有自己的衰减生命周期"为由排除 belief 行（A2），但该生命周期（`belief-decay.ts`）永不执行。这不是单点 dark，而是一个**跨模块契约谎言**——一个 live 模块把责任让渡给一个 dark 模块，形成信念卡永久堆积、既不衰减也不淘汰的真实泄漏。severity 最高，因为它有生产数据后果。
2. **【高】"读取器已接、生产者未接"反模式**：IPC `getMaintenanceRoundStatus`（`ipc-handler.ts:1013`）接线完整，但其数据源 `lastMaintenanceRoundStatus` 只在 dark 的 A1 函数体内赋值→生产恒返回 null（A1）。一个对外暴露的状态面永远吐 null 而无人报警，是"半接线"债的典型。
3. **【中高】死并列实现与 live 实现共存**：压缩有 `createLayeredCompactor`（A3，L2 还是 throw stub）vs live `compactAgentInputItems`；两套压缩概念长期并列，已被项目自身审计（`2026-07-03-...deep-audit-findings.md:67`、`P6-structural-debt-drift.md:81`）与清理计划 `2026-06-21-p6j-...cleanup.md` 记录。维护者面对两份合同易接错。
4. **【中】live 文件内的死能力**：`compressToolTraceForPrompt/Artifacts`（A5）活在 live 的 context-compression.ts 里，且 `buildCompressionReport` 硬编码 `false` flag——文件级"通电"掩盖了函数级"未接"，比整文件 dark 更难发现。
5. **【中】裁决只用模板、缺规划期个性化标准**（B2）：所有 run 按 100% 模板判定，模型规划期声明的 bespoke 成功条件从不参与，裁决保真度系统性偏低。
6. **【中】Stage-3 大合同整体停用**（B1）：任务包 compile/dispatch/failure 三件套成建制 dark，虽由 gate 主动封锁+closeout 记录（属可控 defer），但代表一层已建的编排能力长期未上电。

---

## 3. 能力缺口（capabilityGaps）

> payload 的 capabilityGaps 数组被截断；下列由 confirmedDark 反推的生产侧实际缺失能力。

- **信念卡老化缺失**：生产中信念卡无衰减、无淘汰机制在跑（A2）。
- **agent 自我学习回合缺失**：从自身历史结晶 staged 信念卡 / 合并用户画像的 LLM 维护主循环不在生产路径（A1）。
- **人类反馈回路缺失**：无从收集用户 run 评分，`run_feedback` 0 行（B3）。
- **规划期验收标准缺失**：run 无法按 agent 自己声明的 task-specific 标准被裁决（B2）。
- **prompt tool-trace / artifact 压缩缺失**：长 tool-trace / artifact 列表不被压缩即注入 prompt，token 冗余（A5）。
- **并行任务包编排缺失**：复杂多目标请求无法扇出为并行子包+结构化失败结算+≤5 行上行汇总（B1，属刻意 defer）。

---

## 4. 接线与 gate 策略（关键）

### 4.1 根因：现有 gate 只会"保持 dark"，缺"证明 live"的对偶闸

代码库已有一批 gate（`check-unwired-capability-markers.cjs`、`check-l2-stub-not-in-production-path.cjs`、`check-dormant-compaction-not-in-live-path.cjs`、`check-feedback-upsert-shape.cjs`）——但它们全是**负向断言**："这东西别接进生产"。复发根因正相反：能力被 建好+单测绿+标注 unwired 后，"应上电"的那一步再没发生，且**没有任何机制在能力应 live 却零产出时报警**。A1 的 IPC 恒返回 null、A2 的 belief 永不衰减，都是"没有 live 产出证明"造成的静默缺口。

### 4.2 加"通电闸 + `*_fired` 账本"（防复发主脊）

引入**能力通电登记表 + fired 账本**，把现有的诚实自述 header 从"注释"升格为"机器可判定的三态注册"：

1. **状态三态注册**：每个顶层能力入口标注 `@capability-status: {deferred-by-design | dark-defect | live-required}`。
   - `deferred-by-design` 必须指向 defer 文档 + 现有负向 gate（如 A4、B1 已满足）。
   - `dark-defect` 必须挂一张接线工单（A1/A2/B2/B3 应转此态）。
   - `live-required` 必须有对应 `*_fired` 账本断言。
2. **`*_fired` 运行时账本**：`live-required` 能力在真实执行时 emit 一个可观测计数（如 `belief_decay_round_fired`、`maintenance_llm_round_fired`）。一次 smoke/集成跑后，正向 gate 断言每个 `live-required` 的 fired ≥ 1；**恒为 0 即 gate 红**。这直接抓住 A1"IPC 读取器接了但生产者从不 fire"这类半接线。
3. **"排除即托付"契约闸**（专治 §2 第 1 条）：当 live 模块以"由模块 Y 处理"为由排除某类数据（`memory-lifecycle.ts:167` 排 belief），gate 强制模块 Y 必须是 `live-required` 且有 fired 账本。**排除方与承接方绑定校验**，杜绝"排除但孤儿"泄漏。
4. **status-reader 依赖闸**：任何 IPC 状态读取器，若其数据源写入点只落在 `dark-defect` 函数体内，gate 红（抓 A1 型恒-null 面板）。

### 4.3 发现是否改变原设想的接线方式？——是，三处

- **A2 与 A1 解耦**：原设计把 belief decay 嵌在 LLM 维护回合内部（`maintenance-llm-round.ts:198`），并被测试专用 dep 二次门控。但 `decideBeliefDecay` 是**纯确定性**，不该被 LLM 回合的成本与风险绑架。→ 改为直接从 live 确定性调度器（CrystallizeScheduler tick）调用 `runBeliefDecayRound`，**先于、独立于** A1 上电。这也符合项目红线"路由/衰减/可重复转换必须由代码承担，模型只做判断题"。
- **A3 不接、要删**：不要为了"利用已建代码"而把第二个压缩器接进生产；live 已有 `compactAgentInputItems`。接两个压缩器=制造新债。按已存在的 p6j 清理计划删除。
- **B1 保持 defer**：不趁机接线；把 defer 显式化、标注日期与解封条件，维持双 gate 封锁。

---

## 5. ROI 排序执行序

### 阶段一 · 可无人值守（确定性、低风险、先做）

1. **A2 wire belief-decay 到 live 调度器（最高 ROI）**：解耦于 A1，挂 CrystallizeScheduler tick，绑 mirror DB effectors。闭掉 §2 第 1 条真实泄漏，纯确定性、零/低 LLM 成本。**同时加 §4.2 第 3 条"排除即托付"闸**锁死回归。
2. **A5 wire prompt 压缩**（先复验 low-confidence）：`buildForScopedRun` 喂 tool-trace/artifact 过压缩器并置真 report flag。局部、省 token、确定性。
3. **A3 删除死并列压缩器**（+ 若放弃 L2 则连 A4 stub 一并清）：按 p6j 清理计划执行，降债。

### 阶段二 · 需监控（LLM/裁决/UX 改动，后做）

4. **B3 RunFeedbackRepository 全栈接线**：实例化 repo + IPC `agent:runFeedback:submit/list` + preload/`electron.d.ts` + renderer 评分控件。标准 CRUD、闭人机反馈环；需 UI 故不可无人值守。
5. **B2 appendModelCriteria 接入裁决**：在 `run-finalizer.ts:623` 上游捕获模型声明标准并合并；上线后**监控裁决漂移**（新标准是否放宽/收紧了判定）。
6. **A1 runMaintenanceLlmRound 上电（旗舰、最后）**：绑 runSubAgent 容器 + BeliefCardStore + collectDecaySignals，接 CrystallizeScheduler/reflection outcome。LLM 成本、staged 写，需**重监控**；应在 A2 已证明 decay effectors 稳定后再做，并顺手修复其 IPC 恒-null 面板（§4.2 第 4 条）。

### 不做（本轮）

- **B1 任务包三件套**：维持刻意 defer，仅把 defer 显式化 + 标日期 + 记解封条件。

---

## 6. 诚实标注（防幻觉留痕）

- **refuted = 0**：本轮无任何候选被反驳为幻觉/误报；上表 8 项均为对抗验证幸存的 CONFIRMED_DARK。
- **uncertain = 3**：三项本轮未定论——其具体内容**不在移交给本次评估的 payload 内**（JSON 在 B3 处被截断，其后 architectureIssues / capabilityGaps / uncertain 数组未送达）。因此本报告的 §2 架构债、§3 能力缺口系由 confirmedDark 证据反推，已逐条标注来源，**未借这 3 项 uncertain 造结论**；3 项应作为下一轮跟进项单独定谳，暂不计入 dark，也不据其接线。
- **置信度差异**：A5 finder 标 confidence=low、B2 medium，其余 high——A5/B2 接线前须各自先复验（已在执行序中标"先验证"）。
- **A4 非缺陷**：L2 stub 属诚实标注、刻意延后、双 gate 封锁，列入普查仅为完整性，不进接线序。

---

本评估仅基于已对抗验证的 confirmedDark 数据；未对代码库做新增探查，未引入 payload 外的未验证结论。
---

# ⚠️ 手审即时发现（belief-knowledge 起步）：P2-1 破坏 verify:evolution-p3 gate

- **事实**：`node scripts/check-unwired-capability-markers.cjs` **FAILED** —— `runtime.ts must not import unwired module crystallize-gate.ts`。我在 P2-1 把 `CrystallizeScheduler`/`runCrystallizeRound` 从 `crystallize-gate.ts` import 进 `runtime.ts` 并接线，但该文件仍带 `P5d/C26 unwired: not in production driver path` 标记，且被 `check-unwired-capability-markers`（在 `verify:evolution-p3`）显式禁止 live import。P2 收尾我跑了 evolution-p1/p4 未跑 p3，**漏检**。
- **性质**：crystallize 属 P5d（enforce:true）**刻意延后的 maintenance/emergence 集群**（crystallize / belief-decay / maintenance-llm-round / candidate-maintenance / emergence-feed），P5d 明言"不接 dormant 生命周期到生产，只把边界显式化"。我把"deferred-by-design"误当"accidental-dark"，用裸 import 接线而非审计策略要求的 gate-flip 迁移（改 UNWIRED 表 + 去标记 + 更 P5d 文档 + 加 `*_fired` 账本）。
- **对 #1 的影响**：审计 #1（belief-decay 挂 CrystallizeScheduler）建立在此半接线之上——若先做 #1 会放大该违规。**这正是用户"先2再1"要规避的错误。**
- **正确单元**：不是"接 belief-decay"，而是"**对整个 P5d 集群做一次连贯裁决**"——保持 deferred，或整簇迁 live（配 gate 更新 + fired 账本），二选一，不可逐个裸接。
- **待办（并入连贯接线决策）**：(a) 还原 P2-1 crystallize 接线恢复 gate 绿；或 (b) 正式迁移 crystallize（+ 视决策连 belief-decay/maintenance-round 一起），改 gate/markers/P5d 文档 + 加 fired 账本。当前 evolution-p3 RED，属已知待决状态。

---

# 手审补齐：census 完成结论（9/9 子系统）

**skill-runtime / browser-engine / events-provider-renderer 三子系统手审：无重大未追踪 dark。** 逐一核验：
- skill-runtime：RuntimeProvisioner/SkillTaskSupervisor/SkillToolFallbackThrottle/SkillConfigurationStore/SkillHostController 等核心类均有 live `new`（runtime-manager 或各自模块）——工作子系统，wired。（之前"SkillResumabilityCoordinator/DetachedTaskRegistry"是我猜错的幻影名，全树 0 引用，不存在。）
- browser-engine：BrowserEvidenceService(browser-tools/browser-agent-runner)、BrowserDiagnosticsService/BrowserPreviewService/BrowserBookmarkTransferService/BrowserPageBackgroundService(ipc-handler) 均 live `new`——wired。我 P1 建的 browser-power-failure/media-verification/browser-action-receipt 也 live（browser-tools 引用）。
- events-provider：provider-sse live（agent-sdk-provider，P0-0）；agent:stream/scopeRunEvent/projection 三通道皆 live（架构债是**三重化**非 dark，属 P3 Phase D run-timeline 单源）。reflection-service 也 wired（runtime:415/4268）。

**census 关键洞察**：built-but-dark **集中在"成长/学习/维护"能力簇**（P5d：crystallize[已迁]/belief-decay[已迁闭漏]/maintenance-llm-round/candidate-maintenance/emergence-feed + external-memory-slot）与 run-lifecycle 独立项（RunFeedbackRepository/appendModelCriteria/compressToolTrace + 死债 LayeredCompactor/ExecutionLoopOrchestrator/HostCapabilityDispatcher）；**执行子系统（browser/skill/events）天天被跑，保持 wired，无 dark**。

这印证根因：dark = 建了却没接的"成长/维护"能力（正是"agent 不成长"痛点），执行路径不受影响。→ **最高 ROI 仍是把成长簇通电**（belief-decay 已做；下一梯队 emergence feed[需 UI] / RunFeedbackRepository[需 UI] / appendModelCriteria[裁决保真]），死债则删。
