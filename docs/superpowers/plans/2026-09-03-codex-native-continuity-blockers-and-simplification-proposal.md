---
title: Codex 原生连续性实施：阻塞根因、ChatGPT runtime 对照与修复/精简提案
date: 2026-09-03
status: proposed
review_status: changes_requested_round3_addressed
enforce: false
scope_of: docs/superpowers/plans/2026-09-01-codex-native-continuity-terminal-and-reply-surface-implementation.md
revision: 4
prior_reviews:
  - ../audits/2026-09-03-codex-native-continuity-proposal-independent-review.md
  - ../audits/2026-09-03-codex-native-continuity-proposal-revision-3-review.md
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：固定历史证据仍引用此路径。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# Codex 原生连续性实施：阻塞根因、ChatGPT runtime 对照与修复/精简提案

> 本文只做诊断与提案，不是验收记录，也不是实施授权。原计划仍是权威合同。
> **Revision 4**：Revision 3 的范围选择（先做第 1–2 步）获[复审](../audits/2026-09-03-codex-native-continuity-proposal-revision-3-review.md)支持，但其 §4.1 文字被判定不可直接开工。本版按复审的两项 P1 重写了入口修复合同：**Renderer 保留当前事实采集、只停止资格重判**；**"继续 / continue / resume"的语义拆分并入第 1 步**。并补入最小验收合同与权威合同的同步修订项。变更记录见 §12。

## 0. 结论（Revision 4）

1. **Stage 1（回复呈现）已落地可验证**；**Stage 2/3（same-thread 连续性、accepted-prefix fork）主体已落地**。
2. **P0 成立且未解决**：raw ambient anchor 与 activated 当轮资源在链路上被两套规则消费，导致 exact Retry 在产品目标场景 100% 不可用（两条红测持续复现）。
3. **Revision 2 推荐的方案 C（native rollback + 重发）已撤回为推荐**。复验确认：
   - **在不改变当前 Stage 3 收口/后继机制的范围内，C 与 P0 的作用域不相交**。今天按钮只在 `historyKind === 'diverged'` 时出现；而 divergence 收口**在失败当时就已经**退役源 thread 并创建后继。此时"撤回当前 head 的最后一轮"撤回的是**已接受前缀 A**，不是失败轮 B。C 的真实作用域是 `continuation_safe`——恰好是今天被 `same_thread_history_retained` 判为 not applicable 的那一类。**C 是新增第二条重试路径，不是简化。**
   - C 的三处技术前提也不成立：重放字段不完整、"同一事务"不可实现、ChatGPT 的权限重解析是条件性的。
4. **推荐路径**：先做 B 中针对已证实矛盾的最小修复 + 发送状态恢复；C 补齐设计与 Ready 集成门后再单独探测；A′ 撤回其"防重复"承诺。
5. **不建议**把第 0–6 步作为整体前置批准。逐步判断见 §9。

---

## 1. ChatGPT / Matrix runtime 取证（Round 1 与 Round 2 双重更正后）

### 1.0 取证范围

| 证据 | 标识 |
| --- | --- |
| App | `/Applications/ChatGPT Matrix Runtime.app`，`26.831.21537` |
| Runtime | `codex-cli 0.152.1`，`sha256 99a6fdb0e0f9188e62dd6681c7ed3c5cc343358291a53ea21a9d4202e09cde9e` |
| Ready pinned | `codex-cli 0.149.0`，`sha256 f4a74117b8142cda581c95ff753abf4508b5636d89682c1ed77e4a9249af8963` |
| Electron 壳 | `.vite/build/src-B8dS-jjl.js` `0071792f…`、`main-7MZ5kTIG.js` `cdcc7ab2…` |
| 产品前端 | `webview/assets/app-initial-b09f80199db1.js` `1158d2df…`、`app-primary-699b5b6c9679.js` `fe030fae…` |
| 覆盖率 | `app.asar` 共 9092 项，其中 7927 项在 `/webview/`。**本文不声称已审完全部资产。** |

**方法论纪律（第一版违反，已写入结论）**：对第三方安装包做"它不做 X"的否定性断言，必须先枚举全部可执行资产并声明覆盖率。第一版在 2% 的 JS 上做了五条否定性断言，四条是反的。

### M1 协议面（经 Round 2 再次收窄）

稳定 schema 对稳定 schema：`ThreadForkParams` 只多 `excludeTurns`；`TurnStartParams` 只多 `serviceTierForTurn` / `toolOutput` / `turnTrigger`。`lastTurnId` 描述逐字节相同。

但 Revision 2 的"0.149 没有 revert / 分页读取，0.152 才新增"**错**——它把稳定 schema 当成了整个协议：

| 方法 | 0.149 stable | 0.149 **experimental** | 0.152 stable |
| --- | --- | --- | --- |
| `thread/rollback` | 有 | 有 | 有 |
| `thread/revert` | 无 | **有** | 有 |
| `thread/turns/list` | 无 | **有** | 有 |
| `thread/items/list` | 无 | **有** | 有 |

且 Ready 初始化本就发送 `experimentalApi: true`（`codex-app-server-client.ts:629`）。

**但仍不能据此直接使用 revert**：`ThreadRevertParams` 描述明确为 *"Replace a **paginated** thread's durable history…"*，而 Ready 全仓无 `historyMode` / paginated 概念（`grep` 零命中），仍走 legacy 全量 `thread/read`；生产封装与出站合同也未接入该方法。

→ §5、§10 已相应改写：adoption 决策依据是**历史模式 + 接口稳定性 + 客户端封装 + 黑盒证据**，不是"下次升级必须无条件换成 revert"。

### M2 `thread/inject_items`（Revision 1 断言已撤回）

wire method 是 snake_case `thread/inject_items`（Revision 1 grep 的是 JSON-Schema 的 title，故得 0 命中）。ChatGPT 在 `thread/fork` 之后立即注入 boundary items（`app-initial @2782313`）。该方法在 Ready pinned 0.149 中也存在。

