---
title: 浏览器采集修正反提案：先止谎、复用现有合同、不对称模式声明
date: 2026-06-06
status: counterproposal
owner: 白
author: Claude（独立审查）
enforce: false
counter_to: docs/superpowers/plans/2026-06-06-browser-collection-mode-router-and-visual-loop-implementation.md
related:
  - AGENTS.md §0（简单优先、手术式改动、模型只做判断题）
  - AGENTS.md §0.5（先合同后代码、修根因、跨边界状态显式建模）
  - docs/superpowers/plans/2026-06-04-agent-browser-visible-crawler-implementation.md
  - docs/superpowers/plans/2026-06-04-browser-collection-subagent-implementation.md
  - docs/superpowers/plans/2026-06-05-chat-side-collection-task-indicator-implementation.md
references_verified:
  - src/main/modules/agent-control/prompt-assembly.ts
  - src/main/modules/tools/browser-tools.ts
  - src/main/modules/tools/schemas/browser-content-schemas.ts
  - src/main/modules/browser-engine/ipc-handler.ts
  - src/main/modules/browser-engine/content-task-runner.ts
  - src/main/modules/browser-engine/browser-collector-actions.ts
  - src/main/modules/browser-engine/capability-service.ts
  - src/main/modules/browser-engine/capability-types.ts
  - src/shared/browser-collection-intent.ts
---

# 浏览器采集修正反提案

> 本文是对《浏览器采集模式路由 + 可见卡片循环修正计划》（下称"原计划"）的独立审查与反提案。
> 审查方式：逐条核实原计划 §2 的八条代码证据（全部属实或基本属实），重读 6/4、6/5 三份前置计划与两份 Matrix 规格，并对照工作区当前未提交改动。
> 结论：**诊断认同，处方反对一半。** 原计划对根因的定位准确，但它的解法引入了过多平行新实体、把语义判断错放进代码路由、把状态和策略混在一个枚举里，并且施工顺序把最便宜的"止谎"修复压在了最贵的新架构后面。

---

## 0. 一句话

原计划的核心病灶诊断成立：**执行层只有"URL 批处理"一条主路径，且进度语义在向用户说谎**。但修法不需要 12 状态的 CollectionJob 新实体、4 模式枚举和代码侧自然语言意图解析——现有的 `sourceTaskId` 链路、`browser_tasks` 状态机、checkpoint、projection sink 和 `browser-collection-intent.ts` 已经覆盖了所需合同的大半。反提案的路线是：**先用三个零新实体的手术修让系统停止说谎，再用"模型声明模式 + 代码不对称否决"接管路由，最后以一个新任务 kind（card_loop）的形式落地点击式采集循环。**

---

## 1. 对原计划的审查结论

### 1.1 证据核实（全部对照工作区当前代码）

| 原计划证据 | 结论 | 关键事实 |
| --- | --- | --- |
| §2.1 prompt 强制路由 | 属实，且工作区未提交改动**正在强化它** | `prompt-assembly.ts:161`（工作区新增行）明确"逐个点开…也必须走 browser_visible_collect → browser_collect_notes" |
| §2.2 单篇硬跳 URL | 属实 | `browser-collector-actions.ts:355-468`：navigate → read → extract → images → download → write，无点击/返回/验证 |
| §2.3 30/30 是发现进度 | 属实 | `content-task-runner.ts:330` 投影里 `completed: total`（都是已发现数）；`:95-99` no_new_content → 'complete' |
| §2.4 max_items 成硬批次 | 基本属实，但**部分低估了现状** | `discoveryStatus / hasMoreLikely / suggestedContinueTool / continueTaskId` 已存在（`content-task-runner.ts:103-111`），"批次 vs 全量"在数据层有标记，缺的是 UI 投影和下游强制 |
| §2.5 默认 agent tab | 属实 | `ipc-handler.ts:736-751, 871-897` 均 `ensureAgentTab()`，无复用用户 tab 路径 |
| §2.6 allow_partial 可绕过 | 属实 | `browser-tools.ts:4327` `args.allow_partial === true`，纯模型参数，无用户确认环节 |
| §2.7 验证暂停投影不稳 | 属实，根因更精确 | `publicNoteCollectStatus`（`content-task-runner.ts:153-157`）**已正确算出** `paused_verification`，但 `BrowserTaskProjectionInput`（`:48-57`）**没有承载它的字段**，UI 只收到泛化 'paused' |
| §2.8 候选识别太浅 | 属实 | `capability-service.ts:183-257`：通用容器选择器 + 取第一个 `a[href]`，无 avatar/author/recommend/video 过滤 |

