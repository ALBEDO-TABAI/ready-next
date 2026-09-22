---
title: P1 Re-scope — Collection Reliability Root (visibility hypothesis DISPROVEN)
date: 2026-07-03
status: diagnosis
enforce: false
correction: >
  §1 的“可见性是共享根因”假设已被 Phase 0 探针证伪（见 §6）。真实根因见 §7。
  保留原假设与证伪过程作为方法论记录——先实测再改救了一次无效且高危的改动。
source:
  - 用户真机复测（2026-07-03）：下载已修；采集仍失败；agent 标签需切换/新建才显示
  - ready.db browser_tasks（07-01 采集 169/179、185 成功 → 07-02 采集 0/0–0/1 失败）
  - src/main/modules/browser-engine/collection-routing.ts:resolveHighControlCollectionTarget
  - src/main/modules/browser-engine/ipc-handler.ts:ensureAgentTab / startVisibleCollection
  - src/main/modules/browser-engine/host-layout-service.ts:createHost / hideHost(offscreen 1x1)
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-07-01-browser-agent-lane-decoupling-plan.md（Phase 0 验证项5、§5 live-host policy、Risk 5）
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P1 重审：agent tab 的“可见运行态”是采集失败与标签隐藏的共享根因

## 0. 为什么要重审

前几轮我在逐个修症状（finalizer proof_gap、任务卡标题、下载工具面），每个都真修好了，但用户真机复测显示：下载 OK，**采集仍失败**、**agent 标签仍要切换/新建才出现**。用户提示：从第一性原理找问题之间的关联，看 P1 工作计划要不要调整。重审后结论——**这些不是彼此独立的小 bug，是同一个根**。

## 1. 共享根因（证据链）

### 1.1 第一性原理

一个浏览器 agent 任务要成功，页面必须处于**真实可见运行态**（`document.visibilityState==='visible'`）。现代站点（尤其小红书这类高风控 + 懒加载 + 富编辑器）在 `visibilityState==='hidden'` 时：
- IntersectionObserver / 懒加载不触发 → 笔记列表、图片不渲染 → 采集拿到 **0 条**；
- 登录态/内容渲染可能延迟或降级 → agent 误读为“登录墙 / 空页”；
- 富编辑器（发布长文）focus/状态不稳 → 发布点不到、状态读不到。

`backgroundThrottling:false`（host-layout-service.ts:34）只关掉了**定时器节流**，并**不改变 `visibilityState`**。可见性由“视图是否附加 + 是否有可见 bounds / 是否被遮挡”决定。

### 1.2 代码事实

- 采集在 agent tab 上跑：`startVisibleCollection`（ipc-handler.ts:982）→ `ensureAgentTab()`。
- agent tab 是后台隐藏 tab：`ensureAgentTab`（ipc-handler.ts:1112）→ `createTab(BLANK, { background: true })`；后台 tab 从不 `setActiveTabId`/`finalizeSwap`，也不被 `showHost`。
- 隐藏用离屏 1x1：`hideHost` → `offscreenBounds { x:-100000, w:1, h:1 }`（host-layout-service.ts:13,78）。离屏 1x1 的视图 → `visibilityState==='hidden'`。
- 只有一种情况采集走**可见** tab：`resolveHighControlCollectionTarget`（collection-routing.ts:14）——仅当 `requestedTabId` 可用，或**用户当前 active tab 已经在高风控站点**时，返回 `usesVisibleTab:true`；**否则返回 null → 落到隐藏 agent tab**。

### 1.3 回归铁证（DB）

`browser_tasks`：
- 2026-07-01 02:49 `visible_collect completed 0/179`、06-30 09:36 `completed 0/185`、07-01 03:09 `card_loop paused 169/179` —— **采集能成，拿到 179/185 条**（彼时用户 active tab 在小红书页，走可见 tab）。
- 2026-07-02 16:48–17:40（本轮测试）`visible_collect failed 0/0、0/1` ×6 —— **全 0 条失败**（落到隐藏 agent tab，页面不渲染）。

