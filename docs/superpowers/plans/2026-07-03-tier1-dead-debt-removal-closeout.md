---
title: 梯队一收尾 — 死债删除 + compressToolTrace 复验（接线→删除）
date: 2026-07-03
status: done
enforce: false
parent: 2026-07-03-HANDOFF-agent-module-rework.md
purpose: >
  执行 handoff §8 梯队一。开工前按用户要求对 handoff 声称逐条复验，
  发现两处实质偏差（范围低估 + A5 接线不成立），按修正后方案执行。
  本文是执行记录与偏差账本。
---

# 1. 复验结论（handoff 声称 vs 实际）

| # | Handoff §5/§8 声称 | 复验结果 | 处置 |
|---|---|---|---|
| 1 | 删死债="删文件+清 barrel+typecheck" | 范围低估：还牵连 package.json 3 处 verify 链点名、1 个 gate 整体退役、2 个 gate 硬编码路径、6 个测试文件、tool-error-metrics 2 个死枚举 | 全部纳入本次执行 |
| 2 | 删 "ToolRuntime.executeBatch" | 实为整个 `ToolRuntime` 类死亡（活代码只 import 该文件的类型/helper；类只被 orchestrator+测试构造）；`host.executeToolBatch`（run-contracts.ts:832）是 dormant turn-engine 合同层，另一物 | 删整类；turn-engine/run-contracts 不动 |
| 3 | compressToolTrace/Artifacts "廉价接线"（finder 自标 low） | **接线不成立**：`buildForScopedRun` 全文无 tool-trace/artifact 数据源；CLAUDE.md 合同本就规定工具日志不入正文消息；live 工具轨迹压缩在 SDK 侧 `compactAgentInputItems`。深审 A5 备选项本就含"或删" | 改为删除两死函数（见 §3） |
| 4 | "别踩 check-dormant-compaction gate" | 无违规风险：prompt-assembly 本就在 `CONTEXT_COMPRESSION_ALLOWED` | gate 按删除结果同步收缩 |

# 2. 删除清单（全部零活引用，删前逐一验证）

**源文件**
- `compaction/layered-compactor.ts`（185 行，被 `compactAgentInputItems` 取代的死并列压缩器，深审 A3）
- `compaction/layered-compactor-l2-stub.ts`（有意暗桩，深审 A4"若 A3 删则可一并清"）
- `compaction/index.ts`（barrel：唯一导入方是被 gate 禁止的导入路径，自相矛盾债）
- `runtime-core/execution-loop-orchestrator.ts`（242 行，被 OpenAI Agents SDK 工具循环取代，深审 A 表）
- `tools-runtime/tool-runtime.ts` 内 `ToolRuntime` 类 + `ToolRuntimeExecutionResult/BatchResult`（199-750 行）；保留活代码消费的 `ToolRuntimeContext`/`ToolRuntimeActiveFrameContext`/`createEmptyActiveFrameContext`/`applyContextModifier`。附带收益：打破 tool-runtime ↔ tool-runtime-context-builder 循环导入
- `context-compression.ts` 内 `compressToolTraceForPrompt`/`compressArtifactsForPrompt` + 两 entry 类型（A5，见 §3）

**测试**（纯死路径覆盖）
- `layered-compactor.test.ts`、`layered-compactor-l2-stub.test.ts`、`execution-loop-parallel-tools.test.ts`、`execution-loop-cancellation.test.ts`、`tool-runtime-interrupt.test.ts`、`tool-runtime-results.test.ts`

**测试修剪**（混合文件，保留活合同）
- `tool-runtime-contract.test.ts`：去 ToolRuntime 类/orchestrator 断言块 + 2026-04-17 设计冻结测试（P3 复查点名的"冻结已取代旧设计"模式）+ 可执行 executeBatch 测试；保留 definitions/registry/gateway/executor/hooks/context-builder 活合同，重命名测试标题
- `skill-internal-action-runtime.test.ts`：去 4 个 ToolRuntime 测试；其中 VEA 3h 超时合同改写为直接断言 registry 定义 `executionTimeoutMs`（不经死运行时）；executor 侧 canonical admission 覆盖保留
- `agent-runtime-host-contract.test.ts`：去 orchestrator 文件存在断言；保留 direct-chat 禁引用负向断言（防复建）

**Gate**
- 退役 `check-l2-stub-not-in-production-path.cjs` + 其测试（断言 stub 必须存在，stub 已删）
- `check-dormant-compaction-not-in-live-path.cjs`：去 layered/l2-stub 禁入项、DORMANT_LAYERED_ALLOWED、barrel 允许项、orchestrator channel 项（missing-file 会硬红）；**保留** context-compression 允许表、SDK 禁入、compressContext channel（run-contracts/direct-chat）、barrel 路径禁入（封 alias 绕行洞）；测试同步
- `check-authorization-undefined-passthrough.cjs`：TARGET_REL_FILES 去 orchestrator 条目（读循环对缺失文件是 catch-continue 不会崩，但条目删除后其 fixture 负例不再被扫描，测试必须同删）
- `check-directchat-turnengine-dormant-boundary.cjs`：**不动**（只扫 direct-chat 源，禁引用语义仍有防复建价值）

**package.json**
- `verify:d` 去 layered-compactor.test；`test:s:focus` 去 l2-stub.test；`verify:s` 去 l2-stub gate；`verify:evolution-p6o` 去两个 execution-loop 测试

