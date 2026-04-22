# Ready 开发进展

> 更新时间: 2026-04-22

## 当前真值摘要

0. Agent 核心重构已先落地第一段可上线基础层。

- `2026-04-22` **工具错误契约 Phase 4 落地：生命周期 + 观测性收口（refactor 最终段）**：
  - **Migration 028**：`skill_executions` 加 `(status, finished_at DESC)` 复合索引，TTL sweep 扫描成本跟"过期集合"而非"全表"成正比。
  - **`ExecutionStateStore.purgeExpiredExecutions(7)`**：删终态行（`completed / failed / cancelled` 且 `finished_at < now - 7d`）；**关键发现**：当前 DB init 从未执行 `PRAGMA foreign_keys = ON`，Migration 018 的 `ON DELETE CASCADE` 实际是 no-op，所以方法里显式先删 `skill_execution_artifacts` + `skill_execution_steps` 再删 `skill_executions`，避免孤儿；未来若 PRAGMA 开启，先删子行仍然是安全的 idempotent 预清理。
  - **`SkillsRuntimeManager.startTtlSweep()`**：构造函数里紧挨 `startScheduler()` 调用；boot 后 30s 首跑、之后每小时跑一次；单次失败只 `console.error`，不 kill 其他调度；每次完成后打 `TOOL_ERROR_METRICS.ttlSwept` metric。
  - **`generateSkillExecutionId()` = `'e-' + randomBytes(4).toString('hex')`**：新 executionId 形如 `e-9f3a2b1c`，日志一眼可辨；旧 UUID 行继续兼容（`getExecution` 用 `WHERE id = ?` format-agnostic，Zod `SkillExecutionIdSchema` 已是 opaque string）。**踩坑**：`persistState` 用 `INSERT ... ON CONFLICT(id) DO UPDATE`，id 碰撞不抛 UNIQUE 违规而是静默覆盖 —— 改用 `SELECT` 预检 + 3 次 retry，比依赖 UNIQUE 异常更可靠。
  - **新 `TOOL_ERROR_METRICS` 枚举**（`src/main/modules/agent-control/tool-error-metrics.ts`）：6 个 entry（`surfaced / unknownSurfaced / inputValidation / resolutionViolation / skillExecutionMissing / ttlSwept`）；key 是 camelCase 代码符号，value 是 snake_case 字符串（保持历史 log 聚合查询不变）；非 tool-error 的 metric（`tool_group_blocked_rate` 等）留在自己模块，**不**并入此 registry。
  - **4 个既有 emit 点换引用**：`tool-executor.ts:101/166`、`tool-runtime.ts:308`、`turn-engine.ts:352`；字符串值未变，仅加 import + 改引用。
  - **补 `skill_execution_missing` 打点**：`tool-executor.ts` catch 里 `kind === 'skill_execution_missing'` 时额外打点（携带 `toolName` / `sessionId` / `executionId`）；从此长尾频次在 `ready-agent-metrics.log` 可见。
  - **文档 4 连发**：`CLAUDE.md` §6.11（7 条 invariant）+ `AGENTS.md` 镜像 + `DOCUMENTATION.md` 追加「工具错误契约」大节（invariant + 相关文件 + metric 表 + 生命周期 + 调试入口）+ `LESSONS_LEARNED.md` 首部追加「stale executionId 引发架构翻新」一条。
  - **5 份新测试共 21 case 全绿**：`skill-execution-id-generator.test.ts` 2 case、`tool-error-metrics-registry.test.ts` 4 case、`execution-state-store-ttl.test.ts` 6 case（in-memory FakeDb 跑真实 purge 逻辑 + cascade 顺序断言）、`tool-error-metrics-contract.test.ts` 6 case（源码 regex 锁 4 个 emit 点 + skill_execution_missing 紧跟条件 + ttlSwept 三字段 + scheduler 常量）、`skill-execution-id-contract.test.ts` 3 case。Phase 1/2 的 `tool-executor-contract.test.ts` 3 处 regex 放宽到接受 literal 或 enum 引用。
  - 全量 `npm test`：1344 pass / 36 fail（Phase 3 基线 1323/36 → **+21 pass，0 新回归**）；`npx tsc --noEmit` 对所有触动文件干净。
  - **重构完整闭环**：Phase 1 dispatch 吞异常 → Phase 2/2.5 dispatch 入口 Zod（102 个工具）→ Phase 3 IPC 分流 + 软失败胶囊 → Phase 4 生命周期 + 观测性 + 文档契约。起因的 "Agent 错误: Execution not found" 现在变成一条 `tool-error-metrics.skillExecutionMissing` 打点 + 一个软失败胶囊，不再阻塞 turn。
  - **后续待办**（不在本期）：DB init 时打开 `PRAGMA foreign_keys = ON`（全局影响，需要审计所有现有 DELETE 路径）、`skill_executions` VACUUM（DELETE 不 reclaim 磁盘）。

- `2026-04-22` **工具错误契约 Phase 3 落地：IPC `agent:error` 结构化 + 渲染端软失败胶囊**：
  - **新增 `src/main/modules/claude-bridge/error-contract.ts`**：`deriveAgentErrorContract(error, options?)` 纯函数，消化 `errorKindFor()`（对 ToolDomainError/ToolHostUnavailable/AbortError 分类）+ `classifyExecutionError()`（对瞬时错误 rate_limit/timeout/transient/auth/context_overflow 进一步归类）。`tool_handler_failure` 退回 classifier；recoverable 白名单：`rate_limit / timeout_model / timeout_tool / transient / tool_handler_failure / 未知领域 errorKind → true`，`auth / context_overflow / host_unavailable / aborted / unknown → false`。
  - **加宽 `emitRuntimeError` 签名**：`direct-chat.ts:774`、`turn-transcript.ts:21/59`、`run-contracts.ts:625` 统一放宽到 `(error: unknown, options?: { toolName?: string })`；内部派生 contract 并 spread 到 `emit('error', { agent, runId, error, type, errorKind, recoverable, toolName })`。
  - **两处 catch 分流 emitOutput**：`turn-engine.ts:1503-1522` 和 `direct-chat.ts:906-934` 的 catch 都在 emitRuntimeError 之前先算一次 contract，`!recoverable` 才写 `transcript.emitOutput('API 请求失败...', 'error')`，避免胶囊和红字 transcript 重复（recoverable contract 在 emitter 内再算一次是幂等的微开销，换来 out-of-band 元数据零逃逸）。
  - **IPC 层增字段**：`ipc-handler.ts:1113-1135` `agent:scopeRunEvent` 记录 payload 增 `errorKind / recoverable / toolName` 三字段；`agent:error` 通过 orchestrator `...payload` spread 自动携带。`ScopeRunEventPayload` 类型在 `agent-control/types.ts:395-406` 同步 additive 扩展。
  - **ScopeRunState 加软失败侧字段**：`types.ts` 新增 `SoftErrorInfo { message, errorKind, toolName, receivedAt }` + `ScopeRunState.softError: SoftErrorInfo | null`；`createEmptyScopeRunState` 默认 `softError: null`。
  - **runtimeDriver onError 三向分流**（`runtimeDriver.ts:340-488`）：① `errorKind === 'aborted'` 早返（cancellation 走 runComplete 自有路径）；② `recoverable === true`（严格布尔，legacy payload 无字段走 fallback）只写 softError，**不**碰 phase/error/blockedReason/toolTraceStatus，**不**触发 addMessage/persistAssistantMessageForRun —— 避免污染 10+ 个 `phase === 'error'` 下游消费点；③ terminal 保留原行为 + 额外 `softError: null` 清除遗留胶囊。
  - **scopeRunState reducer**：`deriveScopeRunStatePatch` 对 `phase === 'error' && recoverable === true` 写 softError；其他 error 事件（含 legacy）清空。
  - **新组件 `SoftFailureCapsule.tsx`**：琥珀色 pill 显示 `工具 X 暂时失败`、消息、errorKind 小标签、`×` dismiss；`ChatPanel.tsx:3148` 挂在 `<ChatMessages>` 和输入区之间（同 tool-trace 胶囊一层，视觉归属一致）。
  - **useAgent 新增 `dismissSoftError(scopeId)`**：只清 softError，不重算。
  - **Preload + electron.d.ts**：`onError` 回调类型加 `errorKind? / recoverable? / toolName?` 可选字段（legacy 老主进程 payload 无这些字段时默认 terminal，确保 rollback 安全）。
  - **放弃 feature flag `READY_USE_RECOVERABLE_CAPSULE`**：回滚面只有 runtimeDriver 一个分支，flag 会累积 test matrix 债，不值。
  - **3 份新测试共 28 case 全绿**：
    - `error-contract.test.ts` 15 case —— 覆盖 ToolDomainError / ToolHostUnavailable / ToolAbort / legacy AbortError / HTTP 429 / auth / context_overflow / transient / timeout / 纯 Error / string throw / null&undefined / options.toolName 覆盖 / plain object toolName / 未知领域 errorKind 默认 recoverable=true
    - `agent-error-ipc-contract.test.ts` 9 case —— 源码 regex 锁 `direct-chat`/`turn-engine`/`ipc-handler`/`runtimeDriver`/`scopeRunState`/`ChatPanel` 6 侧 wiring；特别锁 recoverable 分支不调 addMessage/persist/toolTraceStatus，terminal 分支必须清 softError
    - `agent-error-legacy-payload.test.ts` 4 case —— 严格布尔（`=== true`）+ 严格字符串（`=== 'aborted'`）+ reducer 兜底 + preload 类型可选
  - 全量 `npm test`：1323 pass / 36 fail（Phase 2.5 收官基线 1295/36 → 净 +28 pass，零新回归）；`npx tsc --noEmit` 对所有触动文件干净。
  - **下一步**：Phase 4（`skill_executions` TTL + Task-ID 前缀 + 观测性 metric 枚举收口），详见 `plans/2026-04-22-tool-error-contract-refactor.md` §8。

- `2026-04-22` **工具错误契约 Phase 2.5 PR 12 落地：动态 skill-action 工具接入 Zod schema 缓存（Phase 2.5 收官）**：
  - **新增 `src/main/modules/tools/paramList-to-zod.ts`**：`zodObjectToParamList` 的反函数。接 `SkillParamDefinition[]`（即 manifest 里的 `action.params`）反向建 `z.ZodObject`。`string+enum → z.enum`、`number → z.number`、`boolean → LenientBoolean`（复用 PR 2 的 union literal 语义，接受 `true/false/'true'/'false'/'1'/'0'/1/0`）、`object → z.record(z.string(), z.unknown())` + 可选 `.meta({additionalProperties:true})`、`array` 按 `items.type` 映射元素类型。`required: false` 走 `.optional()`；`.describe()` 在 optional wrapper 上也重新附加一次（Zod v4 `.optional()` 不继承 inner description）。
  - **`skills-tools.ts` 新增 `getSkillActionSchemas()`**：迭代 `getSkillActionToolDefs()` 按 tool name 缓存 Zod schema。缓存失效检测用 `computeSkillActionSignature(defs)`（name + 参数名/类型/必填组合的 sorted join），比订阅 `SkillsRuntimeManager` 事件成本低且覆盖 manifest 重载、skill 新增/删除、visibility toggle。单个 manifest 反推失败被 try/catch 吞掉，不影响整个 registry。`getSkillsRuntimeManager()` 在 boot 未就绪时被捕获，返回空 map。
  - **`tool-executor.ts` 的 dispatch 闸门合并静态 + 动态**：`{ ...getSkillActionSchemas(), ...getToolInputSchemas() }`。**静态后置**让 6 个控制工具永远胜出 —— 防止用户 manifest 无意中把自己的 action 命名成 `skill_get_state` 把控制工具的 schema 覆盖掉（虽然 `buildToolName` 的 sanitize 规则理论上不会产生这种名字，但多一道 defensive 更稳）。
  - **合约断言同步**：`tool-executor-contract.test.ts` 里 PR 1 留下的 `validateToolInput(toolName, args, getToolInputSchemas())` 严格形式放宽到 `validateToolInput(toolName, args, mergedSchemas|getToolInputSchemas())`，继续锁 `getToolInputSchemas()` 依然被调用。
  - **2 份新测试共 11 case 全绿**：
    - `paramList-to-zod.test.ts` 8 case —— 各 leaf type 分支 + enum + LenientBoolean + optional 覆盖 + object 类型 + array<string>/number/object 派生 + **对 `SKILL_CONTROL_SCHEMAS` 6 个 schema 做 `zodObjectToParamList → paramListToZodObject → zodObjectToParamList` 往返一致**（保证反函数不丢信息）+ `additionalProperties:true` 字段级/元素级 round-trip 保真。
    - `skill-action-dynamic-contract.test.ts` 3 case —— source-level 锁 `skills-tools.ts` 里 `getSkillActionSchemas` + 签名缓存 + malformed-manifest catch 的结构；锁 `tool-executor.ts` 合并顺序 `{ ...dynamic, ...static }`；用 `STATIC_TOOL_NAMES` 字面量范围内的正则精确断言 table 不能把 alias 映射到 6 个控制工具名（避免误匹配到 executor 里的 `case 'skill_get_state':` 开关分支）。
  - 全量 `npm test`：1295 pass / 36 fail（PR 11 基线 1284/36 → 净 +11 pass，零新回归）；`npx tsc --noEmit` 对所有触动文件干净（修了 `z.ZodRawShape` 是 readonly 的 TS 类型问题，用 `Record<string, z.ZodTypeAny>` 中转后 cast）。
  - **Phase 2.5 收官汇总**：10 个工具域全部接入 dispatch 入口 Zod 校验；Phase 2 pilot 基线 1101/36 → 1295/36（**净 +194 pass，0 新回归**）；共新增 46 个 schema / 31 份测试文件 / 3 份纯模块抽取（skill-execution-tool-defs、file-management-tool-defs、system-tool-defs）；`zod-param-derivation` 覆盖 12 类 Zod 节点并支持数组 items + `.meta({additionalProperties:true})` opt-in；`tool-input-validator` 继续由未注册即 passthrough 守底。Phase 3（IPC errorKind）+ Phase 4（TTL + 观测性收口）可按原计划推进，无 Phase 2.5 遗留 blocker。

- `2026-04-22` **工具错误契约 Phase 2.5 PR 11 落地：system 域 2 个工具接入 Zod schema**：
  - **新增 `src/main/modules/tools/schemas/system-schemas.ts`** + **`system-tool-defs.ts`（纯模块）**：后者仿 PR 6 抽出，绕开 `getSkillsRuntimeManager → electron` 的测试阻塞；原 `system-tools.ts` 保留 `executeSystemTool` 执行逻辑 + re-export 纯模块的 `SYSTEM_TOOLS / getSystemAnthropicTools / getSystemOpenAITools`。
  - 至此 11 个静态域全部接入 Zod schema 注册表。剩下 PR 12 动态 skill-action。
  - **3 份新测试共 7 case 全绿**：shape 3 + 派生 2 + 黄金快照 2。
  - 全量 `npm test`：1284 pass / 36 fail（PR 10 基线 1277/36 → 净 +7 pass，零新回归）。
  - 下一个（最后一个）：PR 12 动态 skill-action —— `paramListToZodObject` 反向建 Zod + 按 `skillId:actionName` 缓存 + `SkillsRuntimeManager` 重载失效。

