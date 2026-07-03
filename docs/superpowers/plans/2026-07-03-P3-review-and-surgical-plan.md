---
title: P3 无幻觉审查 + 精确手术计划（架构收口）
date: 2026-07-03
status: plan
enforce: false
method: >
  每条结论都对实际代码 grep/wc 核验，不采信 roadmap 旧数字与记忆。
  发现 roadmap P3 段多处失真，已在 §1 逐条更正。
---

# 1. roadmap P3 声称 vs 实测（更正表）

| roadmap/记忆声称 | 实测（2026-07-03 wc/grep） | 差异 |
|---|---|---|
| browser-tools.ts ~5.8k | **8484** 行 | 大 46% |
| turn-orchestrator ~2.4k | 2660 行 | 接近 |
| Settings.tsx ~3.5k | 3486 行 | ✓ |
| AgentSdkRuntime 7.4k（记忆） | **1076** 行 | 已拆完，记忆过期 |
| "dormant 双运行时退役=删 TurnEngine/DirectChat" | turn-engine **prod 0 import**（真 dormant）；**DirectChatEngine 非 dormant** | 关键失真 |
| 巨文件=3 个 | 实测 >2.6k 的有 ~11 个 | 遗漏过半 |
| C29/C30 退役 | 有**前次规划失败**留痕（215 文档） | 高难度信号 |

**实测巨文件全景（>2.6k，源码非测试）**：
- browser-tools.ts **8484**（最大）
- runtime.ts 4297（agent-control 运行时主类，本轮我改过）
- turn-engine.ts 4827（dormant）
- skills-runtime/runtime-manager.ts 3800
- renderer/FileTree.tsx 3737
- skill-child-runner.ts 3560
- Settings.tsx 3486
- skills-tools.ts 3055
- database.ts 2994 / useAgent.ts 2983 / migrations.ts 2789 / turn-orchestrator 2660

# 2. 四项逐条核验结论

## ② dormant 双运行时退役（roadmap 最失真项）

**turn-engine.ts（4827 行）—— 生产真 dormant**：
- `grep` 全仓：**没有任何 src/main|preload|renderer 生产文件 import turn-engine**（只有注释提到它）。
- 它 export 的 helper（`countToolRepetitions`/`statusFromTerminalReason`/`shouldInjectBudgetWarning`/`computeChildContinuationDecision`/`buildBudgetWarningMessage`/`renderChildCommandOutcome`）**生产无人 import**；`computeChildContinuationDecision` 仅定义于此、仅被测试引用。
- 被 6 个测试直接 import + ~14 个测试引用；其中 `agent-runtime-host-contract`（253 断言）/`turn-engine-contract` 是**守卫测试**——断言 direct-chat/live 路径**不**import TurnEngine（即强制 dormancy）。
- 结论：**生产删除零风险（0 引用）**，阻塞仅在测试面（~20 文件，含 route 测试 5117 行）。退役=先确认 helper 无 live 依赖→删类+专属测试→守卫测试转为"文件不存在"gate。风险 **低-中**（大测试面）。

**DirectChatEngine（direct-chat.ts:269）—— 非 dormant，是 live 服务容器**：
- `orchestrator.ts:158` **仍 `new DirectChatEngine()`** 作 `domainAdapterEngine`。
- 仍承载：`getDomainAdapters()`、`getSkillContextOrchestrator()`、`setRunCleanupRegistry`、`setBrowserController`/`hasBrowserController`/`getActiveBrowserUrl`、`setSidecarManager`、`setRuntime`、`newSession`、`stopGeneration`（session 生命周期）。
- 注释（:176）："Stage U PR U1.3 + P6f — DirectChatEngine no longer participates in [turn loop]"——被抽出**回合循环**，但仍是域适配器/技能上下文/浏览器控制器/会话生命周期的宿主。
- 结论：**退役=把这些职责迁到 orchestrator/SDK 路径再删**，大迁移。风险 **高**。且 C29 有前次规划失败留痕。

## ① 巨文件拆分：browser-tools.ts 8484 是象。纯移动、每步可测、无行为变更。风险 **低-中**（量大）。

## ③ run-timeline 事件单源
- `agent:stream` + `scopeRunEvent` 两通道均 live，emit 侧：ipc-handler/run-coordinator/orchestrator/runtime；消费侧：preload → renderer `useAgent.ts`。
- 收敛=定义统一 run-timeline 事件模型，两通道收敛为其投影，renderer 全派生 + gate 防旁路。风险 **中-高**（架构+renderer）。

## ④ 性能整固：测量驱动（首 token 延迟基线、context_bill 注入预算回归、page map+回执替截图轮询）。折进各阶段测量。

# 3. 精确手术计划（按风险/价值排序，每步 typecheck+焦点测试绿）

## ⚠️ Phase A 深挖修正（2026-07-03 A0/A1/A2 实测后）——比"删死代码"复杂

A0-A2 逐条核验后，Phase A 的真实形态被更正如下（无幻觉记录）：

