---
title: Agent Browser 与可见页面采集器 — Claude 复查与反提案
date: 2026-06-04
status: draft-for-review
owner: 白
executor: Claude
enforce: false
note: 本文是对同日 codex 计划（2026-06-04-agent-browser-visible-crawler-implementation.md）的独立复查与反提案。若被采纳，应并入或替换该 implementation 计划并将 enforce 翻为 true；两份计划不得同时 enforce。
related:
  - docs/superpowers/plans/2026-06-04-agent-browser-visible-crawler-implementation.md
  - CLAUDE.md §0.5（先合同，后代码）、§2（BrowserView 原生覆盖层硬约束）
  - .claude/architectural-principles.md
  - docs/superpowers/plans/2026-06-01-browserview-presentation-unification-implementation.md
evidence_matrix:
  - /Users/user/matrix-unpack/Matrix.app/Contents/Resources/browser-v2/main.js:148907（ariaSnapshot mode:ai）
  - /Users/user/matrix-unpack/Matrix.app/Contents/Resources/browser-v2/main.js:148880-148906（formatDomSnapshot 降噪）
  - /Users/user/matrix-unpack/Matrix.app/Contents/Resources/browser-v2/main.js:148333-148359（filterStealthCtxOptions / cloak 启动）
  - /Users/user/matrix-unpack/Matrix.app/Contents/Resources/browser-v2/main.js:144233-144281, 148296-148352（指纹 binary flags）
  - /Users/user/matrix-unpack/Matrix.app/Contents/Resources/browser-v2/main.js:34817-34896, 35138-35141, 36569-36608（humanize 输入层）
  - /Users/user/matrix-unpack/Matrix.app/Contents/Resources/browser-v2/main.js:165277-165298（BrowserSessionStore 共享浏览器）
  - /Users/user/matrix-unpack/Matrix.app/Contents/Resources/browser-v2/main.js:162805-162812（工具结果搭载快照）
  - /Users/user/matrix-unpack/prompts-zh/neo-agent-seed/templates/browser-skill.md（快照纪律 / 双路线 / 确认分类法）
evidence_ready:
  - src/main/modules/browser-engine/automation-service.ts:291（read_page = body.innerText）
  - src/main/modules/browser-engine/capability-service.ts:444-492（scrollCollect 滚到底一次性抽取）
  - src/main/modules/browser-engine/tab-lifecycle-service.ts:104（所有 tab 共用 persist:browser）
  - src/main/modules/browser-engine/ipc-handler.ts:148（toOAuthCompatibleUserAgent）
  - src/main/modules/tools/browser-tool-catalog.ts:17-59（38 个固定工具，grep 实测）
  - src/main/modules/browser-engine/content-task-runner.ts、task-persistence-service.ts（后台任务持久化）
---

# Agent Browser 与可见页面采集器 — Claude 复查与反提案

> 我对 Matrix 解包和 Ready 当前代码各做了一轮独立调查，逐条核对了 codex 计划的事实论断。结论：codex 计划的主骨架成立（隔离、锁、页面地图、采集闭环、视觉单步），但有一个产品级缺口（登录态被推迟成"待决策"，实际是第一天就会撞上的问题）、一个完全漏掉的能力（Matrix 的拟人化输入层）、一处对 Matrix 的过度美化（"完整采集体系"其实不存在于代码中）、以及若干可收敛的工具面和做不到的指纹承诺。
>
> 本文先给证据核对表（§1），再给 Matrix 真正值得学的排序清单（§2）、对 codex 计划的逐条评估（§3），然后是修正后的目标设计（§5）与工作包（§6）。

---

## 0. 一句话

同意"用户浏览器与 Agent 浏览器分离 + 操作锁 + 页面地图 + 采集闭环"的主线，但要做四个实质修正：**(1) 采集分两条泳道**——前台协驾用户标签页（天然带登录态）与后台 Agent Browser（隔离匿名），否则社交平台采集在第一天就会死在登录墙上；**(2) 新工具从 7 个收敛到 4 个**；**(3) 补上 codex 完全漏掉的拟人化输入层**——这在社交平台上比指纹 flag 更重要；**(4) 指纹一致性按 Electron 真实能力重新定界**，明确列出做不到也不做的部分。

---

## 1. 证据核对：codex 论断 vs 实证

我亲自验证了 codex 计划中所有关键事实论断，结果如下：

| # | codex 论断 | 实证结果 | 证据 |
| --- | --- | --- | --- |
| 1 | Matrix 用类似 `ariaSnapshot({ mode: "ai" })` 的页面骨架并做降噪 | **属实**。`captureDomSnapshot` 就是 `formatDomSnapshot(await page.ariaSnapshot({ mode: "ai" }))`；降噪只有约 25 行：丢弃 `img` 节点、把 `generic/listitem/group` 包裹节点展开提升子节点 | main.js:148907, 148880-148906 |
| 2 | 快照纪律是一套操作纪律 | **属实，且需要强调：纪律 100% 在提示词里，代码层没有任何强制**。`browser-skill.md` 包含完整的定位器阶梯、count() 唯一性检查、错误恢复规则 | browser-skill.md §Snapshot Discipline、§Locator Strategy |
| 3 | cloakbrowser 有指纹种子、平台、语言、时区、代理、WebRTC 一致性 | **属实且比 codex 描述的更深**：是一个定制 Chromium 二进制，指纹项编译成了启动 flag（`--fingerprint-platform={macos,windows}`、`--fingerprint-timezone`、`--fingerprint-locale`、`--fingerprint-webrtc-ip[=auto]`），代理出口 IP 经 geoip 解析后自动回填 WebRTC；代码注释明说 locale/timezone 走 binary flag 是为了"避免可检测的 CDP emulation"；同时 `ignoreDefaultArgs: ["--enable-automation"]` | main.js:144233-144281, 148296-148359 |
| 4 | Matrix 共享持久浏览器、taskId 不是锁 | **属实**。`BrowserSessionStore.browser(taskId)` 包装的是同一个 `browserRuntimeManager.browser()`；per-task 的只有 artifact 目录和对话历史。profile 单一：`~/.browser-v2/profiles/user` | main.js:165277-165298 |
| 5 | Matrix 有"先理解、再谨慎展开、再滚动采集、再分段保存"的完整浏览器任务体系 | **不准确**。Matrix 代码里**没有采集器**：没有展开逻辑、没有内容去重、没有分段保存、没有信息流滚动循环。采集能力是"持久脚本运行时 + 快照纪律提示词 + 模型自由组合"涌现出来的，不是一个体系化模块 | 全 bundle grep 验证；唯一批量原语是 `tabs.content({urls, contentType})` 后台临时标签页批量读取 |
| 6 | 视觉 Agent 单步委托 | **属实但有细节**：内部是完整 ReAct 循环 + 约 25 个低层工具（click_at/type_text_at/hover_at/drag_and_drop/long_press_at/scroll_at/wheel/dialog/download/file_chooser/file.read/file.write…），每轮结束注入环境观察（tab 列表 + URL/title/viewport + 截图）。**没有步数预算，只有 timeout（默认 10 分钟）**；"只委托单步"靠调用方提示词约束，不是代码约束 | main.js:163605-163631, 161992-162041, 164651-164663 |

