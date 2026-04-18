# Ready 经验文档

> 更新时间: 2026-04-19

## 0. 视觉主题与启动

### 0.0 CSS 变量主题系统必须在首帧落 `data-theme` / `data-skin`，异步 IPC 不是可行路径
- 现象：Ready 用 `html[data-theme][data-skin]` 的属性选择器组合喂 CSS 变量，但启动期是先 `await window.electronAPI.theme.get()` 再写属性，IPC 抖动 / SQLite 延迟期间 `<html>` 上没有任何标记，CSS 只能命中 `:root` 的亮色默认值，而 liquid-glass 皮肤的 `--lg-material-*` / `--surface-blur` 等 token 全部缺席，用户看到"纯白平面调试态"。
- 固化规则：
  - 任何"用属性选择器切多套 CSS 变量"的方案，必须在 `index.html` `<head>` 里放同步 `<script>` 先从 `localStorage` 读并 `setAttribute`，再让 CSS 解析；IPC 只能作为后续"对齐"而不是"主写入"。
  - 同时在 `:root` 声明 `color-scheme: light dark`（并在 dark 主题覆盖为 `dark`），让原生滚动条/表单控件首帧就走正确配色。
  - Electron 的 `BrowserWindow.backgroundColor` 在非 macOS 平台不要留 `undefined`，必须按持久化的主题值给深/浅色，否则 mica/vibrancy 就绪前会先白一闪。

### 0.1 演出层背景色要独立于内容层 token
- 现象：主题切换过渡用 `background: var(--bg-primary)`；在 liquid-glass+light 下 `--bg-primary = #F7F9FC`（冷白微蓝），但用户日常感知的画布是 `--workbench-mode-bg = #F6F1E7`（暖米）。过渡中途出现的冷白与画布色温不符，被直接当成"既不是亮也不是暗"的 bug。
- 固化规则：
  - ritual / overlay / mask 这类演出层要有专门的语义 token（如 `--ritual-overlay-bg`），并通过 `:root` 间接层代理到"画布色"而不是内容色，未来改画布不会顺带改演出、反之亦然。
  - 切换演出不仅要关心"颜色正不正"，还要关心"与用户当前视野里那块主色的色温是否一致"；肉眼层级的差别比十六进制差别更重要。

## 1. 架构经验
### 1.0 Electron 开发态里，原生依赖 ABI 不匹配会把“设置丢失 / 历史空白 / scope not found”伪装成前端问题
- 这次真正的根因不是设置页没保存，也不是历史会话被清空，而是主进程数据库根本没起来。
- 直接症状：
  - 设置页看起来回到默认配置
  - 历史会话列表空白
  - 新建本地会话时报 `Database not available`，随后连锁变成 `Conversation scope not found`
- 真正原因：
  - `better-sqlite3` 是原生模块，必须按当前 Electron 版本重新编译。
  - 如果它是按别的 Node ABI 编出来的，Electron 主进程加载时会失败，但界面层很容易把后续连锁症状误判成“状态没读出来”。
- 这次的直接报错是：
  - `NODE_MODULE_VERSION 127`，但当前 Electron 需要 `NODE_MODULE_VERSION 132`
- 固化规则：
  - `package.json` 的 `dev / build / verify` 都要先跑 `electron-builder install-app-deps`
  - `postinstall` 也要补这一步，避免换环境后继续用旧的 `.node`
  - 排这类问题时，优先看 `ready-database.log`，不要先怀疑 Zustand、Settings 页面或聊天面板

### 1.1 “OpenAI 兼容”不等于真的兼容 tools
- 有些供应商虽然长得像 OpenAI API，但会吞掉 `tools` 或只实现一部分字段。
- 结论：不能只按 provider 名称分支，必须建立共享能力层，并允许原生调用失败后自动降级。
- 另外一类常见问题不是“完全不支持 tools”，而是只做了严格 schema 校验；像数组字段缺 `items` 这种在宽松通道里能混过去的小瑕疵，到了第三方兼容层会直接返回 400。
- 结论：工具 schema 也要经过统一修复和兜底，不要把“某个工具定义刚好写漏了”留给单个 provider 特判。

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

