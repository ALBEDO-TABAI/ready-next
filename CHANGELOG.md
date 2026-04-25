# Ready V5 - 更新日志

## [Unreleased] - 2026-04-23

### Skill Runtime B — Phase 4 PR2（工具曝光与任务卡收口）

- **显式点名 skill 的工具清单收口**：`SkillContextOrchestrator.buildPreferredSkillToolNames` 不再把 `skill_get_state / skill_submit_* / skill_restart_* / skill_cancel_execution` 放回偏好列表；显式点名 reference skill 时同轮保留 `skill_ask_user / skill_run_shell / skill_write_artifact / skill_read_artifact` 四个 primitive，避免“读了 skill 但下一轮仍拿不到原语”
- **旧 custom `read_skill` 兼容修正**：`skill-compiler.ts` 与 `custom-skill-registry.ts` 在加载期把所有 `runtime:'reference' + name:'read_skill'` action 统一归一为 `visibility:'internal'`，包括历史 manifest 显式写成 public 的本地技能；非 reference typed public action 不受影响
- **会话生命周期与上下文工具桥接补齐**：`agent:newSession` / `agent:kill` / runtime cleanup 同步清 `reference-skill hint`、pending `skill_ask_user` 和 skill 任务投影；`executeSkillTool` 透传 AbortSignal 给 `skill_ask_user` / `skill_run_shell`；DirectChat host runtime 补 `getMemoryRepository()` / `getPromptAssembly()`，让 `memory_search` 不再因为 runtime 包装缺方法而失败
- **最小任务卡进度层落地**：新增 `SkillTaskTracker`，`skills-tools.ts` 在 skill action 与四个 primitive 后记录步骤、等待用户、错误和最近产物，并通过 `projectionPatch` 回到前端；先解决“完全没有进度”的可读性缺口，不复活旧 workflow state machine
- **shell 边界收紧**：`SHELL_ALLOWLIST` 移除 `rm / cp / mv`；LLM-facing schema/description、`AGENTS.md` / `CLAUDE.md`、`lets-go-rss` SKILL/README 同步改为 `bash scripts/x.sh` 或 `python scripts/x.py` 调用脚本，不再鼓励直接 `./scripts/x.sh`
- **Kimi 普通请求历史清洗**：修复“上一轮 Anthropic 工具调用历史被带进下一轮 Kimi Chat 请求”导致的 `invalid part type: tool_use` 400；Kimi Coding 与通用 OpenAI 请求都会先移除旧工具块并保留可读工具结果文本
- **重试轮 skill 识别补洞**：当用户只说“继续 / 再重试一次”时，运行时会把最近真实用户目标纳入 skill 识别；命中 `Video Expert Analyzer` 等 reference skill 后，用匹配到的历史目标注入 SKILL.md，并只偏好四个 skill primitive，不再把旧的 `system_run_embedded_python` 当入口
- **RSS 误触发收口**：`rss-analysis` trigger 不再匹配裸“分析”，必须出现 RSS/feed/订阅源等对象词或显式 `skill_rss_ / lets-go-rss`；新增 migration 030 修正已存在数据库里的旧 `(rss|订阅|抓取|分析)` 规则，避免 Video Expert 这类分析任务被标成 RSS 卡片
- **embedded skill managed 副本同步**：`SkillsRuntimeManager.listSkills()` 在返回 embedded skill 前会同步 app 管理目录里的 skill 文件，并用 `.ready-embedded-sync-state.json` 记录版本；源版本变化时会清掉旧 managed 目录再复制，防止旧 `skill.workflow.json` / 旧 SKILL.md 残留导致 inline 读到过期说明
- **显式 skill 意图优先续跑状态**：即使 prompt assembly 先给了 generic intent，执行层发现 registered skill token 后会把 primary domain 升级为 skill；“再重试一次”会优先复用最近点名的 skill 目标，不再被上一次 widget/RSS/document continuation 抢走
- **新增/改写回归**：补 `skill-session-cleanup-contract.test.ts`、`skill-task-tracker.test.ts`、`openai-history-sanitization.test.ts`、`skill-detection-inputs.test.ts`，并扩展 explicit skill 工具偏好、custom read_skill visibility、run-shell、lets-go-rss、DirectChat recall/memory 桥接等测试
- **验证**：`npm run typecheck` 通过；本轮关键目标测试 42/42 通过；`npm run test` 1514 case / 1478 pass / 36 fail，失败数与既有基线持平（新增测试均通过）

### Skill Runtime B — Phase 4 PR1（退役 `skill_executions` 状态机）

- **彻底删除 6 个 LLM-facing execution-control 工具**：`skill_get_state / skill_submit_input / skill_submit_confirmation / skill_submit_agent_result / skill_restart_from_step / skill_cancel_execution` 不再出现在工具清单；P1-pre-a 先把 4 个 primitive 的 `kind` 从 `'execution_control'` 切到独立 `'primitive'` 避免级联误伤，然后删掉 execution_control switch、`runSkillCoordinator`、`findExecutionForSession`、`formatExecutionDetail`、`createSkillExecutionOutput` 等函数
- **7 个 `SkillsRuntimeManager` execution API + coordinator/store 级联删除**：`listExecutions / getExecution / submitExecutionInput / submitExecutionConfirmation / submitExecutionAgentResult / restartExecutionFromStep / cancelExecution` 全部移除；`ExecutionStateStore` / `ExecutionCoordinator` / `NextActionResolver` / `toWorkflowRunResult` / `executeWorkflowRuntimeAction` 整体删除；`SkillRunResult.mode` 从 `'direct'|'workflow'|'reference'` 收窄为 `'direct'|'reference'`；`SkillRunResult.execution` + `.blocker` 字段退役
- **IPC / preload / renderer 类型面一次性收口**：7 条 `skills:executions:*` IPC handler（`ipc-handler.ts:106–210`）+ 7 个 preload 方法（`preload/index.ts:418–433`）+ `SkillExecutionBlocker / SkillExecutionStepRecord / SkillArtifactRecord / SkillExecutionDetail` 渲染端接口 + `SkillRunResult.execution/.blocker` 字段全部删除；`ChatPanel.handleRetryTask` 的 `restartFromStep` 分支退役，`applySkillExecutionDetailToScope` / `createTaskPatchFromSkillExecutionDetail` 孤儿函数一并清理；`ScopeRunTaskContinuation.executionId` 改为 optional（`parseTaskContinuation` 不再硬 return null）
- **sweep 拆迁**：原 `startTtlSweep` 同时清 `skill_executions` 终态行 + reference-hint；Phase 4 SQLite 清理没意义了，改为 `startReferenceHintSweep` 独立 setTimeout(30s) + setInterval(1h)，只跑 `sweepExpiredReferenceSkillHints()`；对应 metric 从 `ttlSwept = 'skill_executions_ttl_swept'` 重命名为 `skillReferenceHintTtlSwept = 'skill_reference_hint_ttl_swept'`，`skill-reference-hints.ts` 里直接 emit 并带 `removed / ttlMs / cutoffAt` payload
- **工具注册侧瘦身**：`skill-tool-session-gate.ts` 删除 `filterExecutionControlToolsBySession / shouldExposeExecutionControlTool / SESSION_GATED_EXECUTION_CONTROL_TOOL_NAMES`，只保留 primitive gating；`skills-tools-static.ts` 拆掉 `EXECUTION_CONTROL_GATED_TOOL_NAMES / EXECUTION_CONTROL_READ_ONLY_TOOL_NAMES`，`STATIC_SKILL_TOOL_NAMES_BOOT_SAFE` 等同于 `STATIC_SKILL_TOOL_NAMES`；Phase 1 沉淀下来的 `SkillToolDef / toAnthropicTool / toOpenAITool / toSchemaParam / ToolParam` 迁到新文件 `src/main/modules/tools/skill-tool-types.ts`
- **6 个源文件 + 1 个 prompt builder 整体删除**：`execution-coordinator.ts` / `execution-state-store.ts` / `next-action-resolver.ts` / `skill-execution-tool-defs.ts` / `skill-execution-missing.ts` / `schemas/skill-control-schemas.ts` + 孤儿 `skill-prompt-builder.ts`；`schemas/index.ts` 相应删 SKILL_CONTROL_SCHEMAS export；`shared/skill-execution-types.ts` 删除 `ExecutionFrame / ExecutionBlocker / ExecutionBlockerInputField / SkillExecutionError / SkillExecutionStepRecord / SkillExecutionState / SkillExecutionDetail` 7 个类型（保留 `SkillExecutionMode`、`SkillActionResult` 等其他消费者在用的类型）
- **DB migration 029 `drop_skill_execution_tables`**：按子→父表顺序 DROP `skill_execution_artifacts` / `skill_execution_steps` / `skill_executions` + 所有相关索引；所有语句 `IF EXISTS`，幂等；Phase 3 末已无新数据写入，残留行为历史痕迹，不可恢复；release note 需提示用户
- **tool-executor 的 `if (kind === 'skill_execution_missing')` 分支 + metric 同步下线**：`buildSkillExecutionMissingOutput` 删除后该 errorKind 不会再出现，`TOOL_ERROR_METRICS.skillExecutionMissing` 从 registry 里摘掉
- **测试改动（净 -11 case）**：
  - 删 10 份退役测试文件：`skill-execution-id-contract` / `skill-execution-id-generator` / `execution-state-store-ttl` / `skill-resolver-smoke` / `execution-tool-filter-skill-preservation` / `skill-control-schemas` / `skill-execution-missing-output` / `skill-execution-missing-reference-hint` / `skill-zod-golden-snapshot` / `skill-task-projection-contract` / `scope-run-state-clarification-mapping`
  - 改写 2 份：`skill-zod-param-derivation.test.ts` 只留通用 `describe()` 守卫用例；`paramList-to-zod.test.ts` 改用 `SKILL_PRIMITIVE_SCHEMAS` 做 round-trip；`skill-tool-gating-by-session.test.ts` 只覆盖 primitive gating；`tool-input-schemas-registry.test.ts` 只覆盖 primitive schemas；`tool-error-metrics-registry.test.ts` / `tool-error-metrics-contract.test.ts` 对齐新 metric 集；`skill-reference-output-contract.test.ts` 的 `mode?` 联合去掉 `'workflow'`；`run-resource-reaper.test.ts` 删 `manager.cancelExecution` 正则断言
  - 新增 3 份：`skill-execution-tools-removed.test.ts`（负向契约：6 个退役工具名不再出现在静态 registry / primitive defs / skills-tools 的 manager 调用）、`skill-reference-hint-sweep-independent.test.ts`（sweep 拆迁后源码契约 + emit metric）、`migrations-drop-skill-executions.test.ts`（3 case：fresh / idempotent / never-built）
- **全量验证**：`npm run typecheck` 双 project 无错；`npm run test` 1491 case / 1454 pass / 36 fail（与 main 基线 36 红持平）
- **未做 / 推迟到 PR2**：任务卡 todo projection（`skill-task-tracker` + `buildSkillProjectionPatch` 重写）；ask_user pending → `waitingFor='clarification'` 投影；3 个 embedded skill 集成回归的"任务卡 projection 非空"断言

### Skill Runtime B — Phase 3（video-expert vnext swap + lets-go-rss 混合迁移 + 跨技能回归）

- **video-expert-analyzer 整体替换为 vnext**（`/Users/user/Documents/实验田/video-expert-analyzer-vnext`）：
  - 26 个 vnext 脚本（`scripts/audiovisual/`、`host_batching.py`、`run_state.py`、`openclaw_dispatch.py`、`storyboard_generator.py` 等）+ `docs/`、`templates/`、`chart/` 全量拷入；旧 13 个 Python 脚本与 `skill.workflow.json` 删除
  - `ready-skill.json` 改写为 `execution.mode: advisory` + `defaultAction: read_skill`，3 个 action：`read_skill`（reference, internal）+ 2 个 `visibility:'internal'` python 兼容 action（`video_expert_pipeline` / `video_expert_ai_analyze`）
  - 新增 `scripts/ready_compat.py` 兼容适配器：把旧 `--payload-json {url,outputDir,sceneThreshold,bestThreshold}` 翻译成 vnext `orchestrate_vnext.py` 的位置/flag 参数；`item-analysis-manager.ts` 的 RSS 视觉分析路径无回归
  - SKILL.md 在 vnext 自带 `name + description` 基础上补 `when-to-use`，遵循 Claude Skill 协议；vnext 正文里大量精确命令保留（prescriptive 型 reference 技能允许内嵌精确命令，与 §6.7 描述一致）
  - 新增依赖：`anthropic / mlx-whisper / ffmpeg-python / browser_cookie3 / Pillow`，由共享 venv best-effort 安装；mlx-whisper Linux/Windows 装失败由 §6.11 错误回灌契约兜底
- **lets-go-rss 混合迁移**：
  - `ready-skill.json` 加 `read_skill`（reference, internal）action 并把 `defaultAction` 从 `rss_update` 翻到 `read_skill` —— 用户一句"用 lets-go-rss"会触发 orchestrator inline 注入 SKILL.md（含 Bot 推送规范严格 ❌ 列表），不再走"工具说明只够 LLM 自由发挥"的旧路径
  - 5 个 `skill_rss_*` python action 全部保留 `visibility: 'public'`（slash 命令 `/skill lets-go-rss rss_update {…}` / SkillsCenterPanel UI 快捷键 / `rss-domain-adapter` 的 `skill_rss_*` 偏好前缀 / 用户力肌记忆都需要）
  - SKILL.md 顶部加「执行原则」段落：优先 typed `skill_rss_*` 工具、复杂场景再 `skill_run_shell`、Bot 推送严格按下文规范执行、不替用户改 crontab；`when-to-use` frontmatter 同步补上
