---
title: Agent/Skill 模块残债优化实施契约（台账卫生 / 巨文件拆分 / S4-5 复排 / D11 投影纯度）
date: 2026-07-09
kind: implementation
enforce: false
status: implemented
executor: codex（外部实施代理）＋ Claude（续作/收口）
depends_on:
  - 2026-07-09-chained-skill-envelope-round2-implementation.md
verify_entry: O1 扩展 ledger-consistency 测试；O2 以既有全 verify 链为合同；O3/O4 见各节。
principle: 手术式；行为逐字节不变的拆分必须可证明；不为死 premise 立工单。
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Agent/Skill 模块残债优化（v1）

> 背景：2026-07-09 全模块盘点核实——记忆中的大项多数已关：C29/C30/C31-b/C32 走 P6 冻结路线收口（残余均为显式 out-of-P6 缓议项）、AgentSdkRuntime V3 拆分 Phase 1/2/4/5 已落、B8 已落（runtime.ts 4327→2078）、skill 模块六个 seam 零 TODO。真正开放且值得排期的收敛为下述 4 项。
> 执行纪律同 Round-2 契约：每项完成→对抗审查循环→commit。O1 极小可与任一项同批。

## O1 · 台账卫生：两处裸 repo finalize 补 close-out enrich（≤1pt，observability-only）

### 问题
`wrapRunMetaRepositoryWithCloseoutSnapshot` 已覆盖 orchestrator 全部 finalize 调用点，但仍有两处走**裸 repo**、绕过 enrich：`runtime.ts:1444`（stale-without-handle 收口）与 `runtime.ts:1521`（manual_suspend）。两处均经 `finalizeRunOutcome`（funnel 合同不涉），只是 run_meta 的 taskType/budget 不会被 projection 真值 enrich。**非 bug、无用户可见面**（renderer 零 run_meta 消费），纯观测一致性。

### 契约 / 变更 / 测试
- 契约：所有 `finalizeRunOutcome` 调用点的 run_meta 写入面**统一**经 close-out wrapper；`check-run-finalize-funnel.cjs` 继续绿。
- 变更：runtime 侧暴露/复用同一 wrapped accessor（对齐 `agent-sdk-runtime.ts:668-681` 的 `getRunMetaRepositoryForFinalize` 形态），替换两处 `getRunMetaRepository()`。
- 测试（先红）：扩展 `ledger-consistency.test.ts`——manual_suspend 与 stale-closeout 两形态终态后 `run_meta.budget` deepEquals `projection.budget`。
- 风险：无行为语义变化；回滚=还原两行调用。

## O2 · 巨文件拆分续章：`agent-sdk-turn-orchestrator.ts`（~2768 行）+ `agent-sdk-utils.ts`（~2864 行）

### 问题
V3/B8 之后这两个文件成为 agent 模块最大文件；roadmap 已有"触碰 >2k 行文件须拆所触区域"的条款（`2026-07-02-agent-core-experience-roadmap.md:163` 锚，条目 5）。拆分方法论已被 V3/B8 证明：**facade 原位 re-export + 行为逐字节不变 + 全 verify 链绿**。

### 契约（C-O2）
1. **纯移动**：不改任何逻辑/命名/签名；原文件保留 facade re-export，全部既有 import 路径继续可用（不触发全仓改引用）。
2. **可证明不变**：`npm run verify`（含 typecheck/test/ipc-contract/silent-catch）+ `verify:stability` + `verify:streaming` + `verify:skill-envelope-write` 全绿；`check-run-finalize-funnel.cjs`、`check-frame-write-single-source.cjs` 等既有 gate 零新违例；`check-move-only-pr.cjs` 可作纯移动佐证。
3. **切片建议（按内聚 seam，以实际代码为准）**：utils → ① 输入映射簇（`toSdkInput`/message 映射）② envelope/skill_reference 簇（~:892-910 一带）③ 预算/任务簇（`resolveAgentSdkTaskBudgetRuntime` 等）；orchestrator → ① reminder/输入组装簇 ② finalize 调用点簇（**注意 funnel gate 对调用点形态敏感，拆后 gate 必须仍能识别**）③ 恢复/续跑簇。每切片独立提交。
4. 目标（软指标，不做 gate）：两文件各降至 ≤1800 行。

