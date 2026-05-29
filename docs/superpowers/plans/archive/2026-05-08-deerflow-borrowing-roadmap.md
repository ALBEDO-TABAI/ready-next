---
stage: R / S / T (Stage 12-14 candidate)
date: 2026-05-08
enforce: false
status: pending review (v13 — converged after 13 rounds of Claude × Codex flaw-finding loop on 2026-05-08; awaiting user sign-off)
predecessor_stage: 2026-05-07-Q-skill-resumability-triple-fence-implementation.md
predecessor_audit: none (this is a new architectural-borrowing roadmap; source repo is `_research/deer-flow/`)
external_source: https://github.com/bytedance/deer-flow (local clone at `/Users/user/Documents/实验田/_research/deer-flow/`)
revision_history:
  - v1 (2026-05-08): initial roadmap proposal — 7 borrow / 8 reject / 5 open items; user flagged "missed deep-research"
  - v2 (2026-05-08): added deep-research advisory skill borrow + research-stack runtime deps; T-A/B/C/D scenario analysis
  - v3 (2026-05-08): incorporated Codex round 2 — 8 flaws fixed (drop-only sanitizer / no default file-lock / Stage R≠ deep-research-usable / per-theme root-cause / per-W CI gate name / real Ready paths / round1b dependency edges / absorbed mapping table / contract terminology)
  - v4 (2026-05-08): incorporated Codex round 3 — 6 flaws (real embedded-skill / migrations file paths; verify:r/s/t script definitions; web tool end-to-end fixture; deep-research planner contract; rollback semantics decision; terminology pass)
  - v5 (2026-05-08): incorporated Codex round 4 — 8 flaws (ready-skill.json + read_skill manifest / TOOL_ERROR_METRICS unification / research-domain-adapter critical / provider list completeness + execution-client patcher entry / built-in capability fixture before gate / L2 stub-only per §6.15 deferred decision / fresh/upgrade/idempotent migration gate / rollback_target writer)
  - v6 (2026-05-08): incorporated Codex round 5 — 4 flaws (manifest.ts EmbeddedSkillId registration / volcengine + openai-compatible provider parity / execution-client real path verification / research-domain-adapter task-route+module union)
  - v7 (2026-05-08): incorporated Codex round 6 — 3 flaws (W1.6 expanded to 7-piece contract incl. IntentDomain + task-type-resolver / patcher helper for ≥6 OpenAI paths / patch-profile separation from provider parity)
  - v8 (2026-05-08): incorporated Codex round 7 — 5 flaws (research execution-loop closure / research not in capability gate normalizer / streaming patch boundary cleared / patcher priority inversion fix / model-level capability resolver)
  - v9 (2026-05-08): incorporated Codex round 8 — 3 flaws (W4.5 capability targets supportsVision/Thinking/LongContext fields / research downstream allowlists in run-budget-policy + continuation-state + task-projection-sync / web tools vs existing browser_research_topic distinction)
  - v10 (2026-05-08): incorporated Codex round 9 — 4 flaws (W4.0 lands in inline ai-providers.ts not nonexistent submodule / ScopeRunSummary+ScopeRunEventPayload taskType union expansion / research budget continuation/planner fallback / general_research capability group)
  - v11 (2026-05-08): incorporated Codex round 10 — 3 flaws (capabilityClass dead-field gap → must consume in resolveAIConfigCapabilities / TaskType allowlist full-repo scan via continuation-state+task-projection-sync+electron.d.ts / commit-order gate is over-contract → final-state AST gate)
  - v12 (2026-05-08): incorporated Codex round 11 — 4 flaws (grep full-repo too noisy → AST gate with whitelist / renderer cannot import main TaskType → shared/task-types.ts / final-state file-existence gate insufficient → AST consumer-chain check / inferVisionFromAgentProtocol misnamed → real inferredProtocol IIFE)
  - v13 (2026-05-08): incorporated Codex round 12 — 2 major + 2 minor (W3.1 explicit submodule layout / W3.0.5+W3.0.6 split for AIProviderDef + AIModelDef + AIResolvedCapabilities field extensions / TaskType single-source path fixed / AST gate template uses check-coordinator-isolation.cjs); Codex round 13 declared "v13 converged — no Contract Gap"
---

# deer-flow → Ready 借鉴路线图（v13 converged）

> 本文档是**路线图**（roadmap），定义 Stage R / S / T 三阶段的工作项、依赖图、CI 门口子、Stage 切换合同。**不**展开行号级实施细节——那是后续 `*-implementation.md` 的工作。

> **v13 收敛标记**：13 轮 Claude × Codex 找瑕疵循环，第 13 轮 Codex 明确判定 "v13 converged — no Contract Gap，剩余 5 条均为 Implementation Note"。每一轮都基于真实仓内 grep / AST 核实。

## 0. 来源与背景

deer-flow（`https://github.com/bytedance/deer-flow`，本地 `_research/deer-flow/`）是字节的 LangGraph + Python 多代理研究 workflow。Ready 是 Electron + TypeScript 创作工作台。两个范式不同——deer-flow 静态图 + Python 子进程；Ready 动态单循环 + DomainAdapter + Electron main。

采用必须按**机制**而非**形态**——把 deer-flow 中"概念正确但实现绑死 LangGraph"的东西，重新落进 Ready 已有的合同（§6.10 仲裁、§6.15 reminder/compaction/hook、§6.20 TurnFrame 单源、§6.22 projection、§6.23 authorization、§6.24 resumability）。

> 文档术语合同：本路线图使用 **采用 / 拒绝 / 映射 / 不立项** 四个动词，避免 `借/借鉴/可借/只借` 等模糊措辞（v3 round 2 起约定）。

## 1. 目标

让以下能力从 deer-flow 采用进 Ready，且不破坏 §0.5 六条战略原则：

1. **deep-research 完整可用**（M1 里程碑，跨 Stage R+S）：用户问"研究 X / 调研 Y / 综述 Z"时，agent 走系统化多源研究方法论 + 多查询 + 全文 fetch + 引用追踪。
2. **Provider thinking/reasoning 兼容**：DeepSeek reasoning_content / MiniMax reasoning_split / Gemini OAI thought_signature / vLLM stream_usage 等坑统一通过 patch profile 解决。
3. **Tool boundary 硬合同**：args hash / 工具名重名 / orphan tool_call 三处不再脏数据进模型。
4. **Observability 闭环**：run metadata + token attribution + auto-title 让长任务可观察。
5. **Sandbox 边界扩展**：bash 危险模式正则 + symlink 限制 + host path 脱敏 扩展 §6.12。
6. **持久化基础**：run_meta + thread_meta + feedback 表为质量闭环铺底。
7. **可扩展性方向**：parallel subagent + MCP 接入 留作 Stage T 决策项（依赖前两阶段稳定）。

## 2. 五大根因簇（按 §0.5 修根因不修症状）

| 根因 | 描述 | 关联 Theme |
|---|---|---|
| RC-1 | ResearchStack 缺失：Ready 无结构化 web search/fetch 工具 + current_date 注入 + advisory 方法论 SKILL；deep-research SKILL.md 调用 `web_search`/`web_fetch` 调不通 | Theme 1 |
| RC-2 | Tool boundary contracts 缺失：args hash 归一化 / 工具名重名 / orphan tool_call sanitizer 三处都缺硬合同 | Theme 2, 6, 7, 8, 11 |
| RC-3 | Provider compatibility 散落：thinking/reasoning 模型补丁堆在 `ai-providers.ts` 单文件，新坑要改全文件 | Theme 3, 4 |
| RC-4 | Observability 单点缺失：run metadata / token attribution / auto-title 三个 surface 各自缺 | Theme 5 |
| RC-5 | Long-task contract 缺事件账本与持久化：child runner JSONL 缺事件流账本字段；无 run/feedback/thread_meta 持久化 | Theme 9, 10 |

## 3. 工作项（11 Theme）

每个工作项字段：`source / ready landing / size / gate / verify chain / depends-on / 决策（采用/拒绝/映射/不立项）`

### W0 前置：verify 脚本定义

Ready 当前主 `verify` 串走 `verify:q`（`package.json:91`，由 `verify:p` 在 `:88` 派生）。Stage R/S/T 需要新增三段。