→ ChatGPT 的历史交接形态是 **fork + 向 child 注入 boundary items**，与 Ready Stage 3 结构同型。原计划"禁止用 Ready UI 消息重建完整模型历史"仍成立（那是关于**注入什么内容**的约束），但不得再以"ChatGPT 不用它"为论据。

### M3 主对话面的 turn 失败不换 thread（收窄后成立）

"整个壳层没有 failure → new thread 路径"**错**：`src-B8dS-jjl.js @1208347` 的 `h0({… fallbackToFreshThread = !0 …})` 在 fork 抛错时默认落到 `startThread`；`threadSource` 取值含 `agent_forked_thread` / `codex_replay` / `subAgentThreadSpawn`，`'user'` 只是省略时的默认。

**仍成立**：主对话面的 turn 失败不换 thread，失败以 typed error 上报，下一条消息仍 `turn/start` 到同一 threadId。

→ 不得再用作 §7 I-11 的论据：Ready 的 `diverged` 判定针对的是自家 Gateway seam 是否在 wire 上留下部分字节，这是 ChatGPT 壳层结构上不存在的失败类别。

### M4 ambient 上下文（Revision 1 断言已撤回）

ChatGPT **会**自动挂载：普通 composer 提交路径解析 `ideContext` 与 `inAppBrowserContext`（`app-primary @7527755`），`Pqn`（`app-initial @3601319`）把它们拼进模型可见 prompt（`# Context from my IDE setup: / ## Active file: / ## Active selection of the file: / ## Open tabs:`）。`isAutoContextOn` 是持久开关（composer footer `ideContextIndicator`，"Include context from IDE such as selection state and open files"）。

→ 不能用 ChatGPT 论证"ambient 观测不是资源"。Ready 的依据是两边**事实形态不同**：

| | ChatGPT `ideContext` | Ready `currentDocumentAnchor` |
| --- | --- | --- |
| 作用 | 拼进 prompt 文本 | 产生 resource authority + capability floor + 工具授权 |
| 撤销成本 | 少一段文字 | 少一层权限 |
| 用户控制 | 一个持久开关 | 无开关，由 Main 文本分类器推断 |

§3 的 P0 不依赖 M4，三名审查者均确认其独立成立。

### M5 ChatGPT 的失败/重来有三条不同路径（Revision 2 的单一化已撤回）

Revision 2 把 `editLastUserTurn` 提升为"同一需求的答案"，过度。同一安装包中至少三条：

| 场景 | 调用链 | 历史处理 |
| --- | --- | --- |
| 编辑最近一条用户消息 | `pas → editLastUserTurn → don`（`app-initial @2776999`） | revert/rollback 后重发**编辑后**的 input |
| 服务器过载后的手动/自动重试、恢复中断任务 | primary `hyr`（`@6796013` 后）/ `resume_interrupted_task`（`@7473406`）→ `Et` → initial `fas → startEmptyTurn → Qsn`（`@2825087`） | **默认 `input: []`，延续原 thread，无撤回步骤** |
| 安全缓冲中的模型重试 | `qsn`（`@2821711`） | 精确中断当前 turn 后 rollback，再重发原参数并替换模型设置 |

`don` 的细节也需更正：Revision 2 称"重发前当场重新解析权限"，实际是**条件性的**——`h = n.shouldSendPermissionOverrides ? tw((await sendRequest('config/read',{cwd})).config) : null`，否则沿用现行 thread 默认设置；且该读取发生在历史修改**之前**。它不能证明 Ready 的资源身份、技能选择、输出义务与 ceiling 都可按 ordinary 规则替换。

**空输入续跑对 Ready 不可直接借鉴**：Ready 现有合同已记录空 input 无 `userMessage` 身份、无法按现行 `clientUserMessageId` 完成启动归属核对，并明确拒绝该路径（`assets/codex-runtime/contracts/runtime-contracts.json`，`turnClientIdentityExtractionContract`）。研究时应把它纳入对照，不得借旧 successor 枚举名义跳过现行边界。

**关于 attempt-kind**：`turnTrigger` 即上游的 attempt-kind，实测取值含 `edit_user_message` / `safety_buffer_retry` / `resume_interrupted_task` / `app_update_resume` / `plugin_suggestion_connected` 等。Revision 2 曾提议把 Ready 的 `attempt_kind` 收成单值 `'user_ingress'`，**已撤回**——上游在扩张该概念。

### M6 桌面产品库（Revision 1 断言已撤回）

`src-B8dS-jjl.js @543677` 迁移链（v1…32）建表 9 张，含 `local_thread_catalog`（镜像 runtime 的 thread 身份/顺序/来源，配 `local_thread_catalog_sync_state` + scan checkpoints + `last_full_reconciled_at` 的显式对账合同）与 `thread_timeline_ledger`（逐 turn append-only，含 `voice-work-terminal{sessionId,turnId,status}`、`presentation-committed{…}`）。另有第二个库 `codex-thread-summaries.db` 的 `thread_turn_summaries`。

→ 结论与 Revision 1 相反：ChatGPT **确实**镜像 runtime 可回答的事实，靠**显式对账合同**而非"拒绝持久化"来约束。可引用的判据因此是：

> **新增持久字段必须在同一提交里给出 live 或 boot 消费者，或给出与 `local_thread_catalog` 同级的显式对账合同；两者皆无则不得落库。**

---

## 2. 当前实测状态

| 项 | 实测 | 命令 |
| --- | --- | --- |
| 类型检查 | 通过 | `npm run typecheck` |
| 默认文档 handoff 等四组 | **12 pass / 2 fail / 0 skip** | 独立审查复现，两条默认文档红测持续失败 |
| turn input builder / head projection / action-surface event bridge | 30 pass / 0 fail | — |
| e0 contract tests | 18 pass / 0 fail | 结构 gate 在运行 |
| 精选 Electron/SQLite（divergence 后继、首轮 fresh root、历史交接、工具面变化阻断） | 4 pass / 0 fail | — |
| silent-catch 门 | 工作树 **182**；HEAD **184**（先存债） | `node scripts/check-silent-catch.cjs` |
| `verify:codex-runtime-e0r` | 冻结 capture 0.146.1 与固定 0.149.0 冲突，2 fail | — |
| 工作树 | 289 个已跟踪文件（+18465 / −5979）、95 个未跟踪路径、**0 次提交** | `git diff --shortstat` |
| 大文件 | repository 10096、composition 5019、schema 2952、useAgent 2282 | `wc -l` |

