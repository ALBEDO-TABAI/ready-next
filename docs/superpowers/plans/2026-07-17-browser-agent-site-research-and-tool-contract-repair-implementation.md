---
title: 浏览器 Agent 站内研究与工具合同修复实施计划
date: 2026-07-17
status: completed
enforce: true
owner: 白
author: Codex
scope: 浏览器研究意图、模型工具面、长任务参数合同、站内多关键词研究、任务投影、完成判定与可诊断性
related:
  - docs/superpowers/plans/2026-07-17-browser-tool-surface-and-hardening-implementation.md
  - docs/superpowers/plans/2026-07-18-browser-agent-grounded-orchestration-and-capability-closure-implementation.md
  - docs/architecture/current-runtime-contracts.md §4、§5、§6
follow_up:
  - docs/superpowers/plans/2026-07-18-browser-agent-grounded-orchestration-and-capability-closure-implementation.md
note: >
  本文件是 2026-07-17 小红书多关键词研究失败后的纠偏计划。2026-07-18 已结合 live 调用链完成
  开工前复审、实施、本地/打包门禁和已登录真站验收。它修订前一份已完成计划中“研究可完全内化进
  browser_collect”与“31 项是固定目标”两项结论。2026-07-18 后续用户复测又证伪了本文件
  current-site URL adapter 与真站交互正确性结论；被证伪部分由 follow_up 计划覆盖。
---

# 浏览器 Agent 站内研究与工具合同修复实施计划

> **2026-07-18 复测纠偏：** 本文件保留为当时的实施记录。后续同一 18 关键词任务证明，现行 runner
> 仍会合成小红书搜索 URL、直达裸详情 URL，并在任务取消后继续阻止 Agent 使用搜索框；真实浏览
> 历史出现连续 `300031`。因此 §4.5 的 `inspect_site_search` URL adapter、Phase 3 的 current-site
> adapter 方案、§10“已登录小红书真站”对交互路径正确性的 completed 结论，以及 §11 的整体关闭
> 口径，均不再作为现行开发依据。新的证据、目标合同和施工 gate 见
> `2026-07-18-browser-agent-grounded-orchestration-and-capability-closure-implementation.md`。本文件中意图、公开
> 工具合同、task/projection 身份和必要输出地板等未被复测证伪的部分继续有效。

## 0. 本轮边界、假设与完成标准

### 0.1 实施边界

- 计划复审完成前不改运行时代码；复审确认后按 Phase 0 -> 6 实施，不以源码推测替代生产记录。
- 诊断覆盖用户原始任务、两次 Agent 运行、模型实际收到的工具、每次工具调用、后台浏览器任务、任务投影、最终完成判定、现行代码与现行测试。
- 第一轮“模型工具调用被关闭”与第二轮“工具已经开启但任务仍失败”是两件事。前者是正确的 provider 能力约束；本计划不绕过它。后者才是本计划要修的产品缺口。
- “完全不触发平台风控”不是可以证明的承诺。可证明目标是：使用用户真实登录会话、单写者、站内真实交互、页面状态驱动节奏和可恢复断点，消除并发搜索、重试风暴、重复提交、错误跨页读取等应用自己制造的异常行为；验证码、登录墙和平台验证出现时暂停并可原任务续跑，不绕过访问控制。

### 0.2 对“百分百确认”的准确边界

以下因果链已由同一次生产任务的持久记录、精确报错、当前代码路径和最小复现相互印证，可以按 100% 置信度作为根因实施：

1. 原任务被错误识别为“批量持久采集”。
2. 该识别把模型可见浏览器工具缩到 4 项，排除了完成站内研究所需的导航、搜索、读取、快照和交互工具。
3. 模型拿到的 `browser_collect` 参数表没有 `query`，而 `research` 执行分支又强制要求顶层 `query`；模型把查询放进唯一可见的通用 `payload` 也不会被读取。
4. 即使只补 `query`，现有 `research` runner 也不是本任务所需的站内多关键词工作流：本次 18 个 URL 默认只会取前 6 个；无 URL 时还会转到 Google；它也没有“结果卡指标 -> 爆款筛选 -> 详情正文 -> 目标账号适配”的阶段合同。
5. 任务改走 `visible` 后确实启动，但投影记录使用浏览器任务 ID 作为 `runId`，同时继承 Agent run 的执行绑定，稳定触发数据库不变量错误并把后台任务打成失败。
6. 最后，失败工具回执仍被计作部分 proof；默认 `degraded_visible` 允许该 run 保持 `done`，Renderer 又把它映射成 `completed`，于是“18 个关键词 0 个有效交付”仍显示完成。

本轮不能在尚未实施和真机验收前声称“小红书未来一定返回多少条结果”。这属于修复后的运行结果，不属于根因事实。计划中的真实 Electron 验收负责关闭这部分不确定性。

### 0.3 未来实施完成标准

只有同时满足以下条件，后续开发才算完成：

1. 截图中的原始中文任务固定解析为“当前站点多关键词研究”，不再解析为“保存某账号的全部笔记”。
2. Agent 实际发给 provider 的工具参数中，存在独立且诚实的 `browser_research`；`browser_collect`、`browser_download`、`browser_task` 每个公开动作的可见参数与真实执行参数一致。
3. 18 个关键词逐项有可核验状态；候选至少包含关键词、标题、链接、作者、页面可见互动指标与抓取时间；被选中的候选再读取详情正文。没有互动指标时不得宣称“爆款”，没有详情正文时不得宣称已整理“内容”。
4. 目标账号是“适配判断对象”，不是“批量保存来源”。Agent 可读取账号主页及其可见内容，再基于研究证据筛选选题。
5. 站内研究使用当前登录会话，默认串行复用一个研究标签；普通搜索不弹确认。只有登录、验证码、平台验证或确实无法继续时才让用户接管，接管后从持久断点续跑。
6. 浏览器 task id、Agent run id、父任务和执行绑定各司其职；真实 SQLite repository 不再出现 runId mismatch；投影失败不会反向把真实浏览器执行打失败，也不会被静默吞掉。
7. 0 条领域交付、缺少必要字段或仍有未处理关键词时，不得显示绿色完成；有断点则显示可继续，没有断点则明确失败或部分结果。
8. OpenAI、Anthropic 等实际 provider 边界的工具 JSON Schema、生产 repository、完整任务状态和真实 Electron 小红书流程全部通过，而不是只让直接调用 handler 的单元测试通过。

## 1. 生产事故时间线与证据