- **W0.1** 定义 `verify:r`
  - landing `package.json` 加 `"verify:r": "npm run verify:q && <stage-r gates> && npm run test:r:gates && npm run test:r:focus"`
  - Stage R 全部 done 后**三处同时切换**（参考 §6.23 Stage P 模式）：(a) 主 `verify` 改为 `npm run verify:native && npm run verify:r && npm run test`，(b) `verify:cloud` 改为 `npm run rebuild:native && npm run verify:r && npm run test`，(c) CLAUDE.md §6.25 起新合同条目
  - gate `check-stage-r-verify-switch.cjs`（断三处切换均完成）
  - depends-on 无（前置）
- **W0.2** 定义 `verify:s = "npm run verify:r && npm run verify:native && <stage-s gates> && npm run test:s:gates && npm run test:s:focus"`
  - **必须显式包含 `verify:native`**（W10.x 是 SQLite-backed）
  - Stage S done 后同样三处切换（主 verify / verify:cloud / CLAUDE.md §6.26）
  - gate `check-stage-s-verify-switch.cjs`
  - depends-on W0.1
- **W0.3** 定义 `verify:t = "npm run verify:s && <stage-t gates> && npm run test:t:gates && npm run test:t:focus"`
  - Stage T done 后三处切换（主 verify / verify:cloud / CLAUDE.md §6.27）
  - gate `check-stage-t-verify-switch.cjs`
  - depends-on W0.2

### Theme 1 [RC-1] · Research Stack

**根因**：deep-research 是用户最在意的能力之一。Ready 当前没有结构化 search/fetch 工具，BrowserView 是 UI 层（不能给 agent 返回 `[{title, url, snippet}]` 形态），且无跨子模式的 research 意图分发。

**不照搬理由**：deer-flow 9 个 search provider 是产品差异化，Ready 仅采用最简两路（Tavily 主 + DDG fallback；Jina 主 + Tavily fallback）；Ready 已有 `browser_research_topic` 工具用于浏览器子模式深度调研，与新建 web_search/web_fetch 在工具集上分流而非冲突。

| W | 内容 | size | depends-on |
|---|---|---|---|
| **W1.1** | web_search 工具（Tavily + DDG fallback）—— 新建 `src/main/modules/tools/builtins/web-search.ts`；注册到 `tool-registry.ts` 新 capability group `general_research`（不进 `BROWSER_CONTENT_TASK_TOOL_NAMES`）；failure 进 §6.11 `TOOL_ERROR_METRICS`（新 errorKind `web_search_failed`）；Tavily→DDG fallback 进新 `WEB_TOOL_FALLBACK_METRICS` namespace；端到端 fixture 含模型可见名 / Zod schema / admission / openai+anthropic 双 wire / provider fallback / 错误结构化 | S | W0.1 |
| **W1.2** | web_fetch 工具（Jina + Tavily fallback）—— 新建 `src/main/modules/tools/builtins/web-fetch.ts`；同 W1.1 形式；4096 字符硬截断；`web_fetch_failed` 进 `TOOL_ERROR_METRICS` | S | W0.1 |
| **W1.3** | current_date system reminder 注入 —— `system-reminder-registry.ts` 注册 `topic: 'current-date', priority: 90`，提醒文本必须含 ISO 8601 + 周几（参考 deer-flow `lead_agent/prompt.py:829` 形态） | S | W0.1 |
| **W1.4** | deep-research advisory SKILL 内嵌 —— 4 处协调修改：(1) `assets/embedded-skills/deep-research/SKILL.md`；(2) `assets/embedded-skills/deep-research/ready-skill.json`（`runtime: 'reference', execution: { mode: 'advisory' }, actions: { read_skill: { runtime: 'reference', visibility: 'internal' } }`）；(3) `src/main/modules/skills-runtime/manifest.ts` `EmbeddedSkillId` union 加 `'deep-research'`，`EMBEDDED_SKILLS[]` 加条目；(4) `skill-loader.ts` 自动 pick up | S | W1.1 + W1.2 + W1.3 |
| **W1.5** | 5 个方法论 SKILL 内嵌 —— `systematic-literature-review` / `github-deep-research` / `academic-paper-review` / `web-design-guidelines` / `find-skills`；同 W1.4 三件套 × 5；manifest.ts 同步登记 | S | W1.4 |
| **W1.6** | **Research domain adapter（17 件套）** —— 见 §3.1.1 详细落点 | L | W1.4 |

#### 3.1.1 W1.6 详细落点（17 件套合同）

deep-research 真要进 Ready 主执行链路，必须 17 处协调修改：

1. 新文件 `src/main/modules/agent-control/research-domain-adapter.ts`（按 §6.14 `DomainAdapter` 接口实现，与 6 个现存 adapter `browser/document/rss/calendar/feishu/skill` 同目录、同形态）
2. `intent-classifier.ts:4` `IntentDomain` union 加 `'research'` + classifier 关键词矩阵（中英双语：研究/调研/综述/对比/报告/what is X/explain X/research X/compare X and Y/investigate X 等）
3. `task-type-resolver.ts` 在 generic fallback 之前加 research 分支：返回 `{ taskType: 'research', executionChain: 'domain_executor', preferredExecutor: 'research', requiresPlanner: false }`
4. `run-contracts.ts:104-109` `TaskType` union 加 `'research'`（**注意**：v13 起 TaskType 从 shared/task-types.ts 重导出）
5. `run-contracts.ts:289` `TaskExecutionRoute.executor` union 加 `'research'`
6. `run-contracts.ts:282` `TaskTypeResolution.preferredExecutor` union 加 `'research'`
7. `prompt-assembly.ts:100-108` `normalizeCoordinatorModule` 加 `|| id === 'research'`
8. `execution-intent-resolver.ts:200-244` 加 `hasResearchIntent = positiveDomains.has('research') && !excludedDomains.has('research')` + `allowResearchTools = baseVisibilityPlan.hasTools && hasResearchIntent`；web_search/web_fetch 默认进 `allowResearchTools` gate；`prompt-assembly.ts:38` trigger module union 同步加 'research'
9. host 装载位（grep `host.domainAdapters` 装载点）插入 research adapter 实例
10. `run-budget-policy.ts:16-42` `TASK_TYPE_BUDGET_PRESETS` 加 `research: { maxIterations: 60, maxToolCalls: 60 }`（典型 5-10 维度 × 4 query × 2 fetch ≈ 60）
11. `continuation-state.ts:121-131` allowlist 加 'research'（用 `isTaskType()` type guard 取代字面量）
12. `task-projection-sync.ts:576-584` projection allowlist 加 'research'
13. `types.ts:367, :461` `ScopeRunSummary.taskType` 与 `ScopeRunEventPayload.taskType` 改 import `TaskType`（不再独立 5 值 union）
14. `run-budget-policy.ts:77-80` 续跑分支：`if (inheritedFromTaskType === 'multi_step_task' || === 'media_task' || === 'research') return createRunBudgetSeed(inheritedFromTaskType)`；`turn-engine.ts:2506-2508` 续跑预算 override + `task-execution-router.ts:177` planner 60 处按 preset 派生（不硬编码）
15. **TaskType 单源 + shared 边界**（关键完整性合同）：
    - 新文件 `src/shared/task-types.ts`：
      ```ts
      export const TASK_TYPES = ['direct_answer', 'short_task', 'multi_step_task', 'media_task', 'continuation', 'research'] as const
      export type TaskType = typeof TASK_TYPES[number]
      export function isTaskType(value: unknown): value is TaskType { ... }
      ```
    - main `run-contracts.ts:104-109` 改 `import { TaskType } from '../../../shared/task-types'; export type { TaskType }`
    - renderer `electron.d.ts:403-409` 改 `import { TaskType } from '../../shared/task-types'`
    - 不破 main/renderer/shared 三段约束（CLAUDE.md `§3 代码分层`，行 33-37）
