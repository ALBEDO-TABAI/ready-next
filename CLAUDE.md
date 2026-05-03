# Ready 项目协作指引（CLAUDE）

> 更新时间: 2026-04-16

## 0. 前置思考
请使用第一性原理思考。不要默认用户已经把目标、限制和最佳路径都描述完整；当目标不清晰时先澄清，当路径不优时先提出更好的方案。

## 0.5 战略级架构原则（不可绕过）

下列 6 条原则适用于本仓所有架构级改动。具体规则（§6.x、§10、§12 等）是这些原则在不同子系统下的展开；当具体规则与原则冲突时，以原则为准。每条原则的详细展开（反例、正例、自检问题、复发签名）见 `.claude/architectural-principles.md`。

1. **先合同，后代码。** 任何架构级 PR 开工前，先写"如果这个改动成功，CI 能机器验证哪几条合同"。合同写不出来 = 不知道在修什么 = 不开始。
2. **修根因，不修症状。** 看到 N 个相似 bug 时，先归并到根因簇再 PR。看到 1 个症状时，先问"它属于哪条根因的投影"。"先把这个 bug 修了下次再说" 是技术债的标准入口。
3. **拒绝 legacy 兼容分支。** `if (legacy) ...`、union 留旧成员不删、"暂时保留" —— 这些都是根因复发的种子。删除 legacy 词汇 / 路径 是合同的一部分，不是技术债。
4. **形态意识。** 抄 CC-Source / 任何外部"标准答案"前先问："它没这个问题，是因为根本没这个需求，还是因为它解得更好？" 前者照抄 = 引入复杂度，后者 = 解债。
5. **CI 强制 > 文档约束 > 人审。** 合同必须 CI 强制；CI 不行再用文档；文档不行才用人审。**永远不要用"我下次注意" 当解决方案。**
6. **跨边界状态一致性显式建模。** 任何 renderer ↔ main、main ↔ DB、main ↔ 文件系统、父任务 ↔ 子任务这类"一边先生成 / 一边后确认"的状态，都必须明确选择 temp-id 替换、持久化确认门、最终一致、或服务端 lazy create 之一；不允许裸 fire-and-forget 后靠重试碰运气。

为什么要立这 6 条？参考 `docs/superpowers/plans/2026-04-30-skill-runtime-residual-architectural-debt.md` §0 与 `docs/superpowers/plans/2026-04-30-skill-runtime-cc-source-comparison-and-ideal-architecture.md` §6——Layer 1 完成时识别出 26 项遗留架构债共享少数几条根因；按症状逐个补丁是战略级失败的稳定签名。

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

