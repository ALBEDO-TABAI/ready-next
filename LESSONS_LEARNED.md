# Ready 经验文档

> 更新时间: 2026-03-24

## 1. 架构经验
### 1.1 “OpenAI 兼容”不等于真的兼容 tools
- 有些供应商虽然长得像 OpenAI API，但会吞掉 `tools` 或只实现一部分字段。
- 结论：不能只按 provider 名称分支，必须建立共享能力层，并允许原生调用失败后自动降级。

### 1.2 能力层比 provider if/else 更稳
- 把协议、wire API、工具能力、视觉能力、原生视频能力统一解析，比在多个模块里散落 `if (provider === ...)` 更容易维护。
- 设置页、direct-chat、browser vision、RSS 子代理最好共用同一份能力判断。

### 1.3 文本工具桥接是兼容层，不是首选通路
- 对不支持原生 function tools 的通道，文本桥接能兜底，但效果依赖模型是否严格遵守协议。
- 因此仍需保留：
  - 明确的桥接提示
  - 工具结果回灌格式
  - 模型误答”没有工具”时的自动纠偏

### 1.4 Skill workflow 不能靠模型自己记
- 如果让模型自己记 workflow，会出现跳步骤、忘 blocker、误读输入和无法定点重跑的问题。
- 更稳的方式是让宿主编译 workflow、持久化 execution state，并且只在 `need_input / need_confirmation / need_agent_result` 时把控制权交回 Claude。

### 1.5 runtime 结果必须结构化，不要只靠 stdout
- 仅靠 stdout/stderr 会迫使宿主猜结果，agent_task 也拿不到稳定 source materials。
- 更稳的方式是让 wrapper 通过 `READY_SKILL_RESULT_PATH` 写回 `SkillActionResult`，stdout 只做日志，不做主协议。

## 2. BrowserView 与前端壳层经验
### 2.1 BrowserView 是原生覆盖层
- BrowserView 不受 DOM `z-index` 控制。
- 任何侧栏、抽屉、悬浮层、动画布局只要与 BrowserView 共存，都必须把 bounds、显隐、动画节奏一起设计。

### 2.2 面板动画与 BrowserView bounds 需要解耦
- 面板收放、拖拽边界、浏览器区域缩放如果直接跟 BrowserView 高频同步，容易出现闪动、跳帧或遮挡。
- 更稳的做法是把”布局动画”与”原生视图刷新”分层处理，必要时在拖拽/收放期间降频或走更稳定的更新节奏。

### 2.3 浏览器头部交互最好由单一状态拥有者协调
- 当标签、地址栏、刷新/前进/后退 reveal 原本分散在多行、多组件里时，点击外部收起、输入态同步、hover 预热很容易互相打架。
- 更稳的做法是让单个 `BrowserHeader` 持有 `activeTabMode` 与 `refreshDockMode`，把 transient UI state 和持久化 browser data 分层。

### 2.4 renderer 里的 tab store 不能当成 Browser host 的真值来源
- Browser tabs/hosts 的真实生命周期在主进程；renderer 里的 Zustand tab store 只是投影缓存。
- 如果 renderer 重载后把本地 store 清空，却直接按“没有 tabs”去 `createTab()`，就会和主进程里仍然活着的原生 host 叠出双层页面，表现成逐层加载、旧页残留和边界错乱。
- 冷启动时也有类似竞态：如果 `createTab()` 发生在主进程拿到最新 `viewBounds` 之前，新 host 会短暂使用默认 `800x600` 尺寸。
- 更稳的做法是：browser mode 激活时先通过 `browser.getTabs()` 从主进程恢复现有 tabs，再决定是否真的需要创建新 tab；首次新建 tab 前显式等待 `updateBounds` 完成；同时切 tab/恢复 active host 时要先清掉所有非目标 host。

### 2.5 Browser 空态也必须保留可测量的内容容器
- 仅在“有标签页”时才挂 `contentRef`，会让 BrowserMode 空态下的首次 `createTab()` 拿不到真实内容区尺寸。
- 结果是主进程只能先用默认 `800x600` host 起步，再等后续 bounds 回写，肉眼上就会看到页面不跟边界自适应、重启后先窄后宽或像逐层加载。
- 更稳的做法是让 `BrowserModeEmptyState` 也挂上真实的 `contentRef` 容器，让首次新建 tab 和后续 `showActive()` 走同一套 bounds 测量链路。

### 2.6 排 BrowserView 边界竞态时先对 `createTab / updateBounds / showActive` 做时序核对
- 这类问题单看 UI 很容易误判成 DOM 布局、圆角 filler 或网页自身不自适应。
- 更稳的排法是直接对照 `ready-browser.log` 里的 `createTab / updateBounds / showActive` 时序，看看到底是谁先发生，以及发生时有没有拿到正确 bounds。

