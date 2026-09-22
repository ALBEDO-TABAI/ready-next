---
title: 浏览器性能与动态负载优化实施计划
date: 2026-07-17
status: completed
enforce: false
owner: 白
original_author: Claude (Fable 5)
reviewed_by: Codex
scope: 标签页动态降载与休眠、启动懒恢复、事件/IPC 管线收敛、分栏双开交互、后台服务静态开销、相邻模块热点
note: >
  证据与问题分级见配套审计 2026-07-17-browser-performance-dynamic-load-audit.md（下称「审计」）。
  本计划按阶段推进：每阶段先落机器可验证合同，再改实现；单阶段独立过 gate，不一次性大爆改。
  遵守架构红线：修根因不修症状、不留 legacy 兼容分支、跨边界状态显式建模、
  新逻辑进新 service 文件（browser-engine/ipc-handler.ts 已在大文件健康日志挂「危险」，禁止再增肥）。
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# 浏览器性能与动态负载优化实施计划

## Codex 复审后的实施裁决

本节覆盖 Claude 初稿中与当前 Electron 42 或用户无感目标冲突的部分：

1. 指标按真实 OS pid 聚合，一个进程记录 `tabIds[]`；不伪造“每个标签独占一份进程 CPU/内存”。
2. 状态机统一为 `visible | protected-background | throttled | dormant`。`visible` 包含主栏和副栏；`protected-background` 只用于音频、下载、Agent/采集、原生权限/登录弹窗和短暂切换宽限；其余不可见 live tab 交回 Chromium 节流。
3. 启动懒恢复无条件实施：只物化 active + split，其他标签保留原 id、标题、favicon、分组和 profile 的 dormant 记录。运行期回收不采用“到点就杀”的 30 分钟策略；只有 live-view 预算超限或真实 renderer 内存压力达到阈值，且标签经过可恢复性检查后才回收。
4. 冷标签回收前保存 `navigationHistory.getAllEntries()`、active index 和 Chromium pageState；恢复统一走一个 materialize 入口。音频、下载、运行中任务、required、最近交互、权限/登录流程、下载中和无法取得恢复快照的标签不得回收。阈值按系统内存自适应，不增加让用户反复确认的门槛。
5. Main 不再接收 `syncMode`；Renderer 的单 rAF 是 bounds 唯一节拍。只有会改变 DOM/原生遮挡先后关系的 hide/show intent 请求 ack，普通 bounds 无回程。
6. RSSHub 改为首个真实 RSSHub 请求懒启动，并在最后活动 15 分钟后停掉 Node worker；不再把“Node worker”误写成“必然常驻 Chromium 树”。
7. browser+document 的浮层使用通用矩形登记与相交裁决，不维护按组件名 hardcode 的安全名单；browser+rss 除行级 memo/useMemo 外，长列表还要有视口降载合同。
8. 透明材质和 LiquidBackdropProjection 只有真机/Profiler 证明是热点才改；没有证据时记录为非阻塞观察项，不以性能名义改变视觉设计。

完成标准还包括配套的 document performance 合同，因为 browser+document、document+document、browser+rss 的同屏成本不能只用浏览器单面测试证明。

## 0. 总目标与不变式

### 0.1 产品目标

1. **低资源占用**：空闲态（N 个后台标签页 + 无任务）renderer 进程群 CPU 占用接近 Chromium 默认后台基线；启动只物化可见标签，运行期 live-view 数量由自适应预算约束；应用空闲时不常驻 RSSHub worker。
2. **动态负载调整**：标签页按「前台 / 可见副屏 / 后台 / 休眠」四态显式建模，状态驱动降载；agent 任务、音频播放、采集中的页面获得豁免，绝不误伤正在干活的页面。
3. **双开丝滑**：browser+browser / browser+document / browser+rss 分栏下，拖拽、切换、滚动全程不掉帧、无白边、浮层不被原生层错误遮盖。

### 0.2 全程不变式（每阶段回归）

