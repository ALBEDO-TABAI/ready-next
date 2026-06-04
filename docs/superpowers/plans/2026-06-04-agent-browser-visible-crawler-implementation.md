---
title: Agent Browser 与可见页面采集器实施计划
date: 2026-06-04
status: draft-for-review
owner: 白
executor: Codex
enforce: true
related:
  - AGENTS.md §0.5（先合同，后代码）
  - AGENTS.md §2（BrowserView 原生覆盖层硬约束）
  - .claude/architectural-principles.md（形态意识、跨边界状态显式建模）
  - docs/superpowers/plans/2026-05-23-Y0-5-surface-02-embedded-browser-implementation.md
  - docs/superpowers/plans/2026-06-01-browserview-presentation-unification-implementation.md
references_current_ready:
  - src/main/modules/browser-engine/capability-service.ts
  - src/main/modules/browser-engine/content-task-runner.ts
  - src/main/modules/browser-engine/task-persistence-service.ts
  - src/main/modules/tools/browser-tools.ts
  - src/main/modules/tools/browser-tool-catalog.ts
  - src/main/modules/tools/schemas/browser-content-schemas.ts
  - src/main/modules/agent-control/domain-adapters/browser-task-planner.ts
  - src/shared/browser-agent-task.ts
references_matrix_unpacked:
  - /Users/user/matrix-unpack/Matrix.app/Contents/Resources/browser-v2/main.js
  - /Users/user/matrix-unpack/prompts-zh/neo-agent-seed/templates/browser-skill.md
---

# Agent Browser 与可见页面采集器实施计划

> 本文是基于 Matrix 解包调查后，为 Ready 设计的浏览器增强计划。目标不是照搬 Matrix，而是把其中对 Ready 有价值的能力拆出来：Agent 专用浏览器、操作锁、页面骨架读取、可见页面采集、视觉单步委托、指纹一致性。
>
> 施工前必须先读 §1-§4，确认本计划的边界；再按 §7 工作包顺序推进。任何实现都必须先补可机器验证的合同，再改代码。

---

## 0. 一句话

Ready 应该保留用户正在使用的 BrowserView，同时新增一套和用户浏览器解耦的 **Agent 专用浏览器**。Agent 浏览器负责视觉操作、社交平台可见内容采集、长页面滚动展开和后台爬取；用户浏览器负责用户当前看的真实页面。二者不能混用，Agent 浏览器必须有操作锁，指纹处理只放在 Agent 浏览器侧，不能污染用户浏览器。

---

## 1. 前因后果

### 1.1 用户观察到的问题

Matrix 的浏览器能力在实测中表现出几个 Ready 目前不够强的点：

1. 能采集国内外主流社交平台上用户可见的内容。
2. 能识别网页上多个按钮、菜单、选项背后的内容。
3. 能在不稳定页面里通过视觉方式操作，而不是只靠固定选择器。
4. 能处理长页面、评论、信息流等需要多轮展开和滚动的内容。

Ready 目前已经有浏览器工具和内容任务，例如：

- `browser_read_page`
- `browser_extract_structured`
- `browser_scroll_collect`
- `browser_download_gallery`
- `browser_research_topic`
- `browser_capture_viewport`
- `browser_analyze_viewport`
- `browser_click_at`
- `browser_scroll_at`
- `browser_start_task`

这些工具说明 Ready 不是从零开始。但它们目前更像“传统网页采集 + 局部视觉辅助”，还没有形成 Matrix 那种“先理解页面、再谨慎展开、再滚动采集、再分段保存”的完整浏览器任务体系。

### 1.2 这不是单纯加一个爬虫工具

如果只做一个新的 `browser_crawl_page`，很容易变成又一个模板采集器，解决不了社交平台和复杂页面的核心问题。

真正的缺口是四层：

1. **浏览器隔离**：Agent 操作不应影响用户正在看的 BrowserView。
2. **操作锁**：视觉 Agent 的“看截图 -> 点一下 -> 等变化 -> 再看截图”过程不能被其他任务或用户打断。
3. **页面骨架**：采集前要知道页面上有哪些按钮、菜单、选项、卡片、链接、输入框、已选状态。
4. **采集循环**：能展开、复读、滚动、去重、保存，而不是只滚到底后一次性抽取。

