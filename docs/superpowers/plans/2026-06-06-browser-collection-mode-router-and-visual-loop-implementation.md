---
title: 浏览器采集模式声明 + 可见卡片循环修正计划
date: 2026-06-06
status: draft-for-review-revised
owner: 白
executor: Codex
enforce: true
revision:
  - 吸收 docs/superpowers/plans/2026-06-06-browser-collection-mode-router-counterplan.md
  - 保留根因诊断；收缩施工方案；不新建平行 CollectionJob 状态机
related:
  - AGENTS.md §0（简单优先、手术式改动、模型只做判断题）
  - AGENTS.md §0.5（先合同，后代码；跨边界状态显式建模）
  - AGENTS.md §2（BrowserView 原生覆盖层硬约束）
  - AGENTS.md §3（child-loop / durable handle / projection 合同）
  - docs/superpowers/plans/2026-06-04-agent-browser-visible-crawler-implementation.md
  - docs/superpowers/plans/2026-06-04-browser-collection-subagent-implementation.md
  - docs/superpowers/plans/2026-06-05-chat-side-collection-task-indicator-implementation.md
  - docs/superpowers/plans/2026-06-06-browser-collection-mode-router-counterplan.md
  - docs/superpowers/specs/2026-06-06-matrix-agent-architecture-study.md
  - docs/superpowers/specs/2026-06-06-matrix-vs-ready-multi-agent-gap-analysis.md
references_ready:
  - src/main/modules/agent-control/prompt-assembly.ts
  - src/main/modules/tools/browser-tools.ts
  - src/main/modules/tools/schemas/browser-content-schemas.ts
  - src/main/modules/browser-engine/ipc-handler.ts
  - src/main/modules/browser-engine/content-task-runner.ts
  - src/main/modules/browser-engine/browser-collector-actions.ts
  - src/main/modules/browser-engine/collection-targets.ts
  - src/main/modules/browser-engine/capability-service.ts
  - src/main/modules/browser-engine/capability-types.ts
  - src/main/modules/claude-bridge/ipc-handler.ts
  - src/renderer/components/agent/chat-panel/task-snapshot/TaskToolSnapshot.tsx
  - src/shared/browser-collection-intent.ts
references_matrix:
  - /Users/user/matrix-unpack/prompts-extracted/files/neo-agent-seed/templates/browser-skill.md
  - /Users/user/matrix-unpack/prompts-zh/neo-agent-seed/templates/computer-use-dispatcher-skill.md
  - /Users/user/matrix-unpack/prompts-zh/neo-agent-seed/templates/neo-computer-skill.md
---

# 浏览器采集模式声明 + 可见卡片循环修正计划

> 本文是 2026-06-06 小红书/Aoi 采集连续失败后的修订计划。Aoi 和小红书只作为现实样本，不进入主逻辑硬编码。修订后保留原计划的根因判断和 Matrix 学习方向，但吸收 counterplan 的约束：先止谎、复用现有 `browser_tasks` / `source_task_id` / checkpoint / projection 合同，不新建平行 CollectionJob 状态机；验证墙是暂停状态，不是执行模式；策略由模型声明，代码做不对称否决。

---

## 0. 一句话

当前 Ready 的浏览器采集失败，不是 agent 不会努力，而是底层执行模型把“多篇内容采集”做成了“冻结链接列表后，在后台 agent tab 逐个硬跳详情 URL”。对高风控、登录态、信息流页面，这条路径天然容易触发验证、丢上下文、误报进度、保存错内容。

新的方向不是再补一个大而全爬虫，而是把采集拆成三层合同：

1. **先止谎**：发现数量、保存数量、失败数量、剩余数量必须分开显示。
2. **再选策略**：逐篇采集只接受模型声明 `card_loop / url_batch`，代码只负责结构校验和风险否决；`list_only` 是只发现清单、不进入逐篇采集的上游动作。
3. **最后执行**：高风控/逐张点开走 `card_loop`，普通网页可继续用脚本结构化或安全 URL 批处理。

所有策略都遵守 Matrix 值得学习的纪律：观察当前状态 → 做一个小动作 → 验证结果 → 写 checkpoint → 再下一步。

---

## 1. 前因后果

### 1.1 用户连续观察到的问题

最近几轮真实使用里，浏览器采集反复出现这些现象：

1. 可见采集一开始声称确认了 50/60 条，后续只处理 19 条、30 条，数量接力断裂。
2. 任务卡显示 `30/30`，但实际只是滚了一页和冻结候选，不是完成保存。
3. agent 仍然错误打开详情页或新页面，触发小红书验证/扫码/风控。
4. 用户要求“逐张点开保存再返回”，实际底层仍走后台硬跳 URL。
5. 保存结果出现奇怪文件夹名、作者名当标题、头像/推荐图混入、空目录、无后缀或结构不统一。
6. 验证暂停后 UI 没有稳定显示一个可继续的浏览器子任务卡。
7. 重启 dev 后历史任务卡会短暂堆住聊天面板，又突然消失。
8. 工具调用轮次容易耗尽，任务没完全收口。
9. 浏览器租约/锁定错误让 agent 不能连续完成任务。

