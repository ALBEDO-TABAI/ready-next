# Ready 开发文档

> 更新时间: 2026-04-18

## 1. 架构概览
Ready 采用 Electron 三层架构：
- Main：窗口、协议、IPC、数据库、BrowserView、技能运行时、各模块引擎
- Preload：白名单 API 桥接
- Renderer：React UI、状态管理、交互壳层
- Shared：跨进程共享类型、AI 供应商配置与能力解析

核心数据流：
`Renderer UI -> preload(electronAPI) -> main IPC -> DB / FS / BrowserView / runtime`

## 2. 工作台模式
`useMode` 当前维护的子模式：
- `browser`
- `document`
- `rss`
- `calendar`

入口壳层：`src/renderer/pages/WorkbenchMode.tsx`

状态归属补充：
- 工作台双模式分栏比例由 `useMode.workbenchSplitRatio` 管理
- 文档页双栏分屏比例由 `useDocTabs.documentSplitRatio` 管理
- 两者不是同一份状态，不要跨用

## 3. 主模块说明
### 3.1 Browser
- 前端：`src/renderer/pages/modes/BrowserMode.tsx`
- 后端：`src/main/modules/browser-engine/*`
- 说明：多标签、BrowserView 边界管理、历史/书签/下载、右键菜单、popup policy

### 3.2 Document
- 前端：`src/renderer/pages/modes/DocumentMode.tsx`
- 后端：`src/main/modules/document-engine/*`
- 说明：多格式读取、编辑文本抽取、`document_*` 工具
- 文档页自己的双栏分屏状态保留在 `src/renderer/stores/useDocTabs.ts`

### 3.3 RSS / Calendar
- RSS：`src/renderer/pages/modes/RSSMode.tsx` + `src/main/modules/rss-engine/*`
- 微博 / 抖音 / 小红书已统一按应用内浏览器主链抓取；失败时优先引导回 Ready 浏览器处理登录态或验证，不再走 RSSHub 回退
- Calendar：`src/renderer/pages/modes/CalendarMode.tsx` + `src/main/modules/calendar-engine/*`

### 3.4 Agent / Skills / Remote IM
- Agent：`src/main/modules/claude-bridge/*`
- 会话与远程通道：`src/main/modules/agent-control/*`
- 工具：`src/main/modules/tools/*`
- 技能运行时：`src/main/modules/skills-runtime/*`
- Python sidecar：`src/python/ready_sidecar/*`

### 3.4b Agent 主控当前分层
- `AgentControlRuntime` 当前已进一步回到 control plane 角色：
  - scope / conversation / channel / cron 宿主
  - runtime health / heartbeat
  - summary store 宿主
- `RunCoordinator` 负责单轮执行：
  - prompt assembly 接入
  - execution host 调用
  - 成功 / 失败 / 记忆回写收口
- `RunProjection` 负责把执行事件投影成 `ScopeRunSummary`
- `BrowserDomainOrchestrator` 继续吸收浏览器域内 loop supervision：
  - 任务决策与连续性准备
  - tool loop 步骤推进
  - 检查点提醒与上限总结
  - tool loop 计划文案与迭代预算建议
- `DocumentDomainOrchestrator + document-domain-helpers` 开始承接文档域 deterministic helper：
  - 章节改写草稿生成
  - 章节 / 整篇格式整理
  - 章节定位与安全写回
- `DocumentToolLoopOrchestrator` 开始承接文档工具循环监管：
  - inspection 结果回显
  - “已改未存 / 只定位未改 / widget 结果不合格” 这类补提醒
  - 文档任务完成收口
- `DesignToolLoopOrchestrator` 开始承接设计工具循环监管：
  - 主版式去重
  - 设计结果收口
  - 完成文案生成
- `provider-runtime-resolver` 开始承接 OpenAI 通道运行时判断：
  - 走 `responses` 还是 `chat/completions`
  - 当前推理强度
  - 是否切到文字工具桥接、何时重试桥接
- `execution-intent-resolver` 开始承接执行前意图判断：
  - 这轮是否强制文档工具
  - 这轮是否允许浏览器工具
  - widget / 文档改写 / 格式整理这类规则该怎么选
- `skill-context-orchestrator` 开始承接技能前置判断：
  - 用户是否明确点名某个 skill
  - 视频输入下是否仍应保留工具
  - 当前会话应优先暴露哪些 skill 相关工具
  - skill 参考上下文如何注入当前轮
- `openai-execution-client` 开始承接 OpenAI 执行主链：
  - simple 请求
  - text tool bridge 请求
  - tools 请求
  - OpenAI Responses / Chat Completions 响应解析
- 这层同时负责当前 OpenAI 通道里 Kimi Coding 带工具请求的兼容头收口。
- `anthropic-execution-client` 开始承接 Anthropic 执行主链：
  - simple 请求
  - tools 请求
  - Anthropc message 响应解析
- `kimi-coding-client` 开始承接 Kimi Coding 专属链路：
  - simple 请求
  - 视频上传
  - video -> ReadMediaFile 包装
- `video-fallback-service` 开始承接视频提帧回退：
  - ffmpeg 查找
  - video block -> image frame fallback
- `ClaudeSdkOrchestrator` 继续作为 direct-chat 的 transport/bridge 包装层
- agent 工具暴露开始从“全量工具拼接后再局部裁剪”过渡到“先按 capability group resolve，再下发工具面”
- `DirectChatEngine` 继续作为第一阶段 execution host，但开始把 tool visibility / dispatch 之类通用策略抽出主文件