### 6.7 技能中心原则
- 系统级 embedded skills 与用户 custom skills 要分层管理
- Agent 调用 skill 时优先走统一 `skill_*` 工具，而不是绕到手工网页流程
- 更新 skill 管理逻辑时，要同时考虑运行时、UI、默认命令与说明文案
- **B Phase 4 起 `skill_executions` 状态机已退役**：`skill_submit_input / skill_submit_confirmation / skill_submit_agent_result / skill_restart_from_step / skill_cancel_execution / skill_get_state` 6 个 LLM-facing 工具全部删除；`skills:executions:*` IPC + preload + renderer type 一并退役；DB migration 029 `drop_skill_execution_tables` 会清掉 `skill_executions / skill_execution_steps / skill_execution_artifacts` 三张表。任何新增跨 session 的 skill 进度语义都走 in-memory `SkillTaskTracker`，不要再复活 workflow coordinator
- LLM-facing 的 skill_* 工具现在只剩：动态 `skill_<id>_<action>`（来自 manifest）+ primitive（`skill_ask_user / skill_run_shell / skill_write_artifact / skill_read_artifact / skill_patch_config / skill_start_detached / skill_inspect_detached / skill_cancel_detached / skill_inspect_run_state`）。primitive 的 session gating 迁到 `filterSkillPrimitivesBySession`，只有 session 有 reference-skill hint 或 running/blocked skill task run 时才曝光；静态 fallback 与 dispatch 必须使用同一判定，避免“列表可见但执行拒绝”
- Reference 技能（`runtime: reference` / `execution.mode: advisory`）被内联注入时，orchestrator 必须调 `skill-reference-hints.rememberLastReferenceSkill(sessionId, {id,name})` 登记；hint 既用于 primitive 工具曝光判定，也用于 30 分钟 TTL 后自动淘汰（`startReferenceHintSweep` 独立 setInterval，emit `skillReferenceHintTtlSwept` metric）
- Reference 技能内联注入走直读路径（`SkillContextOrchestrator.tryInlineReferenceSkillDoc` 读 `<managedPath>/SKILL.md` → role:'system' 注入，截断 12K 字符、emit `skill_reference_inlined` metric）；只有 readFileSync 失败或无 managedPath 时才回退到旧的 `skill_*_read_skill` tool-call 路径
- Embedded skill 迁移到 reference/advisory（Phase 2 起的 `video-copy-analyzer` 是首例）时，manifest 至少保留 `read_skill` action（`runtime: reference`, `visibility: internal`），删掉 `execution.workflowFile` 与 `skill.workflow.json`；SKILL.md 要按 Claude Skill 协议声明 `name / description / when-to-use` frontmatter
- 是否在 SKILL.md 正文里硬编码 `skill_run_shell` 的精确命令分两种：
  - **轻量方法论型**（如 `video-copy-analyzer`）：不写死命令，留给模型决定调用时机与参数
  - **prescriptive 长流程型**（如 `video-expert-analyzer-vnext`：staged 续跑、OpenClaw 接力、19 类视频路由）：允许 SKILL.md 内嵌精确命令；淡化 LLM 自由度反而会导致跳步
- Phase 3 后所有 embedded skill 都已迁移完毕：`video-copy-analyzer` / `video-expert-analyzer (vnext swap)` / `lets-go-rss (混合：read_skill default + 5 retained public python actions)`，仓库内不再有 `skill.workflow.json`；混合形态的判定标准 = 是否有非 LLM 产品代码直接 `runSkill(skillId, action)`（如 `item-analysis-manager.ts` 调 `video_expert_pipeline` / `video_expert_ai_analyze`，UI 快捷键 `/skill lets-go-rss rss_update {…}`），有就把对应 action 留作 `visibility: 'public'` 或 `'internal'`（按是否需要 LLM 看见决定），并写好 `scripts/ready_compat.py` 这类 entry-script 翻译层把旧 `--payload-json` 契约翻译成新 entry script 的 CLI 形态
- skill progress/stage 与 manifest action 是互不相交的命名空间：progress stage 只用于运行态展示、投影和恢复判断，runtime 不得把它拼成或暴露成模型可见的 `skill_<id>_<action>` 工具名；模型可见 action 只能来自 manifest action 或 primitive allowlist
- reference/advisory skill 的 `read_skill` action 在加载期统一归一为 `visibility: 'internal'`（包括旧 manifest 显式写过 `public` 的情况，避免 LLM 看到 `skill_<id>_read_skill` 并在循环里反复调用）；非 reference 的 typed public action 继续按 manifest 保持可见
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
- Phase 4 起 `skill_executions` 表和 `ttlSwept = 'skill_executions_ttl_swept'` 指标都已退役。仍需要 TTL 的只剩 reference-skill hints（in-memory Map）：`skillReferenceHintTtlSwept = 'skill_reference_hint_ttl_swept'` 由 `SkillsRuntimeManager.startReferenceHintSweep` 驱动，启动后 30s 首跑、之后每小时跑一次，30 分钟 idle 的 hint 被淘汰。ephemeral ask_user 记录（`eau-<8hex>`）继续用 `EphemeralExecutionStore`，完全独立于 SQLite