16. **AST gate**（取代字符串 grep）：`check-tasktype-allowlist-completeness.cjs` 用 typescript API（参考 `check-coordinator-isolation.cjs:6, 43-67` 形态）：
    - 扫所有 `taskType: <string-literal>` 字段赋值，必须命中 6 个 TASK_TYPES 之一
    - 扫所有 `Record<TaskType, ...>` keys 必须包含全部 6 个
    - 扫所有 `value === '<task-type>'` type guard 形式，必须配 `isTaskType()` 或同等 union exhaustiveness
    - **白名单**：`browser-engine/capability-types.ts:77` `BrowserCapabilityTaskKind`、`tools/schemas/browser-content-schemas.ts:64`、`task-projection-repository.ts:380-381` SQL constants、`__tests__/fixtures/**`、`shared/task-types.ts`（union 定义本身）
17. **research 工具策略**（`browser_research_topic` vs `web_search/web_fetch` 分流）：
    - research adapter 内根据 `capabilityProfile`（browser-mode vs others）切换工具集
    - **browser-mode**：优先 `browser_research_topic`（已存在于 `BROWSER_CONTENT_TASK_TOOL_NAMES`，页面级深度调研）
    - **non-browser-mode**：优先 `web_search` + `web_fetch`（多查询并行 + 全文 fetch）
    - 两套工具共存不冲突：`browser_research_topic` 在 BrowserView UI 内；`web_search/web_fetch` 是 backend 调用 Tavily/DDG/Jina API
    - deep-research SKILL.md 顶部 `<tools-contract>` 段描述这个分流

**ResearchPlan 合同**：定义在 `research-domain-adapter.ts` 内 export，fields `{ objective, dimensions[], queries[], sources[], synthesis_steps[] }`。**不复用** DocumentTaskPlan（避免误进 document mode）。

**投影**：复用 §6.22 `task-projection-*` TaskCard projection（不新建第二套），`ResearchPlan` 映射成 TaskCard.steps（每个 dimension/query 是一 step）。

**触发**：在 `intent-classifier` 阶段命中（不是后续 §6.10 `run-capability-controller` 仲裁阶段，也不是 §6.5 Browser Agent V7 任务理解阶段——这是 v8 round 7 critical 修复点：研究意图必须在最早期分流，否则会被 generic 兜底走 direct_answer）。

**gate 套件（13 个）**：
- `check-intent-domain-includes-research.cjs`
- `check-research-end-to-end-routing.cjs`：**端到端 fixture**——10 个研究类 prompt + 10 个非研究类 prompt 跑完整 pipeline，断 `route.executor === 'research'` / `!== 'research'` 分别正确，且 `allowResearchTools === true / false` 同步正确
- `check-research-plan-not-document-task-plan.cjs`：断 ResearchPlan 与 DocumentTaskPlan 类型不可互转
- `check-research-in-all-task-route-unions.cjs`：断 `TaskType` + `TaskExecutionRoute.executor` + `TaskTypeResolution.preferredExecutor` 三处都含 'research'
- `check-research-in-coordinator-module-normalizer.cjs`：断 `normalizeCoordinatorModule` 接受 'research'
- `check-research-adapter-registered-in-host.cjs`：断 `host.domainAdapters` 含 research 实例
- `check-allow-research-tools-gate.cjs`：断 `execution-intent-resolver` 含 `hasResearchIntent / allowResearchTools`
- `check-research-tasktype-downstream-consumers.cjs`：断 budget preset / continuation allowlist / projection allowlist 三处都含 research
- `check-research-tools-distinguish-by-mode.cjs`：fixture 测 browser-mode 给 browser_research_topic，non-browser-mode 给 web_search+web_fetch
- `check-research-budget-preset-shape.cjs`：断 `research` preset `maxIterations === 60 && maxToolCalls === 60`
- `check-research-budget-not-fallthrough-to-24.cjs`：fixture：research 续跑后 `maxIterations === 60`，不掉到 24（continuation 值）
- `check-web-tools-in-general-research-group-only.cjs`：断 web_search/web_fetch 在 `'general_research'` group，不在 `'browser_content_tasks'`
- `check-tasktype-allowlist-completeness.cjs`：见落点 16

**verify chain**：`verify:r`

### Theme 2 [RC-2] · Tool Boundary Contracts

**根因**：args 顺序差异 / 重名工具 / orphan tool_call 三种"脏边"都进了模型。

**不照搬理由**：deer-flow `loop_detection_middleware` 把警告写回 AIMessage 与 §6.15 `SystemReminderRegistry` 冲突；`tools/tools.py:160-174` 是 skip+warn，Ready 选硬失败；`dangling_tool_call_middleware` 用 inject ToolMessage 形态会伪造业务错误，与 §6.11 `errorKind` 互斥语义冲突。

| W | 内容 | size | depends-on |
|---|---|---|---|
| **W2.1** | stable tool-call args hash normalization —— 移植 `loop_detection_middleware.py:34-138` 的 `_normalize_tool_call_args / _stable_tool_key / _hash_tool_calls` 三段（**仅 hash 归一化，不带 AIMessage 注入**）；落 `turn-engine.ts` `recentToolCalls.argsHash` 生成位 | S | W0.1 |
| **W2.2** | History sanitizer policy: **delete invalid tool edges, never synthesize business ToolMessage** —— Ready 现有 `claude-bridge/openai-history-sanitization.ts:90-171` drop 策略保留；本 W 是审计 + 补齐 Anthropic / Gemini / 自定义 provider 路径覆盖度；显式拒绝 deer-flow `dangling_tool_call_middleware` inject 形态（与 §6.11 errorKind 互斥语义冲突） | S | W0.1 |
| **W2.3** | 工具名重名硬失败（注册期）—— `tool-registry.ts` 注册时检测 + 抛 `ToolNameCollisionError`（拒绝 deer-flow `tools/tools.py:160-174` skip+warn 形态） | S | W0.1 |

**gate**：
- W2.1 `check-tool-call-args-hash-stable.cjs`（同语义不同 JSON 排序 hash 必须相同）
- W2.2 (a) `check-tool-input-sanitizer-single-source.cjs`（绕过 sanitizer 的路径必须 0），(b) provider fixture matrix（OpenAI / Anthropic / Gemini OAI / 自定义 4 fixture）
- W2.3 `check-tool-name-uniqueness.cjs`

**verify chain**：`verify:r`

### Theme 3 [RC-3] · Provider Compatibility Patch Architecture

**根因**：DeepSeek reasoning_content / MiniMax reasoning_split / Gemini OAI thought_signature / vLLM stream_usage 等 thinking-class 模型坑，Ready `ai-providers.ts` 单文件硬塞所有判断。

**不照搬理由**：deer-flow 用 LangChain `ChatXxx` 子类化 + monkey-patch，Ready 是 TS + claude-bridge + openai-bridge 不能子类化；要的是**架构形态**——每 provider 独立可补丁子模块，4 个 patch profile 与 7 个正式 provider 分离。