### 1.3 为什么要现在做

Ready 已有可复用基础：

- BrowserView 和 BrowserController 已经能导航、截图、执行页面脚本、点击、滚动。
- `BrowserContentTaskRunner` 已经有后台任务、进度、恢复和结果保存。
- `browser_analyze_viewport` 已经有视觉识别入口。
- `browser_probe_workflow_state` 已经能组织页面状态、候选控件和证据。
- Agent 浏览器任务规划已经有“理解 -> 计划 -> 分步执行 -> 复核”的产品约束。

也就是说，Ready 缺的不是能力碎片，而是把这些碎片收口成一个更强的浏览器任务架构。

---

## 2. Matrix 调查结论

### 2.1 Matrix 的浏览器形态

Matrix 解包中看到的浏览器模块主要是：

- `browser-v2-server`
- `browser-v2-mcp`
- `browser-v2/main.js`
- 自带 `Matrix Browser.app`，本质是一个定制 Chromium 壳
- `browser.script.run`
- `browser.task.message`

它不是一个普通页面爬虫，而是一个独立浏览器服务。外部 Agent 通过 MCP 调用它。

### 2.2 Matrix 的两条浏览器路线

Matrix 把浏览器任务拆成两种方式：

| 方式 | 适合场景 | 特点 |
| --- | --- | --- |
| 脚本方式 | DOM 稳定、需要重复验证、可精确定位 | Playwright 子集、页面骨架快照、唯一性检查 |
| 视觉 Agent | DOM 不稳定、页面强检测、视觉路径更清楚 | 看截图、坐标点击、滚动、逐步复核 |

它明确要求不要把整段任务都交给视觉 Agent。视觉 Agent 只处理一个边界清晰的小步骤，然后回到主流程。

### 2.3 Matrix 的页面骨架能力

Matrix 使用类似 `ariaSnapshot({ mode: "ai" })` 的页面骨架快照，并做了降噪：

- 去掉无意义图片节点。
- 展开 generic/listitem/group 这类包裹节点。
- 保留按钮、链接、菜单项、选项、可见文本、状态等对操作有用的信息。

这解释了它为什么能识别“多个按钮背后的内容”：它不是盲点，而是点开一层后重新读取页面骨架，再判断新增了什么。

### 2.4 Matrix 的快照纪律

Matrix 的提示词里反复强调：

1. 操作前先拿新鲜页面快照。
2. 只从快照里出现的内容构建定位。
3. 目标不唯一时先缩小范围。
4. 点击、填写、选择后，如果 UI 改变，就重新快照。
5. 不要用全页正文或循环读取大量元素做探索。

这不是某个单点工具，而是一套操作纪律。

### 2.5 Matrix 对社交平台的处理方式

Matrix 明确把小红书这类平台列为脚本不适合的场景：避免在登录账号环境下用脚本方式硬操作，改用视觉 Agent。

这说明它在社交平台上的强项，很大一部分不是“有专用社交爬虫”，而是：

- 使用真实持久浏览器。
- 尽量像人类浏览一样滚动、点击、等待、复核。
- 不在强检测平台上滥用脚本方式。
- 对需要展开的内容逐步操作。

### 2.6 Matrix 的指纹处理

Matrix 使用的 `cloakbrowser` 路径里能看到这些能力：

- 去掉常见自动化启动标记。
- 设置浏览器指纹种子。
- 设置平台指纹。
- 支持语言、时区、代理、代理出口地理信息。
- 支持 WebRTC 出口 IP 一致性。
- 默认使用持久 profile。

这不是 Ready 应该默认照搬到用户浏览器的东西，但值得作为 Agent 专用浏览器的“环境一致性”能力学习。

这里的目标不是绕过平台，而是避免 Agent 浏览器一眼看起来像脚本环境。尤其在用户已经授权、浏览器内能正常看到内容时，Agent 浏览器应该尽量保持普通浏览器的一致性。

### 2.7 Matrix 的弱点

Matrix 的共享持久浏览器有明显风险：