### 2.7 浏览器头部的瞬时菜单不要复用会改布局的 side panel
- 收藏、下载、更多这类”点一下就收起“的工具菜单，如果直接借用 renderer 里的侧栏或内联下拉，就会同时改动 flex 布局和 BrowserView bounds，表现成网页区域被横向挤压、头部高度被拉高，肉眼上像界面位移或闪动。
- 更稳的做法是把这类入口接到主进程 native menu，或者至少保证菜单不参与布局流；不要把瞬时菜单状态继续塞进 `activePanel` 这类会驱动整块工作区尺寸变化的状态里。

## 3. Browser Agent 经验
### 3.1 链接不是动作，只是资源
- 用户消息里出现 URL，不代表可以立刻导航。
- 更稳的方式是先把链接、附件、目标站点都收进任务资源，再决定执行路径。

### 3.2 附件先入资源层，不要伪造成文本
- 图片/文件单发若被伪造成”收到一张图”的文本，agent 会误触发完全错误的普通任务。
- 正确边界：附件先进入会话资源层，后续由 planner 或 browser workflow 显式消费。

### 3.3 浏览器任务必须按证据推进
- 上传、输入、提交都要有页面证据，不能靠”看起来像成功了”。
- 执行器负责推进步骤，不负责临场改写大方向。

### 3.4 连续性上下文能显著减少兜圈子
- 当前页状态、近期浏览器动作、上次 skill 运行结果、最近使用的附件，都是浏览器任务的重要上下文。
- 如果 planner 不利用这些上下文，模型很容易重复搜索、重复打开站点、重复上传同一附件。

### 3.5 视频输入不该一刀切关掉 tools
- 之前只要会话里残留视频，tools 就会被整体关闭，导致 Claude 明明具备 skill / Python 能力却回答“做不到”。
- 更稳的 gating 是：普通多模态轮次可降级，但显式 `/skill`、手动阶段控制、embedded python、活跃 execution 必须保留工具面。

## 4. 远程 IM 经验
### 4.1 “已连接”不等于真的在线
- Sidecar / 长连接需要真实心跳与错误回传，不能只靠本地状态假装在线。

### 4.2 远程会话也要遵守 scope 与附件边界
- 飞书线程进入前台会话后，仍要保持”会话隔离、附件资源化、工具日志不混正文”的原则。

## 5. 设计模块经验
### 5.1 tldraw 原生 text 的字号映射问题
- **问题**：tldraw 使用 `DefaultSizeStyle` (s/m/l/xl)，但实际渲染的字号与文档不一致
- **发现**：
  - tldraw 的 size=m 实际渲染为 32px，而不是文档中的 16px
  - 显示模式和编辑模式使用不同的 DOM 元素和样式
- **解决方案**：
  - 更新 `SIZE_TO_FONT_SIZE` 映射：`{ s: 18, m: 32, l: 48, xl: 64 }`
  - 用 CSS 强制覆盖显示模式（`[data-shape-type=”text”]`）和编辑模式（`contenteditable`）的字号
  - 确保两种模式使用相同的 fontSize 和 lineHeight

### 5.2 tldraw 文本编辑使用 contenteditable 而非 textarea
- **关键发现**：tldraw 使用 `tiptap ProseMirror` (contenteditable div) 来编辑文本
- **影响**：针对 textarea 的 CSS 规则无效，必须针对 `.tiptap`、`.ProseMirror` 和 `[contenteditable=”true”]`
- **最佳实践**：
  - 使用浏览器开发工具检查实际 DOM 结构，不要假设实现方式
  - 同时覆盖显示和编辑两种模式的样式
  - 使用 `!important` 确保覆盖 tldraw 的默认样式

### 5.3 调试设计模块的方法论
- **步骤**：
  1. 使用开发工具检查实际渲染的元素和样式
  2. 对比显示模式和编辑模式的所有相关样式（fontSize、lineHeight、fontWeight 等）
  3. 找出差异后，用 CSS 规则统一两种模式
  4. 验证 CSS 规则是否生效（检查 computed style）
- **工具**：
  - `window.getComputedStyle()` 获取实际应用的样式
  - `document.querySelector()` 定位具体元素
  - 控制台实时调试，避免反复重启应用

## 6. 协作与文档经验
### 6.1 跨 main / preload / renderer 的改动必须同步更新文档
- 至少同步：概览、开发文档、经验、进展、模块图、依赖图、结构快照。
- 否则后续排障时，大家看到的是过期项目结构图。

### 6.2 文档不只是总结，也要提供排障入口
- 对复杂模块，文档里应该直接写清：入口文件、日志文件、状态边界、关键限制。