**codex 调查漏掉的四个事实**：

| # | 发现 | 含义 | 证据 |
| --- | --- | --- | --- |
| A | **拟人化输入层（humanize）**：monkey-patch 整个 Playwright context——持久光标位置（CursorState）、贝塞尔曲线鼠标移动、打字延迟 70-100ms ± 抖动、10-15% 概率停顿 400-1200ms，带预设档位 | 在社交平台上，瞬时坐标点击 + 无轨迹移动 + 0 延迟打字是比指纹更强的机器人信号。这可能是 Matrix 在小红书等平台"像人"的真正主力，**codex 计划完全没提** | main.js:34817-34896, 35138-35141, 36569-36608 |
| B | **工具结果搭载环境快照**：每个浏览器工具执行后统一附带当前页面状态（URL/title/dialog/downloads/截图） | 省掉额外 probe 轮次，模型每步都有新鲜环境感知。搬运成本低 | main.js:162805-162812 |
| C | **`browser.script.run` 是持久 REPL**：globalThis 跨调用保留，tab 绑定可跨调用复用，最终表达式即返回值 | 这才是 Matrix 与 Ready 最大的**形态差异**：Matrix 只有 2 个工具（可编程运行时 + 视觉委托），Ready 有 38 个固定浏览器工具。Matrix 的灵活性来自"代码即操作" | browser-skill.md §Runtime Behavior |
| D | **四级确认分类法**：hand-off required（用户必须自己做）/ 操作时必须确认 / 预批准有效 / 免确认，按动作类型逐项枚举 | 比"敏感动作要确认"一句话精细得多，是直接可搬的政策资产 | browser-skill.md §Browser Use Confirmations Policy |

---

## 2. Matrix 真正好的地方（按可搬运价值排序）

1. **快照纪律 + 定位器阶梯 + 错误恢复规则**（提示词资产）。操作前拿新鲜骨架、只从骨架构建定位、count()==1 才点击、严格模式失败后禁止重试同一定位器、generic 标签默认有歧义、禁止 body.innerText / all()+getAttribute 循环做探索。搬运成本≈0，价值最高——而 Ready 的 `browser_read_page` 恰好就是 Matrix 明令禁止的 `body.innerText` 探索方式。
2. **页面骨架 = Playwright 内置 ariaSnapshot + 25 行降噪**。骨架本身不是 Matrix 的发明；降噪规则（丢 img、展开包裹节点）值得照抄。Ready 的难点在于 Electron 没有 ariaSnapshot，需要自己从 CDP Accessibility 树生成（§5.3 给实现路径）。
3. **双路线分工合同**：稳定页面走脚本精确操作，不稳定/强检测页面走视觉单步，明确点名"小红书禁止脚本硬操作（会封号）"。这是产品级经验，直接采纳。
4. **拟人化输入层**（§1 表 A）。对社交平台目标而言优先级高于指纹配置。
5. **工具结果搭载环境快照**（§1 表 B）。
6. **四级确认分类法**（§1 表 D）。
7. **"像普通浏览器"哲学**：持久 profile、真实有头、不用无头模式碰强检测平台、避免可检测的 CDP emulation。方向正确，且 Ready 在 Electron 内的起点可能更好：Electron 不带 `--enable-automation`，按文档推论 `navigator.webdriver` 应为 false——该推论是 WP9 运行时验收项，未验收前不作为事实使用（§4 同口径）。

**不值得学的**：共享无锁浏览器（codex 已识别）；定制 Chromium 二进制（维护成本与合规风险）；无步数预算的视觉循环（违反 Ready"预算是硬限制"红线）；纪律只放提示词不进代码（Ready 红线是 CI 强制优先于文档约束）。

---

## 3. 对 codex 计划的评估

**同意并保留**：用户/Agent 浏览器分离方向、操作锁、页面地图、fixture 先行的验收矩阵、非目标清单（不绕过登录/验证码/不批量抓取）、五阶段施工骨架、待决策第 1/2 条的倾向（先 Electron 后评估独立 Chromium；新增工具不改 read_page 语义）。

**修正 1 — 登录态是第一天的问题，不是"待决策第 3 条"。**
codex 的设计里采集默认走隔离的 Agent Browser（独立 profile、默认不导入登录态）。但用户需求的第一条是"采集国内外主流社交平台上**用户可见**的内容"——小红书、微博、X 的内容大量躲在登录墙后。一个无登录态的隔离浏览器在这些平台上第一天就会失败，然后所有人被迫回头做 cookie 导入或者直接在用户浏览器上跑，隔离设计形同虚设。正确做法是把"在用户标签页上协驾采集"提升为第一类公民（§5.1 泳道 A），隔离浏览器负责不需要登录的研究/批量场景（泳道 B）。