- 脚本、视觉 Agent、人类用户可能操作同一个登录态和页面状态。
- `taskId` 只是 Browser Agent 对话连续性，不是页面锁，也不是并发锁。
- Browser Agent 可以在共享浏览器里影响用户或其他任务的页面。

Ready 不应该学这个弱点。Ready 应该做得更清楚：用户浏览器和 Agent 浏览器分离，Agent 浏览器有显式操作锁。

---

## 3. Ready 当前状态

### 3.1 已有优势

Ready 已经具备几类基础能力：

1. **浏览器交互工具**
   - 导航、搜索、读取页面、点击、输入、截图、坐标点击、滚动、等待。

2. **内容任务工具**
   - 结构化提取、滚动采集、图片收集、URL 下载、图集下载、研究任务。

3. **后台任务持久化**
   - `BrowserContentTaskRunner` 和 `BrowserTaskPersistenceService` 已经支持任务创建、进度、恢复、取消、结果。

4. **视觉辅助**
   - `browser_analyze_viewport` 能基于截图找上传、输入、发送、关闭、返回等目标。

5. **浏览器任务规划**
   - `browser-task-planner` 已经能把上传/生成类任务拆成阶段，并要求最终复核。

这些是 Ready 的强项，计划应复用而不是重写。

### 3.2 当前缺口

| 缺口 | 当前表现 | 影响 |
| --- | --- | --- |
| 用户浏览器和 Agent 浏览器未明确分离 | Agent 工具默认围绕现有 BrowserView 工作 | 视觉 Agent 容易打扰用户当前页面 |
| 缺少操作锁 | 多个 Agent/任务理论上可能争用同一页面 | 视觉判断会被中途状态变化破坏 |
| 页面读取偏正文/规则 | `browser_read_page` 主要是 `body.innerText` | 看不到页面结构和选项关系 |
| 采集器偏传统模板 | `scroll_collect` 主要滚动到底再抽取 | 不擅长展开菜单、评论、回复、tab |
| 视觉能力未接入采集循环 | 视觉工具和采集工具并列存在 | 不稳定页面无法自动切换打法 |
| 指纹一致性未建模 | 用户 BrowserView 和 Agent 环境未区分 | 强检测页面上 Agent 浏览器表现不稳定 |

---

## 4. 目标设计

### 4.1 总体目标

新增一条 Ready 浏览器能力线：**Agent Browser + Visible Crawler**。

它包含：

1. Agent 专用浏览器。
2. Agent 浏览器操作锁。
3. 页面骨架读取。
4. 安全点击与唯一目标确认。
5. 展开并复读的单步工具。
6. 可见页面采集器。
7. 指纹一致性配置。
8. 任务进度保存和回放。

### 4.2 用户浏览器与 Agent 浏览器分工

| 浏览器 | 用途 | 能否被 Agent 自动滚动/点击 | 登录态 | 默认可见性 |
| --- | --- | --- | --- | --- |
| 用户浏览器 | 用户当前浏览、手动查看、产品内网页体验 | 默认不允许，除非用户明确要求 | 用户自己的当前状态 | 可见 |
| Agent 浏览器 | 采集、研究、视觉操作、后台网页任务 | 允许，但必须持有操作锁 | 独立 profile，可选导入/复用授权状态 | 默认隐藏，可预览 |

### 4.3 Agent 浏览器操作锁

Agent 浏览器必须显式建模锁状态。

建议状态：

| 状态 | 含义 |
| --- | --- |
| `idle` | 没有任务控制浏览器 |
| `locked_by_agent` | 某个 Agent 任务正在操作 |
| `waiting_for_user_takeover` | Agent 暂停，等待用户接管 |
| `paused` | 任务主动暂停，锁仍归任务 |
| `expired` | 超时释放，需要恢复或重建上下文 |
| `released` | 正常释放 |

锁必须包含：

- `lockId`
- `taskId`
- `ownerRunId`
- `browserSessionId`
- `tabId`
- `acquiredAt`
- `expiresAt`
- `lastHeartbeatAt`
- `state`
- `reason`

强制规则：