### 3.4c 2026-04-17 Agent 对照研究文档
- 本轮已补四份 agent 研究/整改文档，作为后续主链整改的统一底稿：
  - `docs/superpowers/specs/2026-04-17-claude-code-agent-architecture-study.md`
  - `docs/superpowers/specs/2026-04-17-claude-code-vs-ready-agent-gap-analysis.md`
  - `docs/superpowers/specs/2026-04-17-ready-agent-runtime-realignment-design.md`
  - `docs/superpowers/plans/2026-04-17-ready-agent-runtime-realignment-roadmap.md`
- 这四份文档的结论是：
  - 当前 Ready 最大问题不是“模块拆得不够多”，而是 execution truth、tool runtime、domain orchestration 和 projection 真相还没有稳定收口
  - 下一轮整改优先级应转向：`tool contract -> tool runtime -> turn engine -> domain adapter -> projection truth -> continuation truth`
  - `RunCoordinator / RunProjection / capability groups / BrowserDomainOrchestrator / DocumentDomainOrchestrator` 这些现有积累建议保留，不做推倒重来

### 3.5 Shared / Renderer Utilities
- 共享 URL 工具：`src/shared/url-utils.ts`
  - `getUrlHostname()` 供主进程策略判断使用
  - `getRegistrableDomain()` 供 renderer 展示与同域聚合使用
- renderer 本地存储工具：`src/renderer/utils/storage.ts`
  - 统一封装字符串与 JSON 的读写
  - 保持现有 localStorage key 与数据格式不变

## 4. AI 供应商与能力层
### 4.1 共享配置模型
统一配置定义在 `src/shared/ai-providers.ts`，目前拆成两层：
- 运行时生效配置：`AIModelConfig`
- 前台管理工作区：`AIProviderWorkspace -> AIProviderProfile[]`

`AIProviderProfile` 主要字段包括：
- `id`
- `category`
- `name`
- `builtIn`
- `showInChatSwitcher`
- `config`

`AIModelConfig` 主要字段包括：
- `provider`
- `baseUrl`
- `model`
- `agentProtocol`
- `wireApi`
- `reasoningEffort`
- `toolUseMode`
- `visionMode`
- `nativeVideoMode`

### 4.2 能力解析
所有 AI 请求都会通过 `resolveAIConfigCapabilities()` 得到统一能力视图：
- 当前走 `anthropic` 还是 `openai` 协议
- 当前走 `chat/completions` 还是 `responses`
- 当前是否支持原生 tools、视觉、原生视频
- 当前工具传输方式是 `native`、`text` 还是 `none`

### 4.3 设置页
设置页的模型配置现已收敛为四个入口：
- `OpenAI`
- `Anthropic`
- `Gemini`
- `自定义`

其中：
- 前三个是固定内置预设，各自只保留一个主预设
- `自定义` 入口允许保存多个供应商预设
- 每个预设都有 `showInChatSwitcher`，控制它是否出现在聊天区快速切换面板
- `Agent 接口 / OpenAI API 形式 / 工具调用 / 网页视觉 / 思考强度` 统一折叠到高级设置

兼容接口仍保留：
- `settings:getAIConfig` 始终返回当前激活预设对应的生效配置
- `settings:getAIWorkspace` / `settings:setAIWorkspace` 负责前台预设管理

## 5. Agent 工具调用链
### 5.0 主控循环入口
- 本地会话：`runtime.sendScoped -> RunCoordinator -> orchestrator.executeAndCollect -> DirectChatEngine`
- 远程消息：channel coalesce / scope 建立仍在 runtime，真正执行改为 `RunCoordinator.runInboundChannel`
- `RunCoordinator` 是当前单轮执行 owner；`runtime` 不再直接内联 prompt assembly + sendAndCollect + outcome writeback 这整段链路
- 现在每轮启动时都会先生成稳定 `taskId`；`RunCoordinator -> execution host -> RunProjection -> TaskProjectionStore` 已统一按 `taskId` 串联，`runId` 只保留单次执行实例语义
- 受控 child task 现在继续复用这条链：`runtime.sendScoped` 可选透传 `parentTaskId / parentStepId`，`RunCoordinator` 负责带着父任务关联启动子任务，而不是再起第二套外层循环
- `runtime.sendScoped` / `RunCoordinator` 现已额外支持 `sessionIdOverride`：子任务可以沿用原 scope 发事件与写 projection，但执行宿主会切到独立 worker session，不再和父任务共用同一个 `agent + scopeId` 会话键
- `worker-session.ts` / `subtask-runtime.ts` 现已作为正式 child run 底座：子任务永远使用自己的 `taskId` 做 projection identity，父任务只通过 `parentTaskId / parentStepId` 建关联，不再复用父任务 id
- `worker-projection.ts` 现已统一产出父步骤等待态、child 占位摘要和 child 完成回填补丁；前台继续沿用现有 `scopeRunEvent + task projection` 通道，本期没有新增第二套 renderer 事件链
- 阶段 5 第二轮已落地：`RunCoordinator` 现在会为每轮执行创建统一任务预算，并把 `budget / budgetState / taskId` 一起传给 execution host
- execution host 当前已开始累积 `iterationsUsed / toolCallsUsed / parallelToolGroupsUsed`，并能带回步骤预算、预算预警和降级原因
- 浏览器 / 文档 / 设计三条子域当前给出的 budget hint 也已经会被主流程实际消费，但语义已收口为“给当前步骤补 headroom”，不再直接抬高全局预算上限
- orchestration 层现在还额外持有 run-scoped cleanup registry：工具或 runtime 只要按 run 注册清理动作，取消 / 失败 / 超时都会统一收口一次

### 5.1 原生工具调用
- Anthropic 协议走 `messages` + `tool_use/tool_result`
- OpenAI 协议走 `chat/completions` 或 `responses` 的 function tools