- CLAUDE.md §2 的 BrowserView hide-all intent + ack 合同不变：Browser 离开可见 mode 集合前必须 hide-all + 匹配 ack。
- capability floor、采集验收、租约单写者等既有合同不变；本计划只动资源与呈现层，不动工具面语义。
- 降载/休眠**永不改变用户可见状态语义**：tab 列表条目不消失、标题/favicon 不丢、激活后必须回到原 URL（历史尽量保留，见 P2 裁决）。
- 所有新增跨边界状态（tab 负载态）经显式状态机建模并可查询，禁止 fire-and-forget。

### 0.3 阶段总览与依赖

| 阶段 | 主题 | 解决的审计项 | 依赖 |
|---|---|---|---|
| P0 | 观测与基线 | §9 观测缺失 | 无 |
| P1 | 后台标签页动态降载 | P0-1、P0-4 | P0 |
| P2 | 懒恢复与标签页休眠 | P0-2、P0-3 | P1 |
| P3 | 事件与 IPC 管线收敛 | P0-5、P1-2、P1-3、P1-8 | P0 |
| P4 | 分栏/双开交互收敛 | P1-1、P1-4、P1-5、P1-6、P1-7、P1-12 | P3 |
| P5 | 后台服务静态开销 | P0-6、P1-9、P1-10、P1-11 | 无（可并行） |
| P6 | 相邻模块热点（可选） | §8.1、§8.2 | P0 |

P1→P2 是"动态负载调整"主线；P3 是"丝滑"的 renderer 侧主线；P5 独立可并行先行（含两个低风险高收益快赢）。

---

## P0 观测与基线（1 个 PR，先行）

### 目标

没有量测就没有验收。建立最小观测面 + 记录基线，后续每阶段用同一口径对比。

### 改动面

1. 新文件 `src/main/modules/browser-engine/browser-metrics-service.ts`：
   - 按需采样 `app.getAppMetrics()`，用 `webContents.getOSProcessId()` 建立 pid 到 tabId 集合的归属，输出进程级 `{pid, tabIds, domains, cpuPercent, memoryKB, loadStates}`。同 pid 的内存只计一次。
   - 暴露一个诊断 IPC（挂进现有 BrowserDiagnosticsDock 面板），**默认不采样**，打开诊断面板才启动（采样间隔 ≥2s），关闭即停。禁止常驻定时器。
2. dev-only IPC 计数器：`browser:intent` / `browser:tabUpdate` 两通道按 kind/type 计数（环形窗口 60s），进同一诊断面板。
3. 基线脚本化场景（手工执行 + 记录进本文件附录）：
   - S1 空闲：10 个真实站点标签页，切到 document mode，静置 5 分钟，记录各 renderer CPU/内存。
   - S2 双开拖拽：browser 双开，连续拖分栏 5s，记录 intent/ack 条数与主进程 CPU。
   - S3 导航风暴：单标签页连续导航 10 次，记录 tabUpdate 条数与 localStorage 写次数。
   - S4 冷启动恢复：20 个持久化标签页冷启动，记录首屏可交互时间与进程数曲线。

### 合同与 gate

- 行为测试：诊断关闭时 metrics 服务无活动定时器（真实入口断言，不 source-grep）。
- `npm run verify:browser-perf`（新聚合入口，本阶段起挂 P0-P4 各阶段行为测试）。

### 验收

- 四个场景基线数字回填本文件附录 A；诊断面板真机可见 renderer 进程 CPU/内存及其关联 tabId 集合。

---

## P1 后台标签页动态降载（"动态负载调整"核心）

### 目标

后台标签页交还 Chromium 的降频保护并叠加显式豁免模型；消灭 hide-all 的 O(N) attach。S1 场景下后台标签页 CPU ≈ 0。

### 设计：TabLoadGovernor（新文件 `browser-engine/tab-load-governor.ts`）

四态状态机，Main 侧唯一真值，事件驱动（无轮询）：

```
visible                 # activeTabId 或 splitTabId 且原生 surface 可见
protected-background    # 不可见但因音频/下载/Agent/权限流程暂不降载
throttled               # 不可见，backgroundThrottling 生效
dormant                 # view 已销毁或尚未物化，仅存可恢复记录
```