| W | 内容 | size | depends-on |
|---|---|---|---|
| **W3.0** | Provider parity gate —— `scripts/check-provider-parity.cjs` 扫 `ai-providers.ts` `AI_PROVIDERS[]` 中所有 `id:` 字段（7 个：moonshot / anthropic / fox / openai / gemini / volcengine / openai-compatible），与 W3.1 拆分后的 `src/shared/ai-providers/<id>.ts` 文件名集合做 set-equal 比较 | S | W0.2 |
| **W3.0.5** | 扩 `AIProviderDef.capabilityClass?` 字段 —— `ai-providers.ts:37-52` interface 加可选 `capabilityClass?: { supportsVision?: boolean; supportsThinking?: boolean; supportsLongContext?: boolean }` | XS | W3.0 |
| **W3.0.6** | 同步扩 3 处类型：(a) `AIModelDef`（`:29-35`）加 `capabilityOverrides?: { supportsVision?: boolean; supportsThinking?: boolean; supportsLongContext?: boolean }`；(b) `AIResolvedCapabilities`（`:441-455`）加 `supportsThinking: boolean; supportsLongContext: boolean`；(c) `AIModelConfig`（`:54-72`）保持不变（thinking 走现有 `capabilityModes?: CapabilityModeMap` 同款形态，不新增字段） | XS | W3.0.5 |
| **W3.1** | §6.6 provider 子模块化 —— 见 §3.3.1 详细 | M | W3.0 + W3.0.5 + W3.0.6 |
| **W3.2** | Gemini OAI gateway thought_signature 保留 —— landing `src/shared/ai-providers/patch-profiles/gemini-oai.ts` `requestPatcher`（matchPredicate：`generativelanguage.googleapis.com / vertex / aiplatform` baseUrl + `gemini-*` model）；tool-call 上 `thought_signature` 必须逐字回显下一次请求，否则 HTTP 400 | S | W3.1 |
| **W3.3** | DeepSeek reasoning_content 多轮回传 —— landing `patch-profiles/deepseek.ts` `requestPatcher`（matchPredicate：`*.deepseek.com / *.deepseek.ai` 或 `deepseek-*` model）；DeepSeek thinking 模式下 multi-turn 必须**全部**保留 reasoning_content | S | W3.1 |
| **W3.4** | MiniMax reasoning_split 映射 —— landing `patch-profiles/minimax.ts` `responsePatcher`（matchPredicate：`api.minimax.chat / *.minimaxi.com` 或 `MiniMax-*` model）；把 `extra_body.reasoning_split=true` 返回的 `reasoning_details` 映射到 `additional_kwargs.reasoning_content` | S | W3.1 |
| **W3.5** | OpenAI-compatible 默认开 stream_usage —— landing `src/shared/ai-providers/openai-compatible.ts` 自身的 `defaultRequestPatcher`（防 token 统计空洞） | S | W3.1 |

#### 3.3.1 W3.1 拆分逻辑细化

7 个正式 provider 子模块（参与 parity）：
- `src/shared/ai-providers/index.ts`（barrel + AIProviderDef interface 重导出）
- `src/shared/ai-providers/{moonshot,fox,openai,anthropic,gemini,volcengine,openai-compatible}.ts` × 7
- 每个 export `{ def: AIProviderDef, capabilityClass: { ... }, defaultRequestPatcher?, defaultResponsePatcher? }`
- 原 `ai-providers.ts:105-255` `AI_PROVIDERS[]` 改为汇总：
  ```ts
  import * as moonshot from './ai-providers/moonshot'
  // ...
  export const AI_PROVIDERS: AIProviderDef[] = [
    { ...moonshot.def, capabilityClass: moonshot.capabilityClass },
    // ... 7 个
  ]
  ```

4 个 patch profile 子模块（**不参与 parity**，参与 coverage gate）：
- `src/shared/ai-providers/patch-profiles/{gemini-oai,deepseek,minimax,vllm}.ts` × 4
- 每个 export `{ profileId, matchPredicate(config, baseUrl, model): boolean, requestPatcher?, responsePatcher? }`

新 API `src/shared/ai-providers/resolve-provider-patch-profile.ts`：
```ts
export function resolveProviderPatchProfile(
  config: AIProviderConfig,
  baseUrl: string | null,
  model: string
): PatchProfile | null
```
按 baseUrl 特征 + model 名匹配最具体 profile，无匹配则返 null（落到 7 个正式 provider 自身的 patcher）。

**Patcher 调用 helper**：新建 `src/shared/ai-providers/apply-provider-patch.ts`：
```ts
export function applyProviderRequestPatch(body: any, ctx: PatchContext): any {
  // 优先级：
  // 1. 用户显式配置（最高，不被任何 patcher 改）
  // 2. provider defaultPatcher（次高，profile 不得回滚这些字段）
  // 3. profile patcher（最低，但更具体；只能 add-or-overwrite profile-owned 字段）
  ...
}
export function applyProviderResponsePatch(resp: any, ctx): any { ... }
```

**接入点**：
- `src/main/modules/claude-bridge/openai-execution-client.ts` **6 处**请求体序列化点（4 处 `JSON.stringify(reqBody)`：line 121, 151, 203, 605；2 处 inline 对象 `JSON.stringify({ model, messages })` / `JSON.stringify({ model, messages, tools })`：line 230, 651）前都调 `applyProviderRequestPatch(body, ctx)`（实施期把 inline 对象提取为 `reqBody` 变量后再调 patcher）；6 处 response parse 后调 `applyProviderResponsePatch(resp, ctx)`
- `src/main/modules/claude-bridge/anthropic-execution-client.ts` 类似（≥2 处）

**Streaming 边界**：helper **只 patch 完整 raw/json，不接 chunk**；SSE event-stream 不在 helper 责任范围（provider 自身在 stream end 后聚合再走 helper）。

**gate 套件（5 个）**：
- (a) `check-provider-parity.cjs`：7 子模块 ↔ 7 AI_PROVIDERS id set-equal
- (b) `check-patch-profile-coverage.cjs`：4 个 patch profile 各有 fixture 命中（fixture 在 `src/__tests__/fixtures/patch-profiles.json`）
- (c) `check-provider-patcher-applied-at-execution-client.cjs`：**按路径数计数 + AST**——OpenAI 6/6 + Anthropic ≥2/2 全覆盖才 pass，防假阳性
- (d) `check-patch-priority-stream-usage-preserved.cjs`：fixture——baseUrl=`api.deepseek.com` + provider=openai-compatible（默认 stream_usage=true）+ DeepSeek profile 跑完后 `body.stream_usage === true`（profile 不吞 provider default）
- (e) `check-ai-provider-submodule-shape.cjs`：每文件 export 必须 `{ id, capabilityClass }`（provider）或 `{ profileId, matchPredicate }`（profile）

**verify chain**：`verify:s`

### Theme 4 [RC-3] · Capability Gates & Vision Wiring

**根因**：thinking / vision / longContext 是模型能力维度，Ready 没有声明性 capability class，导致 vision 工具对 non-vision 模型暴露、reasoning_effort 路径走错模型。

**不照搬理由**：deer-flow `model_config.supports_vision` 是单字段，Ready 选多维 `capabilityClass`；**未填能力 = 保守拒绝**（不是默认放行）。

| W | 内容 | size | depends-on |
|---|---|---|---|
| **W4.0** | 内置 7 provider 默认 capabilityClass + 接入 `resolveAIConfigCapabilities` 三层 merge —— 见 §3.4.1 详细 | S | W3.0.5 + W3.0.6 + W3.1 |
| **W4.1** | capabilityClass 仲裁层 enforcement —— `run-capability-controller.ts` resolver；vision tool 仅 capability=vision 暴露；thinking 模型走 reasoning_effort 路径 | M | W4.0 |
| **W4.2** | vision tool 仅 capability=vision 装载 —— `tool-gateway.ts` 装载期检查 | S | W4.1 |
| **W4.3** | view_image 完成后下轮注入图块 —— 移植 `agents/middlewares/view_image_middleware.py` 形态；落 `turn-engine.ts` 工具批后处理 | S | W4.1 + W4.2 |
| **W4.4** | thinking 模型走 reasoning_effort —— 各 provider 子模块 `requestPatcher` | S | W3.1 + W4.1 |
| **W4.5** | model-level capability 覆盖 —— 新建 `src/shared/ai-providers/model-capability-resolver.ts` `resolveModelCapabilities(provider, model)` = provider default + model overrides merge；`openai.ts` `o3-mini` 加 `capabilityOverrides: { supportsThinking: true, supportsVision: false }`（**双覆盖**：thinking=true，vision=false，因为 o3-mini 是 text-only thinking 模型）；删除 `agent-context-source.ts:85-92` 与 `video-expert-child-driver.ts:118-125` 两处 o3-mini 零散特判 | S | W3.1 + W4.0 |

#### 3.4.1 W4.0 三层 merge 接入

`resolveAIConfigCapabilities`（`ai-providers.ts:471`）函数体增补：

```ts
// 在 :511 supportsVision 计算之前插入
const providerCap = provider?.capabilityClass ?? {}
const modelDef = provider?.models.find(m => m.id === normalizedConfig.model)
const modelCap = modelDef?.capabilityOverrides ?? {}
const visionDefault = modelCap.supportsVision ?? providerCap.supportsVision ?? (agentProtocol === 'anthropic' || agentProtocol === 'openai')
const thinkingDefault = modelCap.supportsThinking ?? providerCap.supportsThinking ?? false
const longContextDefault = modelCap.supportsLongContext ?? providerCap.supportsLongContext ?? ((modelDef?.contextWindow ?? 0) >= 128000)
```

