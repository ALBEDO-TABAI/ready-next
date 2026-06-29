# Ready 项目协作指引（Codex）

> 更新时间: 2026-06-20
> 根目录指引只保留全局工作方式、当前不可破合同和索引。阶段性细节放在 `docs/superpowers/plans/`、`docs/superpowers/specs/`、`docs/superpowers/testing-conventions.md` 与 `.claude/architectural-principles.md`。

## 0. 开工前
- 先说清假设、完成标准和验证方式；目标不清或存在多种解释时，先澄清。
- 用第一性原理拆问题，不默认历史实现就是正确答案；发现一个缺口后继续顺着数据、日志、调用链下钻。
- 简单优先：只做当前目标需要的最小改动，不加未要求的扩展点、配置项或抽象。
- 手术式改动：只碰必须碰的文件；不顺手重排、重命名、改注释或清理无关代码。
- 读完再写：新增或修改代码前，先看导出、调用方、共享工具、同目录惯例和相关测试。
- 模型只做判断题：分类、抽取、总结、草拟和语义判断可以交给 LLM；路由、重试、状态机、权限、预算、可重复转换必须由代码、合同或测试承担。
- 预算是硬限制：上下文、token、iteration 接近警戒线时先摘要、切分或新建上下文；产品内预算超限必须可观测。
- 失败要响亮：检查没跑、路径没验证、测试被跳过、假设没证明，就不能说完成。
- 外部复审无输出只能算失败留痕，不能算通过；Claude 不可用或无输出时，必须用具名 subagent/替代复审补位，并把复审结论与测试/gate 一起写进 closeout。

## 0.5 架构红线
架构级改动先写可机器验证的合同；合同写不出来就不要开始。详细解释见 `.claude/architectural-principles.md`。

1. 先合同，后代码。
2. 修根因，不修症状。
3. 拒绝 legacy 兼容分支和“暂时保留”的旧路径。
4. 借鉴外部方案前先判断需求形态是否一致。
5. CI 强制优先于文档约束，文档约束优先于人审。
6. renderer/main/DB/文件系统/父子任务等跨边界状态必须显式建模，不允许裸 fire-and-forget 靠重试碰运气。

## 1. 项目基线
- Ready 是集成式创作工作台，承载浏览、文稿、RSS、日程、AI Agent、技能中心与远程协作。
- 技术栈：Electron 34、React 19、TypeScript 5、Vite 6 + electron-vite、Zustand、Tailwind CSS v4、SQLite/better-sqlite3。
- 分层：`src/main/`、`src/preload/`、`src/renderer/`、`src/shared/`。
- 入口：`src/main/index.ts`、`src/preload/index.ts`、`src/renderer/main.tsx`、`src/renderer/App.tsx`、`src/shared/ai-providers.ts`。
- 工作台模式：`browser`、`document`、`rss`、`calendar`。