---

## 3. P0：raw ambient anchor 与 activated 当轮资源的分裂

### 3.1 事实

`currentDocumentAnchor` 有两种语义：

- **(a) 环境观测（raw）**——`codexCurrentDocumentAnchor.ts:36`：只要 `workbenchMode === 'document' || splitMode === 'document'` 且有 focused tab 就产出；默认空白文档同样产出。
- **(b) 当轮资源（activated）**——`composition.ts:3433-3437`：只有 `hasCurrentDocumentTarget || hasExplicitCurrentDocumentAccessIntent(intentText)` 且无排除词时才成为当轮资源（分类器在 `codex-product-turn-authorization.ts:324`）。

**下游消费 (b)**：`exactRetrySourceFacts`（`codex-exact-retry-eligibility.ts:3-17`，读的是已存库的过滤后 anchor）、`classifyUncommittedOriginPolicy`（`codex-history-continuity-policy.ts:38-46`）、Main 的 `currentResourceEmpty`（`composition.ts:3810-3817`）。

**Retry 入口消费 (a)**：`agent-send-orchestration.ts:170-177`、`explicit-retry-routing.ts:44-52`、`codex-explicit-retry-control.ts:61-63`、`composition.ts:3358`。

三名独立审查者均确认该分裂真实存在且不依赖任何 ChatGPT 证据。

### 3.2 后果（准确范围）

- **document mode（含 browser + `splitMode='document'`）**：source 因过滤后 anchor 为 null 而合格 → projection 写 `retry_failed_task='ready'` → 按钮出现 → 点击必被 raw anchor 拒绝。**"可用"与"可执行"互相矛盾**，两条红测复现。
- **browser mode**：`resolveBrowserExecutionPageRef`（`codex-browser-admission.ts:186`）需 `isCompletePageRef`（`:76-86`）。环境降级路径（`runtime.ts:1470` 无 browserController、`trusted-browser-environment.ts:24` 无活动标签、`:26-28` 缺 token、`runtime.ts:1473-1478` degraded）下 `executionPageRef === null`，Retry **确实可一路走通**。
- 因此准确表述是：**产品目标场景 100% 不可用；只在浏览器环境降级这一非目标状态下可达，且从无安装态证据覆盖过那条路径。**"从未执行过的生产代码"是过度断言，已撤回。

### 3.3 P0 位于 diverged 路径 —— 在不改变 Stage 3 的范围内它不能用 rollback 修

`resolveExactRetryEligibility` 只在 `historyKind === 'diverged'` 时返回 `ready`；`continuation_safe` 被 `same_thread_history_retained` 判为 not applicable。

而 divergence 收口**在失败当时**就已经：退役源 thread（`codex-binding-repository.ts:7084` 附近的 `continuation_blocked / retired = 'publication_diverged'`）、创建 `native_fork` 或首轮失败的 `fresh_root_with_tail` 后继（`:7144` 附近）、并安排源 thread 归档。

因此按钮可用时，当前 head 是**后继**，其中含已接受前缀 A 而**不含** B。任何"撤回当前 head 最后一轮"的操作撤回的是 A。**这是 Revision 2 方案 C 的致命缺陷。**

---

## 4. 推荐路径：入口修复（Revision 2 的 B-1~B-5 与 Revision 3 的 §4.1 均已作废）

> 独立审查明确指出：不得把 B 的旧文字当作已审过的实施合同。以下是重新表述的目标与约束，**实施前仍需按每项单独设计与评审**。

### 4.1 入口修复合同（按 Revision 3 复审重写）

**Revision 3 的 §4.1 已作废。** 它把"原轮唯一事实"与"本次点击的最终检查"混成一件事，并要求 Renderer 停止采集 ambient 事实——而 Main 的可信环境接口在 document 模式下只返回 `{ workbenchMode }`（`runtime.ts:1465-1477`），**没有第二条当前文档来源**。照那样改，§4.2 要求的完整 current facts 就永远拿不到；原轮没文档、点击时新开了文档或分屏，会被误判成"当前环境仍为空"。

替换后的六条：

1. **单一生产点按"每次 Main prepare"定义，而不是"某一个 ordinary run"。** 原 ordinary run 的解析结果只承担 **source facts**；本次 Retry 的 **current facts** 必须在持久化前、从**本次观测**解析。source facts 不得替代 current facts。
2. **复用已有准备记录，不新增同义字段。** 该轮激活结果继续由过滤后的 `prepared.ingress.currentDocumentAnchor` 表示（`codex-product-run-preparer.ts:879` 附近的 ingress 结构）。不新增并行的 activation 标志、摘要或第二套状态——那正是本文反复批评的"同一事实多个真相"。
3. **Renderer 保留事实采集，只停止资格重判。** 最小方案：沿用现有原始观测传递路径（`codexCurrentDocumentAnchor.ts:34` 采集 → `agent-send-orchestration.ts:281` 传递），**删除的是"有 raw anchor 就阻断 Retry"这条判断**，不是采集本身。普通发送的采集路径保持可用。若将来要把采集职责移出 Renderer，必须先给出可工作的等价可信来源。
4. **Main 先校验控制请求与来源，再用原任务根 B 与本次观测判定 activation。** 判定用的 intent text 是 source B（现有 `composition.ts:3425-3428` 已如此），**不使用控制文本 R（"再试一次"）**。只有**未激活**的 ambient 观测不构成本轮资源；真实激活目标、显式资源、附件与完整浏览器 page ref 仍受当前规则约束。
5. **两处提前拒绝点必须同步修改。** `codex-explicit-retry-control.ts:61-63` 与 `composition.ts:3358` 在 activation 之前就拒绝任何 raw anchor；只改 ordinary 侧的 activation producer 修不了它们。改法是把判据从"raw anchor 存在"换成"activation 结果非空"，且顺序必须是"先校验控制请求与来源 → 再解析 activation → 再判资源"。
6. **source / current 两组事实分别检查。** source 从不可变准备记录读取；current 从本次准备结果读取。**缺少 current facts 时拒绝，不得默认 true**（这正是 §7 I-1）。工具定义、执行权限上限、记忆、最新 head / 失败来源与最终提交核对全部保留。