### 1.2 同意的部分

1. 根因分层 L0–L5 成立，特别是"发现≠保存"的进度语义污染和"URL 批处理是唯一主路径"。
2. "观察 → 小动作 → 验证 → checkpoint → 下一步"作为采集纪律。
3. WP0 失败测试先行。
4. 非目标清单（不做万能爬虫、不绕过验证、不硬编码站点特例）。
5. fixture 先行、真实样本只做能力证明。

### 1.3 反对的部分（逐条）

**R1：CollectionJob 新实体是平行建制，违反"简单优先"。**
原计划 §5.1 提出 12 状态父任务实体。但 `visible_collect` 任务产出 `sourceTaskId`，`note_collect` 通过 `source_task_id` 消费它（`browser-tools.ts:4313-4316`）——**发现任务的 taskId 就是天然的 jobId**。父子关系已存在于数据层，缺的只是：① 投影层把这对任务聚合成一张卡；② 数量合同在交接点被强制。为此新建一个带自己状态机的实体，会制造第二套任务层级，正是 6/5 投影计划警告过的"两套系统状态转移冲突"。原计划 §5.1 的 12 个状态里至少 5 个是可推导的（discovery_partial/discovery_complete 即 discoveryStatus；三种 paused 是同一状态加 reason 字段）。

**R2：代码解析自然语言意图选模式，违反"模型只做判断题"的分工，且方向用反了。**
原计划 WP2 要求路由服务"解析用户意图里的低频、逐张、当前页面、完整账号等信号"。这是语义分类，按本仓库红线应交给模型；代码该做的是**强制**而非**理解**。关键字匹配做语义路由（`browser-collection-intent.ts` 现状）只能当保守兜底，把它升格为唯一裁决者会在表达变体上系统性漏判。正确的分工见 §3.2 的"不对称声明"。

**R3：manual_assisted 不是模式，是状态。**
原计划把它列为第 4 种执行模式。验证墙暂停可以发生在任何执行策略中，它是 `browser_tasks` 状态机里已有的 `waiting_human`（`capability-types.ts:78-85`），不是一种"采集方式"。把 state 混进 strategy 枚举会让模式路由和状态机互相污染。

**R4：可见卡片循环的可行性问题被一笔带过。**
原计划 WP4 是全计划最高风险项，却没有回答：
- 点击如何产生？注入 JS 的 `element.click()` 是 untrusted event，高风控平台可检测；基于坐标的 `sendInputEvent` 才接近真实输入，但 `cardBounds` 在懒加载/虚拟列表下会失效，需要"重定位 → 再点击"策略。
- "Validate Card / Verify Detail" 由谁判断？原计划 §9.2 说视觉 agent 只做单步判断，但没有说何时调用、谁付预算、判断错了怎么办。
- 实际上 v1 **完全不需要视觉模型**：点击后比对 URL/DOM 中的 sourceId、返回后校验列表容器仍在、cursor 卡片可重定位——全部 DOM 可验证。"可见"（用户看得到）≠"视觉"（要截图给模型看）。原计划把两者混在"视觉操作模式"一个词里。

**R5：施工顺序把最便宜的修复压在最贵的架构后面。**
三个修复零新实体、当天可落、直接消除用户问题 1/2/6 的大半：
1. 投影不再把"已发现"写成"已完成"（改 `projectVisibleCollect` 和 summary 文案）。
2. `BrowserTaskProjectionInput` 增加 `publicStatus/waitingFor` 字段，让已算出的 `paused_verification` 走到 UI。
3. `allow_partial` 改为查 runtime 持久确认记录，不再信模型布尔参。

原计划把它们埋进 WP1/WP6，前置依赖 CollectionJob 实体——等于让"停止说谎"等待"重新建政"。

**R6：标题/归档问题的最短路径被绕过了。**
原计划 WP3 设计了 titleConfidence 四档 + titleSource 五源 + kind 七类。但"作者名当标题、怪文件夹名"的最短修复是：**详情页是标题的权威源，目录命名延迟到详情采集成功之后**；卡片级标题只是候选展示用。卡片过滤只需做到"不把头像/导航当内容卡"，不需要一套置信度体系。

