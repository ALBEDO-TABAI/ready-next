# Ready V5 - 更新日志

## [Unreleased] - 2026-03-15

### 新增

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
- 卡片写回继续复用现有确定性文档动作：优先 `componentSpec`，最终仍走 `document.insertWidget` / `document.saveTab`

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