- 输入事件：switchTab / split 变更 / hide-all / show / audible 变化（`webContents` `'audio-state-changed'`）/ download 状态 / agent 租约 acquire・release / 采集任务绑定・终态 / 权限与登录弹窗生命周期 / 用户输入。
- 输出动作：`webContents.setBackgroundThrottling(bool)`（Electron 42 支持运行时切换）；状态迁移写诊断日志 `browser_tab_load_state`（含 reason），供 P0 面板与测试消费。
- **豁免集（进入 protected-background 的条件）**：`isCurrentlyAudible()===true`；tab 正在下载、被 agent 租约持有或绑定运行中的采集任务；`required===true`；存在权限/登录弹窗；最近 30 秒内曾是前台。豁免条件消失即回落 throttled。
- webPreferences 侧：`host-layout-service.ts:34` 的 `backgroundThrottling:false` **删除**（回到默认 true），前台/豁免态由 governor 运行时显式 `setBackgroundThrottling(false)`。创建即前台的 tab 在 createTab 完成后立即由 governor 标为 foreground，无空窗。
- 采集探针窗口（审计 P0-1 波及面）：它不是用户 tab，不伪装登记进 tab governor；作为任务态、有界生命周期的独立探针保留全速，任务终态必须走既有销毁路径。

### hideAllHosts 修复（P0-4）

- `hideHost` 拆分语义：只对**当前 attached** 的 view 做屏外隐藏；未 attach 的 view 不再"先 attach 再隐藏"。`hideAllHosts` 只遍历 attached 集合（`host-layout-service` 已有 `attachedHosts` WeakSet，改为可枚举的 Set&lt;tabId&gt; 由调用层维护）。
- 不变式不破坏：hide-all 后 `showActiveHost` 的恢复路径行为不变（对 detach 的 view showHost 本来就走 attach）。

### 合同与 gate（先写后改）

- 行为测试 `browser-tab-load-governor.test.ts`：
  1. 三标签页 A/B/C，激活 A → B、C 收到 `setBackgroundThrottling(true)`；切到 B → B false、A true。
  2. C audible=true 时切走 → C 保持 false（protected-background）；audible 变 false → 回 true。
  3. agent 租约持有 B 期间切走 → B 保持 false；release 后回 true。
  4. 状态迁移全部产生带 reason 的 `browser_tab_load_state` 记录；任意时刻 foreground 集合 = {active, split}。
- 行为测试：hide-all 在含 5 个 detach 标签页的场景下，attach 调用次数 = 可见标签页数（≤2），而非 5。
- 结构 gate `scripts/check-browser-background-throttling-governor.cjs`：webPreferences 不得再出现 `backgroundThrottling:false`（tab 创建路径）；`setBackgroundThrottling` 只允许出现在 governor 文件。

### 验收

- S1 复测：后台 8 个标签页 renderer CPU 合计 < 基线的 10%（记录具体数字）。
- 真机回归：视频网站后台播放不被降频打断（audible 豁免）；agent 采集切后台不失败；hide-all/show 往返（开关设置页）无闪烁。

### 风险与处理

- 个别站点后台节流后若出现可复现的功能问题，先按任务/音频/下载/权限等真实运行事实补豁免，不写平台名单。只有事实模型无法表达时才扩展站点卡声明，并配行为测试。

---

## P2 懒恢复与标签页休眠（内存上界）

### 目标

启动只加载前台标签页；后台标签页可休眠回收进程，激活即恢复。S4 冷启动进程数从 N+1 降到 ≤3；长会话内存有上界。

### 设计

1. **懒恢复（P0-3）**：
   - Main 侧 tab 记录允许 `view === undefined` 的 `dormant` 形态（记录 url/title/favicon/profile）。恢复入口 `rebuildRuntimeFromPersistedTabs` 改为：仅 active（+split）tab 真实 `createTab`，其余登记 dormant 记录（新 IPC `browser:registerDormantTabs`，一次批量）。
   - `switchTab` 命中 dormant 记录时先物化（createHost + loadURL）再走现有 show 流程；物化失败按现有 did-fail-load 路径呈现。
   - Renderer 无感：tab strip 照常显示 dormant 条目（已有 title/favicon），loading 态在激活物化时出现。