### 5.2 文本工具桥接
对于表面 OpenAI 兼容、但实际上不把 tools 透传给模型的供应商：
- 系统会把工具列表转换为文本提示
- 模型通过 `:::tool_call` JSON 块表达工具调用
- 宿主应用本地解析并执行工具
- 工具结果再以结构化文本回灌给模型继续推理

当前这条桥接路径主要用于 `fox / code.newcli.com/codex/v1` 一类通道。

### 5.3 工具分类
- Browser tools：网页导航、搜索、读页、点击、输入、上传、批量下载等
- Document tools：打开、切换、写入、替换、格式化、改写、保存
- Session recall tools：历史会话搜索、最近会话列举、旧会话胶囊引用
- Skill tools：把 embedded/custom skills 暴露为统一 `skill_*` 工具
- System tools：系统命令与应用级操作

### 5.4 工具可见性与传输决策
- `DirectChatEngine` 当前已开始复用 `execution-tool-policy`：
  - `buildToolVisibilityPlan()`
  - `buildToolDispatchDecision()`
- 这一层先解决“本轮能不能看到工具、优先走哪种工具传输”，还没有完整接管全量 tool dispatch。

### 5.5 域内循环监督
- 浏览器 tool loop 的步骤推进、检查点提醒和超限总结已通过 `BrowserDomainOrchestrator` 统一输出，不再在 `DirectChatEngine` 主循环里拼装文案。
- 浏览器提示词细化和确定性执行也已开始通过 `BrowserDomainOrchestrator` 统一输出。
- 浏览器连续性注入、澄清短路、deterministic/tool-loop 分发与 fallback 文案现在也通过 `BrowserDomainOrchestrator.resolveExecutionDispatch()` 统一返回，`DirectChatEngine` 只做固定分发。
- 文档 deterministic flow 的章节识别、格式整理、改写草稿和文件写回 helper 已迁到 `document-domain-helpers`，`DirectChatEngine` 只保留调用与结果汇总。
- 文档工具循环的过程监管已开始通过 `DocumentToolLoopOrchestrator` 统一输出。
- 设计工具循环的主版式守门和完成收口已开始通过 `DesignToolLoopOrchestrator` 统一输出。
- 浏览器 tool loop 的计划文案和预算建议也已通过 `BrowserDomainOrchestrator` 统一输出。

### 5.5.1 结构化任务白名单
- 主进程目前只接受 `browser / document / design / skill` 这四类结构化任务 payload。
- 其他自由文本即使看起来像 JSON，也不会被当成正式任务状态写进前台运行态。

### 5.6 Provider Runtime 判断
- OpenAI 通道当前已开始通过 `provider-runtime-resolver` 统一判断：
  - 当前该走哪种接口
  - 当前推理强度取什么值
  - 当前是否优先走文字工具桥接
  - 原生 tools 没成功时是否要回退到文字桥接
- 这一步还没有把整条 provider 调用链完全抽走，但已经把“怎么判断”先从 `DirectChatEngine` 主体拿出来。

### 5.6a Shared Fallback
- `execution-fallback-policy` 现已作为共享 fallback contract 存在。
- 当前已覆盖：
  - OpenAI native tools -> text bridge
  - OpenAI responses -> chat/completions 回退
  - tool loop 中的视频提帧回退
  - Kimi Coding 的一次重试判定
- Anthropic simple 请求里的视频提帧回退也已并回 client，不再由 `DirectChatEngine` 保留额外的私有判断。
- Kimi simple path 的 `Kimi -> Anthropic-compatible` 回退链也已并回 execution client，不再继续留在 `DirectChatEngine` 的简单路径分支里。
- 这些回退开始通过 execution client / execution loop 统一返回 fallback metadata，而不是继续散在主循环里。
- `RunCoordinator` planning / done 两头当前都会保留同一套 fallback 诊断形状：`happened / kind / attempts`。

### 5.6b 执行意图判断
- `execution-intent-resolver` 当前已开始统一判断：
  - 用户这轮是否在走文档任务
  - 浏览器工具是否真的应该对模型可见
  - widget / 文档格式 / 章节改写这类规则该怎么选
- 这一步同时修正了浏览器工具可见性的判断时机，不再用浏览器决策尚未准备好的旧值去做过滤。

### 5.6b.1 正式任务路由
- `TaskTypeResolver` 现在不再只是分类器；主链新增 `task-execution-router`，会把 `taskType / executionChain / preferredExecutor / degradationReason` 真正转换成执行路线。
- 当前固定执行链为：
  - `direct`：简单直答，不进入工具循环
  - `tool_loop`：短任务与 RSS / Calendar / Feishu 轻执行器共用增强版工具循环
  - `planner`：多步任务先生成结构化步骤，再推进后续执行
  - `domain_executor`：Browser / Document / Skill 重执行器
  - `continuation`：优先从 `TaskProjectionStore + 模块持久化` 恢复
- 最小 `StepPlanner` 当前只负责产出结构化步骤骨架：`id / description / toolHints / budget / dependsOn`
- continuation 恢复失败时不会再静默回到普通工具循环，而是会显式记录 `degradationReason`，然后再降级到 `short_task` 或 `direct_answer`

### 5.6c Prompt 压缩
- `context-compression` 当前先负责 prompt 侧压缩 helper。
- 第一轮已正式接入超长历史摘要压缩，并会通过 `PromptAssemblyResult.compression` 回传压缩报告。
- 这些压缩结果只影响发给模型的 prompt，不会覆盖前台任务卡的 `taskTitle / taskSummary / steps`。

### 5.6d 安全并行工具
- `tool-parallelism-policy` 已从显式 allowlist 收口到资源域标签：
  - `domain`: `browser | document | rss | calendar | feishu | skill | memory | session | system`
  - `accessMode`: `read | write | interactive`
