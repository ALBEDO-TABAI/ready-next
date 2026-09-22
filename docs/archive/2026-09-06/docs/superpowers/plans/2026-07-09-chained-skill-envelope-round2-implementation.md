---
title: 链式技能信封修复 Round-2 实施契约（R-CRIT producer / R-GEN 输出上限 / R-CTX 估算校准 / R-XREAD 读根 / R-LEDGER 关账）
date: 2026-07-09
kind: implementation
enforce: false
status: implemented
executor: codex（外部实施代理）＋ Claude（续作/对抗复核/收口）
depends_on:
  - 2026-07-07-chained-skill-second-doc-diagnosis.md
  - 2026-07-07-chained-skill-envelope-remediation-implementation.md
verify_entry: >
  P1 扩展 npm run verify:skill-envelope-write；P2 扩展 npm run verify:streaming；
  P3 扩展 npm run verify:context-instrumentation；P4 新增 check-skill-crossref-read-root.cjs（沿用 07-07 预命名）。
principle: 先契约后代码；修根因不修症状；模型只做判断题（计数/路由/裁决归代码）；预算与截断必须可观测；每项先红后绿。
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# 链式技能信封修复 Round-2（v1）

> Round-1（07-07 契约 P1–P3，commits f8b82d14/2663bf55/01591ccf/706f270f）交付了 R-CRIT 消费侧（单调无 fail-open）、R-WRITE 写盘纠正、R-CTX 计量（`provider_request_bill`）与 R-GEN/R-LEDGER 调查结论。本轮关闭全部遗留决策并接线。
> 行号引用规则：**行号仅锚点**，以符号名/内容为准；开工前 codex 须逐触点复核（工作树在演进）。
> 执行纪律（用户既定流程）：每个 P 完成后起对抗性审查组修复循环，确认无问题再 commit，再进下一个 P；全部完成后总览复审。

## 0. 范围与排序

| 阶段 | 项 | 一句话 |
|---|---|---|
| **P0（文档，随本契约生效）** | R-LEDGER 正式关账 | premise 双死 + 2026-06-10 预算三疑点全 FIXED/NEVER-TRUE（证据见 §R-LEDGER），不再立工单不再立 gate |
| **P1** | R-CRIT producer（模型声明制 expected_outputs） | 让 Round-1 已建好的 delivery_coverage 消费侧真正 live，抓欠交付 |
| **P2** | R-GEN 输出上限 + 截断可观测 | 消除 anthropic-wire 4096 硬顶；`provider_output_truncated` 落账 |
| **P3** | R-CTX 估算器校准 + 估算/实耗对账 | 修"假 token 数触发误压缩撕碎上下文"的真根因；eviction 降级为数据后决策 |
| **P4** | R-XREAD 链式读根（只读） | 同 envelope 兄弟技能 assetRoot + 同 task 先前 outputDir 进读面 |
| **跨阶段（P1+P2 后）** | 事故 e2e 复跑 | 真机复跑 07-07 事故任务：第二份文档落 V 且 `run_close terminalReason=done` |

依赖关系：P1/P2/P3/P4 相互独立，可按序或并行；e2e 依赖 P1+P2。

---

## R-LEDGER · 正式关账（P0，无代码）

### 结论（2026-07-09 复核，对现行代码逐条验证）
1. **原 premise（`if(taskBudgetRuntime)` gate 丢预算）＝NEVER-TRUE**：close-out wrapper `wrapRunMetaRepositoryWithCloseoutSnapshot`（`run-meta-snapshot.ts:29-33`）对**每个**终态写无条件用 `projection.taskType/budget` enrich；orchestrator 全部 finalize 调用点均走 wrapped repo（`agent-sdk-runtime.ts:668-681` 接线）。**已有测试合同**：`ledger-consistency.test.ts:48-71` 精确种入事故形态的陈旧行（`short_task/24`）并断言终态回写，挂在 `verify:evolution-p2`。
2. **"字段级 type/budget desync 用户可见"＝NEVER-TRUE（live 路径）**：任务卡只读 projection（`taskCardViewModel.ts`），`src/renderer` 零 `run_meta` 消费；终态 `run_meta.budget` 是 `projection.budget` 的逐字节拷贝。
3. **2026-06-10 预算三疑点全部过时**：(a) checkpoint 只在耗尽时写预算 → **FIXED**（checkpoint finalize 走 wrapped repo，`run-finalizer-all-paths.test.ts` 覆盖）；(b) 续跑重置用量 → **NEVER-TRUE**（`run-budget-policy.ts:398-408` 从 runtime/projectionBudget 恢复 usage，`task-budget-runtime-alignment.test.ts` 标题即"preserving usage"）；(c) kill 卡 'working' → **NEVER-TRUE**（run_meta 无该值；各 abort 分支均终态化 + `stale-projection-finalizer` 扫尾 + no-downgrade 网）。
4. **唯一残余（非 bug，观测卫生）**：`runtime.ts:1444`（stale-without-handle）与 `:1521`（manual_suspend）两处 finalize 走裸 repo、绕过 close-out enrich。已移入《2026-07-09-agent-skill-module-residual-optimization-implementation.md》O1（≤1pt，observability-only）。