- `2026-04-22` **工具错误契约 Phase 2.5 PR 10 落地：browser_content_tasks 域 13 个工具接入 Zod schema**：
  - **新增 `src/main/modules/tools/schemas/browser-content-schemas.ts`**：13 个 Zod schema 覆盖图片收集 / 批量下载 / 结构化提取 / 滚动采集 / 后台任务 / 研究等。
  - **扩 `zod-param-derivation.ts` 支持 opt-in `additionalProperties`**：新增 `metaAdditionalPropertiesOf(node)` 读 Zod v4 `.meta({ additionalProperties: true })`，把 `additionalProperties:true` 派生到字段级或数组元素级的 `SkillParamDefinition`。这 4 个 PR 10 工具用到：`browser_extract_structured.fields` / `browser_aggregate_results.items` / `browser_run_workflow.steps` 是 array 元素 opt-in，`browser_start_task.payload` 是字段级 opt-in。
  - **刻意避开 `z.record` 默认 emit `additionalProperties`** ：第一版改法是让所有 `z.record` 默认带 `additionalProperties:true`，但那会让 PR 6/7/8/9 里 4 个已经落地的域（file / document / feishu / browser-interaction）的 LLM-facing 输出整体 drift（hand-rolled 没这个字段）。回退成 opt-in，保证已有的字节等价性。
  - **`browser-tool-catalog.ts`** 完成 content_task 13 entry 的派生切换，**9 个静态域全部进 registry**。
  - **2 份新测试共 20 case 全绿**：shape 9 + 派生 11（含 `items.additionalProperties` + 字段级 `additionalProperties` 的 `deepEqual` 锁）。
  - 全量 `npm test`：1277 pass / 36 fail（PR 9 基线 1257/36 → 净 +20 pass，零新回归）；`npx tsc --noEmit` 对触动文件干净。
  - 下一个：PR 11 system（2 工具；`getSystemAnthropicTools` 参数运行时生成，需要先看它怎么生成的再决定是改读 Zod 源还是抽纯模块）。

- `2026-04-22` **工具错误契约 Phase 2.5 PR 9 落地：browser_interaction 域 25 个工具接入 Zod schema**：
  - **新增 `src/main/modules/tools/schemas/browser-interaction-schemas.ts`**：25 个 Zod schema 覆盖导航 / 搜索 / 点击 / 输入 / 视觉分析 / 坐标操作 / 等待等家族；`TabIdOptional` shared constant 收 ~20 份 `tab_id` 字段重复；所有枚举字段（search engine、scroll direction、action kind、capture mode、wait condition）使用 `z.enum(...)` 派生 enum 数组。
  - **`browser-tool-catalog.ts` 派生改造**：仅 25 个 interaction entry 切换为 `zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS[name]) as ToolParamSchemaSpec[]`；13 个 content_task entry（collect_images、download_urls、extract_structured、scroll_collect、start_task、get_task、resume_task、cancel_task、aggregate_results、download_gallery、research_topic、run_workflow、execute_js）保持 hand-rolled，PR 10 接手。
  - **手动字节对比验证**：swap 前后分别 `npx tsx dump-browser.ts > ...json`，对 25 个 interaction 工具 `diff` 得到空差，LLM-facing payload 逐字节相同。
  - **2 份新测试共 38 case 全绿**：shape 13 case（按关键语义抽样：必填/enum/数组/对象类型）+ 派生 25 case（全工具 `deepEqual` hand-rolled，抽 `TAB_ID` 常量降重复）。
  - **刻意省略全量 golden snapshot**：inline 25 工具 LLM-facing 输出约 ~660 行、噪声大于信号；`toSchemaParam` / `normalizeAnthropicToolSchema` 管道自 PR 1 起未改，派生测试 + 下游 `tool-gateway-registry.test.ts` 等合约测试 + `npm test` 全量回归三者叠加已足够兜 byte drift；在 PROGRESS/CHANGELOG 里明文记录这一偏差。
  - 全量 `npm test`：1257 pass / 36 fail（PR 8 基线 1219/36 → 净 +38 pass，零新回归）；`npx tsc --noEmit` 对触动文件干净。
  - 下一个：PR 10 browser_content_tasks（13 工具；含结构化 array items 如 `items:{type:'object',additionalProperties:true}`，可能要扩 derivation 或用同一 `browser-content-schemas.ts` 文件）。

- `2026-04-22` **工具错误契约 Phase 2.5 PR 8 落地：feishu 域 16 个工具接入 Zod schema**：
  - **新增 `src/main/modules/tools/schemas/feishu-schemas.ts`**：16 个 Zod schema 按 5 个操作族分组；`ChannelId = z.string().describe('飞书频道 ID')` 做 shared constant 收 16 个工具共用的 `channel_id` 字段；`feishu_calendar_create_event.attendees` 用 `z.array(z.string())` 派生出 `items:{type:'string'}`。
  - **`feishu-tools.ts` 派生改造**：16 个 entry 的 `params` 全换为 `zodObjectToParamList(FEISHU_SCHEMAS[name]) as ToolParam[]`；原 ~200 行 hand-rolled 参数阵列删除；`ToolParam = ToolParamSchemaSpec` 保持（superset 支持 `items`/`additionalProperties`）。
  - **3 份新测试共 23 case 全绿**：`feishu-schemas.test.ts` 5 case 按操作族分组覆盖必填字段 + 数组类型；`feishu-zod-param-derivation.test.ts` 16 case `deepEqual` 旧 hand-rolled（抽 `CHANNEL_ID` 常量降重复）；`feishu-zod-golden-snapshot.test.ts` 2 case byte-lock。
  - 全量 `npm test`：1219 pass / 36 fail（PR 7 基线 1196/36 → 净 +23 pass，零新回归）；`npx tsc --noEmit` 对触动文件干净。
  - 下一个：PR 9 browser-interaction（26 工具；`browser-tool-catalog.ts` 集中定义且和 browser-tools.ts 拆分，需先看导入链是否纯）。

- `2026-04-22` **工具错误契约 Phase 2.5 PR 7 落地：document 域 15 个工具接入 Zod schema**：
  - **新增 `src/main/modules/tools/schemas/document-schemas.ts`**：15 个 Zod schema。widget 相关字段 `componentSpec / componentSpecPatch` 用 `z.record(z.string(), z.unknown())`，派生为 `{type:'object'}` 不带 `properties`，与旧 `toSchemaParam` 对 object 类型的输出字节一致。
  - **`document-tools.ts` 派生改造**：原 ~130 行 hand-rolled 参数阵列全部换成 `zodObjectToParamList(DOCUMENT_SCHEMAS[name]) as ToolParam[]`；15 个工具一把过。
  - **修复合约测试 `document-widget-system.test.ts#documents local inline interactivity in document widget guidance`**：旧断言只 grep `document-tools.ts` 源码找 `HTML\/SVG\/本地交互脚本` 子串；PR 7 后该字符串搬到 `schemas/document-schemas.ts`，合约失效。改成读 `document-tools.ts + document-schemas.ts` 拼接后 grep，保证 "widget 支持本地交互脚本" 的 guidance 契约仍成立且不依赖 SSOT 位置。
  - **3 份新测试共 31 case 全绿**：shape 14 + 派生 15（含 object 派生）+ 黄金快照 2。
  - 全量 `npm test`：1196 pass / 36 fail（PR 6 基线 1165/36 → 净 +31 pass，零新回归）；`npx tsc --noEmit` 对触动文件干净。
  - 下一个：PR 8 feishu（16 工具；`FEISHU_TOOLS` 分 doc / message / sheet 三类，可按操作族拆小文件或合成一个 schemas 文件）。

- `2026-04-22` **工具错误契约 Phase 2.5 PR 6 落地：file_management 域 7 个工具接入 Zod schema**：
  - **新增 `src/main/modules/tools/schemas/file-management-schemas.ts`**：7 个 Zod schema。数组全用 `z.array(z.string())`（对齐旧 `toSchemaParam` 对数组硬编码的 `items:{type:'string'}`）；`file_classify.setFrontmatter` 用 `z.record(z.string(), z.unknown())` 得到 `type: 'object'` 派生。
  - **抽出 `src/main/modules/tools/file-management-tool-defs.ts`**（纯模块）：仿 Phase 2 的 skill-execution-tool-defs 做法，把 defs + anthropic/openai builders 搬到不带 `getSearchEngine` 的纯模块。原因：golden snapshot 测试直接 import `file-management-tools.ts` 会触发 `search-engine/ipc-handler → electron 'app'` 失败（`npx tsx` 直接执行能过但 `--test` runner 挂），extract 是已验证过的通用解法。`file-management-tools.ts` 保留执行逻辑并 re-export 3 个公开符号维持调用点不变。
  - **`file-management-tool-defs.ts` 里的 `params` 全部派生自 Zod**：`zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS[name]) as ToolParam[]`。`toSchemaParam` 里对数组硬编码的 `items:{type:'string'}` 逻辑保留；Zod 派生同样emit `items:{type:'string'}`，downstream idempotent，LLM-facing 输出字节一致。
  - **3 份新测试共 16 case 全绿**：shape 7 + 派生 7（含数组 items）+ 黄金快照 2（指向新的纯 defs 模块）。
  - 全量 `npm test`：1165 pass / 36 fail（PR 5 基线 1149/36 → 净 +16 pass，零新回归）；`npx tsc --noEmit` 对触动文件干净。
  - 下一个：PR 7 document（14 工具；widget `componentSpec` 的 `object` 派生是否需要递归展开 properties，届时看 golden snapshot 报不报差异再决定）。

- `2026-04-22` **工具错误契约 Phase 2.5 PR 5 落地：session 域 1 个工具接入 Zod schema**：
  - **新增 `src/main/modules/tools/schemas/session-schemas.ts`**：`SessionSearchSchema`，`sourceKind` 走 `z.enum(['local','channel'])`，`hasAttachments` boolean、`limit` number，全字段 optional。
  - `session-recall-tools.ts` 只有一个 `session_search`，params 切换为 `zodObjectToParamList` 派生。
  - **3 份新测试共 7 case 全绿**：shape 4 + 派生 1 + 黄金快照 2。
  - 全量 `npm test`：1149 pass / 36 fail（PR 4 基线 1142/36 → 净 +7 pass，零新回归）。
  - 下一个：PR 6 file-management（8 工具；`getSearchEngine` 导入链要先确认能否走 pure test，否则沿用源码级正则断言）。

- `2026-04-22` **工具错误契约 Phase 2.5 PR 4 落地：calendar 域 5 个工具接入 Zod schema**：
  - **新增 `src/main/modules/tools/schemas/calendar-schemas.ts`**：5 个 schema，全 string 字段无枚举无数组，对旧 hand-rolled 字节一致；`calendar_capture_session` 无参，派生 `[]`。
  - **`calendar-tools.ts` 派生改造 + `schemas/index.ts` spread 注册**，同一模板一把过。
  - **3 份新测试共 12 case 全绿**：shape 5 + 派生 5 + 黄金快照 2。
  - 全量 `npm test`：1142 pass / 36 fail（PR 3 基线 1130/36 → 净 +12 pass，零新回归）。
  - 下一个：PR 5 session-recall（1 工具）。

- `2026-04-22` **工具错误契约 Phase 2.5 PR 3 落地：rss 域 5 个工具接入 Zod schema**：
  - 触发：PR 2 把 `ZodArray → items` 派生补齐之后，rss 域没有数组 param，是最快的一 PR。
  - **新增 `src/main/modules/tools/schemas/rss-schemas.ts`**：`RssAddSourceSchema / RssFetchUpdatesSchema / RssSelectItemSchema / RssAnalyzeItemSchema / RssCaptureSessionSchema`。两个工具参数列表为空（`z.object({})`），`zodObjectToParamList` 派生出 `[]`，与旧 `params: []` 字节一致。
  - **保持 byte-equivalence**：`rss_analyze_item.analysisType` 旧手写只有 `type: 'string'` 无 enum（虽然 executor 会自行拒绝非 copy/visual）。schema 这里**不**加 `z.enum(['copy','visual'])`，避免 golden snapshot 失锁；enum 收紧留作后续独立 PR。
  - **`rss-tools.ts` 派生改造**：`RSS_TOOLS` 5 个 entry 的 `params` 全换成 `zodObjectToParamList(RSS_SCHEMAS[name]) as ToolParam[]`；`getRSSAnthropicTools / getRSSOpenAITools / executeRSSTool` 调用链不变。
  - **注册**：`schemas/index.ts` 加 `import { RSS_SCHEMAS } from './rss-schemas'` + `...RSS_SCHEMAS` spread。
  - **3 份新测试共 12 case 全绿**：`rss-schemas.test.ts` 5 case、`rss-zod-param-derivation.test.ts` 5 case（含两个空 `[]` 工具）、`rss-zod-golden-snapshot.test.ts` 2 case。
  - 全量 `npm test`：1130 pass / 36 fail（PR 2 基线 1118/36 → 净 +12 pass，零新回归）；`npx tsc --noEmit` 对触动文件干净。
  - 下一个：PR 4 calendar（5 工具；有 intent 字段要读 tool-registry.ts 对应 entry）。

- `2026-04-22` **工具错误契约 Phase 2.5 PR 2 落地：memory 域 4 个工具接入 Zod schema**：
  - **新增 `src/main/modules/tools/schemas/memory-schemas.ts`**：4 个 Zod schema（`MemoryCreateSchema / MemorySearchSchema / MemoryUpdateSchema / MemoryListRecentSchema`）；shared `SourceTypeEnum = z.enum([...])` 收 3 个工具共用的 4 值枚举；描述 / enum / optional 顺序全部对旧 `MEMORY_TOOLS` 逐字节一致，否则 golden snapshot 双侧测试会立刻挂。
  - **扩 `SkillParamDefinition`**（`src/shared/skill-execution-types.ts`）：加 `items?: Record<string, unknown>` + `additionalProperties?: boolean`，与 `./tool-schema.ts::ToolParamSchemaSpec` 超集对齐；两个字段都是 optional，对已有 6 个 skill 控制工具派生零行为变化。
  - **扩 `zod-param-derivation.ts` 的 `ZodArray` 分支**：`resolveParamType` 现在读 `def.element`（Zod v4 的 array 元素字段），递归 resolve 后 emit `items: { type: <elementType> }`；未知元素类型退化到旧的 `{type: 'array'}` 不带 items；try/catch 包裹 recursion 防止未支持节点炸派生。
  - **`memory-tools.ts` 派生改造**：`MEMORY_TOOLS` 4 个 entry 的 `params` 字段换成 `zodObjectToParamList(MEMORY_SCHEMAS[name]) as ToolParam[]`，原 ~120 行 hand-rolled 参数阵列删除；`getMemoryAnthropicTools / getMemoryOpenAITools` 调用链不变，`buildToolParamSchema / normalizeAnthropicToolSchema / normalizeOpenAIToolSchema` 仍作输出管道。
  - **注册进统一表**：`schemas/index.ts` 新加 `...MEMORY_SCHEMAS` spread；后续 PR 3-12 按同一模式追加一行。
  - **3 份新测试共 13 case 全绿**：
    - `memory-schemas.test.ts` 7 case —— 形状、optional、enum、tags 必须数组、memory_id 必填、strip 未知键。
    - `memory-zod-param-derivation.test.ts` 4 case —— 4 个 schema 派生结果 `deepEqual` 内联的旧手写 params 数组（不走 memory-tools.ts，完全从 Zod 反推）。
    - `memory-zod-golden-snapshot.test.ts` 2 case —— `getMemoryAnthropicTools / getMemoryOpenAITools` 与内联的 `EXPECTED_ANTHROPIC` 结构 `deepEqual`；在派生切换**之前**提交的 commit 锁住 byte-level 等价性。
  - 全量 `npm test`：1118 pass / 36 fail（PR 1 基线 1105/36 → 净 +13 pass，零新回归）；`npx tsc --noEmit` 对所有触动文件干净。
  - 下一个：PR 3 rss（5 工具）—— 同一模板一把过。