2. **运行期冷标签回收（P0-2）**：
   - Governor 在 live-view 数量超过自适应预算，或真实 renderer working-set 超过系统内存软阈值时，按最久未交互顺序挑选 `throttled` 标签。预算按总内存分档并设合理上下界，不暴露需要普通用户理解的“4GB/30min”旋钮。
   - 回收前必须取得完整 navigation entries + active index；Electron 42 的 entry 自带 Chromium `pageState`。取得失败则本轮跳过，不降级为只存 URL。回收只销毁 view，保留 tab id、profile、group、title/favicon 和恢复快照。
   - `visible`、`protected-background`、最近 5 分钟有用户输入、下载中、权限/登录流程、Agent/采集绑定、required 或恢复快照缺失的标签永不作为候选。内存压力检查在标签生命周期事件触发，并仅在存在冷候选时保留一个低频、可取消、`unref` 的复查 timer；空闲无候选时零定时器。
   - 激活恢复与启动懒恢复共用同一 materialize 入口。完整 history restore 失败时保留 dormant 记录并返回结构化错误，不悄悄打开错误 URL。

### 合同与 gate

- 行为测试：
  1. 恢复 5 个持久化标签页 → 仅 1 个真实 view，4 条 dormant 记录，tab strip 数据完整。
  2. 激活 dormant tab → 物化并导航到原 URL；`browser:tabUpdate` 流与普通导航同构。
  3. 回收豁免：audible / download / agent 租约 / required / 权限登录 / 最近输入 / 无恢复快照的 tab 永不进入 dormant（穷举断言）。
  4. 休眠→激活往返后，tab id 稳定、group 归属不变、采集任务链（`browser_get_task`）不受影响。
- 结构 gate：物化入口唯一（禁止第二处 createHost for dormant）。
- 与既有合同对齐：休眠不得触碰 agent-view 租约持有的 tab（复用 P1 豁免事实源，不另建名单）。

### 验收

- S4 复测：20 标签页冷启动，进程数 ≤3、首屏可交互时间对比基线记录改善值。
- 真机：dormant tab 激活后恢复完整 history、滚动与表单 pageState；表单、音频、下载、登录弹窗和 Agent 工作页不被回收。恢复时延记录真实数字，不设与网络条件无关的伪硬门槛。

### 风险与处理

- WebSocket 等内存态无法从 history 恢复，因此默认只在预算/压力要求回收时处理冷标签。若站点在恢复后显式报告失败，保留 tab 和错误状态供用户重载，不把恢复失败伪装成成功。

---

## P3 事件与 IPC 管线收敛（renderer 丝滑主线）

### 目标

一次导航的 renderer 账单从「8× 全量三连」降到「≤2 次合并提交 + ≤1 次持久化」；拖拽 IPC 减半；订阅粒度收紧。

### 改动面

1. **Main 侧事件合并（P0-5 上半）**：
   - 新文件 `browser-engine/tab-update-batcher.ts`：同一 tabId 的 `tabUpdate` 在 16ms 窗口内合并为一条复合 payload（title+loading+navigate+meta 字段合并，后到覆盖先到）；`closed` 与 `tabOpened` 不合并直发。窗口用 setTimeout(16) 一次性定时器，空闲零开销。
   - 取消「专用事件 + 全量 meta」双发：meta 并入复合 payload，占位事件删除，**不留旧通道兼容分支**（renderer 同 PR 切换）。
2. **Renderer 侧（P0-5 下半）**：
   - `updateTab` 增加相等短路（浅比较命中字段）；`commit` 的持久化改为 idle 合并写（`requestIdleCallback` + 500ms 上限 + `pagehide`/卸载前同步冲刷）——与 2026-07-15 文档侧 C1 合同同款模式，快照结构不变。
   - `BrowserMode` 的 `useBrowserTabs()` 全量解构改字段级 selector；`VerticalTabRail` 行抽 per-tab memo 子组件（props 收敛为该 tab 的原子字段）；`bookmarkedUrls` 用 useMemo 稳定引用（P1-8 放大器）。
   - `WorkbenchMode` / `DocumentMode` 的全量解构同步收紧（`useWorkspace()`/`useMode()`/`useDocTabs()`）。