- **inline cap 评估后维持 12K**：vnext SKILL.md 表面看 17.8 KB（磁盘字节数），实际 JS string length 仅 10.4K UTF-16 code units（CJK 内容压缩），完全在现有 12K cap 内 — Phase 3 计划里"raise cap to 24K"的前置假设按字节算时被推翻，cap 不动
- **`ScopeRunWaitingFor.clarification` 类型在 4 个消费点完成传递**：Phase 1 给 `ScopeRunWaitingFor` 加了 `'clarification'` 但 4 处局部 union 没跟着，导致 `tsc --noEmit` 长期 2 红；本次顺手在 `turn-engine.ts:775` / `run-contracts.ts:659` / `domain-adapter.ts:21` / `browser-domain-adapter.ts:40` 一次性补齐
- **新增 e2e 3 份共 20 case**：
  - `embedded-skill-video-expert-vnext-swap.test.ts`（7 case）：manifest 3-action 形态、compat 适配器在位、orchestrate_vnext.py / docs 引用文件落盘、SKILL.md 12K cap 内不被截断、reference 路径不创 `skill_executions` 行
  - `embedded-skill-lets-go-rss-migration.test.ts`（4 case）：6-action 混合形态（read_skill + 5 retained）、`defaultAction = read_skill`、SKILL.md frontmatter `when-to-use` 就位、orchestrator inline 注入命中
  - `embedded-skill-batch-reference-migration.test.ts`（9 case）：3 个迁移技能共享同一份契约（advisory + read_skill default + 无 workflow.json + when-to-use frontmatter）
- **CLAUDE.md / AGENTS.md §6.7 同步**：新增一条「Phase 3 已完成 video-expert (vnext swap) + lets-go-rss (混合) reference 化；至此所有 embedded skill 均无 `skill.workflow.json`；prescriptive 型 reference 技能允许 SKILL.md 内嵌精确命令」
- **未做**：不引入 `runtime: 'handler'` 分支（spec §5.3 经评估为不必要 — Ready 主进程 `rss-engine` 服务用户 RSS reader，与 embedded `lets-go-rss` 多平台聚合 bot 是两个产品，不可机械等同）；不删除 `skill_executions` 表 / loader / `EXECUTION_TOOL_DEFS`（Phase 4 才退役）；不拆 `ready_pipeline.py`（vnext 自带 staged orchestrator 替代）
- 回归：全套 1522 case，36 红保持不变（与 Phase 0/1/2 audit 基线一致），3 份新 e2e 共 20 case 全绿；`tsc --noEmit` 双 project 干净

### Skill Runtime B — Phase 1 finalize + Phase 2 (video-copy-analyzer 机械迁移)

- **Phase 1 接线补齐**：`SkillsRuntimeManager.getSharedVenvBinDir()` 暴露共享 venv bin 目录（Unix `<venvRoot>/bin` / Windows `<venvRoot>/Scripts`），dispatch 层 `skills-tools.ts:505` 在调用 `executeRunShell` 时自动前置到子进程 `PATH`；修复 `skill_run_shell` 之前无法 import venv-installed Python 模块（yt-dlp / funasr / torch / …）的盲点。新增 run-shell mock-spawn 测试验证 PATH 注入顺序
- **Inline 注入上限 6K → 12K**：`REFERENCE_SKILL_INLINE_CAP_CHARS` 放宽至 12_000，容纳 `video-copy-analyzer` 这类体量较大的方法论 SKILL.md；同步更新 `skill-reference-inline-injection.test.ts` 截断断言
- **Phase 2 机械迁移 `video-copy-analyzer`**：
  - `ready-skill.json` 从 `execution.mode: workflow` + 3 个 python action 精简为 `execution.mode: advisory` + 单个 `read_skill` reference action（`visibility: internal`），删除 `execution.workflowFile`
  - `skill.workflow.json` 从仓库移除（reference path 不再读取它）
  - `SKILL.md` 按 Claude Skill 协议补齐 `when-to-use` frontmatter 字段；保留原方法论正文，不写死 `skill_run_shell` 的精确命令（遵循"skill 只做协议中性声明，调用由模型决定"原则）
- **新增 e2e 测试 `embedded-skill-video-copy-migration.test.ts`**（4 case）：
  - manifest 编译到 advisory/reference 且只剩 `read_skill`
  - `skill.workflow.json` 不再存在于磁盘
  - SKILL.md frontmatter 含 `when-to-use`
  - orchestrator 对该 skillId 走 inline-injection 路径（零 tool_use 往返）并调用 `rememberLastReferenceSkill`，让下一 turn 的原语 gating 放行
- **文档同步**：`CLAUDE.md` / `AGENTS.md` §6.7 补一条 embedded 迁移规范、§6.12 补一条 venv PATH 自动前置说明；inline 截断字符数 6K → 12K 同步；两份文件正文保持 lock-step
- 回归：全套 138 个 skill 测试 + 新增 4 case = 142 case 全绿；`npx tsc --noEmit` 对 B 改动文件干净（branch 上 2 条 `'clarification'` literal 残留错误是迁移前既存问题，与本次不相关）

## [2026-04-22]

### 重构

#### 工具错误契约 Phase 4：生命周期 + 观测性收口（stale-executionId 重构最终段）
- **Migration 028**：为 `skill_executions` 表加 `(status, finished_at DESC)` 复合索引，专门服务 TTL sweep 的 `WHERE status IN ('completed','failed','cancelled') AND finished_at < ?` 查询，确保扫描成本跟"过期集合"大小而非"全表"成正比
- **新增 `ExecutionStateStore.purgeExpiredExecutions(retentionDays = 7)`**：返回 `{ deleted, cutoff }`；默认保留 7 天。**关键约束发现**：当前 DB 从未执行 `PRAGMA foreign_keys = ON`（database.ts init 路径里没有），所以 Migration 018 的 `ON DELETE CASCADE` 实际是 no-op。方法里显式先删 `skill_execution_artifacts` + `skill_execution_steps`，再删 `skill_executions`，避免孤儿行；未来如果 PRAGMA 开启，先删子行仍然是安全的 idempotent 预清理
- **`SkillsRuntimeManager` 新增 `startTtlSweep()`**：构造函数里紧挨 `startScheduler()` 调用；boot 后 30s 首跑（不阻塞启动），之后每小时一次；单次失败只打 `console.error`，不 kill 其他调度
- **`generateSkillExecutionId()` = `'e-' + randomBytes(4).toString('hex')`**：新 executionId 形如 `e-9f3a2b1c`，日志里一眼可辨；旧 UUID 行继续兼容（`getExecution` 用 `WHERE id = ?` format-agnostic，`SkillExecutionIdSchema` 已是 opaque string 无 UUID 断言）。**踩坑**：`persistState` 用 `INSERT ... ON CONFLICT(id) DO UPDATE`，id 碰撞不抛 UNIQUE 违规而是静默覆盖；`createExecution` 里换成 `SELECT` 预检 + 3 次 retry，比依赖 UNIQUE 异常更可靠
- **新文件 `src/main/modules/agent-control/tool-error-metrics.ts`**：`TOOL_ERROR_METRICS` 只读常量对象 + `ToolErrorMetricName` 类型派生；6 个 entry（`surfaced` / `unknownSurfaced` / `inputValidation` / `resolutionViolation` / `skillExecutionMissing` / `ttlSwept`）；key 是 camelCase 代码符号，value 是 snake_case 字符串（保持历史 log 聚合查询不变）
- **4 个既有 emit 点换引用**：`tool-executor.ts:101/166`、`tool-runtime.ts:308`、`turn-engine.ts:352`；metric 字符串值未变，仅加了 `TOOL_ERROR_METRICS` import + 改引用
- **补 `skill_execution_missing` 打点**：`tool-executor.ts` catch 里当 `kind === 'skill_execution_missing'` 额外打点（携带 `toolName`/`sessionId`/`executionId` 自 ToolDomainError.detail），从此长尾频次在 `ready-agent-metrics.log` 可观测
- **补 `skill_executions_ttl_swept` 打点**：每次 sweep 完成后打 `{ deleted, retentionDays, cutoff }`
- **Feature flag 砍掉**：原 §8.2 预备的 `READY_SKIP_TOOL_INPUT_SCHEMA`、`READY_USE_RECOVERABLE_CAPSULE` 等都未落地也未新增；Phase 4 不引入任何新 env flag
- **文档 4 连发**：
  - `CLAUDE.md` 新增 §6.11「工具错误契约」（7 条 invariant）
  - `AGENTS.md` 同节镜像（§12 要求正文同步）
  - `DOCUMENTATION.md` 追加「工具错误契约」章节（核心 invariant + 相关文件 + metric 表 + 生命周期 + 调试入口）
  - `LESSONS_LEARNED.md` 首部追加「stale executionId 引发架构翻新 (2026-04-22)」一条（起因、分阶段思路、不做什么、踩坑固化规则、最终 invariants）
- **5 份新测试共 21 case 全绿**：
  - `error-contract.test.ts` 已有 15 case（Phase 3），无变化
  - `skill-execution-id-generator.test.ts` 2 case —— 1000 次生成 format + uniqueness
  - `tool-error-metrics-registry.test.ts` 4 case —— 6 个 key 齐、value 是 snake_case、value 去重、历史字符串稳定性
  - `execution-state-store-ttl.test.ts` 6 case —— in-memory FakeDb 跑真实 purge 逻辑（终态+cutoff 过滤 / 幂等 / 子表级联 / null finished_at 保留 / 空 db 零 DELETE / retentionDays 下界夹紧）
  - `tool-error-metrics-contract.test.ts` 6 case —— 源码 regex 锁 4 个 emit 点引用 enum 不引 literal、`skill_execution_missing` 紧跟条件分支、`ttlSwept` 三字段、scheduler 常量
  - `skill-execution-id-contract.test.ts` 3 case —— `generateSkillExecutionId` 格式、`createExecution` 预检 retry、`purgeExpiredExecutions` 子表在父表之前
- **合约微调**：Phase 1/2 的 `tool-executor-contract.test.ts` 3 处 regex 接受 literal 或 enum 引用，避免锁死成旧形式
- 全量 `npm test`：1344 pass / 36 fail（Phase 3 基线 1323/36 → 净 +21 pass，零新回归）；`npx tsc --noEmit` 对所有触动文件干净
- **重构完整闭环**：Phase 1 dispatch 吞异常 → Phase 2/2.5 dispatch 入口 Zod → Phase 3 IPC 分流 + 软失败胶囊 → Phase 4 生命周期 + 观测性收口 + 文档契约。起因的 "Agent 错误: Execution not found" 现在是一个 `TOOL_ERROR_METRICS.skillExecutionMissing` 打点 + 一条软失败胶囊，不再阻塞 turn

#### 工具错误契约 Phase 3：IPC `agent:error` 结构化 + 渲染端软失败胶囊
- 新增 `src/main/modules/claude-bridge/error-contract.ts`：`deriveAgentErrorContract(error, options?)` 纯派生函数，先用 `errorKindFor()` 从 ToolDomainError/ToolHostUnavailable/AbortError 派生 kind，再对 `tool_handler_failure` 退回 `classifyExecutionError` 细化到 rate_limit/timeout_model/timeout_tool/transient/auth/context_overflow/host_unavailable/unknown；recoverable 白名单：`rate_limit/timeout_*/transient/tool_handler_failure/未知领域 errorKind → true`，`auth/context_overflow/host_unavailable/aborted/unknown → false`
- 加宽 `direct-chat.ts` `emitRuntimeError` 签名为 `(error: unknown, options?)`，内部派生 contract 并 spread 到 `emit('error', { agent, runId, error, type, errorKind, recoverable, toolName })`；对应 `turn-transcript.ts` 和 `run-contracts.ts` 的 emitter interface 同步加宽
- `turn-engine.ts:1503-1522` 和 `direct-chat.ts:906-934` 两处 catch：recoverable 错误**不再**写 `transcript.emitOutput('API 请求失败...', 'error')` 红字，避免和胶囊重叠；直接把 Error 本体传给 `emitRuntimeError`
- `ipc-handler.ts:1113-1135` `agent:scopeRunEvent` 记录 payload 加 `errorKind / recoverable / toolName` 三字段（`agent:error` 通过 orchestrator `...payload` spread 自动携带）；`ScopeRunEventPayload` 类型在 `agent-control/types.ts:395-406` 同步扩展
- 新增 `src/renderer/modules/agent/types.ts` `SoftErrorInfo { message, errorKind, toolName, receivedAt }` 和 `ScopeRunState.softError` 可选字段；`createEmptyScopeRunState` 默认 `softError: null`
- `runtimeDriver.ts:340-488` `onError` 分流：① `errorKind === 'aborted'` 早返（cancellation 走 runComplete）；② `recoverable === true`（严格布尔 = true）只写 `softError`，**不**动 phase/error/blockedReason/toolTraceStatus，**不**调用 addMessage/persistAssistantMessageForRun，避免污染 10+ 个 `phase === 'error'` 下游消费点（run-coordinator / task-projection-sync / subtask-runtime 等）；③ terminal 保留原行为并额外 `softError: null` 清除遗留胶囊
- `scopeRunState.ts` 的 `deriveScopeRunStatePatch` reducer 同步：event 里 `phase === 'error' && recoverable === true` 才写 softError；其余 error 事件（包括 legacy payload 无 recoverable 字段）清空 softError
- 新组件 `SoftFailureCapsule.tsx`：琥珀色/暖色 pill，显示 `工具 X 暂时失败`、message、`errorKind` 小标签、`×` dismiss；`ChatPanel.tsx:3148` 挂在 `<ChatMessages>` 和输入区之间（同工具 trace 胶囊一层）
- useAgent store 新增 `dismissSoftError(scopeId)` action：仅清除 `softError` 字段，不触发其他状态重算
- Preload `src/preload/index.ts:144` 和 `src/renderer/types/electron.d.ts:727` 的 `onError` callback 类型加 `errorKind? / recoverable? / toolName?` 可选字段（legacy 主进程 payload 无这些字段时默认 terminal，确保 rollback 兼容）
- 3 份新测试共 28 case 全绿：`error-contract.test.ts` 15 case（覆盖 12 种 Error shape + tool name 覆盖 + 未知领域 errorKind 默认 recoverable=true）、`agent-error-ipc-contract.test.ts` 9 case（源码 regex 锁 main/renderer 两侧 wiring）、`agent-error-legacy-payload.test.ts` 4 case（legacy payload 走 terminal + 严格布尔检查 + preload 类型可选）
- 放弃原计划的 `READY_USE_RECOVERABLE_CAPSULE` feature flag：回滚面窄到 1 个 runtimeDriver 分支，不值为它养 test matrix
- `npm test` 总量 1323 pass / 36 fail（Phase 2.5 收官基线 1295/36 → 净 +28 pass，零新回归）；`npx tsc --noEmit` 对所有触动文件干净