- 当前并行规则为：
  - `interactive` 永远串行
  - 同域且任一为 `write` 时串行
  - 跨域且无 `interactive` 时可并行
  - 全 `read` 时可并行
  - 全局并行上限 `5`
- `ExecutionLoopOrchestrator.executeToolCalls()` 已开始按资源域批次执行工具，并保持结果回收顺序稳定。
- 新增 `ToolRuntime` 作为工具批执行的唯一真相层：allowlist 校验、`ToolDefinition` 查询、并发分组、超时恢复、cleanup 回收与结果归一化都统一在这里完成。
- `ExecutionLoopOrchestrator.executeToolCalls()` 现已缩成对 `ToolRuntime.executeBatch()` 的薄代理；模型请求恢复与 fallback 仍保留在 orchestrator，不和工具执行真相再混在一起。
- 工具结果契约现已升级为 `ToolExecutionOutput`：主链统一拿到 `text / shape / data / projectionPatch / interactionHint`，旧工具返回的字符串会先被包装后再进入主链。
- 连续恢复或运行时压力升高时，执行层会主动降为串行批，避免工具批次继续放大抖动。
- 当本轮剩余工具预算不足时，执行层会在边界处停下，并把“预算已达上限”的状态留给主流程统一收尾。
- 当某个工具批次已经把本轮预算打满时，主流程会在这一轮末尾直接停下，不再继续请求下一轮模型响应。

### 5.6e 三层预算运行时
- 当前预算真相已从单层计数器升级为三层：
  - `TaskBudget`
  - `StepBudget`
  - 单轮 `IterationBudget / usage`
- 预算预警固定为：
  - `70%`：warning
  - `90%`：converge，会向模型注入收敛提醒
  - `100%`：exhausted，停止新一轮请求并交付部分结果摘要
- 纯 `read` 工具轮次会退还当前步骤的 iteration 消耗，但不会退还工具调用数。
- `suspended` 会冻结预算；`resuming` 会从冻结点继续，不会重置消耗。
- 前台任务卡与 `TaskPanel` 当前都可以读到：
  - `budgetUsagePercent`
  - `stepBudget`
  - `budgetWarningLevel`
  - `degradationReason`

### 5.7 Planning 投影
- `RunCoordinator` 在 planning 阶段已开始直接输出正式 `taskTitle / taskSummary`。
- 命中 trigger 的任务在前台会更早拿到结构化任务标题，不再只看到一条泛化准备态文本。
- planning 事件现在也会携带次级诊断信息，例如：
  - prompt compression 是否发生
  - 本轮 taskId 是多少
  - 本轮 budget seed 是多少
  - 本轮 fallback 是否发生、是什么类型、已重试几次
- 这些字段只用于诊断保留，不会顶掉前台任务卡的主标题和主摘要。
- 一轮执行结束后，`RunCoordinator` 也会补一次 execution diagnostics 更新，把本轮真实的 budget usage、step budget、budget warning 和 degradation reason 写回前台状态层。

### 5.8 文档任务结构化投影
- 文档 deterministic flow 在完成时已开始输出正式结构化任务字段。
- 主进程 scope run 事件现在不只接受浏览器模块的结构化任务结果，也能接住文档与设计模块的结构化任务结果。
- 文档与设计工具循环在“阻塞 / 完成”关键节点也已开始主动输出结构化任务字段，进一步减少前台只靠自然语言猜状态的比例。
- renderer 侧已补上文档/设计任务卡的显式回归测试，确保任务卡不再默认“有步骤的任务主要是浏览器或 skill”。

### 5.9 Task Projection 与继续任务
- `TaskProjectionStore` 当前是正式任务看板主表，但只负责任务投影，不承担浏览器或 skill 的内部执行细节。
- Browser / Skill continuation 现在会先通过 `taskId` 找到对应 projection，再跳模块内部持久化恢复细节，不再直接靠 `sessionId` 猜最近任务。
- `session-continuity` 现已按 `scopeId -> taskId -> continuation snapshot` 轻量持久化最近可继续任务；同一会话里的多个 blocked/running 任务不会再互相覆盖，任务完成时也只清自己的 snapshot。
- `TaskPanel` 和聊天任务卡生成的继续/重试草稿现在都会显式带上 `Task ID`，便于后续轮次精确恢复到正确任务。
- `DirectChatEngine` 现在会先按原始用户文本剥离 continuation 控制行，再重建清洗后的 `RequestEnvelope`；bootstrap 前缀会原样保留给模型，continuation 恢复不再靠把 `Task ID / Step ID / blockedReason` 重新注入会话历史来补上下文。
- projection 现已持久化 `taskTitle / taskSummary / recentArtifacts`，前台卡片默认优先消费 projection，再回退到 `ScopeRunSummary`
- `task_projections` 现已补上 `parent_task_id / parent_step_id`；child task 完成后，会把摘要和产物摘要回写到父步骤的 `childTasks/detail`

## 6. Browser Agent V7
### 6.1 核心原则
浏览器任务采用固定闭环：
`任务理解 -> 计划生成 -> 分步执行 -> 结果复核`

### 6.2 上传/生成类任务默认步骤
1. `resolve_target_page`
2. `resolve_attachment`
3. `navigate_target`
4. `ensure_upload`
5. `ensure_prompt`
6. `submit`
7. `final_reconcile`

### 6.3 证据优先
- 附件未出现页面级证据，不进入 prompt 阶段
- Prompt 未确认进入正确输入区，不进入 submit 阶段
- 页面未进入运行态，不报告完成

### 6.4 连续性上下文
系统会把近期浏览器动作、上次技能运行、当前页面状态、会话附件等注入到 planner / tool loop，目标是减少重复搜索、重复跳转、重复上传。
- 当前连续性仍以“短期收口”为主：最近工作流会额外记录可否继续、最近证据和上次失败原因，供任务恢复、重试和刷新后回看使用。