这些不是孤立 bug。它们来自同一个设计偏差：发现、执行、续跑、展示、归档没有被投影成一个统一采集视图；执行层又只有“链接批处理”这一条主路径。

### 1.2 旧计划为什么没有完全解决

6 月 4 日的计划把重点放在“后台浏览器采集子 agent + 专用 agent 标签页”。这个方向解决了一个真实问题：agent 不应该抢用户当前 BrowserView。

但它保留了另一个更大的问题：后台采集仍然是“逐篇打开目标 URL → 提取 → 下载”。这对普通网页可以接受，对高风控信息流不够。因为高风控平台最敏感的不是“是否抢前台”，而是“是否沿着自然浏览路径操作”。

修订后的判断：

- **保留隔离投资**：agent tab、租约、写定向、冻结确认仍然有价值。
- **替换默认动作**：高风控/逐张点开不再默认 URL batch。
- **不新建平行任务实体**：发现任务 taskId 就是 jobId，投影层聚合即可。
- **先修假进度**：停止把“已发现”说成“已保存”。

### 1.3 counterplan 的采纳点

Claude 的反提案里有几条应该直接吸收：

1. `manual_assisted` 不是模式，而是验证墙/用户接管等暂停状态。
2. 不需要 12 状态 `CollectionJob` 新实体，现有 `visible_collect.taskId -> note_collect.source_task_id` 就是天然 job 关系。
3. 路由不应由代码解析自然语言。模型做语义声明，代码做结构校验和风险否决。
4. `allow_partial=true` 不能继续信模型参数，必须有持久用户确认。
5. `card_loop` v1 先用 DOM/URL 可验证，不急着引入视觉模型判断。
6. 先做“止谎三修”，再做更贵的 card_loop。

### 1.4 二次复查采纳点

Claude 复查修订版后指出的几处问题需要继续吸收：

1. **S2/S3 空窗**：如果 S2 先拒绝高风控 `url_batch`，但 S3 的 `card_loop` 还没注册，高风控采集会暂时不可用。计划必须声明中间态。
2. **退化路径矛盾**：spike 失败时如果退化到高风控 `url_batch`，必须有用户确认降级的豁免记录，否则会和否决规则冲突。
3. **用户声明总数缺口**：现有 `expected_count` 只保证“冻结数 = 交接数”，不保证“冻结数 = 用户说的 50/60”。发现阶段需要建模 `userExpectedTotal`。
4. **投影两跳**：只改 `BrowserTaskProjectionInput` 不够，必须断言最终 renderer 卡片状态。
5. **用户直接贴 URL 列表**：这类任务没有列表页，不应强制 `browser_visible_collect`；但必须有 URL provenance 校验。
6. **24-action 语义错误**：`content-task-runner` 没有 child-driver 的 24-action 分段机制，`card_loop` 要自己定义预算和可恢复暂停。

---

## 2. 当前审查证据

### 2.1 prompt 层把“逐张点开”强行路由到后台 URL 采集

`prompt-assembly.ts` 的浏览器采集规则明确写着：用户要求“逐个点开”“低频方式”“只保存图片”也仍然必须走 `browser_visible_collect → browser_collect_notes / browser_resume_task`，手动 `click_text / collect_images / download_urls` 只允许单篇应急。

这个规则本意是避免 agent 临时乱跑，但副作用是：用户明确要求可见逐张操作时，模型也会被强行送进后台采集器。于是语言层说“逐张点开”，工具层实际做“后台硬跳详情 URL”。

### 2.2 单篇采集第一步就是硬跳详情 URL

`browser-collector-actions.ts` 的 `collectNote()` 固定顺序是：

1. `browser_navigate(openUrl)`
2. `browser_read_page`
3. `browser_extract_structured`
4. `browser_collect_images`
5. `browser_download_urls`
6. 写 `note.md / manifest.json`

它没有卡片 locator、没有当前主页滚动位置、没有点击卡片、没有关闭弹窗/返回主页、没有验证“回到了列表上的下一张”。因此它不可能实现用户要的“主页逐张点开保存收回再点下一个”。

### 2.3 可见采集 30/30 是发现进度，不是保存进度

`content-task-runner.ts` 的 visible collect 每轮把 `total/completed` 都写成已发现数量；最终如果 stopReason 是 `no_new_content`，就把 discovery 标成 completed。聊天 UI 因此显示类似 `30/30`。

但这 30 只是冻结候选，不代表 30 篇已经打开、保存、归档。用户看到的是“任务完成感”，实际只是“发现阶段结束”。

### 2.4 `max_items=30` 会被模型带入并变成硬批次

最新运行里 agent 调用了 `browser_visible_collect(max_items=30, max_rounds=4)`。代码会尊重这个上限；如果短时间没有新内容，就可能把 30 条标成 complete。

数据层已经有 `discoveryStatus / hasMoreLikely / continueTaskId` 等字段，但 UI 投影和下游强制还没有把“当前批次”和“账号全量”清楚分开。

还缺一个更上游的数量合同：现有 `expected_count` 只约束 `browser_collect_notes` 收到的冻结清单数量是否等于交接数量；它不能证明冻结清单数量等于用户在对话里声明或 agent 早先确认的总数。例子：用户说 60，visible_collect 被 `max_items=30` 截断并误判 complete，后续 `expected_count=30` 仍会顺利通过。需要新增 `userExpectedTotal`：当用户或 agent 明确过目标总数时，`frozenCount < userExpectedTotal` 即使 discovery 标成 complete，也必须要求继续发现或用户确认只采当前部分。