#### 工具错误契约 Phase 2.5 PR 12：动态 skill-action 工具接入 Zod schema 缓存（Phase 2.5 收官）
- 新增 `src/main/modules/tools/paramList-to-zod.ts`：`paramListToZodObject(params: SkillParamDefinition[])` 为 `zodObjectToParamList` 的反函数；manifest 声明的 `params` 数组反向建 Zod schema；`string+enum → z.enum`、`boolean → LenientBoolean`（与 PR 2 `LenientBoolean` 语义对齐）、`object → z.record + optional .meta`、`array → z.array` 按 `items.type` 选元素类型；所有字段按 `required` 自动 `.optional()` 包裹 + `.describe()` 重新附加（确保 Zod v4 `.optional()` wrapper 上也能读到 description）
- `skills-tools.ts` 新增 `getSkillActionSchemas()`：按 `(skillId, actionName)` 缓存 manifest 派生出的 Zod schema；使用轻量 signature（tool name + 参数名/类型/必填组合）做缓存失效检测，比订阅 `SkillsRuntimeManager` 事件更便宜且覆盖 manifest 重载、skill 增删、visibility toggle；单个 manifest 失败被 catch，不影响整个 registry
- `tool-executor.ts` 的 dispatch 闸门现在合并静态+动态：`{ ...getSkillActionSchemas(), ...getToolInputSchemas() }`，**静态后置**以在名字碰撞时让 6 个控制工具永远胜出（防止用户 manifest 意外覆盖 `skill_get_state` 等）
- 2 份新测试共 11 case 全绿：`paramList-to-zod.test.ts` 8 case（各 type 分支 + enum + LenientBoolean + additionalProperties 往返 + 对 `SKILL_CONTROL_SCHEMAS` 的 6 个 schema 做 `zodObjectToParamList → paramListToZodObject → zodObjectToParamList` 往返相等）、`skill-action-dynamic-contract.test.ts` 3 case（source-level 锁 wiring + STATIC_TOOL_NAMES 不能 alias 到控制工具）
- `tool-executor-contract.test.ts` 的合约断言同步放宽以覆盖 PR 12 的合并调用（`validateToolInput(toolName, args, mergedSchemas|getToolInputSchemas())`）
- 扩 `zod-param-derivation.ts` 支持字段级 + 数组元素级的 `.meta({ additionalProperties: true })` opt-in（PR 10 里加的；PR 12 的反函数用同一 opt-in 契约）
- `npm test` 总量 1295 pass / 36 fail（PR 11 基线 1284/36 → 净 +11 pass，零新回归）；`npx tsc --noEmit` 对所有触动文件干净
- **Phase 2.5 收官**：所有 10 个工具域（skill control + memory + rss + calendar + session + file + document + feishu + browser-interaction + browser-content + system + dynamic skill-action）都在 dispatch 入口走 Zod 校验；从 Phase 2 基线 1101/36 → 1295/36（净 +194 pass，0 新回归）

#### 工具错误契约 Phase 2.5 PR 11：system 域 2 个工具接入 Zod schema
- 新增 `src/main/modules/tools/schemas/system-schemas.ts`：`SystemRunEmbeddedPythonSchema`（5 个 optional 字段：code / scriptPath / args<string[]> / cwd / timeoutMs）、`SystemRunOpenclawSchema`（command required）
- **新增 `src/main/modules/tools/system-tool-defs.ts`**（纯模块）：仿 PR 6 抽 file-management-tool-defs 的做法，把 `SYSTEM_TOOLS` 数组 + `getSystemAnthropicTools / getSystemOpenAITools` 从 system-tools.ts 搬出，避免 golden snapshot 测试被 `getSkillsRuntimeManager → electron` 导入链挂掉；原 `system-tools.ts` 保留 `executeSystemTool` 执行逻辑并 re-export 这三个符号
- params 全切为 `zodObjectToParamList(SYSTEM_SCHEMAS[...])` 派生
- 注册：`schemas/index.ts` spread `SYSTEM_SCHEMAS`
- 3 份新测试共 7 case 全绿：`system-schemas.test.ts` 3 case、`system-zod-param-derivation.test.ts` 2 case、`system-zod-golden-snapshot.test.ts` 2 case（指向纯 defs 模块）
- `npm test` 总量 1284 pass / 36 fail（PR 10 基线 1277/36 → 净 +7 pass，零新回归）；`npx tsc --noEmit` 对触动文件干净

#### 工具错误契约 Phase 2.5 PR 10：browser_content_tasks 域 13 个工具接入 Zod schema
- 新增 `src/main/modules/tools/schemas/browser-content-schemas.ts`：13 个 Zod schema（collect_images / download_urls / extract_structured / scroll_collect / start_task / get_task / resume_task / cancel_task / aggregate_results / download_gallery / research_topic / run_workflow / execute_js）
- **扩 `zod-param-derivation.ts` 支持 `additionalProperties` opt-in**：新增 `metaAdditionalPropertiesOf(node)` 读 Zod v4 `.meta({ additionalProperties: true })`；字段级和数组元素级都能把 `additionalProperties:true` 派生到 `SkillParamDefinition`，然后由 `buildToolParamSchema` 继续 forward 到 LLM 层。4 个工具用到：`extract_structured.fields` / `aggregate_results.items` / `run_workflow.steps` 是数组元素 opt-in，`start_task.payload` 是字段 opt-in
- **刻意不让 `z.record` 默认 emit `additionalProperties:true`**：之前 PR 6-9 已用 `z.record` 但 hand-rolled 不带 `additionalProperties`，如果默认加这个字段会把那些域的 LLM-facing 输出整体 drift；改成 opt-in 通过 `.meta()` 才给出
- `browser-tool-catalog.ts` 的 13 个 content_task entry 的 `params` 全切为 `zodObjectToParamList(BROWSER_CONTENT_SCHEMAS[...])` 派生
- 注册：`schemas/index.ts` spread `BROWSER_CONTENT_SCHEMAS`（至此 9 个域全部接入统一 registry）
- 2 份新测试共 20 case 全绿：`browser-content-schemas.test.ts` 9 case、`browser-content-zod-param-derivation.test.ts` 11 case（含 3 个 `additionalProperties` 派生 case）
- `npm test` 总量 1277 pass / 36 fail（PR 9 基线 1257/36 → 净 +20 pass，零新回归）；`npx tsc --noEmit` 对触动文件干净

#### 工具错误契约 Phase 2.5 PR 9：browser_interaction 域 25 个工具接入 Zod schema
- 新增 `src/main/modules/tools/schemas/browser-interaction-schemas.ts`：25 个 Zod schema（navigate / search / get_tabs / read_page / click{,_text,_at} / type{,_smart,_at} / compose_message / capture_viewport / probe_workflow_state / locate_action_targets / locate_input_targets / analyze_viewport / list_upload_targets / upload_scope_attachment / scroll_at / send_keys / ask_user_takeover / query_gemini / wait{,_for_condition} / go_back）；shared `TabIdOptional = z.string().optional().describe('标签页 ID，留空则使用当前活跃标签页')` 收 ~20 份重复
- `browser-tool-catalog.ts` 的 25 个 interaction entry 的 `params` 全切为 `zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS[...])` 派生；13 个 content_task entry 保持 hand-rolled（留给 PR 10）
- **手动字节对比**：swap 前后 `getBrowserAnthropicTools()` 对 25 个 interaction 工具的输出经 `diff` 确认逐字节一致
- 注册：`schemas/index.ts` spread `BROWSER_INTERACTION_SCHEMAS`
- 2 份新测试共 38 case 全绿：`browser-interaction-schemas.test.ts` 13 case（按关键语义抽样，覆盖必填/enum/数组/对象）、`browser-interaction-zod-param-derivation.test.ts` 25 case（全工具 `deepEqual` hand-rolled）
- **省略全量 golden snapshot**：25 工具 LLM-facing 输出单独 inline ~660 行噪声大于信号；派生测试 + 未变动的 `toSchemaParam/normalizeAnthropicToolSchema` 管道 + npm test 下游合约测试（tool-gateway-registry 等）三者叠加已足够兜住 byte drift
- `npm test` 总量 1257 pass / 36 fail（PR 8 基线 1219/36 → 净 +38 pass，零新回归）；`npx tsc --noEmit` 对触动文件干净

#### 工具错误契约 Phase 2.5 PR 8：feishu 域 16 个工具接入 Zod schema
- 新增 `src/main/modules/tools/schemas/feishu-schemas.ts`：16 个 Zod schema，按 Document / Message / Calendar / Chat / File 五个操作族组织；shared `ChannelId = z.string().describe('飞书频道 ID')` 收 16 个工具共用的 channel_id 参数
- `src/main/modules/tools/feishu-tools.ts` 的 `FEISHU_TOOLS` 16 个 entry 的 `params` 全切为 `zodObjectToParamList(FEISHU_SCHEMAS[...])` 派生；原 ~200 行 hand-rolled 参数阵列删除
- 注册：`schemas/index.ts` spread `FEISHU_SCHEMAS`
- 3 份新测试共 23 case 全绿：`feishu-schemas.test.ts` 5 case（按操作族分组）、`feishu-zod-param-derivation.test.ts` 16 case（含 attendees array<string> 派生）、`feishu-zod-golden-snapshot.test.ts` 2 case
- `npm test` 总量 1219 pass / 36 fail（PR 7 基线 1196/36 → 净 +23 pass，零新回归）；`npx tsc --noEmit` 对触动文件干净

#### 工具错误契约 Phase 2.5 PR 7：document 域 15 个工具接入 Zod schema
- 新增 `src/main/modules/tools/schemas/document-schemas.ts`：15 个 Zod schema；widget 相关的 `componentSpec / componentSpecPatch` 用 `z.record(z.string(), z.unknown())` 派生到 `{type:'object'}`，不递归展开 properties，与旧 hand-rolled 字节等价
- `src/main/modules/tools/document-tools.ts` 的 `DOCUMENT_TOOLS` 15 个 entry 的 `params` 全切为 `zodObjectToParamList(DOCUMENT_SCHEMAS[...])` 派生；原 ~130 行 hand-rolled 参数阵列删除
- 修复合约测试 `document-widget-system.test.ts#documents local inline interactivity in document widget guidance`：旧断言只读 `document-tools.ts` 源码匹配 `HTML\/SVG\/本地交互脚本`；PR 7 后该字符串搬到 `schemas/document-schemas.ts`。断言改为读取两个文件拼接后匹配，保证 guidance 字符串的契约不因 SSOT 位置变化而断
- 注册：`schemas/index.ts` spread `DOCUMENT_SCHEMAS`
- 3 份新测试共 31 case 全绿：`document-schemas.test.ts` 14 case、`document-zod-param-derivation.test.ts` 15 case、`document-zod-golden-snapshot.test.ts` 2 case
- `npm test` 总量 1196 pass / 36 fail（PR 6 基线 1165/36 → 净 +31 pass，零新回归）；`npx tsc --noEmit` 对触动文件干净