### 6.5 浏览器运行时统一层
- 浏览器主链现在开始收口为统一运行时合同，而不再只靠 `direct-chat`、`browser-agent-runner`、`browser-tools` 各自维护页面理解。
- 浏览器能力现在已被正式拆成 `browser_interaction` 与 `browser_content_tasks` 两组：前者偏页面即时交互，后者偏提取、下载、研究与后台任务。
- 当前新增的统一层包括：
  - `agent-runtime-adapter`
  - `page-state-service`
  - `evidence-service`
  - `browser-task-planner`
- `BrowserAgentRunner` 仍保留 Browser Agent V7 的阶段式执行，但页面身份和证据判断已开始复用统一层。
- `BrowserPageState` 现已补上统一 evidence / risks / continuity 三段摘要，浏览器执行器、诊断入口和恢复判断都从这套结构取真值。

### 6.6 浏览器任务结构化投影
- 浏览器 runner 现在支持输出结构化浏览器任务 payload。
- 主进程会把结构化字段映射进 `scopeRunEvent.taskTitle / taskSummary / steps / currentStepId / waitingFor / resumableActions / recentArtifacts / blockedReason / taskContinuation`。
- renderer 侧 `scopeRunState` 已优先消费这些显式字段，减少对阶段文本解析的依赖。
- 浏览器 domain adapter 现在也会直接产出这套结构化 payload：tool loop 进行中、实时查询结果已核对、最终 `done` 收口都走同一条 projection 真值通道，不再只靠最早那条 planning 文案撑满整轮任务卡。

### 6.7 浏览器诊断入口
- 浏览器诊断不再只有 host / preview / recent log 这类底层状态。
- 当前诊断数据会额外带出：
  - 当前浏览器任务摘要
  - 当前页面状态摘要
  - 当前连续性摘要
  - 最近失败原因
  - 可直接执行的恢复动作
- Browser 模式页内现已挂上轻量诊断卡，用户可以直接看到“现在在做什么、卡在哪、怎么继续”。

## 7. 会话 Scope 与远程 IM
### 7.1 Scope 粒度
会话按“来源频道 + 线程/本地 conversation + agent”隔离。

### 7.1b Scope Run 摘要
- 主进程会为最近 scope run 维护任务摘要，供聊天面板刷新后恢复最近任务。
- 统一任务字段包括：`taskTitle / taskSummary / steps / currentStepId / waitingFor / resumableActions / recentArtifacts / memoryCapture`
- Browser Agent V7 阶段会直接投影成步骤；workflow skill blocker 会映射成 `input / confirmation / agent_result` 等等待态。
- renderer 在收到最终 `done / error / cancelled` scope run 事件后，会再次回写 assistant 消息快照，确保消息上的任务卡不会冻结在较早的运行中状态。

### 7.1c 会话回看主链
- 当前已补上独立的 session recall 主链，和 memory 系统分开。
- 历史会话仍以 `chat_conversations / chat_messages` 为原始真相，不额外复制 transcript。
- 会话层现已补上 `parentConversationId / lineageRootId / resumeTitle` 三个谱系字段，用于后续 continuation / recall 归并。
- SQLite 现在会维护：
  - `chat_messages_fts`：历史消息全文索引
  - `session_recall_metadata`：会话标题、恢复标题、最近任务摘要、附件名、preview
  - `session_recall_attachment_index`：可检索的附件索引
- 历史会话现在还会维护 `session_recall_vectors`：为会话胶囊生成本地持久化向量，供余弦相似度检索使用。
- `session_search` 是当前历史会话回看的正式工具：
  - 无 query：返回最近会话
  - 有 query：按消息正文、会话标题、任务摘要、附件名搜索，并追加本地向量相似度补召回
  - 默认排除当前 scope 所在 lineage，避免把当前会话自己搜回来
- 搜索结果会按 `lineageRootId` 归并，返回的是会话级 hit / capsule，而不是原始 transcript；`matchedBy` 当前可能包含 `message / title / task / attachment / semantic / recent`。
- 当前 scope 现在可以显式挂入旧会话 capsule；Prompt Assembly 会把这些 capsule 作为独立的“跨会话回看”段注入到当前轮。
- Prompt Assembly 现在还会做一层保守的**自动跨会话召回**：
  - 只在当前频道范围内检索
  - 默认只挑 1 到 2 条高相关旧会话
  - 当前主要依赖 `session_search` 结果中的高分 hit，再过滤为自动 recall capsule
  - 自动召回结果不会写回会话引用列表，也不会替代手动引用
- 聊天面板当前已补上轻量入口：可搜索旧会话、引用到当前轮、查看已引用 capsule，并支持移除。

### 7.2 附件安全边界
- 图片/文件消息先进入会话资源层
- 不能伪造成一条普通文本消息直接触发 agent
- 后续浏览器任务必须显式消费附件资源

### 7.3 Sidecar 角色
`src/python/ready_sidecar/*` 负责：
- 远程通道连接与心跳
- 事件入站
- 附件落盘
- 主进程的前台会话写入与 agent 调度辅助

## 8. 技能中心
### 8.1 技能来源
- `embedded`：应用内置系统级技能
- `custom`：用户导入的技能目录

### 8.2 运行时
技能运行时负责：
- 安装与同步 embedded skill
- 导入/移除 custom skill
- 调度 Python / Node / Shell skill action
- 记录 jobs / schedules / stats
- 编译 `ready-skill.json + skill.workflow.json + SKILL.md`
- 持久化 workflow execution / step history / artifacts
- 对 workflow skill 提供 blocker-based resume / restart-from-step