同一套采集代码，可见 tab 上 179 条、隐藏 tab 上 0 条。这不是采集算法坏了，是**采集跑在了看不见的页面上**。

### 1.4 三个症状归一

| 用户症状 | 同一根因的不同侧面 |
|----------|-------------------|
| 采集任务失败（0 条） | agent tab 隐藏 → XHS 懒加载不触发 → 冻结清单 0 条 → 失败 |
| “冻结清单丢失了” | 上游 0 条 → 本就没有清单可冻结，续跑时表现为“丢失”（下游现象，非独立 state bug） |
| agent 新建标签不显示，要切换/新建才出现 | agent tab 是 background + 离屏，从未被 supervision 稳定 surface 到副窗格 |
| 发布长文不稳（前几轮） | 富编辑器跑在隐藏页 → 状态读不到、点不准（同根，待复验） |

## 2. P1 计划的真实缺口

lane-decoupling 计划（2026-07-01）**早就写明**这条：
- **Phase 0 验证项 5**：“agent tab 在可见、副窗格折叠、离屏隐藏三种状态下的 document.hidden/visibilityState/timer/rAF/IntersectionObserver/懒加载行为”——**从未实测**。
- **§5 运行态 live-host policy**：“运行中的 agent 页面不能变成 hidden frozen 页面；对依赖可见态站点，隐藏运行必须降级为保持可见小窗格或明确暂停，而不是静默 hidden”——**从未实现**。
- **Risk 5**：“离屏 1x1 隐藏会让页面被节流/hidden，对依赖可见态站点导致页面地图读不到、采集懒加载不触发、发布编辑器状态不稳”——**正是现象**。

我上一轮把 lane 标成“WIP 已完成”，是基于**代码存在**（boundTabId/supervision/binding），但**承重的 live-host 可见性策略（Phase 0 + §5）根本没做**。这就是 P1 的真实缺口，也是为什么修完 finalizer/标题/下载工具面后采集依旧失败。

## 3. 重排后的 P1 计划

把“agent tab 可见运行态”从 lane 计划的一个埋藏子项**提升为 P1 的最高优先根因项**，排在其余打磨之前：

### P1-R0（新增，最高优先）：agent 可见运行态
1. **Phase 0 实测**（先验证，不猜）：在真实 dev 里对 agent tab 三态（副窗格可见 / 折叠 / 离屏）分别探测 `document.visibilityState`、IntersectionObserver、懒加载是否触发；确认“隐藏 → 0 条”的因果。
2. **live-host policy**：前台 workflow 与高风控采集运行期，agent tab 必须有**真实可见 bounds**（副窗格），不得停在离屏 1x1；纯后台下载/已冻结队列这类**不依赖可见态**的任务才允许隐藏。
3. **采集路由修复**：`resolveHighControlCollectionTarget` 落到 agent tab 时，必须 surface 成可见副窗格再跑，而不是隐藏；高风控采集“无可见 tab”时先开可见 agent 副窗格。
4. 一并修好用户看得见的“标签不出现”（supervision → 副窗格稳定 surface）。

### P1 其余项（次序不变，其中已完成的保留）
- A1 ✅、采集三边界 ✅、Phase D ✅、W5 ✅、动作回执 ✅、下载工具面 ✅、finalizer/标题 ✅（前几轮已修，真机部分已验）。
- lane Phase 2/4/5/6：**降级为“未完成”**——之前误判为完成；真正的 live-host 部分并入 P1-R0。

## 4. 风险与安全边界

- **BrowserView 可见性是白屏高危区**（硬约束：显示纯 DOM 覆盖层前先 hideAll，恢复后 showActive+同步 bounds）。改可见性必须先做 P1-R0.1 实测，再动代码，每步真机验证，避免白屏。
- 可见运行态与“不打扰用户”的张力：agent 采集时占一块可见副窗格是必要代价；但要保证用户主窗格不被抢（lane 已有的双 surface + 主窗格保留）。