### 1.6 长任务不能只显示粗粒度 phase
- 只有 `planning / tool_running / done` 这类粗粒度状态时，聊天面板很难解释“现在卡在哪一步”“还能怎么继续”。
- 更稳的做法是把浏览器阶段、workflow blocker、最近产物和自动沉淀结果统一投影成宿主管理的任务摘要。
- 这层摘要最好由主进程保留最近状态，renderer 刷新后直接恢复，不要只依赖前端内存。

### 1.7 本地普通请求默认不要暴露 RSS / 日程 / 飞书工具
- 这次有一类跑偏不是模型“突然变傻”，而是我们把无关工具默认也暴露给了它。
- 当本地普通请求既不是 RSS，也不是日程，也不是飞书操作时，如果这些 capability group 仍然可见，模型就可能误打到 `rss_*` 或 `feishu_*`。
- 更稳的做法是：
  - `rss` 只在用户明确提到 RSS / 订阅源 / feed / RSSHub 时开放
  - `calendar` 只在用户明确提到日程 / 日历 / 会议 / 提醒 / 排期时开放
  - `channel_feishu` 只在远程渠道会话里默认开放，或用户明确提到飞书时开放
- 原则：能力宣告必须贴近当前意图，不能因为“技术上能调用”就默认让模型看见。

## 2. BrowserView 与前端壳层经验
### 2.1 BrowserView 是原生覆盖层
- BrowserView 不受 DOM `z-index` 控制。
- 任何侧栏、抽屉、悬浮层、动画布局只要与 BrowserView 共存，都必须把 bounds、显隐、动画节奏一起设计。

### 2.2 模式切换的丝滑体验：冻结帧是关键
- BrowserView 是原生层，无法参与 CSS 动画。水平滚动切换模式时，如果 BrowserView 还在显示，会出现"从侧边栏滑入"的穿帮感。
- **D方案核心**：所有模式常驻 DOM + 水平滚动容器，`isMotionSettled` 控制 BrowserView 显示时机。
- **冻结帧捕获**：必须在 `hideAll()` **之前**捕获当前画面，使用 `captureViewportSnapshot`（调用 `webContents.capturePage()`），而非 `captureWindowSnapshot`（只捕获主窗口）。
- **为什么 `captureWindowSnapshot` 不行**：`mainWindow.capturePage()` 只捕获主窗口渲染内容，BrowserView 是独立的 `webContents`，必须用 `view.webContents.capturePage()`。
- **缓存策略**：`cachedFreezeFramesByTabId` 按标签页缓存，切换回来时显示上次画面而非空白骨架屏。
- **显示优先级**：过渡期间 `freezeFrame ?? cachedFreezeFrame` → 动画结束 → 真实 BrowserView。

### 2.2b "无法挑剔的丝滑"级优化
在基础冻结帧之上，要达到极致丝滑还需：

**复合淡出动画（Opacity + Blur + Scale）**
- 仅用透明度淡出不够细腻，叠加轻微模糊（0→2px）和轻微缩小（1→0.998）能增强"沉入背景"的深度感
- 使用 JS 驱动的 `requestAnimationFrame` 动画配合 `ease-out-quart` 缓动，比 CSS transition 更可控
- 三属性同步动画：`opacity`（1→0）、`filter: blur()`（0→2px）、`transform: scale()`（1→0.998）

**预测性预捕获（Predictive Pre-capture）**
- 用户鼠标悬停在浏览器模式图标上时，立即触发 `browser.captureViewportSnapshot()`
- 这样点击发生时冻结帧已经准备好，消除"点击→截图→切换"的延迟
- 事件流：`mouseenter` → `BROWSER_PRE_CAPTURE_EVENT` → 后台 BrowserMode 执行 `captureStableFrame()`