### 8.3 UI
技能中心当前支持：
- 系统技能与自定义技能分区展示
- 拖拽导入技能目录
- 默认命令生成
- 技能说明更新与删除/移除操作
- Recent Executions 区域，展示 status / current step / blocker / recent artifacts
- 在 blocker 为 `need_input / need_confirmation / need_agent_result` 时直接继续提交 execution

### 8.3b ChatPanel 任务区
- Agent 聊天面板新增 `当前任务 / 后台任务` 两块任务视图，不再只靠 tool trace 胶囊表达进度。
- `当前任务` 优先显示当前 scope 的活动任务或刚完成任务。
- `后台任务` 按当前频道来源显示最近仍活跃、阻塞中、或刚完成的 scope run。
- 若任务带有 `memoryCapture`，聊天里会直接展示本次自动沉淀的偏好/摘要，并支持确认、撤销、补充。

### 8.4 Workflow Skill 协议
- `ready-skill.json` 负责 skill 元信息、actions、visibility、execution mode
- `skill.workflow.json` 负责 step、inputs、transitions、agent_task / confirmation / user_input
- `SKILL.md` 只做人类说明，不再承担机器协议职责
- 公开 action 才会暴露为模型工具；`visibility: "internal"` 仅供 workflow step 调用

### 8.5 Claude / OpenAI 兼容修复
- `direct-chat` 现在会在视频输入场景下，为显式 `/skill`、手动阶段控制、embedded python 请求、活跃 execution 保留 tools
- `direct-chat` 现已开始消费 capability resolution：provider tool 开关、浏览器任务模式、文档意图与飞书可用性会先收口成可见能力组，再生成本轮 allowlist。
- `direct-chat` 的运行前能力判断现在统一走 `run-capability-controller`：initial run 和 browser decision 后的 reconcile 都在这一层完成，主循环只消费结果
- `direct-chat` 新增 `DocumentTaskPipeline` MVP：当请求命中“先读文档再做卡片”结构化意图时，会先读取当前活动文档快照，再拆成 `insight -> componentSpec -> deterministic writeback` 两轮执行
- renderer 文档模块新增 host-only `document.inspectActive`，供主进程读取当前活动文档全文；这条路径不对模型直接暴露
- 文档深读 pipeline 的 simple 请求现已支持独立阶段超时，不再只能沿用默认 45 秒 simple request 预算
- `direct-chat` 现已在会话内短期缓存 `DocumentInsight`：同一文档内容 + 同一问题重复触发时，第一轮 insight 会优先复用缓存结果，减少重复模型调用
- 新增 `live-info-intent` 轻量语义层：天气、新闻、股价、汇率、比分、航班、路况、空气质量、官网最新公告这类依赖最新外部信息的问题，会在入口阶段先被识别成“需要联网核对”，不再强依赖“打开网页/浏览器/网站”这类显式动作词
- `intent-classifier` 现已把实时外部信息查询视作高优先级 browser intent；文档上下文、最近 widget 历史或其它环境噪声不应再把这类请求误导到 document/design 路由
- `browser-task-planner` 现在允许这类请求走“先搜索、再锁定可靠结果页”的计划路径：没有显式 URL 时会优先生成 `targetSearchQuery`，再去权威或最新页面完成读取与核对
- 实时查询的浏览器工作流当前会把成功标准收口成“已锁定可靠结果页 + 已读取与问题匹配的最新信息”，而不是泛化成“页面做过某个动作”
- 浏览器实时查询现在会先收集 `browser_*` 工具读到的网页证据，再由宿主做一次最终答复整理；最终回复只允许基于已核对的网页事实，不再把步骤播报、文本桥接纠偏或“工具缺失”解释混进最后答案
- OpenAI 原生工具回复如果出现“没有可调用的浏览器工具组结果返回”这类新变体，当前也会被识别成缺失工具回复并自动进入现有纠偏链，而不是直接把这段借口当最终答复
- 仅仅在文本里提到“浏览器工具/网页工具”但没有具体网页动作、链接、附件或实时查询信号时，任务路由现在会回到普通回答路径；这类 meta 追问不再误落到 browser executor
- 站点名直达型请求现在也会进入浏览器计划层：当用户说“打开 pinterest / 去即梦 / 进入 Gemini”但没有附带 URL 时，planner 会先生成 `targetSearchQuery` 再锁定目标站点，而不是继续停在 `no_browser_intent`
- 浏览器任务如果 native tools 回包里 `toolCalls=0`，当前会把它视为执行证据不足并主动切到纠偏重试；浏览器任务至少要先发起一个 `browser_*` 动作，不能直接拿解释性文本收尾
- `request-envelope` 现已新增稳定 `resources[]`：每个附件、`@[文件]`、当前文档上下文、文档引用都会保留独立身份、顺序、正文与可写属性，不再在入口阶段被揉成一段混合材料
- `document-task-plan` 现已作为文档复杂任务入口：当一句话里出现显式“根据 A 在 B 中做卡片”、多来源、多目标或顺序步骤时，会先生成 `DocumentTaskPlan -> DocumentTaskJob[]`
- 每个 `DocumentTaskJob` 当前至少固定拆成六步：`collect_materials -> build_insight -> compose_widget -> write_target -> save_target -> verify_result`
- 多 job 文档任务现已正式接入 child task：父任务只展示 job 级 overview step，每个 job 会生成独立子任务承载这六步细节；单 job 仍保持原来的内联路径，不强行转成 child task
- 文档 child task 会生成独立 `workerSessionId + taskId`，但继续复用父会话里的 insight/widget cache；这轮隔离的是运行身份与后续 child turn，会话级缓存不另起一份
- 父任务现在会按 job 顺序等待 child 完成，任何一个 child 失败都会立即 fail-fast；已完成 child 的独立投影与步骤记录会保留，父步骤摘要也会按现有 backfill 机制回填
- 文档来源选择现已支持角色绑定：`primary_source / secondary_source / target_document / ambient_context`；`current document context` 默认只作为低优先级环境信息，不能压过显式材料
- 文档 insight 缓存键现已切到任务级：会带上 job 角色绑定、来源文本 hash、目标文档身份与当前步骤，避免“源材料变了但缓存还命中”或“目标文档摘要污染 insight”这类复用错误
- widget 草稿当前也开始做短期会话级缓存：如果 insight 已完成、草稿也已拿到，但写入或保存阶段失败，下一次重试会优先从草稿继续，而不是重新提炼来源材料
- 新增共享 `document-sectioning` helper：长文档会优先按章节切块，章节过长再按段落/句子拆开，并在 insight 阶段先筛相关片段后再发第一轮模型请求
- `DocumentTaskPipeline` 现已支持部分成功降级：insight 或 widget draft 一旦已生成，后续阶段失败时会优先把这些中间结果回给用户，而不是整轮直接报错结束
- `document-engine` 的深读热路径已先异步化：`readDocxRawText` 与 `readDocumentEditableText` 现在改为异步读取，优先降低这条 pipeline 在主进程上的阻塞风险
- `DocumentTaskPipeline` 的 insight 阶段完成文案现在会补上关键指标，例如本轮共切了多少片段、实际使用了多少片段、是否命中缓存；当前任务卡已可直接消费这类阶段摘要
- 文档深读相关指标也已正式进入 `executionDiagnostics.pipeline.document`，供 renderer 状态层和任务卡稳定消费，而不再只依赖摘要文本解析
- 文档结构化任务状态现已按计划步骤投影：未开始步骤显示 `pending`，失败步骤显示 `blocked`，前台不再把整条文档链路默认显示成进行中
- 文档主进程的通用读取入口也已继续异步化：`document:read`、`document:list`、`document:parseDocx`、`document:parseXlsx` 现在改为异步 fs 读取，进一步降低打开和解析大文档时的阻塞风险
- `system_run_openclaw` 与文档 format/rewrite 的 deterministic 直通现在统一走 `host-capability-dispatcher`，不再在 `direct-chat.ts` 里各自手写 host-only 分支
- `ToolGateway` 继续只负责 registry 真相：已补上 group 级 schema/query 与 dynamic source 标记，`skills` 组会把静态 execution control 和运行期 skill action 一起输出
- AI 设置页“能力分组”的当前状态改为读取 agent runtime 返回的 capability runtime snapshot；renderer 只负责展示，不再自己猜飞书/浏览器可用性
- OpenAI `chat/completions` / `responses` 发请求前都会修复缺失的 tool response history，避免 `tool_call_id` 400
- `need_agent_result` blocker 会自动注入文本类 source materials 正文，而不是只告诉模型文件路径
- Agent continuation 现已优先按 `Task ID` 恢复任务投影：聊天任务卡和右侧 `TaskPanel` 生成的继续/重试草稿都会显式带上 `Task ID`，主循环不再强依赖“继续/恢复”关键词猜测要恢复哪个任务
- `RunCoordinator -> ClaudeSdkOrchestrator -> DirectChatEngine` 现已开始透传 `TaskBudgetRuntime`：任务预算、当前步骤预算、warning level 和 frozen state 会统一进入 `executionDiagnostics`，供 `ScopeRunSummary / task_projections / ChatPanel / TaskPanel` 共用
- `intent-classifier` 与 `task-type-resolver` 已补齐 `skill` 域：显式 skill / workflow / blocker 请求会进入正式 skill executor 路径，不再只靠 skill tool allowlist 在通用循环里碰运气
- `direct-chat` 里的文档深读后制卡 pipeline 已开始受正式任务路由约束：只有 document executor 路径命中时才会进入这条 deterministic pipeline，避免继续漂成主循环前置特例
- `RecoveryRouter` 现在会产出稳定的重试元数据：`rate_limit / transient` 使用 `350ms` 起步、最大 `8s`、最多 `3` 次的指数抖动退避；一旦出现恢复记录或预算进入 warning，`ToolRuntime` 会把后续工具批次自动降为串行，`ExecutionLoopOrchestrator` 只继续保留模型请求恢复。
- `tool_result` 发往 renderer / provider transcript 前，主进程最后一公里仍会序列化成兼容旧通道的文本或 JSON 字符串；本期没有改 preload / renderer 协议。

