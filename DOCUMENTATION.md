# Ready 开发文档

> 更新时间: 2026-03-07

## 1. 架构概览
Ready 采用 Electron 三层架构：
- Main：窗口、协议、IPC、数据库、BrowserView、技能运行时、各模块引擎
- Preload：白名单 API 桥接
- Renderer：React UI、状态管理、交互壳层
- Shared：跨进程共享类型、AI 供应商配置与能力解析

核心数据流：
`Renderer UI -> preload(electronAPI) -> main IPC -> DB / FS / BrowserView / runtime`

## 2. 工作台模式
`useMode` 当前维护的子模式：
- `browser`
- `document`
- `design`
- `video`
- `rss`
- `calendar`

入口壳层：`src/renderer/pages/WorkbenchMode.tsx`

> 旧 `image` 模式已废弃并迁移到 `design`。

## 3. 主模块说明
### 3.1 Browser
- 前端：`src/renderer/pages/modes/BrowserMode.tsx`
- 后端：`src/main/modules/browser-engine/*`
- 说明：多标签、BrowserView 边界管理、历史/书签/下载、右键菜单、popup policy

### 3.2 Document
- 前端：`src/renderer/pages/modes/DocumentMode.tsx`
- 后端：`src/main/modules/document-engine/*`
- 说明：多格式读取、编辑文本抽取、`document_*` 工具

### 3.3 Design
- 前端：`src/renderer/pages/modes/DesignMode.tsx`
- 后端：`src/main/modules/design-engine/*`
- 说明：TLDraw 画布、设计会话、Inspector 与导出链路

### 3.4 Video
- 前端：`src/renderer/pages/modes/VideoMode.tsx`
- 后端：`src/main/modules/video-engine/*`
- 说明：Remotion 驱动的预览、时间轴、轨道与 Inspector

### 3.5 RSS / Calendar
- RSS：`src/renderer/pages/modes/RSSMode.tsx` + `src/main/modules/rss-engine/*`
- Calendar：`src/renderer/pages/modes/CalendarMode.tsx` + `src/main/modules/calendar-engine/*`

### 3.6 Agent / Skills / Remote IM
- Agent：`src/main/modules/claude-bridge/*`
- 会话与远程通道：`src/main/modules/agent-control/*`
- 工具：`src/main/modules/tools/*`
- 技能运行时：`src/main/modules/skills-runtime/*`
- Python sidecar：`src/python/ready_sidecar/*`

## 4. AI 供应商与能力层
### 4.1 共享配置模型
统一配置定义在 `src/shared/ai-providers.ts`，主要字段包括：
- `provider`
- `baseUrl`
- `model`
- `agentProtocol`
- `wireApi`
- `reasoningEffort`
- `toolUseMode`
- `visionMode`
- `nativeVideoMode`

### 4.2 能力解析
所有 AI 请求都会通过 `resolveAIConfigCapabilities()` 得到统一能力视图：
- 当前走 `anthropic` 还是 `openai` 协议
- 当前走 `chat/completions` 还是 `responses`
- 当前是否支持原生 tools、视觉、原生视频
- 当前工具传输方式是 `native`、`text` 还是 `none`

### 4.3 设置页
设置页支持高级选项：
- `Agent 接口`
- `OpenAI API 形式`
- `工具调用`
- `网页视觉`

这些配置在切换 provider 时会自动按 provider 默认值播种，但允许手动覆盖。

## 5. Agent 工具调用链
### 5.1 原生工具调用
- Anthropic 协议走 `messages` + `tool_use/tool_result`
- OpenAI 协议走 `chat/completions` 或 `responses` 的 function tools

### 5.2 文本工具桥接
对于表面 OpenAI 兼容、但实际上不把 tools 透传给模型的供应商：
- 系统会把工具列表转换为文本提示
- 模型通过 `:::tool_call` JSON 块表达工具调用
- 宿主应用本地解析并执行工具
- 工具结果再以结构化文本回灌给模型继续推理

当前这条桥接路径主要用于 `fox / code.newcli.com/codex/v1` 一类通道。

### 5.3 工具分类
- Browser tools：网页导航、搜索、读页、点击、输入、上传、批量下载等
- Document tools：打开、切换、写入、替换、格式化、改写、保存
- Skill tools：把 embedded/custom skills 暴露为统一 `skill_*` 工具
- System tools：系统命令与应用级操作

## 6. Browser Agent V7
### 6.1 核心原则
浏览器任务采用固定闭环：
`任务理解 -> 计划生成 -> 分步执行 -> 结果复核`

### 6.2 上传/生成类任务默认步骤
1. `resolve_target_page`
2. `resolve_attachment`
3. `navigate_target`
4. `ensure_upload`
5. `ensure_prompt`
6. `submit`
7. `final_reconcile`

### 6.3 证据优先
- 附件未出现页面级证据，不进入 prompt 阶段
- Prompt 未确认进入正确输入区，不进入 submit 阶段
- 页面未进入运行态，不报告完成

### 6.4 连续性上下文
系统会把近期浏览器动作、上次技能运行、当前页面状态、会话附件等注入到 planner / tool loop，目标是减少重复搜索、重复跳转、重复上传。

## 7. 会话 Scope 与远程 IM
### 7.1 Scope 粒度
会话按“来源频道 + 线程/本地 conversation + agent”隔离。

### 7.2 附件安全边界
- 图片/文件消息先进入会话资源层
- 不能伪造成一条普通文本消息直接触发 agent
- 后续浏览器任务必须显式消费附件资源

### 7.3 Sidecar 角色
`src/python/ready_sidecar/*` 负责：
- 远程通道连接与心跳
- 事件入站
- 附件落盘
- 主进程的前台会话写入与 agent 调度辅助

## 8. 技能中心
### 8.1 技能来源
- `embedded`：应用内置系统级技能
- `custom`：用户导入的技能目录

### 8.2 运行时
技能运行时负责：
- 安装与同步 embedded skill
- 导入/移除 custom skill
- 调度 Python / Node / Shell skill action
- 记录 jobs / schedules / stats

### 8.3 UI
技能中心当前支持：
- 系统技能与自定义技能分区展示
- 拖拽导入技能目录
- 默认命令生成
- 技能说明更新与删除/移除操作

## 9. 开发约定
### 9.1 新增跨进程功能的最小闭环
至少同步修改：
1. Main IPC handler
2. Preload API
3. Renderer 类型声明
4. Renderer 页面或组件
5. 至少一份相关文档（模块图 / 依赖图 / 进展 / 经验）

### 9.2 BrowserView 约定
- BrowserView 是原生层覆盖，不受 DOM `z-index` 控制
- 需要展示纯 DOM 覆盖层时，先 `hideAll()`
- 恢复浏览内容时，再 `showActive()` 并更新 bounds

### 9.3 日志约定
当前关键日志：
- `/tmp/ready-directchat.log`
- `/tmp/ready-tools.log`
- `/tmp/ready-browser.log`

## 10. 常用命令
```bash
npm run dev
npm run typecheck
npm run build
npm run lint:check
npm run test
npm run verify
```

## 11. 当前测试入口
`src/__tests__/` 当前包含：
- `agent-control.test.ts`
- `ai-provider-capabilities.test.ts`
- `browser-popup-policy.test.ts`
- `browser-tools.test.ts`
- `database.test.ts`
- `ipc-handlers.test.ts`
- `responses-parser.test.ts`
- `rss-analysis-manager.test.ts`
- `stores.test.ts`
- `tool-bridge.test.ts`