#### 工具错误契约 Phase 2.5 PR 6：file_management 域 7 个工具接入 Zod schema
- 新增 `src/main/modules/tools/schemas/file-management-schemas.ts`：7 个 Zod schema（search / locate / get_backlinks / get_graph / classify / rename / move）；数组用 `z.array(z.string())`，object 用 `z.record(z.string(), z.unknown())`
- **新增 `src/main/modules/tools/file-management-tool-defs.ts`**（纯模块）：把 `FILE_MANAGEMENT_TOOLS` 数组 + `getFileManagementAnthropicTools / getFileManagementOpenAITools` 从 `file-management-tools.ts` 抽出，避免 golden snapshot 测试经由 `getSearchEngine` 触发电子导入链（和 Phase 2 抽 `skill-execution-tool-defs.ts` 同一手法）；原 `file-management-tools.ts` 保留执行逻辑并 re-export 这 3 个符号维持公开 API
- params 全切为 `zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS[...])` 派生；`toSchemaParam` 对数组强制 `items:{type:'string'}` 的旧行为保留，与 Zod 派生输出同构
- 注册：`schemas/index.ts` spread `FILE_MANAGEMENT_SCHEMAS`
- 3 份新测试共 16 case 全绿：`file-management-schemas.test.ts` 7 case、`file-management-zod-param-derivation.test.ts` 7 case（含数组 items 派生）、`file-management-zod-golden-snapshot.test.ts` 2 case（指向新的纯模块）
- `npm test` 总量 1165 pass / 36 fail（PR 5 基线 1149/36 → 净 +16 pass，零新回归）；`npx tsc --noEmit` 对触动文件干净

#### 工具错误契约 Phase 2.5 PR 5：session 域 1 个工具接入 Zod schema
- 新增 `src/main/modules/tools/schemas/session-schemas.ts`：`SessionSearchSchema` 含 `sourceKind` 枚举（`local / channel`）、`hasAttachments` boolean、`limit` number，与旧 hand-rolled 对齐；文件留作 session 域后续工具（`session_inspect` 等）的落地点
- `src/main/modules/tools/session-recall-tools.ts` 的 `session_search` entry 的 `params` 切为 `zodObjectToParamList(SESSION_SCHEMAS.session_search)`
- 注册：`schemas/index.ts` spread `SESSION_SCHEMAS`
- 3 份新测试共 7 case 全绿：`session-schemas.test.ts` 4 case、`session-zod-param-derivation.test.ts` 1 case、`session-zod-golden-snapshot.test.ts` 2 case
- `npm test` 总量 1149 pass / 36 fail（PR 4 基线 1142/36 → 净 +7 pass，零新回归）；`npx tsc --noEmit` 对触动文件干净

#### 工具错误契约 Phase 2.5 PR 4：calendar 域 5 个工具接入 Zod schema
- 新增 `src/main/modules/tools/schemas/calendar-schemas.ts`：5 个 Zod schema（`CalendarListWindowSchema / CalendarCreateEventSchema / CalendarUpdateEventSchema / CalendarDeleteEventSchema / CalendarCaptureSessionSchema`），全 string 参数，无枚举，与旧 hand-rolled 字节等价
- `src/main/modules/tools/calendar-tools.ts` 的 `CALENDAR_TOOLS` 5 个 entry 的 `params` 全切为 `zodObjectToParamList(CALENDAR_SCHEMAS[...])` 派生
- 注册：`schemas/index.ts` spread `CALENDAR_SCHEMAS`
- 3 份新测试共 12 case 全绿：`calendar-schemas.test.ts` 5 case、`calendar-zod-param-derivation.test.ts` 5 case、`calendar-zod-golden-snapshot.test.ts` 2 case
- `npm test` 总量 1142 pass / 36 fail（PR 3 基线 1130/36 → 净 +12 pass，零新回归）；`npx tsc --noEmit` 对触动文件干净

#### 工具错误契约 Phase 2.5 PR 3：rss 域 5 个工具接入 Zod schema
- 新增 `src/main/modules/tools/schemas/rss-schemas.ts`：5 个 Zod schema（`RssAddSourceSchema / RssFetchUpdatesSchema / RssSelectItemSchema / RssAnalyzeItemSchema / RssCaptureSessionSchema`），描述与 required 顺序对旧 hand-rolled 逐字节一致；`analysisType` 保留 `z.string()` 不加 enum，以维持 byte-equivalence（枚举收紧留作后续 PR）
- `src/main/modules/tools/rss-tools.ts` 的 `RSS_TOOLS` 5 个 entry 的 `params` 全切为 `zodObjectToParamList(RSS_SCHEMAS[...])` 派生
- 注册：`schemas/index.ts` spread `RSS_SCHEMAS`
- 3 份新测试共 12 case 全绿：`rss-schemas.test.ts` 5 case（必填、optional、空对象、analysisType 要求 string）、`rss-zod-param-derivation.test.ts` 5 case（含两个空 params 工具）、`rss-zod-golden-snapshot.test.ts` 2 case（`getRSSAnthropicTools / getRSSOpenAITools` byte-lock）
- `npm test` 总量 1130 pass / 36 fail（PR 2 基线 1118/36 → 净 +12 pass，零新回归）；`npx tsc --noEmit` 对触动文件干净

#### 工具错误契约 Phase 2.5 PR 2：memory 域 4 个工具接入 Zod schema
- 新增 `src/main/modules/tools/schemas/memory-schemas.ts`：`MemoryCreateSchema / MemorySearchSchema / MemoryUpdateSchema / MemoryListRecentSchema` 4 个 Zod schema 作为 SSOT；共享 `SourceTypeEnum` 收敛重复枚举；描述与 enum 值对旧 hand-rolled params 逐字节一致（golden snapshot 双侧锁定）
- 扩 `SkillParamDefinition`（`src/shared/skill-execution-types.ts`）加可选 `items?: Record<string, unknown>` 与 `additionalProperties?: boolean`，与 `./tool-schema.ts::ToolParamSchemaSpec` 对齐，但保持旧代码零行为变化（两个字段都是 optional）
- 扩 `zod-param-derivation.ts` 的 `ZodArray` 分支：解析 `def.element` 获取元素 schema 并调 `resolveParamType` 递归得到 `items: { type: <element> }`；元素未知时退化到 `{type: 'array'}` 不带 items；skill 域原有派生无回归
- `src/main/modules/tools/memory-tools.ts` 的 `MEMORY_TOOLS` 4 个 entry 的 `params` 字段全切为 `zodObjectToParamList(MEMORY_SCHEMAS[...])` 派生；hand-rolled 参数阵列删除
- 注册：`src/main/modules/tools/schemas/index.ts` spread `MEMORY_SCHEMAS` 到 `STATIC_TOOL_INPUT_SCHEMAS`
- 3 份新测试共 13 case 全绿：`memory-schemas.test.ts` 7 case（形状、enum、tags 必须数组、memory_id 必填、strip 未知键）、`memory-zod-param-derivation.test.ts` 4 case（`deepEqual` 旧手写 params）、`memory-zod-golden-snapshot.test.ts` 2 case（`getMemoryAnthropicTools / getMemoryOpenAITools` byte-for-byte lock，commit 在派生切换前）
- `npm test` 总量 1118 pass / 36 fail（PR 1 基线 1105/36 → 净 +13 pass，零新回归）；`npx tsc --noEmit` 对所有触动文件干净

#### 工具错误契约 Phase 2.5 PR 1：dispatch 闸门去域限定 + 统一 schema 注册表
- 新增 `src/main/modules/tools/schemas/index.ts`：`STATIC_TOOL_INPUT_SCHEMAS` 以 spread 汇聚所有域的 Zod 注册表，`getToolInputSchemas()` 访问器而非常量导出 —— 为 PR 12 的动态 skill-action cache merge 预留无冷路径注入口
- `src/main/modules/tools/tool-executor.ts` 闸门从 `if (definition.domain === 'skill')` 改为域无关：`validateToolInput(toolName, args, getToolInputSchemas())` 每次 dispatch 都跑；未注册的工具由 validator 的 passthrough 分支兜住，行为对非 skill 域零变化。失败 `logAgentMetric` payload 新增 `domain: definition.domain`，为后续按域统计失败率做铺垫
- 新增 `src/__tests__/tool-input-schemas-registry.test.ts`（4 case 全绿）：锁定 6 个 skill 控制工具名都在注册表里、访问器返回可安全 spread 的普通对象、无重复键、每个 schema 是带 `safeParse` 的 ZodObject
- 扩写 `src/__tests__/tool-executor-contract.test.ts` 的 gate 断言：用 `assert.doesNotMatch(...)` 反证旧的 skill-only 守卫已消失，用 `assert.match(source, /domain:\s*definition\.domain/)` 锁定新 metric 字段
- `npm test` 总量 1105 pass / 36 fail（Phase 2 基线 1101/36 → 净 +4 pass，零新回归）；`npx tsc --noEmit` 对所有触动文件干净
- 后续 PR 2-12 按计划 `~/.claude/plans/generic-enchanting-gosling.md` 的易到难顺序推进：memory → rss → calendar → session → file → document → feishu → browser(interaction) → browser(content_tasks) → system → skill-action(动态)

#### 工具错误契约 Phase 2：6 个 skill 控制工具接入 Zod schema 双向契约
- 新增 `src/main/modules/tools/schemas/skill-control-schemas.ts`：6 个 execution-control skill 工具的 Zod schema 作为单一真源；`SkillExecutionIdSchema` 用 `trim().min(1)` 拒绝空串/纯空白；`LenientBoolean` 用 union literals 复刻 `asBoolean` 的 `true/'true'/'1'/1` 全覆盖（不使用 `z.coerce.boolean()` —— 它会把 `"false"` 错判为 true）
- 新增 `src/main/modules/tools/tool-input-validator.ts`：纯函数 `validateToolInput`，失败返回 `errorKind: 'input_validation'` 的结构化 ToolExecutionOutput，最多报 10 条 issue，text 中文格式便于模型自纠
- 新增 `src/main/modules/tools/zod-param-derivation.ts`：Zod v4 兼容的 `zodObjectToParamList(schema)`，走 `.description` accessor + `.meta()` fallback；支持 12 类节点（ZodString/Boolean/Number/Object/Record/Array/Optional/Default/Enum/Literal/Union/Pipe），未识别节点抛错
- 抽出 `src/main/modules/tools/skill-execution-tool-defs.ts`：把 `EXECUTION_TOOL_DEFS + toSchemaParam/toAnthropicTool/toOpenAITool` 从 `skills-tools.ts` 移到纯模块，同步把 6 个 defs 的 `params` 切为 `zodObjectToParamList(SKILL_CONTROL_SCHEMAS[...])` 派生，杀掉双源漂移
- `src/main/modules/tools/tool-executor.ts` 加入 skill-domain-gated 校验闸门（在 `getToolDefinition` 后、`switch` 前）：失败 `logAgentMetric('tool_input_validation_failed', {...})` 并提前 return；成功用 `args = outcome.data` 保留 transform 值。dynamic skill-action 工具无 schema 登记则 passthrough
- 4 份新测试 + 1 份扩展（共 27 case 全绿）：`skill-control-schemas.test.ts` 11 case、`tool-input-validator.test.ts` 5 case、`skill-zod-golden-snapshot.test.ts` 3 case（LLM-facing 输出 byte-for-byte 锁定，commit 在派生切换前）、`skill-zod-param-derivation.test.ts` 7 case、`tool-executor-contract.test.ts` 扩 1 case
- `npm test` 总量 1101 pass / 36 fail（Phase 1 基线 1074/36 → 净 +27 pass，零新回归）；`npm run typecheck` 对所有触动文件干净
- 参考 `plans/2026-04-22-tool-error-contract-refactor.md` §6 与 `~/.claude/plans/generic-enchanting-gosling.md`；后续 Phase 3（IPC errorKind）/ Phase 4（TTL + 观测收口）按 plan 推进

#### 工具错误契约 Phase 1：dispatch 层吃掉所有 throw，tool-runtime 不再把未分类错误当致命错误
- 新增 `src/main/modules/tools/tool-errors.ts`：`ToolDomainError`（带 `errorKind + detail`）、`ToolHostUnavailableError`（终结类）、`ToolAbortError`；`isTerminalInfrastructureError` 基于 `error.name === 'AbortError'` / `instanceof ToolHostUnavailableError` 做 minify 安全的终结判定
- `src/main/modules/tools/tool-executor.ts` 的 `executeToolCall` 外层包 try/catch：dispatch switch 的任何 throw 默认被兜成带 `errorKind: 'tool_handler_failure'` 的 `ToolExecutionOutput` 回给模型；只有终结类才继续冒泡。同步 `logAgentMetric('tool_error_surfaced', ...)`
- `src/main/modules/agent-control/tool-runtime.ts:289-316` 翻转默认值：`kind === 'unknown'` 不再 `throw error`，改成结构化返回 + `logAgentMetric('tool_error_unknown_surfaced', ...)`；catch 入口先 `if (isTerminalInfrastructureError(error)) throw error` 放行 AbortError / HostUnavailable，保证 outer batch runner 的 interrupt 语义不变
- 新增 `src/__tests__/tool-executor-contract.test.ts`（7 case 全绿）锁定错误契约；`npm run typecheck` 对触动文件干净；`npm test` 总量 1074 pass / 36 fail，基线 1072 / 38，净 +2 pass / -2 fail，36 项失败与本次无关（预存 electron 导入链问题）
- 参考 `plans/2026-04-22-tool-error-contract-refactor.md`，后续 Phase 2-4 按 plan 分 PR 推进

## [Unreleased] - 2026-04-21

### 修复

#### 浏览器左侧拖拽调宽时的假 chrome / 原生页面错位
- BrowserView 拖拽链路现已去掉“renderer 再等一帧 + main 再等 16ms”的双重延后：拖拽中的 bounds 变化直接沿现有按帧拖拽节拍同步到原生宿主，不再让标签栏和浏览器页面持续错半拍
- `useBrowserViewBounds` 新增 drag-reason 分流：只有真实拖拽会绕过额外的 bounds rAF，点击收放等非拖拽过渡仍保留原有调度路径，避免把其他场景一并放大成高频 setBounds
- 主进程 `BrowserHostLayoutService` 不再对 transient bounds 再做一次 16ms 定时合并；renderer 已经完成按帧合并，主进程只保留同几何去重，保证 BrowserView 跟随 DOM 外壳处于同一时间基准
- 已补充 / 更新 BrowserView 对齐合同测试，并通过定向合同回归与 `npm run typecheck:node`、`npm run typecheck:web`

