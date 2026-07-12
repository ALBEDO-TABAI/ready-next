# Ready 项目协作指引（Codex）

> 更新时间：2026-07-12
> 根指引只保留工作方式、不可破红线和必读入口。子系统细节集中在 `docs/architecture/current-runtime-contracts.md`，阶段实现集中在 `docs/superpowers/plans/`。

## 0. 开工前

- 先写明假设、完成标准和验证方式；存在会改变结果的多种解释时先澄清。
- 从第一性原理和真实调用链出发；发现一个缺口后继续核对数据、日志、相邻入口和同类变体。
- 简单优先：只做当前目标所需的最小实现，不加未要求的扩展点、配置或兼容层。
- 手术式改动：先读导出、调用方、共享工具、同目录惯例和测试；不顺手重排、重命名或清理无关代码。
- 模型只做语义判断；路由、重试、状态机、权限、预算和可重复转换必须由代码、合同或测试承担。
- 预算接近上限时先摘要或切分。检查未跑、路径未验证、测试被跳过或假设未证明时，不得宣告完成。
- 外部复审无输出不算通过；改用具名 subagent/替代复审，并把结论与 gate 一起记录。

## 0.5 架构红线

架构级改动先写机器可验证合同；写不出来就不要开始。详见 `.claude/architectural-principles.md`。

1. 先合同，后代码。
2. 修根因，不修症状。
3. 拒绝 legacy 兼容分支和“暂时保留”的旧路径。
4. 借鉴外部方案前先判断需求形态是否一致。
5. CI 强制优先于文档约束，文档约束优先于人审。
6. renderer/main/DB/文件系统/父子任务等跨边界状态必须显式建模，禁止裸 fire-and-forget。

## 1. 项目基线

- Ready 是 Electron 创作工作台，承载 Browser、Document、RSS、Calendar、AI Agent、技能、文件涌现与远程协作。
- 版本与依赖以 `package.json` 为准；当前基线是 Electron 42.3、React 19、TypeScript 5.7、Vite 6、Tailwind CSS 4、Zustand、SQLite/better-sqlite3。
- 分层：`src/main/`、`src/preload/`、`src/renderer/`、`src/shared/`；稳定入口见 `docs/architecture/codebase-map.md`。
- Workbench mode 只有 `browser | document | rss | calendar`。
- Agent 生产主链是 `AgentSdkRuntime -> AgentSdkTurnOrchestrator`；`direct-chat.ts` 与 `turn-engine.ts` 已删除，不得复活或把 dormant parity 路径写成 live 权威。

## 2. 当前硬约束

修改 Agent、Browser、Skill、Document/Widget、文件涌现、窗口或 Windows 路径前，必须先读 `docs/architecture/current-runtime-contracts.md` 对应章节。若文档与代码/gate 冲突，先定性为实现回归或文档漂移，再同步修正。

- 保留 Renderer bootstrap 白屏兜底与 `/workbench` 路由 fallback。
- Renderer 通用 reset 必须在 `@layer base`；禁止层外通用 margin/padding reset，运行 `scripts/check-css-cascade-layer-reset.cjs`。
- 代码文件只要净增行数，收尾就检查总行数；超过 1000 行按“危险 / 一般 / 健康”更新 `docs/code-health/large-file-health-log.md`。危险项必须在最终回复提醒，一般项写复查日期。
- BrowserView 是原生覆盖层；DOM 覆盖面出现前先 hide，恢复后 show 并同步 bounds。
- 会话按来源、线程/本地 conversation 与 agent 隔离；远程附件先入资源层，不自动触发 Agent。
- Provider 能力从共享能力层判断；OpenAI-compatible 不等于原生 tools/vision/video 可用。三条 SDK provider 路径必须真 SSE，语义性 4xx 不得伪装成 stream fallback。
- 显式技能/文档资源产生 capability floor；最终工具面必须非空且包含地板。live 权威在 SDK executor 与 turn orchestrator；只有 `resolveRunCapabilities` 路径当前是 dormant parity。
- 所有 run 终态经 `finalizeRunOutcome()`；Renderer watchdog 不得终止 Main 仍确认 active 的 provider，旧 run 不得覆盖新 run。
- Dynamic Delivery 的 worker 永远无工具；Owner 独占写入、确认和外部动作，候选结果在 fresh verifier 接受前不得进入共享会话。
- 文档 Widget 必须走共享令牌、结构真值、CSP nonce 和 receiver 事件桥；禁止 Markdown 表格冒充卡片。回归入口 `npm run verify:widget-ready`。
- 天气、新闻、股价、汇率、比分、航班、路况、空气质量、官网公告等实时问题必须进入网页查询工作流；Widget 更新上下文优先于 live-info 判断。
- 非浏览器高危工具必须经过代码侧行动确认。staged 知识不得进入 prompt，自动学习不得直接改写 active 站点卡。
- 文件涌现反馈必须同时约束 Main 与 Renderer；Tag Forge 自动写入必须有绑定 run/tab/path/hash 的 durable receipt，并在索引 readback 后才可被涌现消费。
- Windows 必须本机安装依赖并重编 native 模块，绝不复制 macOS 的 node_modules、包体、缓存、种子或密钥。