### 行动
- 本节即关账记录；同步在 07-07 契约 R-LEDGER 节尾加一行终局注（指向本文档）。**不立 gate、不立工单**（不为死 premise 立合同）。

---

## R-CRIT-P · delivery_coverage 的 producer：模型声明制（P1，最高杠杆）

### 问题重述
Round-1 消费侧已 live 但恒暗：`deriveCoverageTargets` 读 `steps[].expectedOutputs`，而**全仓无写入者**。live 形态核实：
- skill 任务路由 `domain_executor`（`task-type-resolver.ts:158-165`；两个技能同属 `skill` 单域 → `crossDomain=false` → 不走 planner），router 给 `steps: []`（`task-execution-router.ts:174-179`）；`buildPlannerSteps` 只服务 planner 链且不产 expectedOutputs。
- live inline-skill 的 steps 由 tracker 按工具事件铸造（`skill-task-tracker.ts:869-891`，`{id,title,status,detail,updatedAt}` 无 expectedOutputs），经 `buildSkillProjectionPatch`→`projectionPatches`→finalizer。
- **不存在任何模型可写 steps 的工具**（无 update_plan/tracker-write 类工具面）。

### 设计裁决（D-CRIT-P，已裁决）
"要交付几份、各是什么路径"是**判断题→模型声明**；计数与匹配是**代码**（Round-1 的 `resolveDeliveryCoverage` 原样复用）。声明通道选**既有 live 工具 `declare_completion_criteria` 扩展 optional 字段**，不新增工具面：
- 该工具已双协议曝光、handler 经 `tool-executor.ts:821-834` 写 `getTaskProjectionStoreForFinalize()`——**与 finalizer 同源 store**。⚠️ **P1-0 前置取证（复核新发现，高置信待实证）**：`modelCriteria` 疑似**未真正持久化**——`task-projection-repository.ts` 的 `update()`/`mapRow()`/`TaskProjectionRow` 均无该字段分支，`store.update({modelCriteria})` 疑为静默 no-op、finalize 处 `projection.modelCriteria` 恒 undefined（即 Round-1 的 `appendModelCriteria` 消费端疑似 dark；与既有"D4 appendModelCriteria gate-flip live-required"口径须对账——该 gate 可能只断言了消费端调用、未断言持久链）。P1 开工第一步先写 live-glue 测试实证；若坐实，`modelCriteria` 与 `expected_outputs` **同批**修通持久链（同一 seam，不另立工单）。
- 承载改为**任务级**而非塞进 tracker 步（tracker 步按工具事件粒度铸造，"哪步拥有哪份交付"语义天然错位）：projections 行新增 `expected_outputs_json`，终态 `projectionPatch` 透传，`deriveCoverageTargets` 取并集。
- **明确不采纳**：manifest 声明产出数（静态 pattern 表达不了 per-run 数量，正撞"2 技能≠2 文档" over-demand 陷阱）；envelope/技能数派生（同陷阱，进 gate 红线）。manifest `outputs` 仅允许将来作提示种子（本轮不做）。