### 6.12 Skill 原语沙箱边界（B Phase 1）
- `skill_run_shell` 的基础命令白名单（18 个）：`python / python3 / node / bash / sh / curl / cat / ls / head / tail / grep / find / which / mkdir / pwd / echo / awk / sed`，维护在 `src/main/modules/tools/skill-primitives/run-shell.ts::SHELL_ALLOWLIST`；`host_requirements.shell_allowlist_extensions` 只会在当前 session 命中 active/reference skill 时临时并入 effective allowlist，不是用户级全局开关；`yt-dlp / ffmpeg / ffprobe / scenedetect` 不在基础白名单，直调时必须来自 scoped extension，脚本内部查找则依赖 runtime PATH；脚本必须通过 `bash scripts/x.sh` 或 `python scripts/x.py` 调用，不允许直接 `./scripts/x.sh`
- `parseCommand` 仍用于简单命令的双引号分词；简单命令里出现 POSIX 单引号或不平衡的双引号时抛 `CommandParseError`，handler 转换为 `errorKind: 'command_parse_failed'`。若命令包含 `cd`、`$VAR`、`&&`、管道、重定向，或是 `bash/sh` 包裹的 POSIX 单引号写法，或是 `python/node/grep/find/awk/sed` 这类脚本探针里的单引号片段，则由 `bash -c` 兼容执行，但仍拒绝 `rm/cp/mv` 这类破坏性文件命令
- `skill_run_shell` 的超时 kill：Unix 走 `spawn({ detached: true })` 并用 `process.kill(-pid, SIGTERM)` 杀整个进程组，覆盖 bash/sh 孕育的孙进程；5s 后若仍存活升级 `SIGKILL`；Windows 回退到 `child.kill`
- stdout / stderr 默认上限 8K 字符，超出时把完整内容写入 `<artifactRoot>/.logs/shell-<ts>-<uuid>-<stream>.txt` 并返回 `stdoutArtifactPath` / `stderrArtifactPath`；overflow 写入失败不吞掉命令主结果，通过 `stdoutArtifactError` / `stderrArtifactError` 暴露，同时 emit `skillPrimitiveRejected{reason:'overflow_artifact_write_failed'}`
- `skill_write_artifact` 只能写 `<artifactRoot>` 子树；绝对路径 / `..` 穿越 / symlink 逃逸 / 保留文件（`SKILL.md` / `ready-skill.json` / `skill.workflow.json` / `MANIFEST.json`，大小写不敏感）一律拒绝；单次写入字节上限 `WRITE_ARTIFACT_HARD_CAP_BYTES = 50 MB`，超出返回 `errorKind: 'size_limit'`
- `skill_read_artifact` 允许读 `<artifactRoot>` 下的任何文件；默认读 32 KB，最大 1 MB（Zod `.max(1_048_576)` + 运行时 `HARD_CAP_BYTES`）；缺失文件返回 `errorKind: 'not_found'`，目录返回 `not_a_file`
- `skill_patch_config` 只能修改当前 skill manifest 的 `host_requirements.config_repair.files` 明确声明的 JSON 文件；支持 JSON pointer `set/delete`、原子写入、回读校验，返回值必须 mask key/token/secret。配置校验不过只能保持 blocked，不允许说“已修复”
- 原语 Phase 1 **不提供并发锁**：同一 skill 对同一 path 的 `skill_write_artifact` 并发写以最后赢家为准；若未来某 skill 证实需要原子性，按需引入文件锁或 `mkdtemp + rename`
- 原语曝光受 `filterSkillPrimitivesBySession` 管控：Phase 4 起 session 的"有 active execution"信号永久 false（`skill_executions` 已退役），**primitive 的曝光条件 = session 有 reference-skill hint 或 running/blocked skill task run**；`clearAllReferenceSkillHints` 在 `cleanupAgentRuntime`（app 退出）触发，`sweepExpiredReferenceSkillHints` 由 `startReferenceHintSweep` 独立 setInterval 驱动（不再挂在 skill_executions TTL sweep 上），idle 超过 30 分钟的 hint 被淘汰，emit `skillReferenceHintTtlSwept` metric
- `skill_run_shell` 的子进程 `PATH` 由 dispatch 层（`skills-tools.ts`）自动前置 runtime bin + 共享 venv bin（`SkillsRuntimeManager.getRuntimeBinDir()` → `<runtimeRoot>/bin`，`getSharedVenvBinDir()` → `<venvRoot>/bin` Unix / `<venvRoot>/Scripts` Windows），确保 `yt-dlp / ffmpeg / ffprobe / scenedetect` 这类 runtime bin 和 `requirements.txt` 驱动安装到共享 venv 的 Python 依赖都可被脚本找到；handler 本身不做路径解析，缺失时走 no-op