3. **ack 瘦身（P1-2）**：intent 增加 `expectsAck?: true`；Main 仅对带标记的 intent 回 ack。现有消费者是 mode-switch、设置/全屏遮罩和真实相交的 DOM 浮层，set-bounds/secondary-set-bounds 不再产生回程。
4. **syncMode 裁决（P1-3）**：**删除**该参数而非实现它——renderer 的 rAF 合帧已是唯一节拍层，Main 侧再加一层合帧收益无证据（P0 基线若显示 setBounds 本身成为瓶颈再重开）。删除范围：`BrowserBoundsSyncMode` 类型、intent 字段、`applyBounds` 形参链。简单优先，不留哑旋钮。
5. **rail flyout 滚动节流（P1-8）**：`onScroll` 的 pushSnapshot 合并到 rAF。

### 合同与 gate

- 行为测试：
  1. 模拟一次导航事件序列（start/navigate/title×3/favicon/stop）→ renderer 收到 ≤3 条 tabUpdate；store 提交 ≤3 次；localStorage 写 ≤1 次（idle 冲刷后）。
  2. 强杀前（beforeunload/pagehide）快照冲刷必达：写入内容与内存态一致。
  3. 拖拽 5s 双开：ack 条数 = 0（无 mode 切换发生时）。
  4. title 更新只重渲染对应 tab 行组件（React 测试断言渲染计数）。
- 结构 gate：`browser:tabUpdate` 发送点唯一（batcher 之外禁止直发该通道）。
- 回归：`verify:stability` 全绿（事件合并不得破坏采集/任务投影对 tab 事件的依赖——batcher 只合并 UI 通道，任务链事实源不走此通道，需在 PR 中确证并写测试）。

### 验收

- S3 复测：tabUpdate 条数与 localStorage 写次数对比基线；真机长页面（标题频繁变化的 SPA）标签栏不再整列闪烁重画。

---

## P4 分栏/双开交互收敛

### 目标

拖拽、跟随、切换全链无逐帧 React state、无逐事件原生调用；浮层×原生层协调有合同兜底。

### 改动面

1. **工作台分栏拖拽 ref 化（P1-12）**：`handleSplitResize` 改为 BrowserMode 内部双开同款（ref + DOM flexBasis 逐帧、结束提交 store）。BrowserView bounds 已由 PANEL_RESIZE_STATE_EVENT 驱动，不受影响。
2. **overlay 子窗口跟随合帧（P1-1）**：vertical-rail / lock / fastcard / Agent 指针四个 overlay 窗口的 move/resize 回调合并进单个微任务/16ms 定时（leading+trailing）；`screen.getDisplayMatching` 结果缓存，仅 `display-metrics-changed` 失效。抽共享 helper（新文件 `browser-engine/overlay-window-follower.ts`），四窗复用，**删除四份手写跟随**。
3. **窗口 resize 白边（P1-5）**：先量测（P0 基线补 S5：连续拉伸窗口 3s 录屏），确认可见性后二选一：(a) 把既有 freeze-frame 机制扩展到窗口 resize（复用 `useBrowserResizeFreeze`，触发源加 windowResize）；(b) 量测显示不可感知则记录结论关闭该项。**不预设实现**。
4. **浮层×原生层协调合同（P1-6/P1-7）**：
   - 新增共享原语 `useNativeSurfaceAwareOverlay`（renderer）：浮层根节点登记真实矩形，与标记为 native surface 的 Browser pane DOM 占位矩形求交；只有相交才 begin/endBrowserMask，卸载即释放。
   - 通用 ContextMenu、portal drawer、selection toolbar 与文档 tab flyout 接入同一原语；gate 断言所有 portal 根使用统一属性/组件合同，不以具体文件名维护易漂移名单。
   - `beginBrowserMask` 增加 ack 等待（复用 modeSwitchAckWaiter，100ms 上限），消除首帧竞态；设置页挂载路径同步接入。