**修正 2 — 7 个新工具收敛为 4 个。**
codex 提议 `browser_read_page_map`、`browser_click_page_target`、`browser_expand_page_target`、`browser_choose_page_option`、`browser_expand_and_read`、`browser_visible_collect`、`browser_visual_step`。其中 click/expand/choose 三个工具共享同一套"目标解析 → 唯一性确认 → 操作 → 复读"逻辑，只是动作动词不同；`browser_expand_and_read` 又是"expand + 读回"的组合。合并为一个 `browser_act_on_target`（action 参数 + read_back 参数）。工具面是合同面，每多一个工具就多一份 schema、authorization、测试和文档负担（Ready 已有 38 个浏览器工具）。最终新增：`browser_read_page_map`、`browser_act_on_target`、`browser_visible_collect`、`browser_visual_step`。

**修正 3 — 补拟人化输入层 WP**（§5.7）。codex 计划完全没有覆盖；它对社交平台目标的贡献大于 WP8 指纹配置的一半项目。

**修正 4 — WP8 指纹一致性按 Electron 真实能力重定界。**
codex 的配置项里 timezone、proxy geo consistency、WebRTC 出口一致在 Electron 内做不到 cloakbrowser 的保真度（人家是改了 Chromium 源码编译 flag，注释明说就是为了避开可检测的 CDP emulation；我们用 CDP emulation 模拟反而制造检测面）。重定界后 Electron 能诚实做到的见 §5.8，做不到的明确列入"不做"。

**修正 5 — 锁状态机简化。**
codex 的六状态里 `paused` 是任务状态不是锁状态，`released` 和 `idle` 语义重复。简化为 `idle / held / takeover / expired` 四态（§5.2）。

**修正 6 — WP3 页面地图必须给出 Electron 实现路径。**
codex 只写了"优先从可访问树/ARIA/DOM 结构提炼"一句。这是全计划技术风险最高的部分：Electron 没有 ariaSnapshot。§5.3 给出 CDP Accessibility 域的具体方案、targetId 稳定性设计和过期合同。

**修正 7 — 施工顺序：先证明采集能力，再做隔离。**
codex 把"隔离 + 锁"放第一阶段、采集闭环放第三阶段。但页面地图和采集循环才是技术风险最高、用户价值最大的部分；隔离浏览器是工程确定性高的部分。泳道 A（用户授权的可见协驾）不需要新浏览器就能跑通完整采集闭环——锁先行防止写交错，但不承诺无感（§5.1 口径）。建议顺序见 §6.11。

---

## 4. Ready 现状硬事实（独立验证）

- `browser_read_page` 返回 `document.body.innerText`（automation-service.ts:291）——Matrix 纪律中明令禁止的探索方式。
- `scrollCollect` = 滚到底等高度稳定 → 一次性 CSS 模板抽取（capability-service.ts:444-492）。无逐轮增量提取、无展开操作、checkpoint 只在完成时写一次。
- 所有标签页（含 agent 创建的）共用 `persist:browser` partition（tab-lifecycle-service.ts:104、session-policy-service.ts:162 等 6 处）；`owner: 'manual' | 'agent'` 只是元数据，无隔离效果。
- 写操作无任何互斥：automation-service 的 CDP dispatch 无锁无队列，两个任务可交叉发键鼠事件。
- 后台任务持久化是真的（SQLite `browser_capability_tasks`，checkpoint_json，启动恢复）——**直接复用**。
- 视觉单步工具形态已接近 Matrix：`browser_analyze_viewport` 返回结构化目标 + 归一化坐标 + 置信度——**复用扩展**。
- `browser-task-planner` 的结构化计划（steps/verify/skipIf/failIf/retryPolicy）已存在——**复用**。
- `browser_execute_js` 已存在（任意 JS）：Ready 其实已有"代码即操作"逃生门，但没有任何纪律约束（见 §8 待决策 6）。
- UA 已做 `toOAuthCompatibleUserAgent` 规范化（ipc-handler.ts:148）；Electron 默认无 `--enable-automation`，按 Electron 文档推论 `navigator.webdriver` 应为 false——**此推论列为 WP9 运行时验收项，验收通过前不作为既成事实使用**。若成立，Ready 的反检测起点比 vanilla Playwright 好；最大破绽是输入行为（瞬时点击）而不是环境指纹。

---

## 5. 目标设计

### 5.1 双泳道

| | 泳道 A：前台协驾 | 泳道 B：后台 Agent Browser |
| --- | --- | --- |
| 操作对象 | 用户当前 BrowserView（可见） | 独立 `persist:agent-browser` partition 的隐藏 WebContentsView |
| 登录态 | 用户自己的，天然可用 | 默认无；按站点显式授权导入（后置 WP） |
| 适用 | "采集我正在看的内容"、登录平台可见内容、强检测平台 | 通用网页研究、批量采集、匿名可达内容 |
| 可见性 | 全程可见，用户在看着 | 默认隐藏，可预览 |
| 锁 | 强制持有 user-view 租约；用户接管即时生效 | 强制持有 agent-view 租约 |
| 输入节奏 | 拟人化输入默认开 | 可配置 |
| 呈现合同 | 严格遵守 BrowserViewIntent 单一边界（2026-06-01 合同） | 不参与用户呈现层 |

**泳道 A 的诚实口径**：它是**用户授权的可见协驾**，不是"不打扰"。Agent 会滚动、点击、占用用户当前页面；租约防止的是 Agent 并发与"用户/Agent 写交错"，不承诺页面无感。因此泳道 A 只能由用户显式发起，运行期间 UI 必须有明确"Agent 正在协驾"表征（WP11），用户随时接管。"不打扰用户"这个属性只属于泳道 B。

路由规则写入 browser domain adapter：任务涉及"已登录平台/用户可见内容"→ 泳道 A（必须用户显式发起或确认）；通用网页/批量/匿名 → 泳道 B。强检测平台（首批：小红书）在两条泳道上都禁用脚本硬操作，优先地图+单步视觉，全程拟人化输入。

### 5.2 写租约 BrowserWriteLease

主进程单例服务，按 surface（`user-view` / `agent-view`）管理：

