# Ready 开发进展

> 更新时间: 2026-04-18

## 当前真值摘要

0. Agent 核心重构已先落地第一段可上线基础层。

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
  - 新增 `worker-session / subtask-runtime / worker-projection`，child task 现在会生成独立 `workerSessionId + taskId`，父任务只通过 `parentTaskId / parentStepId` 关联，不再和父任务抢同一个执行会话键。
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
