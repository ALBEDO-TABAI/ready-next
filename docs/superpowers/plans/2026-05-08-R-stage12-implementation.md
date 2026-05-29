---
stage: R (Stage 12)
date: 2026-05-08
enforce: true
status: approved v15 — Codex round 15 converged 2026-05-09 (15 rounds × 50 瑕疵 cleared, no Contract Gap)
predecessor: 2026-05-07-Q-skill-resumability-triple-fence-implementation.md
roadmap: archive/2026-05-08-deerflow-borrowing-roadmap.md
external_source: https://github.com/bytedance/deer-flow (local clone at `_research/deer-flow/`)
revision_history:
  - v1 (2026-05-08): initial implementation plan from roadmap v13; covers W0.1 / W1.1-W1.6 / W2.1-W2.3 / W5.1+W5.4 / W6.4 / W10.4 with 29 CI gates
  - v2 (2026-05-08): incorporated Codex round 1 — 7 瑕疵（4 Contract Gap + 2 Major + 1 Minor）：(1) PR-R1 含 TASK_TYPE_BUDGET_PRESETS research preset 同步落（Record<TaskType,...> 编译合同）；(2) `check-stage-r-verify-switch.cjs` 解耦为定义阶段 + 切换阶段两 gate（避免 verify:r 循环依赖）；(3) `registerStaticTool` 替换为真实 ToolDefinition + ToolDomain 'general_research' 新增 + tool-executor switch case 加；(4) capability-resolver `intentGroupModes.general_research = allowResearchTools` 显式装配；(5) web_search/web_fetch 错误用 `ToolDomainError(errorKind)` 而非裸 throw；(6) DomainAdapter 接口为 shouldHandle/applyResult/buildProjectionPatch（不是 matches/apply）；(7) `truthPatch?.taskType ===` 真实位置在 `task-projection-sync.ts:577-581` 不是 continuation-state
  - v3 (2026-05-08): incorporated Codex round 2 — 7 瑕疵（4 Contract Gap + 2 Major + 1 Minor）：(1) DomainAdapter skeleton 按 `domain-adapter.ts:106-213` 真实接口重写（contributePromptFragment 无参、prepare/applyResult/dispatch 返结构化字段、buildProjectionPatch 返 `Record<string,unknown>|null`）；(2) 工具集分流（落点 17）从 `arbitrateRunCapabilities.allowedTools` 移到 `prepare.allowedToolNames`（CoordinatorCapabilityArbitration 只有 forceTool/hideAssistantProcessText/budgetMultiplier）；(3) intentGroupModes 装配真实位是 `execution-intent-resolver.ts:244-252`（非 capability-resolver），增 `general_research: allowResearchTools` 在该对象内；(4) §3.2.3 (g) 新增 `tool-parallelism-policy.ts:118-183` 加 `web_search_/web_fetch_/present_file` 显式分支（默认 `system/interactive` 会让新工具走错策略）+ §3.2.3 (h) `tools/schemas/index.ts:37-49` STATIC_TOOL_INPUT_SCHEMAS spread 新增 `GENERAL_RESEARCH_SCHEMAS`；(5) `web_search_failed/web_fetch_failed` **不**进 TOOL_ERROR_METRICS（registry 是 metric 名表，dispatch 已通过 `TOOL_ERROR_METRICS.surfaced` 自动 emit），保留为 ToolDomainError 的 errorKind 字符串；(6) §8 列表把 `check-stage-r-verify-switch.cjs` 改 `check-verify-r-defined.cjs`（switch gate 不属 verify:r 内嵌）；(7) frontmatter status v3 + 删 continuation-state truthPatch 行号引用
  - v4 (2026-05-08): incorporated Codex round 3 — 6 瑕疵（3 Contract Gap + 1 Major + 2 Minor）：(R3-D1) prepare.allowedToolNames 过滤后**返回空数组而非 null**（filterAllowedToolNamesByPrefixes 无匹配返 null，turn-engine.ts:2543 的 `||` 会让 null 退回全量工具，分流失效）；(R3-D2) `tool-parallelism-policy.ts:58-60` `ToolResourceTag.domain` union 必须扩 `'general_research'`（不仅 getToolResourceTag 加分支）；(R3-D3) `ToolContext`（`tool-executor.ts:60-107`）没有 runtimeRoot/rendererPushAttachment 字段——present_file 通道改走 `requestModuleToolAction`（已存在 IPC 桥）+ `runtime.getArtifactRoot()`（present_file 不需 runtimeRoot 直传）；(R3-D4) present_file `concurrency: 'serialized'`（不是 parallel_read_safe）；(R3-D5) §1.1:35 + §3.3.5 + §3.3.6 残留 `web_search_failed / web_fetch_failed` 进 TOOL_ERROR_METRICS 文字与 §3.2.4 矛盾，统一删；(R3-D6) §10/§13 测试计数 14→15；§11 CLAUDE.md §6.25 草稿同步 4 条 round 3 硬合同
  - v5 (2026-05-08): incorporated Codex round 4 — 3 瑕疵（1 High + 2 Medium）：(R4-D1) §3.1.12 / §6 W6.4 research 分流前缀必须含 `present_file`，否则 `selectedDomainPrepareResult.allowedToolNames` 命中后 present_file 被反向过滤掉与"三件套同 group 同显隐"合同冲突；(R4-D2) `AgentControlRuntime` 不暴露 `getArtifactRoot()`——改用 `SkillsRuntimeManager.getRuntimeInfo().outputsRoot`（实测在 `runtime-manager.ts:181, 595-603, 1670`；present_file outputs 校验通过 SkillsRuntimeManager 单源）；(R4-D3) `executeGeneralResearchTool` args 类型改 `Record<string, unknown>` + handler 内 Zod parse；返回值统一 `string | ToolExecutionOutput`，JSON 用 `createToolExecutionOutput(...)` 包装（`tool-result-types.ts` 导出）
  - v6 (2026-05-09): incorporated Codex round 5 — 4 瑕疵（2 P1 + 2 P2）：(R5-D1) `createToolExecutionOutput` options 真实字段是 `data`（不是 `structured`，实测 `tool-result-types.ts:58-67` only `shape/data/projectionPatch/interactionHint/framePatch/contextModifier`）；(R5-D2) present_file 路径守护改用 `resolveReadableWithinRoot(ctx.outputsRoot, args.path)`（`path-sandbox.ts:202-228`）做 canonical + symlink 校验，朴素 `startsWith` 会被 sibling-prefix 攻击；(R5-D3) §6 W6.4 措辞澄清"同 group 仅指 capability exposure 一致，最终 prepare.allowedToolNames 由 mode-specific prefix 过滤"；(R5-D4) `tool-registry.ts:667` 真实容器是 `GROUP_TOOL_PROVIDERS: Record<CapabilityGroupId, ToolRegistryProvider>`（不是 Map，符号名带 GROUP_ 前缀）
  - v7 (2026-05-09): incorporated Codex round 6 — 3 瑕疵（2 Major + 1 Minor）：(R6-D1) §3.1.3 删 `coordinatorModule: 'research'`（`TaskTypeResolution`（`run-contracts.ts:277-283`）实测无此字段，task-execution-router 只读 `preferredExecutor`，写了无消费）；(R6-D2) module union 同步扩 4 处（不仅 prompt-assembly）：`run-contracts.ts:277-283` TaskTypeResolution / `types.ts:190-199` ScopeRunTriggerHit.module / `types.ts:417-426` ScopeRunEventPayload.module / `renderer/modules/agent/types.ts:103-112` AgentModuleKind / `scopeRunState.ts:159 toAgentModule` 5 处全加 `'research'`，否则前端 `toAgentModule()` 会把 'research' 丢成 null；(R6-D3) §3.1.2 / §3.1.12 / §11 残留旧措辞清干净——browser-mode prefix `browser_research_topic + present_file`，non-browser-mode `web_search + web_fetch + present_file`，"同显隐"仅描述 profile-level exposure
  - v8 (2026-05-09): incorporated Codex round 7 — 3 瑕疵（1 Major + 1 Minor + 1 nit）：(R7-D1) §3.1.5 module union 跨处清单**还要补 renderer IPC 镜像 3 处**（`renderer/types/electron.d.ts:223-238` ScopeRunTriggerHitData.module / `:626-678` ScopeRunEventData.module 与 .artifactRefs[].module / `:475 module: string`、`:2341 module: string | null` 是 string 不需扩），共扩 8 处；(R7-D2) §9 PR 拆分表头是 PR-R1..R8 8 个，但章节描述写"5 个 PR" 是历史残留，统一改成 8 个；(R7-D3) revision_history v5（行 14）的"三件套同 group 同显隐"措辞作为历史描述保留可（不再调整 历史段引用是 round 4 当时的修复理由），但当前 §11 §6.25 (5) 已改 v8 ok
  - v9 (2026-05-09): incorporated Codex round 8 — 2 瑕疵（1 Major + 1 Minor）：(R8-D1) §3.1.5 必须**新增 cjs gate** `check-module-allowlist-completeness.cjs` 显式扫 8 处 union 含 'research'，因 d.ts 独立 union 漏加 'research' typecheck **不一定能撞**（renderer 端 `toAgentModule()` 是 type guard 函数，落到 default 也不报错），不能仅靠 typecheck + 1 个 fixture 兜底；W1.6 gate 由 13 升 14，Stage R 总 gate 由 29 升 30；(R8-D2) §3.1.5 标题与段尾"5 处"统一改"8 处"
  - v10 (2026-05-09): incorporated Codex round 9 — 2 瑕疵（2 Major）：(R9-D1) `verify:r` 脚本串实测漏加 `check-module-allowlist-completeness.cjs`，跟 §3.1.5 / §8 声明的"30 gate"对不上；现已加进 verify:r script；(R9-D2) AST/形状/fixture gate 计数残留 13/29/+13 文字未同步，全部改 14/30/+14（包括统计命令期望值，roadmap §11 总数变 79，待 roadmap v14 落 PR 同步）
  - v11 (2026-05-09): incorporated Codex round 10 — 3 瑕疵（3 Major）：(R10-D1) §9 PR-R5 描述"capability-resolver intentGroupModes 装配"位置错，真实位是 `execution-intent-resolver.ts:244-252`（capability-resolver.ts:66-74 只 merge）；(R10-D2) `executeWebSearch` 与 `executeGeneralResearchTool` ctx 的 `abortSignal: AbortSignal` 必填会类型红，实测 `tool-executor.ts:68` `ToolContext.abortSignal` 是 optional，统一改 `abortSignal?: AbortSignal`；(R10-D3) `getToolDefinitionsDetailed` 返 `ToolDefinitionResolution`（`tool-registry.ts:131-135` 实测 `{ definitions, error?, usedStaticFallback? }` 形状），不是裸 `ToolDefinition[]`
  - v12 (2026-05-09): incorporated Codex round 11 — 3 瑕疵（2 Minor + 1 nit）：(R11-a) §3.1.5 module union 跨处清单 5 处实测均为 9 值 union（browser/document/design/skill/video/rss/calendar/feishu/system），不是 8 值；扩 'research' 后变 10 值（不是 9 值）；(R11-b) §3.1.6 落点 8 标题"capability-resolver 显式装配"措辞与正文 execution-intent-resolver 实位矛盾，标题改"intentGroupModes.general_research 显式装配"；(R11-c) W2.2 sanitizer 输出文件路径从 `src/main/.../history-sanitizer-coverage.md` 改 `docs/superpowers/audits/2026-05-09-history-sanitizer-coverage.md`
  - v13 (2026-05-09): incorporated Codex round 12 — 3 瑕疵（3 Minor）：(R12-a) §1.1 行号修正 `truthPatch?.taskType ===` 真实在 `task-projection-sync.ts:577-581` 不在 continuation-state（continuation-state.ts:419 仅 1 处 'continuation' 字面量）；(R12-b) §1.1 `tools/index.ts:51-56` 实测是 10 个 executeXxxTool 出口（不是 6 个）；(R12-c) `EmbeddedSkillManifest` 实测字段 `{ id, name, description, version, requirementsFile }`（`manifest.ts:6-12`，**无** `enabled` 字段），EMBEDDED_SKILLS[] 6 项新条目按完整字段补全
  - v14 (2026-05-09): incorporated Codex round 13 — 3 瑕疵（1 Contract Gap + 2 Minor）：(R13-a) §1.1 / §3.1.9 澄清 continuation-state.ts 内有 2 处 `=== 'continuation'`：`:127` 在 normalizeTaskType 内（被 isTaskType refactor 吸收）+ `:419` 单独边界判断（保留字面量）；之前措辞误读为"仅 :419 一处"；(R13-b) W1.3 必须扩 `system-reminder-registry.ts:5-25` `ReminderTopic` union 加 `'current-date'`，否则 type 红；assembly 内可能含 Record<ReminderTopic,...> 同步加 key；(R13-c) **W2.3 重写**——ToolRegistry 实测**无 register* 公共 API**，工具走 `GROUP_TOOL_PROVIDERS` provider entry 注入；重名在 `:958-963 listToolDefinitions` 被 `if (!tools.has(name))` **静默吞掉**。改造在 listToolDefinitions 收集阶段做冲突检测，启动期由 AgentControlRuntime constructor 触发 boot invariant 抛 `ToolNameCollisionError`
  - v15 (2026-05-09): incorporated Codex round 14 — 1 瑕疵 + 2 残留澄清：(R14-a) §1.1:50 残留 "W2.3 名重检测在 register* 路径加 throw" 措辞与 R13-c 重写冲突，已改 "改造在 listToolDefinitions() 收集阶段（详见 §4.3）"；(R14-b/c) Codex 提及 "tools/tool-registry.ts 不存在 / tools/tool-gateway.ts 不存在"——本计划全文 grep 无 `src/main/modules/tools/tool-registry.ts` 或 `src/main/modules/tools/tool-gateway.ts` 形态错引；所有 tool-registry / tool-gateway 引用均带正确 `agent-control/` 前缀或上下文清晰指明 agent-control 实位（`tool-registry.ts:667/759/958` 等行号引用与 §1.1 全文一致），无需进一步修改