- 状态：`idle / held / takeover / expired` 四态。`paused` 属于任务状态（task runner 已有），不进锁。
- 字段：`leaseId`、`taskId`、`runId`、`surface`、`tabId`、`acquiredAt`、`expiresAt`、`lastHeartbeatAt`。
- 规则：
  1. **写调用判定按本次调用的实际效果，不按工具名**。凡是会导航、点击、输入、滚动、上传、创建/切换标签页或执行 JS 的调用都是写调用——包括 `browser_extract_structured` / `browser_scroll_collect` 带 `url` 参数时（会打开或导航标签页）、`browser_scroll_collect` 本身（会滚动页面）、以及 `browser_execute_js`（任意 JS 的只读性静态不可判定，**一律按写调用处理**，不做伪保证）。写调用必须持有对应 surface 的有效租约；无租约 → 结构化错误 `lease_required`。
  2. 真只读调用（`browser_read_page_map`、`browser_capture_viewport`、不带 `url` 且仅做只读求值的 probe/extract 路径）免租约，结果标记 `readOnly: true`。每个工具按参数形态的读/写分类登记在 catalog 静态表中，合同测试逐一断言，不允许口头分类。
  3. 同一 surface 同时只有一个租约；第二个任务申请 → `lease_held` 错误，不排队不抢占。
  4. 用户接管 → 租约转 `takeover`，后续 Agent 写调用返回 `lease_takeover` 结构化错误；任务凭 checkpoint 决定恢复或终止。识别机制见下。
  5. TTL 到期且心跳停止 → `expired`，自动转 `idle`；任务可重新申请并从 checkpoint 续跑。不存在永久卡死。

- **接管识别（让"即时生效"可落地而不是口号）**：
  1. Agent 写动作全部经 automation-service 统一通道下发，下发前在租约服务登记**动作窗口**（correlationId + 时间窗）；窗口外出现的输入/导航视为用户来源。
  2. 用户来源信号分层：键盘走 `before-input-event`；导航走 `did-start-navigation` 且无匹配的 Agent 导航意图；renderer 发起的切 tab / 关 tab IPC 构造上即用户动作；UI 显式"接管"按钮（WP11）。
  3. `webContents` 的 `input-event` 事件作为鼠标来源识别首选，WP1 spike 验证其在 Electron 34 的可用性；若不可用，"页面内无导航的纯鼠标点击"是已知残余盲区，由显式接管按钮 + 键盘/导航信号兜底，并在文档与 UI 中明示。

### 5.3 页面地图 `browser_read_page_map`

**实现路径**（这是全计划技术风险最高的部分，必须先 spike）：

1. 首选：`webContents.debugger`（automation-service 已在用 CDP）调 `Accessibility.getFullAXTree`，拿 role/name/value/state + `backendDOMNodeId`；对可交互节点用 `DOM.getBoxModel` 合并视口坐标。
2. 降噪照抄 Matrix `formatDomSnapshot` 规则：丢弃无名 `img`/不可见节点，`generic/listitem/group` 包裹节点展开提升子节点，保留 button/link/menuitem/option/tab/textbox/heading/可见文本/checked/expanded/disabled 状态。
3. Fallback（若 Electron 的 AX 域在目标页面不完整）：注入 JS walker 按 role/aria 属性/语义标签计算同构输出。两条路径产出同一 schema，行为测试只断言 schema。
4. **targetId = `${mapGeneration}:${frameId}:${backendDOMNodeId}`**；每次生成地图 generation 自增，frame 维度覆盖 iframe 内目标。节点缺 `backendDOMNodeId` 时回退到结构路径 id 并标 `unstable: true`（操作前必须复读确认）。地图输出带 `generation` 与 `viewport`。
5. 限长合同：缩进文本 + targets 数组默认 ≤ 32KB，超限按"视口内优先、可交互优先"截断并标注 `truncated: true`。**永不返回完整 HTML**。

### 5.4 目标操作 `browser_act_on_target`

一个工具替代 codex 的 click/expand/choose/expand_and_read 四个：

- 输入：`target_id`、`action: click | expand | choose | fill | hover`、`value?`（choose/fill 用）、`read_back: none | delta | map`、`expected_change?`、`max_wait_ms?`。
- 合同：
  1. `target_id` 的 generation 必须等于当前地图 generation，否则 `stale_page_map` 结构化错误（强制"操作前拿新鲜快照"，纪律进代码而不是只进提示词）。
  2. 目标解析不唯一 → `ambiguous_target` 错误并返回候选容器列表，拒绝盲点第一个。
  3. `read_back: delta` 时返回操作后的新增/消失内容摘要 + 新 generation；`map` 时返回完整新地图。
  4. 操作经拟人化输入层（§5.7）执行。
  5. 必须持有对应 surface 租约。
- 所有写工具（含现有 `browser_click_at` 等）的结果统一搭载 `pageDelta`：`urlChanged / titleChanged / dialogOpen / newDownloads / mapGenerationBumped`（搬运 Matrix browserToolResult 模式，省 probe 轮次）。

### 5.5 采集器 `browser_visible_collect`

复用 `BrowserContentTaskRunner` / `BrowserTaskPersistenceService`，新增 `kind: 'visible_collect'`：

- 循环：读地图 → 提取当前可见条目 → 找可展开目标（展开全文/更多/评论/回复/tab/加载更多）→ **每次只展开一个** → 复读地图（delta）→ 提取新增 → 去重 → 滚一屏 → **逐轮写 checkpoint**（修正现状的"只在完成时写一次"）。
- 停止条件（全是硬预算，符合红线）：`max_items`、`max_rounds`、`max_expands_per_round`、`max_duration_ms`、连续 K 轮无新增、租约失效/接管、任务取消。
- 条目身份键：有 link 用规范化 link；否则 `hash(正文文本) + 容器路径`。去重在代码层，不交给模型。
- 输入输出 schema 沿用 codex §4.7 的设计（合理），增加 `surface: 'user-view' | 'agent-view'` 与 `lease_id`。
- 中途取消/崩溃后凭 checkpoint 恢复，从上次 cursor 继续。
- **落地接线（一次到位，不留半成品）**：`src/shared/browser-agent-task.ts` 任务类型、`browser-content-schemas.ts` 的 kind 枚举（现状只有 `download_urls / scroll_collect / research`）与 Zod schema、`content-task-runner.ts` 分支、`task-persistence-service.ts` 恢复路径同步加 `visible_collect`。
- "滚一屏"走 §5.7 统一输入通道（泳道 A 强制），不再用页面内 `window.scrollTo(instant)`；fixture 模式可用 `off` 档保持测试速度。
- **隐私边界**：泳道 A 在登录平台上的采集结果只进本地任务结果层；截图默认不持久化，仅保留动作摘要；dogfood 记录沿用 §8.5 口径。