1. 没有锁不能点击、输入、滚动、导航、上传。
2. 只读观察可以允许无锁，但必须标记为 read-only。
3. 一个 Agent 浏览器同一时刻只能有一个写操作任务。
4. 用户接管前必须暂停 Agent 并切换锁状态。
5. 锁超时必须释放或进入可恢复状态，不能永久卡死。

### 4.4 指纹一致性配置

指纹处理只属于 Agent 浏览器，不属于用户浏览器。

建议能力：

- 持久 profile。
- 普通有头浏览器。
- 避免明显自动化标记。
- User-Agent、语言、时区、地区一致。
- 代理与地理信息一致。
- WebRTC 出口一致。
- 浏览器窗口尺寸稳定。
- 不用无头模式触碰强检测平台。

边界：

- 不做绕过登录。
- 不做绕过平台权限。
- 不做批量压测式抓取。
- 不把反检测作为产品默认宣传点。
- 不污染用户 BrowserView。

### 4.5 页面骨架读取

新增或扩展一个工具，返回结构化页面地图，而不是只返回正文。

建议工具名：

- `browser_read_page_map`

或扩展：

- `browser_read_page` 增加 `mode: "text" | "map" | "both"`

页面地图至少包含：

- 页面标题、URL、主域名。
- 可见正文摘要。
- 链接列表。
- 按钮列表。
- 输入框列表。
- 菜单、下拉、tab、切换项。
- 卡片/帖子/评论候选。
- 图片/视频候选。
- 已选状态、禁用状态、展开状态。
- 每个节点的稳定定位线索：文本、角色、label、href、data-testid、坐标、所在容器。

不要返回完整 HTML，也不要把大段页面文本直接塞给模型。

### 4.6 安全点击与唯一目标确认

新增一组“安全操作”规则：

1. 从页面地图或截图候选里选择目标。
2. 确认目标唯一。
3. 若不唯一，先缩小到容器。
4. 点击/输入/选择后重新读取页面地图或截图。
5. 如果页面变化和预期不一致，停止盲试。

可以新增工具：

- `browser_click_page_target`
- `browser_expand_page_target`
- `browser_choose_page_option`

也可以先在 Agent 指令里强制现有工具按这个流程使用。

### 4.7 可见页面采集器

核心新能力是：

- 只采集用户或 Agent 浏览器中可见、可到达、可正常访问的内容。
- 自动识别“展开全文 / 查看更多 / 加载更多 / 评论 / 回复 / tab / 筛选 / 排序 / 下拉”。
- 每次只操作一个展开点。
- 操作后重新读取页面地图。
- 提取新增内容。
- 滚动一屏。
- 重复直到达到限制或没有新增内容。
- 结果分段保存，支持恢复。

建议工具名：

- `browser_visible_collect`

输入：

- `url?`
- `tab_id?`
- `target`：要采集的内容类型，例如 `posts/comments/images/links/cards/custom`
- `max_items`
- `max_scrolls`
- `max_expands_per_scroll`
- `include_comments`
- `include_media`
- `same_origin_only`
- `respect_robots_hint`
- `save_progress`

输出：

- `taskId`
- `status`
- `collectedCount`
- `newItems`
- `dedupedItems`
- `expandedTargets`
- `skippedTargets`
- `screenshots`
- `sourceMap`
- `nextCursor`

### 4.8 视觉单步委托

当页面地图不够清楚时，调用视觉能力只处理一个小步骤。

适用：

- “哪个按钮是展开评论？”
- “哪个 tab 是最新？”
- “哪里是加载更多？”
- “这个页面里哪个按钮会打开筛选项？”

不适用：

- 让视觉 Agent 自己无限爬。
- 让视觉 Agent 替主流程做长期规划。
- 让视觉 Agent 自行处理登录、支付、验证码、敏感操作。

建议工具：

- `browser_visual_step`

返回：

- 建议动作。
- 置信度。
- 坐标或目标描述。
- 依据截图。
- 是否需要用户确认。

---

## 5. Matrix vs Ready 差异表

