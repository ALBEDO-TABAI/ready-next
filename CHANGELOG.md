# Ready V5 - 更新日志

## [Unreleased] - 2026-03-15

### 新增

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

### 调整

#### Claude / OpenAI 工具链兼容
- `direct-chat` 在视频输入场景下，为显式 `/skill`、手动阶段控制、embedded python 请求、活跃 execution 保留 tools
- OpenAI `chat/completions` 和 `responses` 请求前会自动修复缺失的 tool response history
- 文本工具桥接与原生 tools 现在共用同一套 skill 可见性过滤，不再把 internal action 暴露给模型

#### Skills Center
- 技能中心新增 Recent Executions 区域与 execution detail 卡片
- 支持在 UI 中继续提交 blocker：input / confirmation / agent result
- 技能卡片增加 execution mode 感知，workflow skill 默认走 execution 而不是直接 stdout/stderr 返回

#### Agent / Browser 调试口径
- `direct-chat` 运行日志新增 `toolCallTransport` 维度，便于区分原生工具与文本桥接
- AI 配置能力判断统一收口到共享层，减少在主进程、设置页、浏览器视觉和 RSS 子代理中的分散判断

#### 文档同步
- 根目录协作文档全部按 2026-03-07 当前代码状态刷新：架构、依赖、进展、经验、模块地图、结构快照已统一对齐

### 修复

#### BrowserView 可见性与工作台外框
- 浏览器主 host 新增 `hideActiveHost` 呈现闸门，避免 BrowserView 在切换到文档 / RSS / 日历后因异步加载完成重新浮到最上层
- 浏览器内容 bounds 支持顶部 inset，网页内容会上抬到上一行 chrome 的下边缘，地址栏可更贴近浮层覆盖效果
- 左侧 SidePanel 与右侧 ChatPanel 新增透明圆角外框壳，统一向文档模块的外缘圆角矩形靠拢，同时保持无异色底板

#### BrowserView 宽度跟随稳定性
- BrowserView 的 bounds 回写从延后批处理改为立即应用，避免左右拖拽工作台边界时顶部标签栏与底层网页内容出现“标签先动、网页后追”的错位与抖动
- 浏览器 bounds 同步不再跳过细小拖拽步进，拖动中的小幅宽度变化也会直接跟上；布局变化后的短时间内会持续跟踪一段，压低尾部回弹感
- 高频 bounds 同步改成单向直发，不再在拖拽过程中为每次宽度变化等待一轮主进程回包，进一步减轻浏览器内容区跟随时的卡顿和抖动
- 浏览器拖拽态冻结方案改为直接抓取“整块浏览器区域”的可见画面，而不再只抓内部网页视口；拖拽时展示的是完整区域快照，所以圆角、顶部与边缘不会再因为分层拼接反复出现白块、缺角或被咬一口
- 新增 `browser-resize-stability-contract`，把“宽度变化时浏览器 chrome 与网页表面必须同步”固化为回归检查

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