### 5.6 视觉单步 `browser_visual_step`

沿用 codex §4.8 设计，落在现有 `browser-vision.ts` 通道上。补充合同：单次调用只返回一个建议动作；返回 `confidence`，低于阈值必须停止上报而不是重试；敏感动作返回 `requiresConfirmation: true`；调用方（domain adapter 指令）负责"不要把整段任务交给视觉"——与 Matrix 一致，但 Ready 在 tool dispatch 层额外加每任务视觉调用预算（Matrix 没有，这是我们该比它强的地方）。

### 5.7 拟人化输入层（codex 计划缺失）

升级 automation-service 的 CDP dispatch：

- 鼠标：持久光标位置（per-tab CursorState），贝塞尔曲线插值移动轨迹（Input.dispatchMouseEvent mousemove 序列）后再 press/release；移动时长与距离相关 + 随机抖动。
- 键盘：逐字符延迟 70-100ms ± 抖动，约 10% 概率插入 400-1200ms 停顿。
- 滚动：分段滚动 + 随机间隔，替代瞬时 scrollTo 到底（visible_collect 的"滚一屏"使用此通道）。
- 档位：`off / default / cautious`；泳道 A 与强检测平台默认 `default` 以上；fixture 测试用 `off` 保证速度。
- 边界：这是"像人类浏览"的体验一致性，不是绕过检测的承诺；与 §5.8 同样的合规表述。
- **统一写入通道合同**：本层是唯一合法的写动作出口。工具实现不得用 `executeJS` 合成点击/输入/滚动绕过本层（现状 `scrollCollect` 的 `window.scrollTo` 即属此类，WP4 迁移）；`browser_execute_js` 因不可判定而一律按写调用管制（§5.2.1）。否则锁、拟人化、页面地图纪律三者都会被同一个后门击穿。

### 5.8 环境一致性（Electron 真实能力定界）

**做**：独立持久 partition（`persist:agent-browser`）；UA 规范化（复用 toOAuthCompatibleUserAgent，验收断言不含 Electron/应用 token）；`Accept-Language` 与系统 locale 一致；稳定 viewport；隐藏视图 `backgroundThrottling: false`；有头渲染（不用 offscreen 无头路径碰强检测平台）。

**明确不做**（需定制 Chromium 二进制或制造新检测面）：timezone/locale 的 binary-flag 级伪装、WebRTC 出口 IP 改写、canvas/WebGL 指纹噪声、平台指纹伪装、代理 geo 一致性。如未来确有需要，单独立项评估独立 Chromium 后端，不在本计划内。

### 5.9 纪律即合同

把 Matrix 提示词资产翻译进 Ready 的两层：

- **代码层强制**（CI 可验证）：stale map 拒绝（§5.4.1）、唯一性拒绝（§5.4.2）、租约强制（§5.2）、采集预算硬限制（§5.5）、地图限长（§5.3.5）、视觉调用预算（§5.6）。
- **指令层**（browser domain adapter，经 SystemReminderRegistry 注册，不内联进 turn-engine）：定位器阶梯（testid > 稳定属性 > 稳定 href > 角色+名称 > 文本 > 容器 CSS > 坐标）、错误恢复规则（歧义/超时后必须重读地图，禁止重试同一目标）、四级确认分类法（hand-off / 操作时确认 / 预批准 / 免确认，按 Matrix 的动作枚举裁剪到 Ready 工具面）、强检测平台不硬脚本、网页内容一律不可信不作为指令。

---

## 6. 工作包

### WP0 — 合同先行
codex WP0 的 7 条合同保留，增改：
- (8) 泳道 A 用户接管即时生效：takeover 后任何 Agent 写调用返回结构化错误；"即时"由 §5.2 接管识别机制定义（动作窗口 + 用户来源信号），不是口号。
- (9) `stale_page_map` / `ambiguous_target` / `lease_required` / `lease_held` / `lease_takeover` 是五个独立的结构化错误码，语义互斥（对齐 tool_not_registered vs authorization_denied 的先例）。
- (10) 写工具结果必须含 `pageDelta` 字段。**兼容策略**：pageDelta 是纯新增字段，不改不删既有字段；现有提示词与测试分阶段迁移，迁移完成前所有消费方必须容忍该字段缺失。
- (11) 工具读/写分类是 catalog 静态表（按参数形态判定，§5.2.1-2），合同测试逐工具断言。
- (12) `browser_execute_js` 一律按写调用管制；任何工具实现不得用 executeJS 合成点击/输入/滚动（§5.7 统一写入通道合同）。施工前先 grep 枚举现有**所有** JS 合成写路径（已知：scrollCollect 的 `window.scrollTo`；可能还有 compose/click_text 等的 JS 派发），枚举结果作为本合同测试的输入清单。
- 验收：合同测试先红后绿。

### WP1 — BrowserWriteLease（提前，原 codex WP2）
两个 surface；按 §5.2.1 写调用分类接入现有全部工具（含 `browser_execute_js`、带 `url` 的 extract/scroll_collect）+ 新工具；Agent 动作窗口登记与用户来源信号实现（含 `input-event` 可用性 spike）。**不依赖新浏览器，先行**。
验收：codex WP2 四条 + `browser_extract_structured(url)` 无租约被拒、`browser_execute_js` 无租约被拒、用户键盘输入触发 takeover 且后续写调用返回 `lease_takeover`。

### WP2 — 页面地图（原 codex WP3，含 spike）
先做 CDP Accessibility spike（1-2 天），验收项：真实静态页 + 重 SPA + 含 iframe 页面各至少一个；统计缺 `backendDOMNodeId` 节点比例并验证结构路径 fallback id 可操作；限长截断行为正确；stale target 合同生效。spike 结论（主路径/fallback 配比）写回本文档后再实现 §5.3。验收沿用 codex WP3 四条 + targetId 跨 generation 过期测试 + iframe 内目标可定位。