### 风险
- funnel/frame 类 source-grep gate 对文件路径敏感——**每切片拆完先跑对应 gate**，gate 若因路径而非行为红，修 gate 的路径清单属本项 scope（须在提交信息声明）。
- 与 Round-2 P2/P3（provider 侧）文件不相交；与 P1/P4（finalizer/frame-resolver）弱相交——**O2 排在 Round-2 全部落地之后**，避免 rebase 噪声。

## O3 · S4-5（证据化步骤完成判定）复排两步走

### 问题
S4-5 在稳定性契约中登记为 **blocked，不排期**（`2026-06-10-agent-stability-closure-implementation.md:234-238`，已亲验），前置=Plan P WP3+WP5 验收。盘点显示 Plan P 页面证据能力疑似已随 D10–D18 落地——**"疑似"不是验收**。

### 契约（两步硬序，不得跳步）
1. **步骤一（复核，无代码）**：对照 roadmap §5 依赖边，逐条核验 Plan P WP3+WP5 的验收证据（gate/测试/真机记录）；结论写入本节（PASS→步骤二 / FAIL→保持 blocked 并记缺口）。
2. **步骤二（重写工单+轻复审）**：按 S4-5 自带条款"开工前需对照 Plan P 实际接口重写本单细节并经一次轻量复审"，产出重写版工单（把 S4-3 `verify=weak` 升级为消费页面证据的强判据、移除 weak 标注），复审通过后方可实施。
- gate：不新增；以两步产物（复核记录 + 重写工单）为准入证据。

### 2026-07-10 执行记录

- 步骤一：**PASS**。Plan P WP3 的 fresh target/generation、stale/ambiguity/readBack 合同已有正式工具接线与行为测试；WP5 的 `BrowserTaskEvidence` 已在 live `BrowserDomainOrchestrator.recordToolLoopProgress()` 消费，并由“口头完成不推进 / 页面证据推进”测试钉死；D10–D18 留有真实 Electron 页面复测记录。
- 步骤二：已重写为 `2026-07-10-s4-5-evidence-step-completion-implementation.md`。新工单只改 S4-3 活动计划的推进判据：任务句柄、终态、完整下载数量和失败明细成为强证据；移除 `verify=weak`。轻量复审通过后实施。

### 2026-07-11 对抗复核更正

- 上述“WP5 live”结论为 **FAIL**：生产 SDK 只持有 adapter 列表，并不调用 `BrowserDomainAdapter.applyResult()`；旧测试仅证明类存在和模块内行为，不能证明生产接线。
- 不复活已退役 TurnEngine 路径。S4-5 的准入边改为当前真实执行面：SDK 工具执行器把每个结果送入 code-owned 活动计划，模型循环在下一轮回注当前缺失证据；真实 `AgentSdkRuntime` 集成测试已证明这条链。
- S4-5 强判据仍成立，并补齐直接 `collect_notes` 入口、失败/剩余发现项、错误工具结果、不相关页面、普通 click 假提交等反例。最终依据以 `2026-07-10-s4-5-evidence-step-completion-implementation.md` 的更正记录为准。

## O4 · D11：`nextSuggestedAction` 投影纯度（optional，浏览器侧波及）

### 问题
deferred register D11（`2026-07-03-deferred-work-register.md:179` 一带；注意该项无独立 `# D11` 标题、内容嵌于 D10-c 段）：browser 工具 receipt 的 `nextSuggestedAction` 被投进 steps/criteria 形状，造成"假 100%"呈现伪装（锚 `browser-tools :3318/:3055`）。register 已铲掉部分文案源头，结构修未做。

### 契约 / 测试
- 契约：receipt 建议只进 advisory/meta 通道，**永不**进 steps/criteria 投影形状（renderer 不新增本地猜测的既有红线的写侧对偶）；这里不依赖已退役的 narration 运行模式。
- 测试（先红）：投影 shape 测试——带 `nextSuggestedAction` 的 receipt 终态后 steps/criteria 不含其派生项。
- 波及：browser-lane 测试链（`verify:browser-lane`）须绿。若对抗复审认为波及超出本轮预算，允许降回 register 缓议（须写理由）。

## 不做清单（本轮明确不碰）
- **packet-trio、candidate-maintenance**：deferred-by-design，有 `check-mandated-capability-is-live.cjs` 看门，前置未满足。
- **C29 壳删除 / C30 岛外重构 / C31-b 全局脱敏 / C32 外部 MCP errorKind**：P6 显式 out-of-scope 缓议项，不在本轮复活。
- **C04 shell 动态写已知缺口**：sentinel 钉死，等 OS 级隔离（基建决策）。
- **boost 动态工作流（BW-1..14）**：自有两份 2026-07-09 文档，draft 待复审，边界互不侵入。
- **D8/D9（浏览器等待语义/采集混线）**：留 register，与本轮 skill/agent 主线弱耦合，待浏览器专轮。