全链仍然只有**一条**判定规则，每次 prepare 用当次输入执行一次；不是让多个下游各自重新分类。

**必须覆盖的场景（缺一不可）**：默认空白文档、document 分屏（`splitMode`，前三版都漏）、正常浏览器页面、无页面/降级浏览器、显式资源非空。

依据是 Ready 自身的授权语义（§M4 表格），不是 ChatGPT 的做法。

### 4.2 "继续"与"重试"的语义拆分（并入第 1 步，不可延期）

`matchesResumeIntent(text, 'strict')` 的词典（`resume-lexicon.ts:96`）同时包含 `继续 / continue / resume` 与 `再试一次` 家族，而 **Renderer 路由**（`explicit-retry-routing.ts:46`）与 **Main 控制请求校验**（`codex-explicit-retry-control.ts:56`）都用它。

今天 raw anchor 拦截把这个问题掩盖了。**§4.1 解除拦截后它会立刻进入常用场景**：复审直接调用两个真实入口取得的反例——

| 输入 | 现状（raw ambient 拦截） | 解除拦截后 | Main 控制校验 |
| --- | --- | --- | --- |
| 再试一次 | 不转 Retry | 转 Retry | 接受 |
| 继续 | 不转 Retry | **转 Retry** | **接受** |
| continue | 不转 Retry | **转 Retry** | **接受** |
| resume | 不转 Retry | **转 Retry** | **接受** |
| 重试并总结另一个网页 | 不转 Retry | 不转 Retry | 拒绝作为控制消息 |

**因此 I-7 是第 1 步的依赖项，不是可延期的清理。** 要求：Renderer 与 Main 共用**同一个**明确的 exact-retry 判定入口；`继续 / continue / resume` 与任何带新要求的正文都不得自动绑定为原任务重发；按钮仍通过精确失败来源发起重试。**只改 Renderer 不成立**——Main 仍会接受旧语义。

### 4.3 同步修订权威合同（不可省略）

原计划 §9.1 / §9.2 现在仍写着 raw anchor 必须缺席、当前同类字段必须为空且不得静默清除。**不能一边声称旧条款逐字不变、一边声称默认文档重试已修复。**

修订为：**原始观测可以传递供 Main 判断；作为本轮资源的激活结果必须为空。** 保留"显式资源不得被剥离/静默清除"的限制不变。修订与实施在同一提交内完成。

### 4.4 补齐已证实缺失的合同项

- **事实可用性区分**（§7 I-1）：`resolveExactRetryEligibility` 的 `currentFacts?:` 改为可辨识联合，杜绝 projection 用硬编码 `true` 冒充"已知为真"。
- **缺失的 blocker**（§7 I-10）：`same_thread_failed_turn_restatement_required` 与 `compacted_failed_turn_restatement_required` 在源码零命中，被压成单一 `same_thread_history_retained`。补齐时须按**真实覆盖事实**给出两个不同 blocker，**不能只改常量名**。
- **动作面读取失败后的恢复**（§7 **I-6**）。
- **`consequence` 的 composer 展示**（§7 I-2）：最终提交须重新核对所展示集合，不默默扩大省略范围。

### 4.5 第 1–2 步的最小验收合同

以下 Retry 正例均以原任务满足零执行、零资源等资格、且当前 head / 来源有效为前提。**先写进实施合同，再落行为测试。**

| 场景 | 必须观察到的结果 |
| --- | --- |
| 默认空白文档、原任务不指向当前文档 | 自然语言重试与按钮都到达 Main；inactive 观测不成为资源；原任务输入恰好一次 |
| browser 主模式 + document 分屏 | 文档观测与浏览器页面分别判断；无正常 page ref 且文档 inactive 的合格情况可重试；有完整 page ref 仍拒绝 |
| 正常浏览器页面 / 无页面或降级 | 正常页面**保留**资源阻断；无页面只满足这一项条件，不能绕过其余资格 |
| source 有资源 / current 新增真实目标、附件或显式资源 | 分别拒绝；**缺失 current facts 也拒绝**；不清空草稿、不剥离选择、不产生新 run 或 Provider 请求 |
| 原轮结束后观测变化 | 用原任务 B 与本次观测判断；旧 source 的空资源事实不能替代 current；**不得使用控制文本 R** |
| 「继续 / continue / resume」与「再试一次」 | 前者按普通用户输入处理；后者仅在完整资格满足时绑定失败来源；**两端判定一致** |
| `native_fork` / `fresh_root_with_tail` | 两类现有后继入口均跑通；保留正式 tail assignment，失败原任务不得重复交付 |
| 同 thread 保留失败输入 / 后来被压缩覆盖 | 均保持不提供 exact Retry；按真实覆盖事实给出两个不同 blocker |
| 动作面读取失败后恢复 | 无需换会话或重置即可重读；草稿保留；恢复只刷新状态、不自动重发任务；旧读取不得覆盖新 scope/epoch/版本 |
| consequence 展示后集合发生变化 | 最终提交重新核对所展示集合；不默默扩大省略范围 |

安装态证明继续使用原计划的具名脚本 `scripts/run-codex-context-continuity-installed-proof.mjs`，补齐本次修改涉及的场景。**"正常浏览器页面被明确拒绝"是保留规则的证明**，不得为了让场景全绿而改成允许重试。

### 4.6 验证