### WP3 — `browser_act_on_target`（合并原 codex WP4+WP5）
实现 §5.4。验收：codex WP4 三条 + WP5 三条（展开全文/评论提取、菜单打开不误判完成）+ stale/ambiguous 错误路径。

### WP4 — `browser_visible_collect` 泳道 A 版（原 codex WP6）
在用户标签页上跑通完整采集闭环（需 WP1 租约）。交付含 §5.5 落地接线全清单（shared 类型 / Zod kind 枚举 / runner 分支 / persistence 恢复路径）；滚动迁移到统一输入通道；隐私边界落地（截图默认不持久化）。验收：codex WP6 五条（fixture 信息流/评论区/tab 页/取消可查/checkpoint 恢复）+ 逐轮 checkpoint 断言 + takeover 中断恢复 + 重启后 `visible_collect` 任务能被 resumePendingTasks 接起。

### WP5 — 拟人化输入层（新增）
实现 §5.7。验收：CursorState 连续性（两次点击之间有移动轨迹事件序列）；打字事件间隔分布断言；fixture 下 `off` 档位与现有行为等价（回归保护）。

### WP6 — Agent Browser 会话 + 隐藏视图 spike（原 codex WP1）
`persist:agent-browser` partition、隐藏 WebContentsView、绑定 taskId、可预览可销毁。**新 partition 不是只创建出来就完**：session-policy-service 的权限/下载/adblock 策略、UA 与语言设置必须显式 applyForPartition 到新 partition，与 `persist:browser` 策略面对齐（差异只允许出现在显式声明处）。**前置 spike**：隐藏视图的 capturePage/滚动/点击/定时器在 `backgroundThrottling: false` 下是否可靠；不可靠则降级为最小化窗口或 1px 视图方案，spike 结论写回本文档。验收沿用 codex WP1 三条（用户 BrowserView 的 URL/activeTab/滚动位置零变化等）+ 新 partition 策略生效断言（权限请求被策略处理、下载落任务目录、UA 一致）。

### WP7 — `browser_visible_collect` 泳道 B 版
同一工具加 `surface: 'agent-view'`；后台长任务接入现有 resume。验收：A/B 隔离 fixture（codex §11.5）。

### WP8 — 视觉单步 `browser_visual_step`（原 codex WP7）
实现 §5.6。验收：codex WP7 三条 + 每任务视觉预算超限停止。

### WP9 — 环境一致性（重定界版，原 codex WP8）
实现 §5.8"做"清单。验收：指纹配置只影响 agent-view；用户 BrowserView 的 UA/语言/profile 零变化；**运行时断言**（不是文档推论）：agent-view 内 `navigator.webdriver === false`、实测 UA 不含 Electron/应用 token、`Accept-Language` 与配置一致；"不做"清单写入文档与测试注释。

### WP10 — 纪律落地 + 平台轻规则（原 codex WP9 + 指令层）
§5.9 指令层进 domain adapter；首批平台规则（小红书/微博/X/Reddit/B站/YouTube：脚本禁用名单、展开词表、条目字段归一、每轮上限）。验收：fixture 必须，真实平台只做人工 dogfood 证据（沿用 codex 立场）。

### WP11 — 预览、接管与回放 UI（原 codex WP10）
Agent Browser 截图预览、租约状态、采集进度、动作摘要、暂停/接管/恢复。按 CLAUDE.md §7 最小闭环走全六项（IPC handler / preload / renderer 类型 / 组件 / 行为测试 / 文档）。renderer 只消费 projection 派生状态，不本地猜测（对齐既有红线）。

### 施工顺序与里程碑

```
阶段一（采集能力证明，全部在泳道 A，无新浏览器）：
  WP0 → WP1 → WP2 → WP3 → WP4
  里程碑：在 fixture 与一个真实登录平台上，由用户显式发起协驾、全程可接管的前提下完成"地图→展开→滚动→去重→分段保存"。（"不打扰用户"属于泳道 B，是阶段三的里程碑。）
阶段二（行为质量）：
  WP5
阶段三（隔离与后台）：
  WP6 → WP7
阶段四（复杂页面与边界）：
  WP8 → WP9
阶段五（产品化）：
  WP10 → WP11
```

与 codex 顺序的差异：隔离浏览器从第一阶段移到第三阶段。理由见 §3 修正 7——风险最高、价值最大的是地图与采集循环；泳道 A 在用户授权协驾下凭租约防写交错即可开工（不承诺无感，§5.1 口径）；最快证实/证伪核心假设。

---

## 7. 风险与处理

沿用 codex §9 全部五项（法务边界、用户体验、复杂度、指纹合规、注入），增加：

- **CDP AX 树不完整风险**：Electron 的 Accessibility 域在部分页面可能缺节点 → WP2 spike 先行，JS walker fallback 同 schema，行为测试只锚 schema。
- **隐藏视图渲染风险**：capturePage/定时器在隐藏 WebContentsView 上可能不可靠 → WP6 spike 先行，备选方案（最小化窗口 / 1px 贴边视图）提前写明。
- **泳道 A 打扰风险**：协驾本质上占用用户可见界面 → 只允许用户显式发起；接管 0 容忍窗口；采集中 UI 有明确"Agent 正在操作"表征（WP11）。
- **双泳道路由错误风险**：登录平台任务被错误路由到泳道 B 导致登录墙空采 → 路由规则进 domain adapter 合同测试；泳道 B 采集遇登录墙时结构化上报 `login_required`，提示切换泳道 A，而不是静默空结果。
- **泳道 A 隐私风险**：协驾发生在用户登录环境，截图/checkpoint 可能含敏感内容 → §5.5 隐私边界（截图默认不持久化、结果只进本地任务结果层）+ WP11 明确表征。
- **接管识别盲区风险**：若 `input-event` 不可用，页面内无导航的纯鼠标点击无法被识别为用户来源 → 显式接管按钮 + 键盘/导航/切 tab 信号兜底；盲区在 UI 与文档明示，不假装覆盖。