### 可验证契约（C-CRIT-P）
1. 模型声明后：terminal 时 `coverageTargets` == 规范化声明集（与 adjudicator 共用 `normalizeDeliveryTarget`，无第二套口径）。
2. **判别力**：声明 2 份、交付 1 份（含多中间 artifact 噪声，忠实还原事故 `artifact×32/1 交付`形态）→ `verdict≠accept`；声明 2 交付 2 → `accept`；**未声明 → 与 Round-1 单调行为逐字节一致**（c1 保持 pre-P1 判据，零回归）。
3. **模型只声明、代码只计数**：任何路径不得从技能数/envelope 项数/`mentionedDomains` 派生 expected 数——gate 红线。
4. **可续跑**：声明持久化在 projections 行；重启后 finalizer 从 `store.get(taskId)` 重派生，同判。replace 语义（最后一次声明整体替换）。
5. **可观测**：声明落 `expected_outputs_declared{taskId, count}`；沿用 Round-1 `adjudicator_criteria_resolved{mode:'coverage_count', delivered, expected}`。
6. **曝光合同（复核已定性：必须修）**：现状下 skill-selected 轮（技能声明非空 `allowedTools` 时——正是事故形态）`declare_completion_criteria` 会被 `filterSelectedSkillToolSurface`（`agent-sdk-utils.ts:183-206`，接线 `agent-sdk-tool-executor.ts:378`）剥离且不被 floors 补回——声明通道恰在目标场景不可达。本轮必须修曝光：selected 轮工具面**保留 agent_interaction 维度的 `declare_completion_criteria`**（按 CLAUDE.md §3 维度独立原则实现，禁止塞进 skill authorization、禁止借道 capability floors 语义）；selected-turn 曝光测试先红后绿。

### 源码触点（锚点）
- 工具 schema：`agent-interaction-tool-defs.ts`（`declare_completion_criteria` 双协议 builder；新增 optional `expected_outputs: string[]`，1..8 项、每项 trim 非空 ≤200 字符、必须含文件名段——裸目录拒绝，理由见 07-07 契约"producer 应发具体文件 target"残留注）。
- handler：`tools/builtins/declare-completion-criteria.ts` + 接线 `tool-executor.ts:821-834`：`store.update(taskId, { expectedOutputs })`。
- 持久化：`task-projection.ts` + `run-contracts.ts` 加 `expectedOutputs?: string[]`；repository **自建全链路**（新列 `expected_outputs_json` + `update()` 字段分支 + `mapRow()` 读回 + SQLite 迁移——**没有可仿的现成 pattern**，见 P1-0 取证；提交前 `npm run verify:native` 必跑）。
- 消费：`run-finalizer.ts deriveCoverageTargets`：并集 `normalize(projection.expectedOutputs) ∪ normalize(patch.expectedOutputs) ∪ 既有 steps flatten`（patch-wins 维持）。`resolveCriteria`/`resolveDeliveryCoverage`/`adjudicateTerminalOutcome` **不动**。
- 提示接线：经 `SystemReminderRegistry`（skill hint / criteria-self-check 各一句："任务承诺 N 份文件交付时，先用 declare_completion_criteria.expected_outputs 声明每份最终路径"）；**禁止**在调度层内联文案（CLAUDE.md §5）。

### 测试（先红）
- 判别力三连（扩展 `skill-primitive-criteria-coverage.test.ts` + `run-finalizer-checkin.test.ts` live-glue）：2 声明/1 交付+31 条中间 artifact → 非 accept；2/2 → accept；0 声明 → 与现状逐字节一致。
- producer 单测：schema 校验（空串/超长/裸目录拒）、replace 语义、store 落行、`expected_outputs_declared` metric。
- **P1-0 持久 live-glue 测（先红判真伪）**：`declare_completion_criteria` 写入（modelCriteria 与 expected_outputs 各一）→ 经 repository 持久 → 新实例读回 → finalize 可见；以此实证/修复疑似 no-op。
- 续跑测：落行后新 finalizer 实例重派生同判。
- 曝光测：skill-selected 轮工具面含该工具。
- 迁移测：旧行（无列）读取回退 `[]` 不炸。

### 回归 gate
- `scripts/check-delivery-coverage-producer-model-declared.cjs`（red-first）：断言 ① `expected_outputs` schema 存在且 handler 写 projections 行；② 全仓无 `expectedOutputs`/`coverageTargets` 从 `skillCount`/envelope 项数/`mentionedDomains` 派生（grep-fence）；③ 判别力测试存在且引用事故形态（多中间 artifact）。挂入 `verify:skill-envelope-write`。

### 风险 / 回滚
- 模型不声明 → 行为=现状（单调兜底，天然 fail-safe）；提示语驱动声明率，e2e 观察。
- 声明路径写错 → 欠覆盖判非 accept，属"响亮失败"方向，可接受；不做模糊匹配放宽。
- 回滚面：schema 字段 + 列 + deriveCoverageTargets 并集三处，全部 additive，删除即回退。

---

## R-GEN · 输出上限模型化 + 截断可观测（P2）