**更激进的延迟优化**
- `BROWSER_SURFACE_READY_DELAY_MS` 从 24ms 降至 16ms（一帧@60fps）
- 预截图间隔保持 30s，但页面加载完成后立即补一次捕获
- 冻结帧淡出持续时间从 120ms 延长至 180ms，配合模糊效果更柔和

### 2.3 面板动画与 BrowserView bounds 需要解耦
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

### 2.8 站内点开子页面时，开页动作必须先走 renderer 接管
- 像 bilibili 这类站点，点视频未必是普通同页跳转，经常会走“新开页面”的链路。
- 如果主进程在 `window.open` 里直接自己创建新标签或新原生视图，而 renderer 侧的 tab store、地址栏和当前标签状态没有同步接管，就会出现“前面已经是新页面了，但地址栏还是旧网址、前进后退也还在控旧页、关闭后前景页面还残留”的脱节现象。
- 更稳的做法是：这类开页请求先发回 renderer，由 renderer 走统一的新标签创建和激活流程，再让主进程承载实际页面；不要让主进程绕过 renderer 状态层单独把页面抬到前台。

### 2.9 拖拽边界时如果要冻结 BrowserView，优先冻结整块浏览器区域，不要只冻内部网页
- 只抓内部网页视口来做拖拽态遮罩，看起来像成本更低，但会立刻碰到边缘拼接问题：顶部圆角、角落遮片、原生 host 外轮廓、DOM 壳层边框并不来自同一层，后面会连续出现“直角、缺角、白块、像被咬一口”的假象。
- 更稳的方式是直接抓取用户当前看到的整块浏览器区域，再用这张完整画面覆盖拖拽过程。这样顶部、圆角、边缘和网页内容来自同一张图，不需要在拖拽态继续拼角或补边。
- 同时，冻结层不要撤得太早。像百度、B 站这类页面在宽度变化后，网页自身的重排会比 BrowserView bounds 落位更慢一点；更稳的做法是在拖拽结束后继续保留冻结层一小段时间，并补几次最终 bounds 同步，再露出真实页面。

### 2.10 浏览器切回来的过渡层不要盖住标签栏
- 切回浏览器时，如果冻结层、启动遮罩、过渡遮罩都从最顶上直接铺满整个壳层，用户会先看到旧图压住标签栏，再看到真实头部弹出来，主观上就像“标签栏歪了一下”或“先没有再出现”。
- 更稳的做法是把这些过渡层统一收在标签栏下面，只负责网页内容区；顶部标签栏始终交给 DOM 头部自己稳定显示。
- 过渡层一旦缩到标签栏下面，冻结截图的抓取范围也要一起缩到网页内容区；如果还在抓整块浏览器壳层，就会把旧标题栏一起带进下面那层，表现成“上下两个标题栏闪一下”。
- 以后只要遇到“切回浏览器时头部错位、头部闪一下、头部像被旧图盖住”这类问题，先检查过渡层的 `top` 和圆角范围，而不是先怀疑标签数据或 BrowserView 显隐本身。

### 2.11 widget 更新目标不能污染下一条普通提问
- 如果上一轮从文档里点了“更新这个 widget”，聊天输入区会自动挂上一个 `document-widget-target` 目标；用户接着直接问别的问题时，这个目标如果还被一并发给 agent，就会把普通问答误判成文档 widget 任务。
- 更稳的做法是：发送前先看当前输入是否还像“更新 widget / 改文档”的请求；如果已经变成普通问答，就自动丢掉这个目标，不要把旧任务上下文继续带进新问题。
- 同时，执行层也要有第二道保险：即使模型还是胡乱调用当前轮未授权的工具，也必须在执行器里直接拒绝，不能只靠上游“理论上不会给它这个工具”。