返回值改：
```ts
supportsVision: applyCapabilityMode(normalizeCapabilityMode(normalizedConfig.visionMode), visionDefault),
supportsThinking: applyCapabilityMode(normalizeCapabilityMode(normalizedConfig.capabilityModes?.thinking), thinkingDefault),
supportsLongContext: applyCapabilityMode('auto' as AICapabilityMode, longContextDefault),
```

7 个 provider 子模块默认 capabilityClass：
- `anthropic.ts`: `{ supportsVision: true, supportsThinking: true, supportsLongContext: true }`
- `openai.ts`: `{ supportsVision: true, supportsThinking: false, supportsLongContext: true }`（gpt-4o 默认；o3-mini 在 W4.5 model overrides 覆盖）
- `gemini.ts`: `{ supportsVision: true, supportsThinking: true, supportsLongContext: true }`
- `moonshot.ts`: `{ supportsVision: false, supportsThinking: false, supportsLongContext: true }`（v1-128k 主打长上下文）
- `fox.ts`: `{ supportsVision: false, supportsThinking: false, supportsLongContext: false }`（保守，gpt-5.4 等需用户在 settings 改）
- `volcengine.ts`: `{ supportsVision: false, supportsThinking: false, supportsLongContext: false }`（保守）
- `openai-compatible.ts`: `{ supportsVision: false, supportsThinking: false, supportsLongContext: false }`（保守，未填 = 拒绝原则）

**gate**（W4.0/W4.5 共用）：
- `check-builtin-provider-capability-fixture.cjs`：每 7 个 provider 子模块都已 export capabilityClass
- `check-resolveAIConfigCapabilities-consumes-capabilityClass.cjs`：AST 检查 `resolveAIConfigCapabilities` 函数体内引用 `provider?.capabilityClass` 与 `modelDef?.capabilityOverrides`，且 supportsThinking/supportsLongContext 返回值由这两层参与计算（不是纯 inline 推断）
- `check-w4-after-w3.cjs`：AST gate（仿 `check-coordinator-isolation.cjs:6, 43-67` 形态），检查 `AIProviderDef.capabilityClass?` 字段定义 + `AIModelDef.capabilityOverrides?` 字段定义 + `resolveAIConfigCapabilities` 函数体三层 reference
- `check-capability-gate-conservative-default.cjs`：未填 = 拒绝
- `check-capability-gate-enforced-in-arbitration.cjs`：在 §6.10 `run-capability-controller` 真实 enforce
- `check-vision-tool-capability-gated.cjs`
- `check-view-image-followup-injection.cjs`
- `check-reasoning-effort-routing.cjs`
- `check-model-capability-resolver-merge-order.cjs`：model overrides 必须能覆盖 provider default
- `check-text-only-models-resolve-text-only.cjs`：fixture：`o3-mini` resolver 必须返 `supportsThinking: true / supportsVision: false`
- `check-no-o3-mini-special-cases.cjs`：断旧零散特判已删除

**verify chain**：`verify:s`

### Theme 5 [RC-4] · Observability

**根因**：run metadata / token attribution / auto-title 三个 surface 各自缺；用户看不到研究类长任务的"agent / model / capability / parent run / token 归因 / 自动标题"任何一个。

**不照搬理由**：deer-flow `tracing/factory.py` 走 LangSmith / Langfuse hosted；Ready 用本地 per-run span，与 §6.11 metric registry 协同，不入 `TOOL_ERROR_METRICS`。

| W | 内容 | size | depends-on |
|---|---|---|---|
| **W5.1** | run metadata taxonomy —— per-run span: agent / model / capabilityClass / parent run id；新建 `src/main/modules/agent-control/run-span-metadata.ts` 导出 `RUN_SPAN_METADATA_KEYS`（**不**入 §6.11 `TOOL_ERROR_METRICS`） | S | W0.1 |
| **W5.2** | token usage attribution split —— (a) per model-call span 指标，(b) per-step TaskCard 归因（§6.22 task-projection-*）；来源 `agents/middlewares/token_usage_middleware.py` | S~M | W5.1 |
| **W5.3** | token 多维归因 —— search / fetch / subagent / present / clarification / todo 等子维度（参考 `token_usage_middleware.py:TOKEN_USAGE_ATTRIBUTION_KEY`） | S | W5.2 |
| **W5.4** | auto-title middleware —— `agents/middlewares/title_middleware.py`；TaskCard projection 首轮后自动调用，失败本地兜底 | S | W0.1 |

**gate**：
- W5.1 `check-run-span-metadata-keys-frozen.cjs`：新增 key 必须更新常量
- W5.2 `check-token-attribution-namespaces-separate.cjs`：不与 TOOL_ERROR_METRICS 合并
- W5.3 `check-token-attribution-dimensions-registered.cjs`
- W5.4 `check-auto-title-fallback.cjs`

**verify chain**：W5.1 + W5.4 → `verify:r`；W5.2 + W5.3 → `verify:s`

### Theme 6 [RC-2] · Interactivity

**根因**：Ready `skill_ask_user` 是 ephemeral 胶囊（24h TTL）+ 无 5 类 type + 无 options 列表 + 无稳定 ID + 用户无法重试 replace；体验上是个"黑盒胶囊"。

**不照搬理由**：deer-flow `ClarificationMiddleware` 在中间件链尾位 + `goto END`，Ready 没有中间件链（§6.10 单点裁决）；改在 turn 间隙触发；不允许澄清吞 turn。

| W | 内容 | size | depends-on |
|---|---|---|---|
| **W6.1** | clarification 5-type + options —— 移植 `tools/builtins/clarification_tool.py:6-18` 的 `Literal['missing_info','ambiguous_requirement','approach_choice','risk_confirmation','suggestion']` + `options: list[str] \| null`；`ask-user-bridge.ts` 升级 ephemeral 协议；renderer 5 类不同 UI（自由文本 vs 多选 vs 风险确认） | M | W0.2 |
| **W6.2** | clarification stable message ID —— `agents/middlewares/clarification_middleware.py:_stable_message_id` `f"clarification:{tool_call_id}"` 或 sha256 截 16；重试 replace 不 append | S | W6.1 |
| **W6.3** | clarification 在 turn 间隙触发（**非 middleware**）—— `turn-engine.ts` 工具批后位插入 check；**不吞 turn**（拒绝 deer-flow `goto END`） | M | W6.1 |
| **W6.4** | present_file 标准化呈现动作 —— 移植 `tools/builtins/present_file_tool.py:84-121`；新建 `src/main/modules/tools/builtins/present-file.ts`；契合 §6.8 文档多资源任务"现场展示"形态 | S | W0.1 |

**gate**：
- W6.1 `check-clarification-type-enum-frozen.cjs` + renderer 5 类 fixture matrix
- W6.2 `check-clarification-stable-id.cjs`
- W6.3 `check-clarification-turn-gap-not-middleware.cjs`
- W6.4 `check-present-file-only-outputs-dir.cjs`：仅允许 outputs/ 子树

**verify chain**：W6.1-6.3 → `verify:s`；W6.4 → `verify:r`

### Theme 7 [RC-2] · Sandbox Hardening（扩展 §6.12）

**根因**：§6.12 base allowlist 18 个命令 + bash 路径检查不够防 `rm -rf /` / `|sh` / `$(curl ..)` 复合命令；symlink / 文件大小 / host path 脱敏未约束。

**不照搬理由**：sandbox 抽象基类 + 6 原语扩展会破坏 §6.12 显式 4 原语决策；只取**正则审计 + symlink/size 限制 + host path 脱敏**三处补丁，不重构 sandbox 形态。