## [Unreleased] - 2026-04-20

### 修复

#### BrowserView 启动恢复与新建标签重显回归
- `BrowserMode` 补回“延后一次宿主重显”的轻量兜底：当浏览器模式已进入稳定态、主进程标签恢复完成或新活动标签刚创建后，会在短延时后再次执行 `fitActiveTabToBounds + visible(forceBoundsSync)`，避免 BrowserView 停留在隐藏态，必须手动点标签才出现
- 这次修复只落在 renderer 的 BrowserView 重同步层，没有改动主进程标签生命周期、BrowserView hide/show IPC 顺序和现有 mode-switch 显隐协议
- 新增/更新合同测试，锁定“启动恢复 / 新建活动标签后必须补一次延后重显”，防止后续再把这条恢复链路删掉
- 浏览器冷启动在主进程没有真实标签时，现已只在首次进入浏览器模式时自动补开默认首页；不再显示一个可点按的“假标签”等用户手动点一下才开始工作
- 启动中的 starter tab 现在保留视觉占位，但点击已禁用，避免用户在运行时尚未准备好时误触发一次额外的首页创建
- 普通切标签不再复用 BrowserView 的“hidden -> fit -> visible”启动恢复链路；该三步流现在只在进入浏览器/恢复真实宿主时触发，切换标签只保留轻量对齐，消除切标签时一闪而过的空白壳层
- 主进程 `BrowserTabShellService.switchTab()` 现已改为“先显示新标签，再移除旧标签”，避免切换时出现真实 BrowserView 真空期；对应服务单测同步改成新顺序

## [Unreleased] - 2026-04-19

### 修复

#### 主题启动 FOUC 与昼夜切换过渡偏色双收口
- `index.html` `<head>` 新增内联 bootstrap 脚本：在 CSS 解析之前同步从 `localStorage` 读 `ready-theme` / `ready-theme-skin` 并落到 `<html>` 的 `data-theme` + `data-skin`，消灭"首帧命中 `:root` 纯白 + 无 liquid-glass token"的调试态白屏；CSP 维持 `'unsafe-inline'`
- `styles/index.css` `:root` 追加 `color-scheme: light dark`（dark 主题下覆盖为 `dark`），让原生滚动条 / 表单控件在首帧就按正确配色渲染
- 引入 `--ritual-overlay-bg` 代理 `--workbench-mode-bg`，`ritual-overlay.css` 的 theme-transition 背景与 `ritual-reduce-flash` keyframe 改用这一 token；过渡中途色从与画布冷暖不一致的 `--bg-primary`（liquid-glass+light 下为 `#F7F9FC` 冷白）修正为实际画布色（light 暖米 `#F6F1E7`、dark `#192131`）
- `main/index.ts` 在非 macOS 平台依据 `nativeTheme.shouldUseDarkColors` 给 `BrowserWindow.backgroundColor` 上深/浅色，避免 Windows / Linux 窗口外壳先白一闪
- `renderer/main.tsx` 把启动主题写入从"主写入"降级为 `reconcileStartupTheme`：只在和 main 进程值不一致时才纠正 `data-theme`；fatal bootstrap 错误态改为按当前 `data-theme` 走深/浅两套 palette，不再暗模式下白底刺眼
- `stores/useTheme.ts` 删除从未被 setAttribute 的 `THEME_TRANSITION_ATTRIBUTE` 死代码
- 合同测试同步：`browser-startup-theme-contract` 放宽对旧常量的断言并反向断言其被移除；`theme-ritual-orchestration-contract` 新增 `--ritual-overlay-bg` 与 `color-scheme` 断言；新增 `renderer-startup-fouc-contract` 守住 head 内联脚本与 non-macOS 首帧色

## [Unreleased] - 2026-04-18

### 修复

#### Agent 文档 widget 修改链路 P2 四项收口
- `list_widgets` 输出升级为结构化 JSON 清单：含 `index / title / mode / componentHint / preview / hasState`；原有人类可读首行保留，方便 LLM 直接解析候选集
- `show-widget` fence 扩展可选 `component_spec` 字段：write 路径透传、parse 路径向后兼容，老 widget 无该字段时 `componentSpec === null`，不崩溃
- Widget draft 的 `targetWidgetTitle` 改为受控枚举：优先消费 `requestEnvelope` 里的 `widget_target` 资源；LLM 输出经 `resolveControlledWidgetTarget` 做大小写/子串归一，命中则落候选、未命中则进 reprompt 错误
- `buildDocumentPipelineInsight` 新增 `targetWidgetTitle` 窗口化：update 分支以目标 widget 所在段落为中心抽 ±2 chunk 作为 insight 上下文，未命中自动回退老 `buildFocusedDocumentContext` 路径
- `update_widget` 支持字段级 `componentSpecPatch`：pipeline 向 LLM 引导"小改动请输出 patch"；renderer 端读取目标 widget 现有 componentSpec → deepMerge（对象递归、数组整体替换、null 视为删除）→ 重编译 → 写回，老 widget 无 componentSpec 时给出明确拒绝消息

## [Unreleased] - 2026-03-15

### 新增

#### Agent runtime phase5 projection 真相收口
- `TurnEngine` 现在会把每轮真实执行过的工具结果透传给 domain adapter；adapter 优先读取 `projectionPatch`，否则才消费结构化 JSON 结果，不再从正文文本反推任务状态
- `SkillDomainAdapter` 已接住 skill 工具自带的结构化 patch；`RSS / Calendar / Feishu` 三个 adapter 也会把已执行工具轨迹转成稳定步骤与摘要
- `RunProjection` 已删除 browser / skill 文本 regex 兜底，renderer `scopeRunState` 也同步清掉 browser / skill 旧文本解析主路径；任务卡与任务面板继续统一以 projection truth 为准
- continuation 的 `Task ID / Execution ID` 文本控制协议仍留在 phase6，本次未改

#### Agent 运行时恢复与任务分层骨架
- Agent 主循环新增运行时恢复链路：模型请求现在会先走错误分类，再决定退避重试、上下文压缩重试或继续进入原有通道降级
- 保留原有 `execution-fallback-policy` 处理协议/通道不兼容，同时把运行时恢复拆成独立组件，避免两类问题继续混用
- 工具执行新增统一超时预算：查询、文档写入、浏览器交互、Skill、飞书分别走不同超时配置
- 工具并行策略从只读白名单升级为资源域标签分组，同域写入与交互型工具保持串行，跨域只读可并行
- 新增 `ToolRuntime`，把工具批执行的 allowlist 校验、资源域分组、超时恢复、cleanup 回收与结果归一化统一收口到单一运行时层
- 工具结果契约升级为 `ToolExecutionOutput`：主链统一消费 `text / shape / data / projectionPatch / interactionHint`，旧字符串工具结果由 `tool-executor` 自动包装兼容
- `ExecutionLoopOrchestrator.executeToolCalls()` 缩成薄代理，保留模型请求恢复；`direct-chat` 的 Anthropic / OpenAI / 文本桥接三条工具结果后处理改为共享批次消费逻辑
- runtime 产出的 `timeout / host_unavailable / auth` 恢复结果与文档 projection patch 都开始走结构化工具结果，但对 renderer / preload 仍保持现有 `tool_result` 兼容协议
- 预算默认值开始按任务类型分层：直答、短任务、多步任务、媒体任务不再共用同一轮次模板
- 主控事件链开始透传 `taskType / interactionState / budgetUsagePercent / recoveryHistory / degradationReason`
- 新增 `TaskTypeResolver`，并把它接入主链：低信号通用问题可直接走直答，不再一律落入工具循环
- 新增 `task_projections` 轻量任务看板表、repository 与同步器，运行中的任务摘要开始从 `ScopeRunSummary` 投影到独立持久层
- 主进程新增 `agent:listTaskProjections / agent:getTaskProjection`，preload 与 renderer 类型同步补齐，前台可以正式读取任务投影而不只靠旧的 run summary
- Ready 右侧 `TaskPanel` 已开始展示当前会话最近任务的任务类型、交互状态、预算进度与自动恢复记录；即使 live run 暂时不在内存里，也能读回最近任务步骤
- `TaskPanel` 现已支持直接从任务投影生成“继续任务 / 重试任务”草稿，最近任务不必先进聊天区任务卡才能接着做
- ChatPanel 里的任务卡也开始并入任务投影：持久任务与当前任务卡会补上任务类型、交互状态、预算占用和自动恢复提示，不再只显示旧摘要
- ChatPanel 现在还会用任务投影补足继续信息和恢复动作；即使旧摘要没把 continuation 写全，任务卡也能继续给出正确入口
- 本轮继续把第二阶段收口做完：`taskId` 现已成为正式任务主键，`RunCoordinator / execution host / run projection / task projection / continuation` 全链都开始显式透传它，`runId` 回到单次执行实例语义
- 新增正式 `task-execution-router`，`TaskTypeResolver` 的 `executionChain / preferredExecutor / degradationReason` 不再只停留在分类结果，而是开始真实驱动 `direct / tool_loop / planner / domain_executor / continuation` 五条执行链
- 新增最小 `StepPlanner` 路由输出：多步任务会先生成结构化步骤，再进入后续执行；继续任务恢复失败时也会显式写入降级原因，不再静默回落
- 预算运行时升级为三层：新增 `TaskBudgetRuntime / StepBudgetState / BudgetWarningLevel`，主链开始统一写回步骤预算、预算预警、只读轮次退还、暂停冻结与恢复继续
- `TaskPanel` 与任务卡本轮补显示当前步骤预算、预算预警和降级原因；继续/重试草稿会显式附带 `Task ID`
- `skill` 现已正式进入意图识别与任务路由：显式 skill / workflow / blocker 请求会走 dedicated skill executor，而不是继续混在 generic tool loop 里兜圈
- `RunCoordinator -> execution host -> DirectChatEngine` 新增统一 `TaskBudgetRuntime` 透传；执行诊断、任务投影和前台任务卡现在都能看到任务预算、步骤预算与 warning level 的同一份运行时真相
- continuation 入口不再依赖“继续/恢复”关键词：显式 `Task ID` 会优先恢复对应任务；聊天任务卡和右侧任务面板生成的继续/重试草稿都会稳定带回同一任务身份
- continuation phase6 收口已补完：控制行改为只按原始用户文本清洗，bootstrap 前缀继续原样保留；`session-continuity` 现已按 `taskId` 持久化多个 continuation snapshots，turn engine 不再把 `Task ID / Step ID / blockedReason` 重新塞回会话历史补上下文
- 恢复路由补齐指数抖动退避元数据，并在预算进入 warning 或已经发生恢复后把后续工具批次自动降为串行；`host_unavailable` 也会显式落成降级原因

#### Agent 架构对照研究文档
- 新增 `docs/superpowers/specs/2026-04-17-claude-code-agent-architecture-study.md`，系统研究 Claude Code 的主循环、工具契约、工具调度、会话持久化与子 agent 设计
- 新增 `docs/superpowers/specs/2026-04-17-claude-code-vs-ready-agent-gap-analysis.md`，把 Claude Code 与 Ready 当前主链逐项交叉对比，明确 P0/P1 结构缺口
- 新增 `docs/superpowers/specs/2026-04-17-ready-agent-runtime-realignment-design.md`，定义 Ready 下一版 agent 的目标分层：`AgentRuntimeFacade / TurnEngine / ToolRuntime / DomainAdapter / Transcript+Projection / Session+Continuation`
- 新增 `docs/superpowers/plans/2026-04-17-ready-agent-runtime-realignment-roadmap.md`，给出不做 big bang 的七阶段整改路线，后续 agent 主链收口改为按该路线推进

#### Browser 实时查询结果收口
- 浏览器实时查询现在会在浏览器域内收集网页证据，再由宿主发起一次“最终答复整理”请求；最终回复不再直接依赖工具循环里那段过程话术
- 浏览器工具循环里的步骤播报、文本桥接纠偏和其它过程性说明，不再默认混入最终 `finalText`；这些内容继续留在任务卡/工具轨迹里
- 浏览器域现在会稳定输出结构化任务投影，最终 `done` 事件也会带上浏览器任务标题、摘要和步骤状态，避免任务卡停留在“正在理解需求”
- renderer 在收到最终 `done / error / cancelled` 事件后会重新持久化一次 assistant 消息快照，消息上的任务卡不再冻结在较早的运行中状态