- `2026-04-22` **工具错误契约 Phase 2.5 PR 1 落地：dispatch 闸门去域限定 + 统一 schema 注册表**（计划 `~/.claude/plans/generic-enchanting-gosling.md`，12 PR 链条首个基础设施 PR）：
  - 触发：Phase 2 只给 skill 域 6 个控制工具接了 Zod 校验；要把同一 pattern 滚到其他 9 个静态域 + 动态 skill-action，必须先拆掉 `if (definition.domain === 'skill')` 硬闸门，否则每个域 PR 都会在 `tool-executor.ts` 同一块改冲突。`tool-input-validator.ts` 本来就对未注册工具 passthrough —— 把 gate 一次性拆成域无关，后续 PR 只动自己的 schemas 文件即可。
  - **新增 `src/main/modules/tools/schemas/index.ts`**：`STATIC_TOOL_INPUT_SCHEMAS` 用 spread 汇聚所有域的 Zod 注册表，目前只承接 `SKILL_CONTROL_SCHEMAS` 一组；导出 `getToolInputSchemas()` 访问器而非常量，为 PR 12 折入动态 skill-action cache 预留热路径（无需 cold-path re-export / 缓存失效协调）。
  - **`tool-executor.ts` 闸门改写**：`if (definition.domain === 'skill')` 包裹去掉；`validateToolInput(toolName, args, getToolInputSchemas())` 每次 dispatch 都跑；未注册工具走 validator 的 `if (!schema) return { ok: true }` 分支，对非 skill 域零行为变化。失败 metric 增字段：`logAgentMetric('tool_input_validation_failed', { toolName, domain, issueCount, firstCode, firstPath, sessionId })` —— `domain` 是新加的，让后续按域统计失败率。
  - **新测试 `src/__tests__/tool-input-schemas-registry.test.ts`（4 case 全绿）**：注册表包含 6 个 skill 控制工具名、`getToolInputSchemas()` 返回可安全 spread 的普通对象（未冻结、未代理）、无重复键、每个值是带 `safeParse` 的 ZodObject —— 为后续 PR 往里塞域 map 提供不变式兜底。
  - **扩写 `src/__tests__/tool-executor-contract.test.ts`**：反向断言 `doesNotMatch(/if \(definition\.domain === ['"]skill['"]\) \{...validateToolInput/)` 锁旧守卫消失；正向断言 `validateToolInput(toolName, args, getToolInputSchemas())` 与 `domain: definition.domain` 新字段就位；保留既有的 `args = outcome.data` / `return outcome.output` / `logAgentMetric` 锚点断言。
  - 全量 `npm test`：1105 pass / 36 fail（Phase 2 基线 1101/36 → 净 +4 pass，零新回归）；`npx tsc --noEmit` 对所有触动文件干净。
  - 后续 12 个 PR 按计划推进顺序：memory(4) → rss(5) → calendar(5) → session(1) → file(8) → document(14) → feishu(16) → browser-interaction(26) → browser-content(13) → system(2) → skill-action(动态)。每个 PR 只新增 `schemas/{domain}-schemas.ts` + golden snapshot + 派生改造 + 注册表 spread。

- `2026-04-22` **工具错误契约重构 Phase 2 落地：Zod schema pilot on skill control tools**（计划 `plans/2026-04-22-tool-error-contract-refactor.md` §6，详设计 `~/.claude/plans/generic-enchanting-gosling.md`）：
  - 触发：Phase 1 已把"handler throw"兜住，但 root cause（模型发空串/错格式 executionId → 到 DB 才爆）还在。Zod 4.3.6 本来就在 deps，TS 5.7.3 覆盖 Zod v4 要求，`z.toJSONSchema()` native 可用 —— 对照 CC-Source 的两阶段 dispatch 校验契约落 pilot。
  - **新增 `src/main/modules/tools/schemas/skill-control-schemas.ts`**：6 个 "execution_control" skill 工具的 Zod schema 作为 SSOT；`SkillExecutionIdSchema = z.string().trim().min(1)`；`LenientBoolean` 用 union literals 严格复刻 `asBoolean` 的 `true/false/'true'/'false'/'1'/'0'/1/0` 覆盖（**不**用 `z.coerce.boolean()` —— 它会把字符串 `"false"` 当真，隐形翻转拒绝为确认）；`SKILL_CONTROL_SCHEMAS: Record<SkillControlToolName, ZodObject<ZodRawShape>>` 带 typed union 防止注册漂移。
  - **新增 `src/main/modules/tools/tool-input-validator.ts`**：纯函数 `validateToolInput(toolName, args, schemas)`，无 schema 登记 → passthrough；`safeParse` OK → 返回解析后的 `data`（让 `.transform` 生效）；失败 → `createToolExecutionOutput` 带 `errorKind: 'input_validation'`，最多报 10 条 issue，`text` 中文格式 `"工具 X 输入校验失败：path — message"`。
  - **抽出 `src/main/modules/tools/skill-execution-tool-defs.ts`**：把 `EXECUTION_TOOL_DEFS + toSchemaParam/toAnthropicTool/toOpenAITool` 从 `skills-tools.ts` 移到纯模块，为 golden snapshot 绕开 electron 导入链提供路径；同时把 6 个 tool defs 的 `params` 字段改为 `zodObjectToParamList(SKILL_CONTROL_SCHEMAS[name])` 派生，杀掉 Zod schema ↔ LLM-facing JSONSchema 双源漂移。
  - **新增 `src/main/modules/tools/zod-param-derivation.ts`**：Zod v4 兼容的 `zodObjectToParamList`，走 `.description` accessor + `.meta()` fallback（Zod v4 的 description 不在 `_def` 里）；支持 `ZodString/Boolean/Number/Object/Record/Array/Optional/Default/Enum/Literal/Union/Pipe` 共 12 类节点，未识别节点**抛错**让测试立刻发现覆盖漏洞；ZodUnion 取第一个成员类型（lenient-boolean union 自动塌缩为 `boolean`）。
  - **`tool-executor.ts` 接入 validator**：在 `getToolDefinition` 之后、`switch` 之前加 `if (definition.domain === 'skill')` 闸门，只对 skill 域走校验；失败打 `logAgentMetric('tool_input_validation_failed', { toolName, issueCount, firstCode, firstPath, sessionId })` 并提前 return；成功用 `args = outcome.data`（保留 transform 值）。dynamic skill-action 工具同是 skill 域但没注册 schema → passthrough。
  - **新测试 4 份 + 1 份扩展**（27 case 全绿）：
    - `skill-control-schemas.test.ts` 11 case —— 形状、optional、lenient boolean 所有合法变体、strip unknown keys。
    - `tool-input-validator.test.ts` 5 case —— passthrough、coerce OK、失败结构、10 条 issue 上限、root-level error。
    - `skill-zod-golden-snapshot.test.ts` 3 case —— LLM-facing Anthropic/OpenAI 输出 byte-for-byte 锁定（**commit 在派生切换之前**作为回归网）。
    - `skill-zod-param-derivation.test.ts` 7 case —— 6 个 schema 派生结果 `deepEqual` 旧手写 params，外加 missing `.describe()` 报错路径。
    - `tool-executor-contract.test.ts` 扩 1 case —— 校验闸门接入点、metric、`args = outcome.data` 赋值。
  - 全量 `npm test`：1101 pass / 36 fail（Phase 1 基线 1074/36 → 净 +27 pass，无新回归）；`npx tsc --noEmit` 对所有触动文件干净。
  - **Out-of-scope**：dynamic skill-action 工具（manifest 驱动），其他域（browser/document/feishu/...）—— pattern 现在已证明，后续按一个域一 PR 推进。MCP 适配 / Task-ID 前缀迁移留 Phase 4。

- `2026-04-22` **工具错误契约重构 Phase 1 落地**（计划 `plans/2026-04-22-tool-error-contract-refactor.md` §5）：
  - 触发：上一轮 "Agent 错误: Execution not found" 问题盘查后，确认 `tool-runtime.ts:290` 的 `classified.kind !== 'unknown'` 默认值对 LLM-agent 架构是反的（未分类错误被当作致命错误终结整轮），参考 CC-Source 的"所有 tool 错误都是 `is_error: true` tool_result"统一契约设计。
  - **新增 `src/main/modules/tools/tool-errors.ts`**：`ToolDomainError`（领域错误，带 `errorKind + detail`）、`ToolHostUnavailableError`（host 能力离线，终结类）、`ToolAbortError`；`isTerminalInfrastructureError(error)` 基于 `error.name === 'AbortError'` / `instanceof ToolHostUnavailableError` 做 minify 安全的终结判定；`errorKindFor / errorMessageOf` 规范化导出。
  - **`tool-executor.ts` 的 `executeToolCall` 外层包 try/catch**：dispatch switch 的所有 throw 被兜住；终结类 rethrow，其余转成带 `errorKind: 'tool_handler_failure'` 的 `ToolExecutionOutput` 并 `logAgentMetric('tool_error_surfaced', ...)`，模型可在下轮 tool_result 里看到并自纠。
  - **`tool-runtime.ts:289-316` 翻转默认**：`kind === 'unknown'` 不再 `throw error`；入口先 `if (isTerminalInfrastructureError(error)) throw error` 放行终结类，其余一律转结构化返回；unknown-kind 额外 `logAgentMetric('tool_error_unknown_surfaced', ...)` 供后续观测 dispatch 兜底是否仍有漏网。AbortError 继续按原路径冒泡（outer runner 负责 interrupt hook）。
  - **新测试 `src/__tests__/tool-executor-contract.test.ts`** 7 case 全绿：ToolDomainError kind/detail、ToolHostUnavailableError terminal、AbortError terminal、bare Error fallback to tool_handler_failure、非 Error 值也能 kind 化、`executeToolCall` 源码包 try/catch 且 terminal rethrow、`tool-runtime` 不再有尾部 `throw error`。
  - 全量 `npm test`：1074 pass / 36 fail（基线 1072 pass / 38 fail，净 +2 pass / -2 fail，36 项失败均为预存 electron 导入链问题与本次无关）；`npm run typecheck` 对触动文件干净。
  - 不破坏现有 retry/recover 机制（`timeout_tool` / `transient` / `host_unavailable` / `auth` 的 classifier + buildRecoveryPlan 链路保持不变）。后续 Phase 2（Zod 参数校验）/ Phase 3（IPC errorKind/recoverable）/ Phase 4（skill_executions TTL + 观测性收口）按 plan 分 PR 推进。

- `2026-04-21` 全局搜索 Step 5（多源索引抽象）+ Step 6（Agent 工具层 · 反向链接 · 关系图谱）已落地（计划 `plans/1-4-piped-bear.md` §Step 5/6）：
  - **Migration 027**：`documents` 表新增 `source_type / source_meta_json / source_id` 列 + `idx_documents_source` 索引；插入 `@shared` workspace 承载非文件源。原 `(workspace_id, path)` 唯一键沿用，bookmark/rss/calendar/agent 各自用 `rss://id` 等伪 URI 落 path。
  - **Adapter 层**（`src/main/modules/search-engine/adapters.ts`）：`IndexSourceAdapter` 接口 + 5 个实现 —— `FileSystemAdapter`（per-root，原 reindex 主循环重构进来）、`BookmarkAdapter / RssAdapter / CalendarAdapter / AgentMessageAdapter`（均 shared，直接 SELECT 本域表写入 documents）。`syncShared` helper 统一事务 + 删除孤儿行。`conversation_attachments` 表当前不存在，adapter 暂不实现。
  - **多源搜索**：`SearchEngine.reindexAllSources(root)` 并列跑 fs + 4 个 shared adapter；`search(query, {sources?})` 动态拼 `d.source_type IN (…)`；query planner 新增 `src:xxx` token 类型，与 `opts.sources` 合并。新 IPC `document:reindexAllSources / listSources`；preload + `electron.d.ts` 同步 `DocumentSearchHit.sourceType / sourceMeta`、`DocumentReindexAllSourcesResult` 等类型。
  - **GlobalSearchPanel** 切到 `reindexAllSources`，渲染源 chip（doc/bookmark/rss/calendar/agent），`openResult` 按 source_type 分流：doc 走 `selectFile + workbench mode`；bookmark/rss 用 `window.open(url)`（main 的 `setWindowOpenHandler` 自动 `shell.openExternal`）；calendar/agent 暂切到相应 mode。
  - **Agent 工具层**（新 capability group `file_management` / 新 `ToolDomain 'file'`）：`src/main/modules/tools/file-management-tools.ts` 暴露 7 个工具 —— `file_search / file_locate / file_get_backlinks / file_get_graph`（只读，主进程直查 SQLite，无需 renderer 往返）+ `file_classify / file_rename / file_move`（写类，`assertInsideWorkspace` 严格 workspace root 前缀校验，`newName` 拒绝路径分隔符，默认不覆盖）。`file_classify` 通过 `src/shared/document-graph-parse-frontmatter-writer.ts` 的 `writeFrontmatter` 幂等写入 YAML frontmatter，再主动 `engine.indexDocument` 回写索引。
  - 工具链路接入：`tool-registry.ts` 新增 `file_management` provider；`tool-parallelism-policy.ts` 在前缀分发里加 `file_` → `domain='file'` 分支（write tools `accessMode='write'`）；`tool-executor.ts` switch 增加 `case 'file'` 走 `executeFileManagementTool`。`ai-capability-groups.ts` 补 `file_management` 组定义。遵循 CLAUDE.md §6.10：不在 `turn-engine` 加双重挡板；裁决仍只走 `resolveRunCapabilities` / `resolvePolicyConflicts` 既有两类冲突。
  - **反向链接 Panel**（`src/renderer/components/document/BacklinksPanel.tsx`）：读 `document:getBacklinks(path)` IPC（新增，基于 `doc_links.target_doc_id`），列表条目点击 `selectFile(srcPath)`。空结果自动隐藏整个面板；待接入 `MarkdownEditor` 底部槽位。
  - **关系图谱视图**（`src/renderer/components/graph/`）：不引入新 npm 依赖；自写 ~180 行 Verlet force sim（`runForceLayout` 纯函数 + `useForceLayout` hook），节点 = doc/tag/ghost、边 = wikilink/mdlink/tag-of；`GraphView.tsx` 用 SVG 渲染 + pointer 捕获做 pan/zoom/drag；`document:getGraph({centerPath?, depth?, workspaceRoot?})` IPC 支持 BFS 深度限制；空图状态友好提示。
  - 新增单测 6 条（`document-graph-parse-frontmatter-writer` 3 + `search-query-planner` 额外 2 条 src: 覆盖 + `search-force-layout` 3）全绿；合计 Step 5/6 引入 27 条单测。`npm run typecheck` 干净。
  - 关键新文件：`src/main/modules/search-engine/adapters.ts`、`src/main/modules/tools/file-management-tools.ts`、`src/shared/document-graph-parse-frontmatter-writer.ts`、`src/renderer/components/document/BacklinksPanel.tsx`、`src/renderer/components/graph/{useForceLayout.ts,GraphView.tsx}`。