5. **模式切换时延地板（P1-4）**：产品裁决项——建议把 animated 仪式的 `enter 120ms` 压到 ≤60ms、holding 最短 100ms 改为「ack 完成即走」（保留视觉连续性由 CSS 过渡承担）。固定 setTimeout（180/48/260ms）逐个改为事件驱动或压缩，逐项在 PR 中记录理由；800ms lock overlay 淡出属视觉设计保留。
6. **原生页面圆角单一路径**：真实应用对比确认 `WebContentsView.setBorderRadius()` 可以稳定裁出网页四角，而遗留 `BrowserView` 不具备同一合同，却仍可被环境变量或历史设置重新选中。删除这套运行时选择和旧承载分支，正式运行只允许 `WebContentsView`；合同同时禁止 `BrowserView`、`addBrowserView/removeBrowserView` 和旧选择键重新进入 host layout。单浏览器、浏览器双开、browser+document、browser+rss 四种布局都用高对比页面真机截图验收。

### 合同与 gate

- 行为测试：工作台分栏拖拽 60 帧内 `useMode` store set 调用 ≤1 次（结束提交）；overlay follower 在 100 次 move 事件下 setBounds 调用 ≤ 帧数上限。
- 合同测试：已知文档浮层清单全部接入 native-surface-aware 原语；`beginBrowserMask` 路径必有 ack 或超时记录。
- 真机验收矩阵（双开三组合 × 操作）：browser+browser 拖分栏、browser+document 打开编辑器菜单越线、browser+rss 快速连点 5 篇文章、每组合切换 mode 往返——录屏确认无掉帧/遮盖/白边。

---

## P5 后台服务静态开销（可并行先行，含快赢）

### 改动面

1. **RSSHub 懒启动（P0-6，快赢）**：boot 不再无条件 `rsshubManager.start()`；首个需要 embedded RSSHub 的真实请求通过既有 `ensureHealthy()` 启动。最后活动 15 分钟后且无 pending 请求时停机，下次需要再拉起。自重启逻辑仅在仍有活跃/近期请求时生效。
   - 合同：从未使用 RSSHub 时没有 RSSHub Node worker，也不触发 Chromium 准备；首个请求成功启动并抓取；请求期不被 idle timer 误停；空闲后 worker 退出且 Chromium 孙进程被清理。
2. **日志缓冲（P1-9，快赢）**：`rotating-logger` 增加缓冲模式：内存队列 + 250ms/64KB 先到先冲刷 + 进程退出钩子同步冲刷；文件大小改为进程内计数器累加（启动时 stat 一次校准），删除每写一次的 `statSync`。directchat/tools/process 三个高频日志切到缓冲模式；崩溃诊断依赖的最后写入由退出钩子保证。
   - 合同：单元测试断言 1000 条连写只触发 ≤N 次真实 IO；退出冲刷必达。
3. **CDP 生命周期收口（P1-10）**：domain 引用计数归零且无活跃 observer 时 `debugger.detach()`（守卫：DevTools 附着时不抢）；`closeTab` 路径清理 `domainRefsByTab`、`browserPageMapAmbiguityByTab`、network observer 句柄（集中一个 `disposeTabResources(tabId)`，由 closeTab 调用——同时解决审计 §4 关闭路径残留）。
4. **RSS 前台让路与列表降载**：fetchAll 的解析/入库在每源完成后 `setImmediate` 让出事件循环，不做复杂优先级系统。`filteredItems` 必须 useMemo，行组件 memo；长列表至少使用 `content-visibility`/稳定占位，若真实 1000 条场景仍超预算则启用窗口化，不能只登记后移。

### 合同与 gate

- `verify:browser-perf` 扩展收录 1-3 的行为测试；RSSHub 懒启动需真机验证「首个 RSSHub 源添加→抓取成功」链路。

### 验收

- 空闲态进程清单对比基线：从未使用 RSSHub 时无 RSSHub Node worker；用到浏览器自动化路由后，其 Chromium 孙进程在 idle stop/退出时一并清理。Agent 高频工具事件期间主进程无逐条同步写盘（用 fs 调用计数或 dtruss 抽查记录）。

---

## P6 相邻模块热点（可选，独立立项亦可）