## 3. Agent 与 Skill Runtime 速查

- `skill_executions` 状态机、相关 IPC 和 workflow coordinator 已退役；进度走 task tracker、projection 与 child-run。
- LLM 可见 skill 工具只来自 manifest action 与 primitive；曝光、执行与 primitive 归属由本轮 `SkillTurnIdentity + SkillToolAuthorization` 决定。
- 语义选择由模型读取 id/name/description 后调用 `use_skill`；代码只识别完整技能名或明确别名，禁止 description 模糊激活。
- `use_skill` 返回方法论后继续当前任务，不得只给计划等用户再次发言。
- `tool_not_registered` 表示工具不存在；`authorization_denied` 表示存在但本轮未授权，两者互斥。
- reference/advisory skill 以内联 `SKILL.md` 为主；reference hint 不能单独打开 primitive。
- 长任务续跑以 `childRunId`、`detachedTaskId` 或 `outputDir + runStatePath` 为准；空壳 taskRunId/skillId 不算可继续。
- Tag Forge 文件夹批量打标只走 `prepare_batch -> apply_batch`：保留 typed-folder 地板、代码签发 revision 与持久重试，不开放通用写文件或 shell。
- `TurnFrame` 是模型循环内 frame-state 唯一读源；任务卡只消费 projection 真值，不在 Renderer 猜完成、等待或可继续状态。
- research、MCP、agent_interaction 是独立 capability 维度，不能塞入 skill authorization。

## 4. 文档、Widget 与实时信息

- 附件、`@[文件]`、当前文档与引用片段先进入结构化资源层；多来源、多目标、多步骤任务先计划再执行。
- Widget 的视觉、结构、nonce、事件与导出合同见 `docs/architecture/current-runtime-contracts.md` §7 和 `docs/superpowers/plans/2026-07-11-document-widget-ready-design-language-implementation.md`。
- 实时信息与 Widget 口语可能冲突时，先判断用户是在更新当前卡片，还是请求外部最新事实；不要把“趋势图/信息卡”机械路由到 Browser。

## 5. DomainAdapter 与系统提醒

- 每个产品域通过 `DomainAdapter` 注册行为；live 调度层是 `agent-sdk-turn-orchestrator`，只调度，不写产品分支或比较具体 adapter id。
- 系统提醒必须经 `SystemReminderRegistry` 注册和组装，不在调度或 steering 中内联文案。
- compaction、hook、reminder 是独立抽象；hook 不能代替日志，handler 失败不得中断 turn。
- `ask_user_questions` 属于主 Agent 结构化反问，每 turn 最多一次，同一 session 只允许一个 pending 卡。

## 6. 测试与验证