| W | 内容 | size | depends-on |
|---|---|---|---|
| **W7.1** | bash 危险模式正则审计 —— 移植 `agents/middlewares/sandbox_audit_middleware.py:25-51, 137-189` 的 `_HIGH_RISK_PATTERNS`；落 `src/main/modules/tools/skill-primitives/run-shell.ts` 在 `parseCommand` 后加正则审计层 | S | W0.3 |
| **W7.2** | read/write 路径 symlink 跳过 + 文件大小限 —— `sandbox/search.py` 的 ignore-symlink + max-file-size；落 `read-artifact.ts` + `write-artifact.ts` | S | W0.3 |
| **W7.3** | host path 脱敏（仅 stderr/stdout 输出层）—— `sandbox/local/local_sandbox.py` + `sandbox/tools.py` 形态；落 `run-shell.ts` 输出处理层 | S | W0.3 |
| ~~W7.5~~ | ~~file_operation_lock~~ —— **不立项**（与 §6.12 "不提供并发锁"决策冲突；仅作 backlog 备注，未来证明需要时局部加） | — | — |

**gate**：
- W7.1 `check-sandbox-bash-high-risk-patterns.cjs` + fixture matrix（rm -rf / dd / mkfs / |sh / $(curl) / base64 -d| / >/etc/* / >/usr/bin/）
- W7.2 `check-skill-primitives-symlink-rejected.cjs`
- W7.3 `check-shell-output-host-path-redacted.cjs`

**verify chain**：`verify:t`

### Theme 8 [RC-2] · Frame-Truth Compaction & LLM Resilience

**根因**：§6.15 L2 layered compactor 是 stub 但 deer-flow 有 skill-preserving 形态可采用；LLM 调用错误（5xx / 429 / busy）的重试散落各 provider 适配层，无统一中间件。

**不照搬理由**：§6.15 已明确 L2 实装是 deferred 决策（生产中 L1 不够 + 用户报"忘了上文"才上）；本 Theme W8.1 只落 stub 形态 + hook interface，不开实际压缩；W8.2 LLM 错误重试不照搬 deer-flow `goto END` 流控形态，而是落到所有 provider 适配层共享 helper。

| W | 内容 | size | depends-on |
|---|---|---|---|
| **W8.1** | L2 layered compactor **stub + hook 接口（不开实际压缩）** —— 实装 `BeforeSummarizationHook` 接口（pure interface）；落 `_SkillBundle` 形态的 frame-truth-preserve preview function（stub，不进入 production path）；触发实装条件：遵循 §6.15 deferred 决策，触发后另开 W8.1.1 工作项实装 | S | W0.2 |
| **W8.2** | LLM error retry/backoff/熔断 —— 移植 `agents/middlewares/llm_error_handling_middleware.py:27-41, 138-170, 208-298`；408/409/425/429/5xx + "server busy" 模式；新建 `src/main/modules/claude-bridge/llm-resilience.ts` 所有 provider 共用 | S~M | W3.1 |

**gate**：
- W8.1 `check-l2-stub-not-in-production-path.cjs`：断 stub 仅 reachable from test，production turn 不调用
- W8.2 `check-llm-retry-status-codes.cjs`：408/409/425/429/5xx + busy patterns

**verify chain**：`verify:s`

### Theme 9 [RC-5] · Worker Event Ledger（采用账本，拒绝 rollback 自动语义）

**根因**：§6.13 child runner 已有 JSONL 日志，但缺 `event_kind / terminal_reason / rollback_target` 维度，导致续跑诊断弱。

**不照搬理由**：deer-flow `runtime/runs/worker.py` 整体是 LangGraph worker 形态，Ready 保留 child runner；只采用 `worker.py:271-391` 的事件流账本字段。**显式拒绝** deer-flow worker abort rollback 语义；Ready 只做诊断账本，**不做自动状态回滚**（用户取消 task 仅标 cancel，已完成的副作用不撤销）。

| W | 内容 | size | depends-on |
|---|---|---|---|
| **W9.1** | child runner JSONL 加事件账本字段 —— 写入侧落 `skill-child-runner.ts` JSONL 写入位；除 `event_kind, ts, terminal_reason`，**终态事件可选写入** `rollback_target = lastSafeStepId`（用户 cancel 时填，自然结束不填） | M | W0.3 |
| **W9.2** | rollback_target **诊断字段读取**（采用诊断 + 拒绝自动回滚）—— 落 `skill-child-run-log.ts`（reader 真实文件）仅读取展示；renderer TaskCard 显示 `rollback_target` 字段供用户参考 | S | W9.1 |

**gate**：
- W9.1 `check-event-ledger-shape.cjs`：每条事件含 `event_kind, ts`；终态含 `terminal_reason`；`rollback_target` 仅在 terminal cancel 时出现
- W9.2 (a) `check-rollback-target-readable.cjs`，(b) `check-no-auto-rollback-on-cancel.cjs`：断 cancel 路径不触发任何 rollback 函数

**verify chain**：`verify:t`

### Theme 10 [RC-5] · Run Persistence & Feedback

**根因**：Ready 有 SQLite 但无 run_meta / thread_meta / feedback 表，无质量闭环——长任务诊断和用户反馈学习都缺持久化基础。

**不照搬理由**：deer-flow `persistence/engine.py` 提供 SQLite WAL + Postgres 双后端是服务端化方案；Ready 是单用户本地 Electron + better-sqlite3，整体形态不采用，仅采用 schema 设计（run/thread_meta/feedback 字段集合）+ 单向 migration 形态（与 §6.16 现有 33 个 migrations 一致）。

| W | 内容 | size | depends-on |
|---|---|---|---|
| **W10.1** | SQLite run_meta —— 落 `src/main/modules/migrations.ts` 单文件 `migrations[]` 数组追加（按现有编号约定，预计 034）；fields：status / token / 首尾消息 / follow-up | M | W5.1 |
| **W10.2** | thread_meta + owner 过滤 + strict mutate —— 同 W10.1 文件追加 + 新 repository | S | W10.1 |
| **W10.3** | run-level feedback upsert + stats —— 同 W10.1 文件追加 + 新 repository；用户对结果反馈的质量闭环基础 | M | W10.1 |
| **W10.4** | message_processing 纠错/强化识别 —— **仅** `agents/memory/message_processing.py:88, 100` `detect_correction / detect_reinforcement`，长期记忆主体 backlog；新建 `src/main/modules/agent-control/message-correction-detector.ts` | S | W0.1 |

**gate**：
- W10.1 (a) `verify:native` 真 sqlite，(b) `check-migration-numbering-sequential.cjs`，(c) `check-migration-fresh-upgrade-idempotent.cjs`：fresh install / upgrade from v033 / re-run idempotent 三场景测试，**不**测 down 因 Ready 单向
- W10.2 `check-thread-meta-strict-mutate.cjs`
- W10.3 `check-feedback-upsert-shape.cjs`
- W10.4 `check-correction-detector-fixtures.cjs`

**verify chain**：W10.1-10.3 → `verify:s`（已显式包含 `verify:native`，见 W0.2）；W10.4 → `verify:r`

### Theme 11 [RC-2] · Skill System Hardening（扩展 §6.7）

**根因**：§6.7 skill 中心已有 §6.23 authorization 三层（identity/authorization/registry），但 manifest `allowed-tools` 字段约束 + skill 安装期 security_scanner 阻断仍缺；恶意/越权 custom skill 进入 Ready 没有专用拦截层。

**不照搬理由**：deer-flow `skill_evolution / setup_agent_tool / update_agent_tool / invoke_acp_agent_tool` 让 agent 自管 skill / 自配置自身——与 §6.7 "skill 由用户/Ready 团队管理"明确决策冲突，全部不立项。本 Theme 只采用 deer-flow `skills/tool_policy.py` 的字段约束 + `skills/security_scanner.py` 的安装期阻断两处守门补丁。

| W | 内容 | size | depends-on |
|---|---|---|---|
| **W11.1** | skill manifest `allowed-tools` 字段过滤 —— 移植 `skills/tool_policy.py`；落 `skill-compiler.ts` + tool gateway 协同（§6.23 authorization 决定 visible，allowed-tools 决定 contractual） | S | W0.2 |
| **W11.2** | skill 安装/编辑前 security_scanner —— 移植 `skills/security_scanner.py`；落 `skills-runtime/runtime-manager.ts`（Ready 真实安装入口；不存在独立 skill-installer.ts，安装逻辑就在 runtime-manager 内）安装 hook；失败保守阻断 | M | W0.2 |

**gate**：
- W11.1 `check-skill-allowed-tools-enforced.cjs`
- W11.2 `check-skill-installer-scanner-blocks.cjs`：已知恶意 fixture 必须被拒

**verify chain**：`verify:s`

## 4. T-阶段（深度扩展，每条先过决策）

- **T-A** Theme 6 完成后体验已升级，**不独立存在**（被 W6.1-W6.4 取代）
- **T-B** parallel subagent + hard cap（**采用**）
  - source `subagents/executor.py` 概念 + `subagent_limit_middleware.py:1-75` 硬限流
  - landing 新建 `src/main/modules/agent-control/parallel-branch-orchestrator.ts`
  - size L
  - gate (a) `check-parallel-branch-frame-merge.cjs`：branch merge 必须保持 §6.20 frame 单源，(b) `check-parallel-branch-hard-cap.cjs`：默认 max 3
  - verify chain `verify:t`
  - **depends-on**（硬门）：W0.3 + W3.1 + W5.1 + W5.2 + W5.3
  - 架构风险：破坏 §6.20 TurnFrame 单源；与 deep-research 强组合（让 4 阶段并行）
- **T-C** MCP integration + OAuth + deferred discovery（**采用**）
  - source `mcp/{cache,client,oauth,tools}.py` + `tools/builtins/tool_search.py:31-120` + `agents/middlewares/deferred_tool_filter_middleware.py`
  - landing 新建 `src/main/modules/mcp/{client,oauth,registry}.ts` + 修改 `tool-registry.ts` / `tool-gateway.ts` 加 active/deferred 两档
  - size L
  - gate (a) `check-mcp-tools-go-through-authorization.cjs`，(b) `check-deferred-tool-promotion-after-authorization.cjs`，(c) `check-deferred-registry-per-turn-reset.cjs`：abort/error 后 reset
  - verify chain `verify:t`
  - **depends-on**（硬门）：W0.3 + W2.3 + W3.1 + W4.1 + W11.1
  - 架构风险：async-to-sync 在 Electron main 易踩坑；schema 数量爆炸
- **T-D** 远程 projection join/catch-up —— **不立项**（用户已决断，远程协作非短期目标）

## 5. Stage 划分

| Stage | 时间估 | 包含 W | Stage done 后 |
|---|---|---|---|
| **Stage R / 12** 合同基础 | ~3-4 周 | W0.1 / W1.1-W1.6 / W2.1-W2.3 / W5.1+W5.4 / W6.4 / W10.4 | 主 `verify` 切到 `verify:r` |
| **Stage S / 13** 完整功能 | ~6-8 周 | W0.2 / W3.0-W3.5 / W4.0-W4.5 / W5.2+W5.3 / W6.1-W6.3 / W8.1-W8.2 / W10.1-W10.3 / W11.1-W11.2 | 主 `verify` 切到 `verify:s` |
| **Stage T / 14** 深度扩展（每条先过决策） | ~按需 | W0.3 / W7.1-W7.3 / W9.1-W9.2 / T-B / T-C | 主 `verify` 切到 `verify:t` |

## 6. M1 里程碑 — deep-research full-stack enabled（跨 R+S）

必须以下全部 done 才标 M1 达成：
- **Stage R 段**：W1.1, W1.2, W1.3, W1.4, W1.6
- **Stage S 段**：W3.0, W3.1, W4.0, W4.1, W4.2, W4.3, W4.4, W5.2, W5.3, W8.2

**M1 不是 Stage R 单段承诺**——deep-research"完整可用"是跨段里程碑。Stage R 完成后只能算"deep-research 基础设施 ready"。

## 7. Absorbed dependency edges（硬门）

| 前置 | 后置 | 理由 |
|---|---|---|
| W4.0 | W4.1 | 必须先填 7 个内置 provider capabilityClass，再开 capability gate（否则现有 provider 全死） |
| W3.0 | W3.0.5 | parity gate 是字段扩展前置 |
| W3.0.5 | W3.0.6 | AIProviderDef 字段先于 AIModelDef + AIResolvedCapabilities |
| W3.0.6 | W3.1 | 类型扩展先于 provider 子模块化 |
| W3.1 | W3.2-W3.5 | provider 子模块文件先于 patcher 落点 |
| W3.1 | W4.0 | provider 子模块文件先于 capabilityClass export |
| W3.1 | W4.4 + W8.2 | provider 子模块 + bridge 接入先于具体 patch |
| W4.1 | T-C | capability gates 是外部工具进入前置 |
| W2.3 | T-C | 工具名重名硬失败必须先于 MCP 多 server schema 注入 |
| W11.1 | T-C | manifest allowed-tools 字段先于 MCP 工具进 skill 视图 |
| W3.1 | T-C | provider 子模块化先于 MCP 工具调用接入 |
| W0.3 | T-B + T-C | Stage T verify chain 必须先定义 |
| W3.1 | T-B | provider 子模块为 parallel branch 各自模型路由前置 |
| W5.2 | T-B | per-step token attribution 是并行 branch 计费基础 |
| W5.3 | T-B | 多维归因是并行 branch 拆分维度的前置 |
| W5.1 | W5.2 + W5.3 + W10.1 + T-B | run metadata 是 token attribution + run_meta 表的 schema 来源；并行 branch 计费基础 |
| W1.1 + W1.2 + W1.3 | W1.4 | SKILL.md 引用工具名必须先存在 |
| W1.4 | W1.5 + W1.6 | deep-research SKILL 形态确认是后续基础 |
| W6.1 | W6.2 + W6.3 | 5-type + options 是 stable ID + turn-gap 触发的前置 |
| W9.1 | W9.2 | event ledger 写先于读 |
| W10.1 | W10.2 + W10.3 | run_meta 表是 thread_meta / feedback 的关联 schema |

## 8. Absorbed mapping（v1-v13 → final）

| 历史名称 | v13 落点 |
|---|---|
| B1 deferred MCP tool discovery + scoped promotion | T-C 子项 |
| B2 frame-truth-preserving compaction | W8.1 |
| B3 stable tool-call key normalization | W2.1 |
| B4 dangling tool-call sanitizer gap audit | W2.2（drop-only contract）|
| B5 token usage + step attribution split | W5.2 + W5.3 |
| B7 clarification interrupt pattern | W6.1 + W6.2 + W6.3 |
| B8 parallel subagent hard cap | T-B 子项 |
| B9 run metadata taxonomy | W5.1 |
| B10 MCP OAuth interceptor | T-C 子项 |
| O4 config-driven capability gates | W4.1 |
| O5 remote projection join/catch-up | **不立项**（用户决断）|
| Provider fixture matrix（round 1b）| W2.2 gate (b) |
| abort/error 后 deferred registry reset（round 1b）| T-C gate (c) |
| W7.5 file_operation_lock | **不立项**（§6.12 决策冲突）|
| dangling tool_call inject 形态 | **拒绝**（W2.2 显式 drop-only）|
| deer-flow `write_todos / TodoMiddleware` | **拒绝**（W1.6 落点 17 显式 ResearchPlan 不引入 todo 形态）|
| deer-flow worker abort rollback 自动语义 | **拒绝**（W9.2 仅诊断不回滚）|

## 9. 不立项清单（明确）

- 长期记忆主体（仅采用 W10.4 纠错/强化识别）
- LangGraph checkpointer 抽象（TurnFrame 单源已覆盖）
- skill_evolution / setup_agent_tool / update_agent_tool / invoke_acp_agent_tool（agent 越权设计）
- 多用户网关 / auth.py / agents.py CRUD / skills.py edit-history（边界冲突）
- credentials_loader.py（产品边界）
- Jinja prompt 模板（SystemReminderRegistry 已覆盖）
- LangSmith / Langfuse hosted tracing（per-run span 已覆盖）
- 内容生产 skills（PPT/podcast/consulting/...）— backlog
- LangChain `AgentMiddleware` 全栈作为策略层
- 工具名 skip+warn — Ready 选硬失败
- T-D 远程 projection join/catch-up — 用户决断
- file_operation_lock 默认锁 — §6.12 决策冲突
- dangling tool_call inject 形态 — §6.11 errorKind 互斥
- deer-flow `write_todos` / TodoMiddleware
- deer-flow worker abort rollback 自动语义

## 10. 实施期 watch-list（Codex round 13 输出）

非合同瑕疵，但实施时容易写歪的细节：

1. W3.1 汇总时 `def.capabilityClass` 与单独 export `capabilityClass` 不能双源分叉
2. W4.0 三层 merge 优先级固定 `model override > provider class > fallback`
3. `capabilityModes` 只负责用户开关，不变成新模型配置结构
4. patch profile 执行接入要覆盖 streaming 与 `usage` 保留（不止非流式路径）
5. TaskType AST gate 白名单保持收敛，别变成绕过合同的长期逃生口

## 11. CI gate 完整列表（78 个 unique gate，29/37/12 拆分）

每个 W 与 §3 详细落点 1:1 映射。Gate 名 = `scripts/check-*.cjs` 文件名（实施期落地）。

### Stage R（verify:r）共 29 个

| W | Gate | 备注 |
|---|---|---|
| W0.1 | `check-stage-r-verify-switch.cjs` | Stage R done 后三处切换 |
| W1.1 | `check-web-search-tool-shape.cjs` + `check-web-search-end-to-end.cjs` | 形态 + 端到端 fixture |
| W1.2 | `check-web-fetch-tool-shape.cjs` + `check-web-fetch-end-to-end.cjs` | 形态 + 端到端 fixture |
| W1.3 | `check-current-date-reminder-registered.cjs` | |
| W1.4 | `check-deep-research-skill-asset-present.cjs` + `check-embedded-skill-manifest-vs-asset-parity.cjs` | |
| W1.5 | `check-methodology-skills-asset-present.cjs` | 5 个方法论 SKILL 共用 parity gate |
| W1.6 | `check-intent-domain-includes-research.cjs`、`check-research-end-to-end-routing.cjs`、`check-research-plan-not-document-task-plan.cjs`、`check-research-in-all-task-route-unions.cjs`、`check-research-in-coordinator-module-normalizer.cjs`、`check-research-adapter-registered-in-host.cjs`、`check-allow-research-tools-gate.cjs`、`check-research-tasktype-downstream-consumers.cjs`、`check-research-tools-distinguish-by-mode.cjs`、`check-research-budget-preset-shape.cjs`、`check-research-budget-not-fallthrough-to-24.cjs`、`check-web-tools-in-general-research-group-only.cjs`、`check-tasktype-allowlist-completeness.cjs` | 13 个 gate |
| W2.1 | `check-tool-call-args-hash-stable.cjs` | |
| W2.2 | `check-tool-input-sanitizer-single-source.cjs` + provider fixture matrix | matrix 是 fixture 不是 cjs |
| W2.3 | `check-tool-name-uniqueness.cjs` | |
| W5.1 | `check-run-span-metadata-keys-frozen.cjs` | |
| W5.4 | `check-auto-title-fallback.cjs` | |
| W6.4 | `check-present-file-only-outputs-dir.cjs` | |
| W10.4 | `check-correction-detector-fixtures.cjs` | |

### Stage S（verify:s，含 verify:native）共 37 个

| W | Gate |
|---|---|
| W0.2 | `check-stage-s-verify-switch.cjs` |
| W3.0 | `check-provider-parity.cjs` |
| W3.0.5 | `check-ai-provider-def-capability-class.cjs` |
| W3.0.6 | `check-ai-model-def-capability-overrides.cjs` + `check-ai-resolved-capabilities-thinking-longcontext.cjs` |
| W3.1 | `check-patch-profile-coverage.cjs`、`check-provider-patcher-applied-at-execution-client.cjs`、`check-patch-priority-stream-usage-preserved.cjs`、`check-ai-provider-submodule-shape.cjs`（W3.0 parity gate 复用，不重复计数） |
| W3.2 | `check-gemini-thought-signature-preserved.cjs` |
| W3.3 | `check-deepseek-reasoning-content-multi-turn.cjs` |
| W3.4 | `check-minimax-reasoning-split-mapping.cjs` |
| W3.5 | `check-openai-stream-usage-default.cjs` |
| W4.0/W4.5 | `check-builtin-provider-capability-fixture.cjs`、`check-resolveAIConfigCapabilities-consumes-capabilityClass.cjs`、`check-w4-after-w3.cjs`、`check-capability-gate-conservative-default.cjs`、`check-capability-gate-enforced-in-arbitration.cjs`、`check-vision-tool-capability-gated.cjs`、`check-view-image-followup-injection.cjs`、`check-reasoning-effort-routing.cjs`、`check-model-capability-resolver-merge-order.cjs`、`check-text-only-models-resolve-text-only.cjs`、`check-no-o3-mini-special-cases.cjs` |
| W5.2 | `check-token-attribution-namespaces-separate.cjs` |
| W5.3 | `check-token-attribution-dimensions-registered.cjs` |
| W6.1 | `check-clarification-type-enum-frozen.cjs` |
| W6.2 | `check-clarification-stable-id.cjs` |
| W6.3 | `check-clarification-turn-gap-not-middleware.cjs` |
| W8.1 | `check-l2-stub-not-in-production-path.cjs` |
| W8.2 | `check-llm-retry-status-codes.cjs` |
| W10.1 | `check-migration-numbering-sequential.cjs` + `check-migration-fresh-upgrade-idempotent.cjs` + `verify:native` 内嵌 |
| W10.2 | `check-thread-meta-strict-mutate.cjs` |
| W10.3 | `check-feedback-upsert-shape.cjs` |
| W11.1 | `check-skill-allowed-tools-enforced.cjs` |
| W11.2 | `check-skill-installer-scanner-blocks.cjs` |

### Stage T（verify:t）共 12 个

| W | Gate |
|---|---|
| W0.3 | `check-stage-t-verify-switch.cjs` |
| W7.1 | `check-sandbox-bash-high-risk-patterns.cjs` + bash fixture matrix |
| W7.2 | `check-skill-primitives-symlink-rejected.cjs` |
| W7.3 | `check-shell-output-host-path-redacted.cjs` |
| W9.1 | `check-event-ledger-shape.cjs` |
| W9.2 | `check-rollback-target-readable.cjs` + `check-no-auto-rollback-on-cancel.cjs` |
| T-B | `check-parallel-branch-frame-merge.cjs` + `check-parallel-branch-hard-cap.cjs` |
| T-C | `check-mcp-tools-go-through-authorization.cjs` + `check-deferred-tool-promotion-after-authorization.cjs` + `check-deferred-registry-per-turn-reset.cjs` |

**总计**：29 (R) + 37 (S) + 12 (T) = 78 个 unique CI gate（不含 fixture matrix 与 verify:native 内嵌；通过 `awk '/^## 11\./,/^## 12\./' docs/superpowers/plans/archive/2026-05-08-deerflow-borrowing-roadmap.md | grep -oE 'check-[a-zA-Z0-9-]+\.cjs' | sort -u | wc -l` 验证）。

## 12. 协作文档同步要求

按 CLAUDE.md §10 与 §12，本路线图 land 时必须同步：
- CLAUDE.md / AGENTS.md：Stage R/S/T 起新增 §6.25/§6.26/§6.27 章节，分别描述 Stage 合同
- PROGRESS.md：Stage 切换里程碑
- DOCUMENTATION.md：deep-research 用户使用指引
- LESSONS_LEARNED.md：13 轮收敛过程的经验留底

## 13. 后续实施文件

每个 Stage 立项时配套生成：
- `2026-MM-DD-R-stage12-implementation.md`
- `2026-MM-DD-S-stage13-implementation.md`
- `2026-MM-DD-T-stage14-implementation.md`（每个 T-决策项可独立 implementation 文件）

每个 implementation 文件先过 Codex 找瑕疵循环（参考 Stage Q 4 轮模式）才 land。

---

**v13 收敛声明（2026-05-08）**：本路线图经 Claude × Codex 13 轮找瑕疵循环（每轮基于真实仓内 grep / AST 核实，不是合同纸面博弈），第 13 轮 Codex 明确判定 "v13 converged — no Contract Gap"。剩余 5 条均为 Implementation Note（见 §10），不阻塞收敛。等待用户 sign-off 后立项进入 Stage R 实施。
