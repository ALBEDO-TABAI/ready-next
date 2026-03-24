# Ready 开发进展

> 更新时间: 2026-03-24

## 当前真值摘要
1. 当前基线是本地 `main`。
- 本地相对 `origin/main` 为 `ahead 29`。
- 这条基线已经吸收了 agent/runtime 拆分、browser service 化、repository 基线拆分、module handler 独立化、RSS runtime 与 browser-backed acquisition 的主要改动。

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
- design/video/rss/calendar 的 agent handler 已从页面组件中拆出。
- browser/RSS/calendar/design/video 都有基础 diagnostics panel。
- browser/document/design/video 的 tabs/chrome 已进入共享路径。
- document 与 design 已从”tab 行里塞操作”改成”tabs + toolbar”结构。
- browser / document / rss / calendar 的工作台切换已补上 keep-alive 壳层：四个主模式会在 outlet 内常驻挂载，切换只改 CSS 显隐，不再依赖访问后首次挂载 + motion 动画切场。
- 非活跃模式已开始进入“前台激活、后台挂起”节奏：RSS 轮询/自动刷新只在可见时运行，Calendar 的 Schedule-X 初始化延后到首次激活，RSS 预览在模式隐藏时会主动关闭原生 preview host。
- 当当前可见模式集合不含 browser 时，Workbench 壳层会统一走 `browser.hideAll()`，避免只隐藏 active host 却遗漏 preview/native overlay。
- 顶栏四模块切换器已收敛为稳定宽度，去掉了会造成视觉抖动的纵向位移；browser/rss/calendar 的工作区外轮廓和左边界也已向 document 模式对齐。
- BrowserMode 重新显示原生 host 的逻辑已加上 RAF 取消与 `hideAll()` 收口，避免切离 browser 后被延迟回调重新抬回前台；RSS 在 liquid-glass 下恢复了可见的圆角 outline。
- 顶栏四模块切换器已进一步退回普通按钮组，不再依赖 gooey segmented control；主进程隐藏态下也会跳过 BrowserView bounds 回写，进一步降低原生视图抢前台风险。
- BrowserMode 顶部浏览器 chrome 已从 “`BrowserTabBar + BrowserAddressBar` 两层结构” 收口为单层 `BrowserHeader`：左侧 refresh dock 支持 hover reveal，激活标签改为可展开地址面，右侧工具按钮独立收口。
- 浏览器右上收藏 / 下载 / 更多已切到主进程 native utility menu：renderer 不再通过 `activePanel` 拉起 `BrowserSidePanel`，`useBrowserViewBounds` 也不再把这类瞬时菜单当成布局变化源，点击按钮不会再把网页内容横向或纵向推移。
- Browser cold start / renderer reload 的 host 恢复链路已补齐：空态也提供可测量 `contentRef`，renderer 会先 `browser.getTabs()` 恢复主进程 tabs，再 `await sendBoundsImmediate()` 后才 `showActive()` / `createTab()`，避免默认 `800x600` host 抢跑导致的边界不自适应。

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

7. **设计模块已完成核心改进（2026-03-10）**。
- **”假成功”问题已修复**：所有设计工具调用都返回真实结果或明确错误，AI 能基于真实执行结果做决策。
- **语义控制能力已扩展**：支持圆角、字号、字重、行高、对齐、间距、颜色、边框等高频控制。
- **语义控制已应用到设计生成**：typography、board、layoutStrategy、styleGuide 生成逻辑已集成新的语义控制。
- **创建工具支持 meta 属性**：可以一步到位设置样式，不需要二次更新。
- **design_update_selected 工具已实现**：简化选中元素更新流程，从 2 步简化为 1 步。
- **UI 增强已完成**：缩放控制、+ 键新增标签、水印移除。
- **UI 视觉优化已完成**：隐藏横向分隔线、竖向分隔线隐约可见、所有面板统一浅米色背景。
- 详见 `DESIGN_MODULE_IMPROVEMENTS_SUMMARY.md`、`DESIGN_UPDATE_SELECTED_IMPLEMENTATION.md`、`DESIGN_UI_ENHANCEMENTS.md`、`UI_VISUAL_OPTIMIZATION.md`。

## 当前最高优先级
1. ~~小红书 / 抖音 / 微博的 RSS 获取链路收尾~~（已完成）。

2. ~~工作台顶部三行视觉对齐~~（已完成）。

3. ~~Design inspector 高频能力补齐~~（已完成）。
- ✅ 修复”假成功”问题
- ✅ 扩展语义控制类型（圆角、字号、字重、行高、对齐、间距、颜色、边框）
- ✅ 创建工具支持 meta 属性
- ✅ 应用语义控制到设计生成逻辑
- ✅ design_update_selected 工具实现
- ✅ UI 增强（缩放控制、+ 键行为、水印移除）
- ✅ UI 视觉优化（隐藏横向分隔线、统一面板背景色）

4. **下一阶段主线**：
- `PromptAssemblyService + L0/L1/L2 memory`（Agent 记忆系统）
- `Feishu capability replacement`（飞书能力替换）

## 当前未完成项
- Weibo/Xiaohongshu/Douyin 仍未全部完成最终实机签收。
- Workbench 顶部三行在各模块下仍需最后一轮视觉对齐。
- ~~Design inspector 仍缺高频属性控制~~（已完成）。
- Browser diagnostics 仍是 panel，不是完整 lab。
- Browser orchestration 仍有最后一层收口空间。
- Browser unified header 还需要一轮实机动效与窄宽度体验微调，但结构性切换已完成。
- skill workflow 仍缺少更细的 execution UX 打磨与更多样例 skill 迁移。
- **`PromptAssemblyService + L0/L1/L2 memory` 还未启动**（下一阶段主线）。
- **Feishu capability replacement 还未启动**（下一阶段主线）。

## 建议的继续顺序
1. ~~先做 RSS 三条源的最终签收~~（已完成）。
2. ~~再做顶部三行和 tabs 的视觉基线收口~~（已完成）。
3. ~~再补 design inspector 高频缺口~~（已完成）。
4. **接下来回到底座主线**：
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
- `npx tsx@^4.19.2 --test src/__tests__/skill-compiler-smoke.test.ts src/__tests__/skill-resolver-smoke.test.ts` 通过
- `python3 -m py_compile` 已校验新 wrapper 脚本语法
- `npm test` 通过，最近一次全量通过为 `173` 个测试
- `npm run build` 通过

## 体积基线
- 仓库总大小：`2.7G`
- `logs`：`1.0M`
- `out`：`24M`
- `dist`：`924M`