### 6.13 Skill 长任务状态与续跑
- `run_state` / VEA 输出目录选择必须以 expected task id 为第一身份；恢复路径、tracker fallback、root `run_state.json` 只有在 task id 匹配或被标记为可信显式路径时才能算命中
- 用户通过附件 / `@[file]` / 当前文档 / 显式路径带入的 `run_state.json`，以及同一会话上一轮已打开或工具返回过的唯一 `run_state.json`，都是可信续跑句柄，必须进入 TurnFrame 并武装对应 reference-skill hint；但它只证明身份与恢复入口，VEA 真实进度仍以 `scene_scores.json` / `host_batches` 等产物核验为准
- 长任务预算模型固定为 `220` 硬上限 + 前台 lease 可续租窗口；UI 与任务投影不得把预算暂停或后台存活误判为完成
- continuation 全链路必须保留 durable skill handle：`pauseReason / detachedTaskId / taskRunId / jobId / skillId / action / runStatePath / outputDir / progressFingerprint`；即使没有 `executionId / todoId`，只要有这些 handle，也必须能构造继续入口
- skill 的 stage/progress 与 manifest action 是两个命名空间；runtime 不得把 `score_batches / merge_validate / finalize` 这类进度阶段拼成 LLM-facing 工具名，也不得为了续跑把 stage 注册成 action
- resume-only typed action 必须先解析 canonical child-run handle；缺少可信 `outputDir / runStatePath / sceneScoresPath` 时只能 blocked/checkpoint，不能用 `<runtimeRoot>/outputs/<skillId>/<childRunId>` 伪造新目录。`scripts/check-child-run-output-dir-fallback.cjs` 是硬门
- VEA scoring 前必须做 provider vision preflight；当前 agent/provider/model 不能被 stale `delivery_report.json` 或旧 VEA config 覆盖。未证明支持 image input 的 custom/openai-compatible provider 必须 blocked_config，不允许先启动 host batches 消耗预算
- checkpoint / done / cancelled / error 都是 terminal IPC 状态；跨 main -> renderer 的 `emitStatus` / scope-run event 必须保留 `terminalReason`，不能只传 terminal status。只有 `working` 允许裸 status；`scripts/check-terminal-reason-propagation.cjs` 是硬门，新增明确字面量 terminal status 时必须同步传 reason
- `doneEventType` 兼容参数已退役；错误结束的 output event type 必须由真实 status 推导，禁止 `status !== success` 却向 renderer 发送 done 形态。`scripts/check-emit-output-done-event-type.cjs` 是硬门
- 任务卡状态只能消费 supervisor / lifecycle / projection 的真实信号，不在 UI 新增完成判断；展示优先级为真实失败且无后台存活、后台运行、预算暂停、等待用户、完成、普通运行
- 任务卡中文状态标签固定为 `后台运行中` / `预算已暂停` / `等待补充` / `已完成` / `失败`；完成态只显示打开产物，不显示继续或重试；后台运行显示继续、打开产物、取消；预算暂停显示继续、重试、取消
- SQLite-backed 验收前必须先跑 `npm run verify:native`；该命令会在 rebuild 后用 Electron runtime 真实打开 `better-sqlite3` 并执行 smoke query。若 Electron ABI 下 native check 不通过，只能标记为 DB 路径未证明，不能算验收通过
- Ready 主应用启动时必须先通过 primary DB 硬门；`better-sqlite3` 加载、真实 `ready.db` 打开、迁移或 settings 表探测失败时必须弹原生错误并退出，不能进入 renderer 展示默认/空 AI 配置
- **Feature flags（生产降级开关）**：
  - `READY_SKILL_CHILD_INTERNAL_STRICT_ADMISSION`：默认 `'1'`，控制 child-internal tool 的严格 admission；`'0'` 退回到 telemetry-only 旧行为。
  - `READY_SKILL_CHILD_RESUME_ENABLED`：默认 `'1'`，控制 turn-engine 的 child resume 自动分支是否启用；`'0'` 时遇到 paused child + 用户 resume 意图也不会调 `resumeSkillChildRun`，turn 退化为普通 model 回复，emit `skill_child_resume_disabled_by_flag` metric。runner 自身的 `resumeSkillChildRun` API 不受影响。
  - `READY_OUTPUT_DIR_RETENTION_DAYS`：默认 `7`，控制 child-run outputDir 终态后的默认保留天数。
  - `READY_OUTPUT_DIR_LEGACY_GRACE_DAYS`：默认 `30`，控制无 `.lifecycle.json` 的 legacy outputDir 宽限期。
  - `READY_CHILD_RUN_LOG_RETENTION_DAYS`：默认 `30`，控制 `<runtimeRoot>/.ready/child-runs/*.jsonl` 日志保留期。
  - `READY_CHILD_RUN_CIRCUIT_BREAKER_ENABLED`：默认 `'1'`；`'0' / 'false' / 'off'` 可关闭 child-run circuit breaker。cooldown 状态只保存在当前 `SkillChildRunner` 进程内存中，紧急情况下重启 Electron 即可清空，不需要 reset API。
  布尔开关默认全开，问题出现切 `'0'` 即可，不允许通过删代码回退。