## 2. 当前硬约束
- 白屏防护：`src/renderer/main.tsx` 保留 bootstrap 级错误兜底 UI；`src/renderer/App.tsx` 保留 `/workbench` 与 `* -> /workbench` fallback。
- BrowserView 是原生覆盖层，不受 DOM `z-index` 控制；显示纯 DOM 覆盖层前先 `browser.hideAll()`，恢复后 `browser.showActive()` 并同步 bounds。
- 会话 scope 按“来源频道 + 线程/本地 conversation + agent”隔离；工具日志只留前台运行态或胶囊层，不混入正文消息。
- 飞书/远程图片和文件先进入会话资源层，不自动触发 agent；后续任务必须显式选择附件资源。
- Browser Agent 走“理解 -> 计划 -> 分步执行 -> 复核”；链接是资源，不是立即执行指令。
- 浏览器脚本合同分 Safe Mode 与 Power Mode：Safe Mode 只接受命名只读模板（`browser-readonly-script-templates.ts`）并以 `freeform_script_denied` / `script_blocked` 拒绝自由脚本；Power Mode 走 `browser_power_eval` / `browser_power_cdp` / `browser_power_network_trace` / `browser_power_resource_forensics`，按代码侧 effect/grant/audit 执行，不按站点静态封锁。
- AI provider 能力必须从共享能力层判断；不要把“OpenAI 兼容”当成原生 tools/vision/video 一定可用。
- 工具错误由 dispatch 层转成结构化 `ToolExecutionOutput` 回灌模型；只有 Abort 或 host 不可用这类基础设施错误可以冒泡。
- 主进程启动、日志轮转、SQLite native gate 和 `better-sqlite3` 真实加载都是验收边界；SQLite 路径不能用 host Node skip 当通过。
- Windows 同步/移植不是 macOS 打包的副本：必须在 Windows 本机重装依赖并重编 `better-sqlite3`，路径使用 `app.getPath`/`process.resourcesPath`/`path.join`/`path.delimiter`，打包扩展 `electron-builder.yml` 的 win/nsis/dir 目标，不能带入 macOS `node_modules`、`.app`、`.dmg`、`.icns`、本机种子、缓存或密钥。
- Windows 顶部 chrome 必须按 Windows 原生按钮设计：右上角保留最小化/最大化/关闭，Ready 圆点从 `ModeSlider` 右上迁到左上，中心 X 对齐 `IconRail` 槽位中心（`WORKBENCH_EDGE_RAIL_SLOT_INSET_X + WORKBENCH_EDGE_RAIL_SLOT_SIZE / 2`，当前 25px）。标题栏颜色接壤优先用 `titleBarStyle: 'hidden'` + `titleBarOverlay` 让 renderer 同层背景画到顶边；Mica 只作 Windows 11 22H2+ 增强，必须有普通背景 fallback。
- Run 终止走唯一收口通道：所有退出路径经 `runtime-core/run-finalizer.ts` 的 `finalizeRunOutcome()`，终态账本与可见收口原子完成；通道外写终态被 `check-run-finalize-funnel.cjs` 禁止。零工具的"行动宣告"不得直接判 done（先转向、再 checkpoint）。
- Run continuity：renderer infrastructure timeout 不得只在本地宣告恢复；必须让 main 侧可见，并经 `finalizeRunOutcome()`、明确 cancel/takeover 或 durable resumable mark 收口。main 侧 active run 必须有不依赖 renderer watchdog 的 no-progress 守卫，守卫 tick 必须按 requestId 仲裁，超时以 `main_no_progress_timeout` 区分于 renderer/model/tool timeout。旧 run 晚到不得覆盖同 scope 新 run 的可见状态，已落库消息不得被展示成消息丢失。
- 后台任务（browser_tasks/skill child）终态必须经 `TaskEventBridge` 推回 agent 循环（活跃 run 注提醒 / 无 run 落 pending + 播报续跑）；无注册路由的 scheduleTask 运行时断言失败。自动续跑仅限播报建议（narration 档），执行类动作需用户显式确认。
- 采集终态判决唯一来自 `browser-engine/collection-verdict.ts` 的 `resolveCollectionVerdict()`：0 条永不 completed；部分进展永不清断点；整任务重试只重试失败项。
- 聊天输入框液态玻璃以真实 Electron dev 为验收面；`#/liquid-test` 只用于调参。生产输入框不得加外部暗色阴影、不得用静态镜像/截图贴片冒充实时折射，消息列表底部必须保留由输入框浮层高度测出的空白尾巴，避免最后一条消息被压住。
- 稳定性合同回归入口：`npm run verify:stability`（终止合同/事件桥/判定矩阵/意图分类/会话快照全链焦点测试 + 三个 gate）。
- 非浏览器高危工具仍走行动确认闸门：M1-M4 静态策略表（`agent-control/safety/action-confirmation-policy.ts`）在 `tool-executor` authorization 之后裁决。浏览器侧 supersede 为 Power Browser 合同：破坏性浏览器效果由 `src/shared/browser-power.ts` 代码枚举，live target 命中支付/改凭据/访问控制等语义时返回 `grant_required`；自由 eval 的 scope 内副作用残差以授权、限时、审计和脱敏收口，不再用 M1 manual-only 表示“工具没有能力”。
- 信念卡 staged 状态不得进入 prompt 注入：`BeliefCardStore` 读 API 默认排除 staged（真实注入接线属 K3）。
- Reflection 产物不得直接写入 prompt 可见的 `resident_user` / `scope_memory` 常驻记忆；用户偏好只能经 user-picture CAS 或后续明确 staged 路径进入，reflection 必须发 `reflection_outcome` 可观测账本。
- Agent 进化阶段一合同回归入口：`npm run verify:evolution-p1`（全部焦点测试 + `verify:native`）。
- 专项 agent 注入面（阶段三）：per-agent RULES/knowledge 注入 owner 解析三段式——显式 `ownerAgentId` 优先；完全未传 owner 时回退 `scope.agent`；显式但非法的 id 降级 global-only（不回退 scope.agent，防腐败 owner 借道注入他人谱系，也永不成为路径片段）。charter/路由索引段只进主 agent 会话；`ownerAgentId` 写值唯一来自 handoff 采纳（用户点击后经 `repository.update`），后续轮注入随 scope 最近 owner 切换。
- 任务包合同（阶段三）：packet 嵌套两层硬上限在 projection 写侧强制；`direct_answer`/`short_task` 永不分包、multi_step/research 需多目标（门槛是代码不是模型）；子包失败只有重派(≤1)/降级(必须写理由)/阻塞三选一，静默吞=测试红；上行报告 ≤5 行摘要+引用不转述。
- 最小传话铁律（05 §4）：handoff/SubAgent/技能子进程三类转发点只传 `userRequestVerbatim` 逐字+结构化 refs，禁止转述改写拼接摘要；恢复路径还原持久化原话不重新派生；全局断言矩阵 `verbatim-relay.test.ts`。
- LLM 维护回合（阶段三）：必须经 EP2-C2 确定性门控（skip=零 LLM 调用）、容器钉死 `runSubAgent`、维护写卡强制 staged；用户画像合并 CAS 作用于 DB 真值行（同事务 hash 比对，USER.md 仅无 profile 行时镜像）；涌现候选投影只在 stage=candidate 且证据 ≥3。
- Agent 进化阶段三合同回归入口：`npm run verify:evolution-p3`（全部阶段三焦点测试 + 四 gate + `verify:native`）。
- Agent 进化阶段四：agent 作用域卡进入镜像/衰减/维护信源但 root `index.md` 只收 global；`agent_auto_routing` 默认 suggest，预路由按状态优先、routing 卡先例、主 agent 兜底，continue 类永远回原 agent；routing 卡 `triggers` 是≤8 个字面关键词，staged/无 triggers/目标非 active 不参与。
- 专项 agent 派生和生命周期：新派生 id 必须是小写 slug；无用户确认不得自动派生；routing 卡默认 staged，只有确认流勾选立即生效才 active；active→retired/merged 只能经确认，主 agent 禁退，资产目录保留；retired/merged 或不存在 owner 的后续轮注入降级 global-only。
- 站点卡学习和设置页暴露：浏览器失败学习只产 staged 新卡/旁卡/风险建议卡，active 站点卡不得被自动改写；设置页必须能看到知识系统总开关、staged 信念卡确认、站点卡风险和维护回合状态。
- 剩余涌现卡：prepare/harvest/forming 卡必须带 evidence 与行动出口；受保护路径只显示“产物已生成（受保护路径）”，不得把隐私路径或内容写进卡面。
- Agent 进化阶段四合同回归入口：`npm run verify:evolution-p4`（阶段四焦点测试 + 四 gate + 迁移连续 gate + `verify:native`）。