| 方向 | Matrix | Ready 当前 | Ready 计划 |
| --- | --- | --- | --- |
| 浏览器形态 | 独立 browser-v2 服务，带定制 Chromium | 产品内 BrowserView | 新增 Agent Browser，保留用户 BrowserView |
| 用户/Agent 分离 | 共享持久浏览器，隔离不足 | 默认围绕用户 BrowserView | 用户浏览器与 Agent 浏览器显式分离 |
| 操作锁 | 未看到强锁模型 | 未形成 Agent 浏览器锁 | 新增 lockId/taskId/sessionId 状态机 |
| 指纹处理 | CloakBrowser 指纹、语言、时区、代理一致性 | 未作为独立能力建模 | 只给 Agent 浏览器做环境一致性 |
| 页面理解 | 页面骨架快照 + 快照纪律 | 正文读取 + 候选规则 + 截图分析 | 新增页面地图工具 |
| 点击策略 | 操作前确认唯一性 | 部分工具可直接点击 | 新增安全点击/展开/选择流程 |
| 社交平台 | 强检测平台走视觉方式 | 传统采集更强，视觉未串入采集 | 可见页面采集器 + 视觉单步委托 |
| 长任务 | 视觉 Agent 可写中间发现 | 已有后台任务持久化 | 接入现有后台任务，分段保存 |
| 素材盘点 | 页面资源 inventory/bundle | 图片收集和下载较基础 | 中期增加页面素材盘点 |
| 风险边界 | 共享浏览器有串扰风险 | 产品 BrowserView 不能被打扰 | 隔离 + 锁 + 可接管 + 可回放 |

---

## 6. 非目标

本计划不做：

1. 不替换 Ready 的用户 BrowserView。
2. 不把 Matrix 的独立 Chromium 壳直接搬进来当默认浏览器。
3. 不做绕过登录、绕过平台权限、绕过验证码。
4. 不做无边界批量抓取。
5. 不一开始给每个平台写重型专用爬虫。
6. 不让视觉 Agent 无限自治。
7. 不把指纹处理应用到用户浏览器。
8. 不把网页里的外部内容当成可信系统指令。

---

## 7. 工作包

### WP0 — 合同与边界先行

**目标**：先写可机器验证的合同，避免后续架构漂移。

**新增合同建议**：

1. Agent 浏览器写操作必须持锁。
2. 用户 BrowserView 默认不被 Agent 采集任务滚动/点击。
3. Agent Browser session 与用户 BrowserView session 不共用 tab 状态。
4. 锁超时会释放或进入可恢复状态。
5. `browser_visible_collect` 不会在无锁情况下执行点击、滚动、输入。
6. 页面地图输出有大小上限，不返回完整 HTML。
7. 强检测平台策略不会默认启用脚本硬操作。

**验收**：

- 至少新增一组行为测试或合同测试，先红后绿。

### WP1 — Agent Browser 会话模型

**目标**：建立 Agent 专用浏览器会话，不再默认用用户当前 BrowserView 做采集和视觉操作。

**设计点**：

- 新增 Agent Browser session 概念。
- session 有独立 profile/path。
- session 可隐藏、可预览、可销毁。
- session 可绑定 taskId。
- session 状态可上报给 renderer。

**候选模块**：

- `src/main/modules/browser-engine/`
- `src/shared/browser-agent-task.ts`
- `src/main/modules/agent-control/domain-adapters/browser-domain-orchestrator.ts`

**验收**：

- 创建 Agent Browser 不改变用户当前 BrowserView URL、activeTab、滚动位置。
- Agent Browser 关闭不影响用户 BrowserView。
- Agent Browser 截图、导航、读取页面能独立完成。

### WP2 — Agent Browser 操作锁

**目标**：为 Agent Browser 建立显式操作锁。

**设计点**：

- 只读观察可无锁。
- 写操作必须持锁。
- 锁有 owner、task、session、tab、超时、心跳。
- 用户接管会暂停 Agent。
- 任务完成释放锁。

**工具影响**：

- `browser_click_at`
- `browser_type_at`
- `browser_scroll_at`
- `browser_send_keys`
- `browser_navigate`
- `browser_upload_scope_attachment`
- 新增 `browser_visible_collect`

**验收**：

- 无锁点击失败并返回结构化错误。
- 同一 session 第二个写任务不能抢锁。
- 锁超时后新任务可以恢复。
- 用户接管时 Agent 写操作停止。

