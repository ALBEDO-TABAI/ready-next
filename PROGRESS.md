# Ready 开发进展

> 更新时间: 2026-03-28

## 当前真值摘要
1. 当前基线是本地 `main`。
- 本地相对 `origin/main` 为 `ahead 100`。
- 这条基线已经吸收了 agent/runtime 拆分、browser service 化、repository 基线拆分、module handler 独立化、RSS runtime 与 browser-backed acquisition 的主要改动。

2. **Browser 模式切换体验已进一步打磨（冻结帧机制）**
- 修复了切换时"标签栏先出、内容后加载"的分段闪现问题。
- 关键修复：`captureSnapshot` 改用 `captureViewportSnapshot`（调用 BrowserView 的 `webContents.capturePage()`），而非 `captureWindowSnapshot`（只捕获主窗口，不含 BrowserView）。
- 切换前（`!isMotionSettled`）先执行 `captureStableFrame()` 保存当前画面，再 `hideAll()` 隐藏 BrowserView。
- 过渡期间显示冻结帧（`freezeFrame ?? cachedFreezeFrame`），动画结束后 BrowserView 真正就位再淡出。
- 每个标签页独立缓存冻结帧（`cachedFreezeFramesByTabId`），切回时显示上次画面而非骨架屏。

2. Agent/runtime 底座已经落地到可继续迭代的状态。
- `useAgent` 不再独自承担整条执行链。
- 运行态按 `runId + scopeId` 路由。
- runtime routing、message composition、module execution、scope-run patching 已拆入独立模块。

3. Browser 主干已经完成第一轮架构收口。
- main-process browser 逻辑已拆成 shell、lifecycle、preview、automation、data、diagnostics、download、session policy、layout 等 services。
- renderer 侧 browser shell、layout、diagnostics entry 已从页面容器中拆出。
- preview/context-menu/browser overlay 相关层级问题已处理过一轮。

4. Repository 基线已经建立。
- browser/chat/rss/calendar/settings/agent 的主要访问路径已不再依赖旧式跨域 `getDatabase()` 直连。
- 之前的 `database.ts` 静态/动态混合导入告警已清掉。

5. Workbench 模块已进入统一执行模型。
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

6. RSS 已经具备独立维护条件。
- packaged/runtime RSSHub 可观察、可修复、可诊断。
- route diagnostics 和 benchmark 结果会持久化。
- browser-backed acquisition 已切到优先复用应用内浏览器路线。
- 单源刷新语义、`lastFetchInvocation` 诊断、preview 关闭覆盖 RSS 面板 bug 都已收口。

7. Skill runtime 已完成 Claude workflow 执行底座升级（2026-03-15）。
- 新增 `skill-execution-types.ts`、compiler / loader、execution state store、execution coordinator、prompt builder。
- embedded skills 已拆分为 `workflow / advisory / direct` 兼容模式：
  - `video-copy-analyzer`：workflow
  - `video-expert-analyzer`：workflow
  - `lets-go-rss`：advisory + direct runtime utility
- 新增 `skill_get_state / skill_submit_input / skill_submit_confirmation / skill_submit_agent_result / skill_restart_from_step / skill_cancel_execution`
- 新增 `system_run_embedded_python`
- skills center 已新增 Recent Executions 和 blocker 继续入口
- direct-chat 已加入视频输入下的 skill/python tools 保留策略，以及 OpenAI tool history repair

## 当前最高优先级
1. ~~小红书 / 抖音 / 微博的 RSS 获取链路收尾~~（已完成）。

2. ~~工作台顶部三行视觉对齐~~（已完成）。

3. **下一阶段主线**：
- `PromptAssemblyService + L0/L1/L2 memory`（Agent 记忆系统）
- `Feishu capability replacement`（飞书能力替换）

## 当前未完成项
- Weibo/Xiaohongshu/Douyin 仍未全部完成最终实机签收。
- Workbench 顶部三行在各模块下仍需最后一轮视觉对齐。
- Browser diagnostics 仍是 panel，不是完整 lab。
- Browser orchestration 仍有最后一层收口空间。
- Browser unified header 还需要一轮实机动效与窄宽度体验微调，但结构性切换已完成。
- skill workflow 仍缺少更细的 execution UX 打磨与更多样例 skill 迁移。
- **`PromptAssemblyService + L0/L1/L2 memory` 还未启动**（下一阶段主线）。
- **Feishu capability replacement 还未启动**（下一阶段主线）。

## 建议的继续顺序
1. ~~先做 RSS 三条源的最终签收~~（已完成）。
2. ~~再做顶部三行和 tabs 的视觉基线收口~~（已完成）。
3. **接下来回到底座主线**：
   - **`PromptAssemblyService + L0/L1/L2 memory`**（Agent 记忆系统）
   - **`Feishu capability replacement`**（飞书能力替换）
   - Browser orchestration 最后收口
   - Diagnostics labs 完整化

## 最近一次有效校验
- `npm run typecheck:node` 通过
- `npm run typecheck:web` 通过
- `npx tsx@^4.19.2 --test src/__tests__/ui-browser-hook-split-contract.test.ts src/__tests__/browser-engine-services.test.ts src/__tests__/browser-unified-header-contract.test.ts` 通过
- `npx tsx@^4.19.2 --test src/__tests__/browser-unified-header-contract.test.ts src/__tests__/browser-host-visibility-contract.test.ts src/__tests__/ui-browser-hook-split-contract.test.ts` 通过
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

## 体积基线
- 仓库总大小：`2.7G`
- `logs`：`1.0M`
- `out`：`24M`
- `dist`：`924M`