### 2.5 高风控页面默认被改到 agent tab

`ipc-handler.ts` 的 `startVisibleCollection()` 和 `startNoteCollection()` 都会 `ensureAgentTab()`，然后在 `agent-view` 上跑。这样可以不抢前台，但如果它在 agent tab 里直接裸跳详情 URL，依然会形成异常路径。

修订后的判断是：agent tab 本身不必废掉，关键是 agent tab 也要从列表页自然点击，不能直接 URL batch。

### 2.6 `allow_partial=true` 仍可被模型绕过

`browser_collect_notes` 对 partial source task 有保护：如果发现清单不完整，默认拒绝启动采集，除非传 `allow_partial=true`。

但现在这个布尔值仍由模型传入。只要模型说 `allow_partial=true`，代码无法证明用户真的明确同意“只采当前部分”。这会让“数量合同”从硬合同退化成 prompt 纪律。

### 2.7 验证暂停没有投影成稳定可继续卡片

当前 note collect 遇到验证会进入 `waiting_human / paused_verification`，这比直接失败更正确。但投影层把 paused 写成 `recoverable_paused` 且 `waitingFor='none'`，没有把“等待用户扫码/验证”和“继续同一个 browser-task”作为稳定动作投给 UI。

counterplan 的补充是准确的：`publicNoteCollectStatus` 已经能算出 `paused_verification`，但链路有两跳：runner status → `BrowserTaskProjectionInput` → `TaskProjectionRecord` → renderer view model。只在第一跳加字段可能在第二跳被磨平成 `recoverable_paused / waitingFor='none'`。S0/S1a 的测试必须断言最终聊天卡片可见状态，而不是只断言中间输入。

### 2.8 候选识别太浅，导致标题和图片来源混乱

当前目标识别主要从 `article / section / li / .card / [class*=card] / [class*=post] / [class*=feed]` 等通用容器里找第一个链接、标题、摘要、图片。现实信息流里，一个卡片附近常有作者、头像、推荐入口、视频标识、二级链接。

因此冻结清单会混入：

- 作者名当标题。
- 头像图当媒体。
- 推荐卡/导航入口当目标。
- 视频笔记被当图片笔记。
- 详情页标题被推荐标题覆盖。

修订后的最短路径是：卡片标题只做候选展示，详情页标题才是命名权威源。

---

## 3. Matrix 借鉴点

Matrix 解包材料里最值得吸收的不是“部门制”，而是浏览器工作方式。

### 3.1 两种操作家族，而不是一条路跑到底

Matrix `browser-skill.md` 把浏览器能力分成：

| 家族 | 适合场景 | Ready 应吸收的点 |
| --- | --- | --- |
| `browser.script.run` | DOM 稳定、结构化、可重复检查、本地验证 | 用代码/DOM 做可验证的读取和保存 |
| `browser.task.message` | DOM 不稳定、视觉路径更清楚、脚本检测强、需要人类浏览式操作 | 只委托一个边界清晰的小步骤 |

它明确要求：不要把整个任务交给 Browser Agent；只让它做一个清晰步骤，然后调用方继续掌控。

Ready 当前刚好反过来：它把整批采集交给后台 URL loop，而没有在每一步根据页面状态选择策略。

### 3.2 观察 → 动作 → 验证

Matrix 的浏览器纪律是：

1. 先观察当前页面。
2. 从最新 DOM snapshot 或截图里定位。
3. 只做一个小动作。
4. 动作后用最便宜的方式验证结果。
5. 页面状态变了再重新 snapshot。

Ready 的 `card_loop` v1 应先用 DOM/URL 断言实现这套纪律：定位卡片、点击、验证详情 sourceId、采集、返回、验证列表。视觉模型判断作为后续增强，不进本轮 v1。

### 3.3 Matrix 的弱点也不能照搬

Matrix 使用共享持久浏览器，`taskId` 不是页面锁，也不是并发锁。它的 prompt 纪律很强，但不等于工程上完全隔离。

Ready 不能照搬“共享浏览器 + prompt 纪律”。Ready 应该把 Matrix 的操作模式吸收进代码合同：

- 策略由模型声明，代码记录和否决。
- 每步状态由 checkpoint 保存。
- 每步验证失败不能继续假装完成。
- 高风控页面默认不要整批交给模型或 URL loop。

---

## 4. 根因分层

### L0：产品语义层

用户说的“采集这个账号的笔记图片”，实际包含三个不同目标：

1. 找到完整或当前批次的目标清单。
2. 逐篇进入内容详情并保存图片。
3. 归档成可检查、可续跑、可报告的结果。

Ready 当前把三者拆成不同任务，并且 UI 没有把它们聚合成一张真实采集卡。

如果用户直接粘贴一组 URL，则可以跳过“发现列表”这个动作，但不能跳过“冻结清单”这个合同。运行时应从当前会话用户消息里校验 URL provenance，并且必须创建一个 synthetic `visible_collect` source task 记录作为 jobId；不能用“等价清单”绕过 taskId/source_task_id 聚合合同。synthetic source task 没有真实列表上下文，只支持 `url_batch`，不支持 `card_loop`。若目标域高风控，则必须先取得 `HighControlUrlBatchDowngradeConsent`。