修复后必须跑**真实点击到 Main 的路径**与安装态证明，不能只跑单元红测。两条默认文档红测转绿是必要条件，不是充分条件。

---

## 5. 方案 C：降为受控研究候选（作用域已重新界定）

### 5.1 C 的真实作用域与它不能做的事

- C 的操作对象只能是**失败轮仍在当前同一 thread 中**的情形，即 `continuation_safe`。
- 该情形与今天按钮出现的情形（`diverged`）**不相交**。因此 **C 不修 P0，也不是简化**——它是把一类今天 not applicable 的失败变为可重试，属于**功能新增**。
- 若要覆盖 diverged，就必须重审失败收口与后继创建的时机、归档与恢复，不能再宣称"只改 Retry 按钮、不动 Stage 3"（§4.4(4) 的旧说法已撤回）。

### 5.2 Revision 2 的三处技术前提均不成立，需重新设计

| 旧说法 | 复验结果 |
| --- | --- |
| "重发 `canonicalCurrentInputRef.input` 即保留原轮输入" | **不完整**。原生 input 是 `canonicalCurrentInputRef.input + explicitResourceEnvelope.input`（`codex-turn-input-builder.ts:446-450`），正式合同也写作 `exactly_one_current_canonical_input_plus_explicit_resources`；资源薄引用、Ready memory、待交付 tail 另走 `additionalContext`；当前文档锚/浏览器目标/产品目标/资源 authority/输出合同分别存在准备记录中；显式技能会向第二个 input 数组加入原生 `skill` 项。实测反例：完整原轮输出 `[text, skill]`，只取指定字段只剩 `[text]`。**文字相同不等于任务相同**——"修改当前文档"在用户切换文档后重发，目标已经不确定。 |
| "同一事务内 rollback + turn/start" | **不可实现**。`immediate` 是同步 `BEGIN IMMEDIATE → work → COMMIT`（`codex-binding-repository.ts:10085`），不等待外部 Promise；即使保持事务打开，SQLite 回滚也撤销不了 app-server 已完成的历史修改。 |
| "ChatGPT 冻结输入、当场重新解析授权" | **条件性**。`don` 只在 `shouldSendPermissionOverrides` 为真时读 `config/read`，且发生在历史修改之前。 |

另需注意：同一 thread **禁止工具定义变化**，变化时返回 `tool_surface_change_requires_new_thread`（`codex-binding-repository.ts:5276`）。"重新核对权限"不等于可以在同一 thread 任意换工具。

### 5.3 C 若继续，必须先补齐的设计合同

1. **明确操作目标**：哪个当前 head、哪个原生 thread/turn、哪个 scope epoch；保留"最新失败来源"的核对，阻止较旧失败记录在更新的会话状态下重新获得写权。
2. **完整重放材料清单**：哪些保留原身份/版本、哪些按当前配置重新解析；资源变更、模式切换、技能卸载、记忆关闭、工具定义变化时如何拒绝。**所有检查必须先于历史修改**。
3. **中断恢复合同**：用现有持久操作/启动交付机制明确阶段与唯一 owner——完整预检与冻结 → 记录精确撤回意图 → 单次外部修改 → 回读确认 → 本地记录与历史覆盖的原子更新 → 重发准入 → 结果未知时对账。必须逐一回答：rollback 成功但准备失败；rollback 完成但响应丢失后重启；本地已确认撤回但未发新 turn 时崩溃；新 turn 已发但响应丢失；双击/其他发送/重置/压缩竞争。不得盲重发 rollback，不得把原始失败的不可变审计改写成"从未发生"。
4. **最小探测范围**：先保持纯文本、无资源/技能/记忆，**不要把引入 rollback 与扩大重试范围绑成一次改动**。

### 5.4 Stage 0 必须包含 Ready 集成门（不只是 schema 比较）

- 同一 head 保留失败轮、已 fork、首轮 fresh root 三类分别证明操作目标；较旧失败记录不得获得当前写权。
- 重发包含完整输入与原目标；资源/模式/技能/记忆/工具定义变化时，失败发生在历史修改之前。
- rollback 前后、Ready 提交前后、`turn/start` 前后每个中断点可重启读回；丢响应与双击不得导致第二次删轮或重复发送。
- coverage / accepted-prefix、旧终态审计、后继/归档与动作版本保持一致；压缩后的历史仍能证明失败内容已从实际模型请求中移除。
- 新 run 必须通过现有 Gateway、工具授权、产品收口、UI 与安装态入口；**"直接对 app-server 发两个请求成功"不等于 Ready 具备该能力**。

### 5.5 revert vs rollback 的 adoption 判断

`thread/revert` 在 0.149 **实验** schema 中已存在且 Ready 已发 `experimentalApi: true`，但其合同限定为 paginated thread，而 Ready 仍是 legacy history 且无生产封装。因此：**按历史模式、接口稳定性、客户端封装与黑盒证据做 adoption 决策**。`thread/rollback` 的弃用提示是真实的，但"下次升级必须无条件换成 revert"不是必然结论。

---

## 6. 方案 A′：撤回"防重复"承诺

Revision 2 称"回填 composer + 保留 `same_thread_history_retained` 与 tail supersession 即可防重复"。复验证明当前代码不支持：

- `same_thread_history_retained` 只约束 exact Retry，**不拦普通发送**；
- ordinary 发送对纯文本待交付项固定 `deliver_untrusted_history`（`composition.ts:3786` 附近）；
- 现有 supersession 明确拒绝 `untrusted_text_history`（`codex-history-continuity-policy.ts:120` 附近，会抛 `uncommitted_user_tail_supersession_conflict`）。

实测反例：旧失败 B 作为纯文本 tail、回填的 B 作为新 ordinary input，最终参数中 B 出现两次。

**修订后的定位**：A′ 只是**帮用户起草一条新命令**，按新命令说明，**不承诺历史中只有一份相同文本**（用户主动重述本身也不构成错误）。若仍要承诺替换旧失败输入，就必须保留精确来源绑定并实现对应 assignment——不能只保留 blocker 名称，更不能靠文本相同猜测替换关系。