- `2026-04-21` 全局搜索 FTS5 索引 Step 4（草稿叠加 + 收尾）已落地（计划 `plans/1-4-piped-bear.md` §Step 4）：
  - NFKC 归一、零宽剥离、CJK bigram、`####heading` 跳过、widget fence 文本入索引、`BINARY_EXTENSIONS + >2MB` 防护，均已在 Step 2/3 落地，Step 4 不再重复做。
  - `GlobalSearchPanel.tsx` 新增 `parseLocalQuery / buildDraftSnippet / matchDraftTab`：`useDocTabs.tabs.filter(t => !t.path || t.isDirty)` 被本地用 `parseDocumentGraph` 解析并按 AND 语义匹配（所有 tag / wikilink 必须命中；所有 FTS term 必须命中 normalized body 或 name）；命中草稿前置合入结果流，同路径的 IPC 结果会被过滤掉（以 draft 现值为真）。
  - 结果渲染带 `draft` 角标，点击草稿直接 `setActiveTab(tab.id) + setWorkbenchMode('document')`；磁盘文件仍走 `selectFile(path)`。统计行改为「命中 N 条 +M 草稿 · X ms · degraded?」。
  - 全套单测 19/19（`document-graph-parse` 11 + `search-query-planner` 8）全绿，`npm run typecheck` 通过。
  - Step 1-4 合计关键文件：`migrations.ts`（026 迁移）+ `search-engine/{repository, indexer, query, ipc-handler}.ts`（新模块）+ `document-graph-parse.ts`（新共享）+ `document-engine/ipc-handler.ts`（`export BINARY_EXTENSIONS`、`setDocumentWriteIndexHook`）+ `database.ts`（`export DatabaseConnection/Statement`）+ `preload/index.ts` + `electron.d.ts` + `GlobalSearchPanel.tsx`。图谱铺路已完成：`doc_links + tags + documents` 三张表构成完整图数据源，后续做 Obsidian 式图谱只需 renderer 读取 + D3/Cytoscape 渲染。

- `2026-04-21` 全局搜索 FTS5 索引 Step 3（前缀语法 + FTS5 查询 + 面板切换）已落地（计划 `plans/1-4-piped-bear.md` §Step 3）：
  - 新增 `src/main/modules/search-engine/query.ts`：`parseSearchQuery` 按引号短语 / `#tag` / `[[wikilink]]` / 普通 term 四类切分；所有 token 走 NFKC 归一 + 零宽剥离；纯标点（`#` / `[[` / `""` 单独出现）直接丢弃；CJK term / phrase 展开为 bigram 短语串（`"机器学习"` → `"机器" "器学" "学习"`，各段间 AND）。
  - `SearchEngine.search` 按 `parsed.ftsMatch / tags / wikilinks` 动态拼 SQL：FTS 段走 `documents_fts MATCH + bm25(documents_fts, 2.0, 1.0) + snippet(…, char(1), char(2), …, 12)`（用控制字符做 mark 分隔避免 `dangerouslySetInnerHTML`）；tag 条件走 `tags IN (…) GROUP BY doc_id HAVING COUNT(DISTINCT)=N` 保证 AND；wikilink 走 `doc_links kind='wikilink'`；无 FTS term 时跳过 join，改按 `indexed_at DESC` 排序。查询侧再补一次 tag/link 回读用于填 `tagsHit / linksHit` 标记。
  - 新 IPC `document:searchIndex({query, limit?, workspaceRoot?})` 在 `search-engine/ipc-handler.ts` 注册，preload `documentAPI.searchIndex` 与 `electron.d.ts` 的 `DocumentSearchHit / SearchIndexResult / Response` 类型全链路同步。
  - `GlobalSearchPanel.tsx` 切换到 `electronAPI.document.searchIndex`：runSearch 整块替换、`SearchResultItem` 扩 `tagsHit/linksHit/snippet`，`renderSnippet` 按控制字符切段用 `<mark>` 标注；`workspaceRoot` 变化时自动 `reindexWorkspace`；带前缀语法（`#/[[`）时 replace-all 按钮自动禁用并给出 tooltip；替换成功后 `document:write` 钩子即时更新索引，之后自动再查一次。panel 顶部文案改为「#tag / [[wikilink]] 前缀语法 · 引号可做短语匹配」。统计行改为「命中 N 条 · X ms」并带 degraded 标记。
  - 新增单测 `src/__tests__/search-query-planner.test.ts` 8/8 全绿：tag/wikilink/term 分类、引号短语、NFKC 全角 `＃ａｌｐｈａ`、CJK bigram 展开、CJK 短语折空格再 bigram、纯前缀 token → `ftsMatch=null`、零宽字符剥离、`""` / `#` 纯标点丢弃。`npm run typecheck` 通过。

- `2026-04-21` 全局搜索 FTS5 索引 Step 2（Markdown 图谱解析 + 边表写入）已落地（计划 `plans/1-4-piped-bear.md` §Step 2）：
  - 新增 `src/shared/document-graph-parse.ts`：`parseDocumentGraph` 在 NFKC 归一 + 剥零宽字符后，逐行提取 `#tag`（含 `#中文/hierarchical`、`####heading` 跳过、lookbehind 约束前导符号）、`[[wikilink]]`（含 `#anchor` / `|alias`）、普通 `[label](url)`（`![..](..)` 单独进 attachment，`![[x.ext]]` 在 wikilink 扩展后识别），可选 YAML frontmatter（`tags` 字段合入）；widget fence 在 body 中被剥除，结构化 `componentSpec / skeletonSpec` 的所有字符串叶子 join 成 `widgetText` 追加到 body 末尾，实现「widget 里的文本可被 FTS5 命中」但不污染 tags。
  - `search-engine/repository.ts` 扩展 `replaceTags / replaceLinks / replaceAttachments / resolveWikilinkTargets / listWorkspaceRoots`；indexer 在同一 transaction 里同时 upsert documents + 写三张边表，批结束后统一跑一次 wikilink target 解析（按 name / name+'.md' 回填 `target_doc_id` 与 `resolved` 标志）。
  - FTS5 改为常规表（去掉 external-content 与对应同步触发器），仅保留 `documents_ad` 删除触发器；由 indexer 在事务内显式 `DELETE + INSERT documents_fts(rowid, name, body)`，snippet/bm25 可以直接读索引内正文。
  - 新增 `document:indexDocument(path, root?, content?)` IPC；`document-engine/ipc-handler.ts` 暴露 `setDocumentWriteIndexHook(fn)`，`setupSearchIPC()` 启动时挂钩，`document:write` 成功后自动触发对应工作区的增量索引（通过 `searchEngine.findWorkspaceRootForPath` 匹配最长 root）。
  - 新增单测 `src/__tests__/document-graph-parse.test.ts` 11 条全绿：`####heading` 不漏成 tag、`ab#xy` / URL 锚点不误判、`[[bar#intro|Alias]]` anchor+alias、内部 vs 外部链接、image/video/audio/file 分类、`[[x.png]]` 提升为 attachment、frontmatter tags 合并、`＃ａｂｃ` NFKC 归一与零宽剥离、widget fence 文本进入 body 但 `"#fakeTag"` 不污染 tag 列表。`npm run typecheck` 通过。

- `2026-04-21` 全局搜索 FTS5 索引 Step 1（schema + 索引基建）已落地（计划 `plans/1-4-piped-bear.md`）：
  - Migration 026 新增 `workspaces / documents / documents_fts (FTS5) / tags / doc_links / doc_attachments` 六张表 + 外部内容 FTS5 的三条同步触发器；FTS5 创建失败被包裹 try/catch 以兼容未编入 FTS5 的 better-sqlite3 构建。
  - 新模块 `src/main/modules/search-engine/`：`repository.ts` 封装 workspaces/documents 的 prepare 语句与手写事务，`indexer.ts` 实现 `reindexWorkspace` 分片扫描（`BINARY_EXTENSIONS` + `>2MB` + 常见忽略目录如 `node_modules/.git/dist/...`），每 500 条一批事务包裹、批间 `setImmediate` 让出 event loop；`probeFts5Availability` 靠 `sqlite_master` 查 `documents_fts` 决定是否走降级路径。
  - IPC 契约闭环：`document:reindexWorkspace` 在 `setupSearchIPC()` 注册，`setupGlobalIPC` 与既有 `setupDocumentIPC` 并列调用；preload `documentAPI.reindexWorkspace(root)` + `electron.d.ts` 的 `DocumentReindexWorkspaceResult / Response` 类型同步。
  - `document-engine/ipc-handler.ts` 中的 `BINARY_EXTENSIONS` 改为 `export`，`database.ts` 中的 `DatabaseConnection / DatabaseStatement` 改为 `export`，供 search-engine 复用。
  - 本步只写 documents 基础行（tags/doc_links/doc_attachments 留到 Step 2 的解析器），`npm run typecheck:node` + `npm run typecheck:web` 通过。

- `2026-04-21` 已修复浏览器模式下“拖拽左侧栏调宽时标签栏和原生页面错位”：
  - 根因确认在 BrowserView bounds 的双重延后，不在布局常量也不在标签栏 DOM：拖拽输入端已经由 `useRafResizeDrag` 做过一轮按帧合并，但 `useBrowserViewBounds` 又额外等了一帧，主进程 `BrowserHostLayoutService` 还会再等 16ms 才 `setBounds`，导致原生页面持续落后于假 chrome。
  - renderer 现已按 resize reason 分流：真实拖拽时直接发送 transient bounds，不再额外排入下一帧；click-toggle 等非拖拽过渡仍保留原调度路径，避免无差别放大 BrowserView 更新频率。
  - 主进程 BrowserView 宿主层现已取消 transient bounds 的二次 timer 合并，只保留相同几何去重，让 native BrowserView 和 DOM 外壳共用同一拍节奏。
  - 已新增 / 更新 BrowserView 对齐合同测试，并通过定向合同回归、`npm run typecheck:node` 与 `npm run typecheck:web`。

- `2026-04-20` 已修复 BrowserView 启动恢复 / 新建标签显示回归：
  - 问题层级确认在 renderer 的 BrowserView 重同步层，不是主进程建标签失败，也不是 BrowserView 基础 hide/show IPC 损坏。
  - `BrowserMode` 现已补回一次“延后宿主重显”兜底：浏览器模式进入稳定态后，只要主进程标签恢复完成或活动标签刚切到/新建，就会再做一轮 `fitActiveTabToBounds + visible(forceBoundsSync)`，把被提前留在隐藏态的 BrowserView 拉回前台。
  - 这次没有改 BrowserView 生命周期和标签创建链路，只补 renderer 端恢复节拍，避免把 mode switch、遮罩和 bounds 同步带出新问题。
  - 已通过 `browser-mode-startup-resync / browser-sync-visible-host-three-step / browser-host-visibility / browser-runtime-hydration / browser-state-restore` 定向回归，以及 `npm run typecheck`。
  - 同日继续修复冷启动默认页策略回归：`useBrowserRuntimeEffects` 现在会在“主进程没有真实标签 + 首次进入浏览器模式”时自动补开默认首页，只执行一次；用户后续手动关空标签页时不会被再次强行补开。
  - `TabRail` 的 starter tab 在 `loading` 阶段已禁用点击，避免用户点到假标签后才触发首页创建，造成“看起来像要点一下浏览器才开始工作”的错觉。
  - 已补齐 `browser-empty-state-bootstrap-contract` 与 `browser-unified-header-contract`，并与现有 `browser-runtime-hydration / browser-mode-startup-resync / browser-host-visibility` 一起完成定向回归；`npm run typecheck` 继续通过。
  - 同日继续优化切标签闪空：根因确认是 `BrowserMode` 把 `activeTabId` 也挂进了启动恢复 effect，导致普通切标签也执行 `hidden -> fit -> visible`，先把 BrowserView 整体藏掉一帧。
  - 现已把启动恢复和普通切标签拆开：三步流只在宿主恢复场景触发；切标签仅保留后续轻量 `fitActiveTabToBounds + visible(forceBoundsSync)` 对齐，不再先 `hideAll`。
  - 进一步确认主进程切标签顺序也会放大真空期：`BrowserTabShellService.switchTab()` 之前是先 `detachNonTargetHosts()` 再 `showHost(next)`；现在改成先 `showHost(next) + applyBounds`，随后再 detach 旧标签，让新宿主先顶上来。
  - 已新增/更新 `browser-tab-switch-visibility-contract` 与 `browser-engine-services` 单测，并与 `browser-sync-visible-host-three-step / browser-mode-startup-resync / browser-view-visibility-consolidation` 等一起完成定向回归；`npm run typecheck` 继续通过。

- `2026-04-19` 已完成主题启动白屏与昼夜切换过渡偏色双修复（计划 `plans/proud-painting-karp.md`，审计 `docs/performance/2026-04-19-theme-startup-transition-gap-audit.md`）：
  - `index.html` `<head>` 内联 bootstrap 同步落 `data-theme` + `data-skin`，不再等 IPC 才写入；`:root` 加 `color-scheme: light dark`，dark 覆盖为 `dark`。
  - Ritual overlay 换 token：引入 `--ritual-overlay-bg: var(--workbench-mode-bg)`，`ritual-overlay.css` 的 theme-transition 背景与 reduce-flash keyframe 同步迁移；过渡中途色与画布对齐（light 暖米、dark 深蓝），消灭 `#F7F9FC` 冷白一闪。
  - `main/index.ts` 非 macOS 平台按 `nativeTheme.shouldUseDarkColors` 给窗口预先定主题化 `backgroundColor`；macOS 透明 + vibrancy 不动。
  - `renderer/main.tsx` `hydrateStartupTheme` → `reconcileStartupTheme`，只在与 main 不一致时纠正 DOM；fatal error 配色跟随当前 `data-theme`。
  - `stores/useTheme.ts` 移除从未被写入的 `THEME_TRANSITION_ATTRIBUTE` 死代码。
  - 合同测试：更新 `browser-startup-theme-contract` 与 `theme-ritual-orchestration-contract`；新增 `renderer-startup-fouc-contract`；`theme-transition-backdrop-contract` 与 `theme-liquid-default` 无需改动。
  - 本轮不做项（审计 §3 其余）：SQLite↔localStorage 源收口、`setSkin` 单值化、`handleSystemChange` 动画化（被合同测试强制）、`panelResizing` 跳过路径、BrowserView mask 异常路径，各自另立计划。