### 1.1 运行身份

| 项目 | 值 |
|---|---|
| conversation / scope | `conv-e4ccc5b4-b44a-424f-8815-9f8ec14e9358` |
| 第一次 run | `req-1784300587029-3yckx3` |
| 第二次 run | `req-1784300687158-mtm2ck` |
| 主任务 | `task-3d5adf15-00f0-4f24-a2fd-b7df644b43bd` |
| 后台浏览器任务 | `browser-task-ee94f117-c7ba-4df4-b7bc-80f1f5663fdd` |
| Agent | `analyst` |

### 1.2 真实发生顺序

| 时间 / 阶段 | 生产证据 | 结论 |
|---|---|---|
| 第一次 run | `provider_disabled_tools`；provider wire 的 `toolSchemaCount=0` | 模型配置当时没有开放原生工具。这次阻塞是正确的，不是浏览器 handler 故障 |
| 用户开启工具后重试 | 第二次 run 最终有 53 个工具，但浏览器只剩 `browser_request_takeover / browser_collect / browser_download / browser_task` | provider 已能调用工具；缺口转为 Ready 的浏览器意图与暴露面 |
| 15:05:28 | `browser_collect(mode=research, urls=18项, limit, expected_count)` -> `query is required` | 模型按公开 schema 调用，但 schema 没有 handler 必填的 `query` |
| 15:05:40 | 再次调用并把查询放入 `payload.query` -> 同样 `query is required` | `payload` 是假逃生口；执行分支只读顶层 `args.query` |
| 15:05:48 | 改用 `browser_collect(mode=visible, template=自然语言要求)` -> 任务启动 | 模型被迫换了语义不相符的采集模式；`template` 又被错误声明为任意字符串 |
| 15:05:54 | `browser_task(action=get, task_id=...)` -> `execution binding runId must match projection runId` | 浏览器任务已经运行，失败点是投影身份冲突，不是平台风控或 Agent 放弃 |
| 后台任务记录 | `visible_collect` checkpoint cursor=1，存在部分页面项，但主要是导航/侧栏区域；缺少作者、互动指标和详情正文 | 即使没有投影错误，这一路也无法证明“爆款”、无法交付笔记“内容” |
| run 终态 | `run_meta.status=done`、`terminal_reason=adjudication_degraded`、`task_type=research`；projection 为 `completed` | 系统自己知道验收项未满足，却仍把任务投成绿色完成 |

### 1.3 原始任务的结构真相

本次用户给出 18 个关键词，要求在“小红书这里”分别搜索、整理其中爆款笔记的标题和内容，再结合“这个账号”筛选适合的选题。它包含四种不同角色：

生产请求 fixture 必须原样保留以下查询顺序：`vlog调色 高级感`、`剪映 进阶教程`、`自媒体视频 质感提升`、`vlog转场 创意`、`短视频 字幕排版 高级`、`视频拍出来和博主差距大`、`vlog怎么剪才有网感`、`剪映调色 没质感`、`达芬奇调色 vlog`、`商业剪辑师 技巧`、`AI做视频 教程`、`AI视频制作 博主`、`AI生成视频 自媒体`、`vlog美颜 高级感`、`视频画质 美颜 剪辑`、`博主美颜参数 分享`、`视频封面 设计 自媒体`、`小红书封面 制作教程`。

1. **研究语料**：18 个搜索关键词。
2. **候选证据**：每个关键词的站内结果卡与详情页。
3. **评价对象**：当前目标账号主页及其已有内容。
4. **最终产出**：去重后的爆款证据、标题/正文整理和账号适配选题。

当前正则把“整理”当成采集动词，又在整段文本中同时看见“账号/博主”和“笔记/视频”，不区分它们分别属于输出、评价对象还是候选证据，于是误判为批量保存账号内容。

最小复现已证明：

- `在小红书搜索这些关键词，整理爆款笔记标题和内容` -> 非 batch。
- 加上 `再筛选适合这个账号的选题` -> 变为 batch。
- 真正的 `把这个博主的每篇笔记都保存图片` -> batch。

因此，触发误判的不是 18 个关键词，而是“整理 + 账号 + 笔记”跨子句串联。

## 2. 根因分层

### R1：站内研究与结构化采集被错误合并为一个语义

前一份工具面计划把旧 `browser_research_topic` 与 `browser_start_task` 一并内化，并宣告 `browser_collect` 可以覆盖跨页研究。这个结论过度压缩了用户语义：

- “研究”产出的是带来源的事实与分析，不等于把网页内容保存成用户资产。
- `browser_collect` 面向按页、按清单或按结构提取内容；其中需要落盘的动作还要求目录、清单、下载和完整性验收。普通站内研究不应因此打开下载或部分采集同意流程。
- 同一个 `browser_collect` 只要出现在工具面，`resolveTaskTypeFromToolDefinitions()` 就把整个任务标成 research；反过来，研究意图又被 collection/batch 的工具名单收窄。

**裁决：** 新增一个新的语义工具 `browser_research`。它不是恢复旧 `browser_research_topic`，不保留旧名兼容；旧工具仍退役。公开语义工具总数从 31 调整为 32。数字不是架构目标，“一个用户语义一个诚实工具”才是目标。

### R2：布尔正则把不同子句和角色拼成一个 batch 结论

`src/shared/browser-collection-intent.ts` 当前存在三处直接原因：

- `COLLECTION_VERB` 包含“整理”。
- `BATCH_SCOPE_SIGNAL` 包含“账号/博主”。
- `BATCH_CONTENT_OBJECT` 包含“笔记/视频/内容”。

`resolveBrowserBatchCollectionIntent()` 在整段文本上找这些词，不要求“保存/下载”与“全部笔记”属于同一动作子句。当前运行时又把该 boolean 通过 TTL 继承到后续回合，误判会持续污染重试。

**裁决：** 代码只确定可机械证明的事实：是否明确要求保存/下载/采集、是否存在查询列表、是否有当前网页引用。研究、评价对象和输出角色由结构化浏览器计划表达；不再用一个 sticky batch boolean 代表所有浏览器长任务。

### R3：batch 工具面恰好删掉了研究所需能力

`browser-tool-surface.ts` 的 `batch_collection` 只有 4 项；`agent-sdk-tool-executor.ts` 在 batch 命中后会删除其他所有 `browser_*` 定义。现有测试甚至明确要求 batch 时不存在 navigate/click/read/snapshot。这个合同只适合“目标已冻结、后台按清单保存”的阶段，不适合“先在站内逐关键词发现、再深读和分析”的任务。