---

# Stage R (Stage 12) — deer-flow 借鉴 · 合同基础 · 实施计划

## 0. 背景

`2026-05-08-deerflow-borrowing-roadmap.md` v13（13 轮 Codex 收敛）划定 Stage R 目标：建立 deep-research 全栈基础设施 + 三处工具边界硬合同 + observability 起点 + present_file + 纠错识别。

**M1 里程碑跨段**：deep-research 真正可用要等 Stage S 完成 W3.0/W3.1/W4.0/W4.1/W4.2/W4.3/W4.4/W5.2/W5.3/W8.2。Stage R 完成只代表"deep-research 基础设施 ready"。

## 1. 现实核实（基于 worktree 实测）

### 1.1 现有架构形态

- **TaskType union**：`src/main/modules/agent-control/run-contracts.ts:104-109` 当前 5 值（`direct_answer / short_task / multi_step_task / media_task / continuation`）。**没有** shared/task-types.ts —— 路线图 W1.6 落点 15 要新建。
- **IntentDomain union**：`src/main/modules/agent-control/intent-classifier.ts:4` 当前 8 值（`browser / document / rss / calendar / feishu / skill / pet / generic`）—— 加 'research' 第 9 值。
- **DomainAdapter 装载位**：**`src/main/modules/claude-bridge/direct-chat.ts:446-457`**（不是路线图说的 host 包；DirectChat 里直接 new 出 6 个 adapter）。新加 `new ResearchDomainAdapter()` 到该数组。
- **TASK_TYPE_BUDGET_PRESETS**：`src/main/modules/agent-control/run-budget-policy.ts:16-43` 5 条记录，对应 5 值 TaskType；新增 `research: { maxIterations: 60, maxToolCalls: 60 }` 第 6 条。
- **Continuation-state allowlist**（**Codex round 13 修正**）：`src/main/modules/agent-control/continuation-state.ts` 内有 2 处 `=== '<task-type>'`：(a) `:121-132` `normalizeTaskType()` 5 个字面量（含 `:127 === 'continuation'`），改为用 `isTaskType()` helper；(b) `:419 projection.taskType === 'continuation'` 单独 1 处边界判断保留字面量（continuation 是 type-narrowing 比较，不在 union 完整覆盖范围）。
- **Task-projection-sync allowlist**：`src/main/modules/agent-control/task-projection-sync.ts:577-581` `truthPatch?.taskType ===` 5 比较（**Codex round 12 修正**：之前误标在 continuation-state，真实位置在这里）。
- **Task-projection-sync allowlist**：`src/main/modules/agent-control/task-projection-sync.ts` 含同形态比较位（详见 §3.1.7）。
- **Renderer TaskTypeData**：`src/renderer/types/electron.d.ts:403-408` 当前独立 5 值 union。要改为 `import type { TaskType } from '../../shared/task-types'; type TaskTypeData = TaskType`。
- **Capability groups**：`src/shared/ai-capability-groups.ts:1-14` `CapabilityGroupId` 13 值 + `CAPABILITY_GROUPS` 数组；新增 `'general_research'` 第 14 值。
- **TOOL_ERROR_METRICS**：`src/main/modules/agent-control/tool-error-metrics.ts:19` 是 **metric 名注册表**（不是 errorKind 字符串集合）；dispatch 通过 `TOOL_ERROR_METRICS.surfaced`（`tool-executor.ts:346`）已经统一 emit，并把 errorKind 作为字段一起报。所以 `web_search_failed / web_fetch_failed` **不进** TOOL_ERROR_METRICS，保留为 `ToolDomainError.errorKind` 字符串。
- **Embedded skill manifest 注册位**：`src/main/modules/skills-runtime/manifest.ts` `EmbeddedSkillId` union + `EMBEDDED_SKILLS[]` 当前 3 项（lets-go-rss / video-copy-analyzer / video-expert-analyzer）。Stage R 加 6 项（deep-research + 5 方法论）。
- **历史 sanitizer**：`src/main/modules/claude-bridge/openai-history-sanitization.ts:78-171` `sanitizeOpenAICompatibleMessageHistory` 已是 drop-only。本 stage 是 **审计 + 补齐 Anthropic / Gemini / 自定义 provider 路径**，不重写。
- **Tool registry**：`src/main/modules/agent-control/tool-registry.ts:759` `ToolRegistry` class；**Codex round 13 修正**：无 `register*` 公共 API，工具走 `GROUP_TOOL_PROVIDERS` provider entry；W2.3 名重检测改造在 `listToolDefinitions()` 收集阶段（详见 §4.3）。
- **System reminder registry**：`src/main/modules/agent-control/system-reminder-registry.ts:33` `SystemReminderRegistry` interface；W1.3 注入 `topic: 'current-date'` 通过该接口。
- **Direct-chat 工具调度桥**：`src/main/modules/tools/index.ts:51-56` 多个 `executeXxxTool` 出口（实测 10 个：browser/skill/feishu/memory/pet/sessionRecall/document/rss/calendar/system）；新 `executeGeneralResearchTool` 加进同一 barrel，由 ToolGateway 经 tool-executor switch 派发。

### 1.2 Verify chain

- 当前主 `verify` 串：`package.json` 顶层 `verify` 走 `verify:q`（Stage Q 收敛后切到 verify:q）。Stage R 完成后切 `verify:r`。
- `verify:cloud`：`npm run rebuild:native && npm run verify:q && npm run test`。Stage R 后改为同款指向 `verify:r`。
- CLAUDE.md 当前 §6.24 是 Stage Q（resumability 三层 fence）；Stage R 起新增 §6.25。

### 1.3 deer-flow 资料路径

- 本地 clone：`/Users/user/Documents/实验田/_research/deer-flow/`（注意：worktree 在 `.claude/worktrees/deerflow-stage-r-s-t/`，但 deer-flow clone 在主仓外）。
- `backend/packages/harness/deerflow/agents/middlewares/` 18 个 middleware 是 Theme 5/6/8 的源材料。
- `backend/packages/harness/deerflow/tools/builtins/` 含 `clarification_tool.py / present_file_tool.py / tool_search.py`（Theme 6/T-C）。
- `backend/packages/harness/deerflow/community/` 9 个 search provider — Stage R 仅采用 Tavily / DDG / Jina。
- `backend/packages/harness/deerflow/skills/` Python 实现的 `tool_policy.py / security_scanner.py`（Theme 11，Stage S）。

## 2. W0.1 — verify:r 定义

### 2.1 package.json scripts 增量

加在 `verify:q` 后面：

```jsonc
"test:r:gates": "node --test eslint-rules/__tests__/*.test.mjs scripts/__tests__/*.test.cjs",
"test:r:focus": "npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/research-domain-adapter.test.ts src/__tests__/research-end-to-end-routing.test.ts src/__tests__/web-search-tool.test.ts src/__tests__/web-fetch-tool.test.ts src/__tests__/current-date-reminder.test.ts src/__tests__/embedded-skill-deep-research.test.ts src/__tests__/embedded-skill-methodology-set.test.ts src/__tests__/tool-call-args-hash.test.ts src/__tests__/tool-input-sanitizer-coverage.test.ts src/__tests__/tool-name-uniqueness.test.ts src/__tests__/run-span-metadata.test.ts src/__tests__/auto-title-middleware.test.ts src/__tests__/present-file-tool.test.ts src/__tests__/correction-detector.test.ts src/__tests__/task-types-shared-source.test.ts",
"verify:r": "npm run verify:q && node scripts/check-verify-r-defined.cjs && node scripts/check-intent-domain-includes-research.cjs && node scripts/check-module-allowlist-completeness.cjs && node scripts/check-research-end-to-end-routing.cjs && node scripts/check-research-plan-not-document-task-plan.cjs && node scripts/check-research-in-all-task-route-unions.cjs && node scripts/check-research-in-coordinator-module-normalizer.cjs && node scripts/check-research-adapter-registered-in-host.cjs && node scripts/check-allow-research-tools-gate.cjs && node scripts/check-research-tasktype-downstream-consumers.cjs && node scripts/check-research-tools-distinguish-by-mode.cjs && node scripts/check-research-budget-preset-shape.cjs && node scripts/check-research-budget-not-fallthrough-to-24.cjs && node scripts/check-web-tools-in-general-research-group-only.cjs && node scripts/check-tasktype-allowlist-completeness.cjs && node scripts/check-web-search-tool-shape.cjs && node scripts/check-web-search-end-to-end.cjs && node scripts/check-web-fetch-tool-shape.cjs && node scripts/check-web-fetch-end-to-end.cjs && node scripts/check-current-date-reminder-registered.cjs && node scripts/check-deep-research-skill-asset-present.cjs && node scripts/check-embedded-skill-manifest-vs-asset-parity.cjs && node scripts/check-methodology-skills-asset-present.cjs && node scripts/check-tool-call-args-hash-stable.cjs && node scripts/check-tool-input-sanitizer-single-source.cjs && node scripts/check-tool-name-uniqueness.cjs && node scripts/check-run-span-metadata-keys-frozen.cjs && node scripts/check-auto-title-fallback.cjs && node scripts/check-present-file-only-outputs-dir.cjs && node scripts/check-correction-detector-fixtures.cjs && npm run test:r:gates && npm run test:r:focus"
```