---

## 7. 其余问题清单

### I-1 `resolveExactRetryEligibility` 的事实可用性被伪造
`codex-product-turn-presentation.ts:445-450` 在 projection 路径硬编码 `currentFacts: { resourceEmpty: true, skillAndExecutionCeilingValid: true, … }`（`memoryPayloadEmpty` 与 `selectedSeedCount` 是真实值）。原计划 §9.2 明令禁止从 projection 推导"当前资源为空"。**修法**：改为 `{ phase:'projection' } | { phase:'pre_persistence'; currentFacts:{…} }`。

### I-2 写出但无人消费的字段（经两轮审查逐行更正）

| 字段 | 状态 | 结论 |
| --- | --- | --- |
| `CodexActionGate.consequence` | producer `codex-action-surface.ts:100-105`；Renderer 0 处消费 | 原计划 §6.4 要求 composer 附近展示。**产品缺口，必须补 UI，不可删** |
| `closedByLifecycleRef` + `historyState:'closed'` | 恒 `null` / 零 producer | 可删。**注意**：`historyState` 其余 7 值有真实 producer 且被测试断言为可观察合同（Revision 1 的"收窄枚举"已撤回）；真实问题只是仅 `legacy_context_boundary` 被分支消费 |
| `UserIngress.artifactSources` | 恒 `[]`，schema `z.tuple([])`，零消费者，四处重复断言为空 | 可删 |
| 三个 evidence digest / `NonUserSuccessorIngress` / `signedContinuationContextRef` / 两个 successor attempt kind | TS 侧零 producer，但见下 | **不是"零成本删除"**，见 I-3 |
| `SendScopedResponse.retryableByUser` | Renderer / preload 0 处读 | **Revision 2 称其为 zod 判别式，错**——真正的判别式是 `disposition`，`retryableByUser` 在多个分支同为 `false`，另一支是任意 `boolean`（`agent-runtime.ts:1027-1075`）。测试断言说明它目前属于合同，但不能据此认定必不可删；**本轮不建议顺带删除**，保留理由应是明确的语义与消费者 |

### I-3 删除三个 digest 与 successor kind 的真实影响面（Revision 2 严重低估）

它们不只在 TS 与测试里，还在：

- `codex_turn_bindings` 的 **SQL CHECK**（`codex-binding-schema.ts:2082-2090`：`explicit_retry` 分支要求三个 digest **NOT NULL**）、`idx_codex_turn_predecessor` 唯一索引、不可变触发器；
- 冻结的正式合同 `assets/codex-runtime/contracts/runtime-contracts.json`（`non_user_successor` 联合）与 `contracts/binding-schema.json`；
- 派生的 runtime manifest —— 而 manifest digest 变化会直接影响既有 head 的可用性（`codex-action-surface.ts:56` 的 `head_contract_drift`）；
- 已保存的准备记录、终态记录及其重启读回。

**停止写入而未迁移约束会直接失败；只改建表 SQL 不会改变已创建的表。** 结构 gate（`scripts/codex-runtime/e0-contract-model.cjs` + `scripts/__tests__/codex-runtime-e0-contracts.test.cjs`，18 pass，经 `verify:codex-runtime-outbound-rpc/e3/e4`）正面断言这些取值有效，删除必须同步修改，且该影子模型与 TS 已有漂移（e0 允许 `explicit_retry` 作为 successor attemptKind，TS 不允许），需一并对齐。

**修订要求**：删除须同时明确持久格式转换、正式合同与 manifest 更新、既有会话/准备记录的读回、安装态证明的处理；**保留 predecessor 去重约束**。结构测试的正面断言不代表必须保留死分支，但也不能替代真实行为验收。

### I-4 Renderer 对同一决定的重复判定
6 个判定点，其中 `ChatPanel.tsx:862-866` 手写内联重算 head 匹配且**漏掉 workbenchMode 比较**，与同目录共享函数 `productTurnReceipt.ts:98-105` 实测不等价。**修法**：统一规则、替换不等价副本。按钮显示与 Main 最终准入仍各有职责，应复用同一事实与判据，而不是只剩一个检查位置。

### I-5 composer 的并行 thread_busy / compaction 推断未删除
`agent-send-orchestration.ts:152` 与 `:153` + `:83-86` 从 `slice.lifecycleError.code` 重判，与 head gate 同名 blocker 重复且可能不一致。**修法**：改由 `head.actions.send_new_message` 单一裁决。

### I-6 动作面读取失败 = composer 永久不可用
`useAgent.ts:255-284`：任一读取失败都 `clearAtomicSurface()` 置 null 并 return；`ChatPanel.handleSend:792-800` 在 `!sendGate` 时一律拒绝；触发点只有切 scope / reset / boot / invalidation，**失败后无重试**。**修法**：具名 `head_unavailable` 状态 + 沿用现有 scope/epoch/版本保护的重读入口；具体退避次数不是架构合同。

### I-7 严格重试词典把「继续」当成「重试」（**已升级为第 1 步依赖项**）
`resume-lexicon.ts:96` 的 `STRICT_FULL_MATCH` 含 `继续 / 接着做 / continue / resume`，该词典自述用途是 continuation；Renderer 路由（`explicit-retry-routing.ts:46`）与 Main 控制校验（`codex-explicit-retry-control.ts:56`）都用它。今天由 raw anchor 拦截掩盖，解除拦截后立刻进入常用场景——实测反例见 **§4.2**。**修法**：拆出独立的 exact-retry 判定入口，Renderer 与 Main 共用；仍是一份文件一份词典。**必须与 §4.1 同批交付。**

### I-8 `RunDurationMeter` 用中文字面量做二次判定
`:103` `model.label === '本轮用时' ? '' : '本轮用时 '`；`:80-82` `pulse: live` 冗余。纯 Renderer 清理。

### I-9 markdown ordered-list 的不可达分支
`markdown/index.tsx:28`/`:615`：`type:'ordered-list'` 必然带 `orderedList`。改为按 `type` 辨识的联合。