**裁决：** 新增 `site_research` 暴露意图；它包含阅读核心、必要的可信交互、`browser_research`、`browser_task`、状态与接管，但不含下载、归档、任意脚本或 Power。按页或按结构提取可继续使用普通 collect 面；只有明确要求落盘、保存或下载才进入 persistent collection，只有目标已经冻结且任务确实是批量保存时才进入原来的四工具后台面。

### R4：模型参数合同和执行参数合同已经分叉

`daccec377` 把多个旧工具压成统一 schema 时，保留了 handler，却丢掉了各模式的关键字段。`.passthrough()` 只能让运行时容忍未知字段，不能让 provider 的工具定义向模型公开这些字段。

已确认的代表性漂移如下：

| 工具 / 动作 | handler 真实读取但当前模型参数中缺失或失真 |
|---|---|
| `browser_collect(research)` | `query`、`max_pages`、`limit_per_page`；其中 `query` 必填 |
| `browser_collect(images)` | `keyword`、`min_width`、`include_hidden` |
| `browser_collect(structured)` | enum `template`、`item_selector`、`fields`、`min_width`；当前 `template` 是任意字符串 |
| `browser_collect(scroll)` | `item_selector`、`max_scrolls`、`scroll_delay_ms` |
| `browser_collect(visible)` | `max_items`、`max_rounds`、`max_duration_ms`、`user_expected_total`、`output_root_dir` |
| `browser_collect(notes)` | `target_profile_url`、`strategy`、`notes`、`allow_partial`、`max_notes`、`max_duration_ms`、`max_consecutive_failures` |
| `browser_collect(start)` | handler 必填 `kind`，schema 不公开；同时前一份计划又明确 `kind/payload` 不应由模型手写 |
| `browser_download(urls/collected/resolve/gallery)` | `filename_prefix`、`overwrite`、`expected_total`、视频候选字段、`limit`、`max_scrolls`、`retry_failed` 等 |
| `browser_task(result)` | schema 强制 `task_id`，handler 却忽略它并读取未公开的 `items/merge_strategy/sort_by` |
| `browser_resources` | `wait_ms`、`max_candidates` |
| `browser_tabs(open)` | `opener_tab_id` |
| `browser_navigate/search` | handler 读取未公开的 `allow_repeat` |
| `browser_console(list)` | `duration_ms` |
| `browser_wait` | schema 宣称 `duration_ms`，真实分支不使用它；handler 另读未公开的 `custom_js/check_interval_ms/stable_iterations` |

现有 `browser-tool-schemas.test.ts` 只证明“31 个名称都有一个可导出的参数列表”，没有证明参数足以调用真实 handler。其他工具测试又经常绕过 provider schema，直接把隐藏字段传给 handler，所以全绿也没有覆盖模型真实可调用性。

**裁决：** 不逐个补丁式加字段。建立一个长任务动作合同表，由它同时生成公开 schema、mode -> operation 路由和 typed parser；公开输入与受信内部上下文分开，handler 不再直接读取一包 `Record<string, unknown>`。

### R5：现有 research runner 不是站内研究

`content-task-runner.ts` 的 `research` 分支：

- 默认 `maxPages=6`，本次 18 个 URL 会静默只处理前 6 个。
- 没有 URL 时构造 Google 查询，而不是在用户说的“小红书这里”搜索。
- 对 URL 做通用结构提取和去重，没有“关键词 -> 结果排名 -> 互动指标 -> 详情正文”的分层结果。
- 没有保留目标账号主页作为独立评价对象。

**裁决：** 删除 `browser_collect(mode=research)` 的公开路径；新增独立的 `browser_research` 与 `site_research` runner。通用公开网页研究继续由现有 web research 工具负责；登录态站内研究由 in-app browser 负责，两者不互相静默降级。

### R6：浏览器 task id 被当成 Agent run id

`browser-collection-projection-sink.ts` 当前写入：

- `taskId = browser task/source task id`
- `runId = input.taskId`（仍是 browser task id）
- `executionBinding = 发起 Agent run 的 binding`

repository 正确要求 `executionBinding.runId === projection.runId`，所以一旦 2026-07-16 开始继承 Agent binding，旧的 `runId=input.taskId` 就必然报错。测试使用一个不执行 repository 不变量的 Map 假 store，因此把无效记录当成了通过。

**裁决：** 浏览器 task id 只做任务身份和续跑句柄；projection 的 `runId` 使用当前执行它的真实 Agent run。创建来源永久保留，恢复时将“当前执行绑定 + projection runId”在同一事务/写入中更新。无 Agent run 的系统后台任务可以保留 browser task id 作为 runId，但必须没有 execution binding。

### R7：派生视图错误反向杀死了真实任务

runner 在每轮内同步调用 projection sink。sink 抛错会穿透 `runTask()`，`scheduleTask().catch()` 随即把 `browser_tasks` 本体写成 failed。投影本来只是用户界面的派生视图，不应成为浏览器执行的命门；但也不能简单 try/catch 后丢失状态。

**裁决：** 先持久化 browser task 真值和 revision，再通知 projection coordinator；projection 按 task id/revision 幂等重建。写失败进入有界持久重试并记录 metric，绝不改写 browser task 的执行终态。启动时按 revision 对账，不能依赖一次内存事件。

### R8：失败证据被当成完成证据

默认 finalizer 在 degraded verdict 下，只要 `proofCount>0`、`satisfiedCount>0` 且不是特定 blocker，就可保持 `done`。随后：

- `run-coordinator` 把 `adjudication_degraded + success` 转成 done phase。
- `task-projection-sync` 明确把 `adjudication_degraded + done` 转成 completed。

本次 `query is required`、binding mismatch 和“尝试过工具”足以形成 proof，却没有任何一个关键词的可用结果。

**裁决：** 失败回执可以证明“发生了失败”，不能满足领域交付。`browser_research` 先执行代码侧 essential-output floor，再进入通用 adjudication；未满足时写明确 terminal failure 或 recoverable checkpoint，使 generic degraded-visible 无权把它翻回绿色完成。

### R9：诊断真相仍部分依赖易失临时日志

`ready-directchat.log / ready-tools.log / ready-browser.log` 在调查期间已随应用生命周期消失。幸好本次 `chat_messages.meta_json.toolTraceSnapshot`、`run_meta`、`browser_tasks` 和 metrics 留下了关键链路，但“为什么选择 batch 面、模型实际看到哪个 mode schema、投影第几次失败”还不够集中。

