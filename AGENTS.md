# Ready 项目协作指引（Codex）

> 更新时间: 2026-04-16

## 0. 前置思考
请使用第一性原理思考。不要默认用户已经把目标、限制和最佳路径都描述完整；当目标不清晰时先澄清，当路径不优时先提出更好的方案。

## 1. 项目定位
Ready 是一个集成式创作工作台，统一承载：浏览、文稿、RSS、日程、AI Agent、技能中心与远程协作。

## 2. 技术基线
- Electron 34
- React 19
- TypeScript 5
- Vite 6 + electron-vite
- Zustand
- Tailwind CSS v4 + CSS Variables
- SQLite（better-sqlite3）

## 3. 代码分层
- Main：`src/main/`
- Preload：`src/preload/`
- Renderer：`src/renderer/`
- Shared：`src/shared/`

## 4. 关键入口
- 主进程：`src/main/index.ts`
- 预加载：`src/preload/index.ts`
- 渲染入口：`src/renderer/main.tsx`
- 应用壳层：`src/renderer/App.tsx`
- AI 配置能力层：`src/shared/ai-providers.ts`

## 5. 工作台子模式
`useMode` 当前包含：
- `browser`
- `document`
- `rss`
- `calendar`

## 6. 当前稳定性约定
### 6.1 白屏防护
- `src/renderer/main.tsx` 必须保留 bootstrap 级错误兜底 UI
- `src/renderer/App.tsx` 必须保留 `/workbench` 路由与 `* -> /workbench` fallback

### 6.2 BrowserView 使用原则
- BrowserView 是原生层覆盖，不受 DOM `z-index` 控制
- 需要显示纯 DOM 覆盖层时，先 `browser.hideAll()`
- 恢复浏览内容时，`browser.showActive()` 后同步更新 bounds

### 6.3 统一会话 Scope
- 会话按“来源频道 + 线程/本地 conversation + agent”隔离
- 左上切换的是频道来源，不是具体历史会话
- 工具日志只能留在前台运行态 / 胶囊层，不允许混入正文消息

### 6.4 附件安全边界
- 飞书/远程图片与文件单发：只进入会话资源层，不自动触发 agent
- 后续文字任务若要消费附件，必须由 planner / workflow 显式选取附件资源
- 远程消息不能把图片/文件伪造成普通文本

### 6.5 Browser Agent V7 原则
- 浏览器任务必须走：任务理解 -> 计划生成 -> 分步执行 -> 结果复核
- 链接是资源，不是立即执行指令
- 执行器只按计划推进，不临场重写大方向
- 上传型任务的最小完成条件：
  - 页面已挂载附件
  - Prompt 已进入正确输入区
  - 页面已提交并出现运行态证据

### 6.6 AI 供应商兼容原则
- 不要假设“OpenAI 兼容”就一定支持原生 function tools
- 优先通过共享能力层判断协议、wire API、tools/vision/video 能力
- 若通道不支持原生 tools，应优先复用文本工具桥接，而不是继续写 provider 特判

### 6.7 技能中心原则（全量同步 CLAUDE.md）
- 系统级 embedded skills 与用户 custom skills 要分层管理
- Agent 调用 skill 时优先走统一 `skill_*` 工具，而不是绕到手工网页流程
- 更新 skill 管理逻辑时，要同时考虑运行时、UI、默认命令与说明文案
- LLM-facing 的 `skill_submit_input / skill_submit_confirmation / skill_submit_agent_result / skill_restart_from_step / skill_cancel_execution` 5 个工具按 session 状态动态曝光：当 `ToolPolicy.sessionId` 提供且该 session 无 active execution 时必须被过滤掉，只保留只读的 `skill_get_state`；入口在 `skill-tool-session-gate.ts::filterExecutionControlToolsBySession`
- 这 5 个工具的 description 前置固定子句 `ONLY call this if a previous skill_* tool returned an explicit executionId. Never fabricate an id like "new" or "0".`，防止模型在 reference 技能场景下编造 executionId；文案变更由 `src/__tests__/skill-zod-golden-snapshot.test.ts` 锁定
- Reference 技能（`runtime: reference` / `execution.mode: advisory`）被内联注入时，orchestrator 必须调 `skill-reference-hints.rememberLastReferenceSkill(sessionId, {id,name})` 登记；`buildSkillExecutionMissingOutput` 检测到 `lastReferenceSkill` 后会用「不要再调 skill_submit_*」文案替代通用 `skill_get_state` 引导
- Reference 技能内联注入走直读路径（`SkillContextOrchestrator.tryInlineReferenceSkillDoc` 读 `<managedPath>/SKILL.md` → role:'system' 注入，截断 6K 字符、emit `skill_reference_inlined` metric）；只有 readFileSync 失败或无 managedPath 时才回退到旧的 `skill_*_read_skill` tool-call 路径
- `custom-skill-registry.ts` 自动生成的 `read_skill` action 默认 `visibility: 'internal'`（避免 LLM 看到 `skill_<id>_read_skill` 并在循环里反复调用）；manifest 显式声明 `visibility: 'public'` 继续被尊重
- `skill_ask_user` 通过独立 IPC（`skill:askUserQuestion` push + `skills:askUser:submit` invoke）驱动渲染端 `SkillAskUserPrompt` 胶囊；ephemeral 状态存于 `EphemeralExecutionStore`（内存，不写 `skill_executions` 表），executionId 用 `eau-<8hex>` 前缀区分；24h 超时 / AbortSignal 抗抖 / session 关闭都会清 pending 记录