### WP3 — 页面地图读取

**目标**：补齐 Ready 的页面骨架能力。

**建议工具**：

- `browser_read_page_map`

**页面地图字段**：

- `page`
- `summary`
- `sections`
- `cards`
- `links`
- `buttons`
- `inputs`
- `menus`
- `options`
- `expandables`
- `media`
- `states`
- `targets`

**实现思路**：

- 优先从可访问树/ARIA/DOM 结构提炼。
- 不返回完整 HTML。
- 合并可见文本、aria-label、title、href、role、坐标、容器路径。
- 降噪 generic wrapper、空图片、不可见节点。
- 输出严格限长。

**验收**：

- 能在 fixture 页面识别多个同名按钮并标出各自容器。
- 能识别 tab、下拉、展开按钮、评论入口。
- 输出不包含完整 HTML。
- 同一页面连续读取稳定。

### WP4 — 安全目标操作

**目标**：让点击、展开、选择从“猜 selector/坐标”变成“基于页面地图确认目标”。

**建议工具**：

- `browser_click_page_target`
- `browser_expand_page_target`
- `browser_choose_page_option`

**规则**：

1. `targetId` 来自页面地图。
2. 目标过期时必须重新读取页面地图。
3. 目标不唯一时拒绝操作并返回候选。
4. 操作后返回页面变化摘要。

**验收**：

- 两个同名“更多”按钮时，不允许盲点第一个。
- 指定某张卡片内的“更多”时能正确展开。
- 展开后返回新增内容摘要。

### WP5 — 展开并复读

**目标**：实现可见页面采集器的关键单步：识别可展开目标，展开一个，重新读取页面地图，提取新增内容。

**建议工具**：

- `browser_expand_and_read`

**输入**：

- `target_id`
- `expected_change`
- `max_wait_ms`

**输出**：

- `expanded`
- `newContent`
- `newTargets`
- `beforeMapId`
- `afterMapId`
- `screenshotIds`

**验收**：

- 展开全文后能提取新出现正文。
- 展开评论后能提取新评论。
- 如果点击只打开菜单，不误认为采集完成。

### WP6 — 可见页面采集器

**目标**：把页面地图、展开单步、滚动、去重、保存串起来。

**建议工具**：

- `browser_visible_collect`

**采集循环**：

1. 打开或复用 Agent Browser tab。
2. 获取操作锁。
3. 读取页面地图。
4. 提取当前可见内容。
5. 找可展开目标。
6. 每次展开一个，复读页面地图。
7. 提取新增内容并去重。
8. 滚动一屏。
9. 重复直到达到限制、没有新增内容或触发风险边界。
10. 保存 checkpoint。
11. 释放锁。

**验收**：

- 对 fixture 信息流采集多轮滚动内容。
- 对 fixture 评论区展开并采集评论。
- 对 fixture tab 页面切换 tab 并采集各 tab 内容。
- 中途取消后任务状态可查。
- 恢复后从 checkpoint 继续。

### WP7 — 视觉单步委托

**目标**：当页面地图无法判断时，用视觉模型处理一个小步骤。

**建议工具**：

- `browser_visual_step`

**输入**：

- 当前截图。
- 页面地图候选。
- 目标动作，例如 `find_expand_button`、`find_comments入口`、`find_load_more`。

**输出**：

- `action`
- `target`
- `confidence`
- `reason`
- `requiresConfirmation`

**验收**：

- 视觉只返回单步建议，不直接无限执行。
- 低置信度时停止并报告。
- 敏感动作必须要求确认。

### WP8 — 指纹一致性配置

**目标**：Agent Browser 提供环境一致性，不污染用户浏览器。

**配置项**：

- profile path
- user agent
- locale
- timezone
- viewport
- proxy
- proxy geo consistency
- headless disabled for sensitive sites
- automation marker minimization

**验收**：

- 指纹配置只影响 Agent Browser。
- 用户 BrowserView 的 UA、语言、时区、profile 不被改变。
- Agent Browser 配置可观测，可重置。
- 无配置时走安全默认值。

### WP9 — 社交平台轻规则

**目标**：不是写重型平台爬虫，而是对常见页面形态加轻规则。