## 3. Agent 与 Skill Runtime 速查
- `skill_executions` 状态机和相关 IPC/工具已退役；不要复活 workflow coordinator。新进度语义走当前的 task tracker、projection、child-run 合同。
- LLM 可见 skill 工具只来自 manifest action 与 primitive；曝光、执行、primitive 归属由本轮 `SkillTurnIdentity` + `SkillToolAuthorization` 决定。
- `tool_not_registered` 表示工具不存在；`authorization_denied` 表示工具存在但本轮未授权；两者语义互斥。
- reference/advisory skill 以内联 `SKILL.md` 为主，`read_skill` 归一为 internal；primitive 不能因为 reference hint 单独打开。
- `skill_run_shell`、artifact 读写、config patch 必须遵守沙箱、allowlist、大小上限、symlink 和保留文件约束。
- child-loop action 属于子循环；父循环不得强制合成这些 typed tool_use。embedded manifest、driver 注册、静态工具名映射必须一致。
- 长任务续跑以 durable handle 为准：`childRunId`、`detachedTaskId`、或 `outputDir + runStatePath`；空壳 `taskRunId/skillId` 不算可继续。
- `TurnFrame` 是模型循环内 frame-state 唯一读源；frame patch 和 context modifier 是声明的两条写通道。
- 任务卡 UI 只消费 projection 派生状态；renderer 不新增完成、等待、可继续等本地猜测。
- research、MCP、agent_interaction 是独立 capability 维度；不要把它们塞进 skill authorization。