### 6.8 文档多资源任务原则
- 文档任务里的附件、`@[文件]`、当前文档上下文、引用片段都必须先进入结构化资源层，不能在入口阶段直接拼平成一段大文本
- 复杂文档任务必须先做资源角色绑定，再进入执行：至少区分 `primary_source / secondary_source / target_document / ambient_context`
- `当前文档上下文` 默认只算环境信息，不能压过用户显式点名的来源材料
- 一句话里出现多个来源、多个目标或多个顺序步骤时，必须先生成 `DocumentTaskPlan + DocumentTaskJob[]`，再按 job 顺序执行
- 文档卡片类执行状态必须按计划步骤展示；未开始步骤显示 `pending`，失败步骤显示 `blocked`，不能再把整条链路默认标成进行中或完成

### 6.8.1 Widget 骨架仲裁层（v0.1+）
- 文档 widget 采用「骨架 + 设计规范」作为 LLM 与用户之间的仲裁层：`src/shared/document-widget-skeletons.ts` 定义 9 个骨架（A–G + H1 freeform_static / H2 freeform_interactive），`background_mode` 是跨骨架的正交维度，不新增骨架
- Legacy `componentSpec`（20 个组件）通过 `src/shared/document-widget-skeleton-mapping.ts` 只读映射到骨架；保存时可升级为 `skeletonSpec`，但不得在解析阶段丢弃原 `component_spec` 字段
- H1/H2 仅在用户消息命中触发关键词（`做一个超特殊卡片` / `交互式信息卡` / `交互式数据图`）时允许使用；LLM 即便选了也要在渲染端走 `arbitrateSkeletonForUserText` 降级到最近的 A–G
- Widget 相关口语（信息卡 / 卡片 / 图表 / 超特殊卡片 / 交互式信息卡 / 透明背景 / A4 / 4:3 / …）必须同步到 `live-info-intent.LOCAL_DOMAIN_HINTS`，避免被误判为 browser 意图

### 6.9 实时外部信息查询原则
- 天气、新闻、股价、汇率、比分、航班、路况、空气质量、官网最新公告这类依赖最新外部信息的问题，不能只因为用户没写“打开网页/浏览器”就当成普通直答
- 这类请求必须先做轻量语义判断；命中后优先进入浏览器查询工作流，而不是继续沿用 `direct_answer`
- 语义判断优先级高于“当前文档上下文”或“最近在改 widget”这类环境噪声，避免把实时查询误路由到 document/design
- 对实时查询的网页计划，允许先走搜索再落到权威或最新结果页；不要把“没有显式 URL”直接当失败
- 只有在语义置信度不足、来源冲突或用户目标不明确时，才进入澄清；不要用站点白名单或显式动作词把这类任务硬挡住
- live-info 语义判断的输入只能是用户的 primary instruction，不能拼上 widget attachment / referenced resources，否则附件正文里的“赛程/比分/天气”等领域词会污染分类，把信息卡修改请求误升级成 browser_workflow
- 当 `environmentHints.hasWidgetTargetContext = true`（用户携带 `### Widget 更新上下文` 发起对话）时，`intent-classifier` 与 `browser-task-planner.decideTask` 必须跳过 live-info 判定；即使 primary instruction 里出现天气/温度/最新等主题词也不能翻到 browser_workflow。裁决层只会降级工具面板，不会回写 adapter decision，挡板必须在源头
- `live-info-intent.LOCAL_DOMAIN_HINTS` 需要覆盖常用 widget 口语名词（卡片/信息卡/图表/趋势图/波动图/对比卡/进度卡/…），避免用户用这些词指代 widget 时被误判为 browser 意图

