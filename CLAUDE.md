# Ready 项目协作指引（CLAUDE）

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

### 6.7 技能中心原则
- 系统级 embedded skills 与用户 custom skills 要分层管理
- Agent 调用 skill 时优先走统一 `skill_*` 工具，而不是绕到手工网页流程
- 更新 skill 管理逻辑时，要同时考虑运行时、UI、默认命令与说明文案

### 6.8 文档多资源任务原则
- 文档任务里的附件、`@[文件]`、当前文档上下文、引用片段都必须先进入结构化资源层，不能在入口阶段直接拼平成一段大文本
- 复杂文档任务必须先做资源角色绑定，再进入执行：至少区分 `primary_source / secondary_source / target_document / ambient_context`
- `当前文档上下文` 默认只算环境信息，不能压过用户显式点名的来源材料
- 一句话里出现多个来源、多个目标或多个顺序步骤时，必须先生成 `DocumentTaskPlan + DocumentTaskJob[]`，再按 job 顺序执行
- 文档卡片类执行状态必须按计划步骤展示；未开始步骤显示 `pending`，失败步骤显示 `blocked`，不能再把整条链路默认标成进行中或完成

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