### I-10 原计划要求的 blocker 词汇未实现
`same_thread_failed_turn_restatement_required` / `compacted_failed_turn_restatement_required` 在 `src/` 零命中，被压成单一 `same_thread_history_retained`，且无 compaction-coverage 分支。

### I-11 `continuation_safe` allowlist 过窄（论据已改写）
`codex-terminal-facts.ts:203-207` 是单一字面量（`gateway_upstream_http_400 / headers / eventCount=0 / wireByteCount=0`）。**论据改为 Ready 自身的成本核算**（每次常见 provider 错误都新建一条 native thread，累积 thread、archive 压力与 coverage lineage 长度），不再引用 M3。**修法**：判据本身不放宽，只把 `causeCode` 从单值改为逐个实测过的集合，每个新增值绑定自己的 probe receipt。

---

## 8. 工程与交付卫生

- **I-12 工作树**：289 个已跟踪文件、+18465/−5979、0 次提交，压着 8 个以上计划的产物。**审查意见**：不要用一次宽泛 WIP 提交 + 索引重置代替范围审查；先做只读快照与文件归属/依赖清单，再按明确范围形成提交。**不要用 `git stash`**（worktree 共享 stash 栈）。
- **I-13 `outputs/`**：12 GB，20 条未忽略（含调试脚本）。收进单一目录并整体忽略；仅 provenance 与最终日志摘要入库。
- **I-14 两个先天红门**：`check-silent-catch` HEAD 184 / 工作树 182，`npm run verify` 因此不可能绿；`verify:codex-runtime-e0r` 冻结 capture 0.146.1 与 0.149.0 冲突。交付说明须标为"已知先存红门 + 数字 + 与 HEAD 的逐条差值"并单独排期。
- **I-15 大文件**：repository 10096（本轮 +1922）、composition 5019（+1293）、schema 2952（+586），连续 6 轮登记"后续拆分"。建议给 repository 定硬上限 10000 行。

---

## 9. 实施顺序（按独立审查的逐步判断）

**不建议整体批准第 0–6 步。** 逐步结论：

| 步骤 | 判断 | 前置要求 |
| --- | --- | --- |
| 0 工作树拆分 | **不作为默认前置** | 先只读快照 + 文件归属/依赖清单，再按明确范围提交 |
| 1 入口修复（§4.1 六条）**+ 语义拆分（§4.2）+ 权威合同修订（§4.3）** | **优先做，三者同批** | 五种环境场景全覆盖；两处提前拒绝点同步改；Renderer/Main 共用同一 exact-retry 判定入口；§4.5 前六行验收 |
| 2 事实可用性区分 + 缺失 blocker + 动作面恢复 + consequence 展示（§4.4） | **优先做** | §4.5 后四行验收；真实点击到 Main + 安装态证明 |
| 3 重复判定清理（I-4、I-5） | 支持 | 复用同一事实与判据，不是只剩一个检查位置 |
| 4 死分支/字段清理（I-2、I-3） | 方向可评估，**非零成本** | 先明确数据存续，再同步删除正式定义、约束、调用方、manifest 与测试；保留 predecessor 去重约束 |
| 5 Renderer 文案/类型清理（I-8、I-9） | **后移** | 无证据表明是重试闭环的前置条件，不应绑进恢复架构的放行 |
| 6 C 的设计补齐 + Stage 0（§5.3、§5.4） | 单独立项 | 不得让扩大资源范围成为引入 rollback 的附带变化 |
| 7 I-11 causeCode 集合 | 可延后 | 须先重录 probe receipt |
| 8 I-12~I-15 | 随时 | — |

**I-7（"继续"语义拆分）已从"后移"移入第 1 步**——它与解除 raw anchor 拦截存在直接依赖，延期会让入口修复扩大问题范围。

---

## 10. 明确不做

- 不把 B 的旧文字（Revision 2 的 B-1~B-5）与 Revision 3 的 §4.1 当作已审过的实施合同——两者均已作废。
- **不删除 Renderer 的当前文档观测采集**：Main 在 document 模式下没有等价可信来源（`runtime.ts:1465-1477`）。要移走采集职责，必须先提供可工作的替代来源。
- **不新增与 `prepared.ingress.currentDocumentAnchor` 同义的 activation 标志/摘要/第二套状态。**
- **不用控制文本 R（"再试一次"）判定 activation**；判定用的是原任务根 B。
- 不在同一批次里只改 Renderer 的 exact-retry 判定而不改 Main——Main 会继续接受旧语义。
- 不在未补齐 §5.3 设计合同与 §5.4 Ready 集成门前写方案 C 的生产代码。
- 不声称"下次 runtime 升级必须无条件换成 `thread/revert`"——按历史模式、接口稳定性、客户端封装与黑盒证据决策（§5.5）。
- 不借 ChatGPT 的空输入续跑路径给 Ready 接入空 input；Ready 现有合同已明确拒绝，且不得借旧 successor 枚举名义跳过边界。
- 不承诺 A′ 具备历史去重效果（§6）。
- 不用 `thread/inject_items` 从 Ready 的 UI 消息重建完整模型历史。该约束是关于**注入什么内容**，不再声称"ChatGPT 不用它"。
- 不放宽显式资源规则；不为 browser mode 过滤 ambient page ref（它同时承载工具授权）。
- 未重录 probe receipt 前不放宽 `continuation_safe` allowlist。
- 本轮不顺带删除 `retryableByUser`。

---

## 11. 需要评审签字的一点

**是否按 §9 批准第 1–2 步——即 §4.1 的六条入口修复 + §4.2 的语义拆分 + §4.3 的权威合同修订 + §4.4 的缺失合同项，以 §4.5 为最小验收合同——并把 C 与死字段清理各自单独立项？**

这是四轮审查后收敛的共同结论：P0 真实且未解决；在不改变当前 Stage 3 收口/后继机制的范围内 rollback 修不了它；C 是功能新增而非简化，需要自己的设计与集成门；死字段清理触及持久数据、正式合同与 manifest，不是零成本。