### 6.14 Coordinator role / DomainAdapter 抽象
- 每个产品（browser / document / skill / rss / calendar / feishu）通过实现 `DomainAdapter` 注册自己的 mode 行为：触发条件、提示注入、工具过滤、仲裁规则、用户文本润色、执行和投影；`turn-engine.ts` 只调度，不持有产品身份。
- 引入新产品 = 实现新 `DomainAdapter` + 在 host `domainAdapters` 注册；`turn-engine.ts` 不新增产品分支。
- 改产品行为 = 改对应 `*-domain-adapter.ts`，不能反向去 `turn-engine.ts` 内加产品 `if/else` 或 `adapter.id === '<product>'` 比较。
- CI 强制：`npm run verify:c`、`scripts/check-coordinator-isolation.cjs` 和 `ready/no-coordinator-id-leak` 必须阻止 `turn-engine.ts` 泄漏产品 id；通用 `TRIGGERS` 不承载 product module 规则；6 个 adapter 必须显式实现 `contributePromptFragment / arbitrateRunCapabilities / decorateUserText`。

### 6.15 System reminder / Compaction / Hook 三件抽象
- 所有进入模型输入的系统级提醒文案必须通过 `SystemReminderRegistry` 注册和组装，条目包含 `topic / priority / text / conflictsWith`；`turn-frame-steering.ts` 不允许内联写 `systemReminder: <提醒文案>`，`turn-engine.ts` 不允许直接 push `系统补充：` / `系统提醒：` 形态的内联 user message。CI 由 `ready/no-inline-system-reminder-write` 强制。
- reminder registry 是 per-turn / per-call 的一次性对象，不是全局 singleton；相同 topic 后注册覆盖先注册，输出按 priority 降序、topic 升序稳定排列。默认冲突表必须继续覆盖 child-owned 压制 typed-action-preferred / force-tool 系列提示，避免父循环和 child-loop 同时给模型相反指令。
- `createLayeredCompactor()` 提供 L1（字符串消息的 cheap 截断/摘要，幂等）+ L2（token-threshold gated，D 阶段 stub）。默认 L2 threshold 为 0，生产路径只启用 L1；连续 3 次 L2 失败后熔断并 emit `compaction_circuit_break`，单次 L2 失败 emit `compaction_l2_failed`。模型输入可使用压缩后的 session 副本，但不得把压缩结果写回持久会话消息。
- `HookRegistry` 固定 4 个 lifecycle 名：`pre_tool_use / post_tool_use / user_prompt_submit / stop`。`register` 返回 unregister，`fire` 串行 await；handler throw 或 timeout 只 emit `hook_handler_failed` / `hook_handler_timeout` 并继续后续 handler，不得中断 turn 主流程。
- Hook handler 的注册由具体 telemetry / observability / audit 需求驱动，没有 default handler 是合规设计。引入新 handler 的标准：(a) 该 handler 解决的需求当前用 metric / log 无法满足；(b) handler 必须 idempotent（fire 失败不能让 turn 挂掉）；(c) handler 必须有独立测试 + 在 PR 描述里写明"为什么 metric/log 不够"。禁止把 hook 当 logging 替代品。
- L2 实装的触发条件：(a) 生产中观察到 L1 后 messages 仍超 model context window 的实例 ≥ N 次/周（N 由当时观察决定，先不预设）；(b) 有用户报告"模型说"我已经忘了上文""的样本。触发后 land 必须配 e2e 测试覆盖 L2 in-loop 正确性，circuit-break 行为不变。
- `npm run verify:d` 必须内嵌 `npm run verify:c`，并覆盖 reminder registry、layered compactor、hook registry、turn-frame steering 与 turn-engine route 相关测试。