## 4. 文档、Widget、实时信息
- 文档任务里的附件、`@[文件]`、当前文档上下文和引用片段先进入结构化资源层；多来源、多目标、多步骤任务先生成计划再执行。
- 文档 widget 以骨架和设计规范仲裁。H1/H2 freeform 只在用户命中特定触发词时使用，其他情况降级到 A-G 骨架。
- 天气、新闻、股价、汇率、比分、航班、路况、空气质量、官网公告等实时问题要进入浏览器/网页查询工作流；不要因为用户没说“打开网页”就直答。
- Widget 更新上下文优先于 live-info 判定；“卡片/信息卡/趋势图/对比卡”等口语要避免误路由到 browser。
- `run-capability-controller.resolveRunCapabilities` 是工具策略冲突的唯一裁决点；不要在上游重复加挡板。

## 5. DomainAdapter 与系统提醒
- 每个产品域通过 `DomainAdapter` 注册行为；`turn-engine.ts` 只调度，不写产品分支，也不比较具体 adapter id。
- 系统提醒必须通过 `SystemReminderRegistry` 注册和组装；不要在 `turn-engine.ts` 或 steering 里内联写提醒文案。
- compaction、hook、reminder 都是独立抽象；hook 不能当 logging 替代品，handler 失败不得中断 turn 主流程。
- `ask_user_questions` 是主 agent 的结构化反问工具，独立于 skill 域；每 turn 最多一次，同一 session 只允许一个 pending 卡。

## 6. 测试与验证
- 新测试默认写行为测试，调用真实入口或最小替身并断言可观察结果；结构测试只用于行为测试无法证明的硬合同。
- 不得用 source-grep 冒充行为验证，不得用 skip 当通过。
- 破坏 singleton、全局状态、admission 或 lifecycle 的 helper 必须显式声明风险。
- SQLite-backed 验收先跑 `npm run verify:native`；普通 Node 下的 ABI skip 只说明 host-Node 未覆盖该路径。
- 阶段 verify 链以当前 `package.json` 为准；修改某阶段合同要同步对应 `verify:*`、gate 和测试。
- Agent audit P6b 回归入口：`npm run verify:evolution-p6b`（contextBudget 全段统计、compaction/snapshot 保真、live/dormant compaction 边界）。它不代表 TurnEngine 退役，也不覆盖 C30/C31/C32。
- Agent audit P6d/C32 回归入口：`npm run verify:evolution-p6d`（run_meta 终态共享源、paused/direct-resume 谓词、detached task status alias、detached_task/send-im errorKind 登记与 drift gate）。它不代表 P6 完成，也不覆盖 C30/C31-b/C29。
- Agent audit P6e 回归入口：`npm run verify:evolution-p6e`（SDK-shaped `CapabilityResolution` 与 TurnEngine/controller 能力准备路径的 parity 准入测试）。它只是 C29 退役前置证明，不代表 TurnEngine/DirectChat 退役、C29 关闭或 C30 拆分完成。
- Agent audit P6f 回归入口：`npm run verify:evolution-p6f`（SDK live 执行、DirectChat/TurnEngine dormant 执行边界、dormant compaction 边界）。它不删除 TurnEngine/DirectChat，也不关闭 C31-b/C30/C32。

## 7. 新功能最小闭环
新增跨进程功能至少同步：

1. Main IPC handler
2. Preload API
3. Renderer 类型声明
4. Renderer 页面或组件
5. 行为测试或合同 gate
6. 相关文档