§4.3 需要**同时修订原计划 §9.1 / §9.2 的文字**，这是一次权威合同变更，需明确签字。

---

## 12. 审查记录

### Round 1（两名独立审查者）：CHANGES_REQUESTED
- 审查者 A（Ready 全链消费）`P0=2 / P1=4 / P2=6`：browser 降级路径使 exact Retry 可达（"两种 mode 都不可达"过度）；原方案 A 删除 `same_thread_history_retained` 会引入重复历史；"全部为删除"为假；`NonUserSuccessorIngress` 等有活跃 gate 消费者；遗漏安装态证明脚本；行号漂移等。
- 审查者 B（ChatGPT 取证）`P0=6 / P1=5 / P2=1`：取证只覆盖 21 个 shell bundle 中的 2 个、未开 `/webview/**`（7927 项）；`edit-last-user-turn` 是 revert/rollback + 重发原轮 params；`thread/rollback` 在 0.149 即存在；ChatGPT **会**自动注入 IDE/浏览器上下文；Matrix 本地库有 9+ 表与逐 turn 终态账本；`thread/inject_items` 确被调用。
- 处置：Revision 2 撤回 M2/M4/M6、改写 M3/M5、推荐方案改为 C。

### Round 2（独立审查记录，66 项检查 / 64 通过 / 2 失败）：CHANGES_REQUESTED

| 结论 | 本版处置 |
| --- | --- |
| R1 C 在 diverged 下会撤回错内容（收口已创建后继，撤回当前 head 会删掉 A） | 复验确认（`codex-binding-repository.ts:7084/7144`）。**C 撤回为推荐**；§3.3 新增作用域分析，§5.1 重新界定 C 为功能新增 |
| R2 指定重放字段不完整；重新授权不能替代任务目标 | 复验确认（`codex-turn-input-builder.ts:446-450`，正式合同 `exactly_one_current_canonical_input_plus_explicit_resources`）。§5.2 表格；§5.3(2) 要求先列完整重放材料清单 |
| R3 "同一事务"不可实现 | 复验确认（`codex-binding-repository.ts:10085` 同步 `BEGIN IMMEDIATE`）。§5.2、§5.3(3) 要求逐中断点的恢复合同 |
| R4 ChatGPT 有三条不同路径；`don` 的权限读取是条件性的 | M5 重写；撤回 Revision 2 的"关键不对称"表述；补空输入路径对 Ready 不可直接借鉴的理由 |
| R5 删除步骤涉及已有数据、正式合同与 manifest | I-3 重写，列出 SQL CHECK / 索引 / 触发器 / 两份冻结合同 / manifest / `head_contract_drift` |
| R6 A′ 防重复承诺不成立 | 复验确认（ordinary 固定 `deliver_untrusted_history`；supersession 拒绝 `untrusted_text_history`）。§6 撤回该承诺 |
| 版本事实：0.149 **实验** schema 已含 `thread/revert` / 两个分页读取；Ready 已发 `experimentalApi: true`；但 revert 限定 paginated 而 Ready 是 legacy | 复验确认。M1 表格重写；§5.5 与 §10 改为按历史模式与封装做 adoption 决策 |
| `retryableByUser` 不是判别式（`disposition` 才是） | 复验确认（`agent-runtime.ts:1027-1075`）。I-2 更正；本轮不建议删除 |
| 第 0–6 步不应整体先行 | §9 改为逐步判断表，采纳其对第 0 步与第 5 步的处置 |

**Round 3 须在实施范围选定后对本版重新发起**，至少覆盖：§4.1 单一事实的五种场景是否穷尽、§9 各步的门是否充分、以及本版是否遗漏任何 Round 2 结论。

### Round 3（Revision 3 复审，34 项检查 / 32 通过 / 2 失败）：CHANGES_REQUESTED

范围选择（先做第 1–2 步）获支持；C 与 P0 不相交的判断在"保留当前 Stage 3 收口/后继机制"的前提下成立；C、死字段清理与界面类型整理单独处理的排序合理。两项 P1 必须补齐：

| 结论 | 本版处置 |
| --- | --- |
| R3-1 §4.1 把"原轮唯一事实"与"本次最终检查"混为一谈；要求 Renderer 停止采集会让最终检查失去信息（Main 在 document 模式只返回 `{workbenchMode}`）；两处提前拒绝点未安排修改；权威合同 §9.1/§9.2 的旧表述与"已修复"自相矛盾 | 复验确认（`runtime.ts:1465-1477`、`codex-explicit-retry-control.ts:61-63`、`composition.ts:3358`）。**§4.1 整节按其六条替换条款重写**；新增 §4.3 权威合同同步修订；§10 增加四条禁止项 |
| R3-2 I-7 未进入实施顺序，而解除 raw anchor 拦截会让「继续 / continue / resume」立刻变成原任务重发；只改 Renderer 不成立 | 复验确认（`resume-lexicon.ts:96`、`explicit-retry-routing.ts:46`、`codex-explicit-retry-control.ts:56`）。**新增 §4.2 并把 I-7 移入第 1 步**，要求 Renderer 与 Main 共用同一判定入口 |
| 最小验收合同（10 类场景） | 全文照收为 **§4.5**，并保留"正常浏览器页面被拒绝是保留规则的证明，不得为求全绿改成允许"这一条 |
| 文字修正：§4.2 的恢复项应指向 I-6 而非 I-5 | 已改（现为 §4.4） |
| 文字修正：M3 的 causeCode 引用应为 I-11 而非 I-9 | 已改 |
| 文字修正："C 不能修 P0"应带上"在不改变当前 Stage 3 的范围内" | §0(3)、§3.3 标题、§11 均已加限定 |

**Round 4 须在第 1 步实施后发起**，至少覆盖：§4.5 十类场景是否全部落成行为测试与安装态证明、§4.3 的权威合同修订是否与实现同批、以及 exact-retry 判定入口在 Renderer 与 Main 是否真正同源。