### 6.16 防爆 + 减脆（E 阶段）
- 状态类 JSON 写入必须走 `atomicWriteJson`（tmp write + fsync + rename）；文本/config 写入走 `atomicWriteText`。`scripts/check-atomic-write.cjs` 是硬门，`agent-control/` 与 `skills-runtime/` 内不得新增 JSON 直写。
- child-run outputDir 终态写 `.lifecycle.json`；默认保留 7 天，无 sidecar 的 legacy 目录有 30 天宽限。outputDir sweep 只扫 `<runtimeRoot>/outputs/`，不得递归误删 `<runtimeRoot>/.ready/child-runs/`。
- 新 child-run JSONL 写到 `<runtimeRoot>/.ready/child-runs/<childRunId>.jsonl`；resume reader 优先新路径，只有新路径缺失或为空时才回退旧 `<outputDir>/.ready/child-runs/<childRunId>.jsonl`，保证升级前暂停的 run 可续跑。
- retry policy 必须显式覆盖 17 个 terminal reason：`queued_global_concurrency` 保留 3 次、每次 5s 的重试语义；`nested_child_run_not_supported` 不重试；`resume_launch_failed` 走 2s / 10s 两次退避。
- 同一个 single-flight key 在 5 分钟内连续 5 次失败会进入 15 分钟 cooldown；期间返回软失败 `error.kind='circuit_break'` 并打 `child_run_circuit_break` metric。该状态是内存态，重启 Electron 会清空。
- child runner 执行动作必须走 `executeSkillActionViaToolGateway`，不允许再直接绕到 runtime `runSkill`；runner 通过 `childInternal: true` 与 `childInternalSkillAction` 上下文进入 gateway，再由 `tool-executor` 做 admission；implicit admission 只能作为安全兜底，不是主路径。
- `npm run verify:e` 必须内嵌 `npm run verify:d`，并覆盖 atomic write、outputDir/log lifecycle、legacy resume fallback、retry policy、circuit breaker 与 gateway admission 相关测试。