### 2.2 Stage R done 后三处切换

**条件**：本 stage 全部 W 项 land 且 verify:r 在 CI 与本地均绿。

切换原子操作：

1. `package.json`：`"verify": "npm run verify:native && npm run verify:r && npm run test"`（保持 `verify:native` 前置）
2. `package.json`：`"verify:cloud": "npm run rebuild:native && npm run verify:r && npm run test"`
3. `CLAUDE.md` 加新章节 §6.25（见 §11）

### 2.3 Gate 拆分（避免循环依赖）

**Codex round 1 修正**：原方案 `verify:r` 内含 `check-stage-r-verify-switch.cjs` 但切换在 PR-R8 才发生 → PR-R2..R7 期间 verify:r 必败。拆为两 gate：

- **`check-verify-r-defined.cjs`**（**进 verify:r 自身**）：仅断 `verify:r` 脚本存在 + `test:r:gates` + `test:r:focus` 存在 + `verify:q` 内嵌于 verify:r 脚本中
- **`check-stage-r-verify-switch.cjs`**（**不进 verify:r**，在 PR-R8 提交时由 CI 单独跑作为 stage 切换 gate）：
  - 断主 `verify` 串包含 `verify:r`
  - 断 `verify:cloud` 串包含 `verify:r`
  - 断 `CLAUDE.md` 含 `### 6.25`
  - 实施：在 `package.json` 加 `"verify:r:switch": "node scripts/check-stage-r-verify-switch.cjs"`，PR-R8 commit message 引用执行结果

依赖：W0.1 是其余所有 W 的前置（仅"定义存在" gate）；切换 gate 只在收尾 PR 跑。

## 3. Theme 1 [RC-1] · Research Stack

### 3.1 W1.6 — Research domain adapter（17 件套）

**这是 Stage R 最大的工作项。** 路线图 §3.1.1 已定 17 落点；本节给行号级合同。

#### 3.1.1 落点 15：TaskType 单源（前置）

新文件 `src/shared/task-types.ts`：

```ts
export const TASK_TYPES = [
  'direct_answer',
  'short_task',
  'multi_step_task',
  'media_task',
  'continuation',
  'research',
] as const

export type TaskType = typeof TASK_TYPES[number]

export function isTaskType(value: unknown): value is TaskType {
  return typeof value === 'string' && (TASK_TYPES as readonly string[]).includes(value)
}
```

**main 改造**：`src/main/modules/agent-control/run-contracts.ts:104-109` 改：

```ts
import type { TaskType } from '../../../shared/task-types'
export type { TaskType }
```

**renderer 改造**：`src/renderer/types/electron.d.ts:403-408` 改：

```ts
import type { TaskType } from '../../shared/task-types'
type TaskTypeData = TaskType
```

注意 d.ts 文件用 `import type` 不破 §3 三段约束（CLAUDE.md 行 33-37）。

#### 3.1.2 落点 1-2：新建 research-domain-adapter + 加入 IntentDomain

**新文件** `src/main/modules/agent-control/research-domain-adapter.ts`：

**Codex round 1+2 修正**：`DomainAdapter` 接口实测在 `domain-adapter.ts:106-213`。完整签名骨架：

```ts
import type {
  DomainAdapter,
  DomainAdapterSelectionContext,
  DomainAdapterPrepareParams,
  DomainAdapterPrepareResult,
  DomainAdapterDispatchParams,
  DomainAdapterDispatchResult,
  DomainAdapterApplyParams,
  DomainAdapterApplyResult,
  DomainAdapterProjectionParams,
  CoordinatorPromptFragment,
  CoordinatorCapabilityArbitration,
  CoordinatorTextDecorationPhase,
} from './domain-adapter'

export class ResearchDomainAdapter implements DomainAdapter {
  readonly id = 'research' as const

  shouldHandle(params: DomainAdapterSelectionContext): boolean {
    return params.route?.taskType === 'research'
  }

  contributePromptFragment(): CoordinatorPromptFragment[] | null {
    // deep-research SKILL 通过 reference inline 注入（W1.4 内联），不在此硬编码
    return null
  }

  arbitrateRunCapabilities(_params: DomainAdapterPrepareParams): CoordinatorCapabilityArbitration | null {
    // 仅 forceTool / hideAssistantProcessText / budgetMultiplier 字段；不在此分流工具集
    return null
  }

  decorateUserText(text: string, _params: { phase: CoordinatorTextDecorationPhase }): string {
    return text
  }

  prepare(params: DomainAdapterPrepareParams): DomainAdapterPrepareResult {
    // 工具集分流（落点 17）落在这里：browser-mode 选 browser_research_topic + present_file；non-browser-mode 选 web_search + web_fetch + present_file
    return {
      allowedToolNames: this.resolveAllowedToolNames(params),
    }
  }

  dispatch(_params: DomainAdapterDispatchParams): DomainAdapterDispatchResult {
    // 走 turn-engine 默认 tool_loop（不返 finish；让上层正常驱动 LLM 循环）
    return {}
  }

  applyResult(_params: DomainAdapterApplyParams): DomainAdapterApplyResult {
    return {}
  }

  buildProjectionPatch(_params: DomainAdapterProjectionParams): Record<string, unknown> | null {
    return null
  }

  private resolveAllowedToolNames(params: DomainAdapterPrepareParams): string[] | null {
    // 实施期细化：从 params.executionIntentContext / params.toolPolicy 读 capability profile
    // browser-mode → 收紧到 [...existing, 'browser_research_topic']
    // non-browser-mode → 收紧到 [...existing, 'web_search', 'web_fetch', 'present_file']
    return params.allowedToolNames
  }
}
```

**关键合同**：
- `shouldHandle` 用 `params.route.taskType === 'research'`（route 已由 task-type-resolver 在落点 3 派生）。
- `contributePromptFragment` 是无参的，返 `CoordinatorPromptFragment[] | null`。
- `prepare.allowedToolNames` 是工具集分流落点（不是 arbitrateRunCapabilities）。
- `dispatch` 不返 `{type:...}`，返结构化字段 `{ sessionMessages?, domainState?, interactionState?, finalText?, projection?, finish? }`，全 optional 时即"走默认 tool_loop"。
- `buildProjectionPatch` 返 `Record<string, unknown> | null`，不是 `DomainAdapterProjection | null`。

**`intent-classifier.ts:4` 改**：

```ts
export type IntentDomain =
  | 'browser' | 'document' | 'rss' | 'calendar' | 'feishu' | 'skill' | 'pet'
  | 'research'
  | 'generic'
```

**关键词矩阵**（加进 `DOMAIN_OBJECT_PATTERNS` + `DOMAIN_ACTION_PATTERNS`，参考 `:23-50` 形态）：

中文 object：研究 / 调研 / 综述 / 报告 / 综评 / 综合分析  
中文 action：研究 / 调研 / 综述 / 对比分析 / 调查 / 整理研究  
英文 object：research / survey / review / analysis / overview  
英文 action：research / survey / compare / investigate / explain in depth / what is X

#### 3.1.3 落点 3：task-type-resolver.ts research 分支

**位置**：`src/main/modules/agent-control/task-type-resolver.ts` 在 `intent.primaryDomain === 'generic'` 兜底分支**之前**插入。

**Codex round 6 R6-D1 修正**：`TaskTypeResolution`（`run-contracts.ts:277-283`）实测**没有** `coordinatorModule` 字段；task-execution-router 只读 `preferredExecutor`。**不要写** `coordinatorModule: 'research'`，会编译失败 / 引入无消费字段：

```ts
if (params.intent.primaryDomain === 'research') {
  return {
    taskType: 'research',
    executionChain: 'domain_executor',
    preferredExecutor: 'research',
    requiresPlanner: false,
  }
}
```

#### 3.1.4 落点 4-6：run-contracts.ts 三处 union 扩展

- `:282` `TaskTypeResolution.preferredExecutor` 加 `'research'`
- `:289` `TaskExecutionRoute.executor` 加 `'research'`
- TaskType union 已通过落点 15 间接扩（shared 重导出）

#### 3.1.5 落点 7：module union 跨 8 处同步（不仅 prompt-assembly）

**Codex round 6+7 修正**：仅扩 prompt-assembly 不够；module 字符串 union 在 main + renderer + types + renderer IPC 镜像共 8 处独立定义，不同步会让前端把 'research' 丢成 null：

| 位置 | 当前 union 值 | 改动 |
|---|---|---|
| `run-contracts.ts:277-283` `TaskTypeResolution.preferredExecutor` | 字面量 union | 已在落点 6 加 'research' |
| `prompt-assembly.ts:100-108` `normalizeCoordinatorModule` | 函数体 | 加 `id === 'research'` 接受 |
| `prompt-assembly.ts:38` trigger module union | 字面量 union | 加 `'research'` |
| `types.ts:190-199` `ScopeRunTriggerHit.module` | 9 值 union（browser/document/design/skill/video/rss/calendar/feishu/system） | 加 `'research'`，变 10 值 |
| `types.ts:417-426` `ScopeRunEventPayload.module` | 9 值 union | 加 `'research'`，变 10 值 |
| `renderer/modules/agent/types.ts:103-112` `AgentModuleKind` | 9 值 union | 加 `'research'`，变 10 值 |
| `renderer/modules/agent/scopeRunState.ts:159 toAgentModule()` | switch | 加 `case 'research': return 'research'` |
| **renderer IPC 镜像（R7-D1 修正）** | | |
| `renderer/types/electron.d.ts:223-238` `ScopeRunTriggerHitData.module` | 9 值 union | 加 `'research'`（要镜像 main 端 `types.ts:190-199`），变 10 值 |
| `renderer/types/electron.d.ts:626-678` `ScopeRunEventData.module` 与 `.artifactRefs[].module` | 两处 9 值 union | 各加 `'research'`（要镜像 main 端 `types.ts:417-426`），变 10 值 |
| `renderer/types/electron.d.ts:475 module: string` / `:2341 module: string \| null` | 已是 string 类型 | **不需扩**（string 接受任意值） |