**R7：两条用户问题没有 WP 承接。**
- 问题 9（租约/锁定错误打断任务）：无任何 WP 提及。续跑必须重新获取租约、租约冲突应产生可恢复暂停而非失败——这要进合同测试。
- 问题 8（轮次耗尽）：`21e6e1b3` 已把 max-turn 耗尽改为可继续，但原计划没有规定"长采集不消耗 agent 轮次"这一边界（后台 runner 模式天然满足，应写成合同防回退）。

**R8：原计划与工作区在-flight 改动直接冲突，未做对账。**
工作区未提交的 `prompt-assembly.ts` 改动**新增**了"逐个点开也必须走采集器"的规则行，而原计划 WP2 要求**删除**这条规则。同时 `TaskToolSnapshot.tsx` 改动 + 新增 `task-bottom-background-selection.test.ts` 已部分覆盖 WP8。任何一版计划落地前必须先决定这批工作区改动的去留，否则测试会互相打架。

---

## 2. 反提案的设计原则

1. **先止谎，后建制。** 凡是"系统对用户陈述了不真实状态"的问题，用最小手术修，不等新架构。
2. **jobId := 发现任务 taskId。** 不新建实体；父子聚合在投影层完成；数量合同在 visible_collect → note_collect 交接点强制。
3. **不对称模式声明。** 模型声明执行策略（它有完整会话语境）；代码拥有否决权，且否决是单向的：**往更安全策略的声明直接接受，往更高风险策略的声明必须有代码可验证的条件支撑**（站点不在高风控清单、目标 URL 来自用户消息原文、或存在持久用户确认记录）。
4. **状态归状态机，策略归策略。** 验证墙、用户接管、预算耗尽是 `browser_tasks` 状态 + pause reason，不进模式枚举。
5. **DOM 可验证优先。** card_loop v1 的每步验证全部用 DOM/URL 断言；视觉模型判断作为显式延后的增强，不进本轮范围。
6. **详情页是内容权威源。** 标题、正文、媒体以详情页为准；卡片数据只用于定位和候选过滤。
7. **长采集不消耗 agent 轮次。** 执行永远是后台 runner（content-task-runner 任务 kind），agent 只负责发起、被动接收投影、处理暂停后的恢复指令。

---

## 3. 目标架构

### 3.1 任务模型：一对任务 + 投影聚合，不新建实体

```
visible_collect 任务 (taskId = jobId)
  └─ 产出: 冻结清单 manifest + discoveryStatus + hasMoreLikely
       │  （数量合同的锚点）
       ▼
note_collect / card_loop 任务 (payload.source_task_id = jobId)
  └─ 产出: 每篇结果 + checkpoint(cursor) + 终态
```

- 投影层按 `source_task_id` 把同一 jobId 的任务聚合成**一张采集卡**，分两行显示：
  `已发现 N（清单可能不完整）` / `已保存 X，失败 Y，剩余 Z`。
- 发现阶段单独存在时，卡片只显示发现行，**绝不显示 X/X 完成**。
- `browser_tasks` 不加 parent_id 列；jobId 已在 payload 链路里。如后续确实需要跨任务查询，再加索引列，本轮不做。

### 3.2 模式路由：模型声明 + 代码不对称否决

执行策略收敛为三种（替代原计划的四模式）：

| 策略 | 含义 | 风险级 |
| --- | --- | --- |
| `list_only` | 只在列表页提取，不打开详情 | 低 |
| `card_loop` | 在列表上逐张点开 → 采集 → 返回 | 中（新增，见 §3.3） |
| `url_batch` | 逐个 navigate 到详情 URL（现状 collectNote 路径） | 高（对高风控站点） |

路由合同（代码强制，写进 `browser_collect_notes` 入口）：

1. 模型在发起采集时声明 `strategy`。
2. **降险声明直接接受**：声明 `card_loop` 或 `list_only` 永远合法。
3. **升险声明需要证据**：声明 `url_batch` 必须满足全部——
   a. 目标域不命中高风控信号（复用 `isHighControlPlatformText` 等，作为保守兜底而非裁决者）；
   b. 目标 URL 列表来自用户消息原文，或来自非登录态列表页的发现结果。
   不满足则代码拒绝并返回结构化错误，提示改用 `card_loop`。