**裁决：** 在现有持久 run/trace 中追加小型、低敏的路由与合同快照，不复制网页正文，不新建第二套日志真值。

## 3. 不采用的表面修复

以下做法可以让某个报错暂时消失，但不能完成用户任务，实施时明确禁止：

1. **只给 `browser_collect` 加 `query`。** 仍会保留误路由、6 页截断、Google fallback、无互动指标、无详情正文和投影冲突。
2. **始终暴露全部 31/32 个浏览器工具。** 会掩盖路由错误、增加模型噪声，也让普通阅读回合无必要地看到下载与 Power。
3. **遇到小红书就强制 batch/high-control。** 域名不能代表用户意图；“分析账号”和“保存全部笔记”必须不同。
4. **吞掉 projection 异常。** 任务可能继续，但用户卡片永久错误，重启后更难恢复。
5. **把部分结果一律标完成。** 用户要求的 18 个查询不能因“有过一次工具调用”而完成；部分可见与绿色完成是两回事。
6. **加固定随机延迟、全程慢打或伪造指纹。** 既降低效率，也不证明更安全；节奏必须由真实页面反馈和 origin 单写者控制。
7. **回滚整个 31 工具重组或复活旧名兼容层。** 已完成的快照、可信输入、下载、指针和统一执行器继续保留；只纠正研究语义与合同生成。
8. **只写小红书选择器脚本。** 小红书是首个强验收站点，不是又一条绕开通用 BrowserActionExecutor 的旁路。

## 4. 目标合同

### 4.1 浏览器工作意图：显式事实与语义角色分开

新增共享 `BrowserWorkIntent`，至少包含：

```text
kind: observe | site_research | persist_collection | transact | diagnose
siteSurface: current_site | supplied_urls | none
queries: string[]
persistenceRequested: boolean
batchScope: none | explicit_all_items
roles:
  researchQueries
  evidenceSources
  evaluationTargets
  outputDestinations
```

约束：

- `采集/抓取/下载/保存` 才能令 `persistenceRequested=true`；“整理/分析/筛选/找爆款/选题”不能。
- `explicit_all_items` 必须由同一动作子句中的持久动词 + 全量词 + 内容对象共同证明，例如“保存这个博主的全部笔记”。目标账号出现在评价子句时不得触发。
- 18 个换行关键词保留顺序、去空白、精确去重；不能拼成一个 query，也不能当作 18 个 URL 数量上限。
- 继续/重试只继承完整 `BrowserWorkIntent` 和原始查询清单，不继承孤立的 collection/batch boolean。
- 不需要当前登录态、Cookie 或应用内页面上下文的站外公开网页研究，在进入该 intent 前就交给通用 web research；不能用 `siteSurface` 把两套执行面混在一起。
- 代码确定显式事实和权限边界；主 Agent 负责“什么内容适合账号”这种语义判断。

本次 fixture 的期望值固定为：

```text
kind=site_research
siteSurface=current_site
queries=18
persistenceRequested=false
batchScope=none
evaluationTargets=[当前账号]
```

### 4.2 新增独立 `browser_research`

`browser_research` 是用户语义级工具，目标是“在用户当前登录站点或指定 URL 集上，完成可续跑的多查询研究”。它不写用户目录、不下载媒体、不触发部分采集同意。

公开输入：

| 字段 | 合同 |
|---|---|
| `scope` | 必填，`current_site | url_set`；不允许静默改成外部搜索引擎 |
| `queries` | `current_site` 必填，非空字符串数组，保序去重；单查询也用数组 |
| `site_tab_id` | provider 字段可选；若当前明确网页引用已由代码注入则无需模型重复提交，否则 `current_site` 必填。进入 runner 前必须解析成唯一绑定 tab，用于继承 origin/session，不能被任意活动 tab 代替 |
| `urls` | `url_set` 必填；不因默认 page limit 静默丢尾部。仅用于必须继承当前浏览器登录态或页面上下文的 URL 集；普通公开 URL 继续走通用 web research |
| `per_query_limit` | 每个查询结果卡上限，有合理默认和总预算 |
| `detail_limit_per_query` | 每个查询深读候选上限；默认只深读有可比较依据的前若干项 |
| `fields` | 受控 enum：`title/url/author/engagement/published_at/body`；不能传任意脚本 |
| `preserve_source_tab` | 默认 true；研究使用同 session 的 Agent 标签，不破坏用户正在看的账号主页 |

返回：

- 立即返回 `browserTaskId`、查询总数、当前阶段和 continuation。
- 终态结果按 query 分组；每项包含 rank、canonical URL、标题、作者、页面可见互动指标、抓取时间、详情正文或明确不可得原因、证据引用。
- 去重不抹掉 query 归属：同一笔记可命中多个关键词，保留 `matchedQueries[]`。
- `browser_task(action=result, task_id)` 读取该持久结果；不再让模型重新提交 items 做临时聚合。

### 4.3 站内研究工具面

新增 manifest intent `site_research`，从单一清单生成：

- 读取与定位：`browser_tabs`、`browser_navigate`、`browser_snapshot`、`browser_find`、`browser_read`、`browser_screenshot`、`browser_wait`。
- 必要可信交互与恢复：`browser_search`（新增 `scope=current_site`）、`browser_click`、`browser_type`、`browser_scroll`、`browser_press_key`、`browser_request_takeover`。
- 长任务：`browser_research`、`browser_task`、`browser_status`。

不默认包含 `browser_download`、`browser_archive`、`browser_eval`、`browser_cdp`、session 清理或权限修改。用户随后明确要求保存时，再从 research result/task id 原子升级到 collection，不能靠同一个模糊工具静默改变任务性质。

`batch_collection` 的四工具窄面继续保留，但入口必须是已冻结目标 + 明确持久保存，不再服务发现/研究阶段。

### 4.4 公开输入与受信上下文彻底分离

建立一个 canonical action contract registry，覆盖 32 个公开工具的每个 action/mode：

```text
publicSchema     模型可以看到和提交的字段
requiredRule     action/mode 相关必填与互斥关系
normalize        只把 public input 转成 typed request
operation        唯一 handler 操作名
trustedContext   run/task/tab/binding/surface/consent/allowRepeat 等代码侧事实
```

规则：