**测试**：`task-types-shared-source.test.ts` 同步加 module-union allowlist 验证：fixture 跑过 `toAgentModule('research')` 必须返 `'research'` 而非 null；同时 typecheck 自身会保护 main 端字面量 union（落点 1-7 任一处漏 'research' 会编译失败）。

**新增 cjs gate**（**Codex round 8 R8-D1 修正**）：`check-module-allowlist-completeness.cjs` 必须显式扫 8 处 union 各自含 `'research'` 字面量；因 renderer `electron.d.ts` 的 3 处 IPC 镜像是独立 union（main 加了 'research' 不会让 d.ts 报错），且 `toAgentModule()` 是 type guard 函数（落到 default 也不报 typecheck 错），仅靠 typecheck + 1 个 runtime fixture 不足兜底。**W1.6 gate 由 13 升 14，Stage R 总 gate 由 29 升 30**（同步更新 §8 与 §13）。

`task-types-shared-source.test.ts` 同步加 module-union allowlist 验证：fixture 跑过 `toAgentModule('research')` 必须返 `'research'` 而非 null；与 cjs gate 互补（gate 扫 union 形态，test 扫 runtime 行为）。

#### 3.1.6 落点 8：execution-intent-resolver.ts 加 research gate + intentGroupModes.general_research 显式装配

**位置 A**：`src/main/modules/agent-control/execution-intent-resolver.ts:200-244` 周围（`baseVisibilityPlan` 计算后）插入：

```ts
const hasResearchIntent =
  positiveDomains.has('research') && !excludedDomains.has('research')
const allowResearchTools = baseVisibilityPlan.hasTools && hasResearchIntent
```

**位置 B（Codex round 2 修正）**：`src/main/modules/agent-control/execution-intent-resolver.ts:244-252` `intentGroupModes` 对象**必须显式写入** `general_research`（capability-resolver.ts:69-74 是另一处 merge 入口，没有 `allowResearchTools` 作用域，不在那写）：

```ts
intentGroupModes: {
  ...(hasLiveInfoBrowserIntent ? { browser_interaction: true } : {}),
  document: allowDocumentTools,
  rss: allowRSSTools,
  calendar: allowCalendarTools,
  channel_feishu: allowFeishuTools,
  pet: allowPetTools,
  skills: allowSkillTools,
  general_research: allowResearchTools, // 新增
},
```

只有这样，未命中 research intent 的 turn 才不会因 profile 默认 `local_chat / scheduled_run` 命中而把 web_search/web_fetch 暴露给模型。

`prompt-assembly.ts:38` trigger module union 同步加 `'research'`。

#### 3.1.7 落点 9：DirectChat 装载 ResearchDomainAdapter

**位置**：`src/main/modules/claude-bridge/direct-chat.ts:446` `domainAdapters` 数组**首位**插入：

```ts
this.domainAdapters = [
  new ResearchDomainAdapter(),
  new BrowserDomainAdapter(this.browserDomainOrchestrator as never),
  // ...
]
```

放首位是合规决策：research 意图必须早期分流，不让 browser/document 优先吞掉（路线图 §3.1.1 触发段说明）。

#### 3.1.8 落点 10：run-budget-policy preset

`src/main/modules/agent-control/run-budget-policy.ts:16-43` `TASK_TYPE_BUDGET_PRESETS`：

```ts
const TASK_TYPE_BUDGET_PRESETS: Record<TaskType, Pick<RunBudgetSeed, 'maxIterations' | 'maxToolCalls'>> = {
  direct_answer: { maxIterations: 8, maxToolCalls: 8 },
  short_task: { maxIterations: 24, maxToolCalls: 24 },
  multi_step_task: { maxIterations: 40, maxToolCalls: 40 },
  media_task: { maxIterations: 60, maxToolCalls: 60 },
  continuation: { maxIterations: 24, maxToolCalls: 24 },
  research: { maxIterations: 60, maxToolCalls: 60 }, // 新增
}
```

#### 3.1.9 落点 11-13：allowlist 三处加 research

**`continuation-state.ts:121-132` `normalizeTaskType`**：改为用 `isTaskType` helper：

```ts
import { isTaskType } from '../../../shared/task-types'

function normalizeTaskType(value: unknown): TaskType {
  return isTaskType(value) ? value : 'short_task'
}
```

**`task-projection-sync.ts:577-581` `truthPatch?.taskType === ...`**（Codex round 1 修正：原计划写在 continuation-state.ts，行号实测错；真实位置在 task-projection-sync.ts）：保留 `=== 'continuation'` 字面量分支，其余 `=== 'X'` 用 `isTaskType()` + `&& truthPatch.taskType !== 'continuation'` 形态。

`continuation-state.ts:127` `normalizeTaskType` 内的 `=== 'continuation'` 改用 `isTaskType` 整体替代（5 个分支合一）；`:419 projection.taskType === 'continuation'` 单独保留字面量比较（continuation 边界判断）。

**`types.ts` ScopeRunSummary / ScopeRunEventPayload**：两处独立 5 值 union 改 `import type { TaskType }`。具体行号实施期 grep。

#### 3.1.10 落点 14：研究续跑预算合同

**`run-budget-policy.ts:77-80`** 续跑分支扩：

```ts
if (
  inheritedFromTaskType === 'multi_step_task'
  || inheritedFromTaskType === 'media_task'
  || inheritedFromTaskType === 'research'
) return createRunBudgetSeed(inheritedFromTaskType)
```

**`turn-engine.ts:2506-2508`** 续跑预算 override + **`task-execution-router.ts`** 60 处 planner 派生 — 实施期 grep 全部加 research 分支。

#### 3.1.11 落点 16：AST gate `check-tasktype-allowlist-completeness.cjs`

**模板参考**：`scripts/check-coordinator-isolation.cjs:6, 43-67` 的 typescript API 模式。

扫描规则：

1. 所有 `taskType: <string-literal>` 字段赋值（含 type 注解 + value 表达）—— literal 必须 ∈ `TASK_TYPES`
2. 所有 `Record<TaskType, X>` 字面量必须 6 keys 齐全
3. 所有 `value === '<task-type-literal>'` type guard —— 必须配 `isTaskType()` 调用 OR 该比较位整体 union exhaustiveness

**白名单**（路线图明确）：
- `browser-engine/capability-types.ts:77` `BrowserCapabilityTaskKind`（不是 TaskType）
- `tools/schemas/browser-content-schemas.ts:64`
- `task-projection-repository.ts:380-381` SQL constants
- `__tests__/fixtures/**`
- `shared/task-types.ts`（union 定义本身）

#### 3.1.12 落点 17：research 工具策略分流

**Codex round 2 修正**：`CoordinatorCapabilityArbitration`（`domain-adapter.ts:40-44`）只有 `forceTool / hideAssistantProcessText / budgetMultiplier`；**没有** `allowedTools`。工具分流落点是 `prepare.allowedToolNames`（`DomainAdapterPrepareResult` 字段，`domain-adapter.ts:136-140`）。

**`research-domain-adapter.ts.prepare`** 内逻辑（已在 §3.1.2 skeleton 中体现）：

**Codex round 3 关键修正（R3-D1）**：`filterAllowedToolNamesByPrefixes`（`domain-adapter.ts:215-224`）在过滤后无匹配时返 `null`；但 `turn-engine.ts:2543` 的 `||` 退回逻辑会让 `null` 解为"unrestricted_passthrough"，把全量工具暴露给模型——research 分流彻底失效。所以必须**显式收紧到 []** 而非 null：

```ts
import { filterAllowedToolNamesByPrefixes } from './domain-adapter'

prepare(params: DomainAdapterPrepareParams): DomainAdapterPrepareResult {
  const isBrowserMode = /* 实施期：从 params.executionIntentContext / toolPolicy 读 */
  const inputAllowed = params.allowedToolNames ?? null
  // Codex round 4 R4-D1 / round 5 R5-D3：present_file 与 web_search/web_fetch 同 capability group（profile-level exposure 一致），由 mode-specific prefix 进一步分流；present_file 在两 mode 都纳入
  const prefixes = isBrowserMode
    ? ['browser_research_topic', 'present_file']
    : ['web_search', 'web_fetch', 'present_file']
  const filtered = filterAllowedToolNamesByPrefixes(inputAllowed, prefixes)
  // R3-D1: filtered 为 null 表示"input 为空 OR 过滤后空"——后者会被 turn-engine.ts:2543 当 passthrough 解，破坏分流；
  // 显式收紧到空数组，让模型只能拿到 prefix 工具。
  return {
    allowedToolNames: filtered ?? [],
  }
}
```

`filterAllowedToolNamesByPrefixes` 是 `domain-adapter.ts:215-224` 已存在 helper，可直接 import。

**deep-research SKILL.md 顶部 `<tools-contract>` 段**（W1.4 落点）描述这个分流给模型看。

#### 3.1.13 W1.6 14 个 gate（含 round 8 新增 module-union completeness gate）

详见 §8.

### 3.2 W1.1 — web_search 工具（Tavily + DDG fallback）

#### 3.2.1 新文件结构

```
src/main/modules/tools/builtins/
├── web-search.ts            # 工具实现
└── web-fetch.ts             # 工具实现 (W1.2)
```

`builtins/` 子目录是新建。

#### 3.2.2 实现合同

```ts
// src/main/modules/tools/builtins/web-search.ts
import { z } from 'zod'

export const webSearchSchema = z.object({
  query: z.string().min(1).max(500),
  topK: z.number().int().min(1).max(10).optional().default(5),
})

export async function executeWebSearch(
  args: z.infer<typeof webSearchSchema>,
  ctx: { abortSignal?: AbortSignal; tavilyKey?: string },
): Promise<{ results: Array<{ title: string; url: string; snippet: string; source: 'tavily' | 'ddg' }> }> {
  // 1. Try Tavily (if tavilyKey present)
  // 2. Fallback to DDG (HTML scrape, rate-limited)
  // 3. failure → throw ToolDomainError('web_search_failed', ...) — errorKind 字符串由 ToolDomainError 携带，不进 TOOL_ERROR_METRICS
}
```

#### 3.2.3 注册位（Codex round 1 修正：完整工具系统集成）

实测 ToolRegistry 没有 `registerStaticTool` 公共 API；工具走 ToolDefinition + 静态名映射 + tool-executor switch case 三段。完整集成：

**(a) `src/shared/ai-capability-groups.ts`**：`CapabilityGroupId` 加 `'general_research'`；`CAPABILITY_GROUPS[]` 加条目（exposure: `'model_visible'`, defaultProfiles: `['local_chat', 'scheduled_run']`，**不**含 remote_channel——避免 Tavily key 远程滥用）。

**(b) `src/main/modules/agent-control/tool-definition.ts:4-15`** `ToolDomain` union 加 `'general_research'` 第 12 值（与 CapabilityGroupId 'general_research' 同名，便于 1:1 映射）。