### L1：执行策略层

当前只有“链接批处理”这条主路径。它没有明确区分：

- `card_loop`：在列表上逐张点开、采集、返回。
- `url_batch`：逐个 navigate 到详情 URL。
- `list_only`：只发现清单，不进入逐篇采集；它不是 `browser_collect_notes.strategy`。

验证墙、用户接管、预算耗尽不是策略，是任务状态和 pause reason。

### L2：目标清单层

冻结清单只保存 URL/title/sourceId，不保存“怎么在当前列表上重新找到这个卡片”。这让 resume 和 detail collect 只能靠 URL 跳转。

本轮只补最小字段：

- `stableHref`
- `order`
- `sourceId`
- `kind?: 'content' | 'video'`
- `excludedReason?`

不持久化易过期的 bounds/viewport 几何信息；坐标点击需要的 bounds 在执行时实时重定位。

### L3：单篇动作层

单篇采集没有“定位卡片 → 点击卡片 → 验证详情 → 保存 → 返回/关闭 → 验证列表”的状态机。它只有“navigate 到详情 URL”。

### L4：任务投影层

发现、采集、验证暂停、输出报告不是一个 UI 聚合视图。UI 只能显示多个松散 projection，导致卡片错位、消失、假完成。

### L5：输出归档层

命名和保存已经有所改善，但仍依赖前面给出的标题和图片。如果前面的目标识别错了，输出层只能把错误稳定保存下来。目录命名应延迟到详情页标题确认后；详情失败或零图片进入 `_failed/`，不建普通成功目录。

---

## 5. 目标架构

### 5.1 任务模型：发现任务 taskId 就是 jobId

不新建 `CollectionJob` store/service。现有任务链路已经有天然 job 关系：

```
visible_collect 任务（taskId = jobId）
  └─ 产出：冻结清单 + discoveryStatus + hasMoreLikely + outputRootDir
       │
       ▼
note_collect / card_loop 任务（payload.source_task_id = jobId）
  └─ 产出：每篇结果 + cursor checkpoint + 终态
```

投影层按 `source_task_id` 聚合成一张采集卡：

- `已发现 N（可能还有更多）`
- `已保存 X，失败 Y，剩余 Z`
- `等待验证 / 部分完成 / 已完成 / 失败`

发现阶段单独存在时，卡片只显示发现行，绝不显示 `N/N 完成`。

同一个 jobId 可能有多次后续采集：先采当前部分，用户确认后又采剩余部分。聚合时必须按 `sourceId` 去重累加 saved/failed，不能简单把多个 child task 的计数相加。

### 5.2 策略：模型声明 + 代码不对称否决

逐篇采集策略收敛为两种：

| 策略 | 含义 | 风险 |
| --- | --- | --- |
| `card_loop` | 在列表上逐张点开 → 采集 → 返回 | 中 |
| `url_batch` | 逐个 navigate 到详情 URL | 普通站点低，高风控高 |

`list_only` 是 `browser_visible_collect` / 发现阶段，不进入 `browser_collect_notes.strategy` 枚举。

路由合同：

1. 模型在发起采集时声明 `strategy`。
2. 声明 `card_loop` 合法，但只有在 `card_loop` task kind 已注册时才可真正启动。
3. 声明 `url_batch` 必须有代码可验证条件：目标域不命中高风控信号，且 URL 列表来自用户原文或非登录态普通列表发现。
4. 未声明时，代码保守默认：高风控信号命中 → `card_loop`；否则 → `url_batch`。
5. prompt 规则改写：不再说“逐个点开也必须走 browser_collect_notes”；改为“除用户直接提供 URL 列表外，多篇采集必须先 browser_visible_collect 冻结清单，再按声明 strategy 接力；用户要求逐张点开时声明 `card_loop`”。
6. 用户直接贴 URL 列表时可跳过真实页面 visible_collect，但必须从当前会话用户消息中校验 URL 原文包含关系，并创建 synthetic source task；synthetic source task 只允许进入 `url_batch`。
7. S2 中间态必须有 capability gate：`card_loop` runner 未注册时，高风控默认 `card_loop` 只返回结构化 `card_loop_not_ready`，不启动 `url_batch`。如果产品要在 S2 后继续支持高风控采集，必须同批落 S3，或要求用户确认降级。
8. `browser-collection-intent.ts` 只负责工具曝光和高风控保守信号，不升格为自然语言语义路由器。

### 5.3 `card_loop` 执行器

`card_loop` 是 `content-task-runner` 里与 `note_collect` 平级的新任务 kind，复用：

- `browser_tasks` 持久化。
- checkpoint_json。
- agent-view lease。
- ScopedBrowserFacade。
- projection sink。
- 自定义预算与可恢复暂停。

单篇状态机：

```
relocate_card
open_card
verify_detail
collect_detail
write_result
return_list
verify_return
checkpoint
```

每步规则：