### 6.17 测试规约
- 新测试默认写行为测试：调用真实入口或最小替身，断言可观察结果；不要用 source-grep 伪装行为测试。
- 结构测试只保留给无法通过行为证明的硬契约；豁免必须写产品理由，禁止无理由 waiver。
- 破坏 singleton、全局状态、admission 或 lifecycle 的测试 helper 必须声明 `__breaksInvariants`。
- e2e 只用于真子进程、真实 runtime 或真实外部依赖边界；默认 opt-in，不拖慢常规 verify。
- 普通 Node 下的 `better-sqlite3` skip 只能证明 host-Node 测试未覆盖该路径；SQLite-backed 验收必须使用 Electron native gate（`npm run native:check` / `npm run verify:native`），不能用 skip 当通过。
- 详细规约、示例和运行模式见 `docs/superpowers/testing-conventions.md`。

### 6.18 提质 + 控制面（G 阶段）
- child-run close status 判定只从 `skill-child-run-types.ts` 的 helper 读取；其他文件不得再造 `TERMINAL_CHILD_CLOSE_STATUSES`，也不得新增散落的 `close.status` 字面判断。CI 由 `scripts/check-child-status-vocabulary.cjs` 强制。
- `resumeSkillChildRun` 成功续跑时返回 `freshContractFields`；turn-engine resume 分支必须整体应用该对象，禁止在 resume 分支手写 `childCloseEvent = closeEvent`。
- `SkillChildCloseEvent` 对外是 `DeepReadonly<>`，构造/解码出口统一 freeze；多个 awaiter 拿到的是同一个不可变 close event。
- `TurnFeatureFlags` 在 turn-engine `execute()` 入口 snapshot 一次，tool-executor 等下游只消费显式传入的 snapshot；禁止中途再调 `isXxxEnabled()` 读 env。
- child-run 调试控制面通过 `agent:listActiveChildRuns` / `agent:cancelChildRun` 暴露；取消来源必须区分 `source: 'nlp' | 'ui_button'`，并进入 `skill_child_run_cancel_requested` metric。
- `npm run verify:g` 内嵌 `verify:f`，并额外覆盖 status vocabulary、fresh contract、close immutability、turn flag snapshot、child-run IPC/control surface。

### 6.19 主进程稳定性与日志生命周期（J 阶段）
- 主进程必须在 `app.whenReady()` 前注册 `unhandledRejection` / `uncaughtException` / `render-process-gone` / `child-process-gone` 四类 handler。fatal 类错误必须尝试 bounded cleanup 后 `app.exit(1)`；Electron runtime-gone 类事件只记录和打点，不强制退出。
- 所有 `ready-*.log` 写入必须走 `createRotatingLogger`；禁止在 `src/main/` 新增绕过 helper 的 `appendFileSync` / `appendFile` `.log` 直写。`ready-design-run-captures.ndjson` 是本轮白名单，不按 `.log` 处理。
- process / log metric 保持在本地常量（`src/main/utils/process-metrics.ts`），不进入 `TOOL_ERROR_METRICS`；`scripts/check-process-handlers.cjs` 会阻止这类污染。
- `READY_LOG_MAX_BYTES` / `READY_LOG_MAX_FILES` 是支持的日志轮转阈值；默认 50MB、保留 5 个历史文件。`scripts/check-log-rotation.cjs` 必须阻止新增未轮转的 `ready-*.log` 写入。
- `npm run verify:j` 必须内嵌 `verify:i`，并覆盖 process handler gate、log rotation gate、J gates/focus。

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
npm run native:check
npm run verify:native
npm run typecheck
npm run test
npm run verify
npm run build
```

## 10. 提交前检查
- `npm run typecheck` 无错误
- 涉及 SQLite / 设置 / 本地持久化时，`npm run verify:native` 必须通过
- 关键页面可正常渲染与切换
- Browser / Agent / Settings 关键链路至少做一次基础回归
- 若改动跨多层，必须同步更新根目录协作文档
- 架构级改动必须能配对到 `docs/superpowers/plans/YYYY-MM-DD-*-implementation.md`；`*-arrangement.md` / `*-counterplan.md` 只作反提案，历史材料需在 frontmatter 标 `enforce: false`

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