**(c) `src/main/modules/agent-control/tool-registry.ts`**：
- 新加常量 `GENERAL_RESEARCH_TOOL_NAMES = ['web_search', 'web_fetch', 'present_file']`
- 新建 provider entry 给 `general_research` group（**Codex round 5 R5-D4 修正**：实测在 `:667 GROUP_TOOL_PROVIDERS: Record<CapabilityGroupId, ToolRegistryProvider>`，**不是** Map；ToolRegistry constructor `:760-765` `this.groupProviders = { ...GROUP_TOOL_PROVIDERS, ... }` spread）：
  - `staticToolNames: GENERAL_RESEARCH_TOOL_NAMES`
  - `getToolDefinitionsDetailed(sessionId): ToolDefinitionResolution`（**R10-D3 修正**：实测 `tool-registry.ts:131-135` 返 `{ definitions: ToolDefinition[]; error?: string | null; usedStaticFallback?: boolean }`，**不**是裸 `ToolDefinition[]`）：`{ definitions: [...], error: null, usedStaticFallback: false }`，三个 ToolDefinition：
    - `web_search`: domain `'general_research'`, kind `'read'`, concurrency `'parallel_read_safe'`
    - `web_fetch`: domain `'general_research'`, kind `'read'`, concurrency `'parallel_read_safe'`
    - `present_file`: domain `'general_research'`, kind `'interactive'`, concurrency `'serialized'`（**R3-D4 修正**：interactive/IPC 写不能并行）
  - `getAnthropicTools / getOpenAITools` 走 zod schema → JSON schema 标准转换（参考现有 system tools 形态）

**(d) `src/main/modules/tools/tool-executor.ts:270` switch (definition.domain)**（**Codex round 3+4 修正**：ToolContext 实测在 `:60-107`，**没有** `runtimeRoot / rendererPushAttachment` 字段；不扩 ToolContext。`AgentControlRuntime` 不暴露 `getArtifactRoot()`；通过 `SkillsRuntimeManager.getRuntimeInfo().outputsRoot`（实测在 `skills-runtime/runtime-manager.ts:181, 595-603`）单源派生）：

```ts
import { getSkillsRuntimeManager } from '../skills-runtime/runtime-manager'

case 'general_research': {
  const runtimeInfo = getSkillsRuntimeManager().getRuntimeInfo()
  return executeGeneralResearchTool(toolName, args as Record<string, unknown>, {
    abortSignal: context.abortSignal,
    sessionId: context.sessionId,
    outputsRoot: runtimeInfo.outputsRoot,
    requestModuleToolAction: context.requestModuleToolAction,
    scope: context.scope,
  })
}
```

**(e) 新建调度文件** `src/main/modules/tools/general-research-tools.ts`（**Codex round 4 R4-D3 修正**：args 类型 `Record<string, unknown>` + handler 内 Zod parse；返回值 `string | ToolExecutionOutput`，JSON 走 `createToolExecutionOutput(...)`）：

```ts
import { ToolDomainError } from './tool-errors'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../agent-control/tool-result-types'
import type { ConversationScope } from '../agent-control/types'
import { webSearchSchema, executeWebSearch } from './builtins/web-search'
import { webFetchSchema, executeWebFetch } from './builtins/web-fetch'
import { presentFileSchema, executePresentFile } from './builtins/present-file'

export interface GeneralResearchToolContext {
  abortSignal?: AbortSignal  // R10 修正：tool-executor.ts:68 ToolContext.abortSignal 是可选的，strict 下必填会类型红
  sessionId?: string
  outputsRoot: string
  requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  scope?: ConversationScope | null
}

export async function executeGeneralResearchTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: GeneralResearchToolContext,
): Promise<string | ToolExecutionOutput> {
  switch (toolName) {
    case 'web_search': {
      const parsed = webSearchSchema.safeParse(args)
      if (!parsed.success) throw new ToolDomainError('input_validation', parsed.error.message)
      const result = await executeWebSearch(parsed.data, ctx)
      return createToolExecutionOutput(JSON.stringify(result), { data: result })
    }
    case 'web_fetch': {
      const parsed = webFetchSchema.safeParse(args)
      if (!parsed.success) throw new ToolDomainError('input_validation', parsed.error.message)
      const result = await executeWebFetch(parsed.data, ctx)
      return createToolExecutionOutput(JSON.stringify(result), { data: result })
    }
    case 'present_file': {
      const parsed = presentFileSchema.safeParse(args)
      if (!parsed.success) throw new ToolDomainError('input_validation', parsed.error.message)
      const result = await executePresentFile(parsed.data, ctx)
      return createToolExecutionOutput(JSON.stringify(result), { data: result })
    }
    default:
      throw new ToolDomainError('tool_not_registered', `Unknown general_research tool: ${toolName}`)
  }
}
```

**present_file 内部**：通过 `ctx.requestModuleToolAction('renderer:present-file', { path, reason })` 经 IPC 桥推到 renderer；artifactRoot 校验通过 `ctx.outputsRoot`（main 已传给 ctx 的字符串路径）。**不**新加 ToolContext 字段，**不**直接持 SkillsRuntimeManager 引用。

**(f) `src/main/modules/tools/index.ts`**：新加 `export { executeGeneralResearchTool } from './general-research-tools'`，并更新 `executeToolCall` 调度（实测在 tool-executor.ts:270 switch 内 import 即可）。

**(g) `src/main/modules/agent-control/tool-parallelism-policy.ts`**（Codex round 2+3）：

**两步**改：

1. **R3-D2 union 扩**：`:58-60` `ToolResourceTag.domain` union 加 `'general_research'`：

```ts
export interface ToolResourceTag {
  domain: 'browser' | 'document' | 'file' | 'rss' | 'calendar' | 'feishu' | 'skill' | 'memory' | 'session' | 'pet' | 'system' | 'general_research'
  accessMode: 'read' | 'write' | 'interactive'
}
```

2. `:118-183` `getToolResourceTag` switch 内在 system 兜底前加显式分支：

```ts
if (normalized === 'web_search') return { domain: 'general_research', accessMode: 'read' }
if (normalized === 'web_fetch') return { domain: 'general_research', accessMode: 'read' }
if (normalized === 'present_file') return { domain: 'general_research', accessMode: 'interactive' }
```

否则三个新工具会落到 `system/interactive` 默认分支，让 web_search / web_fetch（read-safe）走错并行策略。

**(h) `src/main/modules/tools/schemas/index.ts:37-49`** `STATIC_TOOL_INPUT_SCHEMAS`（Codex round 2 新增）：

新建 `src/main/modules/tools/schemas/general-research-schemas.ts`：

```ts
import type { ZodObject, ZodRawShape } from 'zod'
import { webSearchSchema } from '../builtins/web-search'
import { webFetchSchema } from '../builtins/web-fetch'
import { presentFileSchema } from '../builtins/present-file'

export const GENERAL_RESEARCH_SCHEMAS: Record<string, ZodObject<ZodRawShape>> = {
  web_search: webSearchSchema as ZodObject<ZodRawShape>,
  web_fetch: webFetchSchema as ZodObject<ZodRawShape>,
  present_file: presentFileSchema as ZodObject<ZodRawShape>,
}
```

`schemas/index.ts` 顶部 import + spread：

```ts
import { GENERAL_RESEARCH_SCHEMAS } from './general-research-schemas'

const STATIC_TOOL_INPUT_SCHEMAS: Record<string, ZodObject<ZodRawShape>> = {
  // ... existing spread
  ...GENERAL_RESEARCH_SCHEMAS, // 新增
}
```

否则 dispatch-time `tool-input-validator` 会让新工具 args 不经 Zod 校验直接进 handler。

#### 3.2.4 错误指标 + ToolDomainError 抛错（Codex round 1+2 修正）

**Codex round 2 修正**：`TOOL_ERROR_METRICS` 是 **metric 名注册表**（`tool-error-metrics.ts:19-37`），不是 errorKind 字符串集合；dispatch 通过 `TOOL_ERROR_METRICS.surfaced`（`tool-executor.ts:346`）已经统一打 metric，并把 `errorKind` 作为字段一起报。所以**不**往 TOOL_ERROR_METRICS 加 `web_search_failed / web_fetch_failed`——errorKind 字符串本身就由 ToolDomainError 携带。

**关键**：web_search / web_fetch 的所有失败路径必须抛 `ToolDomainError`（实测在 `src/main/modules/tools/tool-errors.ts:30`），裸 `throw new Error(...)` 会被 dispatch 层吞成 `errorKind: 'tool_handler_failure'`（`tool-errors.ts:89`），不会变成期望的 `web_search_failed / web_fetch_failed`。

```ts
import { ToolDomainError } from '../tool-errors'

// web-search.ts 内：
if (tavilyFailed && ddgFailed) {
  throw new ToolDomainError(
    'web_search_failed',
    `Both Tavily and DDG failed: tavily=${tavilyError?.message}, ddg=${ddgError?.message}`,
    { query: args.query, tavilyError: String(tavilyError), ddgError: String(ddgError) },
  )
}
```

**`tool-errors.ts:85-90` 现有错误映射**：`if (error instanceof ToolDomainError) return error.errorKind`——所以 ToolDomainError 抛出会精确映射成 `web_search_failed`，不会被 generic handler 吞掉。

新 namespace `WEB_TOOL_FALLBACK_METRICS`（独立常量，**不**进 TOOL_ERROR_METRICS，遵循 §6.11 - "其他 metric 留在自己模块内"）：

```ts
// src/main/modules/tools/builtins/web-tool-metrics.ts
export const WEB_TOOL_FALLBACK_METRICS = {
  WEB_SEARCH_TAVILY_TO_DDG: 'web_search_tavily_to_ddg_fallback',
  WEB_FETCH_JINA_TO_TAVILY: 'web_fetch_jina_to_tavily_fallback',
} as const
```

#### 3.2.5 端到端 fixture

`src/__tests__/web-search-tool.test.ts` 含：
- 模型可见名（`web_search`）出现在 `general_research` group
- Zod schema 拒绝空 query
- admission 检查（在 §6.11 errorKind 框架下）
- openai + anthropic 两 wire 都能注册并接收
- Tavily 失败 → DDG 成功（mock fetch）
- Tavily + DDG 全失败 → throw → tool-executor `errorKind: 'web_search_failed'`

#### 3.2.6 Gates

- `check-web-search-tool-shape.cjs`：断 `executeWebSearch` 函数签名 + zodSchema 导出 + 注册到 `general_research` group
- `check-web-search-end-to-end.cjs`：端到端 fixture 入口

### 3.3 W1.2 — web_fetch 工具（Jina + Tavily fallback）

形式同 W1.1：

- `src/main/modules/tools/builtins/web-fetch.ts`
- Jina API（`https://r.jina.ai/<url>`）主，Tavily Extract API fallback
- **4096 字符硬截断**（路线图明确）
- `web_fetch_failed` 通过 ToolDomainError 携带 errorKind（不进 TOOL_ERROR_METRICS）
- `WEB_TOOL_FALLBACK_METRICS.WEB_FETCH_JINA_TO_TAVILY` 进 fallback metric
- 端到端 fixture `src/__tests__/web-fetch-tool.test.ts`

Gates：`check-web-fetch-tool-shape.cjs` + `check-web-fetch-end-to-end.cjs`

### 3.4 W1.3 — current_date system reminder