### 6.10 Agent 工具策略裁决与超时
- `run-capability-controller.resolveRunCapabilities` 是策略冲突的唯一裁决点：当 `forceDocumentTool × browser_workflow` 或 `widget update/inspect/remove × allowBrowserTools` 这类组合出现时，由它统一降级 `browserDecisionMode` 并重算工具集；上游模块（`browser-task-planner`、`turn-engine` 等）不得再加双重挡板
- `assertNoToolResolutionViolation` 仅作 telemetry 使用：任何残留的 invariant 失谐都通过 `logAgentMetric('tool_resolution_violation_post_arbitration', ...)` 记录并写日志，不再抛错给用户；如再出现该指标即说明裁决层有 bug
- `document-task-pipeline-executor` 中所有 `requestModuleToolAction` 必须通过 `document-task-tool-timing` 的 `wrapToolCall` / `raceWithTimeout` 包装，并在入口检查 abort signal；不允许出现 `void params.signal` 这样吞掉信号的写法
- DirectChatEngine 的 `sendMessage` 抢占既要 abort 旧 `AbortController`，也要先调用注入的 `cancelPendingToolActions`，把渲染端正在 pending 的 `agent:toolActionRequest` 取消掉，否则旧的 widget 写入会落到新会话上
- H1/H2 freeform 骨架的触发关键词校验与降级也统一走 `arbitrateSkeletonForUserText`；任何绕过裁决层直接在 pipeline executor 内加 skeleton 白名单的做法都视为双重挡板，不允许

### 6.11 工具错误契约
- Tool handler 可以抛异常，但 dispatch 层（`src/main/modules/tools/tool-executor.ts`）永远不 rethrow 业务错误；所有抛出都被吞成 `ToolExecutionOutput { errorKind, detail }` 结构化结果回灌模型，由模型决定下一步
- 只有 `isTerminalInfrastructureError(error) === true` 的错误（`AbortError` / `ToolHostUnavailableError`）才允许冒泡出 dispatch 层
- 所有工具 dispatch 入口都走 Zod `safeParse`；失败返回 `errorKind: 'input_validation'` 结构化结果，不进 handler。静态 schema 注册在 `src/main/modules/tools/schemas/index.ts`，动态 skill-action schema 在 `skills-tools.ts` 按签名缓存并合并
- 主→渲染 `agent:error` IPC 必须带 `{ errorKind, recoverable, toolName? }`；`recoverable === true` 走软失败胶囊（`SoftFailureCapsule`），其他走系统消息；`errorKind === 'aborted'` 在 runtimeDriver 入口早返
- 新增 tool-error metric 必须先登记在 `TOOL_ERROR_METRICS`（`src/main/modules/agent-control/tool-error-metrics.ts`），再在 emit 点引用；其他 observability metric（`tool_group_blocked_rate` / `policy_conflict_resolved` / `task_title_correction_rate` …）留在自己模块内，**不**并入此 registry
- `skill_executions` 终态行（`completed / failed / cancelled`）7 天清理；活跃行（`running / blocked`）永不清理；sweep 在 `SkillsRuntimeManager` 启动后 30s 首跑、之后每小时跑一次，`tool-error-metrics.ttlSwept` 打点
- `skill_executions` 表所在的 DB 没有开 `PRAGMA foreign_keys = ON`，`ON DELETE CASCADE` 实际不生效；任何清理跨表数据的逻辑必须显式删子表行（`skill_execution_steps` / `skill_execution_artifacts`）
- 所有新 executionId 使用 `e-{8hex}` 前缀（`generateSkillExecutionId()`）；旧 UUID 行继续兼容，不做回填；`getExecution` 用 `WHERE id = ?` format-agnostic，`Zod` schema `z.string().trim().min(1)` 不加 UUID 断言