- `2026-04-18` 已完成文档信息卡修改链路 `P2` 四项（Gap G / I / J / N），计划文件 `plans/starry-purring-gosling.md`：
  - `list_widgets` 输出结构化 JSON 清单（`summarizeDocumentWidgets`）：带 componentHint / preview / hasState，让 LLM 拿到清晰候选集再做定位。
  - `show-widget` fence 扩展可选 `component_spec` 字段（`tryParseWidgetPayload` / `buildShowWidgetFence` / `updateWidgetInDocument` 透传），老 widget 无该字段时解析仍返回 `componentSpec === null`，向后兼容。
  - Widget draft `targetWidgetTitle` 走受控枚举（`resolveControlledWidgetTarget`）：优先消费 `requestEnvelope.resources[widget_target]`；LLM 输出大小写/子串归一，未命中进 reprompt 错误；fallback 也首选 preferred 目标。
  - `buildDocumentPipelineInsight` 对 update 分支按目标 widget 做段落窗口化（`selectWidgetCenteredChunks` + chunk `startOffset/endOffset`），命中失败自动回退原 focused 读取。
  - `update_widget` 支持 `componentSpecPatch` 字段级合并（`mergeComponentSpecPatch`：对象递归、数组整体替换、null 视为删除）；老 widget 无 componentSpec 时给出明确拒绝文本而非静默失败。
  - 契约 & 单测：`document-list-widgets-structured / document-widget-fence-component-spec / document-widget-target-controlled-selection / document-insight-widget-window / document-update-widget-patch`；回归 `document-task-pipeline-widget-fallback / document-task-pipeline-widget-prompt / document-task-pipeline-widget-reprompt` 全绿，`npm run typecheck` 无新增错误。

- `2026-04-18` 已完成一轮 `P1` 文档信息卡修改链路结构性收口，重点是“把已有但被短路的路径连起来”而不是新增能力：
  - `DocumentTaskPipelineExecutor.tryExecute` 当前已把 `document_list_widgets` / `document_remove_widget` 两种结构化意图也路由进 `runDocumentWidgetPipeline`；list / remove 请求不再回落普通工具循环，会产出结构化步骤与诊断，并在构造 `DocumentTaskPipeline` 时注入对应 `listWidgets` / `removeWidget` deps 桥接到 renderer `document.listWidgets` / `document.removeWidget` 动作。
  - `DocumentInsight.recommendedWidget` 类型与 insight / widget 两段 system prompt 已从 5 种 info-card 字面量放开到 `documentWidgetCatalog` 全集；新增共享 `WIDGET_COMPONENT_IDS` 单一事实源，`normalizePipelineInsight` 与 `approvedWidgetComponentNames` 都从该常量派生，未来 catalog 变更无需再多点同步。
  - `pipelinePhaseOrder` 不再硬编码 create 专用 5 步；`buildPipelinePhaseOrder(taskType)` 会按 create / update / list / remove 分别派生对应 phase 序列，UI 步骤列表现在与实际发出的 phase 集合一一对齐。
  - 已新增 `executor-routes-list-and-remove-intents / pipeline-phase-order-matches-task-type / widget-catalog-recommended-widget-superset` 三份契约测试，并回归 `document-task-pipeline / document-task-pipeline-widget-prompt / document-widget-openui-describe-props / document-task-pipeline-host-contract`；`npm run typecheck` 与测试差分相对改动前零新增失败。
- `2026-04-18` 已完成 agent runtime realignment phase4 的第二轮“实质收口”，这轮不再只满足“有 adapter 文件”：
  - `skill / rss / calendar / feishu` 四个 domain adapter 现在都会从统一 `executedTools` 批次摘要里接住本轮工具结果，再由 adapter 自己生成任务卡 patch。
  - `TurnEngine` 已补通用工具结果明细：会把工具名、标准化结果、原始文本和可选 JSON 一起传给 adapter，Browser / Document 原有专项统计不回退。
  - `SkillDomainAdapter` 现已正式接住 skill workflow 的执行状态、阻塞信息、当前步骤和继续引用；skill 工具的结构化结果不再直接绕过 adapter 进入任务卡真相。
  - `RSS / Calendar / Feishu` 三个 adapter 已补最小状态机：成功会稳定输出标题/摘要/步骤，缺参数或校验失败会进入 blocked，而不是继续只剩最后一条助手文本。
  - `run-projection` 已删除 skill 专属 regex 恢复分支；skill 任务状态现在只认结构化 projection patch，不再从 `Execution ID / Current step / Blocker` 文本反推。
  - 本轮已通过 `npm run typecheck`，并回归 `turn-engine-projection / domain-adapter-contract / agent-runtime-host-contract / direct-chat-executor-routing / task-projection-truth-contract`。

- `2026-04-18` 已完成一轮 `P0` 流畅性基建收口，重点不再是“补几个动画”，而是把工作台壳层、BrowserView 跟随和主题切换的基础节奏一起改正：
  - 左侧栏和聊天栏现已改成“壳层占位 + 内容位移动画”，不再让面板组件自己持续做宽度补间；聊天栏收起后保留窄边栏形态。
  - 面板拖拽现已按帧合并宽度更新；BrowserView bounds 新增 `transient / settled` 两段同步语义，拖拽中可合并，最终落点立即精确。
  - Browser 模式切入切出不再在第一帧硬抓图；当前会优先接管最近稳定静帧，等原生层恢复稳定后再刷新缓存，减少中途闪露。
  - 主题切换已改成根节点过渡标记 + 下一帧切 DOM 主题 + 再下一帧同步原生主题的两段式流程；工作台主链路关键节点和 `tiptap.css` 已开始去掉 `transition-all / transition: all`。
  - 本轮已通过定向合同回归与 `npm run typecheck:web`，作为 P0 收口基线。
- `2026-04-18` 已完成一轮 `P1` 工作台卡顿收口，重点从“让页面看起来在动”转成“只让该动的东西动”：
  - `WorkbenchModeOutlet` 已从“四联横带一起平移”改成分层场景；四个主模式继续常驻，但只有当前页、进入页、离开页会参与过场，其余模式统一停画且保留状态。
  - renderer 新增共享窗口 resize hub；`ChatHeader`、`FilesPanel`、主 BrowserView bounds、RSS preview 不再各自并行挂原生 `window.resize`。
  - `useBrowserViewBounds` 与 RSS `PreviewBrowser` 已统一成“一帧一条变化 + 收尾一条最终落点”的同步模型；拖拽期间逐帧发 `transient`，结束后强制补 `settled`，并修正了“同几何值吞掉最终落点”的去重问题。
  - 文档标签、RSS 列表/预览、聊天输入/消息、文件树这些工作台热路径已清掉 `transition-all`，不再把 `width / min-width / flex` 这类布局属性误带进动画。
  - 已新增 `workbench-window-resize-contract` 与 `workbench-hot-path-transition-contract`，并更新 keep-alive / browser resize contracts；`npx tsx@^4.19.2 --test src/__tests__/workbench-keep-alive-contract.test.ts src/__tests__/browser-resize-stability-contract.test.ts src/__tests__/browser-host-visibility-contract.test.ts src/__tests__/workbench-window-resize-contract.test.ts src/__tests__/workbench-hot-path-transition-contract.test.ts src/__tests__/chat-panel-collapsed-rail-contract.test.ts src/__tests__/side-panel-waterfall-contract.test.ts` 和 `npm run typecheck` 已通过。

- `2026-04-18` 已完成一轮 `P3` 面板内容动效收口，重点从“分段表演式瀑布切换”改成“整块内容轻量交接”：
  - `SidePanel` 与 `ChatPanel` 现已统一改成单层 `transform + opacity` 过渡，不再把 header / body 拆成两段纵向滑入，也不再使用 `clipPath`、`translateZ(0)`、`backfaceVisibility` 这类额外合成层提示。
  - 左右面板的内容交接现已统一为串行等待，不再让离场层和入场层在同一帧重叠驻留；重内容面板切换时的双层合成压力被一起压掉。
  - renderer 新增共享 `panel-motion` 常量，`SidePanel`、`ChatPanel` 与 `WorkbenchMode` 的等待时长已回到同一节奏，壳层不再比内容切换多挂一截。
  - `side-panel-waterfall-contract` 与 `chat-panel-waterfall-contract` 已改成锁定新单层结构；Browser host visibility / resize stability / icon alignment 回归继续通过，确保这轮没有把 BrowserView 跟随链路带回旧问题。

- 已完成一轮针对 `CC-Source` 的 Claude Code agent 对照研究，并新增四份文档沉淀架构研究、交叉缺陷分析、目标设计与分阶段整改路线；后续 agent 整改将以这四份文档为统一底稿，而不再继续只靠零散口头判断推进。
- agent runtime realignment phase4 已完成第一轮 domain adapter 收口：`TurnEngine` 不再继续硬编码 Browser / Document 的专属执行分支，六个域已统一接入同一套 adapter 生命周期，`task-execution-router` 也已回到只负责 route 解析。

- 已补齐统一任务状态/恢复记录/任务投影的类型契约，后续阶段不再需要各长一套字段。
- 运行时恢复现已正式接入工具循环：限流、模型超时、上下文过长会先走恢复，再回到原有协议降级。
- 工具超时已统一进入主分发层，超时型工具结果不再直接打崩整轮执行。
- 工具并行策略已从白名单切到粗粒度资源域分组，并行上限默认收口为 `5`。
- agent runtime realignment phase2 已落地第一版：新增 `ToolRuntime` 接管工具批执行真相，allowlist、分组调度、超时恢复、cleanup 与结果归一化不再散在主循环里。
- 工具结果契约已升级为结构化 `ToolExecutionOutput`，主链现在统一消费 `text / shape / data / projectionPatch / interactionHint`，旧字符串工具结果会自动包装兼容。
- `ExecutionLoopOrchestrator` 现已缩责：模型请求恢复与 fallback 还留在这里，但工具批执行本身已改为委托 `ToolRuntime.executeBatch()`。
- `direct-chat` 里 Anthropic / OpenAI / 文本桥接三条工具结果后处理已收成共享逻辑，预算、文档/设计状态、interaction state 与 `tool_result` 回写不再各写一套。
- 默认预算已开始按任务类型分层，主控和运行态事件也开始透传任务类型、交互状态、预算占用和恢复记录。
- `TaskTypeResolver` 已接入主链第一版：低信号通用问题会优先直答，浏览器/文档/跨域任务会走不同执行路径。
- `task_projections` 轻量任务看板层已落地到主进程数据库：scope run 摘要会同步写入独立任务投影，不再只能存在运行时内存里。
- 主进程 / preload / renderer 的任务投影读链已经打通：当前会话可通过正式 IPC 读取最近任务投影。
- Ready 右侧 `TaskPanel` 已开始消费任务投影，能直接展示任务类型、当前状态、预算进度、自动恢复记录和最近步骤。
- Ready 右侧 `TaskPanel` 也已经能直接从任务投影生成继续/重试草稿，最近任务恢复入口不再只在聊天区里。
- 聊天区任务卡也已并入任务投影补充字段：当前任务与持久任务都会带出任务类型、交互状态、预算占用和恢复提示。
- 聊天区任务卡现在也会用任务投影兜底 continuation / resumableActions，旧摘要不完整时仍能继续任务。
- 第二阶段收口本轮已补上稳定 `taskId`：`RunCoordinator -> execution host -> run projection -> task projection -> continuation 草稿` 现已统一按任务主键串联，`runId` 回到“单次执行实例”语义。
- `TaskTypeResolver` 现在不再只是打标：新增正式执行路由层后，`direct / tool_loop / planner / domain_executor / continuation` 五条执行链已经能直接驱动主循环。
- 三层预算本轮已开始进入真实运行态：任务预算、步骤预算、单轮消耗、`70/90/100%` 预警、只读轮次退还、暂停冻结与恢复继续都已有正式字段和主链写回。
- `TaskPanel` 与聊天任务卡本轮已补显示当前步骤预算、预算预警和降级原因；继续/重试草稿也会显式带上 `Task ID`，前台恢复入口不再靠会话猜测。
- 本轮继续把 7 个剩余缺口往主链里收口：`skill` 已正式进入意图识别与任务路由；文档深读后制卡只会在 document executor 路径下触发，不再作为长期前置特例漂在主循环外。
- `RunCoordinator -> execution host -> DirectChatEngine` 现已开始透传统一 `TaskBudgetRuntime`；旧 `budget / budgetState` 仍保留兼容，但主链诊断与任务投影已经能读到当前任务预算、步骤预算和 warning level 的单一真相。
- continuation 入口已不再强依赖“继续/恢复”关键词：显式 `Task ID` 会优先命中任务投影恢复；恢复或宿主不可用时也会把降级原因与恢复记录显式写回任务诊断。
- phase6 的 continuation 收口已补完最后一段：控制行现在按原始用户文本清洗，bootstrap 前缀不会被压平；`session-continuity` 也已切到 task-keyed snapshots，同一 scope 的多个待继续任务不会再互相覆盖，turn engine 不再回写 continuation 控制文本来补 prompt。
- 恢复策略本轮补齐了 `350ms -> 8s` 的指数抖动退避元数据，并在出现恢复记录或预算进入 warning 后把后续工具批次自动降为串行，避免继续并行放大抖动。

1. 当前基线是本地 `main`。

- 本地相对 `origin/main` 为 `ahead 130`。
- 这条基线已经吸收了 agent/runtime 拆分、browser service 化、repository 基线拆分、module handler 独立化、RSS runtime 与 browser-backed acquisition 的主要改动。

2. Browser 主线已并回 `browser-4-3` 的新功能与新改进。

- 浏览器主进程新增 capability / content-task / task-persistence 三层：支持结构化提取、滚动采集、研究任务、批量下载与任务续跑。
- 浏览器工具链已补齐与这些能力对应的 agent 工具入口，主进程数据库也新增浏览器任务持久化表。
- 浏览器标签切换现已加入顺序保护，快速连续切换时只会采纳最后一次完成结果。
- 标签重排已打通 preload -> main -> renderer 的完整链路，不再只是前端假排序。
- 浏览器标签栏、地址面、refresh dock、收藏入口、拖拽保护与宽度预留都已顺着现有 unified header 结构补齐。
- 窗口重建后的 BrowserView host 可重新绑定到新窗口；站点权限也已收口为“低风险自动放行 + 高风险询问”。

3. **Browser 模式切换体验已进一步打磨（冻结帧机制）**

- 修复了切换时"标签栏先出、内容后加载"的分段闪现问题。
- 关键修复：`captureSnapshot` 改用 `captureViewportSnapshot`（调用 BrowserView 的 `webContents.capturePage()`），而非 `captureWindowSnapshot`（只捕获主窗口，不含 BrowserView）。
- 切换前（`!isMotionSettled`）先执行 `captureStableFrame()` 保存当前画面，再 `hideAll()` 隐藏 BrowserView。
- 过渡期间显示冻结帧（`freezeFrame ?? cachedFreezeFrame`），动画结束后 BrowserView 真正就位再淡出。
- 每个标签页独立缓存冻结帧（`cachedFreezeFramesByTabId`），切回时显示上次画面而非骨架屏。
- 最新一轮继续收紧了回场体感：冻结帧淡出已从单纯透明度升级为 `opacity + blur + scale` 复合动画，Browser surface ready 延迟也从 24ms 再压到 16ms。
- 顶栏模块切换器现已补上 hover 级预截图：鼠标悬停到 browser 图标时，会提前触发后台 `captureStableFrame()`，把"点击后才开始准备冻结帧"的迟滞再往前消掉半拍。

4. Agent/runtime 底座已经落地到可继续迭代的状态。