1. **LiquidBackdropProjection（审计 §8.1）**：先量测（长会话 + 流式输出期间 clone 耗时曲线），确认后候选方案：mutation 合并窗口从 1-rAF 放宽到 2-3 帧；克隆范围裁剪到可视区；或改为定期快照。不预设结论，量测数据进附录。
2. **透明 vibrancy 复核（审计 §8.2）**：实色玻璃皮肤下评估 `vibrancy:'under-window'` + `visualEffectState:'active'` 是否仍必要；若皮肤合同允许，非透明皮肤切换为不透明窗口材质（走既有 windowMaterialController 状态表，不加分支旁路）。

---

## 开放裁决项（codex 复审时给结论）

1. 导航历史只接受 Electron 42 完整 entries/pageState restore；失败不做 URL-only 伪恢复。
2. 阈值按系统内存与 live-view 数自适应，不新增设置页旋钮。
3. 模式切换不保留固定 holding 地板；ack 和 DOM commit 完成即可离开，CSS 只承担视觉过渡。真实录屏若出现跳变再调过渡，不恢复等待墙。
4. workbench 级 `splitMode` 持久化属于体验一致性，不纳入本轮性能状态真值；内部 browser/document split 继续按既有持久化工作。
5. tabUpdate 合并窗口初值 16ms；行为 gate 约束“无重复、一次 quiet burst 一次持久化”，不以网络加载跨秒事件强行承诺固定总条数。

## 验证纪律（对 codex 的执行要求）

- 每阶段完成定义 = 合同测试绿 + `npm run typecheck` 零错误 + 受影响专项 gate 绿 + 真机场景复测数字回填附录，四者缺一不可；不得以「代码完成」宣告阶段完成。
- 验证命令一律 `npm run xxx > /tmp/xxx.log 2>&1; echo EXIT=$?` 形态，禁止管道尾接 `tail`/`echo` 掩蔽退出码。
- 涉及 SQLite/设置持久化的改动（P2 设置项）跑 `npm run verify:native`。
- BrowserView/分栏/overlay 的每一项改动必须真实 Electron 验收，源码检查与单测不可替代（CLAUDE.md §10）。
- 大文件红线：新逻辑一律新文件；`browser-engine/ipc-handler.ts`（危险级）净增行数必须 ≤0，接线代码也应顺势下沉到对应 service。

## 附录 A：真实基线与收口记录

量测环境：2026-07-17，64 GB Apple Silicon Mac，macOS 27.0，Ready 0.7.1 / Electron 42.3。施工前没有可比的系统 trace，因此不在施工后伪造“优化前”数字；前态由审计中的真实调用链和会失败的计数合同固定，后态数字如下。完整结构化记录见 `outputs/agent-audit/live/2026-07-17-stage2-browser-performance-report.json`。

| 场景 | 施工前确证事实 | 施工后真实结果 |
|---|---|---|
| S1 空闲 10 tab | 每个标签禁用 Chromium 后台降频，且没有负载状态机 | document mode 静置超过 5 分钟后 10/10 为 throttled、60 秒后事件为 0；CDP 区间口径 CPU 合计 0.000992%、内存 786960 KB，独立 OS 采样口径稳态 CPU 0.34–0.39%、最终内存 704208 KB |
| S2 双开拖拽 5s | 普通 bounds 也无条件回 ack，工作台分栏逐帧写 React state | browser+document：584 次原始移动、534 次 bounds、ack 0；browser+rss：574/523/0；browser+browser：587 次移动、350+462 次双栏 bounds、ack 0。另一轮聚焦量测发现逐帧诊断写盘，移除后 5 秒拖拽主进程 CPU 从 22.75% 降到 17.11% |
| S3 导航×10 | 专用事件与全量 meta 重复下发，每条都整份写 localStorage | 顺序风暴 1.022 秒完成，91 个底层事件合并为 11 个 renderer patch；并发风暴 1.978 秒完成且只有 2 个 patch；两者浏览器快照均只写 1 次 |
| S4 冷启动 20 tab | 恢复时每个持久化标签立即建 view 并 loadURL | 单开布局 3.36 秒显示，1 visible + 19 dormant；保留双开的独立冷启动为 2 visible + 18 dormant，20 秒内页面 target 上限为 3（Ready Renderer + 2 个网页） |
| S5 窗口拉伸 | 原始“越界”采样只证明原生面没有超出容器，没有检测它比 DOM 慢一帧的缝隙 | 放大到 662 次尺寸对照后确认原生面最大滞后 12×6 px，82 次存在尺寸差。窗口拉伸期间用最后稳定帧填充后，未被填充的差异和扩大缝隙均为 0；最终 6.98 秒/402 帧高对比录屏抽帧无白边，稳定后冻结帧正常释放 |
| 原生圆角 | 两套 host 可切换，其中旧 host 不满足圆角合同 | 正式路径只剩 WebContentsView；单浏览器、双浏览器、browser+document、browser+rss 四组高对比截图均显示网页顶角和外角正确裁切 |