## 排序建议（与 Round-2 合并的总执行序）
Round-2 P1 → P2 → P3 → P4 →（e2e 复跑）→ O1 → O3 步骤一/二 → O2（最后，避免 rebase 噪声）→ O4（可选）。

---

## 执行记录（2026-07-10，Claude 续作 + 收口）

**O1 · 已落地。** `runtime.ts` 新增 `getRunMetaRepositoryForFinalize()`（复用 `wrapRunMetaRepositoryWithCloseoutSnapshot`，对齐 `agent-sdk-runtime.ts` 形态），两处裸 finalize（stale-without-handle `:1455`、manual_suspend `:1532`）改走 wrapped accessor。`ledger-consistency.test.ts` 扩展为「manual_suspend 与 stale-closeout 两形态终态后 `run_meta.budget` == `projection.budget`」，Electron ABI 下与迁移 065、declaration 持久测同批 8/8 绿；`check-run-finalize-funnel.cjs`、`check-suspend-run-finalize-semantics.cjs` 继续绿。无行为语义变化。

**O2 · 已收口（codex 起、Claude 补齐）。** codex 已把 `agent-sdk-utils.ts`（2864 行）拆出 `agent-sdk-foundation-utils.ts` + `agent-sdk-model-message-utils.ts`（facade `export *` 原位 re-export），但遗留 15 处跨文件符号未接线（typecheck 全红）且两新文件整块复制了原始 import 头。本轮：① 补齐跨文件 import + 导出两个原私有函数（`hasCurrentTurnAttachmentContext`、`parseAttachmentReferences`），typecheck 归零；② 以保守 codemod 清除 57+68 处未用 import（0 unused，typecheck 复绿）。行为不变由 `verify:stability` + `verify:skill-envelope-write` + 各焦点链全绿佐证（拆分函数被测试真实驱动）。软指标：utils 降至 ~1839 行（略高于 1800，可接受）。**遗留 follow-up（非阻断）**：foundation-utils ↔ utils 存在函数级循环 import（运行时安全，均为提升函数声明），若后续要做「内聚 seam」再评估把 4 个共享 helper 下沉到 foundation-utils 断环。

**O3 · 已完成（见上「2026-07-10 执行记录」两步）。** 步骤一 PASS、步骤二重写为 `2026-07-10-s4-5-evidence-step-completion-implementation.md`（`status: ready-for-light-review`）。S4-5 的实际实施是该独立工单的后续，不属本轮范围。

**O4 · 已落地。** `browser-action-session.ts` 的 `buildBrowserActionSessionProgress` 把 `detail: session.nextSuggestedAction` 改为 `detail: null`，建议只留在 `browserActionSession` meta 通道，永不进 steps/criteria 投影形状（消除「read map again」伪 0/1 与伪 100%）。`browser-action-receipt.test.ts` 加断言「`nextSuggestedAction` 只在 session meta、progress 无 `steps`/`criteria` 键」；`verify:browser-reliability` 绿。

## 2026-07-10 最终收口更正

- O1 终态事实优先级已统一：finalizer 的 taskType/budget 优先，projection 只补缺失字段；陈旧 `short_task` 不再覆盖终态 `research`。projection、run_meta 和 run_close 已由新的小型行为测试钉死一致。
- O2 已按最终架构收口：`agent-sdk-utils.ts` 为 8 行兼容导出层，意图/信封、文档保护、终态转换、提醒组装、模型循环与收口持久化均已按责任拆分；叶子模块不再回依赖 facade，循环依赖已清零。orchestrator 958 行，其余新核心模块均低于 900/1000 目标。
- O3 的 S4-5 不再是“后续工单”，已完成严格证据化实施；最终合同见 `2026-07-10-s4-5-evidence-step-completion-implementation.md`。
- O3 的旧 WP5 接线声明已由 2026-07-11 更正取代；完成依据是 live SDK 活动计划证据漏斗，不是 dormant DomainAdapter。
- 最终三轮命名对抗复审无高/中优先级遗留，全量 `verify` 与真实 Electron 双技能事故复跑通过。本节取代上文早期的“utils ~1839、循环依赖可接受、S4-5 未实施”阶段性描述。