### 2.12 新本地会话可以带摘要，但摘要不能直接驱动动作
- 这次排查里，“新开会话却还记着上一轮内容”并不是后端把多个 scope 真的串成了一个大池子；scope 本身是新的，只是提示拼装层会把当天全局摘要一起带进来。
- 摘要本身并不一定是坏事，问题在于工具权限如果也跟着摘要走，普通问答就会被旧任务带偏，表现成一上来就去开文档、改 widget、跑浏览器。
- 更稳的做法是：摘要可以继续给模型做参考，但工具开放必须只看当前这句用户请求和当前环境；如果这句只是问天气，就先答天气，最多在回答后建议“要不要顺手做成卡片”，不要直接进入卡片流程。

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

### 3.6 Browser 阶段最好直接暴露给用户
- Browser Agent V7 已经有稳定阶段顺序，但如果只把这些阶段写到日志或 tool trace，用户仍然不知道当前处于“确认附件”“填写提示词”还是“结果复核”。
- 更稳的方式是把阶段名直接投影到聊天任务卡里，并在刷新后保持最近任务摘要。

### 3.6b 浏览器统一层要先立合同，再迁逻辑
- 直接同时重写 `direct-chat`、`browser-agent-runner`、`browser-tools`，很容易把已有浏览器主链掰断。
- 更稳的顺序是先补统一合同：runtime adapter、page state、evidence service、planner。
- 等旧逻辑开始复用这些统一层之后，再逐步删掉分散判断，风险明显更低。

### 3.6c 结构化浏览器任务状态比纯阶段字符串更稳
- 只靠 `[计划]` / `[阶段]` 文本去驱动任务卡，文案一变就容易失配。
- 更稳的做法是保留人能读的阶段文案，同时额外输出结构化浏览器 task payload，让主进程和 renderer 直接消费显式字段。

### 3.6d 浏览器诊断要直接复用执行真相，不能另起一套猜测
- 如果诊断入口只显示 tab 数量、最近日志和 preview 状态，排查“为什么这轮任务没过”时帮助很有限。
- 更稳的做法是让 runner 和连续性层直接把当前任务、最近证据、页面摘要、最近失败原因喂给 diagnostics，再由 Browser 模式页内入口直接消费。
- 这样“聊天任务卡看到的”“浏览器诊断看到的”“恢复逻辑依赖的”会是同一份真相，不容易出现各处说法不一致。

### 3.6e 先补单轮执行 owner，比直接拆大文件更稳
- 直接上来重切 `runtime / orchestrator / direct-chat` 的职责，很容易在本地会话、远程通道和浏览器任务三条链上同时失血。
- 更稳的顺序是先补 `RunCoordinator`，让单轮执行 ownership 有唯一入口；再补 `RunProjection`，让任务摘要和前台投影先脱离 runtime 主文件。
- ownership 先稳住之后，再继续从 `DirectChatEngine` 主体里抽 tool visibility、tool dispatch 和 domain orchestration，风险明显更低。

### 3.7 自动记忆必须保守
- 会话结束后自动沉淀确实能提升下一轮表现，但如果把一次性上下文、临时路径、偶发要求也写成长期记忆，后续任务会越来越偏。
- 首版更稳的边界是只自动写入 `user_preference` 和 `summary`，并且允许在聊天里直接撤销或补充。

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

### 6.3 视觉样式排障不要只看代码和浏览器页
- Electron 壳层里的顶部控件、侧边栏控件，有时浏览器直接开 `localhost` 看到的是白页或不完整壳层，单靠源码猜“该改哪一层”很容易连续改错。
- 更稳的做法是直接截正在运行的 Electron 窗口，再只裁出目标区域对照；这次定位顶部四模式滑块时，真正有效的是 `screencapture -l <windowId>` 抓系统窗口，而不是抓浏览器里的开发页。

### 6.4 视觉“没变化”时，要先排查层级遮挡
- 顶部滑块这类控件，常见问题不是颜色值没改，而是图标和滑块底不在同一层级：要么图标被滑块盖住，要么滑块做得太透明，看起来像没变。
- 更稳的做法是同时检查两件事：
  - 激活底本身的颜色和透明度是否真的变了
  - 图标的层级是否压在滑块上面