- `relocate_card`：用 stableHref/sourceId 在当前列表重定位目标卡片；找不到则受限滚动重试，仍无则单篇 failed(card_not_found)。
- `open_card`：优先使用 trusted 坐标输入；具体实现先 spike 证伪。
- `verify_detail`：断言 URL/DOM 中含目标 sourceId；不符则关闭/返回并标记该篇失败。
- `collect_detail`：读详情标题、正文、图片；详情标题是目录命名权威源。
- `write_result`：写 `note.md / manifest.json / assets`，失败项进入 `_failed/`。
- `return_list`：支持 `close_modal` 和 `history_back`。
- `verify_return`：确认回到列表容器，下一目标可重定位。
- `checkpoint`：cursor、scrollY、失败原因、已写文件落盘。

验证墙命中进入 `waiting_human(verification)`；恢复后保持原 strategy，不退回 `url_batch`。

### 5.4 `url_batch` 保留但降级

`url_batch` 继续服务普通站点和用户明确给出的 URL 列表，不作为高风控信息流默认路径。

在高风控页面上，如果模型声明 `url_batch`，代码应返回结构化拒绝原因，并提示改用 `card_loop`。

如果 `card_loop` spike 失败、暂未注册，或 source task 是用户直接 URL 列表生成的 synthetic source task，需要允许用户明确确认降级为低频 `url_batch`。这不是普通 `allow_partial`，而是独立的 `HighControlUrlBatchDowngradeConsent`：记录 scope、sourceTaskId、目标域、确认时间和风险提示文案。没有该记录，高风控 `url_batch` 仍必须被拒绝。

### 5.5 `list_only` / 脚本结构化模式保留

普通网页、DOM 稳定页面、本地 fixture 仍应优先用结构化脚本读取。`list_only` 负责只发现目标和冻结清单；后续是否进入 `card_loop` 或 `url_batch` 由策略和用户目标决定。它不作为逐篇采集策略传给 `browser_collect_notes`。

---

## 6. 接口增量

### 6.1 冻结清单增量

在现有 note candidate / collection target 上增量，不新建一套复杂类型体系：

```ts
interface FrozenTargetDelta {
  stableHref: string
  order: number
  sourceId: string
  kind?: 'content' | 'video'
  excludedReason?: string
}
```

过滤只做四条可验证规则：

1. 无 stableHref 指向详情的容器不进清单。
2. avatar/author/profile 链接或容器不进清单。
3. nav/login/notification 语义不进清单。
4. video 项标记 `kind: 'video'`，由策略决定跳过或另行处理。

### 6.2 投影增量

```ts
interface BrowserTaskProjectionInputDelta {
  jobId?: string
  publicStatus?: 'paused_verification' | 'partial' | 'completed' | 'failed' | 'cancelled'
  waitingFor?: 'verification' | 'background' | 'none'
  discovered?: number
  userExpectedTotal?: number
  saved?: number
  failed?: number
  remaining?: number
  hasMoreLikely?: boolean
  resumableActions?: Array<{ name: 'browser_resume_task'; taskId: string }>
}
```

关键是 `discovered` 和 `saved/completed` 分离。UI 不得再把发现数渲染成保存完成数。若 `userExpectedTotal` 存在且 `discovered < userExpectedTotal`，UI 必须显示清单未达用户声明数量，不得渲染为完整发现。

旧字段不能双轨并行。对浏览器采集类 kind（`visible_collect` / `note_collect` / `card_loop`）的投影，现有 `progress.total / progress.completed / progress.failed` 必须统一重定义：

| 字段 | 新语义 |
| --- | --- |
| `progress.total` | 已发现/冻结数量，即 discovered |
| `progress.completed` | 已保存成功数量，即 saved；仅发现阶段必须为 0 |
| `progress.failed` | 已失败数量 |

这些采集类 kind 的所有写入点都要按新语义改写；renderer 不允许一部分读新字段、一部分继续读旧 `completed=total` 语义。其他非采集任务 kind 的进度语义不在本计划内重定义。

### 6.3 card_loop checkpoint

```ts
interface CardLoopCheckpoint {
  cursor: number
  scrollY?: number
  lastVerifiedAt: string
  failureBySourceId: Record<string, string>
  strategy: 'card_loop'
}
```

不持久化 bounds / viewportIndex / snapshotHash。几何信息只能作为执行时实时观察结果，不能当恢复依据。

`content-task-runner` 没有 child-driver 的 24-action 分段机制；`card_loop` 必须定义自己的预算：

- 单篇步骤上限。
- 整任务 maxNotes / maxDurationMs。
- 连续失败上限。
- 总下载量上限。
- 预算耗尽进入可恢复暂停，不把工作弹回当前 agent turn 里循环消耗轮次。

### 6.4 部分采集确认

```ts
interface PartialCollectionConsent {
  scopeId: string
  sourceTaskId: string
  confirmedVia: 'ask_user_questions' | 'ui_action'
  confirmedAt: string
}
```

`allow_partial` 模型参数不再放行，只能作为提示位。真正放行必须查到同 scope、同 sourceTaskId 的持久确认。

确认不能靠解析模型写出的反问文案。拒绝启动采集时，runtime 先创建一条 pending consent request：

