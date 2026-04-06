# Ready 开发文档

> 更新时间: 2026-03-31

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
- `rss`
- `calendar`

入口壳层：`src/renderer/pages/WorkbenchMode.tsx`

状态归属补充：
- 工作台双模式分栏比例由 `useMode.workbenchSplitRatio` 管理
- 文档页双栏分屏比例由 `useDocTabs.documentSplitRatio` 管理
- 两者不是同一份状态，不要跨用

## 3. 主模块说明
### 3.1 Browser
- 前端：`src/renderer/pages/modes/BrowserMode.tsx`
- 后端：`src/main/modules/browser-engine/*`
- 说明：多标签、BrowserView 边界管理、历史/书签/下载、右键菜单、popup policy

### 3.2 Document
- 前端：`src/renderer/pages/modes/DocumentMode.tsx`
- 后端：`src/main/modules/document-engine/*`
- 说明：多格式读取、编辑文本抽取、`document_*` 工具
- 文档页自己的双栏分屏状态保留在 `src/renderer/stores/useDocTabs.ts`

### 3.3 RSS / Calendar
- RSS：`src/renderer/pages/modes/RSSMode.tsx` + `src/main/modules/rss-engine/*`
- 微博 / 抖音 / 小红书已统一按应用内浏览器主链抓取；失败时优先引导回 Ready 浏览器处理登录态或验证，不再走 RSSHub 回退
- Calendar：`src/renderer/pages/modes/CalendarMode.tsx` + `src/main/modules/calendar-engine/*`

### 3.4 Agent / Skills / Remote IM
- Agent：`src/main/modules/claude-bridge/*`
- 会话与远程通道：`src/main/modules/agent-control/*`
- 工具：`src/main/modules/tools/*`
- 技能运行时：`src/main/modules/skills-runtime/*`
- Python sidecar：`src/python/ready_sidecar/*`

### 3.5 Shared / Renderer Utilities
- 共享 URL 工具：`src/shared/url-utils.ts`
  - `getUrlHostname()` 供主进程策略判断使用
  - `getRegistrableDomain()` 供 renderer 展示与同域聚合使用
- renderer 本地存储工具：`src/renderer/utils/storage.ts`
  - 统一封装字符串与 JSON 的读写
  - 保持现有 localStorage key 与数据格式不变

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

### 7.1b Scope Run 摘要
- 主进程会为最近 scope run 维护任务摘要，供聊天面板刷新后恢复最近任务。
- 统一任务字段包括：`taskTitle / taskSummary / steps / currentStepId / waitingFor / resumableActions / recentArtifacts / memoryCapture`
- Browser Agent V7 阶段会直接投影成步骤；workflow skill blocker 会映射成 `input / confirmation / agent_result` 等等待态。

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
- 编译 `ready-skill.json + skill.workflow.json + SKILL.md`
- 持久化 workflow execution / step history / artifacts
- 对 workflow skill 提供 blocker-based resume / restart-from-step

### 8.3 UI
技能中心当前支持：
- 系统技能与自定义技能分区展示
- 拖拽导入技能目录
- 默认命令生成
- 技能说明更新与删除/移除操作
- Recent Executions 区域，展示 status / current step / blocker / recent artifacts
- 在 blocker 为 `need_input / need_confirmation / need_agent_result` 时直接继续提交 execution

### 8.3b ChatPanel 任务区
- Agent 聊天面板新增 `当前任务 / 后台任务` 两块任务视图，不再只靠 tool trace 胶囊表达进度。
- `当前任务` 优先显示当前 scope 的活动任务或刚完成任务。
- `后台任务` 按当前频道来源显示最近仍活跃、阻塞中、或刚完成的 scope run。
- 若任务带有 `memoryCapture`，聊天里会直接展示本次自动沉淀的偏好/摘要，并支持确认、撤销、补充。

### 8.4 Workflow Skill 协议
- `ready-skill.json` 负责 skill 元信息、actions、visibility、execution mode
- `skill.workflow.json` 负责 step、inputs、transitions、agent_task / confirmation / user_input
- `SKILL.md` 只做人类说明，不再承担机器协议职责
- 公开 action 才会暴露为模型工具；`visibility: "internal"` 仅供 workflow step 调用