**Codex round 13 R13-b 修正**：`system-reminder-registry.ts:5-25` `ReminderTopic` 是字面量 union（实测含 `missing-input / child-owned / force-tool-locked / force-tool-missing / typed-action-preferred / provider-tool-arguments-corrupt / skill-resume-context-prompt / force-tool-checkpoint-blocked / force-tool-blocked-child-owned` 等 10+ 项，**不**含 `current-date`）；`system-reminder-assembly.ts` 可能要求完整 Record 覆盖。**必须先扩 union**，否则 `topic: 'current-date'` 会 type 红。

**两步改**：

1. `system-reminder-registry.ts:5-25` `ReminderTopic` union 加 `'current-date'`
2. 如 `system-reminder-assembly.ts` 含 `Record<ReminderTopic, ...>` 类型对象，同步加 `'current-date'` key（实施期 grep 确认）

**位置**：`src/main/modules/agent-control/system-reminder-registry.ts` 内或新文件 `src/main/modules/agent-control/system-reminders/current-date-reminder.ts`：

```ts
import type { SystemReminderRegistry } from './system-reminder-registry'

export function registerCurrentDateReminder(registry: SystemReminderRegistry, now: Date = new Date()) {
  const iso = now.toISOString().slice(0, 10) // 2026-05-08
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()]
  registry.register({
    topic: 'current-date',
    priority: 90,
    text: `当前日期：${iso}（${weekday}）。引用网络资料时需考虑信息时效性。`,
  })
}
```

注册位：DirectChat / runtime 进 reminder 装配处（实施期 grep `system-reminder-registry` 现有调用位）。

参考：`_research/deer-flow/backend/packages/harness/deerflow/agents/lead_agent/prompt.py:829` 形态。

Gate `check-current-date-reminder-registered.cjs`：断 `topic: 'current-date'` 在 reminder 装配输出中。

### 3.5 W1.4 — deep-research advisory SKILL 内嵌

#### 3.5.1 4 处协调修改

**(1) `assets/embedded-skills/deep-research/SKILL.md`**：

```md
---
name: deep-research
description: 系统化多源研究方法论：维度拆解、多查询、全文 fetch、引用追踪
when-to-use: 用户要求"研究 X / 调研 Y / 综述 Z / 对比 A 与 B"等需要系统化网络调研的场景
---

# Deep Research

## 工具合同

<tools-contract>
本 skill 使用的工具按 capability profile 分流：
- browser-mode：优先 `browser_research_topic`（页面级深度调研）
- non-browser-mode：优先 `web_search` + `web_fetch`（多查询并行 + 全文 fetch）
两套工具不冲突：browser_research_topic 在 BrowserView UI 内运行；web_search/web_fetch 是 backend Tavily/DDG/Jina API 调用。
</tools-contract>

## 方法论

1. **拆维度**：先把研究目标拆成 5-10 个独立维度（不是 query）
2. **生 queries**：每维度 3-4 个 query 形态（中文 + 英文双语）
3. **执行**：每 query 调 web_search → 选 top-3 结果 → web_fetch 取全文
4. **综合**：按维度合并 → 给出引用追踪的输出
5. **检查**：覆盖度自检（每维度至少 2 个高质量来源）

预算：60 iterations / 60 tool calls（与 media_task 同档）。
```

**(2) `assets/embedded-skills/deep-research/ready-skill.json`**：

```json
{
  "id": "deep-research",
  "name": "deep-research",
  "displayName": "Deep Research",
  "description": "系统化多源研究方法论：维度拆解 + 多查询 + 全文 fetch + 引用追踪",
  "version": "0.1.0",
  "runtime": "reference",
  "execution": { "mode": "advisory" },
  "actions": {
    "read_skill": {
      "runtime": "reference",
      "visibility": "internal"
    }
  }
}
```

**(3) `src/main/modules/skills-runtime/manifest.ts`**：

```ts
export type EmbeddedSkillId =
  | 'lets-go-rss'
  | 'video-copy-analyzer'
  | 'video-expert-analyzer'
  | 'deep-research'        // 新增
  // 5 个方法论 SKILL（W1.5）：
  | 'systematic-literature-review'
  | 'github-deep-research'
  | 'academic-paper-review'
  | 'web-design-guidelines'
  | 'find-skills'

// EmbeddedSkillManifest 实测字段（manifest.ts:6-12）：{ id, name, description, version, requirementsFile }
// **没有 enabled 字段**——manifest 中存在即视为内置（loader 自动 pick up）
export const EMBEDDED_SKILLS: EmbeddedSkillManifest[] = [
  // ... 旧 3 项
  {
    id: 'deep-research',
    name: 'Deep Research',
    description: '系统化多源研究方法论：维度拆解 + 多查询 + 全文 fetch + 引用追踪',
    version: '2026.05.09',
    requirementsFile: 'requirements.txt',  // 即使 advisory skill，保留空 requirements.txt 与现有 3 项形态一致
  },
  {
    id: 'systematic-literature-review',
    name: 'Systematic Literature Review',
    description: '学术综述方法论：Boolean query / PRISMA / 引用图谱',
    version: '2026.05.09',
    requirementsFile: 'requirements.txt',
  },
  {
    id: 'github-deep-research',
    name: 'GitHub Deep Research',
    description: 'GitHub 项目调研方法论：仓库 / issue / 贡献者 / 依赖图',
    version: '2026.05.09',
    requirementsFile: 'requirements.txt',
  },
  {
    id: 'academic-paper-review',
    name: 'Academic Paper Review',
    description: '论文审稿方法论：method / experiment / claim / threat-to-validity',
    version: '2026.05.09',
    requirementsFile: 'requirements.txt',
  },
  {
    id: 'web-design-guidelines',
    name: 'Web Design Guidelines',
    description: '网页设计调研方法论：sitemap / typography / palette / interaction patterns',
    version: '2026.05.09',
    requirementsFile: 'requirements.txt',
  },
  {
    id: 'find-skills',
    name: 'Find Skills',
    description: '技能搜索方法论：description matching + when-to-use 反向 lookup',
    version: '2026.05.09',
    requirementsFile: 'requirements.txt',
  },
]
```

**Codex round 12 修正**：实测 `EmbeddedSkillManifest` 字段是 `{ id, name, description, version, requirementsFile }`（`manifest.ts:6-12`），**没有** `enabled` 字段；即使 advisory skill 没有 Python 依赖也保留空 `requirements.txt` 与现有 3 项形态一致（避免 manifest 异构）。

**(4) `skill-loader.ts` 自动 pick up**：assets 目录下文件自动加载，不需改代码。

#### 3.5.2 Gates

- `check-deep-research-skill-asset-present.cjs`：assets/embedded-skills/deep-research/{SKILL.md, ready-skill.json} 存在
- `check-embedded-skill-manifest-vs-asset-parity.cjs`：`EMBEDDED_SKILLS[]` ↔ `assets/embedded-skills/*/` 子目录 set-equal

### 3.6 W1.5 — 5 个方法论 SKILL 内嵌

5 个 skill 形态同 deep-research，差别仅在 SKILL.md 内容：

- `systematic-literature-review`：学术综述方法论
- `github-deep-research`：GitHub 项目调研方法论
- `academic-paper-review`：论文审稿方法论
- `web-design-guidelines`：网页设计调研方法论
- `find-skills`：技能搜索方法论（参考 deer-flow `tool_search.py` 概念，但仅作方法论 advisory，不引入实际 deferred tool registry —— 那是 Stage T-C）

每 skill 4 件套：SKILL.md / ready-skill.json / manifest 注册 / 自动加载。

Gate：`check-methodology-skills-asset-present.cjs`：断 5 个子目录 + manifest 全部齐全。

## 4. Theme 2 [RC-2] · Tool Boundary Contracts

### 4.1 W2.1 — stable tool-call args hash normalization

**Source**：`_research/deer-flow/backend/packages/harness/deerflow/agents/middlewares/loop_detection_middleware.py:34-138` 的 `_normalize_tool_call_args / _stable_tool_key / _hash_tool_calls` 三段。**仅 hash 归一化，不带 AIMessage 注入**。

**新文件** `src/main/modules/agent-control/tool-call-args-hash.ts`：

```ts
export function normalizeToolCallArgs(args: unknown): unknown {
  // 递归 sort object keys，array 保留顺序，primitives 保留
}

export function stableToolKey(toolName: string, args: unknown): string {
  return `${toolName}:${JSON.stringify(normalizeToolCallArgs(args))}`
}

export function hashToolCalls(calls: Array<{ name: string; args: unknown }>): string {
  // sha256(stable serialization)，截 16 hex
}
```

**接入位**：`turn-engine.ts` `recentToolCalls.argsHash` 生成位（实施期 grep `recentToolCalls` 找）。

Gate `check-tool-call-args-hash-stable.cjs`：fixture 测同语义不同 JSON key 顺序 hash 必须相同。

### 4.2 W2.2 — History sanitizer 审计 + 补齐

**起点**：`src/main/modules/claude-bridge/openai-history-sanitization.ts:78-171` `sanitizeOpenAICompatibleMessageHistory` 已是 drop-only。

**审计目标**：列出**所有**调用历史 sanitizer 的入口，确保：
1. OpenAI 兼容 wire 走 `sanitizeOpenAICompatibleMessageHistory`
2. Anthropic wire 有等价 sanitizer（grep `anthropic-execution-client.ts` 历史装配位）
3. Gemini OAI 走 OpenAI 兼容 wire，不需另写
4. 自定义 provider 走相同链路

**禁止**：deer-flow `dangling_tool_call_middleware` 注入 ToolMessage 形态（与 §6.11 errorKind 互斥语义冲突）。

**输出**：`docs/superpowers/audits/2026-05-09-history-sanitizer-coverage.md` 记录 4 wire 覆盖矩阵（**R11 修正**：路径放 docs/，不放 src/）。

**Gates**：
- (a) `check-tool-input-sanitizer-single-source.cjs`：所有 history-edit 入口必经 sanitizer（AST 扫 `messages.push` / `messages = ...` 在 execution-client 中的位置）
- (b) provider fixture matrix：`src/__tests__/tool-input-sanitizer-coverage.test.ts` 4 fixture（OpenAI / Anthropic / Gemini OAI / 自定义）

### 4.3 W2.3 — 工具名重名硬失败

**Codex round 13 R13-c 修正**：实测 `ToolRegistry`（`tool-registry.ts:759-`）**没有公共 `register*` API**——工具通过 `GROUP_TOOL_PROVIDERS: Record<CapabilityGroupId, ToolRegistryProvider>`（`:667`）的 provider entry 注入；重名在 `:958-963 listToolDefinitions()` 内 `tools.set(tool.name, tool)` 后 **`if (!tools.has(tool.name))` 静默吞掉**——后到的同名 tool 被丢弃，无任何警告。

**实际改造**：在 `listToolDefinitions()` 与 `getToolDefinitionsResolutionForGroupForInternalLookup` 收集阶段加冲突检测：