**首批平台建议**：

- 小红书
- 微博
- X/Twitter
- Reddit
- B 站
- YouTube

**规则类型**：

- 哪些平台默认不用脚本硬点。
- 哪些平台优先视觉单步。
- 常见“展开评论/更多/加载”文字和图标。
- 内容条目字段归一：作者、正文、时间、链接、图片、互动数。
- 每轮采集上限。

**验收**：

- 在 fixture 或人工可控页面验证规则。
- 不要求真实平台全量稳定通过作为 CI 条件。
- 真实平台只做人工 dogfood 证据。

### WP10 — 回放、预览与用户接管

**目标**：让 Agent Browser 任务可监督、可暂停、可接管。

**能力**：

- 当前 Agent Browser 截图预览。
- 当前锁状态。
- 当前采集进度。
- 最近动作摘要。
- 暂停任务。
- 用户接管。
- 接管后恢复或终止。

**验收**：

- 用户接管时 Agent 停止写操作。
- 接管结束后，Agent 能重新读取页面地图并判断是否继续。
- 回放能看到关键截图和展开动作。

---

## 8. 验收矩阵

| 能力 | 自动测试 | 手动 dogfood |
| --- | --- | --- |
| Agent Browser 不影响用户 BrowserView | 必须 | 必须 |
| 操作锁 | 必须 | 可选 |
| 页面地图 | 必须 | 必须 |
| 安全点击 | 必须 | 必须 |
| 展开并复读 | 必须 | 必须 |
| 可见页面采集 | 必须 | 必须 |
| 视觉单步委托 | 部分 | 必须 |
| 指纹一致性 | 必须验证隔离 | 必须 |
| 社交平台轻规则 | fixture 必须 | 真实平台 dogfood |
| 用户接管 | 必须 | 必须 |

---

## 9. 风险与处理

### 9.1 法务与平台边界风险

风险：采集社交平台内容可能触及平台规则。

处理：

- 只采集用户可见、可正常访问的内容。
- 不绕过登录和权限。
- 不绕过验证码。
- 不做高频批量抓取。
- 默认限速、限量、可停止。
- 对敏感动作要求确认。

### 9.2 用户体验风险

风险：Agent 操作打扰用户当前浏览器。

处理：

- 用户 BrowserView 和 Agent Browser 分离。
- 默认采集走 Agent Browser。
- 操作锁防止并发串扰。
- 预览和接管明确表征。

### 9.3 实现复杂度风险

风险：一次性做完整 Agent Browser + Crawler 可能过大。

处理：

- 按 WP0-WP10 分阶段。
- 先做合同、隔离、锁和页面地图。
- 可见页面采集器先支持 fixture 和通用页面。
- 社交平台规则后置。

### 9.4 指纹处理风险

风险：做成“反检测能力”会带来产品和合规风险。

处理：

- 命名为环境一致性，不作为绕过工具。
- 只作用于 Agent Browser。
- 默认温和配置。
- 强检测平台优先视觉与人工确认，不硬脚本。

### 9.5 外部内容注入风险

风险：网页内容可能包含“给 Agent 的指令”。

处理：

- 网页内容一律视为不可信。
- 页面地图只作为数据，不作为系统指令。
- 采集器不得执行页面内容里的命令。

---

## 10. 推荐施工顺序

### 第一阶段：基础边界

1. WP0 合同。
2. WP1 Agent Browser 会话模型。
3. WP2 操作锁。

完成后 Ready 应具备：Agent 可以拥有自己的浏览器，且不会打扰用户浏览器。

### 第二阶段：页面理解

4. WP3 页面地图读取。
5. WP4 安全目标操作。
6. WP5 展开并复读。

完成后 Ready 应具备：能看懂页面结构，能安全展开按钮背后的内容。

### 第三阶段：采集闭环

7. WP6 可见页面采集器。
8. 接入现有后台任务保存和恢复。

完成后 Ready 应具备：能滚动、展开、去重、分段保存。

### 第四阶段：复杂页面增强

9. WP7 视觉单步委托。
10. WP8 指纹一致性配置。

完成后 Ready 应具备：复杂页面和强检测页面有更合适的打法。