#### 文档深读后制卡 MVP
- 新增结构化文档意图 `document_read_then_widget_create`：像“先阅读当前文档，再做一个信息卡”这类请求不再只靠前 1200 字摘要和单轮大 prompt
- 新增 `DocumentTaskPipeline`，把这类请求拆成“读取文档 -> 提炼 insight -> 生成 componentSpec -> 写入 widget -> 保存文档”五段执行，并把阶段状态映射回现有任务卡
- renderer 侧新增 host-only `document.inspectActive`，主进程现在可以读取当前活动文档的完整快照，未保存草稿也能走深读链路
- 文档 pipeline 两轮模型请求现已支持独立阶段超时，不再只能吃 simple 请求默认 45 秒预算
- 同一会话里相同文档 + 相同问题的 `DocumentInsight` 现已做短期缓存，重复生成时会优先复用第一轮提炼结果，减少重复阅读与重复总结
- 新增 `document-sectioning`：长文档现在会优先按章节切块，章节过长再按段落/句子拆开；insight 阶段只把和问题最相关的片段送入第一轮提炼
- 文档 pipeline 现在支持部分成功降级返回：如果 insight 已完成但卡片阶段失败，会先把重点提炼结果回给用户；如果卡片草稿已生成但写入/保存失败，也会保留草稿结果，避免整轮白做
- 文档深读热路径已先异步化：`readDocxRawText` 和 `readDocumentEditableText` 不再用同步读取，先把 pipeline 会命中的读取路径从主线程阻塞里挪开一层
- 文档 pipeline 的阶段文案现在会带关键指标：例如 insight 阶段会显示共拆了多少段、实际用了多少段、是否命中缓存，前台任务卡不看日志也能知道这轮为什么快或慢
- 文档深读指标现已进入正式 `executionDiagnostics.pipeline.document`：状态层会保留当前阶段、切段数量、实际使用数量、是否命中缓存和切分方式，TaskPanel 已能直接展示
- 文档主进程的常用读取入口也继续异步化了：`document:read`、`document:list`、`document:parseDocx`、`document:parseXlsx` 现在都改成异步读取，减少打开文件和解析大文档时的主线程阻塞
- 卡片写回继续复用现有确定性文档动作：优先 `componentSpec`，最终仍走 `document.insertWidget` / `document.saveTab`

#### 文档多资源任务计划
- `request-envelope` 新增稳定 `resources[]`，每个附件、`@[文件]`、当前文档上下文和文档引用都会保留独立资源身份、顺序、正文与可写属性，不再在主进程入口阶段被揉成一段混合材料
- 新增 `DocumentTaskPlan / DocumentTaskJob`：显式“根据 A 在 B 中做卡片”、多来源、多目标或顺序型文档任务会先做资源角色绑定，再按 job 顺序执行
- 多 job 文档任务现已正式走“父任务总览 + 每个 job 一个 child task”的执行路径；单 job 保持原来的内联执行，避免把轻任务也强行拆成子任务
- 每个文档 child task 会持有自己的六步详情：`collect_materials -> build_insight -> compose_widget -> write_target -> save_target -> verify_result`；父任务只保留 job 级 overview 与最终收口
- 文档多 job 现在按 job 顺序 fail-fast：任何一个 child 失败都会立刻结束父任务，但已完成 child 的独立记录和父步骤回填会被保留
- 文档来源角色现已至少区分 `primary_source / secondary_source / target_document / ambient_context`；`current document context` 默认只作为环境信息，不能覆盖用户显式点名的来源材料
- 文档 insight 缓存键现已切到任务级：会带上 job 角色绑定、来源文本 hash、目标文档身份与当前步骤，避免源材料变化后继续复用旧 insight
- widget 草稿新增短期会话级缓存：如果 insight 已完成、草稿也已拿到，但写入或保存阶段失败，下一次重试会优先从草稿继续
- 文档结构化任务状态改为按计划步骤投影：`collect_materials -> build_insight -> compose_widget -> write_target -> save_target -> verify_result`，未开始步骤显示 `pending`，失败步骤显示 `blocked`

#### 实时外部信息查询路由
- 新增 `live-info-intent` 轻量语义判断：天气、新闻、股价、汇率、比分、航班、路况、空气质量、官网最新公告这类依赖最新外部信息的问题，不再要求用户显式写“打开网页/浏览器”
- `intent-classifier` 现已把这类请求优先归到 browser intent，避免“当前文档上下文”或“最近在改 widget”把实时查询误路由到 document/design
- `browser-task-planner` 现已支持“先搜索、再锁定可靠结果页”的工作流；没有显式 URL 时会先生成搜索词，再去权威或最新页面读取与核对
- 浏览器查询计划对这类请求的完成标准已收口成“已锁定可靠结果页 + 已读取与问题匹配的最新信息”，不再泛化成普通网页动作
- 新增回归测试，覆盖“今天广州天气怎么样”和“去中国气象台帮我看看”这类实时查询请求
- 补上浏览器工具缺失借口识别：像“虽然写了浏览器任务执行计划，但没有可调用的浏览器工具组结果返回”这类新变体，现已会触发原生工具回退/纠偏，而不是被当成正常完成
- 浏览器能力追问也已从执行链里剥离：像“你不能调用浏览器工具吗？”这类只是在问工具可用性的 meta 追问，不再误走 browser executor 并把 `memory_* / session_*` 当成“这轮唯一工具列表”念给用户
- 显式站点打开请求现已补齐到浏览器决策层：像“帮我打开 pinterest”这类没有直接 URL、但明确点名站点的请求，也会进入浏览器工作流并先解析官方入口
- 浏览器任务在原生 tools 回包里如果出现“零工具调用”，现在会强制进入一次纠偏重试；不会再把“这轮没有 browser_* 工具”这种解释性文本直接当成最终结果
- 浏览器工具发现链路已补结构化快照与分组诊断：每轮运行都会记录宿主可见工具组、实际下发名单、provider 请求/响应快照，以及逐组 `toolCount / schemaError / static fallback`，方便直接区分“宿主没给”“schema 掉光”还是“模型没调”
- OpenAI 文本工具桥接降级已改成“单次请求生效”：当轮 native tools 掉线时允许内部改走 text bridge 救场，但不会再把整段会话永久黏在文本桥接上
- 浏览器 schema 现已从执行器模块中拆到纯目录模块，`tool-registry` 不再通过 `browser-tools.ts` 反取 schema；技能组在 runtime 未就绪时会退回静态 execution-control schema，并把 fallback 原因写入运行诊断
- 当浏览器组被判定为可见、但最终工具名单里没有任何 `browser_*` 时，主链现在会显式记为 `tool_resolution_error` 并停止继续向模型发送假工具名单

#### 模型预设工作区与聊天快速切换
- 设置页的模型配置收敛为 `OpenAI / Anthropic / Gemini / 自定义` 四个入口，不再把 Moonshot、Fox、火山方舟等单独铺成一排
- 新增 `AIProviderWorkspace / AIProviderProfile`，把“前台管理的预设集合”和“当前生效配置”正式拆开
- 主进程新增 `settings:getAIWorkspace / settings:setAIWorkspace`，同时保留 `settings:getAIConfig` 作为运行时兼容出口
- 旧 `ai_model_config + ai_saved_configs` 会自动迁移到新的工作区结构；旧第三方供应商会并入“自定义预设”
- 每个预设新增 `showInChatSwitcher`，用户可以决定它是否出现在聊天区模型切换面板
- 聊天区底部模型入口现已支持真正切换默认预设，并在当前激活预设被隐藏时以“当前使用中”单独保留入口

#### 文档卡片头部动作
- 文档里的 widget 卡片现在统一拥有新的头部：左侧可直接点击重命名，右侧提供完整字样的 `引用` 与 `导出` 按钮
- 预览里的 widget 卡片也复用了同一套头部语言，不再只有渲染内容没有卡片级操作
- `引用` 会直接把当前卡片送进聊天输入区，方便继续让 agent 修改
- `导出` 已改为按单张卡片直接生成 `.png` 图片，不再把卡片另存为文档格式
- 卡片头部去掉了类型小胶囊，标题槽和右侧按钮改为同一水平线对齐，整体留白更紧致
- 交互型 widget 的当前状态现在会回传给文档层：导出图片时按当时状态出图，保存文档时会把当前状态一起写回文档，重新打开后能回到上次保存的样子

#### 浏览器能力层与任务续跑
- 主线并回 `browser-4-3` 的浏览器增强能力：新增结构化页面提取、滚动采集、研究型采集与后台任务续跑能力
- 浏览器工具链补充 `browser_extract_structured / browser_scroll_collect / browser_start_task / browser_get_task / browser_resume_task / browser_cancel_task / browser_aggregate_results / browser_download_gallery / browser_research_topic`
- 浏览器任务进度现已落库，应用重开后可恢复未完成的浏览器后台任务
- 浏览器权限策略改为“低风险自动放行，高风险显式确认”，同时补上窗口重绑与 BrowserView host 重新附着能力

#### 浏览器标签交互稳定性
- 浏览器标签切换新增“只接受最新一次切换结果”的顺序保护，避免快速切换时旧结果回写覆盖当前标签
- 标签重排现已真正打通 renderer 与 main：前端顺序变更会同步回写主进程标签顺序
- 顶部激活标签与 tab rail 新增更稳的宽度预留、拖拽保护与显式收藏入口，减少展开地址栏、切换标签和拖拽时的错位
- 浏览器运行态恢复继续以主进程真实 tabs 为准，并在 create / switch / close 后回拉后端真值，避免 renderer 本地状态漂移

#### Agent 长任务摘要与聊天任务区
- scope run 新增统一任务摘要字段：`taskTitle / taskSummary / steps / currentStepId / waitingFor / resumableActions / recentArtifacts / memoryCapture`
- 主进程新增 `agent:listScopeRuns`，renderer 刷新后可恢复当前频道的最近任务
- ChatPanel 新增 `当前任务 / 后台任务` 两块任务视图，tool trace 胶囊退居技术细节抽屉
- workflow skill blocker 现在会映射成聊天里的等待态，并提供继续、确认、撤销、补充等入口

#### 跨会话搜索 / 回看主链
- 会话原始真相继续保留在 `chat_conversations / chat_messages`，同时补上 `parentConversationId / lineageRootId / resumeTitle`，为后续 continuation / recall 归并立好骨架
- 新增 `chat_messages_fts`、`session_recall_metadata`、`session_recall_attachment_index` 三层索引，历史会话现在可按消息正文、标题、任务摘要、附件名检索
- 新增 `session_recall_vectors`，旧会话回看现在会为会话胶囊生成本地持久化向量，并在关键词检索之外追加余弦相似度补召回
- 主进程新增：
  - `searchSessionRecall`
  - `listRecentSessions`
  - `getSessionRecallCapsule`
  - `listAttachedSessionRecallContexts`
  - `attachSessionRecallContext`
  - `detachSessionRecallContext`
  - `resumeSessionCandidate`
- 新增模型工具 `session_search`：无 query 返回最近会话，有 query 走历史会话搜索；默认排除当前 scope 所在 lineage，并把 `semantic` 命中并回结果
- `RunProjection` 产出的新任务摘要现在会同步持久化到 session recall metadata，不再只留在运行时内存里
- `PromptAssemblyService` 已补上独立的“跨会话回看”注入段，当前轮显式挂入的旧会话胶囊会进入 prompt
- `PromptAssemblyService` 现已开始做保守自动跨会话召回：只在当前频道内挑 1 到 2 条高相关旧会话自动注入，不写回会话引用列表
- ChatPanel 已补上聊天内轻量入口：可搜索旧会话、引用到当前轮、展示已引用胶囊并支持移除

#### Agent Core Loop Ownership 收口
- 新增 `run-coordinator`，`runtime.sendScoped` 与 channel inbound 的单轮执行开始统一交给中间层处理
- 新增 `run-projection`，`ScopeRunSummary` 聚合与浏览器/skill 任务摘要推断开始从 `runtime.ts` 中拆出
- `ClaudeSdkOrchestrator` 新增 `executeAndCollect` 合同，开始作为 direct-chat 的 execution host bridge
- `DirectChatEngine` 开始复用 `execution-tool-policy`，先把 tool visibility / dispatch 决策从主循环主体里抽出第一层
- 文档域的章节改写 / 格式整理 helper 已迁到独立 `document-domain-helpers`，`DirectChatEngine` 不再内联持有这批文档解析与写回细节
- 浏览器工具循环里的“步骤推进 / 检查点提醒 / 次数上限总结”已收进 `BrowserDomainOrchestrator`，主循环主体继续回到执行宿主角色
- OpenAI 通道的接口选择、推理强度和文字工具桥接切换判断已迁到 `provider-runtime-resolver`，`DirectChatEngine` 继续缩回 execution host
- 文档工具循环里的 inspection 结果回显、补提醒、保存判定和完成收口已迁到 `DocumentToolLoopOrchestrator`
- 设计工具循环里的主版式去重、结果收口和完成判断已迁到 `DesignToolLoopOrchestrator`
- `RunCoordinator` 在 planning 阶段已开始直接写入正式任务标题与摘要，前台任务卡不再只看到泛化的“Prompt assembly ready”
- 浏览器 tool loop 的计划文案和迭代预算建议也已并回 `BrowserDomainOrchestrator`，`DirectChatEngine` 继续减少对 planner 细节的直连
- 文档 deterministic flow 完成时已开始输出正式结构化任务字段，前台任务卡不再只能靠自然语言总结去猜文档任务状态
- 文档与设计工具循环在“阻塞 / 完成”关键节点也已开始主动输出结构化任务字段，前台任务卡可更直接消费正式状态
- `execution-intent-resolver` 已开始接管“这轮到底是什么任务、该开什么工具规则”的判断，并修正浏览器工具可见性的时序
- 浏览器提示词细化与确定性执行也已继续并回 `BrowserDomainOrchestrator`，`DirectChatEngine` 进一步减少对浏览器细节的直连
- `skill-context-orchestrator` 已开始接管显式 skill 命中、视频下保留工具、技能工具可见性和 skill 上下文注入，主循环不再内联持有这整块技能判断
- OpenAI 请求主链已迁到 `openai-execution-client`，`DirectChatEngine` 不再内联持有这整段 OpenAI simple / text bridge / tools 调用与响应解析逻辑
- 补上两处已确认回归风险：
  - Kimi Coding 带工具请求重新补回 `User-Agent`
  - 显式技能命中现已支持“用 xxx”这类常见中文说法