```ts
// tool-registry.ts:954-967 改造
listToolDefinitions(): ToolDefinition[] {
  const tools = new Map<string, ToolDefinition>()
  const collisions: Array<{ name: string; existing: string; incoming: string }> = []
  for (const groupId of Object.keys(this.groupProviders) as CapabilityGroupId[]) {
    for (const tool of this.getToolDefinitionsResolutionForGroupForInternalLookup(groupId).definitions) {
      const existing = tools.get(tool.name)
      if (existing) {
        // R12-c invariant: cross-group tool-name collision is a hard failure
        collisions.push({ name: tool.name, existing: 'prior-group', incoming: groupId })
      } else {
        tools.set(tool.name, tool)
      }
    }
  }
  if (collisions.length > 0) {
    throw new ToolNameCollisionError(collisions)
  }
  return Array.from(tools.values())
}
```

**新错误类**：`src/main/modules/agent-control/tool-registry-errors.ts` `ToolNameCollisionError extends Error`，构造函数 `constructor(collisions: Array<{ name; existing; incoming }>)`。

**boot-time invariant**：`AgentControlRuntime` constructor 启动时调一次 `defaultToolRegistry.listToolDefinitions()`（实测在 `runtime.ts` 已有类似启动 hook 位置；如无则新增），冲突时抛错走全局 unhandledRejection handler 退出（与 §6.21 Stage N boot assertion 同款形态）。

Gate `check-tool-name-uniqueness.cjs`：fixture 模拟两 group 注册同名 tool，必须 throw `ToolNameCollisionError`，且错误信息含 `name / existing / incoming` 三字段。

## 5. Theme 5 [RC-4] · Observability（Stage R 切片）

### 5.1 W5.1 — run metadata taxonomy

**新文件** `src/main/modules/agent-control/run-span-metadata.ts`：

```ts
export const RUN_SPAN_METADATA_KEYS = [
  'agent_id',
  'model',
  'capability_class',
  'parent_run_id',
  'task_type',
  'session_id',
] as const

export type RunSpanMetadataKey = typeof RUN_SPAN_METADATA_KEYS[number]
```

**注册位**：在 turn-engine 启动每个 turn 时构造 span 字段（实施期 grep `runId` / `parentRunId` 现有装配位）。

**不入** §6.11 `TOOL_ERROR_METRICS`（路线图明确）。

Gate `check-run-span-metadata-keys-frozen.cjs`：新增 key 必须更新该常量。

### 5.2 W5.4 — auto-title middleware

**Source**：`_research/deer-flow/.../agents/middlewares/title_middleware.py`。

**新文件** `src/main/modules/agent-control/auto-title.ts`：

```ts
export async function generateTaskTitle(
  firstUserMessage: string,
  firstAssistantTurn: string | null,
  ctx: { llmCall(prompt): Promise<string> },
): Promise<string> {
  // 1. 调 LLM 生成 ≤24 字标题
  // 2. 失败 → 本地兜底（取前 16 字 + 截断省略号）
}
```

**接入位**：TaskCard projection 首轮后异步调用（不阻塞 turn）。grep `task-projection` 找 `taskTitle` 设置位。

Gate `check-auto-title-fallback.cjs`：mock LLM 失败时返回本地兜底字符串。

## 6. Theme 6 W6.4 — present_file 标准化呈现动作

**Source**：`_research/deer-flow/.../tools/builtins/present_file_tool.py:84-121`。

**新文件** `src/main/modules/tools/builtins/present-file.ts`：

```ts
import { z } from 'zod'
import { ToolDomainError } from '../tool-errors'
import { resolveReadableWithinRoot, PathSandboxError } from '../skill-primitives/path-sandbox'

export const presentFileSchema = z.object({
  path: z.string().min(1),
  reason: z.string().optional(),
})

export async function executePresentFile(
  args: z.infer<typeof presentFileSchema>,
  ctx: {
    abortSignal?: AbortSignal  // R10 修正：与 ToolContext 一致 optional
    sessionId?: string
    outputsRoot: string  // R4-D2: 由 dispatch 层从 SkillsRuntimeManager.getRuntimeInfo().outputsRoot 派生
    requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  },
): Promise<{ status: 'presented'; path: string }> {
  // 1. **R5-D2 修正**：用 path-sandbox 的 canonical + symlink 校验（不能用朴素 startsWith；
  //    会被 sibling-prefix 攻击：outputsRoot=/foo/bar vs path=/foo/bar-evil 会通过）
  let resolvedPath: string
  try {
    resolvedPath = resolveReadableWithinRoot(ctx.outputsRoot, args.path)
  } catch (err) {
    if (err instanceof PathSandboxError) {
      throw new ToolDomainError('path_outside_outputs', err.message)
    }
    throw err
  }
  // 2. 通过 ctx.requestModuleToolAction('renderer:present-file', { path: resolvedPath, reason }) 经现有 IPC 桥推到 renderer
  // 3. 失败抛 ToolDomainError('present_file_failed', ...)
  return { status: 'presented', path: resolvedPath }
}
```

**capability group**：`general_research`（与 web_search/web_fetch 同 group）。**R5-D3 措辞澄清**：同 group **仅指 capability exposure 层一致**（profile-level visibility）；最终模型可见名单 `prepare.allowedToolNames` 由 mode-specific prefix 进一步过滤——browser-mode 故意只放 `browser_research_topic + present_file`（隐藏 web_search/web_fetch）；non-browser-mode 放 `web_search + web_fetch + present_file`。这是有意为之，不是与 §3.1.12 矛盾。

**concurrency**：`'serialized'`（present_file 是 interactive，不能并行；R3-D4 修正）。

**IPC 通道**：复用现有 `requestModuleToolAction`（已存在于 ToolContext）+ 在 renderer 注册新 module 入口 `renderer:present-file`（实施期决定具体 UI 落点：可复用现有 ChatPanel 附件展示，或新 mini-card）。**不**给 ToolContext 加新字段。

**outputsRoot 来源**：R4-D2 — 由 dispatch 层从 `SkillsRuntimeManager.getRuntimeInfo().outputsRoot`（`runtime-manager.ts:181, 595-603`）派生作为字符串传入 ctx；handler 不直接持 manager 引用。

Gate `check-present-file-only-outputs-dir.cjs`：扫 path 解析逻辑必须含 `outputsRoot` 子树检查。

## 7. Theme 10 W10.4 — message_processing 纠错/强化识别

**Source**：`_research/deer-flow/.../agents/memory/message_processing.py:88, 100` `detect_correction / detect_reinforcement`。

**新文件** `src/main/modules/agent-control/message-correction-detector.ts`：

```ts
export function detectCorrection(message: string): { isCorrection: boolean; signal?: string } {
  // 关键词矩阵：不对 / 错了 / 重新 / 别 / 不是 / actually no / wait / let me clarify
}

export function detectReinforcement(message: string): { isReinforcement: boolean; signal?: string } {
  // 关键词矩阵：没错 / 对的 / 就这样 / yes exactly / perfect / keep going
}
```

**注册位**：暂不进入 turn 主流程（路线图明确"长期记忆主体 backlog"）。本 stage 只落 helper + 测试。后续 Stage S 或 T 才决定接入位。

Gate `check-correction-detector-fixtures.cjs`：fixture matrix（10 正例 + 10 负例）。

## 8. CI Gate 完整列表（30 个，round 8 升级）

每 gate `scripts/check-*.cjs` 的实施模式：

- **AST gates**（14 个）：用 `typescript` package 解析 + AST walker，参考 `scripts/check-coordinator-isolation.cjs` 形态
- **形状 gate**（10 个）：用 `fs.existsSync` + JSON 字段检查
- **fixture gate**（6 个）：调 in-process 函数 + 断言

完整清单（**Codex round 2 修正**：W0.1 列 `check-verify-r-defined.cjs`，是 verify:r 内嵌 gate；`check-stage-r-verify-switch.cjs` 是 PR-R8 提交前单独跑的切换 gate，不属 30 个 verify:r 内嵌 gate；下表用 `[switch]` 标记）：

```
W0.1: check-verify-r-defined.cjs              [verify:r 内嵌]
      check-stage-r-verify-switch.cjs         [PR-R8 切换 gate，不内嵌]

W1.1: check-web-search-tool-shape.cjs + check-web-search-end-to-end.cjs
W1.2: check-web-fetch-tool-shape.cjs + check-web-fetch-end-to-end.cjs
W1.3: check-current-date-reminder-registered.cjs
W1.4: check-deep-research-skill-asset-present.cjs + check-embedded-skill-manifest-vs-asset-parity.cjs
W1.5: check-methodology-skills-asset-present.cjs
W1.6 (14): check-intent-domain-includes-research.cjs
         + check-module-allowlist-completeness.cjs        [round 8 R8-D1 新增，扫 8 处 union]
         + check-research-end-to-end-routing.cjs
         + check-research-plan-not-document-task-plan.cjs
         + check-research-in-all-task-route-unions.cjs
         + check-research-in-coordinator-module-normalizer.cjs
         + check-research-adapter-registered-in-host.cjs
         + check-allow-research-tools-gate.cjs
         + check-research-tasktype-downstream-consumers.cjs
         + check-research-tools-distinguish-by-mode.cjs
         + check-research-budget-preset-shape.cjs
         + check-research-budget-not-fallthrough-to-24.cjs
         + check-web-tools-in-general-research-group-only.cjs
         + check-tasktype-allowlist-completeness.cjs

W2.1: check-tool-call-args-hash-stable.cjs
W2.2: check-tool-input-sanitizer-single-source.cjs (+ provider fixture matrix in test:r:focus)
W2.3: check-tool-name-uniqueness.cjs

W5.1: check-run-span-metadata-keys-frozen.cjs
W5.4: check-auto-title-fallback.cjs

W6.4: check-present-file-only-outputs-dir.cjs

W10.4: check-correction-detector-fixtures.cjs
```

合计 30 unique gate **进 verify:r 内嵌**（`check-verify-r-defined.cjs` 计入；`check-stage-r-verify-switch.cjs` **不**计入，是 PR-R8 切换 gate；round 8 R8-D1 新增 `check-module-allowlist-completeness.cjs`）。ResearchPlan vs DocumentTaskPlan 是 typescript 类型互否检查，非 fs check。

**自动化检查命令**（实施期验证 gate 数）：

```bash
awk '/^## 11\./,/^## 12\./' docs/superpowers/plans/archive/2026-05-08-deerflow-borrowing-roadmap.md \
  | grep -oE 'check-[a-zA-Z0-9-]+\.cjs' | sort -u | wc -l
```

应返 79（R 全 + S 全 + T 全；R 段在 round 8 由 29 升至 30，roadmap §11 待 v14 同步）。Stage R 子集应是 30（W0.1 + 28 个 W 项 gate + check-module-allowlist-completeness.cjs round 8 新增）。

## 9. PR 拆分

Stage R 按依赖图拆 8 个 PR（参考 Stage Q 7 PR 模式扩 1 个）：

