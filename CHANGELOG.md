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

#### C 类安全清扫
- 根目录协作文档、模块图和结构快照已对齐到当前 4 模式工作台真值：`browser / document / rss / calendar`
- 移除工具网关和 agent `app.switchMode` 描述里对已下线 `design / video` 工作台模式的过期注册
- 历史设计模块经验显式标注为归档知识，避免继续被当作当前基线
- 工作区目录失效后不再只停留在旧路径；“重选文件夹”现在会真正切换到新工作区并清空失效状态
- 文档模式对外部删除 / stat 失败补上显式“无法打开文档”提示，不再静默无反应
- 浏览器数据 IPC 的下载/历史/打印失败路径统一走 shared error helper，减少假成功/假默认值
- Browser 模式创建标签页失败时现在会保留底层错误细节，不再统一显示成泛化初始化失败
- 文件树、Ready 文件面板、拖拽分类和旧样式里的 `design` 残留继续清除，避免 UI 再暴露已下线模式词汇
- `scopeRunState` 新增统一 error-state builder，`runtimeDriver` 和 `useAgent` 的重复错误 run-state 构造收口到同一路径，并修复显式清空 checkpoint 失效的问题
- `direct-chat` 移除失效的 design tool policy 字段、helper 与日志分支，主链不再保留 `forceDesignTool` 一整套死代码
- `tool-policy-heuristics` 移除未再被主链消费的 design heuristic 与 design context marker，文档 / widget 相关判定直接走当前活跃规则
- `memory / user-profile / agent-personality` repository 不再经过 `database-accessor` 纯透传层，进一步压平当前主进程数据访问链

### 修复

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

#### 文档编辑 / 预览职责拆分
- 文档模式的文本类文件现在改为明确区分 `源码 / 排版 / 预览` 三种视图，不再把源码编辑和最终预览混成同一种体验
- Markdown / TXT / DOCX 默认进入源码视图，直接展示原始标记；现有所见即所得编辑保留为单独的“排版”视图
- 代码 / 配置类文本文件只保留源码视图，图片 / 视频 / PDF / 表格类文件只保留实际可用的查看视图，减少无效切换按钮
- 文本类文档现已进一步收口为 `源码 / 排版` 两档：`排版` 成为唯一成品界面并默认打开，独立 `预览` 主入口已移除
- 生成式内容在 `排版` 里只显示最终结果，`让 agent 更新 / 查看源码 / 复制源码 / 删除` 等管理动作统一收回 `源码`

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