### 问题重述（Round-1 调查已定案）
live 主 agent 从不设 `modelSettings.maxTokens`，anthropic wire `max_tokens: request.modelSettings.maxTokens || 4096`（`agent-sdk-provider.ts:777`，已抽验）→ 长 CJK 深读 ~4096 token 截断。**只有 anthropic wire 封顶 output**；openai chat/responses 两条 wire 不发上限（远端默认）。`stop_reason`/`finish_reason` 在 SSE accumulator 已捕获（`provider-sse.ts:186/355`）但**全链零消费**——截断在台账不可证。claude-bridge `anthropic-execution-client.ts:118/212` 另有两处硬编 4096。

### 可验证契约（C-GEN）
1. **per-model 上限**：`AIModelDef` 新增 `maxOutputTokens?: number`；anthropic catalog 填值（已核对官方口径，均无需 beta header）：`claude-opus-4-20250514`→32000、`claude-sonnet-4-20250514`→64000、`claude-haiku-3-5-20241022`→8192。
2. **解析次序**：`request.modelSettings.maxTokens`（显式，**永远最优先**，`verify:streaming` 既有断言不得破）→ `AIModelConfig.maxOutputTokensOverride`（新增，仿 `contextWindowOverride:108` 惯例，custom/`__custom__`/kimi-for-coding 逃生阀）→ catalog `maxOutputTokens` → fallback **8192**（未知模型安全值，严格优于现状 4096）。实现为 `resolveMaxOutputTokens(config)` 纯函数，置于 `src/shared/ai-providers.ts` 能力层（CLAUDE.md §2：能力必须从共享能力层判断）。
3. **blocking 降级路径钳制**：`READY_SDK_TRUE_SSE=off` / 伪流式 / 单次阻塞重试路径上，`max_tokens = min(resolved, 8192)`——Anthropic 对大 max_tokens 非流式请求会拒绝/超时；降级路径以可靠性优先。真 SSE 路径用完整 resolved 值。
4. **openai 两条 wire 请求体不动**（截断是 Claude-path 专有；给无上限的 wire 加上限=引入新行为，违手术式）。
5. **截断可观测（三 wire 全覆盖）**：三个同构整形函数（`shapeAnthropicModelResponse`/`shapeChatCompletionsModelResponse`/`shapeResponsesModelResponse`，SSE 终局与阻塞路径共用）在 `stop_reason==='max_tokens'` / `finish_reason==='length'` 时落 `logAgentMetric('provider_output_truncated', {path, provider, model, cap})`——观测不改请求体，openai wire 也能证伪/证实截断。
6. claude-bridge 两处 4096 改走同一 `resolveMaxOutputTokens`（或其常量出口），消灭第二口径。
7. 三级降级合同（true-SSE 总开关/伪流式/仅 stream-mention 4xx 单次阻塞重试）与语义性 4xx 冒泡语义**逐字节不变**；`npm run verify:streaming` 全绿。

### 明确不做
- **不做 append-continuation**（检出 length 后续写）：需先有本契约第 5 点的检出，且有 tool_use 截断畸形 JSON、thinking echo_required 保持、消息交替不变式三重风险——列为 D-GEN-2 决策档，本轮不实施。
- 不动 rss-subagent/skill-handoff 等各自显式 maxTokens 的 runner。

### 测试（先红，扩展 verify:streaming 挂载的既有测试文件）
- 无显式 modelSettings + `claude-haiku-3-5-20241022` → body `max_tokens===8192`（非 4096）；opus/sonnet 各断言 32000/64000。
- 未知模型 id → 8192；`maxOutputTokensOverride` 设置时覆盖 catalog 值。
- 显式 `maxTokens:256` 仍逐字节落 body（既有断言）。
- blocking 路径（`READY_SDK_TRUE_SSE=off`）+ opus → body `max_tokens===8192`（钳制生效）。
- SSE `message_delta stop_reason:'max_tokens'` → 恰一条 `provider_output_truncated`；chat `finish_reason:'length'` 同；`tool_use`/`end_turn`/`stop` → 零条。

### 回归 gate
- `scripts/check-provider-output-cap-model-aware.cjs`（red-first）：断言 ① `:777` 处不再是裸 `|| 4096`；② `resolveMaxOutputTokens` 存在于共享能力层且 provider/claude-bridge 均引用；③ truncation metric 在三个整形函数内。挂入 `verify:streaming` 链（或并入其 gate 段）。