- `browser_collect` 公开 mode 只保留 `images | structured | scroll | visible | notes`；移除 `research | start`。
- `kind/payload` 永远是内部 planner 输出，模型不可见。
- `template` 恢复受控 enum；自定义脚本只走明确高级工具，不藏在普通采集。
- `strategy`、`allow_partial`、`unrelated_to_collection`、ownership/binding 等不再接受模型自报，由任务状态和用户真实确认推导。
- `browser_download` 的 URL、采集结果、视频解析和图库 mode 都有各自 typed request；是否覆盖、文件名前缀、预算等确属用户任务参数的字段公开，来源/授权/是否与采集相关由代码判断。
- `browser_task(result)` 与 get/resume/cancel 一样要求 `task_id`，只读持久任务结果；旧的 ad-hoc `items/merge/sort` 移到内部聚合服务。
- `browser_wait(duration_ms)` 真正按时长等待且可中止；condition 分支只公开可实现条件。普通工具不再读取 schema 外的模型字段。
- 实际 provider JSON Schema 必须从该 registry 生成并做快照测试；Zod `.passthrough()` 不算模型合同。

### 4.5 站内研究状态机

新增独立 runner 文件，`content-task-runner.ts` 只负责注册和调度，不继续增肥。状态机：

```text
bind_site_session
  -> inspect_site_search
  -> query_search[i]
  -> freeze_result_cards[i]
  -> select_detail_candidates[i]
  -> read_details[i][j]
  -> aggregate_and_dedupe
  -> completed | recoverable_paused | failed
```

每个阶段的合同：

1. **bind_site_session**：绑定用户指定/current reference 的 tab、origin、profile 和 document identity；另开同 session 的 Agent 研究标签，默认不覆盖目标账号页。
2. **inspect_site_search**：本事故首个 current-site adapter 只支持小红书真实站内搜索 URL；`browser_search(scope=current_site)` 只在该 origin 内导航，其他未适配站点明确返回不支持，不能 fallback 到 Google、百度等外站。通用 URL 集研究仍可用，不把“任意网站搜索框自动适配”作为本次事故修复的隐含范围。
3. **query_search**：按关键词顺序串行，同 origin 只允许一个写者；导航后等页面可读/结果稳定，不用无条件长 sleep。
4. **freeze_result_cards**：冻结本 query 的标题、URL、作者、可见赞/藏/评等、rank 和 page identity。导航/侧栏污染项不能作为结果。
5. **select_detail_candidates**：只有存在可比较互动指标时才按“爆款”选择；否则标记 `engagement_unavailable`，由 Agent诚实说明，不能臆测。
6. **read_details**：逐项打开详情并读正文；结果卡 snippet 不能冒充正文。正文不可见时记录登录墙、删除、权限、加载失败等原因。
7. **aggregate_and_dedupe**：canonical URL 去重，保留命中关键词和各 query rank；结果与目标账号主页证据分别交给主 Agent 做适配分析。

断点至少记录：当前 query index、已冻结 query 结果、当前 detail index、已读详情、站点 tab/profile identity、最后成功页面和暂停原因。重启或接管后不得重跑已完成 query，也不得重复打开已验证详情。

### 4.6 高风控平台的效率与稳定性

- 同 origin 搜索默认串行；只读详情可以在站点实际稳定后有限复用一个附属标签，不同时爆发打开几十页。
- 节奏由 `readyState`、内容稳定、真实 429/挑战页、连续空结果和动作回执驱动；不使用全局固定随机等待。
- 一次导航/提交结果不确定时先回读，不立即重复；同 query 不产生重试风暴。
- 发现登录/二维码/验证码/安全验证时进入 `waiting_human`，保留当前 query/detail 断点；用户接管完成后继续同一 browser task。
- 页面确实返回 0 结果时记录“已验证空结果”；页面只剩导航壳时是可恢复暂停，不是空结果，也不是完成。
- 不伪造 UA、指纹、行为或验证码答案，不绕过站点访问控制。

### 4.7 task、run、projection 身份合同

浏览器长任务持久记录新增/明确四类身份：

| 身份 | 含义 | 生命周期 |
|---|---|---|
| `browserTaskId` | 浏览器任务与 continuation 主键 | 从创建到清理不变 |
| `createdByRunId` | 首次创建来源 | 不变，仅审计 |
| `activeExecutionBinding.runId` | 当前实际执行/恢复它的 Agent run | 每次合法 resume 原子更新 |
| `parentTaskId` | 最近一次明确执行/续跑它的用户可见主任务 | 创建时写入；显式 resume/handoff 时与 active binding 一起原子换绑。它用于审计和接力，不是同一 owner + scope 后续只读查询的授权边界 |

projection：

- `taskId = browserTaskId` 或稳定的 source-chain task id。
- 有 active binding 时，`runId = activeExecutionBinding.runId`；二者在一次 repository 写中校验。
- 无 active Agent binding 的系统后台 projection 才允许 `runId = browserTaskId`，且 `executionBinding=null`。
- `browser_task(get/status)` 是纯读取：调用方显式持有 `browserTaskId`，并且 owner 与 scope 相同即可在后续主任务中读取；不得因为 `parentTaskId` 已属于上一轮而把状态复查误拒绝。
- resume 先通过 run/task/scope admission，再原子更新 active binding 与 parent handoff 并启动 runner；旧 run 的晚到事件按 revision 拒绝。

### 4.8 browser task 真值优先，projection 可重建

- runner 每次先事务性写 `browser_tasks` 状态、checkpoint、result、revision。
- projection coordinator 收到 `{browserTaskId, revision}` 后回读真值并派生卡片；不得接收 runner 拼出的第二份自由状态。
- projection 写失败写入持久 retry/outbox，按 task id + revision 幂等覆盖；新 revision 淘汰旧 revision。只有现有 `pending_projection_syncs` 的载荷、终态和清理语义可被安全泛化时才复用它，否则新增单一的 browser-task revision reconciler；禁止两套服务同时成为 projection 真值。
- retry 用尽时记录可见诊断和 metric，但 browser task 本体继续按真实执行结果终结。
- 启动时比较 browser task revision 与 projection revision，自动补齐；测试必须使用真实 `TaskProjectionRepository`，Map fake 只可做纯格式测试。

### 4.9 完成真相与必要输出地板

`browser_research` 完成前由代码检查：