### 第五阶段：平台与产品化

11. WP9 社交平台轻规则。
12. WP10 回放、预览与用户接管。

完成后 Ready 应具备：可监督、可恢复、可人工接管的社交平台可见内容采集能力。

---

## 11. 第一批建议测试 fixture

### 11.1 多按钮展开

页面包含 10 张卡片，每张都有“更多”。测试：

- 页面地图能区分每张卡片里的“更多”。
- 未指定容器时拒绝盲点。
- 指定卡片后展开正确内容。

### 11.2 评论区展开

页面包含：

- 查看评论。
- 加载更多评论。
- 展开回复。
- 折叠回复。

测试：

- 采集器能展开评论。
- 能采集新增评论。
- 能去重。

### 11.3 tab/筛选页面

页面包含：

- 最新。
- 热门。
- 图片。
- 视频。
- 下拉排序。

测试：

- 页面地图能识别 tab/下拉。
- 采集器能按配置切换并采集。

### 11.4 信息流滚动

页面滚动后动态追加卡片。

测试：

- 采集器按轮保存。
- 达到 `max_items` 停止。
- 没有新增内容时停止。

### 11.5 Agent Browser 隔离

用户 BrowserView 打开 A 页面，Agent Browser 打开 B 页面。

测试：

- Agent 滚动 B 不影响 A。
- Agent 关闭 B 不影响 A。
- 用户切换 A 不影响 Agent 锁状态。

---

## 12. 待决策问题

1. Agent Browser 用 Electron BrowserWindow/BrowserView 现有能力做，还是引入独立 Chromium/Playwright 后端？
   - 倾向：先用 Electron 现有能力做最小闭环；后续如确有需要，再评估独立 Chromium。

2. 页面地图工具是新增 `browser_read_page_map`，还是扩展 `browser_read_page`？
   - 倾向：新增工具，避免破坏现有工具语义。

3. Agent Browser profile 是否允许从用户 BrowserView 导入登录态？
   - 倾向：默认不导入；需要用户显式授权和一次性说明。

4. 指纹一致性配置放 Settings 还是仅内部默认？
   - 倾向：先内部默认 + 诊断可见；不急着做 UI 配置。

5. 真实社交平台 dogfood 怎么记录？
   - 倾向：只记录动作摘要和用户允许的截图，不保存敏感内容。

---

## 13. 成功标准

这个计划真正完成时，Ready 应该做到：

1. 用户正在看的浏览器不会被 Agent 采集任务打扰。
2. Agent 浏览器有明确锁状态。
3. Agent 能读到页面骨架，而不是只读正文。
4. Agent 能识别多个同名按钮背后的不同内容。
5. Agent 能展开、复读、滚动、去重、保存。
6. 复杂页面能调用视觉单步判断，但不会无限自治。
7. Agent 浏览器具备温和的环境一致性配置。
8. 采集任务可暂停、可恢复、可接管、可回放。
9. 社交平台采集只处理用户可见内容，不绕过权限。

---

## 14. 最小可交付版本

如果要尽快做出第一版，不做完整平台规则，最小闭环是：

1. Agent Browser session。
2. 操作锁。
3. `browser_read_page_map`。
4. `browser_expand_and_read`。
5. `browser_visible_collect` 支持 fixture 和通用页面。
6. 接入 `browser_start_task`/`browser_get_task` 的进度保存。

这版完成后，就能证明 Ready 是否真的具备 Matrix 那种“识别按钮背后内容并采集”的核心能力。

---

## 15. 最终判断

Matrix 最值得学的不是“有一个厉害爬虫”，而是它把浏览器任务拆成了清楚的分工：

- 稳定页面：用页面骨架和精确操作。
- 不稳定页面：用视觉 Agent 做单步判断。
- 长页面：分段采集和保存。
- 强检测平台：避免脚本硬碰。

Ready 应该在这个基础上做得更适合自己的产品形态：

- 用户浏览器和 Agent 浏览器分离。
- Agent 浏览器显式上锁。
- 指纹一致性只给 Agent 浏览器。
- 采集器只处理用户可见内容。
- 所有跨边界状态都有合同和测试。