- renderer 侧已补上文档/设计任务卡展示回归测试，确保前台继续优先消费正式任务字段
- 新增 Stage 5 预备文档，先把共享 iteration budget、并发非交互工具、context compression、provider fallback 统一化的入口和边界讲清楚
- Anthropic 请求主链已迁到 `anthropic-execution-client`，Kimi Coding 请求与视频上传已迁到 `kimi-coding-client`
- 视频提帧回退已迁到 `video-fallback-service`，`DirectChatEngine` 不再内联持有 ffmpeg 查找与视频拆帧逻辑
- tool 执行上下文现在统一通过 `tool-runtime-context-builder` 组装，主循环不再在多个分支里手写局部上下文对象
- 浏览器连续性注入、澄清短路、deterministic/tool-loop 分发与 fallback 文案已通过 `BrowserDomainOrchestrator.resolveExecutionDispatch` 统一收口，`DirectChatEngine` 对浏览器只保留固定分发流程
- 主进程结构化任务白名单现已接受 `skill`，skill 正式任务状态可以和 browser/document/design 一样走统一前台链路
- 阶段 5 已开始落地：新增 `run-budget-policy`，`RunCoordinator` 现在会为单轮执行补上统一预算 seed，并把预算状态带进 execution host
- 浏览器 / 文档 / 设计三条子域现已开始返回 budget hint，只负责建议 headroom，不再各自偷持预算

#### AI 能力分组与运行时开关
- AI 配置新增正式 capability group 概念，开始把“provider 兼容能力”和“业务能力分组”拆开处理
- 新增固定能力组：`browser_interaction / browser_content_tasks / document / rss / calendar / skills / memory / session_recall / channel_feishu / system_host / design_reserved`
- `ToolGateway` 已从工具目录升级为分组注册表，可按能力组产出模型可见工具集合
- `buildExecutionToolState` 已接入 capability resolution：浏览器交互与内容任务开始分组判断，飞书组会受渠道环境可用性约束，`system_host` 作为宿主内部能力保留在模型工具面之外
- 新增 `run-capability-controller` 作为运行前能力总控：`direct-chat` 现在先拿 initial/reconciled capability 结果，不再自己重复拼 `hasTools`、allowlist、环境摘要和 capability 日志
- 新增 `host-capability-dispatcher`：`system_run_openclaw` 与文档 format/rewrite 的 deterministic 直通已迁出主循环，`system_host` 现在在执行路径上也保持 host-only
- `ToolGateway` 新增 group schema/query 与 dynamic source 能力；`skills` 组现在会把静态 execution control 和运行期可枚举 skill action 一起纳入正式真相
- AI 设置页补上第一版“能力分组”开关和状态显示
- AI 设置页“当前状态”现在来自主进程 capability runtime snapshot，不再由 renderer 自行猜测飞书/浏览器环境和组状态
- 新增 `context-compression`，prompt 侧已经能对超长历史做压缩并回传 compression report；前台任务状态链保持不受影响
- 新增 `execution-fallback-policy`，OpenAI / Kimi / 视频提帧回退开始共用同一套 fallback contract，不再各自散着写判定
- 新增 `tool-parallelism-policy`，安全的只读工具现在可以按批并行执行，结果仍按原顺序回收
- `DirectChatEngine` 已开始把预算状态继续传入 execution host：单轮迭代数、工具调用数和并行批次会在执行过程中累积
- 前台状态层现已开始保留 compression / budget / fallback 这类次级诊断信息，但不会覆盖任务标题和任务摘要
- 一轮执行结束后，现在也会写回本轮实际消耗的 budget 使用结果，不再只有 planning 时的 seed
- Anthropic simple 请求里的视频提帧回退也已经并回 client，不再留在主流程里额外判断
- 浏览器 / 文档 / 设计三条子域给出的 budget hint 现在会真正被主流程消费，不再只是定义了接口但没人使用
- 当本轮剩余工具额度不够时，主流程现在会在边界处停下并给出预算已达上限的收尾提示，不再继续半截执行
- Kimi simple path 的 `Kimi -> Anthropic-compatible` 回退链也已并回 execution client；`DirectChatEngine` 不再私留这条简单路径特判
- planning / done 两头现在都会保留同一套 fallback 诊断字段：`happened / kind / attempts`
- 当当前工具批次已经把预算打满时，主流程会在这一轮末尾直接收尾，不再继续请求下一轮模型响应

#### Browser-Agent 统一运行时
- 新增 `browser-task-planner`，统一浏览器任务识别、连续性合流和执行路径选择
- 新增 `agent-runtime-adapter / page-state-service / evidence-service`，开始收口浏览器运行时、页面状态和证据判断
- `BrowserAgentRunner` 已开始复用统一页面身份与证据服务，不再只靠内部私有判断
- 浏览器 runner 现在会输出结构化 task payload；主进程会把这些字段映射进 `scopeRunEvent`，renderer 侧优先消费显式任务字段
- 浏览器短期连续性现已补上 `canResume / lastFailureReason / lastEvidence`，刷新后和继续任务时不再只剩零散阶段文本
- `BrowserPageState` 现已补齐 evidence / risks / continuity 摘要，上传、prompt、运行态和页面复用判断开始共用同一套状态
- 浏览器结构化任务 payload 现已补上 `blockedReason / taskContinuation / recentEvidence`
- Browser 模式页内新增轻量 diagnostics dock，可直接看到当前任务、页面状态、最近失败和继续/重试/回到目标页入口

#### 保守自动记忆沉淀
- ReflectionService 改为保守模式：只自动写入 `user_preference` 与 `summary`
- 自动写入会先做重复检查，不再把 `global_fact` 当作默认沉淀目标
- 聊天任务完成卡片可直接展示本次记忆沉淀，并支持确认、撤销、补充

#### Claude Skill Workflow 执行引擎
- 新增 `skill-execution-types.ts` 统一 skill / workflow / blocker / execution 类型
- 新增 skill compiler / loader，支持 `advisory / workflow / legacy direct` 三态兼容
- 新增 execution state store / coordinator / prompt builder，workflow skill 改为由宿主自动推进到 blocker
- 新增 execution 管理工具：
  - `skill_get_state`
  - `skill_submit_input`
  - `skill_submit_confirmation`
  - `skill_submit_agent_result`
  - `skill_restart_from_step`
  - `skill_cancel_execution`
- 新增 `system_run_embedded_python`，复用 skills runtime Python 解释器执行代码或脚本

#### Embedded Skill 协议资产
- `video-copy-analyzer` 新增 `ready-skill.json + skill.workflow.json + wrapper scripts`
- `video-expert-analyzer` 新增 `ready-skill.json + skill.workflow.json + wrapper scripts`
- `lets-go-rss` 新增 `ready-skill.json + wrapper script`，作为 advisory/direct runtime utility 使用

#### AI 供应商能力层
- 统一引入 `agentProtocol / wireApi / toolUseMode / visionMode / nativeVideoMode` 能力配置
- 设置页支持显式选择：`Agent 接口`、`OpenAI API 形式`、`工具调用`、`网页视觉`
- OpenAI 供应商默认模型列表补充 `gpt-5.4` 自定义模型名

#### OpenAI 兼容工具降级链路
- `fox / code.newcli.com/codex/v1` 现可被识别为 `responses` 通道
- 新增 `/responses` 事件流解析兼容，支持供应商在 `stream: false` 时仍返回 SSE 文本
- 新增文本工具桥接：当供应商不暴露原生 function tools 时，模型可通过 `:::tool_call ... :::` 触发本地工具执行
- 新增桥接纠偏：若模型在桥接模式下仍回复“没有工具”，系统会再次注入约束并要求重试
- OpenAI 风格工具 schema 现在会在发送前统一补齐缺失的数组 `items` 描述，降低第三方兼容通道因严格校验而直接拒收工具定义的概率

### 调整

#### 工作区四模块切换
- 主工作区在 `browser / document / rss / calendar` 间切换时，过场规则进一步收紧：
  - `document / rss / calendar` 之间改为真正的整块水平切换
  - `browser -> 非 browser` 改为浏览器保持原位不动、目标模块横向进入覆盖
  - `非 browser -> browser` 改为浏览器保持原位不动、当前模块横向退出露出
- 这层过场建立在原有四模块常驻壳层上，文档 / RSS / 日历等模块原有状态仍会保留，不会因为动画重新挂载
- 切换开始前不再同步等待新截图生成，连续快速点击时也会记住最后一次目标，减少“点了半拍才动”和中途点击被吞掉的手感
- 已撤回“真实双层页面切换”这一激进路径，继续以更稳的单层过渡为主，避免普通模块切换额外背上双重重界面渲染成本
- 工作台过场整体时长也进一步缩短，让普通页面切换更干脆
- browser 运行态改为优先复用已准备好的 tabs / host：已有 tab 可先做后台恢复，后续切回 browser 不再每次都回到冷启动节奏
- browser-enter 过场新增提前露出时机，原生网页会在离场覆盖层后面更早就位，减轻“动画先结束、网页后到”的割裂感
- 顶栏四模块滑块点击切换改为短促直达，拖动释放才保留 spring 回弹，减少顶部控件与主内容过场叠加后的拖泥带水

#### Claude / OpenAI 工具链兼容
- `direct-chat` 在视频输入场景下，为显式 `/skill`、手动阶段控制、embedded python 请求、活跃 execution 保留 tools
- OpenAI `chat/completions` 和 `responses` 请求前会自动修复缺失的 tool response history
- 文本工具桥接与原生 tools 现在共用同一套 skill 可见性过滤，不再把 internal action 暴露给模型
- workflow skill 的 execution 文本结果会进一步映射为聊天侧可恢复的任务摘要，而不只是一段工具输出

#### Skills Center
- 技能中心新增 Recent Executions 区域与 execution detail 卡片
- 支持在 UI 中继续提交 blocker：input / confirmation / agent result
- 技能卡片增加 execution mode 感知，workflow skill 默认走 execution 而不是直接 stdout/stderr 返回

#### Agent / Browser 调试口径
- `direct-chat` 运行日志新增 `toolCallTransport` 维度，便于区分原生工具与文本桥接
- AI 配置能力判断统一收口到共享层，减少在主进程、设置页、浏览器视觉和 RSS 子代理中的分散判断
- AI 设置页的模型配置区域改为紧凑卡片网格，并增加当前兼容状态 chips，减少超长胶囊和横向空耗
- 浏览器 diagnostics 返回值现在不只包含 host / preview / recent logs，也会带出当前任务、页面状态、连续性、最近失败和可恢复动作

#### RSS 浏览器主链
- 微博、抖音、小红书的更新链路进一步收口为应用内浏览器主链，不再把这三类来源视为 RSSHub 必需来源
- 新增“为 RSS 打开或复用目标账号主页”的浏览器入口；登录失效、验证拦截或页面异常时，RSS 可直接把用户带回 Ready 浏览器继续处理
- RSS 添加源提示、能力矩阵与刷新反馈已改成浏览器登录态语义，不再继续显示“需要 RSSHub”
- 当系统判断需要登录或扫码验证时，RSS 会直接弹出确认框，引导用户在应用内跳转到对应账号主页处理

#### 文档同步
- 根目录协作文档全部按 2026-03-07 当前代码状态刷新：架构、依赖、进展、经验、模块地图、结构快照已统一对齐

### 修复

#### BrowserView 可见性与工作台外框
- 浏览器主 host 新增 `hideActiveHost` 呈现闸门，避免 BrowserView 在切换到文档 / RSS / 日历后因异步加载完成重新浮到最上层
- 浏览器内容 bounds 支持顶部 inset，网页内容会上抬到上一行 chrome 的下边缘，地址栏可更贴近浮层覆盖效果
- 左侧 SidePanel 与右侧 ChatPanel 新增透明圆角外框壳，统一向文档模块的外缘圆角矩形靠拢，同时保持无异色底板
- BrowserMode 回场的 ready 定时器现已可清理，避免刚切离 browser 后旧定时器又把冻结层提前释放，减轻回场时的错层和后半拍加载
- 浏览器回场时现在只暂时收起顶部浏览器栏，不再把整块浏览器区域一起藏掉，避免浏览器内容被误判成“整块消失”

#### BrowserView 宽度跟随稳定性
- BrowserView 的 bounds 回写从延后批处理改为立即应用，避免左右拖拽工作台边界时顶部标签栏与底层网页内容出现“标签先动、网页后追”的错位与抖动
- 浏览器 bounds 同步不再跳过细小拖拽步进，拖动中的小幅宽度变化也会直接跟上；布局变化后的短时间内会持续跟踪一段，压低尾部回弹感
- 高频 bounds 同步改成单向直发，不再在拖拽过程中为每次宽度变化等待一轮主进程回包，进一步减轻浏览器内容区跟随时的卡顿和抖动
- 浏览器拖拽态冻结方案改为直接抓取“整块浏览器区域”的可见画面，而不再只抓内部网页视口；拖拽时展示的是完整区域快照，所以圆角、顶部与边缘不会再因为分层拼接反复出现白块、缺角或被咬一口
- 新增 `browser-resize-stability-contract`，把“宽度变化时浏览器 chrome 与网页表面必须同步”固化为回归检查