1. 所有输入 query 都有 terminal query record，且 query 数量与保序去重后的输入一致。
2. 每个非空结果至少有标题和可打开 canonical URL；“爆款”声明还必须有页面可见互动指标和抓取时间。
3. 所有被最终引用为“内容”的候选都有详情正文或明确的不可得标记；snippet 不算正文。
4. 若用户要求账号适配，最终 run 必须有目标账号主页/内容读取 proof；研究 runner 不自行猜账号定位。
5. 尚有可恢复 query/detail checkpoint 时，终态是 recoverable checkpoint；无可恢复点且必要输出不足时是失败/部分交付，不是 completed。

通用 proof 规则同步补强：

- `ok:false`、`Error:`、`invalid_arguments`、binding mismatch 等工具回执是 diagnostic proof，不可满足成功 criteria。
- “调用过某工具”不能替代“拿到用户要求的领域输出”。
- `adjudication_degraded` 可以让用户看到已有文字和部分结果，但 essential-output floor 未通过时 UI 状态不得为绿色 completed。

### 4.10 持久诊断快照

在既有 run/tool trace 中持久保存，不记录网页正文：

- `browserWorkIntent` 与解析来源。
- 最终浏览器工具名集合、public schema version/hash、provider wire `toolSchemaCount`。
- 选中的 `browser_research/collect` action 或 mode。
- `browserTaskId / createdByRunId / activeBindingRunId / parentTaskId / revision`。
- 每 query 的状态计数、detail 覆盖、projection sync 失败与重试结果。

临时日志继续用于高频细节，但事故复盘不能再依赖它们是否尚未轮转。

## 5. 分阶段实施顺序

### Phase 0：先写会失败的事故合同

新增测试 fixture，原样保留截图中的 18 个关键词和“适合这个账号”的要求。

红测必须同时证明当前缺口：

1. intent 当前错误为 batch。
2. provider 最终工具面只有 4 个 browser 工具。
3. provider JSON Schema 不含 research 必填 query。
4. 18 URL 默认只跑 6 个。
5. 真实 repository 拒绝 browser task id + Agent binding 的组合。
6. 0 个有效 query result 最终仍变成 completed。

Gate：红测原因逐项与生产证据一致；不能以修改 fixture 让红测通过。

### Phase 1：原子修正语义边界与公开合同

- 新增 `browser_research`，公开工具清单 31 -> 32；旧 `browser_research_topic` 仍不可注册、不可执行。
- 用 `BrowserWorkIntent` 替换 collection/batch 两个 sticky boolean 及 TTL；修正 live SDK executor 和 turn orchestrator，不只改 dormant parity。
- 新增 `site_research` 工具面；batch narrow surface 只用于冻结后的持久保存。
- 移除 `browser_collect(research|start)`；修复 `resolveTaskTypeFromToolDefinitions()`，工具“可见”不再决定 task type。
- 建 canonical action contract registry，原子覆盖 `browser_research/collect/download/task` 的 schema、必填规则、typed parser 与 operation；其余公开工具保留现有执行入口，但把 R4 已确认漂移全部收口，并由自动枚举门禁保证公开 schema 能表达 handler 的最小合法调用。不得为了“全量统一”重写与本事故无关的 28 个执行器。

Gate：精确任务与至少 20 组正反例通过；OpenAI/Anthropic 实际 wire schema snapshot 可调用；任一公开 handler 必填字段不可从模型 schema 消失。

### Phase 2：修正浏览器任务身份与派生投影

- 持久化 created-by 与 active execution binding 的明确字段/版本合同；如需 migration，先写 native migration test。
- projection `runId` 与 active binding 同源；resume 原子换绑，旧 revision 不覆盖新 run。
- runner 改为先写 browser task 真值，再由 coordinator 派生 projection；优先泛化现有 `pending_projection_syncs` 重试账本和启动对账，只有行为测试证明其载荷或终态语义不能安全承载 browser task revision 时才允许替换，禁止并存第二套重试真值。
- 保留 repository 的 mismatch 保护，不删除、不放宽。

Gate：真实 Electron/better-sqlite3 repository 覆盖 create、progress、terminal、resume、restart、旧事件竞态；零 skip。

### Phase 3：实现可续跑站内多关键词研究

- 新建站内研究 runner 与 current-site search primitive；复用 BrowserActionExecutor、SnapshotService、trusted input、origin budget 和既有 tab/session 服务。
- 完成 query -> cards -> metrics -> details -> aggregate checkpoint 状态机。
- 以小红书 current-origin adapter/fixture 完成本次生产事故；未适配站点明确失败，URL 集研究保持通用。后续站点必须新增 adapter，不得用外部搜索 fallback，也不得绕过统一执行器。
- TaskEventBridge 只发布任务投影；完成后的 Owner/UI 从 canonical task/projection readback，不保留 pending narration/continuation，也不启动无用户输入的新 turn。

Gate：本地受控站点夹具完成 18 query、重复 URL、多 query 命中、详情缺失、登录墙、429、重启恢复与用户接管。

### Phase 4：完成判定与用户可见状态收口

- 接入 browser research essential-output floor。
- 工具失败 proof 不再满足成功 criteria；保留失败诊断可见性。
- 修正 `adjudication_degraded` 的 phase/status 映射：必要输出不满足时不得投 completed。
- 结果卡展示 query 覆盖、候选数、详情覆盖、暂停原因和继续入口；不把后台句柄冒充内容结果。

Gate：0/18、1/18、17/18 有断点、18/18 有正文、18/18 无互动指标五个矩阵的状态和文案全部正确。

### Phase 5：设置确认后的无感续跑与诊断补齐

- 保留 provider 工具能力 gate；用户确认“启用并继续”后，旧 run 仍结束，但系统可用原始 verbatim request 创建一个全新的 run 自动继续，不要求用户再手打一遍。
- 自动新 run 必须重新读取 profile/provider/model/toolUseMode，绑定同 scope/task，且幂等防双发；拒绝、超时、配置漂移仍不启动。
- 持久化 browser route/schema/task linkage 摘要与 projection retry metric。

Gate：disabled -> confirm -> new run 只有一次；旧工具面不复活，原始 18 queries 不丢、不改写。

### Phase 6：总回归与真实 Electron 验收

按顺序运行：

1. 受影响 focused tests。
2. `npm run verify:browser-surface`。
3. `npm run verify:browser-lane`。
4. `npm run verify:browser-reliability`。
5. `npm run verify:browser-native-lock`。
6. `npm run verify:native`。
7. `npm run verify:stability`。
8. `npm run typecheck`。
9. `npm run test`。
10. `npm run build`。

工作区在本计划开工前已有文档性能、文件监听与版本记录改动。它们不与本轮浏览器改动混写或顺手重构；最终提交前必须分别跑其既有专项 gate，并按可独立解释的提交边界提交。任何无法通过验证的既有改动不得借本轮提交掩盖。