## 9. 开发约定
### 9.1 新增跨进程功能的最小闭环
至少同步修改：
1. Main IPC handler
2. Preload API
3. Renderer 类型声明
4. Renderer 页面或组件
5. 至少一份相关文档（模块图 / 依赖图 / 进展 / 经验）

### 9.2 BrowserView 约定
- BrowserView 是原生层覆盖，不受 DOM `z-index` 控制
- 需要展示纯 DOM 覆盖层时，先 `hideAll()`
- 恢复浏览内容时，再 `showActive()` 并更新 bounds
- 工作台切到非 browser 可见态时，优先由壳层统一调用 `browser.hideAll()`，不要只隐藏 active tab host；否则 RSS preview / popup 这类原生子视图可能残留在前台
- `useBrowserViewBounds` 现已统一为“一帧最多一次”的 renderer 调度路径：容器 `ResizeObserver`、共享窗口 resize hub、面板拖拽事件都只进入同一个调度器，不再并行叠加多条 tracking 链
- Browser bounds 去重键必须同时包含几何值和 `syncMode`；最后那次 `settled` 落点不能因为坐标没变就被前一帧 `transient` 吞掉
- 面板拖拽期间只发送逐帧 `transient` 更新；拖拽结束后必须补一条强制 `settled` 更新，确保主进程拿到最终精确落点
- Browser 运行态初始化要尽量做到“一次准备，多次复用”：已有 tab 可在后台预热恢复，但不要因为后台预热强行新建空白页
- 浏览器冷启动若后端当前没有 tab，应先展示空状态；首个 tab 只在用户或任务主动触发时创建，不要把默认外部页当成启动必经步骤
- 空状态必须沿用真实地址栏交互：输入网址后直接走同一套导航逻辑创建首个 tab，而不是挂一套只会显示 UI、不会真正跳转的占位 header
- browser 回场时可以在壳层离场覆盖还没收完之前提前露出原生 host，但 browser 切出时仍要尽早 `hideAll()`，不要让原生网页和 DOM 过场抢前台