- 新测试默认调用真实入口或最小替身并断言可观察行为；结构测试只用于行为无法证明的硬合同。
- 不得用 source-grep 冒充行为验证，不得用 skip 当通过；测试 helper 若破坏 singleton、admission 或 lifecycle，必须显式声明风险。
- SQLite、设置、搜索索引和本地持久化验收必须跑 `npm run verify:native`；普通 Node 的 ABI skip 只代表未覆盖。
- 测试细则与归属 gate 见 `docs/superpowers/testing-conventions.md`；阶段 verify 链以 `package.json` 为准。
- 常用专项入口：`verify:stability`、`verify:streaming`、`verify:dynamic-delivery`、`verify:widget-ready`、`verify:file-emergence`、`verify:tag-forge`、`verify:evolution-p1/p3/p4`。
- `verify:evolution-p6b/p6d/p6e/p6f` 只证明各自标明的审计切片，不代表整个 P6、旧主链退役或其他缺口自动关闭。

## 7. 新功能最小闭环

新增跨进程功能至少同步 Main handler、Preload API、Renderer 类型与 UI、行为测试/合同 gate，以及受影响的单一权威文档。不要为了“文档齐全”机械复制多份说明。

## 8. 协作文档索引

- 总入口：`docs/README.md`；项目/开发/进展：`PROJECT_OVERVIEW.md`、`DOCUMENTATION.md`、`PROGRESS.md`。
- 发布与经验：`CHANGELOG.md`、`LESSONS_LEARNED.md`。
- 架构：`docs/architecture/codebase-map.md`、`docs/architecture/current-runtime-contracts.md`、`.claude/architectural-principles.md`。
- 专项：`UI_ADJUSTMENT_GUIDE.md`、`docs/platform/windows-development.md`、`docs/superpowers/testing-conventions.md`、`docs/code-health/large-file-health-log.md`。

仍被 gate 直接引用的阶段合同：

- Research：`docs/superpowers/plans/2026-05-08-R-stage12-implementation.md`
- Provider：`docs/superpowers/plans/2026-05-09-S-stage13-implementation.md`
- MCP / sandbox：`docs/superpowers/plans/2026-05-09-T-stage14-implementation.md`
- Agent 稳定性：`docs/superpowers/plans/2026-06-10-agent-stability-closure-implementation.md`
- Agent 进化：`docs/superpowers/plans/2026-06-11-agent-evolution-phase1-implementation.md`、`docs/superpowers/plans/2026-06-12-agent-evolution-phase3-implementation.md`、`docs/superpowers/plans/2026-06-13-agent-evolution-phase4-implementation.md`

## 9. 常用命令

```bash
npm run dev
npm run verify:native
npm run typecheck
npm run test
npm run verify
npm run verify:stability
npm run verify:streaming
npm run build
```

## 10. 提交前检查

- `npm run typecheck` 无错误；改动范围对应的专项 gate 通过。
- 发布版本以 `package.json` 为唯一来源；改版本同步 lockfile、`CHANGELOG.md`，运行 `npm run verify:version`，打包后补真实包体验证。
- 涉及 SQLite、设置或本地持久化时，`npm run verify:native` 必须通过。
- 关键页面在真实 Electron 中完成与风险相称的回归；BrowserView、Widget、液态玻璃或 Windows 原生面不能只靠源码检查。
- 架构级改动配对 `docs/superpowers/plans/YYYY-MM-DD-*-implementation.md`；反提案/历史材料标 `enforce: false`。
- 文档只更新受影响的权威入口；路径、命令、版本和相对链接必须核对。

## 11. 当前关键日志

`ready-directchat.log`（Agent/浏览器决策）、`ready-tools.log`（工具执行）、`ready-browser.log`（BrowserView/popup）都位于 Node/Electron `os.tmpdir()`；Windows 通常是 `%TEMP%`。

## 12. 指引同步

- `CLAUDE.md` 与 `AGENTS.md` 的正文规则保持同步；允许的差异只有标题和必要的代理称谓。
- 阶段细节、长合同和一次性验收记录不得回填到两份根指引；放入对应 architecture/plan/audit 文档，并在根指引只保留入口。
- 新增临时实验页优先使用独立 Renderer 路由（如 `#/liquid-test`），不得替换默认入口或改动现有工作台。