---

## 8. 待决策

1. ~~Electron 还是独立 Chromium~~ → 已定：Electron（理由：全部现有工具/证据/任务栈都在 webContents 上；独立 Chromium 会孤儿化它们）。指纹高保真需求若出现，单独立项。
2. ~~新增工具还是扩展 read_page~~ → 已定：新增（同 codex）。
3. 泳道 B 登录态导入：默认不导入；后置 WP（不在本计划），需按站点显式授权 + 一次性说明。**泳道 A 的存在使该决策不再阻塞核心场景**。
4. 指纹配置入口：内部默认 + 诊断可见，不做 Settings UI（同 codex 倾向）。
5. 真实平台 dogfood 记录：动作摘要 + 用户允许的截图，不存敏感内容（同 codex）。
6. **`browser_execute_js` 的纪律（MVP 阻塞项，WP1 落地）**——它是现存的无约束逃生门，不处理则锁/拟人化/地图纪律全部可被绕开。已定方案：一律按写调用管制（强制租约，§5.2.1）+ 结果限长 + 工具实现不得用它合成点击/输入/滚动（§5.7）。"静态只读校验"因不可判定而不做伪保证。**仍需白拍板的只剩一点**：泳道 A 上是否进一步完全禁用该工具（更严但牺牲灵活性）。
7. **新增：泳道 A 是否允许窗口失焦时继续操作**——建议允许（用户切去别的 app 不等于接管），但窗口内任何用户输入仍即时 takeover。需要白拍板。

---

## 9. 最小可交付版本

阶段一的五个 WP（WP0-WP4）即 MVP：不新建浏览器、不做视觉委托、不做指纹，在用户当前标签页上凭租约跑通"页面地图 → 安全展开 → 滚动采集 → 去重 → 分段保存"，**含 `browser_execute_js` 写调用管制与接管识别**（两者是 MVP 阻塞项，不是后补）。这比 codex 的 MVP（含 Agent Browser session）更小，且第一天就能在真实登录平台上验证核心价值——"识别按钮背后内容并采集"。

---

## 10. 成功标准

沿用 codex §13 九条，修正两条、增加两条：

- （修正 3）Agent 能读到页面骨架——通过 CDP AX 树或同 schema fallback，且输出限长、永不含完整 HTML。
- （修正 7）Agent 浏览器具备**按 Electron 能力定界的**环境一致性配置，"不做"清单同样有测试锚定。
- （新增 10）登录平台的可见内容采集通过泳道 A 完成，不依赖 cookie 导入，不绕过任何权限。
- （新增 11）Agent 的鼠标/键盘/滚动行为经过拟人化输入层，fixture 下可关闭且与原行为回归等价。

---

## 11. 评审循环记录

### Round 1（2026-06-04，Codex 评审 → VERDICT: AGREE-WITH-CHANGES）

Codex 对七个修正点全部表态同意（部分附加条件），指出 3 处事实问题、5 处遗漏，给出 10 条必改清单。**全部采纳**：

1. 工具数 43→38（grep 实测 38，原数字来自子代理报告未复核——教训：二手数字必须复核）。
2. 租约从"按工具名分读写"改为"按本次调用实际效果判定"（§5.2.1-2），`extract_structured(url)` / `scroll_collect` / `execute_js` 均归写调用，分类落 catalog 静态表。
3. `browser_execute_js` 升级为 MVP 阻塞项：一律写调用 + 限长 + 禁止合成输入（§5.2.1、§5.7、§8.6、WP1）。
4. 接管识别从口号变机制：动作窗口 + 分层用户来源信号 + 已知盲区明示（§5.2 接管识别、WP1）。
5. 泳道 A 口径改为"用户授权的可见协驾"，不再声称"不打扰"（§5.1、§6 里程碑）。
6. CDP AX spike 验收补 iframe / 缺 backendDOMNodeId fallback / 限长 / stale（§5.3.4、WP2）；targetId 增加 frame 维度。
7. `visible_collect` 接线清单落 WP4（shared 类型 / Zod 枚举 / runner / persistence）。
8. `persist:agent-browser` 必须接 session policy 全套（WP6）。
9. 拟人化输入定为统一写入通道，JS 合成路径封死（§5.7）。
10. Electron 指纹结论（webdriver=false 等）降级为 WP9 运行时验收项，不作既成事实（§4、WP9）。

附带采纳：pageDelta 兼容策略（WP0.10）、泳道 A 隐私边界（§5.5、§7）。

### Round 4（2026-06-04，Claude 实现，阶段一基础落地）

已落地（typecheck 通过，新增 6 个测试套件全绿）：

- **WP0 结构化错误码 + 读写分类**：`agent-browser-errors.ts`（7 个互斥错误码）、`browser-tool-write-classification.ts`（按调用实际效果分类，extract_structured(url)→write、execute_js 恒 write、未知工具 fail-closed→write），合同测试枚举全部已注册浏览器工具。
- **WP1 BrowserWriteLease**：`browser-write-lease.ts`，四态 idle/held/takeover/expired，acquire/heartbeat/release/checkWrite，动作窗口 + 分层用户信号接管识别（keyboard 不受 grace 抑制、explicit-button 即时、navigation 受 grace）。`agent-browser-lease-gate.ts` 把 lease 以**opt-in**方式接入 `executeBrowserTool`（不破坏既有 38 个调用点）。
- **WP2 页面地图核心**：`agent-browser-page-map.ts`，移植 Matrix `formatDomSnapshot` 降噪（丢无名 img、提升 generic/listitem/group），targetId=generation:frame:node + 无 backendDOMNodeId 时 unstable 结构路径回退，限长截断、永不返回 HTML。
- **WP3 act_on_target 核心**：`agent-browser-act.ts`，stale_page_map / ambiguous_target / target_not_found 门禁。
- **WP4 可见采集器**：`agent-browser-collect.ts`（链接归一去重、跨轮 deduper、硬预算停止条件）+ `content-task-runner.ts` 新增 `visible_collect` kind（逐轮 checkpoint、resume 接线、types/schema/runner/persistence 全链路），新工具 `browser_visible_collect` 注册到 catalog。