不新增与现有职责重复的 `verify:browser-*` package script；新测试挂入上述现有 gate。

真实 Electron 使用隔离测试 profile 与已登录的小红书测试账号，执行两类任务：

- **本次原始 18 关键词任务**：保留账号主页，逐词搜索，输出证据和正文，再做账号适配分析；不下载、不发布、不评论。
- **真正的批量持久任务**：`把这个博主的每篇笔记都保存图片`；仍应走冻结清单 + 后台四工具面，证明修研究没有破坏现有采集。

验收记录必须含：运行 ID、最终 wire tool names/schema hash、browser task/revision、18 query 覆盖、详情覆盖、平台挑战/429 状态、projection/run 终态、真实结果截图或报告。缺少外部测试账号时只能标“实现门禁完成、发布前站点验收待办”，不得宣称整阶段完成。

## 6. 文件级改动地图

以下是计划中的主要落点，实施时以 live 调用链为准，不顺手重排相邻模块：

| 文件 / 新模块 | 目标改动 |
|---|---|
| `src/shared/browser-collection-intent.ts` | 退役布尔 collection/batch 语义；由新的 typed work intent 取代 |
| `src/shared/browser-work-intent.ts`（新） | 明确 kind、site surface、queries、persistence 与角色 |
| `src/shared/browser-tool-surface.ts` | 32 项清单、新 `site_research` intent 和窄面 |
| `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts` | live 工具面按 typed intent 收敛；不再 batch 误删研究工具 |
| `src/main/modules/agent-control/runtime-core/agent-sdk-foundation-utils.ts` | task type 不再由 `browser_collect` 是否可见推导 |
| `src/main/modules/tools/browser-action-contracts.ts`（新） | research/collect/download/task 的公开 schema、required rule、typed parser、operation 单一真值；其余工具接入一致性枚举，不强制重写执行器 |
| `src/main/modules/tools/schemas/browser-tool-schemas.ts` | 从合同生成 32 个真实 provider schema；删除假 payload/start/research mode |
| `src/main/modules/tools/browser-tool-invocation.ts` | 只接收 typed public request；trusted context 分流 |
| `src/main/modules/tools/browser-collection-tools.ts` | 删除 research/start public cases；collect/download/task 改用 typed request |
| `src/main/modules/tools/browser-act-tools.ts` | `browser_search(scope=current_site)` 与 schema 外字段清理 |
| `src/main/modules/tools/browser-observe-tools.ts` | wait/resources/status 等已确认参数漂移收口 |
| `src/main/modules/browser-engine/browser-site-research-runner.ts`（新） | 多 query 站内研究状态机与 checkpoint |
| `src/main/modules/browser-engine/content-task-runner.ts` | 只注册/调度 site research；不继续堆具体流程 |
| `src/main/modules/browser-engine/task-persistence-service.ts` | browser task revision、创建来源、当前执行绑定和 research result |
| `src/main/modules/claude-bridge/browser-collection-projection-sink.ts` | 改为从 task 真值派生；runId 与 binding 一致 |
| `src/main/modules/repositories/task-projection-repository.ts` | 保留现有 mismatch invariant；增加真实集成测试，不放宽 |
| `src/main/modules/agent-control/runtime-core/run-finalizer.ts` | essential-output floor 与失败 proof 语义 |
| `src/main/modules/agent-control/task-projection/run-coordinator.ts` | degraded 终因只在领域输出地板通过时进入 done phase |
| `src/main/modules/agent-control/task-projection/task-projection-sync.ts` | degraded 状态不再无条件映射 completed |
| `docs/architecture/current-runtime-contracts.md` | 实施完成后更新 31 -> 32、研究/采集边界、projection 身份与完成合同 |

## 7. 测试与门禁矩阵

### 7.1 意图与工具面

- 精确原任务 -> site_research、18 queries、非 persistence、非 batch。
- `分析这个小红书账号并给选题` -> observation/site research，不含 download。
- `整理这些爆款笔记的标题和内容` -> research，不因“整理”进入持久采集。
- `把这个博主全部笔记保存图片` -> persistent batch。
- `下载当前这一张图片` -> 单页 download，不是 batch。
- `继续` 在原 research task 上 -> 继承 18 queries；在 batch save 上 -> 继承 frozen task；两者不串。
- 否定表达 `不要采集，只分析` -> persistence=false。

### 7.2 schema -> provider -> invocation -> handler

每个公开 action/mode 都跑四段同一 fixture：

1. canonical public schema 能表达最小合法调用。
2. OpenAI/Anthropic wire schema 中字段和 required 规则仍存在。
3. provider 风格 JSON 经 tool executor 后解析成正确 typed operation。
4. handler 使用同一个 typed request，不读取未声明模型参数。

同时有反向 gate：internal-only 字段 `kind/payload/executionBinding/allow_partial/unrelated_to_collection` 不出现在模型 wire schema。

### 7.3 研究 runner

- 18 query 全覆盖，不受全局 `maxPages=6` 截断。
- 同一 canonical URL 命中多个 query 时只深读一次，保留全部归属。
- 结果卡只有标题时不冒充正文；没有 engagement 时不冒充爆款。
- 页面导航壳/侧栏污染不得进入结果。
- 真实空结果、内容未加载、登录墙、验证码、429 分别得到不同状态。
- 第 9 个 query 后重启从第 10 个继续；已完成项不重复。
- 用户接管后续跑同一 browserTaskId，active execution binding 更新为新 run。

### 7.4 projection 与终态

- 真实 SQLite create/progress/complete/resume 全程满足 binding invariant。
- projection 写失败时 browser task 不失败；retry 后卡片追上最新 revision。
- 旧 revision 晚到不覆盖新 resume run。
- 0/18 + 多个错误回执 -> failed/recoverable，不是 completed。
- 18/18 卡片但 0 详情，而用户要求内容 -> 未完成。
- 18/18 有详情但部分无互动指标 -> 可完成“内容整理”，但输出不得标“爆款已核验”；若“爆款”是必要要求则降级可见而非绿色通过。

### 7.5 同类工具合同普查

除本次三项外，必须逐一关闭本计划 R4 表中的现有漂移。门禁从 32 工具 manifest 与 schema 自动枚举；研究、采集、下载、任务查询新增 mode 时若没有 schema、required rule、typed parser、handler 和行为 fixture 中任一项，CI 直接失败。其他工具至少必须有可表达最小合法 handler 调用的 schema fixture；迁入 canonical registry 不是本轮完成条件。