4. 未声明 strategy 时的默认值由代码决定：高风控信号命中 → `card_loop`；否则 → `url_batch`（保持现状行为，避免普通站点回归）。
5. prompt 规则同步改写：删除"逐个点开也必须走 browser_collect_notes（URL 批处理）"的强制语；改为"多篇采集必须先 `browser_visible_collect` 冻结清单，再以合适的 strategy 调 `browser_collect_notes`；用户要求逐张点开时声明 `strategy: 'card_loop'`"。
6. **工作区对账**：当前未提交的 prompt-assembly 强化行与本条冲突，落地本提案前先裁决该 diff 的去留。

`browser-collection-intent.ts` 的角色定位为：工具曝光 + 高风控保守兜底信号源。**不升格为语义路由器。**

### 3.3 card_loop：content-task-runner 的新任务 kind

不新建执行体系。`card_loop` 是 content-task-runner 里与 `note_collect` 平级的任务 kind，复用：持久化（`browser_tasks` + checkpoint_json）、租约（agent-view lease）、投影 sink、ScopedBrowserFacade、24-action 分段续跑语义。

单篇状态机（每步均为 DOM 可验证断言，失败 → 单篇 failed 跳过 / 验证墙 → waiting_human，绝不盲跑）：

```
relocate_card    在当前列表用 stableHref/sourceId 重定位目标卡片；
                 找不到 → 受限滚动重试 → 仍无 → 单篇 failed(card_not_found)
open_card        对卡片可点击区域发 trusted 输入事件（坐标点击，见 §5 spike）
verify_detail    断言 URL/DOM 含目标 sourceId；不符 → 关闭/返回 + 单篇 failed
collect_detail   读详情标题/正文/图片（标题权威源在此）
write_result     note.md / manifest.json / assets，目录名此刻才定
return_list      returnStrategy: close_modal | history_back
verify_return    断言回到列表容器、下一目标可重定位
checkpoint       cursor + scrollY + 本篇结果落盘（复用 checkpoint_json）
```

验证墙检测命中（复用现有 waiting_human 判定）→ 任务 `waiting_human` + pause reason `verification`，投影出"等待你完成验证"卡，恢复走既有 `browser_resume_task(jobId)`，恢复后**保持原 strategy**。

**执行面：保留 agent tab。** 风控敏感的是"裸跳详情 URL 的非自然路径"，不是"哪个 tab"——登录态经 session partition 共享，agent tab 上先打开列表页再逐张点击同样是自然浏览轨迹。这保住 6/4 两份计划在租约、写定向、冻结确认上的全部投资，避免重新发明"用户页面接管"模型。

### 3.4 数量合同与 allow_partial

- `visible_collect` 终态把 `frozenCount + discoveryStatus + hasMoreLikely` 写进结果 manifest（大部分已存在）。
- `browser_collect_notes` 校验：`discoveryStatus !== 'complete'` 时拒绝启动，除非 runtime 存在**本 scope 的持久用户确认记录**。
- 确认记录的唯一写入路径：主 agent 的 `ask_user_questions` 结构化反问（"清单可能不完整，只采当前 N 条还是继续发现？"）的回答落库，或 UI 卡片上的显式按钮 IPC。**模型工具参数 `allow_partial` 降级为提示位，不再具有放行效力。**
- 投影行文案与 `hasMoreLikely` 联动："已发现 30（可能还有更多）"。

### 3.5 候选过滤与归档（最小版）

- 冻结清单字段增量：`stableHref`（重定位锚点）、`order`、`sourceId`（已有）、`excludedReason?`。
- 过滤规则只做四条可验证的：① 无 `stableHref` 指向详情的容器剔除；② 命中 avatar/author/profile 类名或链接指向作者主页的剔除；③ 命中 nav/login/notification 语义的剔除；④ 视频项标记 `kind: 'video'` 留给策略决定跳过或采封面。**不引入 titleConfidence 四档体系**。
- 目录命名：详情页标题 → 截断清洗；详情失败 → `序号-未命名-{sourceId}` 进 `_failed/`，不建普通目录。零图片同理。
- 根目录 `collection-manifest.json` + 报告保持原计划 WP7 设计（该部分无异议）。

---

## 4. 接口增量（对照原计划 §6 的收缩）

