# Ready V5 - 更新日志

## [Unreleased] - 2026-03-07

### 新增

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

#### Agent / Browser 调试口径
- `direct-chat` 运行日志新增 `toolCallTransport` 维度，便于区分原生工具与文本桥接
- AI 配置能力判断统一收口到共享层，减少在主进程、设置页、浏览器视觉和 RSS 子代理中的分散判断

#### 文档同步
- 根目录协作文档全部按 2026-03-07 当前代码状态刷新：架构、依赖、进展、经验、模块地图、结构快照已统一对齐

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