## 实施记录

| 阶段 | 状态 | 证据 |
|---|---|---|
| P0 观测与基线 | completed | 进程按真实 pid 聚合且关联 `tabIds[]`；诊断关闭时无采样 timer；60 秒事件计数进入同一诊断读面；S1–S5 已回填。 |
| P1 动态降载/hide-all | completed | 四态 governor、音频/下载/Agent/权限/近期交互豁免和事件驱动 reconcile 已落地；未 attach 的 host 不再因 hide-all 被反向 attach；S1 真机通过。 |
| P2 懒恢复/压力回收 | completed | 启动 dormant 登记、单一 materialize、完整 history/pageState 快照、可恢复性过滤和自适应 live-view 预算已落地；S4 20-tab 真机为 1 visible + 19 dormant。 |
| P3 事件/IPC/store | completed | Main quiet-burst 合并、Renderer 相等短路/idle 持久化、普通 bounds 零 ack、`syncMode` 删除、rail 快照 rAF 合帧已落地；S3 为 91→11→1。 |
| P4 双开/overlay | completed | 工作台拖拽 ref 化、四类子窗共享 follower、相交浮层等待 hide ack、快速 mode/split 竞态修复已落地；窗口缩放又补上容量为 6 的稳定帧 LRU，遮住原生面单帧滞后且不在长会话无界占用内存。S2/S5 真机通过；原生 host 收敛为唯一 WebContentsView，四种布局圆角截图通过。 |
| P5 RSSHub/log/CDP/RSS | completed | RSSHub 首次真实请求才启动，临时 Bilibili 源 9.565 秒抓取 30 项；日志批量冲刷、CDP/observer/歧义缓存关闭清理、RSS 行 memo 与 `content-visibility` 已落地。 |
| Document 联合合同 | completed | `npm run verify:document-perf` 137/137（2026-07-17）；文档专项真机与打包态验收已完成，浏览器 S1–S5 也已独立回填。 |
| 真实 Electron + 系统采样 | completed | S1–S5、overlay 相交、RSSHub 首次请求和四组圆角布局均走真实 Electron。完整 Xcode `xctrace` 不可用，按合同改用 `/usr/bin/sample`；Main 峰值 258.3 MB、Renderer 峰值 111.0 MB，等待栈占主导。 |
| 同一个对抗复审者 | completed | Fresh Stage2 reviewer 提出的 6 项有效问题已全部修复并回归：保护期结束后自动唤醒回收、命名 profile 冷启动不丢、独立 CDP 命令及时断开、同一任务提示关闭后不反复出现、超额/非法 dormant 记录不生成幽灵标签、overlay follower 隐藏与销毁生命周期分离。同一复审者继续审查文档联动修正，最终结论为 PASS，无可延期项。 |
| 最终全量验收 | completed | `verify:browser-perf` 为 117 通过 + 2 项按合同由 native gate 覆盖，另有 2/2 性能合同脚本通过；`verify:stability` 为 159 通过 + 22 项 native 转验，Send IM 为 140 通过 + 1 项转验；`npm run verify` 主测试 7373 通过、串行子任务 154 通过、串行时序/性能 31 通过，零失败；`npm run build` 成功生成 Main、Preload、Renderer、RSSHub worker 与 document worker。 |