```ts
interface PendingCollectionConsentRequest {
  requestId: string
  scopeId: string
  sourceTaskId: string
  consentKind: 'partial_collection' | 'high_control_url_batch_downgrade'
  createdAt: string
  expiresAt?: string
}
```

反问卡和 UI 按钮都从这条 pending request 派生，并携带 `requestId / consentKind`。用户选择后由 renderer/IPC 直接写 consent 记录，不经过模型复述，也不解析问题文本。

落点要求：

- 存储走 SQLite-backed store，字段包含 `scopeId/sourceTaskId/confirmedVia/confirmedAt/consentKind`。
- `ask_user_questions` 只负责展示由 pending request 派生的结构化选项；回答带 requestId 回来后由 agent-control/IPC 按 requestId 写入。
- UI 按钮路径必须补齐 Main IPC、Preload API、Renderer 类型声明、组件、行为测试和文档。
- `deleteByScope` 或会话清理时，要清理同 scope 的未完成确认记录，避免跨会话误用。

### 6.5 高风控 URL 批处理降级确认

```ts
interface HighControlUrlBatchDowngradeConsent {
  scopeId: string
  sourceTaskId: string
  targetHost: string
  confirmedVia: 'ask_user_questions' | 'ui_action'
  warningText: string
  confirmedAt: string
}
```

没有这个确认，高风控 `url_batch` 不得启动。该确认只能在 `card_loop` 不可用、spike 失败或用户明确要求降级时出现。

### 6.6 用户声明数量与 URL provenance

```ts
interface CollectionRequestProvenance {
  scopeId: string
  userExpectedTotal?: number
  pageExpectedTotal?: number
  userProvidedUrls?: string[]
  sourceMessageIds: string[]
}
```

要求：

- `userExpectedTotal` 作为 `browser_visible_collect` 工具参数传入，由模型从对话中抽取，可空；一旦存在，就参与 visible_collect 完整性判断。
- `pageExpectedTotal` 可选来自页面元信息，例如账号主页显示的笔记数。若能稳定读取，应作为第二来源参与完整性判断；若两个来源都没有，验收“账号没到底必须显示不完整”只覆盖达到批次/时间/轮次上限或 hasMoreLikely 的场景。
- 用户直接贴 URL 列表时，runtime 必须对照当前会话用户消息文本和用户显式选择的会话资源做 provenance 校验，校验通过后才能构造 synthetic source task。
- provenance 校验位点建议在 `browser-tools.ts` 的 `browser_collect_notes` 入口或其前置 normalize 层，不能只靠 prompt。

### 6.7 低频策略

高风控降级 `url_batch` 和 `card_loop` 默认使用可测的节流策略：

```ts
interface BrowserCollectionThrottlePolicy {
  minDetailIntervalMs: number
  jitterMs: [number, number]
}
```

默认建议：`minDetailIntervalMs >= 3000`，`jitterMs = [800, 2200]`。测试至少断言相邻详情打开的间隔不低于 `minDetailIntervalMs`。

---

## 7. 前置技术验证

`card_loop` 的成败取决于两个技术点，先做 spike，再全面施工。

真实高风控样本验证必须使用用户知情同意的账号；命中验证墙立即暂停，不连续重试。

### 7.1 trusted 点击

验证目标：

- 在 BrowserView / agent tab 上用 `webContents.sendInputEvent` 做坐标点击。
- 对照 JS `element.click()`。
- 在本地 fixture 和一个真实高风控样本上观察详情是否正常打开、事件是否更接近真实用户输入、是否更容易触发验证。

spike 结论决定 `open_card` 的实现方式。

### 7.2 返回路径

验证目标：

- modal 关闭与 `history.back` 两种 returnStrategy。
- 列表滚动位置是否保留。
- 虚拟列表是否重排。
- 下一目标是否能重新定位。

spike 失败不等于计划失败。退化方案是用户明确确认后的 `url_batch + 更低频 + 验证友好暂停`，但必须写入 `HighControlUrlBatchDowngradeConsent`，并且不能再说它等价于“逐张点开”。

---

## 8. 工作包

### S0 — 对账与合同测试

先把当前错误行为写成失败测试。

内容：

- 对账当前未提交 diff：`prompt-assembly.ts` 的“逐个点开也必须走采集器”强化行在 S1a 期间暂时保留；S2 改写 prompt 时删除并替换为 strategy 声明规则。
- 对账 `TaskToolSnapshot.tsx` 和 `task-bottom-background-selection.test.ts`，避免 UI 卡片修复重复施工。
- 失败测试覆盖：
  1. 发现 30 条时投影不得出现保存完成形态。
  2. `waiting_human` 必须以 `waitingFor: 'verification'` 到最终 renderer 可见卡片，不只到 `BrowserTaskProjectionInput`。
  3. partial discovery + 无确认记录时，`browser_collect_notes` 拒绝；模型传 `allow_partial=true` 也拒绝。
  4. `frozenCount < userExpectedTotal` 时即使 discoveryStatus 是 complete，也必须要求继续发现或用户确认。
  5. 高风控域 + `strategy: 'url_batch'` 拒绝；`strategy: 'card_loop'` 在 runner 已注册时接受，未注册时返回 `card_loop_not_ready`。
  6. 用户直接提供 URL 列表时可跳过 visible_collect，但 runtime 必须校验 URL 来自用户消息原文或用户显式选择的会话资源。
  7. 租约丢失转可恢复暂停，resume 重新获取租约。
  8. 长采集必须是后台 runner，不消耗当前 agent turn 轮次。