- `useAgent` 不再独自承担整条执行链。
- 运行态按 `runId + scopeId` 路由。
- runtime routing、message composition、module execution、scope-run patching 已拆入独立模块。
- AI 能力控制现已开始从“provider 兼容开关 + 主循环内零散特判”过渡到“正式能力分组 + 运行前解析”：
  - 新增 capability group 真相层，固定收口 `browser_interaction / browser_content_tasks / document / rss / calendar / skills / memory / session_recall / channel_feishu / system_host / design_reserved`
- `ToolGateway` 已升级为正式分组注册表，不再只是元数据目录
- `buildExecutionToolState` 已开始消费 capability resolution，把浏览器分组暴露、飞书环境可用性和宿主内部能力边界显式化
- 新增 `run-capability-controller`：`direct-chat` 现在改为消费运行前 capability 结果，不再自己重复拼 allowlist、环境判断和宿主捷径前置分支
- 新增 `host-capability-dispatcher`：openclaw 与文档 deterministic 直通已迁出主循环，`system_host` 正式只走宿主快捷执行
- `ToolGateway` 已补上 dynamic source / group schema 查询；`skills` 组现在同时覆盖 execution control 和运行期可枚举 skill action
- AI 设置页已接上主进程 capability runtime snapshot，当前状态不再靠 renderer 轻量推断
- 最新一轮继续补齐了浏览器工具丢失排障链：浏览器 schema 已从执行器模块剥离成纯目录，运行态会记录每轮真实工具快照和逐组解析诊断，文本桥接降级也改成单轮生效；当浏览器组可见但最终名单里没有 `browser_*` 时，主链会直接中止而不是继续把假名单发给模型

5. Browser 主干已经完成第一轮架构收口。

- main-process browser 逻辑已拆成 shell、lifecycle、preview、automation、data、diagnostics、download、session policy、layout 等 services。
- renderer 侧 browser shell、layout、diagnostics entry 已从页面容器中拆出。
- preview/context-menu/browser overlay 相关层级问题已处理过一轮。

6. Repository 基线已经建立。

- browser/chat/rss/calendar/settings/agent 的主要访问路径已不再依赖旧式跨域 `getDatabase()` 直连。
- 之前的 `database.ts` 静态/动态混合导入告警已清掉。

7. Workbench 模块已进入统一执行模型。

- rss/calendar 的 agent handler 已从页面组件中拆出。
- browser/RSS/calendar 都有基础 diagnostics panel。
- browser/document/rss/calendar 的 tabs/chrome 已进入共享路径。
- browser / document / rss / calendar 的工作台切换已补上 keep-alive 壳层：四个主模式会在 outlet 内常驻挂载，切换不再依赖重新挂载；共享壳层现在会在常驻前提下补一层左右切页过场。
- 非活跃模式已开始进入“前台激活、后台挂起”节奏：RSS 轮询/自动刷新只在可见时运行，Calendar 的 Schedule-X 初始化延后到首次激活，RSS 预览在模式隐藏时会主动关闭原生 preview host。
- 当当前可见模式集合不含 browser 时，Workbench 壳层会统一走 `browser.hideAll()`，避免只隐藏 active host 却遗漏 preview/native overlay。
- 顶栏四模块切换器已收敛为稳定宽度，去掉了会造成视觉抖动的纵向位移；browser/rss/calendar 的工作区外轮廓和左边界也已向 document 模式对齐。
- 四模块主工作区切换已进一步收紧为混合规则：document / rss / calendar 之间继续整块横切；browser 在切出和切回时都保持原位不动，只让其他页面横向盖上来或滑走露出它。
- Workbench 切换前不再同步等待截图完成才开场，而是优先复用稳定画面缓存；连续快速切换也会记住最后一次目标，不再把中途点击直接吞掉。
- 工作台切换时长也再收紧了一档，普通页面切换会比上一轮更利落一些。
- BrowserMode 重新显示原生 host 的逻辑已加上 RAF 取消与 `hideAll()` 收口，避免切离 browser 后被延迟回调重新抬回前台；RSS 在 liquid-glass 下恢复了可见的圆角 outline。
- BrowserMode 的“surface ready” 延迟回显现已补上定时器清理，避免刚切走 browser 时旧定时器又把冻结层提前放掉，减少回场时的半拍补出与跳层感。
- 已撤回“真实双层页面切换”和“整块浏览器壳层遮住”的激进方案，回到更稳的单层过渡路径，避免普通模块切换进一步变卡以及浏览器整块消失。
- 浏览器回场时现在只会暂时收起顶部浏览器栏，不再把整块浏览器区域一起藏掉，用更小范围的遮挡去压低“顶部先露出来”的分段感。
- Browser 运行态现已补上“首次准备、后续复用”路径：已有 tab 会尝试后台预热恢复，后续切回 browser 不再每次都重走完整冷启动准备链。
- Browser 回场新增“提前露出”时机：browser-enter 过场还没完全收口时，原生网页已经可以在离场覆盖层后面先就位，减少“动画播完网页才到”的慢半拍。
- 顶栏四模块滑块现已拆成两种手感：点击切换用短促直达动画，拖动释放才走 spring 回弹，顶部控件不再和主内容一起拖泥带水。
- WorkbenchModeOutlet 现在会主动预热四个主模式的代码分块，尽量把首次切换时的补载等待前移。
- 顶栏四模块切换器已进一步退回普通按钮组，不再依赖 gooey segmented control；主进程隐藏态下也会跳过 BrowserView bounds 回写，进一步降低原生视图抢前台风险。
- BrowserMode 顶部浏览器 chrome 已从 “`BrowserTabBar + BrowserAddressBar` 两层结构” 收口为单层 `BrowserHeader`：左侧 refresh dock 支持 hover reveal，激活标签改为可展开地址面，右侧工具按钮独立收口。
- 浏览器右上收藏 / 下载 / 更多已切到主进程 native utility menu：renderer 不再通过 `activePanel` 拉起 `BrowserSidePanel`，`useBrowserViewBounds` 也不再把这类瞬时菜单当成布局变化源，点击按钮不会再把网页内容横向或纵向推移。
- Browser cold start / renderer reload 的 host 恢复链路已补齐：空态也提供可测量 `contentRef`，renderer 会先 `browser.getTabs()` 恢复主进程 tabs，再 `await sendBoundsImmediate()` 后才 `showActive()` / `createTab()`，避免默认 `800x600` host 抢跑导致的边界不自适应。
- BrowserView bounds 现已改为在布局变化时立即落位，不再经过额外的主进程延后批处理；拖拽左侧面板或右侧聊天栏时，顶部标签栏与底层网页区域更容易保持为同一整体。
- renderer 侧 browser bounds hook 也已去掉对细小拖拽位移的跳步忽略，并在拖拽及宽度切换后的短窗口内持续做逐帧跟随，进一步压低边界错位和尾部抖动。
- preload/main 之间的高频 browser bounds 更新现已改成 fire-and-forget 单向同步，拖拽面板时不再为每一帧等待 IPC invoke 往返，浏览器内容区的跟随路径更短。
- BrowserMode 的拖拽冻结方案已从“冻结内部网页视口”切到“冻结整块浏览器区域可见画面”：拖拽时直接覆盖当前浏览器区域截图，顶部、圆角和内容来自同一张画面，避免继续在边角上出现白块、缺角或反向咬口。
- 文件管理顶部“筛选 / 更多”菜单已从左侧栏内部节点改为顶层弹层渲染：菜单仍贴着左栏按钮展开，但不再被 `SidePanel` 的 `overflow-hidden` 裁掉，也不再靠隐藏浏览器内容来制造层级。

8. RSS 已经具备独立维护条件。

- packaged/runtime RSSHub 可观察、可修复、可诊断。
- route diagnostics 和 benchmark 结果会持久化。
- browser-backed acquisition 已切到优先复用应用内浏览器路线。
- 微博 / 抖音 / 小红书现已进一步收口到浏览器主链：不再把这三类来源视为 RSSHub 必需来源，刷新失败时会直接给出“去浏览器登录 / 继续验证 / 查看页面”的引导动作；当判断为登录或扫码验证时，RSS 会直接弹出确认框引导跳转。
- 单源刷新语义、`lastFetchInvocation` 诊断、preview 关闭覆盖 RSS 面板 bug 都已收口。
- B 站单源刷新已补上“旧接口误判”收口：当上游只返回陈旧列表时，系统会优先尝试应用内浏览器；若浏览器实际落在未登录空页，会明确提示先登录，不再静默写出“无新增”。
- B 站最新一轮又补上“抓取顺序”修正：优先读取最新投稿 feed，再退回旧的合集备用结果。实测 `946974` 已从之前停在 `2026-01-06` 改为可拿到 `2026-03-31` 的最新视频。
- B 站浏览器补救结果的展示也已收口：会自动补齐播放量和完整发布时间，并把列表次信息改回“账号名 → 播放量 → 完整时间”的顺序，避免统计串挤进摘要。
- RSS 新增“底稿仓库 / 界面收件箱”双层模型：长期底稿不再随着界面清空而被删除，RSS 页面只展示当前收件箱内容和保留中的收藏。
- RSS 设置页已补上底稿仓库管理入口，可查看每个源的底稿数量、收件箱数量、收藏数量，以及当前是“首次完整”还是“后续轻量”刷新方式。
- 小红书刷新已开始按源状态分流：首次抓取仍负责补齐历史，后续刷新改成更轻的主页检查模式，并只把真正新增的内容重新送回界面列表。

9. Skill runtime 已完成 Claude workflow 执行底座升级（2026-03-15）。

- 新增 `skill-execution-types.ts`、compiler / loader、execution state store、execution coordinator、prompt builder。
- embedded skills 已拆分为 `workflow / advisory / direct` 兼容模式：
  - `video-copy-analyzer`：workflow
  - `video-expert-analyzer`：workflow
  - `lets-go-rss`：advisory + direct runtime utility
- 新增 `skill_get_state / skill_submit_input / skill_submit_confirmation / skill_submit_agent_result / skill_restart_from_step / skill_cancel_execution`
- 新增 `system_run_embedded_python`
- skills center 已新增 Recent Executions 和 blocker 继续入口
- direct-chat 已加入视频输入下的 skill/python tools 保留策略，以及 OpenAI tool history repair

10. Browser-agent 主链已开始进入统一运行时阶段（2026-04-08）。

- 新增 `browser-task-planner`，浏览器任务识别与连续性合流不再只从 `direct-chat.ts` 内部推进。
- 新增 `agent-runtime-adapter / page-state-service / evidence-service`。
- `BrowserAgentRunner` 已开始复用统一页面身份与统一证据判断。
- 浏览器任务现在可输出结构化 task payload，并映射为 `scopeRunEvent` 的显式任务字段。
- renderer 侧 `scopeRunState` 已支持优先消费浏览器结构化任务字段。
- 最新一轮继续补上了“短期连续性 + 诊断收口”：
  - 最近浏览器工作流会记录 `canResume / lastFailureReason / lastEvidence`

11. 文档“先读再制卡”链路已落下第一版结构化执行（2026-04-16）。

- 新增 `document_read_then_widget_create` 结构化意图，像“先阅读当前文档，再做一个信息卡”这类请求开始从通用单轮聊天链中分流。
- 现在由 `DocumentTaskPipelineExecutor + DocumentDomainAdapter` 接管文档制卡主线：读取活动文档快照、生成 `DocumentInsight`、再生成 `componentSpec` 并用现有文档工具确定性写回；`DirectChatEngine` 不再持有这条链路的入口和共享缓存真相。
- 新增 `document_read_then_widget_update` 结构化意图；像“把这个信息卡改成极简风格”这类请求现在会进入结构化文档链路，而不是掉回自由工具循环。
- renderer 文档模块新增 host-only `document.inspectActive`，主进程第一次能直接拿到当前活动文档全文，而不再只能依赖 1200 字上下文摘要或已落盘路径。
- 两轮模型请求现在有独立阶段超时，文档深读场景不再完全受 simple request 默认 45 秒限制。
- 同一会话内已补上 `DocumentInsight` 短期缓存：相同文档内容和相同问题重复触发时，会直接复用上次提炼结果，不再重新跑第一轮 insight 生成；共享缓存和 draft 缓存现已迁到 `DocumentTaskPipelineExecutor` 统一持有。
- 已补上 `document-sectioning` 深读前置：长文档现在会先按章节/段落切块，再挑最相关的片段进入 insight 阶段，第一轮不再默认整篇截断后硬塞给模型。
- 文档 pipeline 现已支持“部分成功先返回”：若卡片阶段或保存阶段失败，前面已完成的 insight / widget draft 不会丢，用户仍能先拿到可继续推进的结果。
- 当 draft 判定为 `update_existing` 时，流水线现在会先定位目标信息卡，再走 `document.updateWidget`；如果找不到目标，会明确阻塞，不会再静默退化成追加新卡。
- `document-engine` 深读热路径已先改成异步读取：`readDocxRawText` 与 `readDocumentEditableText` 不再同步读文件，先把 pipeline 常用读取路径的主线程阻塞风险压下一层。
- 文档 pipeline 当前阶段文案已开始带可见指标：会显示本轮共拆多少段、使用多少段、是否命中缓存，现有任务卡不用进日志也能看到这轮深读是怎么跑的。
- 文档深读指标现已进入正式 `executionDiagnostics.pipeline.document`，前台状态层和 TaskPanel 都能稳定读到，不再只靠自然语言摘要硬猜。
- 文档主进程另外四条高频读取入口也已跟进异步化：`document:read / document:list / document:parseDocx / document:parseXlsx` 不再继续同步读大文件。
  - `BrowserPageState` 已补齐 evidence / risks / continuity 摘要
  - 浏览器结构化任务现已补上 `blockedReason / taskContinuation / recentEvidence`
  - Browser 模式页内新增轻量 diagnostics dock，可直接看到当前任务、页面状态、最近失败和继续/重试/回到目标页入口

11. Agent 主控拆层已开始进入“Run Coordinator + Run Projection”阶段（2026-04-09）。