## 8. 实施后文档裁决

前一份 `2026-07-17-browser-tool-surface-and-hardening-implementation.md` 中以下两项由本计划覆盖：

1. “公开目录固定为 31 个语义工具”改为“当前 32 个；数量不作为 KPI”。
2. “`browser_research_topic` 内化后由 `browser_collect` 覆盖所有研究”改为“旧名退役；新增 `browser_research` 承担必须使用当前浏览器会话的站内/URL 集研究，`browser_collect` 只承担按页、按清单或按结构采集，不承担跨查询研究”。

继续有效的合同包括：BrowserActionExecutor、统一 Snapshot/ref、可信输入、下载 session/流式/原子发布、单写者、可视指针、提示生命周期、用户接管、安全确认只用于真正高风险动作，以及不以域名一刀切禁用能力。

## 9. 已确认的开工顺序

用户已于 2026-07-18 确认本计划。严格按 Phase 0 -> 1 -> 2 -> 3 -> 4 -> 5 -> 6 推进。任何阶段若只修掉当前错误文本、却没有让对应红测从真实 provider/repository 路径转绿，不得进入下一阶段；真实小红书验收未完成时，不得用本地夹具替代发布结论。

## 10. 实施记录

| 阶段 | 状态 | 证据 |
|---|---|---|
| Phase 0 事故合同 | completed | 原始 18 个关键词、账号评价子句、错误 batch 路由、缺失公开参数、投影身份冲突和 0 交付假完成均固定为回归用例。 |
| Phase 1 意图与公开合同 | completed | 新增独立 `browser_research`，公开工具面为 32 项；原任务解析为 `site_research`，18 个查询保序且不再打开持久采集/下载面。自然中文单关键词、多关键词、带或不带冒号/逗号的当前站点研究均有正例，普通网页搜索与否定表达有反例；公开 schema、provider wire、typed invocation 与 handler 必填字段由同一组合同覆盖。 |
| Phase 2 身份与投影 | completed | 浏览器 task、创建 run、当前执行 binding 和父任务分离；真实 SQLite migration/native gate 通过。同 owner + scope 的后续主任务可以凭显式 task id 纯读取状态，只有执行/续跑才原子换绑当前 run 与父任务。投影 revision 单调递增，CAS 冲突可见；任务写入与投影并发时会按最新 revision 自动重投，不让旧投影反杀真实任务。 |
| Phase 3 研究 runner | completed | 站内研究主流程已从通用 content runner 拆到独立任务主机；受控 18-query 场景覆盖顺序执行、重复 URL、多词命中、详情缺失、中英文登录/挑战、429 限流、暂停、恢复、接管与中止。续跑复用已冻结 query 结果和详情进度，不清零已完成查询；直接小红书文章 URL 已经生产 `TabSession` 路径证明会立即走详情抽取，不再等待列表页条件；完整 18 URL 集不会被默认页数截断；单次任务内重复详情失败会复用结果。agent tab 提前丢失和 lease 冲突分别投影为不可续跑终止与可续跑暂停。 |
| Phase 4 完成真相 | completed | 错误回执不再满足成功证据；0/18、部分 query、缺正文、缺互动指标和可恢复断点均按真实状态显示。未深读候选标记明确原因；登录/验证码、限流、终止性参数/profile/站点/结构失败分别投影，不能继续的任务不再给出虚假继续入口，也不把后台句柄或失败工具调用投成绿色完成。 |
| Phase 5 确认后续跑 | completed | provider 工具关闭时仍先确认；确认后只创建一次新 run，重新读取当前配置并保留原始 18-query 请求，拒绝、超时和配置变化不会误启动。 |
| Phase 6 本地与成品门禁 | completed | 修正后的研究与工具合同专项、`verify:browser-surface`、`verify:browser-reliability`、`verify:browser-lane`、native-lock、`verify:native`、`verify:stability`、全量 `verify` 与 production build 均通过。按最终代码重建的 Ready 0.7.5 应用、ZIP 与 DMG 已通过版本、arm64 架构、Applications 入口、包内独立 worker、deep/strict 签名、只读挂载和隔离资料启动检查；DMG 为 246,196,051 字节，SHA-256 为 `0bb505a3af3420d3853ba5753d8c664e073e295fa2b472db29fb6110d72c4408`，ZIP 为 240,103,766 字节，SHA-256 为 `3720946eaad768162ea3cb201f67beb3e86c9adf2ccdddadd4b26a1617b49e7b`。同一对抗复审者已对全部差异与成品明确裁决 `PASS`，本阶段关闭。 |
| 已登录小红书真站 | completed | Ready 0.7.5 真实 Electron 会话在已登录目标账号页运行原始 18 个关键词，生成单一 `site_research` 任务 `browser-task-9f92b1f6-5c1d-46e6-a3eb-2f84f0f224d8`，没有再逐词打开标签。账号读取先形成 8 条可见内容的 evaluation receipt；18/18 查询完成、0 个查询失败、108 条候选均有页面可见互动指标。验收脚本曾误关专用标签，原任务用持久断点换绑新标签后继续，已完成结果未丢失。详情页最终未暴露可核验正文，因此 `detailCount=0`、`missingEssentialOutputs=["body"]`，任务按合同标为 failed 而非绿色完成；没有把标题或结果卡冒充正文。 |
| 显式选技后的状态复查 | completed | 在新的父任务 `req-ready075-xhs-skill-status-proof-1784316142240` 中显式选择社媒运营技能后，最终工具面保留 `browser_research`、`browser_task` 与 `browser_request_takeover`，并继续抑制不属于当前站内任务的通用网页研究。Agent 只调用一次 `browser_task(get)`，没有重搜、续跑、页面操作或标签扩散；它准确回报 18/18、108 条候选/互动数据、8 条账号证据、0 正文及 failed/可继续状态。 |

## 11. 当前裁决

代码、数据合同、迁移、状态机、失败语义、修正后全量门禁、已登录真站验收和按最终代码重建的 0.7.5 成品已经完成。真站结果证明 18 个查询会进入同一可恢复研究任务、目标账号证据先于适配判断产生、候选互动数据可追溯；同时也证明当站点不提供详情正文时，系统会明确拒绝绿色完成，不把本次未取得的正文伪写成研究交付。同一对抗复审者已对全部阻断项和最终成品明确给出 `PASS`，本计划完成。