验收：

- 失败测试先红。
- 不用 source-grep 冒充行为验证。

### S1a — 纯止谎与状态映射

零持久化新实体，先解决用户最明显的误导和错误终态。

内容：

1. `projectVisibleCollect` / summary：`discovered` 与 `saved/completed` 分离，`hasMoreLikely` 进文案。
2. `BrowserTaskProjectionInput` 增加 public status / waitingFor，并同步修改 TaskProjectionRecord 映射和 renderer view model，确保 `paused_verification` 最终在聊天卡片可见。
3. 浏览器采集投影旧字段统一改语义：`total=discovered`、`completed=saved`、`failed=failed`，发现阶段 `completed=0`。
4. lease_lost 终态重映射：现有 visible_collect / note_collect 的 lease_lost 不写成 completed/failed/cancelled，而是可恢复暂停；S3 新增 card_loop 时沿用同一映射，resume 重新获取租约后从 checkpoint 继续。

验收：

- 用户问题 2、6 的复现脚本转绿；用户问题 1 的“显示不再误导”部分转绿，静默缩水 gate 留到 S1b 验收。
- `npm run typecheck`。
- 相关行为测试通过。

### S1b — 合同硬化与持久确认

涉库，承接用户确认、用户声明总数和 URL provenance。

内容：

1. `PartialCollectionConsent` 持久化，`browser_collect_notes` 改查确认记录，不再信模型 `allow_partial`。
2. `HighControlUrlBatchDowngradeConsent` 持久化，高风控降级 url_batch 必须查到该记录。
3. `userExpectedTotal` 作为 `browser_visible_collect` 工具参数进入 visible collect 结果和投影；冻结数小于用户声明总数时显示未完整并触发继续/确认 gate。
4. 用户直接贴 URL 列表时创建 synthetic source task，并记录 URL provenance。
5. consent 写入通过 pending request 的 requestId / consentKind 完成，不解析模型问题文本。

验收：

- partial discovery + 无确认记录时拒绝；有确认记录时放行并在报告里标注部分采集。
- `userExpectedTotal` 小于冻结数缺口时触发 gate。
- 高风控 synthetic source task 无降级确认时拒绝，有确认时放行进入 strategy gate；低频节流断言留给 S2。
- `npm run verify:native` 无条件通过。

### S2 — 投影聚合 + strategy 合同

内容：

- 投影按 `source_task_id` 聚合一张采集卡，两行进度：发现 / 保存。
- `browser_collect_notes` 增加 `strategy` 参数和不对称否决逻辑。
- 结构化拒绝错误写入工具输出和日志。
- prompt 规则改写：除用户直接提供 URL 列表外，多篇采集先冻结清单，再按 strategy 接力；用户要求逐张点开时声明 `card_loop`。
- 用户直接贴 URL 列表时构造 synthetic source task，并记录 URL provenance。
- 高风控 S2 中间态启用 capability gate：`card_loop` 未注册时返回 `card_loop_not_ready`；不允许既拒绝 `url_batch` 又假装启动 `card_loop`。
- 高风控低频启动必须带 `BrowserCollectionThrottlePolicy`。
- 7.1/7.2 spike 并行启动。

验收：

- 普通站点 `url_batch` 回归不破。
- 高风控 + 未声明策略在 runner 已注册时默认 `card_loop`；runner 未注册时返回 `card_loop_not_ready`。
- 高风控 + `url_batch` 无降级确认时返回结构化拒绝；有降级确认时低频启动并标注风险。
- fixture 上“逐张点开”意图声明并接受 `card_loop`。
- 历史 stale 任务过滤与 6/5 任务卡 dwell/settle 语义对账，不让旧任务重启后挤住聊天面板。

### S3 — card_loop runner

内容：

- 新增 `content-task-runner` task kind：`card_loop`。
- 复用 lease/checkpoint/projection；预算耗尽走可恢复暂停，不借用不存在的 24-action 分段机制。
- 冻结清单增加 `stableHref/order/kind`。
- 四条候选过滤规则落地。
- 单篇状态机：relocate/open/verify/collect/write/return/verify/checkpoint。
- 目录命名延迟到详情标题确认。
- 零图片或详情失败进入 `_failed/`。
- video 默认处置：v1 跳过并写入 skipped/video，不采封面；后续另做视频策略。

验收：

- 本地 50 卡片 fixture：逐张点开、保存、返回、下一张，最终 50/50。
- modal 详情、新页详情、点击后卡片消失、返回失败、验证墙模拟都状态正确。
- 单篇失败不污染成功目录。
- 中断后 `browser_resume_task` 从 cursor 续跑且保持 `card_loop`。

### S4 — 验证暂停闭环 + 输出归档

内容：

- 验证墙 → `waiting_human(verification)` → 用户完成 → “继续” → 同 jobId 同 strategy 续跑。
- 连续验证墙只暂停，不连续硬试。
- 同 jobId 多次采集按 sourceId 去重聚合 saved/failed。
- 成功目录统一：`序号 - 标题/note.md/manifest.json/assets/*`。
- 手动补救调用同一 note writer，回填原目标结果。
- 根目录生成 `collection-manifest.json` 和 `采集报告.md`。