### 风险 / 回滚
- 上游代理（自建 baseUrl）不认高 max_tokens → 语义性 4xx 原样冒泡（既有合同），用户经 `maxOutputTokensOverride` 自救；fallback 8192 保守。
- 回滚面：resolver + 三触点（provider/bridge×2）+ catalog 字段，删除即回 4096 现状。

---

## R-CTX · 估算器校准 + 估算/实耗对账（P3；**方向翻案**）

> 2026-07-23 纠偏：本节“data URL 也固定按 1600 token”的结论已被 K3 文本协议真实 HTTP 400 反例取代。现行合同见 `docs/architecture/current-runtime-contracts.md` §4：data URL/截图按 `max(1600, base64字符数/4)` 计，只有 opaque image ref 保留 1600 下限。本节以下内容仅保留为历史决策记录，不再约束生产。

### 问题重述（本轮侦查翻案，取代 07-07 契约"阶段二"两个候选方向）
Round-1 计量（`provider_request_bill`）与压缩触发共用同一估算器 `estimateInputItemTokens`，而该估算器对图片**严重通胀**：`context-budget-types.ts` 中 data-URL 字符串按**全字符长度**计数（一张 400KB 截图 ≈ 数十万"token"），opaque 图片引用按常数 `OPAQUE_IMAGE_REF_TOKENS=85_000` 计——**而真实 Claude 图片成本按 tile 计、单张典型 ≤~1600 token**。诊断中"565–633K、3× 窗口、图片≈85K/张"的数字是**估算器自身的假数**：
- **真实损伤链**：假 token 数 → 0.8×200K 软门（`compact-agent-input.ts`）被虚触发 → 单 run 22 次误压缩、每次真丢 16–78 条**有用文本**（head 图片反而钉死不掉）→ 上下文撕碎 → 写盘参数畸形/路径遗忘（诊断 §3C 的放大器）。
- 图片"每轮重发"在 wire 上是**廉价的**（~1.6K/张/次），eviction 的真实收益远小于预估、且对"图片即分析对象"的任务（正是本事故：用户附图分析）有实害。
- browser 截图**不进**主 history（ring cache + `image_id` 引用），vision 膨胀源=用户附图,这进一步压缩了 eviction 的适用面。

**因此修根因=校准估算器**；eviction 降级为"校准后凭真实对账数据再议"（D-CTX-2）。

### 可验证契约（C-CTX-b）
1. **图片估算 tile 化**：`input_image`（data-URL 与 opaque ref）、`computer_screenshot` 的估算改为常数 `IMAGE_EST_TOKENS`（默认 **1600**，按 Anthropic tile 上限口径，保守不低估单张真实成本）；估算值不得随 base64 字节数线性增长；`OPAQUE_IMAGE_REF_TOKENS=85_000` 退役为同一常数。文本估算逻辑不动。
2. **对账可观测**：每次 provider 响应后，将**估算 total**与 provider 返回的**真实 input token 用量**（usage 已在响应内）落 `provider_estimate_reconciliation{estimatedTokens, actualInputTokens, ratio, visionItems}`（新 metric；或作为字段并入既有 metric——以"能按 run 聚合对账"为准）。这是 eviction 决策（D-CTX-2）的数据来源。
3. **压缩语义不变**：0.8×window 触发条件、head/tail/pair-integrity/16K tool-result 截断全部不动——变的只是喂给它的估算数。校准后同一 3 图对话的估算应下降为原来的零头，**误压缩不再虚触发**。
4. **零扰动**：无图请求的估算与行为逐字节不变；`provider_request_bill` 分节口径继续成立（sections 精确加总==total，vision 数字随校准同步下降属预期，gate 不得断言绝对值）。
5. **兜底不变**：真溢出仍有 `context_overflow`(413) reactive 压缩路径 + 真实用量 `lastUsageTokens` 驱动的 `computeContextBudget`——校准不得移除任何既有兜底。

### 可选子项 W3（默认做，工作量小）：durable 压缩去重旧 skill-catalog 副本
skill-catalog reminder（4000 字符）每个用户轮 prepend 进 session、跨轮累积。仅在 **durable** `compactMemorySession` 路径（`agent-sdk-compactor.ts`）把同 topic 旧副本去重保最新；per-request 压缩不动。测试：三轮累积三份 → durable 压缩后恰一份（最新）、pair-integrity 不破、无 catalog 场景零扰动。