```ts
// 冻结清单条目——在现有 noteCandidates 条目上增量，不新建类型体系
interface FrozenTargetDelta {
  stableHref: string          // 重定位锚点（必填，没有就不进清单）
  order: number
  kind?: 'content' | 'video'  // 仅两类；过滤掉的不进清单而非标 7 类
}

// 投影合同增量——修 §2.7 的根因
interface BrowserTaskProjectionInputDelta {
  publicStatus?: 'paused_verification' | 'partial' | ...  // publicNoteCollectStatus 的产出直通 UI
  waitingFor?: 'verification' | 'background' | 'none'
  jobId?: string              // = source_task_id，供 UI 聚合成一张卡
  discovered?: number         // 与 completed 分离，杜绝 30/30
  hasMoreLikely?: boolean
}

// card_loop checkpoint——复用 checkpoint_json，结构即原计划 §6.4 删掉 jobId/phase 冗余后的子集
interface CardLoopCheckpoint {
  cursor: number
  scrollY?: number
  lastVerifiedAt: string
  failureBySourceId: Record<string, string>
}

// 用户确认记录——allow_partial 的替代
interface PartialCollectionConsent {
  scopeId: string
  sourceTaskId: string
  confirmedVia: 'ask_user_questions' | 'ui_action'
  confirmedAt: string
}
```

不采纳的原计划类型：`BrowserCollectionJob`（投影聚合替代）、`BrowserCardAnchor` 的 bounds/viewportIndex/snapshotHash（坐标点击所需 bounds 在执行时实时取，不持久化——持久化的 bounds 必然过期）、`titleConfidence/titleSource`（详情页权威源替代）。

---

## 5. 前置技术验证（spike，先于一切工作包）

card_loop 的成败系于两个未经验证的技术点，先用一天级 spike 证伪：

1. **Trusted 点击**：在 BrowserView 上用 `webContents.sendInputEvent` 做坐标点击，对照注入 JS click，在本地 fixture 和一个真实高风控站点上验证：事件 isTrusted、详情是否正常打开、是否触发风控差异。
2. **返回路径**：modal 关闭与 history.back 两种 returnStrategy 在目标平台上的实际表现（列表滚动位置是否保留、虚拟列表是否重排）。

spike 结论决定 card_loop 的实现细节甚至可行性。**spike 失败 ≠ 计划失败**：退化方案是"agent tab 上 url_batch + 更低频率 + 验证墙友好暂停"，仍然比现状好。原计划没有这个安全阀。

---

## 6. 工作包

### S0 — 对账与合同测试（先红）

1. 裁决工作区未提交 diff：prompt-assembly 强化行与本提案 §3.2 冲突，留或撤；TaskToolSnapshot/测试改动与 S1 合并推进。
2. 失败测试覆盖：
   - 发现 30 条时投影不得出现 `completed === total` 的"完成"形态。
   - `waiting_human` 必须以 `waitingFor: 'verification'` 到达投影。
   - `discoveryStatus: 'partial'` + 无确认记录 → `browser_collect_notes` 拒绝；模型传 `allow_partial=true` 不改变该结果。
   - 高风控域 + `strategy: 'url_batch'` → 拒绝；`strategy: 'card_loop'` → 接受。
   - 租约丢失 → 任务转可恢复暂停而非 failed；resume 重新获取租约。

### S1 — 止谎三修（零新实体）

1. `projectVisibleCollect` 与 summary：discovered 与 completed 分离；`hasMoreLikely` 进文案。
2. `BrowserTaskProjectionInput` 增量字段 + `publicNoteCollectStatus` 直通 UI + `TaskToolSnapshot` 区分 `等待验证/部分完成/已完成`。
3. `PartialCollectionConsent` 落库 + `browser_collect_notes` 改查记录 + `ask_user_questions` 反问路径接通。

验收：用户问题 1、2、6 的复现脚本全部转绿；`npm run typecheck`、相关行为测试、`verify:native`（涉及落库）通过。

### S2 — 投影聚合 + strategy 路由合同

1. 投影按 `source_task_id` 聚合一张采集卡（两行进度），历史 stale 任务过滤沿用已落地的 a010a5d7 语义。
2. `browser_collect_notes` 增加 `strategy` 参数 + 不对称否决逻辑 + 结构化拒绝错误。
3. prompt 规则改写（§3.2 第 5 条）。
4. spike 并行启动（§5）。