#### Workbench P1 卡顿收口
- `WorkbenchModeOutlet` 已从“四联横带平移”改成分层 keep-alive 场景：四个主模式继续常驻，但只有当前页、进入页、离开页短时参与过场，其余模式统一停画且保留本地状态
- 新增共享 `windowResize` hub，`ChatHeader`、`FilesPanel`、主 BrowserView bounds 和 RSS preview 不再各自重复监听 `window.resize`
- BrowserView 与 RSS preview 的边界同步现已统一为“一帧最多一次 + 收尾强制最终落点”；拖拽中的逐帧更新继续走 `transient`，结束后一定补 `settled`
- Browser bounds 去重现已区分 `transient / settled`，不会再因为几何值相同把最终精确落点跳过
- 工作台热路径里的 `transition-all` 已从文档标签、RSS 列表与预览、聊天输入与消息、文件树这些高频交互面清掉，避免把宽度、最小宽度、`flex` 等布局属性一起拖进动画
- 新增 `workbench-window-resize-contract` 与 `workbench-hot-path-transition-contract`，并同步更新 keep-alive / browser visibility / browser resize 稳定性契约

#### 文件管理下拉菜单完整显示
- 文件管理顶部的“筛选 / 更多”菜单改为顶层弹层渲染，不再挂在左侧栏裁切层内部
- 菜单位置改为按左侧文件面板的真实矩形计算，保持在左栏附近展开，但不再被 `overflow-hidden` 截掉
- 文件管理下拉菜单的勾选和图标强调改回中性风格，不再误带蓝色高亮

#### 浏览器冷启动与主题同步
- 浏览器冷启动改为让应用窗口正常出现，但在浏览器真正可用前先隐藏底层网页，减少“先看到标签栏骨架、再补网页内容”的分段感
- 浏览器 bounds 改为直接跟随可见浏览器容器宽度，避免右侧聊天栏、外层壳宽度混入后触发网页响应式边界跑偏
- 主题初始化改为先读取主进程持久化主题，再同步给 renderer，修正应用浅色但 BrowserView 内网页仍按深色判断的分叉风险

#### 文件管理与 Agent 聊天联动
- 文件夹现在可以从文件管理拖入 Agent 聊天框，附件条和 `@` 引用菜单都会保留对应目录路径
- 文件夹单击改为仅选中并展开/折叠目录，不再在文档模式误开不可编辑标签
- Agent 聊天头部补充快速折叠按钮，用户历史消息去掉底色，流式思考态换成更轻量的 inline 动效
- 文件面板新增轻量目录监听：会自动监听当前路径、固定目录和已展开目录，下载/移动/skill 产物落地后会自动刷新

#### 文档模块 PDF 预览
- `document:read` 在读取 PDF 时恢复附带原始字节，避免渲染层误把二进制文件当文本协议处理
- `PdfViewer` 改为优先消费 IPC 返回的 PDF 字节流，并兼容 `local-file://` URL 兜底，恢复 PDF 预览与阅读

#### RSS 的 B 站旧数据误判
- B 站刷新现在会把“上游接口返回旧内容”视为异常场景，不再继续把旧列表当成成功刷新结果
- 当应用内浏览器拿到的是“登录后你可以”这类未登录空页面时，系统会明确提示先去 Ready 浏览器登录，而不是继续默默显示“本次无新增内容”
- 若浏览器已经拿到可用页面，B 站刷新会优先改用浏览器结果，避免被旧接口长期卡住
- B 站抓取顺序已调整为先尝试最新投稿链路，再回落到旧的合集备用链路，避免像 `946974` 这类账号明明有 3 月 31 日的新视频，却被 1 月的旧内容抢先覆盖
- B 站走浏览器补救时，现在会自动补齐播放量和准确发布时间；列表展示也改回更易读的顺序，不再把“播放量 / 点赞 / 当日时间”整串塞进摘要

#### 工作台浅米色统一
- 去掉工作台主壳层的重分隔线与面板阴影，让顶部、侧栏、聊天栏和状态栏视觉上更连贯
- 文档、RSS、日历主内容背景统一向地址信息条使用的浅米色靠拢，日历大表格区域同步改为浅米色底

#### 文档预览增强
- 文档 `preview` 模式升级为结构化笔记预览，支持 YAML frontmatter 与顶部半结构化属性块
- 新增属性区、标签 chips、关联项 chips、YouTube 缩略图卡片，以及本地图片/视频嵌入预览
- 预览中的链接与 YouTube 卡片可直接打开，标签 chip 支持一键复制

#### 文档生成式 UI（show-widget）
- 文档 `preview` 新增 `show-widget` 围栏渲染，支持在正文中插入交互式 HTML / SVG / Chart.js 可视化组件
- 新增 sandbox iframe + receiver srcdoc 渲染链路，支持主题变量桥接、动态高度同步和 widget 内链接回到 Ready 浏览器模式
- 新增文档工具 `document_insert_widget`，agent 可以把标准 `show-widget` 围栏稳定写入原文档
- 修正文档任务工具过滤：`forceDocumentTool` 现在会真正收敛为文档工具集合，避免测试时把大量无关工具一起暴露给模型导致超时或走偏
- 修正 widget 写入幂等性：同标题 `show-widget` 现在会优先更新已有围栏并清理重复块，`append_content` 误走时也会自动合并而不是越测越多
- 新增 widget 维护工具：`document_list_widgets` / `document_update_widget` / `document_remove_widget`
- 新增 widget 写入质量校验，明显残缺的背景壳 SVG 会被拒绝写入，避免半成品直接落盘
- 对齐引用版本的文档底层行为：跨轮“修改 + 保存”现在会累计判断，不再因为分两轮执行而提前漏报完成；文档模式下发给 agent 的上下文会优先带当前文档正文；“根据某个文档生成信息卡”这类生成式 UI 请求也会更稳定地走文档工具链
- 编辑态 `show-widget` 现已折叠成可操作卡片，支持预览跳转、查看源码、复制源码、删除确认，以及一键把当前 widget 交给 agent 更新
- `show-widget` 现统一走 sandbox iframe 运行时，纯 HTML + 本地内联事件的计算器类 widget 也能在编辑态和预览态保持一致交互
- 新文档 `Ctrl/Cmd+S` 现改为弹保存位置选择；未保存草稿支持本地持久化恢复，并增加状态版本迁移
- 新增文档 widget 基线资产 [docs/DOCUMENT_WIDGET_BASELINES.md](/Users/user/Documents/ready-cowork/docs/DOCUMENT_WIDGET_BASELINES.md)，用于约束推荐 prompt、实现方式和后续回归

## [0.1.4] - 2026-03-06

## [0.1.5] - 2026-04-16

### 修复

#### Agent Core：预算与续跑真值
- 默认 scoped run 不再永久锁死在 `short_task` 预算；真实任务类型解析完成后，会回正到对应预算档位
- continuation 现在会恢复之前已经消耗的迭代、工具调用和并行消耗，并在剩余额度过低时补最小安全余量
- `reserveToolCalls` 预算提示已接入运行时，不再只是空接口

#### Agent Core：执行与交互控制
- 工具批执行已接入取消信号；取消后不会继续启动后续串行工具或下一批并行工具
- 冻结预算会真正停住工具循环，不再只是把 UI 标签改成 `suspended`
- 多步任务现在会在步骤完成提示或当前步骤额度耗尽时推进到下一步，并记录步骤摘要
- 通用文本回复里的“请补充 / 请确认 / 需要人工接管”会提升为结构化交互状态

#### 浏览器冷启动与首个标签页
- 浏览器冷启动不再自动打开默认外部网页，先稳定停在空状态，避免把“首个站点慢/失败”误判成浏览器整体没启动
- 空状态下地址栏现在直接接入真实导航链路，第一次手动输入网址就会创建首个标签页并继续后续跳转

### 调整

#### Agent / Task UI
- 新增 `agent:suspendRun / agent:resumeRun / agent:respondToInteraction` IPC 链路
- `TaskPanel` 与 `ChatPanel` 中的继续、暂停、确认、补充类按钮已改为真实运行控制，不再只是生成草稿文本

#### Agent Core：子任务与任务投影
- `task_projections` 已补上 `parent_task_id / parent_step_id / task_title / task_summary / recent_artifacts_json`
- child task 现在可以带独立 `taskId` 和父步骤引用运行，并把完成摘要与产物摘要回写到父任务步骤
- `runtime.sendScoped` / `RunCoordinator` 新增 `sessionIdOverride`，child task 现在可以沿用原 scope 发事件与写投影，同时切到独立 worker session 执行，不再和父任务共享同一个执行会话键
- 新增 `worker-session / subtask-runtime / worker-projection` 三个底层模块，统一生成 child identity、生命周期事件、父步骤等待态和 child 完成后的摘要补丁
- `run-projection` 已修正父子任务来回切换时的关联继承逻辑：只有同一 task 的连续事件才会沿用之前的 `parentTaskId / parentStepId`，避免 child 链接误挂到父任务摘要上
- `TaskPanel` 与 `ChatPanel` 改为优先读取 projection 持久化真值，不再默认以 scope run 文本摘要为准

#### Agent Core：运行级资源清理
- 新增 run-scoped cleanup registry，取消、失败和超时都会统一触发已注册的清理回调
- skill workflow 启动后会把活跃 execution 挂到当前 run 的清理注册表里，避免中断后留下悬挂 execution

### 变更

#### Browser Agent V7：任务图执行框架
- 浏览器上传型任务从“自由工具循环”升级为“任务理解 -> 计划生成 -> 分步执行 -> 结果复核”的四段式闭环
- 链接不再被视为立即执行指令，而是先进入任务资源，再按步骤图顺序导航与执行
- 任务图新增显式步骤：`resolve_target_page -> resolve_attachment -> navigate_target -> ensure_upload -> ensure_prompt -> submit -> final_reconcile`
- 每个步骤都带有 `goal / action / verify / skipIf / failIf / retryLimit / recoverWith`

#### 浏览器上传与页面证据
- 会话附件提升为浏览器任务的正式资源，图片单发继续只入会话，不自动执行
- 上传成功判定改为依赖页面级证据：缩略图、素材卡片、附件 chip、文件名等
- Prompt 注入与提交阶段引入更严格的输入框锚点与运行态验证

#### 远程 IM / 会话中枢
- Agent 聊天面板引入统一 scope，会话按“来源频道 + 线程 + agent”隔离
- 飞书远程线程进入前台会话列表，与本地会话共享消息流与运行态
- 远程图片单发只进入会话附件资源层，不再伪造成文本并立即触发 agent

### 调整

#### 日志与调试口径
- 浏览器决策日志新增 `mode / reason / attachmentCount / incomingAttachmentCount / targetUrl / stepCount`
- 浏览器 runner 日志切换为阶段日志：`[browser-v7][stage] ...`
- 关键排障日志统一聚焦：
  - `/tmp/ready-directchat.log`
  - `/tmp/ready-tools.log`
  - `/tmp/ready-browser.log`

## [0.1.4] - 2026-04-01

### 变更

#### RSS 底稿仓库与轻量更新
- RSS 条目已拆成“长期底稿”和“界面收件箱”两层：清空列表只会移除界面中的普通内容，不再删除长期底稿
- 收藏内容不再随“清空列表”一起消失；被保留的收藏在下一次进入 RSS 页面时仍会继续展示
- RSS 设置页新增“RSS 底稿”管理区，可查看各订阅源的底稿总量、界面收件箱数量、收藏数量和当前刷新方式
- 设置页支持“重置单个源”与“清空全部底稿”；重置后对应源会回到首次完整抓取状态

#### 小红书刷新风控收敛
- 小红书在首次补齐历史后，后续刷新会改成更轻的主页检查模式
- 后续刷新不再长时间等待，也不再用深抓方式反复探测历史内容，而是只取当前轻量可见的新内容
- 刷新写入统计已收口为“真正新增的内容数”，不再把旧内容重扫也算成新内容

## [0.1.3] - 2026-03-05

### 变更

#### Browser Agent 稳定性
- 工具循环上限从固定值改为按任务动态放宽
- 工具提示新增批量工作流建议，降低“达到最大工具调用次数”的中断概率

#### 浏览器工具能力
- 新增 `browser_collect_images`
- 新增 `browser_download_urls`

#### BrowserView 交互
- 新增中文右键菜单：后退、前进、刷新、缩放、链接/图片操作、网页另存为、打印、检查元素、开发者工具

## [0.1.2] - 2026-03-05

### 变更
- 移除 direct-chat 中对 Gemini 的固定优先工具提示，改为通用“提交-验证-回退”策略
- BrowserAgentRunner 默认不介入，仅保留显式调试入口
- 移除 Pinterest 站点专属注入兜底逻辑，回归通用 popup policy

## [0.1.1] - 2026-03-05

### 修复
- 修复 Pinterest 页面 Google 登录在 BrowserView 中无响应的问题
- 禁用 `FedCm` 以回退传统 OAuth popup 流
- 启用 `disable-popup-blocking`
- 增加 popup 未创建时自动 fallback 到新标签打开认证链接

## [0.1.0] - 2026-02-24

### 初始化
- 创建 Electron + React + TypeScript 项目骨架
- 接入 Browser / Document / Agent / RSS / Calendar 基础模块
- 建立 Zustand 状态管理、Tailwind CSS v4 设计体系和 SQLite 存储底座