### 决策档 D-CTX-2（本轮不实施）
keep-last-K 图片 eviction / 降采样：待校准后 `provider_estimate_reconciliation` 与 `provider_request_bill` 跑出真实 vision 占比，再由用户裁决是否需要。侦查已给出实现草案（`callModelInputFilter` 在 bill emit 之后动 `modelData.input`、placeholder 文案仿 `message-capability-filter.ts` 的既有 pattern、`READY_IMAGE_EVICTION` 开关）——留此存档，不展开。

### 源码触点（锚点）
- `src/shared/context-budget-types.ts`：`estimateUnknownTokens` data-URL 分支、`OPAQUE_IMAGE_REF_TOKENS`、`billProviderRequestSections` 的 vision 计数复用同一常数。
- 对账 emit：provider 响应整形处（三 wire 同构函数或其调用点，与 P2 的 truncation metric 同批接线可共享改动面）。
- W3：`compaction/`（`compactMemorySession` 路径）。

### 测试（先红）
- 校准单测：一张 500KB data-URL 图估算 == `IMAGE_EST_TOKENS`（非 ~字节数）；opaque ref 同；纯文本 item 估算与现状逐字节一致。
- 行为测：3 图 + 常规文本对话的 `estimateInputItemTokens` 总值 < 0.8×200K（不再虚触发压缩）；同输入在旧估算器下 > 阈值（红基线证明）。
- 对账测：mock provider usage → metric 含 estimated/actual/ratio。
- `provider_request_bill` 既有 9 测继续绿（加总不变式）。
- W3 测如上节。

### 回归 gate
- 扩展 `scripts/check-provider-request-bill-sections.cjs` 或新增 `check-image-token-estimate-tiled.cjs`（red-first）：断言 ① 图片估算不随 payload 长度线性增长（两个不同大小 data-URL 估算相等）；② 85_000 常数已退役；③ reconciliation metric 存在。挂入 `verify:context-instrumentation`。

### 风险 / 回滚
- 校准后低估整包 → 真溢出概率升 → 由 413 reactive + 真实用量预算兜底（契约点 5）；`ratio` 对账数据会暴露系统性低估，先观测后调常数。
- 回滚面：常数 + 分支收敛，单文件可回退；W3 独立可回退。

---

## R-XREAD · 链式技能读根（P4，只读扩面；D-XREAD=(b) 落地）

### 问题重述（事故还原）
链式任务中 selected 技能的读面只有自身 `[artifactRoot, assetRoot]`；模型读**另一技能**的 references 连续 `not_found/no_root_match`（M:1159/1190/1233，attemptedRoots 仅 image-deep-read 两根），随后试 `skill_run_shell` 撞软恢复——烧约 1/3 工具调用。沙箱行为**正确**，属工效/覆盖缺口。

### 关键侦查结论（改变实现成本预估）
**`additionalAllowedReadRoots` 参数链路已端到端存在**：`read-artifact.ts:121-124` `candidateRoots=[artifactRoot, ...additionalAllowedReadRoots, assetRoot]`、逐根 symlink/`path_escape`/size 校验自动生效、dispatcher 从 `frame.activeArtifactRoots` 取值（`skills-tools.ts:2409-2429` 一带）。**本项=填充种子，非新管道**：改 `deriveSeedArtifactRoots`（`turn-frame-resolver.ts:32-63`）+ `ResolveTurnFrameInputs` 供给。

### 可验证契约（C-XREAD）
1. **读面并集**：链式 envelope 的 selected 技能读面 = 自身 roots ∪ **同 envelope 其它 `skill_reference` reference-kind 技能的 `assetRoot`**（07-07 D-XREAD 方案 b 原文）∪ **同 `task_id` 先前技能 run 的 outputDir**（事故还原需要读兄弟产物时同样命中）；后两类均**只读**。
2. **允许清单**：兄弟 assetRoot 仅限 envelope 显式引用的技能（名单源 `agent-sdk-utils.ts:892-910` 一带）；outputDir 仅限同 task、且路径必须在 `outputsRoot` 之下（防越权种根）。
3. **写/export 面零变化**：additional roots 永不进 `WriteArtifactHandlerDeps`/`ExportArtifactHandlerDeps`；跨根写仍 `path_escape`/`no_root_match` 拒。
4. **零扰动**：单技能 envelope（无兄弟引用、无先前 run）的 roots 逐字节不变。
5. **次序**：主 `artifactRoot` 保持 candidateRoots 首位（相对路径语义不变）。
6. **可观测**：`skillPrimitiveUsed` 增 `matchedRootKind:'primary'|'sibling_asset'|'sibling_output'|'asset'`，跨根读在 `ready-tools.log` 可见。
7. **勿用** `path-sandbox.ts` 的存在性盲 `resolveReadableWithinAnyRoot`（07-07 诊断触点订正原文），读解析保持 `resolveReadableExistingWithinAnyRoot`。