## 5. 待用户确认的方向（历史）

用户选“先实测再改”。见 §6/§7。

## 6. Phase 0 实测结果——可见性假设被证伪

`scripts/probe-agent-tab-visibility.cjs`（`npm run verify:agent-tab-visibility`）在 Electron 42.3.0 实测 WebContentsView 三态：

| 状态 | visibilityState | rAF ticks/1.5s | IntersectionObserver |
|------|-----------------|----------------|----------------------|
| 附加+可见 bounds | visible | 180 | 触发 |
| 附加+离屏 1x1（hideHost） | **visible** | 180 | 触发 |
| 从窗口移除（detached 后台） | **visible** | 181 | 触发 |

结论：`backgroundThrottling:false` + 窗口 show 时，**离屏/未附加的 WebContentsView 仍报 visibilityState=visible，观察器/rAF 照常触发**。§1 的“隐藏→懒加载不触发→0 条”因果**不成立**。若不先实测，我会实现一个改可见性、既无效又白屏高危的改动。

## 7. 真实根因（DB 载荷证据）

`browser_tasks` result_json（2026-07-02 采集）：
- 17:40:03 `card_list` 主页 URL（带 xsec_token）→ `targetQuality: "suspect_navigation_pollution"`，items = 首页/worldcup26/ai_chat/RED/直播/发布 —— **全是全局侧边栏导航**。
- 17:40:44 / 16:50:59 `image_gallery` 笔记/主页 URL → `items:[], stopReason:"no_new_content"`（0 图）。
- 对照 07-01 `card_list`（xsec_source=pc_search）→ completed 179 条。

**真实根因链**：
1. agent 导航到真实 XHS 主页 URL（带 xsec_token，非空白 tab、非隐藏）。
2. **XHS 只渲染了全局导航壳，没渲染博主的笔记网格**（反爬/内容门控——对 agent 的这次访问路径不出内容；pc_search 出、pc_note/pc_feed 不出）。
3. 页面上只有导航链接可抓 → 采集冻结出导航 → **我的 P1 pollution 检测正确命中 `suspect_navigation_pollution`** → 采集正确拒绝。
4. 但 `resolveCollectionVerdict`（collection-verdict.ts:28）把 pollution 判为 **hard `failed`** → 用户看到“失败”。

即：**采集管线（导航/抽取/污染检测/拒绝）其实都在正确工作**。缺口是两处：
- **(A) 优雅降级**：高风控页只出导航壳 = “页面没有目标内容”，应是**可恢复的用户接管态**（“我这边没渲染出笔记网格，请你在浏览器里打开该主页确认笔记可见后说继续”），而不是 hard 失败。（web-access §16 登录墙接管、§14.7 错误是证据不是真相；7/01 诊断亦然。）
- **(B) 访问路径**（真实可靠性天花板）：为什么 XHS 对 agent 导航只出壳？07-01 用户自己浏览过的可见 tab 出了 179 条，07-02 落到 fresh agent-tab 导航只出壳。`resolveHighControlCollectionTarget` 只在“用户 active tab 已在 XHS”时用可见 tab，否则 fresh 导航 → 被 XHS 降级。这需要**真机 live 取证**（agent tab 打开 XHS 主页时到底 DOM/network 收到什么：登录墙？空网格？需要滚动/交互触发？），headless 无法完成。

## 8. 修正后的 P1 计划

- **P1-R1（本轮可做，低风险、明确正确）**：高风控采集的 pollution / empty / structure-missing 终态从 hard `failed` 改为**可恢复**（paused + 用户接管标签“页面未出内容，请打开/登录后继续”），不再冒充硬失败。附测试。
- **P1-R2（需用户参与的 live 取证）**：查“XHS 对 agent 导航只出导航壳”的访问路径根因 —— 真机打开 XHS 主页于 agent tab，抓 `browser_power_network_trace` / DOM，判定是登录态、xsec_source、还是需交互触发；据此决定路由（优先复用用户已渲染的可见 tab）或接管流。
- **可见性/标签不显示**：与采集失败**无关**（§6 证伪）。标签不显示是独立的 supervision→副窗格 surface UX 问题，单独排期，不属采集根因。
- lane “live-host 可见性”从 P1 关键项**移除**（假设已证伪）；lane Phase 2/4/5/6 仍按原状（副窗格 surface 的 UX 归属那里）。