### 6.12 Skill 原语沙箱边界（B Phase 1）
- `skill_run_shell` 的命令白名单（Phase 1）：`python / python3 / node / bash / sh / curl / cat / ls / head / tail / grep / find / mkdir / rm / cp / mv / echo / awk / sed`，维护在 `src/main/modules/tools/skill-primitives/run-shell.ts::SHELL_ALLOWLIST`；扩展机制为 PR 级别修改白名单常量，**不**提供用户配置开关；遇到 embedded skill 需要的命令打点 `skillPrimitiveRejected{reason:'cmd_not_allowlisted'}` 再统一评估
- `parseCommand` 只支持双引号分词：命令里出现 POSIX 单引号或不平衡的双引号时抛 `CommandParseError`，handler 转换为 `errorKind: 'command_parse_failed'`；不做 shell 展开、不走 `shell: true`，所以 `$(…)` / `&&` / `|` 等元字符按字面量传递
- `skill_run_shell` 的超时 kill：Unix 走 `spawn({ detached: true })` 并用 `process.kill(-pid, SIGTERM)` 杀整个进程组，覆盖 bash/sh 孕育的孙进程；5s 后若仍存活升级 `SIGKILL`；Windows 回退到 `child.kill`
- stdout / stderr 默认上限 8K 字符，超出时把完整内容写入 `<artifactRoot>/.logs/shell-<ts>-<uuid>-<stream>.txt` 并返回 `stdoutArtifactPath` / `stderrArtifactPath`；overflow 写入失败不吞掉命令主结果，通过 `stdoutArtifactError` / `stderrArtifactError` 暴露，同时 emit `skillPrimitiveRejected{reason:'overflow_artifact_write_failed'}`
- `skill_write_artifact` 只能写 `<artifactRoot>` 子树；绝对路径 / `..` 穿越 / symlink 逃逸 / 保留文件（`SKILL.md` / `ready-skill.json` / `skill.workflow.json` / `MANIFEST.json`，大小写不敏感）一律拒绝；单次写入字节上限 `WRITE_ARTIFACT_HARD_CAP_BYTES = 50 MB`，超出返回 `errorKind: 'size_limit'`
- `skill_read_artifact` 允许读 `<artifactRoot>` 下的任何文件；默认读 32 KB，最大 1 MB（Zod `.max(1_048_576)` + 运行时 `HARD_CAP_BYTES`）；缺失文件返回 `errorKind: 'not_found'`，目录返回 `not_a_file`
- 原语 Phase 1 **不提供并发锁**：同一 skill 对同一 path 的 `skill_write_artifact` 并发写以最后赢家为准；若未来某 skill 证实需要原子性，按需引入文件锁或 `mkdtemp + rename`
- 原语曝光受 `filterSkillPrimitivesBySession` 管控：只有当 session 有 active execution 或者 `skill-reference-hints` 登记过 `lastReferenceSkill` 时才对 LLM 可见；`clearAllReferenceSkillHints` 在 `cleanupAgentRuntime`（app 退出）触发，`sweepExpiredReferenceSkillHints` 随 `SkillsRuntimeManager` 的小时级 TTL sweep 一并跑，idle 超过 30 分钟的 hint 被淘汰

## 7. 新功能开发最小闭环
新增跨进程功能时，至少同步修改：
1. Main IPC handler
2. Preload API
3. Renderer 类型声明
4. Renderer 页面或组件
5. 至少一份相关文档

## 8. 协作文档索引
- 项目说明：`PROJECT_OVERVIEW.md`
- 开发文档：`DOCUMENTATION.md`
- 经验文档：`LESSONS_LEARNED.md`
- 开发进展：`PROGRESS.md`
- 模块地图：`FEATURE_MODULE_MAP.md`
- 依赖地图：`DEPENDENCY_MAP.md`
- 结构快照：`PROJECT_STRUCTURE_SNAPSHOT.md`
- 更新日志：`CHANGELOG.md`

## 9. 常用命令
```bash
npm run dev
npm run typecheck
npm run test
npm run verify
npm run build
```

## 10. 提交前检查
- `npm run typecheck` 无错误
- 关键页面可正常渲染与切换
- Browser / Agent / Settings 关键链路至少做一次基础回归
- 若改动跨多层，必须同步更新根目录协作文档

## 11. 当前关键日志
- Agent / 浏览器决策：`<系统临时目录>/ready-directchat.log`
- 工具执行：`<系统临时目录>/ready-tools.log`
- BrowserView / popup：`<系统临时目录>/ready-browser.log`

> macOS: `/tmp/`, Windows: `%TEMP%`

> 调整 Browser Agent、远程 IM、会话 scope、BrowserView、AI provider 能力层、技能运行时等跨模块行为时，必须同步更新根目录协作文档。

## 12. 指引同步与实验页约定
- `CLAUDE.md` 与 `AGENTS.md` 的正文规则必须保持同步；如果一侧新增或修正约束，另一侧要在同次变更中补齐
- 两份文件允许的差异仅限标题、面向代理的称谓与必要的工具名映射，不允许出现实质性行为分叉
- 新增临时实验页时，优先采用 Renderer 内独立路由隔离，例如 `#/liquid-test`；不要替换默认入口，也不要改动现有工作台界面