### 测试（先红）
1. 双技能 envelope：读兄弟 assetRoot 下 references 文件 → 成功（只读）。
2. 同 task 先前 run 的 outputDir 文件 → 读成功。
3. 跨根写 → 拒（写面零变化）。
4. 空 additional → 兄弟绝对路径 → `no_root_match`（deny-by-default 保持）。
5. 兄弟根内 symlink → 拒（逐根校验自动生效）。
6. 单技能 envelope roots 逐字节不变（零扰动）。

### 回归 gate
- `scripts/check-skill-crossref-read-root.cjs`（07-07 预命名，red-first）：断言读面并集实现存在、write/export deps 无 additional-roots 字段、观测字段存在。独立挂载（可并入 `verify:skill-envelope-write` 链尾）。

### 风险 / 回滚
- 只读信息面扩大 → 已由"reference-kind + 同 envelope 显式引用 + 同 task + outputsRoot 之下"四重限定收口。
- 回滚面：种子派生一处 + 观测字段，删除即回单技能读面。

---

## 6. 阶段验收表

| 阶段 | 硬门 | verify 挂载 |
|---|---|---|
| P0 | 07-07 契约 R-LEDGER 节补终局注 | — |
| P1 | 判别力三连测绿 + producer/曝光/续跑/迁移测绿 + gate 红先绿后 + `verify:native`（迁移） | `verify:skill-envelope-write` 扩展 |
| P2 | per-model/覆盖/钳制/metric 测绿 + gate + `verify:streaming` 全绿 | `verify:streaming` 扩展 |
| P3 | 校准/对账/W3 测绿 + gate + `provider_request_bill` 既有测继续绿 | `verify:context-instrumentation` 扩展 |
| P4 | 六测绿 + gate | `check-skill-crossref-read-root.cjs` |
| 跨阶段 | 真机复跑事故任务：第二份文档落 V 且 `terminalReason=done`；声明→计数链路在 `adjudicator_criteria_resolved` 可见 | 人工 + 台账 |

每阶段提交前：`npm run typecheck` 0 错；P1 涉迁移必跑 `npm run verify:native`；对抗性审查组过后 commit。

## 7. 明确不做（本轮）
- 不做 append-continuation（D-GEN-2 决策档）。
- 不做图片 eviction / 降采样（D-CTX-2 决策档，等对账数据）。
- 不动 openai 两条 wire 的请求体。
- 不从 manifest / envelope / 技能数派生 expected 交付数（gate 红线）。
- 不放宽裁决阈值；`resolveDeliveryCoverage` 匹配语义不动。
- 不动 per-request 压缩的 head/tail/pair-integrity 语义。
- 不复活 R-LEDGER（premise 双死）。

## 8. 决策汇总
- **已裁决（本文档定稿即生效）**：D-CRIT-P=模型声明制经 `declare_completion_criteria.expected_outputs`（任务级承载）；D-GEN=per-model `maxOutputTokens` + fallback 8192 + blocking 钳 8192 + `provider_output_truncated`；D-CTX=估算校准+对账为主修、eviction 降级；D-XREAD=(b) 种子填充（assetRoot+outputDir 双类）；D-LEDGER=关账。
- **留给用户/后续数据**：D-GEN-2（continuation 是否需要——看 truncation metric 频次）；D-CTX-2（eviction——看 reconciliation 真实 vision 占比）；W3 若认为多余可砍（默认做）。

---

## 9. 执行记录（2026-07-10，Claude 续作 + 对抗复核）

codex 已施工 P1–P4 主体；本轮完成收口、对抗复核与缺陷修复。