### 8.5 Claude / OpenAI 兼容修复
- `direct-chat` 现在会在视频输入场景下，为显式 `/skill`、手动阶段控制、embedded python 请求、活跃 execution 保留 tools
- OpenAI `chat/completions` / `responses` 发请求前都会修复缺失的 tool response history，避免 `tool_call_id` 400
- `need_agent_result` blocker 会自动注入文本类 source materials 正文，而不是只告诉模型文件路径

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
- 工作台切到非 browser 可见态时，优先由壳层统一调用 `browser.hideAll()`，不要只隐藏 active tab host；否则 RSS preview / popup 这类原生子视图可能残留在前台
- Browser 运行态初始化要尽量做到“一次准备，多次复用”：已有 tab 可在后台预热恢复，但不要因为后台预热强行新建空白页
- browser 回场时可以在壳层离场覆盖还没收完之前提前露出原生 host，但 browser 切出时仍要尽早 `hideAll()`，不要让原生网页和 DOM 过场抢前台

### 9.3 Workbench Keep-Alive 约定
- `src/renderer/components/layout/WorkbenchModeOutlet.tsx` 负责 browser / document / rss / calendar 四个主模式的常驻挂载
- 模式切换仍保持四模块常驻，不回退到“切一次挂一次”；但共享壳层现在会额外编排左右切页，让当前页和离场页短时并存后再收口
- 左右切页只发生在共享壳层，不要把整区重动画重新下放到各模块内部
- 动效语言固定为三类：
  - document / rss / calendar 之间：整块水平切换，旧页完整横向离场，新页从反侧完整进入
  - browser -> 非 browser：browser 保持原位不动，目标模块横向进入并覆盖它
  - 非 browser -> browser：browser 保持原位不动，当前模块横向退出并把它露出来
- 共享壳层若依赖截图做离场层，不能在点击后再同步等待截图结果才开始切换；应优先复用稳定缓存，避免“点了半拍后才动”
- 连续快速切换时以最后一次点击目标为准；中途点击不能被静默丢弃
- 页面级副作用必须感知 `isActive`
- RSS：隐藏时暂停 analysis polling / auto refresh，可见时再做一次数据同步
- Calendar：重量级 Schedule-X 初始化延后到首次激活，隐藏时不继续做 UI 同步
- RSS preview：模式隐藏时必须关闭 preview host，重新显示时再按当前 item 恢复
- 顶栏四模块切换器使用稳定最小宽度，避免 active/hover 状态引发布局抖动
- 切换方向按 `browser -> document -> rss -> calendar` 的顺序决定：向右切时旧页向左出、新页从右入；向左切时严格镜像
- browser/rss/calendar 的内部 header rail 需要和 document 模式共享左边界；`workbench-canvas-shell` 负责统一圆角矩形轮廓，子模块不要再各自切半圆角壳
- BrowserMode 若通过 `requestAnimationFrame` 延后恢复原生 host，必须可取消；切出 browser 时统一走 `hideAll()`，避免旧 RAF 把 BrowserView 再次抬回前台
- BrowserMode 在原生页面尚未稳定前，不应先露出真实顶部 chrome；优先只收起顶部浏览器栏，避免把整块浏览器区域一起藏掉
- BrowserMode 若已经完成过 tab 恢复或首个 tab 创建，后续模块切回不应再把 `browserRuntimeReady` 重置到冷启动态
- 主进程在 `browserHostsPresented = false` 时不应继续把 renderer bounds 应用到 active host；隐藏态只记录最新 bounds，不重新摆回可视区
- liquid-glass 皮肤下若某模块没有额外顶部 shell 参与勾边，需要为该模块补回最小可见 outline；当前 RSS 使用这一例外规则
- 顶栏四模块切换器当前使用普通稳定按钮组；如果未来重新引入高动态 segmented control，必须先验证 hover/active 不会造成几何偏移
- 顶栏四模块切换器点击切换应优先走短促直达动画；只有拖动释放时才保留弹簧回弹，避免与主工作区过场叠加成拖泥带水

### 9.4 日志约定
当前关键日志位于系统临时目录（macOS: `/tmp/`, Windows: `%TEMP%`）：
- `ready-directchat.log`
- `ready-tools.log`
- `ready-browser.log`

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
- `browser-host-visibility-contract.test.ts`
- `database.test.ts`
- `ipc-handlers.test.ts`
- `responses-parser.test.ts`
- `rss-analysis-manager.test.ts`
- `stores.test.ts`
- `tool-bridge.test.ts`
- `workbench-keep-alive-contract.test.ts`
- `workbench-shell-alignment-contract.test.ts`