## 8. 协作文档索引
- 项目说明：`PROJECT_OVERVIEW.md`
- 开发文档：`DOCUMENTATION.md`
- 经验文档：`LESSONS_LEARNED.md`
- 开发进展：`PROGRESS.md`
- 模块地图：`FEATURE_MODULE_MAP.md`
- 依赖地图：`DEPENDENCY_MAP.md`
- 结构快照：`PROJECT_STRUCTURE_SNAPSHOT.md`
- 更新日志：`CHANGELOG.md`
- 架构原则：`.claude/architectural-principles.md`
- 测试规约：`docs/superpowers/testing-conventions.md`
- Electron 聊天输入框液态玻璃规格：`docs/superpowers/specs/2026-06-11-electron-liquid-glass-composer.md`

关键阶段合同索引：

- Coordinator / DomainAdapter：`docs/superpowers/plans/2026-04-30-C-coordinator-role-abstraction-implementation.md`
- Reminder / compaction / hook：`docs/superpowers/plans/2026-04-30-D-reminder-registry-compaction-hooks-implementation.md`
- 防爆与日志生命周期：`docs/superpowers/plans/2026-04-30-E-defense-and-fragility-reduction-implementation.md`、`docs/superpowers/plans/2026-05-02-J-main-process-stability-and-log-lifecycle-implementation.md`
- Frame 单源：`docs/superpowers/plans/2026-05-06-M-frame-update-single-source-of-truth.md`
- Child loop 接管：`docs/superpowers/plans/2026-05-06-N-parent-loop-retire-force-typed-action-implementation.md`
- Projection UI 收口：`docs/superpowers/plans/2026-05-07-O-ui-projection-consolidation-implementation.md`
- Skill authorization：`docs/superpowers/plans/2026-05-07-P-stage-10-transitional-bridge-retirement-implementation.md`
- Skill resumability：`docs/superpowers/plans/2026-05-07-Q-skill-resumability-triple-fence-implementation.md`
- Research / provider / MCP / sandbox：`docs/superpowers/plans/2026-05-08-R-stage12-implementation.md`、`docs/superpowers/plans/2026-05-09-S-stage13-implementation.md`、`docs/superpowers/plans/2026-05-09-T-stage14-implementation.md`
- Agent 稳定性收口：`docs/superpowers/plans/2026-06-10-agent-stability-closure-implementation.md`（roadmap 同日同名 -roadmap.md）
- Agent 进化阶段一（信念卡/资产化/确认闸门/工具信封/浏览器纪律）：`docs/superpowers/plans/2026-06-11-agent-evolution-phase1-implementation.md`
- Agent 进化阶段三（专项 agent 实体/LLM 维护回合/任务包编译层/最小传话收口）：`docs/superpowers/plans/2026-06-12-agent-evolution-phase3-implementation.md`
- Agent 进化阶段四（预路由/派生/生命周期/站点卡学习/剩余涌现卡）：`docs/superpowers/plans/2026-06-13-agent-evolution-phase4-implementation.md`

## 9. 常用命令
```bash
npm run dev
npm run native:check
npm run verify:native
npm run typecheck
npm run test
npm run verify
npm run verify:stability
npm run verify:evolution-p4
npm run build
```

## 10. 提交前检查
- `npm run typecheck` 无错误。
- 涉及 SQLite、设置、本地持久化时，`npm run verify:native` 必须通过。
- 关键页面可正常渲染与切换；Browser、Agent、Settings 关键链路至少做一次基础回归。
- 架构级改动必须能配对到 `docs/superpowers/plans/YYYY-MM-DD-*-implementation.md`；`*-arrangement.md`、`*-counterplan.md` 只作反提案，历史材料需在 frontmatter 标 `enforce: false`。
- 涉及硬约束变化时，同步更新根目录指引和对应详细文档。

## 11. 当前关键日志
- Agent / 浏览器决策：`<系统临时目录>/ready-directchat.log`
- 工具执行：`<系统临时目录>/ready-tools.log`
- BrowserView / popup：`<系统临时目录>/ready-browser.log`

macOS: Node/Electron `os.tmpdir()` 返回的系统临时目录；Windows: `%TEMP%`。

## 12. 指引同步
- `CLAUDE.md` 与 `AGENTS.md` 的正文规则保持同步；一侧新增或修正约束，另一侧同次补齐。
- 两份文件允许的差异仅限标题、面向代理的称谓与必要工具名映射，不允许出现实质行为分叉。
- 新增临时实验页时，优先采用 Renderer 内独立路由隔离，例如 `#/liquid-test`；不要替换默认入口，也不要改动现有工作台界面。