- 新增 `run-coordinator`：`runtime.sendScoped` 与 channel inbound 执行开始统一走单轮执行 owner，而不再由 `runtime.ts` 直接内联 prompt assembly + orchestrator 调用 + outcome 写回。
- 新增 `run-projection`：`ScopeRunSummary` 的聚合与浏览器/skill 文本推断已开始从 `runtime.ts` 抽离。
- `ClaudeSdkOrchestrator` 已补上 `executeAndCollect` 合同，作为 direct-chat 的 execution host bridge。
- `DirectChatEngine` 已开始复用 `execution-tool-policy`，把 tool visibility / dispatch 决策从主循环主体里抽出第一层。
- 最新一轮继续把域内 loop helper 往外挪：
  - 新增 `document-domain-helpers`，文档章节改写 / 格式整理 / 安全写回 helper 不再堆在 `DirectChatEngine`
  - `document-tool-flow` 已接管文档 inspection / mutation / save 的结果判读 helper
  - `BrowserDomainOrchestrator` 已接管浏览器 tool loop 的步骤推进、检查点提醒和超限总结
  - 新增 `provider-runtime-resolver`，OpenAI 通道的接口选择、推理强度与文字工具桥接切换判断不再内联在 `DirectChatEngine`
  - 新增 `DocumentToolLoopOrchestrator`，文档工具循环里的补提醒、inspection 回显和完成判定开始正式收口
  - 新增 `DesignToolLoopOrchestrator`，设计工具循环里的主版式去重和结果收口开始正式收口
  - `DocumentDomainOrchestrator` 已真正接入主链，文档模式下的格式整理 / 章节改写不再只是旁边放着的 helper
  - `RunCoordinator` planning 阶段已开始直接输出正式任务标题和摘要
  - `BrowserDomainOrchestrator` 已继续接管 browser tool loop 的计划文案与迭代预算建议
  - 文档 deterministic flow 完成时已开始输出正式结构化任务字段，前台任务卡不再只能靠自然语言总结去猜
  - 文档与设计工具循环在“阻塞 / 完成”关键节点也已开始主动输出结构化任务字段，第四阶段继续往正式 projection 靠拢
  - 新增 `execution-intent-resolver`，执行前的任务判断与工具规则开始正式收口，并修正浏览器工具可见性的判断时序
  - `BrowserDomainOrchestrator` 已继续接管浏览器提示词细化与确定性执行，主循环进一步减少对浏览器执行器的直连
  - 新增 `skill-context-orchestrator`，显式 skill 命中、视频下保留工具、技能工具可见性和 skill 上下文注入开始正式收口
  - OpenAI 请求主链已迁到 `openai-execution-client`，主循环不再内联持有这整段 OpenAI 请求与响应解析逻辑
  - 已补回 Kimi Coding 带工具请求的 `User-Agent`，并补上“用 xxx”这类常见中文 skill 命中回归测试
  - renderer 侧已补上文档/设计任务卡展示回归测试，正式 task projection 已不再只停留在主进程与状态层
  - 已新增 Stage 5 预备文档，先把共享 iteration budget、并发非交互工具、context compression、provider fallback 统一化的入口和边界讲清楚
  - Anthropic 请求主链已迁到 `anthropic-execution-client`，Kimi Coding 请求与视频上传已迁到 `kimi-coding-client`
  - 视频提帧回退已迁到 `video-fallback-service`，`DirectChatEngine` 不再内联持有 ffmpeg 查找与视频拆帧逻辑
- tool 执行上下文现在统一通过 `tool-runtime-context-builder` 组装，主循环不再在多个分支里手写局部上下文对象
  - 浏览器连续性注入、澄清短路、deterministic/tool-loop 分发与 fallback 文案现已通过 `BrowserDomainOrchestrator.resolveExecutionDispatch` 统一收口，浏览器域只剩固定分发挂在主循环上
  - 主进程结构化任务白名单已补进 `skill`，skill 正式任务状态现在也能走和 browser/document/design 一样的前台通路
  - 阶段 5 已开始落地：新增 `run-budget-policy`，`RunCoordinator` 现在会给单轮执行补上统一预算 seed，并把预算状态带进 execution host
  - 浏览器 / 文档 / 设计三条子域已开始返回 budget hint，只建议多留预算，不再各自偷持预算
  - 新增 `context-compression`，prompt 侧已开始对超长历史做压缩并回传 compression report；前台 structured task truth 维持不变
  - 新增 `execution-fallback-policy`，OpenAI / Kimi / 视频提帧回退开始走共享 fallback contract，不再各自散着判断
  - 新增 `tool-parallelism-policy`，安全的只读工具现在可以按批并行执行，结果仍按原顺序回收
  - 预算状态已继续接进 execution host：单轮迭代数、工具调用数和并行批次会在执行过程中累积
  - 前台状态层已开始保留 compression / budget / fallback 这类次级诊断信息，但不会覆盖任务标题和任务摘要
  - 一轮执行结束后，现在也会写回本轮实际消耗的 budget 使用结果，不再只有 planning 时的 seed
  - Anthropic simple 请求里的视频提帧回退也已并回 client，不再留在主流程里额外判断
  - 浏览器 / 文档 / 设计三条子域给出的 budget hint 现在会真正被主流程消费，不再只是定义了接口但没人使用
  - 当本轮剩余工具额度不够时，主流程现在会在边界处停下并给出预算已达上限的收尾提示，不再继续半截执行
  - Kimi simple path 的 `Kimi -> Anthropic-compatible` 回退链也已并回 execution client，主流程不再私留这条简单路径小路
  - planning / done 两头现在都会输出同一套 fallback 诊断字段：`happened / kind / attempts`
  - 当当前工具批次已经把预算打满时，主流程会在本轮末尾直接停住，不再继续请求下一轮模型响应

12. 跨会话搜索 / 回看主链第一版已落地（2026-04-12）。

- 会话原始真相继续使用 `chat_conversations / chat_messages`，没有新造第二份 transcript 存储。
- 会话层已补上 `parentConversationId / lineageRootId / resumeTitle`，为后续 continuation / recall 归并立好骨架。
- 新增 `chat_messages_fts / session_recall_metadata / session_recall_attachment_index` 三层索引，历史会话现在可按消息正文、标题、任务摘要、附件名检索。
- 新增 `session_recall_vectors`，历史会话现在会为会话胶囊生成本地持久化向量，`session_search` 会在关键词命中之外追加向量相似度补召回。
- 主进程新增 `searchSessionRecall / listRecentSessions / getSessionRecallCapsule / attachSessionRecallContext / detachSessionRecallContext / resumeSessionCandidate`。
- 新增模型工具 `session_search`，无 query 返回最近会话，有 query 走历史会话搜索；默认排除当前 scope 所在 lineage，并把 `semantic` 命中并回结果。

13. Agent runtime realignment phase4 已完成 domain adapter 接线（2026-04-17）。

- 新增统一 `DomainAdapter` 合同，Browser / Document / Skill / RSS / Calendar / Feishu 六个域现在都通过 `shouldHandle / prepare / dispatch / applyResult / buildProjectionPatch` 五段生命周期接入主链。
- `TurnEngine` 已改成“先 resolve route，再选 adapter，再走 prepare/dispatch/applyResult/buildProjectionPatch”的单一路径；Browser / Document 的域内特判不再直接写在主循环里。
- Browser adapter 已组合现有 `BrowserDomainOrchestrator`，浏览器澄清、确定性执行、tool-loop 启动、步骤推进与超限收尾继续沿用原有行为，但挂接位置已迁到 adapter 生命周期。
- Document adapter 已组合现有 `DocumentDomainOrchestrator`、`DocumentToolLoopOrchestrator` 与 `DocumentTaskPipelineExecutor`；文档格式整理 / 章节改写继续走原有 orchestrator，结构化制卡与更新链路则由 document 域直接接管，host shortcut 已移除。
- Skill / RSS / Calendar / Feishu 本轮先落薄适配：各自提供工具白名单、域内提示和任务投影模块信息，暂不额外引入新产品行为。
- `task-execution-router` 已移除 executor 级工具过滤与提示语拼装，职责收口为 route 解析；域内工具可见性现在由 adapter 在 `prepare()` 阶段给出。
- `host-capability-dispatcher` 现阶段只保留 `openclaw` 宿主快捷执行，document deterministic shortcut 不再继续挂在 host-only 特判里。
- 已新增 `domain-adapter-contract.test.ts`，并更新 `turn-engine-route.test.ts`、`direct-chat-executor-routing.test.ts`、`agent-runtime-host-contract.test.ts`，冻结 phase4 接线方式。
- 本轮验收已通过：
  - `npx tsx --test src/__tests__/domain-adapter-contract.test.ts src/__tests__/browser-domain-orchestrator.test.ts src/__tests__/document-tool-loop-orchestrator.test.ts src/__tests__/turn-engine-route.test.ts src/__tests__/direct-chat-executor-routing.test.ts src/__tests__/task-execution-router.test.ts src/__tests__/agent-runtime-host-contract.test.ts`
  - `npm run typecheck`

14. Agent runtime realignment phase5 已完成 projection 真相收口（2026-04-18）。

- `TurnEngine` 现在会把每轮真实执行过的工具批结果透传给 domain adapter；adapter 收口任务状态时优先读 `projectionPatch`，否则才读结构化 JSON 结果，不再从正文文本猜状态。
- `SkillDomainAdapter` 已补最小状态桥接：会缓存最近一次 skill 结构化 patch，在 `budget_limit / no_tool_call` 这类场景继续补齐摘要、阻塞原因和继续动作。`RSS / Calendar / Feishu` 三个 adapter 也已开始把真实工具轨迹镜像成稳定步骤与摘要，不再是空壳。
- `RunProjection` 已删除 browser / skill 的 regex 兜底；`recordEvent` 现在只按显式事件字段、projection truth patch 和上一轮状态合成，legacy `[计划]`、`[阶段]`、`Execution ID` 文本不会再重建任务状态。
- renderer `scopeRunState` 已清掉 browser / skill 旧文本解析死代码；前台继续只消费结构化任务字段，保留的 `createTaskPatchFromSkillExecutionDetail` 仅服务 `restartFromStep` 这类正式结构化入口。
- 聊天任务卡、任务面板和暂停/继续/补充信息动作现已优先按 `taskId` 匹配 projection；暂停任务不再把标题污染成 taskId。
- `Task ID / Execution ID` 那套 continuation 文本控制协议仍留在 phase6，本轮没有把它提前算成 phase5 已完成项。
- 本轮补充验收已通过：
  - `npx tsx --test src/__tests__/run-projection.test.ts src/__tests__/domain-adapter-contract.test.ts src/__tests__/turn-engine-projection.test.ts src/__tests__/scope-run-state.test.ts src/__tests__/task-projection-truth-contract.test.ts src/__tests__/direct-chat-executor-routing.test.ts src/__tests__/agent-runtime-host-contract.test.ts`
  - `npm run typecheck`
- `RunProjection` 写出的新任务摘要现在会同步持久化到 session recall metadata，不再只留在运行时内存 Map。
- `PromptAssemblyService` 已补上独立的“跨会话回看”注入段，当前 scope 显式挂入的旧会话胶囊会在当前轮进入 prompt。
- `PromptAssemblyService` 现已开始做保守自动跨会话召回：默认只在当前频道内挑 1 到 2 条高相关旧会话，自动注入到当前轮 prompt，但不写回会话引用列表。
- ChatPanel 已补上聊天内轻量入口：可搜索旧会话、引用到当前轮、显示已引用胶囊并支持移除。

## 当前最高优先级

1. ~~小红书 / 抖音 / 微博的 RSS 获取链路收尾~~（已完成）。

2. ~~工作台顶部三行视觉对齐~~（已完成）。

3. **下一阶段主线**：

- `PromptAssemblyService + L0/L1/L2 memory`（Agent 记忆系统）
- `Feishu capability replacement`（飞书能力替换）

## 当前未完成项

- Weibo/Xiaohongshu/Douyin 的“浏览器主链 + 登录引导”已完成代码收口，但仍缺最后一轮实机签收。
- Workbench 顶部三行在各模块下仍需最后一轮视觉对齐。
- Browser diagnostics 已有页内 dock，但仍不是完整 lab。
- Browser orchestration 已基本收口，剩余主要是尾部 helper 清理与阶段 5 前的边界复核。
- Browser unified header 还需要一轮实机动效与窄宽度体验微调，但结构性切换已完成。
- skill workflow 仍缺少更细的 execution UX 打磨与更多样例 skill 迁移。
- Agent 主控 ownership 虽已开始收口，但 `DirectChatEngine` 仍然偏大；document pipeline 主线已迁出，剩余主要是 browser / design / provider 组装层还要继续收口。
- 跨会话回看第一版已能搜索和回灌，但仍缺：
  - 老会话任务摘要的完整历史回填
  - 独立搜索面板入口
  - resume title 的正式用户入口与 continuation 策略
- **`PromptAssemblyService + L0/L1/L2 memory` 还未启动**（下一阶段主线）。
- **Feishu capability replacement 还未启动**（下一阶段主线）。

## 建议的继续顺序

1. ~~先做 RSS 三条源的最终签收~~（已完成）。
2. ~~再做顶部三行和 tabs 的视觉基线收口~~（已完成）。
3. **接下来回到底座主线**：
   - **`PromptAssemblyService + L0/L1/L2 memory`**（Agent 记忆系统）
   - **`Feishu capability replacement`**（飞书能力替换）
   - Agent core loop 继续把 browser/document/design 域策略从 `DirectChatEngine` 主体抽离
   - Browser orchestration 最后收口
   - Diagnostics labs 从当前 dock 继续升级完整化

## 2026-04-16 Agent Core Gap Closure（已完成）

- **Batch A：预算真值 + 取消/冻结**
  - 默认 scoped run 现在会先带 `bootstrap budget` 占位标记，等真实任务类型解析出来后再回正到对应预算档位。
  - `reserveToolCalls` 不再只是接口占位，已经会实际压缩剩余工具调用头寸。
  - 工具批执行已接入取消信号；串行工具不会在取消后继续跑下一项；冻结预算也会真正停住迭代。
- **Batch B：续跑预算恢复 + 执行器真分流**
  - continuation 现在会恢复之前已经消耗的 `iterations/toolCalls/parallel groups`，并在剩余额度过低时补最小安全余量。
  - `skill / rss / calendar / feishu` 执行器不再只是路由标签，运行时会注入专用执行指令，并收窄实际允许调用的工具集合。
- **Batch C：步骤推进 + 交互阻塞 + 运行控制**
  - 多步任务现在会维护运行中步骤，支持“模型明确宣布步骤完成”或“当前步骤额度耗尽”时推进到下一步，并记录步骤摘要。
  - 通用文本回复里出现“请补充 / 请确认 / 需要你手动完成”时，会被提升为结构化交互状态，而不再一直挂成普通运行中。
  - 新增 `agent:suspendRun / agent:resumeRun / agent:respondToInteraction` IPC 链路；`TaskPanel` 和 `ChatPanel` 的相关按钮已改为真实控制，不再只是帮用户填草稿。
- **Batch D：子任务脚手架 + 运行级资源清理**
  - `task_projections` 现已补上 `parent_task_id / parent_step_id`，child task 可以按父任务查询，并把完成摘要与产物摘要回写到父步骤。
  - `runtime.sendScoped` / `RunCoordinator` 已能透传父子任务关联，继续沿用原有单轮执行链，不额外生成第二套外层循环。
  - 新增 run-scoped cleanup registry；取消、失败或超时后，注册过的清理回调会按 run 统一收口，skill workflow 也会把未收尾 execution 挂进去。
- **Batch E：projection cleanup + 文档同步**
  - `TaskProjectionStore` 现在会持久化 `taskTitle / taskSummary / recentArtifacts`，不再只存“任务骨架”。
  - `ChatPanel` 与 `TaskPanel` 已改成优先消费 projection 真值，再回退到 scope run 摘要。
  - 协作文档已同步补齐预算、子任务、清理注册表和 projection-first 的当前口径。
- **Batch F：worker session 真隔离 + 文档多 job 子任务接线**
  - 新增 `worker-session / subtask-runtime / worker-projection`，child task 现在会生成独立 `workerSessionId + taskId`，父任务只通过 `parentTaskId / parentStepId` 关联，不再和父任务抢同一个执行会话键；`SubtaskRuntime` 现已收口为 inline worker 专用生命周期，不再对外保留未接完结果的 scoped-turn 半成品入口。
  - 文档 `DocumentTaskPlan` 的多 job 路径现已切到“父任务总览 + 每个 job 一个 child task”的正式链路；单 job 继续走原内联执行，避免无谓放大改动面。
  - `run-projection` 已修正父子任务串线时的关联继承条件：切回父任务摘要时，不会再误把上一个 child 的 `parentTaskId / parentStepId` 挂到新的 task 上。