验收：

- paused verification 卡片稳定显示并带 resume 动作。
- 用户验证完成后从同一 job 继续。
- 成功、失败、重名、无标题、零图片、手动补救都有稳定结构。
- 不再出现孤立的 `门主/门主_-1.webp` 这类目录。

### S5 — 真实验证和回归

验证顺序：

1. 单元/行为测试：projection、partial consent、strategy denial、candidate filtering、card_loop。
2. 本地 fixture：120 卡片、混杂页面、modal 详情、分页/懒加载、验证墙模拟。
3. 输出结构测试：manifest/report/assets。
4. `npm run typecheck`。
5. `npm run verify:native`。
6. `git diff --check`。
7. Ready app 实测：先本地 fixture，再用 Aoi/小红书作为现实样本之一。

现实样本验收只证明通用能力，不允许写 Aoi 或博主名特例。

---

## 9. 与上一版计划的映射

| 上一版 | 修订版 | 处理 |
| --- | --- | --- |
| WP0 合同先行 | S0 | 保留，增加租约、轮次、工作区对账 |
| WP1 CollectionJob 父任务 | S1a/S2 投影聚合 | 替代，不建新实体 |
| WP2 Mode Router | S2 strategy 声明 + 代码否决 | 替代，不让代码解析自然语言 |
| WP3 card-aware manifest | S3 最小冻结清单增量 | 收缩，去掉复杂置信度体系 |
| WP4 visible_card_loop | S3 + spike | 保留核心，v1 不引入视觉模型 |
| WP5 脚本模式 | S2/S5 | 保留为 list_only/url_batch 的安全路径 |
| WP6 验证暂停续跑 | S1a/S4 | 提前投影，后做闭环 |
| WP7 输出归档 | S4 | 保留，命名延迟到详情 |
| WP8 UI 稳定化 | S1a/S2 | 与当前 in-flight UI 改动对账后合并 |
| WP9 回归 | S5 | 保留 |

---

## 10. 非目标

1. 不做万能爬虫。
2. 不绕过平台验证。
3. 不硬编码 Aoi、博主名、固定数量、固定目录。
4. 不把所有任务都交给视觉 agent。
5. 不把所有任务都改成脚本模式。
6. 不把 Matrix 的共享浏览器弱点照搬进 Ready。
7. 不新建与 `browser_tasks` 平行的采集任务实体或状态机。
8. 不把 `browser-collection-intent.ts` 升格为语义意图路由器。
9. 不在 v1 `card_loop` 里引入视觉模型判断。
10. 不持久化卡片几何信息作为恢复依据。

---

## 11. 风险与取舍

### 11.1 card_loop 会慢

这是有意取舍。高风控页面追求稳定和可继续，不追求最快。普通页面仍可用 `url_batch` 或脚本结构化。

### 11.2 trusted 点击可能不成立

这就是前置 spike 的原因。如果 `sendInputEvent` 在真实站点上不可行，`card_loop` 需要退化或改策略；不能在没有验证的情况下把它写成已可施工。

### 11.3 高风控识别会漏

高风控清单只能做保守兜底。漏判时，验证墙命中必须快速暂停并记录，而不是持续硬试。

### 11.4 投影聚合要兼容既有 dwell/settle

当前任务卡已有 background dwell / settle 逻辑。S1a/S2 必须沿用，不另起一套 timer。

### 11.5 `ask_user_questions` 每轮一次

partial 确认可能和其他反问竞争。冲突时退化到 UI 卡片按钮路径。

---

## 12. 验收标准

这轮真正完成时，应满足：

1. 用户要求逐张点开时，不再硬跳详情 URL。
2. 发现 N 条时，投影中 discovered 与 saved/completed 是独立字段，任何状态下不得把发现数渲染成保存完成数。
3. 账号没到底时必须显示清单不完整。
4. partial discovery 只有用户持久确认后才能继续采集。
5. 验证墙或 lease_lost 暂停后，用户恢复可以继续同一个 jobId、同一个 strategy。
6. 每篇保存结果结构统一，失败清楚列出。
7. 子任务卡稳定，不遮挡聊天面板，不突然丢失可继续任务。
8. strategy 的接受/拒绝必须返回结构化 reason 并落日志，可在测试中断言。
9. 本地 fixture 和真实样本都通过。

---

## 13. 建议施工顺序

建议按这个顺序推进：

1. S0：对账当前未提交 diff，写失败测试。
2. S1a：先止谎，修发现/保存进度、验证投影、lease_lost 可恢复暂停。
3. S1b：落持久确认、userExpectedTotal、URL provenance。
4. S2：策略声明和代码否决，聚合成一张采集卡。
5. 7.1/7.2：并行做 trusted 点击和返回路径 spike。
6. S3：spike 通过后实现 card_loop runner。
7. S4：验证暂停续跑和输出归档闭环。
8. S5：完整回归和 Ready app 现实样本验证。

这个顺序的原则是：先停止误导和错误放行，再上更稳的执行路径，最后收口归档和现实样本。