**尚未落地（Electron 运行时绑定，依赖 WP2/WP6 spike 手动验证，列为后续）**：CDP `Accessibility.getFullAXTree` 实采（页面地图的 Electron 捕获端）、`browser_read_page_map` / `browser_act_on_target` 工具的活体 DOM 解析、`persist:agent-browser` 隐藏视图（WP6）、拟人化输入层（WP5）、视觉单步（WP8）。这些都需要在真机 spike 中验证，不在本轮纯逻辑 + 后台任务可测范围内，避免用未验证代码冒充完成。

### Round 5（2026-06-04，Codex 实现审查 REQUEST-CHANGES → 已修）

Codex 审查实现，发现 3 个真实 bug + 1 个范围缺口，全部修复：

1. **wait_for_condition(custom_js) 漏判为 read**：改为 CONDITIONAL——`condition==='custom_js'` 或 `custom_js` 非空时归 write（`browser-tool-write-classification.ts`），补分类测试。
2. **acquire 在 takeover 态可被覆盖**：`browser-write-lease.ts` acquire 增加 takeover 挡板，返回 `lease_takeover`，必须 clearTakeover 才能再 acquire，补"takeover 后新 acquire 被挡"测试。
3. **visible_collect 恢复从零重启**：`content-task-runner.ts` runVisibleCollect 开头读取上轮 checkpoint 的 cursor/partialResults 给 deduper+collected+round 播种，补恢复测试（保留旧 3 条、只增量第 4 条、round 从 cursor 续）。
4. **范围缺口——lane-A 未真正接入生产**：新增 `agent-browser-lane.ts`（runUnderUserViewLease，acquire/gate/heartbeat/release + lease_held/lease_takeover 阻断）+ `agent-browser-lease-singleton.ts`（进程级共享 lease + notifyUserTakeover 入口），并把它接进 `browser-agent-runner.ts` 的 `run()`：整个 upload/browser workflow 在 user-view 租约下执行，每个工具前 heartbeat 并经 gate，结束 release；surface 被占用/被用户接管时返回结构化提示而不强占。**仍属 WP1 spike 的只剩 Electron `before-input-event` 监听器注册**（notifyUserTakeover 的调用方），信号处理路径本身已是代码并测试覆盖。

新增/更新测试：`agent-browser-lane.test.ts`（6 例）、write-lease/classification/visible-collect-runner 各补 1 例。全部新测试套件（9 套）绿；typecheck 通过。

### Round 6（2026-06-04，Codex 实现审查 Round 2 又抓到 1 个状态机阻断 → 已修）

Codex 在复核 lane-A 时发现新阻断点（其 worker 在记录该发现后达到运行时长上限退出，未给完整 verdict）：**takeover 后 `release()` 把状态清成 idle，绕过"必须 clearTakeover 才能再 acquire"**。即用户接管后、agent run 的 finally 释放租约时，会把被接管的 surface 误重置为 idle，导致新任务可立刻强占用户正在操作的页面。

已修：`browser-write-lease.ts` release()——当 surface 处于 takeover 态时，只清 lease 引用、保持 takeover，不重置为 idle；只有 clearTakeover 能恢复 idle。补 2 个测试（write-lease 的 "release during takeover 不重置"、lane 的 "takeover during run 存活过 finally release"）。全部测试绿；typecheck 通过。

### Round 7（2026-06-04，Codex fresh 审查 REQUEST-CHANGES：后台采集绕过租约 → 已修）

Codex 新线程快速给出 verdict，状态机本身无漏洞，但抓到关键架构缺口：**`browser_visible_collect` 只在"启动后台任务"瞬间被租约拦住；后台 runVisibleCollect 循环之后的滚动/提取不再受 takeover/过期约束**——用户接管无法停止后台采集。我此前给 `evaluateStop` 设计了 `leaseLost`/`lease_lost` 正是为此，但没接线。

已修：
- `content-task-runner.ts`：构造函数注入 `leaseService`（默认进程单例）。runVisibleCollect 拆为"租约前置 + 循环"两段：standalone（无继承 lease）时为任务自身 acquire user-view 租约、结束 release；继承 lease（来自 lane-A run）时只 check+heartbeat 不 acquire/release。循环每轮写动作前 `checkWrite`，丢租约/被接管 → `leaseLost` → evaluateStop 返回 `lease_lost` 停止；每轮 heartbeat 防长采集过期。
- `browser-tools.ts`：`browser_visible_collect` 把当前 gate 的 surface/leaseId 透传进任务 payload，使后台循环在同一租约下运行。
- 测试：visible-collect-runner 注入独立 lease 服务，新增 "用户接管 → 后台循环 lease_lost 停止且 0 次 extract" 用例。全部测试绿；typecheck 通过。

### Round 8（2026-06-04，Codex 复核又抓到 url 路径残留绕过 → 已修）

Codex 复核确认 tabId 路径已闭合，但发现 **url 路径残留**：`runVisibleCollectLoop` 在 `payload.url` 存在时先 `openTarget(...)`（打开/导航目标页，本身是写）才进循环做首轮 checkWrite——继承的 lease 若已被接管，后台仍会先打开一次页面。

已修：在 `openTarget` 之前加 upfront `checkWrite` 守卫，租约已丢则以 stopReason `lease_lost`、0 items 直接完成，不碰页面。补测试 "url + 继承已被接管的 leaseId → openTargetCalls===0 且 lease_lost"。全部测试绿；typecheck 通过。

### Round 2（2026-06-04，Codex 复核 → AGREE-WITH-CHANGES，10 条中 8 PASS / 2 FAIL）

两处文本残留已修：§3 修正 7 与 §6 顺序说明中的"不打扰"旧口径统一为"用户授权的可见协驾，防写交错，不承诺无感"；§2.7 的"navigator.webdriver 默认就是 false"改为 WP9 运行时验收项口径。另采纳 Codex 提示：统一写入通道施工时须**枚举现有所有 JS 合成写路径**（不只 scrollCollect），该枚举列入 WP0 合同测试的输入。