**确证可删的部分**：
- 生产 **100% 0 引用** turn-engine（grep 全仓 src/main|renderer|preload 无 import）。
- 权威现状（`2026-06-16-resume-continuation-fact-source-implementation.md:155`）："**live path 是 AgentSdkRuntime，不是 DirectChat/TurnEngine … 修复不要落到 turn-engine/DirectChat 这条 dormant 路径上**"——turn-engine 确为 dormant，roadmap"退役"意图正确。
- 三大行为契约（child-resume 路由 / force-tool typed-action / projection truth）**均有 live SDK 路径测试覆盖**（agent-sdk-runtime / child-loop-terminal-funnel / child-run-retry-policy / run-projection / task-projection-sync 等）。故 `turn-engine-route/projection/force-tool-dispatch` 三测试删除=去重复覆盖，非去唯一覆盖。
- turn-engine.ts **无 compaction 纠缠**（不 import layered-compactor/context-compression/compact-agent-input/context-bill）；layered-compactor 不在 runtime-core live 路径。

**复杂/延迟信号（为何不是简单删除）**：
- `agent-runtime-host-contract.test.ts`（253 断言）与 `turn-engine-contract.test.ts` **冻结的是 2026-04-17 phase3 旧设计**——"TurnEngine 成为唯一 execution truth owner / DirectChat 收缩为 host shell"。此设计**已被 Stage U（AgentSdkRuntime）取代**，这些断言是 stale 残留，且**混在一个大 live-架构契约测试里**（253 断言多数是当前 DirectChat host 契约，仍有效），需**外科式只摘除 turn-engine 相关断言**，不能整删。
- 该 253 断言测试还断言 turn-engine.ts 的**内容存在**（`export class TurnEngine`）+ 多条"design 应描述 TurnEngine 为 owner"的**设计文档 regex**——删 turn-engine 会连带要求处理这些冻结。
- C29/C30 退役有**前次规划失败**留痕（`215-CLAUDE-P6B-C28C29-PLAN-FAILURE.md`）。
- P6i/P6m 的"do not delete DirectChat/TurnEngine dormant"是**那两个 slice 的 scope 排除**（别在 P6i/P6m 里顺手做），非永久禁令；退役是独立 C29/C30 slice。

**结论**：Phase A 生产零风险、行为契约有 live 覆盖，但**牵连一个冻结旧设计的 253 断言契约测试**，需外科式拆解 stale 断言（保留 live DirectChat host 契约断言），且是有前次失败史的 C29/C30 slice。→ 建议按下方**修正版分步**执行，且因契约测试外科手术精细、出错会 typecheck 过但丢失不变量，**建议在可监控会话执行，或先做无此纠缠的 Phase B**。

## Phase A（修正版分步）：退役 dormant turn-engine.ts
- **A0 盘点（非破坏）**：列 turn-engine 所有 export + 每个的引用来源；对每个 helper 判定 dead / 需抽取。已知候选：`computeChildContinuationDecision`（仅测试引用，疑 dead）、`statusFromTerminalReason`/`buildBudgetWarningMessage`/`renderChildCommandOutcome`（被 skill-child-run 测试引用，查 live 是否另有等价）。
- **A1 抽取**：若有 helper 的逻辑仍是 live 真值（被 live 代码经**别的路径**使用同款逻辑），抽到 `agent-control/shared/*` 窄模块 + 单测；否则标记为随类删除。
- **A2 删类 + 专属测试**：删 `TurnEngine` 类主体与 turn-engine-route/projection/force-tool-dispatch 等**引擎专属**测试（其契约若已被 SDK 路径测试覆盖则安全；A0 需逐一确认覆盖）。
- **A3 守卫测试转型**：`agent-runtime-host-contract`/`turn-engine-contract` 中"direct-chat 不 import TurnEngine"的断言 → 改为"turn-engine.ts 不存在"的存在性 gate（`check-*.cjs`），保住"live 路径不复活双运行时"的不变量。
- 产出：删 ~4.8k 源 + ~10k 测试死重；双运行时维护税 dormant 侧清零。
- **风险控制**：A0 先证明"每个 export 要么 dead 要么已被 live 测试覆盖"再动删除；任一 export 证明不了覆盖就先 A1 抽取。

## Phase B（机械高价值，可无人值守）：browser-tools.ts 8484 手术拆分
- 按内聚工具组抽独立模块（如 collection/power/media/navigation/observe 各一），每次抽一组 + 保持 `browser-tools.ts` 做薄 re-export 门面，`browser-tools.test` 每步绿。纯移动零行为变更。
- 先 A 后 B 或 B 独立均可（互不依赖）。

## Phase C（需监控，契约先行）：DirectChatEngine 职责迁移后退役
- C1 把域适配器宿主/技能上下文/浏览器控制器/sidecar/会话生命周期从 DirectChatEngine 迁到 orchestrator 或 SDK 侧的显式持有者（每职责一步 + 契约测试）。
- C2 全部迁完 + `orchestrator` 不再 `new DirectChatEngine()` → 删。
- **必须可监控 + 先写机器可验证合同**（对应 C29/C30，且有前次失败史）。

## Phase D（架构，契约先行）：run-timeline 单源
- D1 定义统一事件模型（turn/text/tool/status/collect/finalize）。
- D2 `agent:stream`+`scopeRunEvent` 收敛为其投影，renderer 全派生。
- D3 gate 防新增旁路事件通道。needs 监控。

# 4. 推进建议
- **可无人值守**：Phase A（先 A0 盘点，证明安全再删）、Phase B（纯移动）。
- **必须可监控 + 合同先行**：Phase C（DirectChat 迁移）、Phase D（事件单源）。
- 建议先 **A0 盘点**（非破坏、纯证据）落地，据结果决定 A 是否可安全无人值守推进；B 可并行独立开。
- C/D 留到可监控会话，按用户架构红线"先机器可验证合同"再动。