- 这次如果只改底色，不提图标层级，最终视觉上会变成“图标被洗白”，用户体感依然像没改对。

### 6.5 文件管理这类下拉菜单，先排查“被壳层裁切”，不要急着动 BrowserView
- 这次文件管理的筛选 / 更多菜单，表面上看像是 BrowserView 压住了菜单，但真正的第一层问题其实是：`SidePanel.tsx` 和它的动画层本身就带 `overflow-hidden`，菜单如果仍然挂在 `FilesPanel.tsx` 内部，只要超出左侧栏边界就一定会被截掉。
- 更稳的排法是先分清：
  - 如果是“菜单只显示一半、边缘被切齐”，优先检查左侧栏壳层裁切；
  - 如果是“菜单完整但被网页盖住”，再去检查 BrowserView 层级。
- 正确做法是把这类菜单改成顶层弹层，再用触发按钮和左侧栏矩形去约束它的展开位置，而不是继续把菜单留在 `FilesPanel` 的 DOM 层级里硬调 `left/right/top`。

### 6.6 遇到左栏菜单问题时，不要为了“浮到最前面”直接把浏览器界面藏掉
- 这次一度把问题误判成“只要让 BrowserView 退掉，菜单就会正常”，结果虽然菜单不再被盖住，却把右边网页整块吃掉，用户体感更差。
- 更稳的原则是：
  - 左侧文件管理这类菜单，如果本来就应该待在左栏附近，优先修“菜单容器和定位策略”；
  - 不要为了修一个左栏下拉，就让整个浏览器内容区消失。
- 换句话说：**先修菜单自己的承载层，再考虑原生浏览器层**。如果菜单问题的根因是裁切，就不要拿 BrowserView 的显隐当万能扳手。

### 6.7 任何会展开的下拉菜单，都不要挂在会被动画裁切的头部层里
- 这次右侧聊天面板为了做“顶部先上滚、整块再收回”的动效，头部被包进了一个带裁切的动画层。结果“应用内”和“历史记录”两个下拉即使层级看起来更高，还是会被父层直接剪掉，表现成菜单只露一截、像藏在后面。
- 这类问题的第一原则不是继续调 `z-index`，而是先检查菜单有没有挂在：
  - `overflow: hidden` 的壳层里；
  - 带 `clip-path`、位移、收纳动画的父层里；
  - 会跟着面板一起做进出场裁切的容器里。
- 更稳的做法是：**像文件管理面板那样，把菜单直接挂到顶层浮层，再用触发按钮的屏幕坐标计算位置。**
- 以后只要是聊天头部、浏览器头部、侧栏头部这种“本身带动画”的区域，默认就不要把下拉菜单写成它的内联子节点，除非能明确证明父层不会裁切它。

### 6.8 半透明工作区底色只能选一个“承载层”，不要多层叠加
- 这次文档区和 RSS 区“明明改成同一个颜色却还是看起来不对”，根因不是颜色值本身，而是同一块区域同时被外壳、内容面、滚动层各自又铺了一层半透明底色。
- 这种问题在液态玻璃皮肤下尤其明显：叠两层以后就会明显发灰、发闷；空态如果最外层又被老规则打成透明，还会直接露出黑底。
- 更稳的做法是先明确一条规则：
  - 由最外层壳负责底色；
  - 内层滚动区和内容面默认透明；
  - 只有确实独立成块的预览面板，再单独给它自己的底色。
- 这次具体经验是：
  - 文档编辑区保留外层模块底色，内层 `document-editor-surface / document-preview-surface` 透明；
  - RSS 列表保留 `rss-feed-sheet` 这一层底色，`rss-feed-surface / rss-feed-scroll` 透明；
  - RSS 预览保留根面板底色，内部内容层透明；
  - 任何“兜底透明”规则都要检查空态，避免无内容时直接漏出宿主黑底。