验收：S0 的路由测试转绿；普通站点 url_batch 回归不破；fixture 上 `逐张点开` 意图 → card_loop 被声明并接受。

### S3 — card_loop runner（fixture 先行）

1. content-task-runner 新 kind `card_loop`，按 §3.3 状态机实现，复用 lease/checkpoint/projection/分段续跑。
2. 冻结清单增量字段（§3.5）+ 四条候选过滤。
3. 本地 fixture 矩阵：50 卡片信息流 / modal 详情 / 新页详情 / 点击后卡片消失 / 返回失败 / 验证墙模拟 / 懒加载重排。
4. 详情页标题权威源 + 目录命名延迟 + `_failed/` 归档。

验收：fixture 50/50 逐张闭环；各失败注入路径状态正确；单篇失败不污染成功目录；中断 → `browser_resume_task` 从 cursor 续跑且保持 card_loop。

### S4 — 验证暂停闭环 + 真实样本

1. 验证墙 → `waiting_human(verification)` → 用户完成 → "继续" → 同 jobId 同 strategy 续跑的端到端链路。
2. 连续验证墙只暂停不硬试（计数器 + 退避进 checkpoint）。
3. 真实样本（Aoi/小红书作为样本之一）验证，不写站点特例。
4. `npm run typecheck` / `npm run test` / `npm run verify:native` / `git diff --check` / Ready app 实测。

---

## 7. 与原计划的工作包映射

| 原计划 | 反提案 | 处置 |
| --- | --- | --- |
| WP0 合同先行 | S0 | 保留，增加租约与工作区对账 |
| WP1 CollectionJob 实体 | S1+S2 投影聚合 | **替代**：不建新实体 |
| WP2 Mode Router 服务 | S2 不对称声明 | **替代**：模型声明 + 代码否决 |
| WP3 card-aware manifest | S3 最小增量 | 收缩：去掉置信度体系 |
| WP4 visible_card_loop | S3 + §5 spike | 保留核心，前置可行性验证，v1 去视觉模型 |
| WP5 脚本模式收口 | S2 strategy 枚举 | 吸收为 list_only/url_batch |
| WP6 验证暂停续跑 | S1（投影）+ S4（闭环） | 拆分提前 |
| WP7 输出归档 | S3 | 保留，命名延迟到详情 |
| WP8 UI 稳定化 | S1+S2 + 在-flight 改动 | 与工作区现有工作合并 |
| WP9 回归 | 各阶段验收 + S4 | 分摊进阶段 |

---

## 8. 非目标

继承原计划全部 8 条非目标，另加：

9. 不在 v1 的 card_loop 里引入视觉模型判断；视觉升级是独立后续提案。
10. 不新建与 `browser_tasks` 平行的任务实体或状态机。
11. 不把 `browser-collection-intent.ts` 升格为语义意图路由器。
12. 不持久化卡片几何信息（bounds/viewport）当作重定位依据。

---

## 9. 风险与开放问题

1. **trusted 点击在真实平台的有效性**（§5 spike 承接；有退化方案）。
2. **不对称否决的兜底误判**：高风控清单漏掉新平台时，url_batch 仍可能放行。缓解：清单可配置 + 拒绝错误结构化可观测 + 验证墙命中即转暂停，损失被限制在"一次被拦"。
3. **模型不声明 strategy 的存量行为**：默认值规则（§3.2 第 4 条）保持普通站点现状，但高风控默认切到 card_loop 后速度变慢——这是有意取舍，与原计划 §9.1 一致。
4. **投影聚合与 6/5 计划的 dwell/settle 语义**：聚合卡要兼容既有 30s dwell 逻辑，S2 实现时对照该计划合同，不另起 timer。
5. **`ask_user_questions` 每轮一次的约束**：partial 确认反问可能与同轮其他反问竞争；冲突时退化为 UI 卡片按钮路径。

---

## 10. 验收标准（对照原计划 §10 逐条）

原计划 8 条全部保留，表述收紧两处：

- 第 2 条改为："发现 N 条时，投影中 discovered 与 completed 为独立字段，UI 任何状态下不得把发现数渲染成保存完成数。"（合同测试断言，不止文案）
- 第 7 条改为："strategy 的接受/拒绝必须返回结构化 reason 并落日志（ready-tools.log），可在测试中断言。"（"能解释"必须机器可验证）