## 9. 第二轮真机复测发现（2026-07-03 02:14/02:19，run_state + metrics 证据）

**采集**：已明显改善——真机渲染出主页网格、真采到 1 条笔记的 8 张图落盘到用户目录、并以可恢复 ask 卡（接受/手动/重采）收口（P1-R1 生效）。残留：
- 抽取深度浅（识别 2 条，深访 1 条）——反爬/懒加载分页深度，非硬失败。
- `采集报告.md` 写入报 `skill_read_artifact/skill_inspect_run_state → no_root_match`：采集跑在 obsidian-web-clip 技能上下文里，技能 artifact 沙箱只允许 `skill-runtime/outputs/obsidian-web-clip`，不含用户授权目录 `/实验田/测试/lib-a`。图片走浏览器下载路径（认用户 roots）成功，报告走技能 artifact 路径被拒——**两条写路径 root allowlist 不一致**。（待修）

**发布（run_state 铁证）**：task-7a855f9d，taskType=browser_transaction，`terminalReason: checkpoint_budget`——**agent 在“找发布按钮”上耗尽预算后可恢复暂停（非硬失败）**。transcript：页面 map 出现 `button "上传视频" [fileInput]`（agent 部分停在“上传视频”tab）、只 fill 了正文一处（无标题）、27 次“发布”搜索。budget 48 够用，问题是**盲找低效**，不是预算低。
- 已修：XHS 站点卡新增“写长文发布流程”知识（确认切到写长文 tab、标题必填→只给正文时用首句作标题、发布按钮右上角、disabled 先 read map 查缺哪个必填项、不要反复 capture/scroll/eval 盲找）。site-card-alignment 测试绿。这是知识级引导（非脆弱选择器），直击观察到的失败模式。
- 待真机复测：站点知识应让 agent 先切 tab+填标题→发布按钮 enable→点击完成。若仍卡，需真机抓写长文编辑器 DOM 写精确定位。

**P1 状态**：采集/发布现均为**可恢复态**（不再硬失败），且发布有了针对性站点知识。剩余=采集抽取深度、发布真机复验。

## 10. 标签不显示 UX — 根因已确认 + 修法（暂缓到可监控会话）

**根因（确认）**：`browser:tabOpened` 只在 `ipc-handler.ts:653` 的 popup 路径发出。通用 `tab-lifecycle-service.createTab`（`ensureAgentTab` 建 agent tab 走这条）**从不发 tabOpened**。renderer 侧用户自建 tab 走 `openWebpageInBrowser.ts:34` 客户端直接更新 store；而 agent/main 建的 tab 没有 renderer 通知 → 不进标签条，直到 `switchTab` 触发 getTabList 刷新才出现。与用户报的“agent 新建标签需切换才出现”完全吻合。

**修法（设计好，暂未实施）**：`createTab` 建 agent/background tab 后发 `browser:tabOpened`，payload 带 `activate:false`；renderer `onTabOpened`（useBrowserRuntimeEffects.ts:275 现无条件 `setActiveTabId`）在 `activate===false` 时只 addTab/updateTab、**不抢占 active**。

**为何暂缓**：这是纯 UI 呈现问题（探针已证渲染/采集功能不受影响），但改动含“不抢占焦点”的门控，做错会变成更糟的抢焦点回归；renderer 焦点行为 headless 无法验证，需真机。无人值守会话里不宜动浏览器 UI 焦点。留待可监控会话实施 + 真机验证。P1-P2 其余工作不依赖它。