### 9.3 Workbench Keep-Alive 约定
- `src/renderer/components/layout/WorkbenchModeOutlet.tsx` 负责 browser / document / rss / calendar 四个主模式的常驻挂载
- 模式切换仍保持四模块常驻，不回退到“切一次挂一次”；但共享壳层现已改为分层场景，只让 `current / entering / leaving` 三个槽位短时参与过场，其余模式统一停画但不丢状态
- 左右切页只发生在共享壳层，不要把整区重动画重新下放到各模块内部
- 非参与过场的模式必须同时退出布局与交互：统一 `display: none`、`pointer-events: none`、`aria-hidden`
- 模式切换不再依赖 `contentVisibility + visibility + adjacent prepare` 这一套预热逻辑；方向仍固定按 `browser -> document -> rss -> calendar` 决定
- 模式槽位需要稳定 memo 边界，避免父壳层切换时把未参与过场的重模块一起重新渲染
- 动效语言固定为三类：
  - document / rss / calendar 之间：整块水平切换，旧页完整横向离场，新页从反侧完整进入
  - browser -> 非 browser：browser 保持原位不动，目标模块横向进入并覆盖它
  - 非 browser -> browser：browser 保持原位不动，当前模块横向退出并把它露出来
- 共享壳层若依赖截图做离场层，不能在点击后再同步等待截图结果才开始切换；应优先复用稳定缓存，避免“点了半拍后才动”
- 连续快速切换时以最后一次点击目标为准；中途点击不能被静默丢弃
- 页面级副作用必须感知 `isActive`
- RSS：隐藏时暂停 analysis polling / auto refresh，可见时再做一次数据同步
- Calendar：重量级 Schedule-X 初始化延后到首次激活，隐藏时不继续做 UI 同步
- RSS preview：模式隐藏时必须关闭 preview host，重新显示时再按当前 item 恢复
- RSS preview bounds 现已与主 BrowserView 共用同一收口思路：每帧至多一条更新，布局稳定后补一条最终确认，不再自带长时间 RAF 追踪循环
- 工作台级窗口 resize 订阅已统一走 `src/renderer/modules/workbench/windowResize.ts`；像 `ChatHeader`、`FilesPanel` 这类只需要重新定位浮层的组件，不再各自挂原生 `window.resize`
- 顶栏四模块切换器使用稳定最小宽度，避免 active/hover 状态引发布局抖动
- 切换方向按 `browser -> document -> rss -> calendar` 的顺序决定：向右切时旧页向左出、新页从右入；向左切时严格镜像
- browser/rss/calendar 的内部 header rail 需要和 document 模式共享左边界；`workbench-canvas-shell` 负责统一圆角矩形轮廓，子模块不要再各自切半圆角壳
- BrowserMode 若通过 `requestAnimationFrame` 延后恢复原生 host，必须可取消；切出 browser 时统一走 `hideAll()`，避免旧 RAF 把 BrowserView 再次抬回前台
- BrowserMode 在原生页面尚未稳定前，不应先露出真实顶部 chrome；优先只收起顶部浏览器栏，避免把整块浏览器区域一起藏掉
- BrowserMode 若已经完成过 tab 恢复或首个 tab 创建，后续模块切回不应再把 `browserRuntimeReady` 重置到冷启动态
- 主进程在 `browserHostsPresented = false` 时不应继续把 renderer bounds 应用到 active host；隐藏态只记录最新 bounds，不重新摆回可视区
- liquid-glass 皮肤下若某模块没有额外顶部 shell 参与勾边，需要为该模块补回最小可见 outline；当前 RSS 使用这一例外规则
- 顶栏四模块切换器当前使用普通稳定按钮组；如果未来重新引入高动态 segmented control，必须先验证 hover/active 不会造成几何偏移
- 顶栏四模块切换器点击切换应优先走短促直达动画；只有拖动释放时才保留弹簧回弹，避免与主工作区过场叠加成拖泥带水

### 9.4 日志约定
当前关键日志位于系统临时目录（macOS: `/tmp/`, Windows: `%TEMP%`）：
- `ready-directchat.log`
- `ready-tools.log`
- `ready-browser.log`

## 10. 常用命令
```bash
npm run dev
npm run typecheck
npm run build
npm run lint:check
npm run test
npm run verify
```

## 11. 当前测试入口
`src/__tests__/` 当前包含：
- `agent-control.test.ts`
- `ai-provider-capabilities.test.ts`
- `browser-popup-policy.test.ts`
- `browser-tools.test.ts`
- `browser-host-visibility-contract.test.ts`
- `database.test.ts`
- `ipc-handlers.test.ts`
- `responses-parser.test.ts`
- `rss-analysis-manager.test.ts`
- `stores.test.ts`
- `tool-bridge.test.ts`
- `browser-resize-stability-contract.test.ts`
- `browser-host-visibility-contract.test.ts`
- `workbench-keep-alive-contract.test.ts`
- `workbench-window-resize-contract.test.ts`
- `workbench-hot-path-transition-contract.test.ts`
- `workbench-shell-alignment-contract.test.ts`