**保留（有意不删）**
- `tool-parallelism-policy.ts`：非孤儿——`getToolResourceTag`/`ToolResourceTag` 被 2 个 gate（check-ask-user-questions-tool-name-frozen / check-agent-interaction-group-registered）和多个活功能测试钉住；`ParallelToolCall` 被 `tool-execution-hooks.ts`（run-contracts 引用）依赖。仅 `groupParallelSafeToolCalls` 失去主代码调用方，随模块保留
- `tool-execution-hooks.ts`、`run-contracts.ts:832 executeToolBatch`、turn-engine 全部：dormant turn-engine 合同簇，退役属 P3 Phase A（监控会话）

# 3. A5 偏差记录：接线→删除的依据

1. 数据源不存在：`prompt-assembly.ts` 全文（grep artifact/toolTrace/工具轨迹/产物）只有 2 行静态文案 + 2 个硬编码 false；`getScopeMessages` 按合同不含工具日志（CLAUDE.md §2"工具日志只留前台运行态或胶囊层"）。
2. live 语义已在别处：SDK 路径工具轨迹压缩 = `compactAgentInputItems`（agent-sdk-runtime.ts:882/907）。在 legacy 组装层再造一条注入路径 = 新增注入面 + 预算账目变化，非"廉价"且无需求。
3. 深审 A5 备选项本含"或删"；finder 自标 confidence=low 并要求先复验——复验结果支持删。
4. **合同形状保留**：`PromptCompressionReport` 三字段与 `toolTraceCompressed:false/artifactSummaryUsed:false` 不动（renderer `scopeRunState.ts:319` 在消费，main/renderer 双侧类型声明齐全；动契约=跨边界改动，超出梯队一）。false 即事实，非谎报。prompt-assembly.ts 报告构造处已加结构事实注释防误判复接。

# 4. 验证证据（2026-07-03，梯队二期间勘误后为准）

> **勘误（梯队二发现）**：本节初版的四链"全绿"结论经 `npm run X | tail && echo OK` 管道得出——管道退出码是 tail 的（恒 0），echo 无条件打印，**不构成证据**。梯队二用 `>log 2>&1; echo EXIT=$?` 重测，真实状态与修正如下。

- `npm run typecheck:node` EXIT=0（真实捕获）。
- `verify:stability`：重测首次 EXIT=1——**本次删除引入的回归**：`check-sqlite-test-skip-pattern` 检出 `test-coverage-exemptions.json` 三条陈旧 c4Exempt（两个已删测试文件 + 修剪后不再传递 sqlite 的 tool-runtime-contract）。移除三条豁免后 **EXIT=0**。
- `verify:evolution-p4` EXIT=0（真实捕获）。
- `verify:evolution-p3`：重测 EXIT=1，唯一失败 = packet-compiler 阈值矩阵——**base 自带**（前序工作把 `browser_transaction` 加进 shared TASK_TYPES，测试矩阵未同步；相关源文件在工作树无未提交改动，属已提交的旧失衡）。测试侧补 `browser_transaction: false`（transaction 原子、永不分包，与"只有 multi_step/research 可分包"合同一致）后 **EXIT=0**（全链含 verify:native）。同类既有失衡 `task-types-shared-source` 冻结 6 元素测试一并同步为 7（不在任何 verify 链）。
- `verify:evolution-p6o`：EXIT=1，失败恰为 3 个 **base 自带**的 agent-sdk-runtime 用例（行动宣告闸合同碰撞，闸与测试均为前序会话未提交改动；本轮零 sdk 改动）→ 挂 D6 工单（deferred-work-register），修复属可监控会话。链内其余 102/106 全过，含本次修剪的全部文件。
- 5 个独立 gate OK（直跑无管道）：dormant-compaction / authorization-passthrough / directchat-boundary / unwired-markers / belief-decay-live（后者已于梯队二泛化退役）。
- 3 个 gate 测试套件 84/84；受影响焦点测试 41/41（tool-runtime-contract、skill-internal-action-runtime、agent-runtime-host-contract、context-compression、tool-error-metrics-registry、compact-agent-input、turn-frame-patch）。
- 残留扫描：layered/orchestrator/两死函数在 src+scripts 零残留（boundary gate 与 host-contract 测试的 direct-chat 禁引用断言为有意保留）。

# 5. 既有问题（非本次引入，已区分处理）

1. `check-silent-catch.cjs` 在继承工作树上即红（~150 违规）。本次只删文件（只会减少违规），未跑 `--update`（会一次性豁免全部 150 条，属政策决定），基线文件未动；其中 layered-compactor.ts:122 条目成为陈旧条目，子集语义下无害。
2. `tool-error-metrics-registry.test.ts` 既有红：已提交的 `userNegationDenied` 枚举未同步进期望列表（该测试不在任何 verify 链）。已顺手 1 行修复，与本次删除无关，单独记账。
3. （梯队二勘误期补记）`packet-compiler-gate` 阈值矩阵与 `task-types-shared-source` 冻结测试的 `browser_transaction` 失衡、agent-sdk-runtime 三用例 vs 行动宣告闸碰撞（D6）——均 base 自带，处置见 §4 勘误。
4. （梯队二勘误期补记）本次删除自身引入过一处回归：exemptions 表陈旧 c4Exempt 三条（§4），已修，回归由 `check-sqlite-test-skip-pattern` 正确检出——gate 文化工作正常，失误在初版验证方法掩蔽了它。

# 6. 下一步（按 handoff §5）

梯队二：通用三态注册 + 正向 gate（把 `check-belief-decay-live.cjs` 泛化为 `check-mandated-capability-is-live.cjs`）；`appendModelCriteria` 接裁决（confidence=medium，接前复验）。