- **Batch G：浏览器结果收口 + 最终快照同步**
  - `browser-domain-orchestrator` 已补上统一的浏览器任务结构化 payload builder；浏览器域现在会持续投影真实步骤，不再让任务卡沿用最初的 planning 标题/摘要。
  - 实时外部信息查询现已改成“浏览器证据收集 -> 宿主最终答复整理”的正式链路；天气、新闻、股价、比分等浏览器查询不再把过程播报或纠偏文本直接当成最终回复。
  - `turn-engine` 已把浏览器工具循环里的过程播报从 `finalText` 中剥离，保留在任务卡和工具轨迹；`runtimeDriver` 在收到最终 `done / error / cancelled` 事件后会再次持久化 assistant 快照，消息上的任务卡会跟随真实最终态收口。

## 最近一次有效校验

- `npx tsx --test src/__tests__/browser-domain-orchestrator.test.ts src/__tests__/turn-engine-route.test.ts src/__tests__/agent-stream-segmentation.test.ts` 通过
- `npx tsx --test src/__tests__/domain-adapter-contract.test.ts src/__tests__/turn-engine-projection.test.ts src/__tests__/run-coordinator.test.ts` 通过
- `npm run typecheck` 通过
- `npx tsx --test src/__tests__/worker-session-contract.test.ts src/__tests__/subtask-runtime-contract.test.ts src/__tests__/task-subtask-runtime.test.ts src/__tests__/document-task-plan-subtask.test.ts src/__tests__/run-projection.test.ts src/__tests__/task-projection-sync.test.ts src/__tests__/direct-chat-executor-routing.test.ts src/__tests__/task-execution-router.test.ts src/__tests__/turn-engine-route.test.ts` 通过
- `npm run typecheck` 通过
- `npx tsx --test src/__tests__/worker-session-contract.test.ts src/__tests__/subtask-runtime-contract.test.ts src/__tests__/task-subtask-runtime.test.ts src/__tests__/document-task-plan-subtask.test.ts` 通过
- `npx tsx --test src/__tests__/subtask-runtime-contract.test.ts src/__tests__/document-task-plan-subtask.test.ts` 通过
- `npm run typecheck` 通过
- `npm run typecheck` 通过
- `npx tsx --test src/__tests__/run-coordinator-budget.test.ts src/__tests__/task-budget-runtime-alignment.test.ts src/__tests__/execution-loop-parallel-tools.test.ts src/__tests__/execution-loop-cancellation.test.ts src/__tests__/task-continuation-budget.test.ts src/__tests__/task-type-resolver.test.ts src/__tests__/task-execution-router.test.ts src/__tests__/direct-chat-executor-routing.test.ts src/__tests__/task-step-progression.test.ts src/__tests__/interaction-state-detection.test.ts src/__tests__/task-run-control-ipc.test.ts src/__tests__/task-projection-repository.test.ts src/__tests__/task-projection-sync.test.ts src/__tests__/task-subtask-runtime.test.ts src/__tests__/run-resource-reaper.test.ts src/__tests__/chat-task-projection-contract.test.ts src/__tests__/task-panel-task-projection-contract.test.ts` 通过
- `npx tsx --test src/__tests__/run-coordinator-budget.test.ts src/__tests__/task-budget-runtime-alignment.test.ts src/__tests__/execution-loop-parallel-tools.test.ts src/__tests__/execution-loop-cancellation.test.ts src/__tests__/task-continuation-budget.test.ts src/__tests__/task-type-resolver.test.ts src/__tests__/task-execution-router.test.ts src/__tests__/direct-chat-executor-routing.test.ts src/__tests__/task-step-progression.test.ts src/__tests__/interaction-state-detection.test.ts src/__tests__/task-run-control-ipc.test.ts` 通过
- `npx tsx@^4.19.2 --test src/__tests__/intent-classifier.test.ts src/__tests__/task-type-resolver.test.ts src/__tests__/task-execution-router.test.ts src/__tests__/run-coordinator.test.ts src/__tests__/task-projection-sync.test.ts src/__tests__/chat-task-projection-contract.test.ts src/__tests__/task-panel-task-projection-actions-contract.test.ts src/__tests__/recovery-router.test.ts` 通过
- `npx tsx@^4.19.2 --test src/__tests__/run-coordinator.test.ts src/__tests__/task-projection-sync.test.ts src/__tests__/task-type-resolver.test.ts src/__tests__/task-execution-router.test.ts src/__tests__/chat-task-projection-contract.test.ts src/__tests__/task-panel-task-projection-contract.test.ts src/__tests__/task-panel-task-projection-actions-contract.test.ts src/__tests__/execution-loop-parallel-tools.test.ts src/__tests__/recovery-router.test.ts src/__tests__/agent-task-runtime-contract.test.ts src/__tests__/agent-runtime-host-contract.test.ts` 通过
- `npx tsx@^4.19.2 --test src/__tests__/agent-runtime-host-contract.test.ts src/__tests__/run-coordinator.test.ts src/__tests__/run-coordinator-budget.test.ts src/__tests__/execution-fallback-policy.test.ts src/__tests__/execution-loop-parallel-tools.test.ts src/__tests__/run-projection.test.ts src/__tests__/task-projection-sync.test.ts src/__tests__/task-projection-repository.test.ts src/__tests__/task-type-resolver.test.ts src/__tests__/task-execution-router.test.ts src/__tests__/task-panel-task-projection-contract.test.ts src/__tests__/openai-execution-client-contract.test.ts src/__tests__/anthropic-execution-client-contract.test.ts src/__tests__/kimi-coding-client-contract.test.ts` 通过
- `npm run typecheck` 通过
- `npx tsx@^4.19.2 --test src/__tests__/agent-runtime-host-contract.test.ts src/__tests__/run-coordinator.test.ts src/__tests__/run-coordinator-budget.test.ts src/__tests__/execution-fallback-policy.test.ts src/__tests__/execution-loop-parallel-tools.test.ts src/__tests__/prompt-assembly.test.ts src/__tests__/run-projection.test.ts src/__tests__/scope-run-state.test.ts src/__tests__/task-card-view-model-contract.test.ts src/__tests__/openai-execution-client-contract.test.ts src/__tests__/anthropic-execution-client-contract.test.ts src/__tests__/kimi-coding-client-contract.test.ts src/__tests__/video-fallback-service-contract.test.ts src/__tests__/simple-execution-fallbacks.test.ts` 通过
- `npm test` 未通过：当前工作区仍有 `browser-tab-switch-executor`、多组 document contract、以及一批 liquid shell / workbench UI contract 旧失败；本轮主控与客户端相关重点测试已通过
- `npx tsx@^4.19.2 --test src/__tests__/browser-*.test.ts src/__tests__/document-widget-openui.test.ts` 通过
- `npm test` 未通过：仍有与本次浏览器改动无关的 `workbench-liquid-shell-contract` 旧失败
- `npm run typecheck` 通过
- `npx tsx@^4.19.2 --test src/__tests__/rss-browser-acquisition.test.ts src/__tests__/rss-draft-store-contract.test.ts src/__tests__/rss-draft-store-ui-contract.test.ts` 通过
- `npm run typecheck` 通过
- `npx tsx@^4.19.2 --test src/__tests__/rss-diagnostics.test.ts src/__tests__/rss-browser-acquisition.test.ts src/__tests__/rss-scrapers.test.ts` 通过
- `npm run typecheck:node` 通过
- `npm run typecheck:web` 通过
- `npx tsx@^4.19.2 --test src/__tests__/ui-browser-hook-split-contract.test.ts src/__tests__/browser-engine-services.test.ts src/__tests__/browser-unified-header-contract.test.ts` 通过
- `npx tsx@^4.19.2 --test src/__tests__/browser-unified-header-contract.test.ts src/__tests__/browser-host-visibility-contract.test.ts src/__tests__/ui-browser-hook-split-contract.test.ts` 通过
- `npx tsx@^4.19.2 --test src/__tests__/browser-engine-services.test.ts src/__tests__/browser-tools.test.ts src/__tests__/browser-agent-runtime-contract.test.ts src/__tests__/browser-agent-evidence.test.ts src/__tests__/browser-task-planner.test.ts src/__tests__/scope-run-state.test.ts src/__tests__/agent-task-panel-contract.test.ts` 通过
- `npm run typecheck` 通过
- `npm run verify` 未通过：仍被仓库内大量与本轮无关的历史 lint 问题拦住
- `npx tsx@^4.19.2 --test src/__tests__/agent-control.test.ts src/__tests__/agent-runtime-host-contract.test.ts src/__tests__/run-projection.test.ts src/__tests__/run-coordinator.test.ts src/__tests__/browser-agent-runtime-contract.test.ts src/__tests__/browser-task-planner.test.ts src/__tests__/scope-run-state.test.ts src/__tests__/agent-task-panel-contract.test.ts` 通过
- `npm run typecheck` 通过
- `npx tsx@^4.19.2 --test src/__tests__/agent-runtime-host-contract.test.ts src/__tests__/run-coordinator.test.ts src/__tests__/run-projection.test.ts src/__tests__/browser-domain-orchestrator.test.ts src/__tests__/browser-agent-runtime-contract.test.ts src/__tests__/browser-task-planner.test.ts src/__tests__/scope-run-state.test.ts src/__tests__/agent-task-panel-contract.test.ts` 通过
- `npm run typecheck` 通过
- `npx tsx@^4.19.2 --test src/__tests__/agent-runtime-host-contract.test.ts src/__tests__/run-coordinator.test.ts src/__tests__/run-projection.test.ts src/__tests__/browser-domain-orchestrator.test.ts src/__tests__/provider-runtime-resolver.test.ts src/__tests__/browser-agent-runtime-contract.test.ts src/__tests__/browser-task-planner.test.ts src/__tests__/scope-run-state.test.ts src/__tests__/agent-task-panel-contract.test.ts` 通过
- `npm run typecheck` 通过
- `npx tsx@^4.19.2 --test src/__tests__/agent-runtime-host-contract.test.ts src/__tests__/run-coordinator.test.ts src/__tests__/run-projection.test.ts src/__tests__/browser-domain-orchestrator.test.ts src/__tests__/document-tool-loop-orchestrator.test.ts src/__tests__/design-tool-loop-orchestrator.test.ts src/__tests__/provider-runtime-resolver.test.ts src/__tests__/browser-agent-runtime-contract.test.ts src/__tests__/browser-task-planner.test.ts src/__tests__/scope-run-state.test.ts src/__tests__/agent-task-panel-contract.test.ts` 通过
- `npm run typecheck` 通过
- `npx tsx@^4.19.2 --test src/__tests__/browser-domain-orchestrator.test.ts src/__tests__/agent-runtime-host-contract.test.ts` 通过
- `npx tsx@^4.19.2 --test src/__tests__/browser-agent-runtime-contract.test.ts` 通过
- `npx tsx@^4.19.2 --test src/__tests__/agent-runtime-host-contract.test.ts src/__tests__/run-coordinator.test.ts src/__tests__/run-projection.test.ts src/__tests__/browser-domain-orchestrator.test.ts src/__tests__/document-tool-loop-orchestrator.test.ts src/__tests__/design-tool-loop-orchestrator.test.ts src/__tests__/provider-runtime-resolver.test.ts src/__tests__/browser-agent-runtime-contract.test.ts src/__tests__/browser-task-planner.test.ts src/__tests__/scope-run-state.test.ts src/__tests__/agent-task-panel-contract.test.ts` 通过
- `npm run typecheck` 通过
- `npm test` 未通过：仍被仓库内既有 `browser-tab-switch-executor` / `workbench-liquid-shell-contract` 等旧失败拦住，本轮主控拆层相关用例已通过
- `npm run verify` 未通过：仍被仓库内既有 lint 问题拦住，本轮新增主控拆层未引入新的 typecheck 失败
- `npx tsx@^4.19.2 --test src/__tests__/session-recall-service.test.ts src/__tests__/prompt-assembly.test.ts src/__tests__/chat-session-recall-contract.test.ts src/__tests__/execution-loop-parallel-tools.test.ts src/__tests__/database.test.ts` 通过
- `npm run typecheck` 通过
- `npm test` 未通过：总计 `559` 项测试里 `538` 通过、`21` 失败；失败仍是仓库内既有 `browser-active-tab-visibility-contract` / `workbench-liquid-shell-contract` 等旧问题，本轮新增会话回看链路未引入新的全量失败
- `npx tsx@^4.19.2 --test src/__tests__/browser-unified-header-contract.test.ts src/__tests__/browser-utility-menu-model.test.ts src/__tests__/browser-host-visibility-contract.test.ts src/__tests__/ui-browser-hook-split-contract.test.ts` 通过
- `npx tsx@^4.19.2 --test src/__tests__/browser-host-visibility-contract.test.ts src/__tests__/workbench-keep-alive-contract.test.ts` 通过
- `npx tsx@^4.19.2 --test src/__tests__/browser-host-visibility-contract.test.ts src/__tests__/workbench-keep-alive-contract.test.ts src/__tests__/workbench-shell-alignment-contract.test.ts src/__tests__/topbar-gooey-segmented-control.test.ts src/__tests__/workbench-icon-alignment-contract.test.ts` 通过
- `npx tsx@^4.19.2 --test src/__tests__/browser-resize-stability-contract.test.ts src/__tests__/browser-host-visibility-contract.test.ts` 通过
- `npx tsx@^4.19.2 --test src/__tests__/workbench-keep-alive-contract.test.ts src/__tests__/browser-startup-theme-contract.test.ts src/__tests__/workbench-slider-motion-contract.test.ts src/__tests__/browser-host-visibility-contract.test.ts src/__tests__/browser-resize-stability-contract.test.ts` 通过
- `npx tsx --test src/__tests__/floating-submenu-style-contract.test.ts src/__tests__/chat-header-menu-style-contract.test.ts` 通过
- `npm run typecheck:web` 通过
- `npx tsx@^4.19.2 --test src/__tests__/skill-compiler-smoke.test.ts src/__tests__/skill-resolver-smoke.test.ts` 通过
- `python3 -m py_compile` 已校验新 wrapper 脚本语法
- `npm test` 通过，最近一次全量通过为 `173` 个测试
- `npm run build` 通过

## 最新研究

- 2026-04-12：已补齐 Hermes memory 路线第一轮研究文档。
- 新增 `docs/superpowers/specs/2026-04-12-hermes-persistent-memory-design.md`，单独梳理 Hermes 的 built-in memory、`memory` 工具、provider 扩展和 session recall 边界。
- 新增 `docs/superpowers/specs/2026-04-12-hermes-vs-ready-memory-cross-comparison.md`，逐项对照 Ready 当前 `memory / reflection / trigger / session_recall` 主链与 Hermes 的真实差异。
- 新增 `docs/superpowers/plans/2026-04-12-ready-memory-alignment-roadmap.md`，把后续路线收敛为“先拆边界，再做 resident core，最后接 provider”的阶段计划。
- 当前已明确：Ready 记忆路线的首要问题不是功能不足，而是 resident memory、session recall、task memory、trigger rule、external provider 这些层还没有被正式拆开。

## 体积基线

- 仓库总大小：`2.7G`
- `logs`：`1.0M`
- `out`：`24M`
- `dist`：`924M`