**P1（R-CRIT-P）——已落地，无缺口。** `declare_completion_criteria.expected_outputs`（1–8、≤200、拒裸目录）→ `CompletionDeclarationPatch{modelCriteria,expectedOutputs}` → `store.update` → repository 全链（迁移 065 同时新增 `model_criteria_json` + `expected_outputs_json`，**坐实并修复了 modelCriteria 的持久 no-op**）。`deriveCoverageTargets` 走 `normalizeDeliveryTarget` 并集（projection ∪ patch ∪ steps，去重）。C-CRIT-P.6 曝光：`filterSelectedSkillToolSurface` 硬保留 `declare_completion_criteria`（不借道 floors/skill-auth），且把 fallback 触发条件从 `filtered.length` 正确改为 `selectedOrPreserved.length`。判别力三连 + 持久重启 + 迁移测均绿（Electron ABI 下 8/8 native）。gate `check-delivery-coverage-producer-model-declared.cjs` 含 grep-fence。

**P2（R-GEN）——契约完备。** `resolveMaxOutputTokens`（显式 → override → catalog → fallback **8192**）落共享能力层；catalog opus32000/sonnet64000/haiku8192；blocking 路径 `min(resolved,8192)`；`provider_output_truncated` 三 wire 同构落点、单次不重复；claude-bridge 两处 4096 归一。复核提示：level-2 非-SSE 伪流式因请求已发出无法钳制（已加注释说明为设计而非 bug）。

**P3（R-CTX）——契约完备。** 图片估算 tile 化（`IMAGE_EST_TOKENS`，`OPAQUE_IMAGE_REF_TOKENS` 退役），文本估算逐字节不变；`provider_estimate_reconciliation` 对账；压缩阈值/head-tail/pair-integrity 未动；W3 durable skill-catalog 去重（`CATALOG_HEADER` 已改为从 reminder 单一源 import，杜绝字面漂移死代码）。413 reactive force-compact 兜底完好。复核留档：reconciliation 的 estimatedTokens 取压缩前，压缩触发时 ratio 偏高（偏“安全”方向，非阻断项，留后续数据决策）。

**P4（R-XREAD）——对抗复核揪出并修复一处写面泄漏。** 派生/allowlist/只读读面/零扰动/observability 均正确；但 codex 把链式读根 seed 进**共享 `activeArtifactRoots`**，而写侧 `resolvePendingSkillHandoffWriteTargets(activeArtifactRoots)` 独立消费该数组——兄弟 output 根若含 pending `audiovisual_handoff/receipt.json` 会被另一技能写入，违反 C-XREAD.3「additional roots 永不进写面」。**修复**：新增只读通道 `activeReadOnlyRoots`（`tool-runtime.ts` 类型+工厂），orchestrator 改 seed 到该通道，读面经新纯函数 `collectSkillReadArtifactRoots` 取 `activeArtifactRoots ∪ activeReadOnlyRoots`，写/export/handoff-target 只读 `activeArtifactRoots`。新增回归测（含 pending-receipt 正对照 + 泄漏栅栏）；gate `check-skill-crossref-read-root.cjs` 强化断言 seed 走只读通道、写解析器只吃 `activeArtifactRoots`；source-contract 测同步更新。

**验证入口全绿**：`verify:skill-envelope-write`（111）、`verify:streaming`、`verify:context-instrumentation`、`verify:stability`、`verify:browser-reliability`、`typecheck`、`native:check`、`ipc-contract`；P1/O1 SQLite 用例 Electron ABI 下 8/8。`check-silent-catch` 因本树并存的非本计划工作（skills-runtime 已提交债 + 未提交 privacy 特性）仍红，本计划触碰的 3 处已加 `silent-catch:` 标注清零。

**跨阶段 e2e（真机复跑 07-07 事故任务）——已通过。** 最终真实 Electron 运行 `req-1783691683388-35og4e` 使用两个 typed 技能引用，跨技能只读根记录 `siblingAssets=1`，两份文档 10800/12973 bytes，`delivered=2, expected=2`，`run_close=done`。证据见 `docs/superpowers/audits/2026-07-10-skill-review-closeout/electron-20260710-215500/`。

### 2026-07-10 最终口径更正

- P2 最终优先级为：用户 `maxOutputTokensOverride` → catalog → 未知 Anthropic 4096 →其他未知模型 8192。流式与阻塞请求使用同一解析值；设置页、切换配置和重启持久化已覆盖。本口径取代本文早期的“未知统一 8192 / blocking 钳 8192”设计草案。
- P3 保留压缩前诊断账单，新增真实上行账单（包含 instructions 与 tool schemas）；只用真实上行数字与供应商 input usage 对账。无压缩时两份账单相等，压缩时显式记录 saved tokens。
- 最终 `verify` 与 `build` 均通过；早期“静默 catch 仍红”的阶段性记录已由最终验收取代。