| PR | 内容 | depends-on |
|---|---|---|
| **PR-R1** | 落点 15（shared/task-types.ts 含 'research'）+ run-contracts.ts TaskType 重导出 + electron.d.ts import type + run-budget-policy.ts `TASK_TYPE_BUDGET_PRESETS.research` + run-budget-policy.ts:77-80 续跑分支扩 + allowlist 扩 W1.6 落点 11/12/13（continuation-state normalizeTaskType / task-projection-sync.ts:577-581 / types.ts ScopeRunSummary+ScopeRunEventPayload）。**Codex round 1 修正**：因 `TASK_TYPE_BUDGET_PRESETS` 是 `Record<TaskType,...>`，preset 必须同 PR 落 | — |
| **PR-R2** | W0.1 verify:r 脚本骨架（不含 Stage 切换三处，本 PR 仅定义 verify:r 脚本 + test:r:gates / test:r:focus 占位） | PR-R1 |
| **PR-R3** | W1.1 + W1.2 + W1.3（web_search / web_fetch / current-date reminder + general_research capability group + ToolDomain 'general_research' + tool-executor switch case + general-research-tools.ts 调度文件 + ToolDomainError 抛错） | PR-R2 |
| **PR-R4** | W1.4 + W1.5（deep-research + 5 方法论 SKILL 内嵌） | PR-R3 |
| **PR-R5** | W1.6 完整 17 件套（除已在 PR-R1 完成的落点 15+11+12+13）+ research-domain-adapter + execution-intent-resolver.ts:244-252 intentGroupModes.general_research 显式装配 + 14 gates（含 round 8 新增 check-module-allowlist-completeness.cjs） | PR-R4 |
| **PR-R6** | W2.1 + W2.2 + W2.3（tool boundary 三件套） | PR-R2 |
| **PR-R7** | W5.1 + W5.4 + W6.4 + W10.4（observability 切片 + present_file + correction detector） | PR-R2 |
| **PR-R8** | Stage 切换：主 verify / verify:cloud / CLAUDE.md §6.25 切换 + Stage R done 收敛 commit | PR-R1..R7 |

PR-R3 / R6 / R7 可并行（互不冲突）。PR-R5 必须等 R4。

## 10. 测试覆盖

新 15 个 tsx 测试文件（在 `test:r:focus` 中列出）：

```
src/__tests__/
├── research-domain-adapter.test.ts
├── research-end-to-end-routing.test.ts
├── web-search-tool.test.ts
├── web-fetch-tool.test.ts
├── current-date-reminder.test.ts
├── embedded-skill-deep-research.test.ts
├── embedded-skill-methodology-set.test.ts
├── tool-call-args-hash.test.ts
├── tool-input-sanitizer-coverage.test.ts
├── tool-name-uniqueness.test.ts
├── run-span-metadata.test.ts
├── auto-title-middleware.test.ts
├── present-file-tool.test.ts
└── correction-detector.test.ts
+ task-types-shared-source.test.ts (落点 15 边界)
```

每 cjs gate 也都有 `scripts/__tests__/check-*.test.cjs`（meta-test，参考 Stage Q 模式）。

## 11. CLAUDE.md §6.25 草稿

加在 §6.24 后：

```md
### 6.25 deer-flow 借鉴 · 合同基础（R / Stage 12）

- Stage 12（R 阶段）落地 deep-research 全栈基础设施 + 三处工具边界硬合同 + observability 起点。
- **TaskType 单源**：`src/shared/task-types.ts` 是 main + renderer 共享 union；`run-contracts.ts` 重导出，`electron.d.ts` import type；新增 'research' 第 6 值。AST gate `check-tasktype-allowlist-completeness.cjs` 强制：所有 `taskType: <literal>` 字段、`Record<TaskType, ...>` keys、`=== '<task-type>'` type guard 全部对齐 6 值或走 `isTaskType()` helper。
- **Research domain adapter**：`research-domain-adapter.ts` 实现 §6.14 `DomainAdapter`，装载位在 `direct-chat.ts:446` `domainAdapters` **首位**（确保 research 意图早期分流）。`intent-classifier.ts` `IntentDomain` 加 `'research'`，关键词矩阵覆盖中英双语（研究/调研/综述/对比 / research/survey/review/compare）。
- **Web tools 分流**：`browser-mode` 优先 `browser_research_topic`（已存在）；`non-browser-mode` 优先 `web_search` + `web_fetch`（新建于 `src/main/modules/tools/builtins/`，分别走 Tavily + DDG fallback / Jina + Tavily fallback）。两套工具不冲突。`general_research` capability group 收纳 web_search / web_fetch / present_file，profiles **只**含 `local_chat` + `scheduled_run`，不含 `remote_channel`（防 Tavily key 远程滥用）。
- **Embedded skill 起点**：`assets/embedded-skills/{deep-research, systematic-literature-review, github-deep-research, academic-paper-review, web-design-guidelines, find-skills}/` 共 6 个新 reference/advisory skill；`manifest.ts` `EmbeddedSkillId` union + `EMBEDDED_SKILLS[]` 同步注册。
- **Tool boundary 硬合同**：(a) `tool-call-args-hash.ts` 提供 stable hash（同语义不同 JSON 顺序 hash 相同）；(b) history sanitizer drop-only（拒绝 deer-flow `dangling_tool_call_middleware` inject 形态，与 §6.11 errorKind 互斥语义冲突）；(c) tool name 重名注册期硬失败 throw `ToolNameCollisionError`（拒绝 deer-flow `tools/tools.py:160-174` skip+warn 形态）。
- **General-research 工具集成 8 条硬合同**（Stage R 加入 web_search/web_fetch/present_file 三新工具时强制）：(1) `tool-parallelism-policy.ts:58-60` `ToolResourceTag.domain` union 必须含 `'general_research'`，`getToolResourceTag` 显式返该 domain；(2) **present_file `concurrency: 'serialized'`**（不能 parallel_read_safe，IPC 写动作需序列化）；(3) `tools/schemas/index.ts:37-49` STATIC_TOOL_INPUT_SCHEMAS 必须 spread `GENERAL_RESEARCH_SCHEMAS`，否则 dispatch-time Zod 校验跳过；(4) **新工具不扩 `ToolContext`**——present_file 走现有 `requestModuleToolAction` IPC 桥 + `outputsRoot` 字符串（dispatch 层从 `SkillsRuntimeManager.getRuntimeInfo().outputsRoot` 派生），**不**加 `runtimeRoot / rendererPushAttachment` 字段，**不**用 `AgentControlRuntime.getArtifactRoot()`（不存在）；(5) **research adapter prefix 集必须在两 mode 都含 present_file**：browser-mode `['browser_research_topic', 'present_file']` / non-browser-mode `['web_search', 'web_fetch', 'present_file']`。capability group "general_research" 仅约束 profile-level exposure 一致（local_chat / scheduled_run），最终模型可见名单由 `prepare.allowedToolNames` 经 prefix 进一步过滤；present_file 必须出现在两 mode 才能跨 browser/non-browser 都可呈现产物；(6) **`executeGeneralResearchTool` 返回 `string | ToolExecutionOutput`**（args 类型 `Record<string, unknown>` + handler 内 Zod parse；JSON 走 `createToolExecutionOutput(JSON.stringify(result), { data: result })`——options 真实字段是 `data`，**不是** `structured`），dispatch 不识别其他形态；(7) **provider 注册容器**实测在 `tool-registry.ts:667 GROUP_TOOL_PROVIDERS: Record<CapabilityGroupId, ToolRegistryProvider>`（不是 Map）；新增 entry 通过 spread 进 ToolRegistry constructor；(8) **present_file 路径守护**走 `resolveReadableWithinRoot(outputsRoot, path)`（`path-sandbox.ts:202-228`）做 canonical + symlink 校验，**禁用**朴素 `startsWith`（会被 sibling-prefix 攻击）。
- **Observability 起点**：`run-span-metadata.ts` 定 `RUN_SPAN_METADATA_KEYS` 6 个 frozen key，**不**入 §6.11 `TOOL_ERROR_METRICS`；`auto-title.ts` 首轮后异步生成 task title，失败本地兜底（不阻塞 turn）。
- **Web tool errorKind 不进 TOOL_ERROR_METRICS**：`web_search_failed / web_fetch_failed / present_file_failed / path_outside_outputs` 全部由 `ToolDomainError.errorKind` 字符串携带；dispatch 通过 `TOOL_ERROR_METRICS.surfaced` 已统一打 metric（带 errorKind 字段）。registry 是 metric 名表不是 errorKind 表。
- **Web tool fallback metric** 进新 `WEB_TOOL_FALLBACK_METRICS` namespace，**不**与 `TOOL_ERROR_METRICS` 合并。
- **prepare.allowedToolNames 收紧到 [] 而非 null**：research domain adapter 的工具集分流必须用 `filtered ?? []`，避免 `turn-engine.ts:2543` 把 null 解为"unrestricted_passthrough"导致分流失效。
- **未启用项**：纠错/强化识别仅落 helper（`message-correction-detector.ts`），尚未接入 turn 主流程，留 Stage S/T 决策。
- **Verify chain**：`npm run verify:r` 必须内嵌 `verify:q`，并覆盖 30 个新 gate + `test:r:gates` + `test:r:focus`。Stage R done 后主 `verify` 与 `verify:cloud` 起步链切到 `verify:r`。
```

## 12. 风险 + watch-list

实施期容易写歪的细节（路线图 §10 + 本计划新增）：

1. **TaskType shared 单源** vs main/renderer/shared 三段约束 —— `electron.d.ts` 必须用 `import type`（不会运行时引入）
2. **research-domain-adapter 装载顺序** —— 必须放 `domainAdapters[]` **首位**（intent-classifier 命中 'research' 时不被 browser/document 早一步抢）
3. **`general_research` profile 不含 `remote_channel`** —— 防 Tavily key 在远程入口被滥用
4. **W2.2 sanitizer 审计输出**进 docs/，不进 src/（避免成为 single-source-of-truth 的运行时依赖）
5. **AST gate 白名单收敛**：`shared/task-types.ts` 自身、`browser-engine/capability-types.ts:77`、`tools/schemas/browser-content-schemas.ts:64`、`task-projection-repository.ts:380-381` 是已知白名单；不允许新增 production 代码白名单
6. **Tavily / Jina API key 来源** —— 走 `ai-providers.ts` `apiKey` 字段同款形态（用户在 settings 配置，main 持久化）。**实施期决定**：是 settings 单独新加 `webSearchTavilyKey / webSearchJinaKey` 字段，还是复用某 provider 的 key？建议新增独立字段，避免与 LLM provider 边界混淆。
7. **DDG fallback 限流策略** —— DDG HTML scrape 易被 ban；实施期加 user-agent 轮换 + 5s 内最多 3 次请求

## 13. 收敛条件

- [ ] §1-§7 所有 17 + 12 = 29 个 W 落点 land（其中 W1.6 有 17 子落点）
- [ ] 15 个 tsx 测试 + 30 个 cjs gate 全部绿
- [ ] `npm run verify:r` 在 worktree 内通过
- [ ] `npm run verify:native` 通过（W10.4 不涉及 SQLite，但 baseline 必须不退化）
- [ ] CLAUDE.md §6.25 land
- [ ] 主 `verify` / `verify:cloud` 切换到 `verify:r`
- [ ] PR-R1..R8 全部 merge
- [ ] git log 含 8 个 stage-r 标记 commit
