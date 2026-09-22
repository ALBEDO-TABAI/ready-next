---
title: Ready Browser Runtime 与无人值守研究实施计划
date: 2026-07-24
kind: implementation
status: approved-for-implementation
enforce: false
owner: 白
author: Codex
approval:
  date: 2026-07-24
  instruction: 收干净当前工作区后，在独立 agent-renew worktree 推进重构
implementation_branch: codex/agent-renew
implementation_worktree: /Users/user/实验田/ready-cowork-agent-renew
review:
  reviewer: adversarial_doc_review
  date: 2026-07-24
  rounds: 4
  verdict: pass
requires:
  - docs/superpowers/specs/2026-07-24-ready-agent-browser-target-architecture.md
  - docs/superpowers/plans/2026-07-24-agent-runtime-rearchitecture-implementation.md
  - docs/superpowers/plans/2026-07-22-agent-plan-execute-policy-hooks-and-branching-runtime-design.md
  - docs/superpowers/plans/2026-07-22-browser-agent-sequential-long-task-and-tab-ownership-closure-implementation.md
joint_cutover_with:
  - docs/superpowers/plans/2026-07-24-agent-runtime-rearchitecture-implementation.md A6
adjudicates:
  - 第一阶段 BrowserRuntimeService 固定为 Main 内 actor；utility process 只能做无状态计算，不能拥有 session/claim/Task DB
  - 后台指针操作必须先通过独立真实 Electron 可行性 spike；未通过不得开始 B1/B2
  - B6 不得独立合并，必须与 Agent A6 同一 gate、同一提交边界完成
scope: Browser session/target 服务、后台动作、页签 finalize、用户接管、Browser tool actions、研究工作项、证据、恢复及真实小红书验收
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：固定历史证据仍引用此路径。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# Ready Browser Runtime 与无人值守研究实施计划

## 0. 文档定位

本文只处理 Browser runtime 和基于 Browser 的无人值守研究。它建立在 Durable Agent Task/Turn/Item 与 07-22 ExecutionPlan 上，不再让 Browser child 成为第二套任务权威。

第一阶段实现形态已裁决为 Main 内单例 `BrowserRuntimeService` actor。Renderer 不是 owner；utility process 只能承接无状态截图解析等纯计算，不能拥有 Browser session、target claim、Task DB 或 terminal 写权。

第一阶段坚持：

```text
一个 owner Agent
+ 一个 durable Task
+ 多个顺序 Browser domain items
+ 可后台工作的独立 targets
```

不在顺序可靠性未完成前加入 Browser 子 Agent 并行。

本文中当前 `package.json` 尚不存在的 `verify:*` 命令，都是对应阶段必须新增并接入 `package.json` 的 gate 名称，不是现有命令清单。

实施只允许在 `/Users/user/实验田/ready-cowork-agent-renew` 的 `codex/agent-renew` 分支进行。该 worktree 必须从已收干净的 source HEAD 创建并保持初始状态为空；B0 之前不得在原 `ready-cowork-newtab` 工作区试写 Browser runtime。`.research/` 中的本机 ChatGPT 副本不是构建输入，B0/A0 所需证据必须转成脱敏 fixture 或由具名只读复核命令生成。

## 1. 总完成标准

只有以下全部成立，本文才能标 completed：

1. Browser session 有 durable identity，受 Main/Supervisor 管理，不受 Renderer 页面生命周期支配。
2. target identity 包含 partition、tab、physical token、document token、boot id、generation。
3. agent control、user visibility 和 active tab 三者分离。
4. 独立真实 Electron spike 已证明 work surface 能在不抢用户焦点的前提下执行读取、点击、滚动、输入、等待和截图；若未证明，本计划不得进入 B1。
5. 用户切换 Ready mode、查看其他 tab 或收起 Browser UI 不暂停 Agent。
6. 用户在同一 target 真实输入时只接管该 target。
7. action mutation 后必须有新 observation receipt。
8. Agent 临时页、ongoing work 页、deliverable 页和 user 页有统一 finalize。
9. `browser_research/browser_collect` 不再拥有独立终态真值；它们要么拆成 ExecutionPlan node + Browser domain items，要么成为可审计 macro。
10. Browser progress 只从 ExecutionPlan nodes/domain items/evidence 派生。
11. Provider 502、Browser service 重启、Renderer reload、app restart 后自动恢复同一 task/session/target。
12. 原 prompt 在真实 Electron 和登录态小红书中完成 10 条规划。
13. QR、安全验证或权限阻塞时准确进入 waiting_user，用户处理后从同一 checkpoint 继续。
14. 零 silent success、零 parent/child terminal mismatch、零重复外部动作。

## 2. 现有能力的取舍

### 2.1 保留并迁移

当前已经有价值的实现：

- per-target claim；
- physical target token；
- claim generation；
- user takeover/return；
- action journal/receipt；
- trusted Browser page identity；
- Browser permission policy；
- Browser observation discipline；
- checkpoint store；
- BrowserView hide/show/bounds 基础。

这些能力迁入新 Browser Runtime Service，不重写成 surface 级全局 lease。

### 2.2 删除权威

以下不再拥有 Task 真值：

- `browser_tasks.status` 独立决定完成；
- `progress_completed/progress_total` 由 Browser macro 自报；
- Browser child paused/completed 反向覆盖 parent；
- Browser checkpoint 自己选择 parent terminal；
- Renderer 依据 Browser overlay/visible 猜运行状态。

可保留 Browser job row 作为 service projection，但它必须从 Task items + ExecutionPlan + Browser domain stores 联合派生。

### 2.3 不复活

- 旧 agent-view / dormant background path；
- surface 级全局 owner；
- 通过切换用户 active tab 获得输入 readiness；
- 站点白名单；
- 用 site-specific deny/allow 代替 capability/permission；
- 复制 macOS Browser state 到其他平台。

## 3. Browser Action 合同

### C1. 每个 action 有精确 target

```ts
interface BrowserActionRequest {
  taskId: string
  turnId: string
  callId: string
  target: BrowserTargetIdentity
  expectedClaimGeneration: number
  expectedDocumentToken?: string
  action: string
  args: unknown
  idempotencyKey: string
}
```

旧 generation、旧 document 或错误 owner 直接拒绝。

### C2. mutation 后 observation

点击、输入、选择、上传、导航、拖拽和 JS mutation 成功后：

```text
action receipt
→ wait/read/snapshot observation
→ observation receipt
→ dependent next action
```

没有 observation receipt 时不能把 domain item 标 accepted。

### C3. visible 不授予 owner

show/focus/switch UI intent 不能修改 claim。只有：

- explicit Agent claim；
- user real input takeover；
- explicit handoff/release；

可以修改 owner。

### C4. Browser service failure 不结束 Task

service disconnect：

1. action journal entry 标 transient；
2. Task → recovering；
3. 恢复/重建 BrowserSession；
4. 按 target/document receipt 对账；
5. successor Turn 继续。

### C5. 页签收口

Turn settle 必须调用一次 `finalizeTargets(turnId)`，结果写 Browser domain receipt + Task reference item。重复调用幂等。

## 4. B0：固定 Browser 边界与前台占用失败

### 目标

把当前“键盘可后台、指针需前台”的差异和 target claim 正确部分固定成测试。

### 当前事实 fixture

覆盖：

- background keyboard/direct text；
- foreground/visible/active pointer requirement；
- 用户点击同 target；
- 用户点击 sibling target；
- show Agent tab；
- chrome navigation/back/forward/reload；
- user close tab；
- page self-navigation；
- popup；
- app boot incarnation change；
- stale generation；
- document token change。

### 新失败测试

1. Agent work tab 不可见时 click/scroll 被拒。
2. 为了执行 pointer 而切换用户 active tab。
3. overlay hide 导致 task suspension。
4. child `18/18 + paused + null result` 被 UI 当成功/停住。
5. Browser service 重启后 target claim 无法重建。

### 验证

```bash
npm run verify:browser-target-claims
npm run verify:browser-reliability
npm run verify:browser-runtime-baseline
```

初始新测试预期红，既有 claim 测试必须保持绿。

## 5. B0.5：后台指针可行性 Spike

### 目标

在重构 Browser Service 前，用真实 Electron/macOS 证明或否定后台 pointer 的物理可行性。该 spike 是 architecture gate，不是 B2 收尾验收。

### 实验矩阵

在专用 acceptance profile、当前源码 build 和受控本地测试页中依次验证：

1. hidden/parked Agent target 上的 CDP `click/scroll/type`；
2. 专用 non-user BrowserWindow/work surface 上的同组动作；
3. 页面收到的 pointer/keyboard/scroll event、DOM state 与 screenshot/observation 一致；
4. 用户同时在 Ready Document 中连续输入，`BrowserWindow.getFocusedWindow()`、当前 Ready mode 与 active user tab 全程不变；
5. 用户在 Agent physical target 上真实输入时，takeover detector 仍能区分 user input 与 Agent action echo。

每条 case 保存：

```text
source/binary/profile/DB handshake
before/after focus and active-tab identity
target/document/claim generation
action + observation receipts
page event log
screenshot digest
pass/fail reason
```

### 决策

- hidden/parked 路径全通过：采用直接 target/CDP；
- hidden 失败但 dedicated non-user work surface 通过：采用 Presentation Scheduler；
- 两条都失败：立即停止 B1/B2，修订目标架构与交互承诺；
- 禁止用切换用户 active tab、隐藏失败、人工补点或只看源码来判通过。

### 具名 gate

扩展现有 `verify:browser-live-grounded` 的 manifest/handshake/report/validator，增加 spike scenario：

```bash
npm run verify:browser-live-grounded -- --scenario=background-pointer-spike
```

负例至少包括焦点被抢、DOM 已变但无 observation、Agent echo 被误判 user、用户输入未触发 takeover、报告缺 screenshot digest。任一负例未被 validator 拒绝，gate 自身失败。

### 出口

产物位于既有 `outputs/browser-live-grounded/<proofNonce>/`，report 由 `scripts/check-browser-live-grounded-report.cjs` fail closed 校验。只有 report 明确 `backgroundPointerFeasible=true` 才能开始 B1。

## 6. B1：Browser Runtime Service 与 Session Store

### 目标

把 Browser control 从 Renderer/Workbench 生命周期移到 Main 中的独立 service boundary。

### 建议职责

```text
browser-runtime/
  service.ts
  session-store.ts
  target-registry.ts
  claim-store.ts
  action-dispatcher.ts
  observation-store.ts
  presentation-scheduler.ts
  finalize-targets.ts
  recovery.ts
```

Browser WebContents 与 service 都由 Main 持有。第一阶段只允许 Main 内 actor，并通过 Supervisor 的 Main Unit of Work 协调 Task/Turn item、ExecutionPlan/domain ref、target claim 和 projection。Browser actor 只能提出 transition/result，不能直接写 Task terminal。

utility process 仅可处理不持有 session/claim/DB 的无状态计算，返回带 digest 的 candidate；它不能成为 Browser Service 替代实现。

### Session

```text
browserSessionId
taskId
partition
browserBootId
status
createdAt
lastActivityAt
targets
```

### 恢复

启动时：

1. 枚举 durable sessions；
2. 读取现有 WebContents/partition；
3. 校验 physical target；
4. 失效 target 标 lost；
5. 有安全重建条件时新建 work tab；
6. 不复制 Cookie 或跨 profile 搬运 session；
7. 记录 recovery receipt。

### 验证

```bash
npm run verify:browser-runtime-service
npm run verify:browser-session-recovery
npm run verify:native
```

### 出口

关闭 Renderer 窗口、切换 Workbench mode、隐藏 Browser pane 后，Browser session 和 Task claim 不变。

## 7. B2：后台可执行的 Work Surface

### 目标

所有常用 Browser action 不占用户前台。

前置：B0.5 已在真实 Electron 中证明一种后台 pointer 路径。B2 只能产品化该已通过路径，不能在此阶段重新猜测或更换机制。

### 实施

1. Agent research 默认创建专用 work tab。
2. work tab 绑定 durable Browser session/Task。
3. action 直接作用于 target WebContents/CDP，不依赖 UI active tab。
4. pointer 使用 target 坐标系和 viewport receipt。
5. 若 B0.5 证明的是 dedicated work surface，必须呈现才能正确执行的动作交给 Presentation Scheduler：

```text
attach to dedicated non-user work surface
→ synchronize bounds/device scale
→ perform action
→ observe
→ park/detach without changing user active tab
```

6. 不调用用户 tab switch 作为 readiness 修复。
7. readiness 返回具体原因：

- target not live；
- document changed；
- claim lost；
- viewport unavailable；
- presentation required；
- platform unsupported。

### 行为矩阵

| action | hidden work tab | 用户在其他 mode | 用户在 sibling tab | 同 target 被接管 |
| --- | --- | --- | --- | --- |
| snapshot/read/find | 允许 | 允许 | 允许 | 拒绝/等待 |
| keyboard/type | 允许 | 允许 | 允许 | 拒绝/等待 |
| click/scroll/hover | 允许 | 允许 | 允许 | 拒绝/等待 |
| drag/upload/dialog | scoped presentation/permission | 不抢前台 | 不影响 | 拒绝/等待 |
| screenshot | 允许 | 允许 | 允许 | 按 owner policy |

### 真实 Electron gate

源码单测不足。必须在 B0.5 通过产物上回归：

1. 启动当前 build；
2. Agent 在 work tab 连续执行 click/scroll/type；
3. 用户在 Document mode 编辑；
4. 证明 active tab/mode 未被抢；
5. 页面动作成功且有 observation receipt。

### 验证

```bash
npm run verify:browser-background-actions
npm run verify:browser-live-background-actions
```

### 出口

常规研究路径零次强制用户 tab switch。

## 8. B3：Target Claim、用户接管与返还

### 目标

在后台控制成立后，收紧同 target 的冲突合同。

### 信号分类

```text
agent_action_echo
user_real_input
user_chrome_navigation
page_self_navigation
browser_system_event
unknown
```

### 规则

1. Agent echo 不接管。
2. 用户查看/聚焦不接管。
3. 用户 click/type/scroll/drag 同 target：原子接管。
4. 用户从 chrome 地址栏、back/forward/reload 操作同 target：原子接管。
5. 用户关闭 target：结算 claim 与 pending action。
6. page self-navigation：更新 document identity，不视为用户接管。
7. unknown 在有 external effect 风险时先暂停该 target，不影响 sibling target/Task 的非 Browser 工作。

### 接管事务

Browser actor 先返回带 expected generation 的 takeover proposal；只有 Main Supervisor 的 `BrowserTakeoverUnitOfWork` 可以提交：

```text
claim owner=user
+ generation increment
+ in-flight action settle/effect_unknown
+ Browser domain suspension ref
+ Task waiting item when task requires this target
+ derived projection revision
```

这些 SQLite 变化在同一连接、同一事务内完成。Browser actor、utility process 和 Renderer 都没有 claim/Task 写权。外部页面动作无法回滚时，事务只结算 action journal 的 receipt/effect_unknown，不伪造网页回滚。

### 返还

用户可：

- 显式“交还 Agent”；
- 完成安全验证后继续；
- 关闭页并允许 Agent 重建。

返还必须产生与 target/document/generation 匹配的 interaction/observation receipt，再由 wake authorizer 恢复；不能靠模型猜用户已操作完。

### 验证

```bash
npm run verify:browser-takeover
npm run verify:browser-live-takeover
```

### 出口

用户和 Agent 在不同 target 各自工作；同 target 冲突可解释、可恢复。

## 9. B4：Browser Tool Surface 重组

### 目标

保留足够小、语义清晰、可组合的 Browser actions。

### Capability actions

建议按能力分组，不要求都同时注入：

```text
session
  open / status / recover

tabs
  list / open / claim / handoff / close / finalize

page_observe
  snapshot / read / find / screenshot / wait

page_interact
  navigate / click / type / fill / select / hover / scroll / press / drag

page_transfer
  upload / download / dialog

page_diagnostics
  console / network / resources

page_advanced
  eval / cdp
```

`eval/cdp` 不作为普通研究默认面，只在低级 actions 无法完成且权限合同允许时激活。

### `browser_research` / `browser_collect`

两种合法处置二选一：

1. 删除 opaque macro，由 07-22 ExecutionPlan node/BrowserResearchState 调用 primitives；
2. 保留 macro，但它必须：

- 逐 action 写 action journal/receipt；
- 写 evidence；
- 不拥有 parent terminal；
- 不自报 progress；
- 可在任一 action 边界恢复；
- 接受 task/callScope/planNode/domainItem/target identity。

禁止维持当前“内部 child job + 自己的 progress/status + parent 再猜”的第三态。

### 动态暴露

原 prompt 的 IntentFrame 已有 Browser floor 时，直接激活 observe/interact 所需 actions。模型不需要先调用一次仅为路由服务的 `use_browser`。

Browser tool surface 不暴露“绕过等待并继续”的通用 action。`session recover` 只能恢复 service/session 连接；Task wake 仍必须经过 Agent A5 的 candidate resolver + receipt authorizer。负例：

- `waiting_user/site_security_verification` + 普通“继续”或 session recover：零新 Turn；
- 错 target/document/generation 的 observation receipt：零新 Turn；
- `waiting_approval` + Browser action retry：零新 Turn；
- site security 必须同时满足 `allOf(matching interaction result, same-target observation)`；只交其中一枚零新 Turn；
- 两枚均匹配时 authorizer 只铸造一个 WakeAuthorizationReceipt，并恢复同一 checkpoint；
- waiting approval 只接受 `allOf(matching approval receipt)`。

### 验证

```bash
npm run verify:browser-tool-surface
npm run verify:agent-tool-broker
npm run verify:continuation-wake-authorization
```

### 出口

每轮只暴露当前 ExecutionPlan node/domain item 所需 Browser actions；复杂研究仍能组合完成。

## 10. B5：BrowserResearchState 与证据管道

### 目标

让“找 10 条合格笔记”成为可验证数据任务，而不是长聊天。

这里的 keyword/candidate/field items 是 BrowserResearchState 的域内真值，不新增通用 `agent_work_items`，也不复制 ExecutionPlan 的顺序/依赖。ExecutionPlan Browser node 只保存 browserTaskId、domain revision、checkpoint 和 evidence watermark。

### 工作流

```text
read input resource
→ commit keyword domain items
→ search keyword
→ enumerate candidates
→ open detail
→ verify publishedAt
→ verify likes
→ open author
→ verify followerCount
→ accept/reject candidate
→ continue until output coverage reached
→ compile 10 plans
→ code verifier
→ fresh semantic verifier
```

### Evidence extractor

每个字段写：

```text
value
raw displayed text
normalized value
parser version
selector/page region identity
page/document token
observedAt
screenshot/page artifact
confidence=verified
```

若页面只显示互动总数：

- `likes` 不得从互动数推断；
- candidate 保持 pending/rejected；
- 必须进入详情或其他可信页面核验。

### 时间与数值冻结

每轮 admission 固定：

```text
acceptanceAt
IANA timezone
calendarWindowStart = acceptanceAt 减 3 个日历月
numericParserVersion
```

规则：

- `万` 乘 10,000，`k/K` 乘 1,000；
- 带 `+`、区间或省略的值只形成上下界；无法凭边界证明阈值就 fail closed；
- 相对发布时间按固定 acceptanceAt/timezone 转换并保存 raw text；
- “3 个月前”等落在临界线且无法确定日期的样本不接受；
- 每个最终字段同时保存 raw、normalized、parserVersion 和 source artifact digest。

### 去重

按稳定 note identity 优先；没有稳定 id 时组合：

```text
author identity + normalized title + publication time + page digest
```

不只按标题。

### Coverage

研究停止条件不是固定关键词次数，而是：

```text
all mandatory keyword domain items settled
and qualifying candidate count >= required
and output plan count == 10
and evidence predicates pass
```

如平台可见结果不足，必须产出“证据化不足”，不能编造补足。

### 验证

```bash
npm run verify:browser-research-ledger
npm run verify:xhs-research-fixture
```

### 出口

删除完整对话历史后，ledger/evidence 足以继续下一个 candidate。

## 11. B6：与 Agent A6 联合生产切换

### 目标

让 Browser 只作为 Agent Kernel capability service，不再参与第二套 Task terminal。

### 前置与提交边界

B6 只有在 A0–A5、B0、B0.5 和 B1–B5 全绿后开始。它与 Agent A6 使用同一 integration branch、同一 `verify:agent-browser-joint-cutover` gate、同一个不可拆提交/PR。禁止先合并任一侧再补另一侧。

### 切换

1. Agent Tool Broker 调用 Browser Runtime Service。
2. Browser actions 写现有 action journal、observation、artifact/evidence 与 Browser domain ledger。
3. Task item 只写这些 canonical objects 的 ref/revision/digest。
4. Browser job projection 从 Task/ExecutionPlan/Browser domain/action/evidence stores 联合派生。
5. Task Completion Verifier 读取 Browser evidence。
6. Renderer Browser task card 读取新 projection。
7. 删除 Browser child → parent terminal patch。
8. 删除 `canResume` Browser 特例。
9. 删除 Browser provider transfer → `blocked_tool_error`。
10. 删除 UI 对 `progress_total/progress_completed` 的独立完成推断。

### 静态 gate

禁止 Browser 模块直接写：

- Task completed/failed；
- canonical assistant terminal；
- parent projection terminal。

### 验证

```bash
npm run typecheck
npm run verify:agent-kernel
npm run verify:browser-target-claims
npm run verify:browser-reliability
npm run verify:browser-background-actions
npm run verify:agent-browser-joint-cutover
npm run verify:native
npm run build
```

### 出口

构造 `18/18 + paused + result=null` 时 Completion Verifier 必须拒绝完成；联合 gate 证明不存在 A6-only 或 B6-only production binding。

## 12. B7：真实小红书无人值守验收

### 12.1 环境

- 独立 Ready profile；
- 当前源码 build；
- 当前 `package.json` 版本；
- 真实 Electron；
- 用户已授权使用的小红书登录态；
- 不复制 Cookie、密钥或其他电脑 profile；
- 不绕过平台 QR、安全验证或反自动化机制。

### 12.2 输入

使用原始 prompt，不增加“请打开浏览器”“持续执行”“不要停”等补丁词。

使用原始目标文档，并验证 Resource receipt 为 complete；若先是 excerpt，必须有后续全文读取 receipt。

### 12.3 三轮场景

#### R1：无干预

- 提交一次；
- 不发“继续”；
- runner 在中段注入一次可恢复 Provider transient，必须由 automatic successor receipt 自行接力；
- 完成全部研究和 10 条规划。

#### R2：用户并行工作

- Agent 搜索时用户切到 Document/RSS/其他 Browser tab；
- 用户不操作 Agent target；
- Agent 不暂停、不抢 active tab。

#### R3：恢复

在第 78 个 tool result 后注入 Provider 502 或受控 worker kill：

- taskId 不变；
- 自动 successor Turn；
- 已接受 candidate 不重做；
- action receipt 不重复；
- 最终完成。

另做一次 app restart：

- session/target 能恢复则继续；
- target 不能恢复则安全重建；
- 不丢 plan/evidence。

### 12.4 数据验收

最终 10 个 reference records 每个必须满足：

```text
publishedAt within last 3 calendar months
likes >= 1000
authorFollowerCount <= 50000
source/evidence readable
observedAt present
acceptanceAt/timezone/parserVersion present
rawDisplayedText + normalizedValue present
```

对至少 3 个随机样本进行人工页面复核，自动结果必须一致。人工抽查只验证数据，不替代全量机器 gate。

### 12.5 终态验收

必须证明：

- all mandatory ExecutionPlan nodes/domain items settled；
- Browser session finalized；
- no open/effect_unknown calls；
- Task/Turn terminal 一致；
- exactly one canonical assistant message；
- message 重启后可见；
- parent/Browser projection digest 一致；
- integrity metrics 全为 0；
- final artifact 可读；
- UI 没有“success 但 paused”的组合。
- R1 `userMessageCount=1`；
- R1/R2/R3 `humanResumeCount=0` 且 `scriptResumeCount=0`；
- R1/R3 至少各有一个 automatic successor receipt；
- 旧 XHS runner 的自动 `resumeRun` 分支在新场景中必须被禁用；一旦调用即 gate 失败。

### 12.6 外部阻塞

若出现 QR/安全验证：

```text
Task=waiting_user
reason=site_security_verification
checkpoint/target/evidence durable
UI 明确要求用户完成验证
```

用户完成后以匹配的 interaction result + 页面验证 observation receipt 唤醒同一 task。未完成验证时报告 blocked，不得写 passed。

验收 runner 必须先做负例：

1. QR/安全验证尚未完成时发送普通“继续”，Task 仍为 waiting_user，active Turn 数不变；
2. 提交 sibling target、旧 document token、旧 claim generation 或过期 interaction receipt，全部零写入；
3. 只提交页面验证 observation 或 interaction result 其中一枚，均零新 Turn；
4. 两枚同属 task/checkpoint 且 target/document/generation 全匹配时，`allOf` 才通过；重复提交也只能创建一个 WakeAuthorizationReceipt 和一个 successor Turn；
5. waiting_approval 同理只接受 `allOf(matching approval receipt)`，普通“继续”或页面 observation 都不能代替审批。

report 保存 candidate-resolution 与 wake-authorization 两类 receipt，validator 必须分别校验；只有 resolver 命中不能算恢复成功。

### 12.7 复用现有 fail-closed 验收

不创建 `outputs/agent-browser-live-proof` 平行体系。扩展现有设施：

- 入口：`npm run verify:browser-live-grounded`；
- runner：`scripts/run-browser-live-grounded.mjs`；
- 总 validator：`scripts/check-browser-live-grounded-report.cjs`；
- XHS runner/validator：`scripts/run-xhs-18-keyword-live-proof.mjs`、`scripts/check-xhs-18-keyword-live-proof-report.cjs`；
- Provider transfer runner/validator：`scripts/run-provider-transfer-live-proof.mjs`、`scripts/check-provider-transfer-live-proof-report.cjs`；
- 现有负例测试：`scripts/__tests__/check-browser-live-grounded-report.test.cjs`、`scripts/__tests__/check-xhs-18-keyword-live-proof-report.test.cjs`、`scripts/__tests__/check-provider-transfer-live-proof-report.test.cjs`。

实施时给 `package.json` 新增具名组合命令：

```json
"verify:agent-browser-live-grounded": "node scripts/run-browser-live-grounded.mjs --scenario=agent-browser-r1-r3"
```

它复用同一个 runtime handshake/source manifest/profile/DB/metrics contract，并把 XHS 与 provider-transfer 作为子场景写入：

```text
outputs/browser-live-grounded/<proofNonce>/
  browser-live-grounded-report.json
  background-pointer-spike/
  controlled-browser-fixture/
  xhs-r1-r3/
    xhs-18-keyword-report.json
    task-items.json
    execution-plan-domain-refs.json
    evidence-index.json
    artifact-digests.json
    recovery-receipts.json
    final-output.md
  provider-transfer/
```

XHS runner 增加 `--no-script-resume` 并移除当前“最多六次 `resumeRun`”对 R1–R3 的帮助；report 仍记录任何 resume attempt，validator 要求：

```text
userMessageCount == 1
humanResumeCount == 0
scriptResumeCount == 0
automaticSuccessorReceipts >= 1 (R1/R3)
canonicalAssistantMessageCount == 1
```

现有 XHS validator 在原有 18-keyword、canonical terminal、artifact、metrics 和 handshake 检查上扩展：

- 10 个合格 reference records；
- 每条三项数值证据与 parser/window contract；
- Task/ExecutionPlan/Browser domain terminal 一致；
- R1–R3 的零人工/脚本续作；
- QR/security verification 只能 `blocked`；
- 缺 run-scoped metrics、artifact、receipt、digest 或 source/profile identity 都非 0 退出。

现有 validator 的负例测试新增：删 automatic successor receipt、伪造 `scriptResumeCount=0`、缺 raw/normalized value、篡改 artifact digest、child paused/parent completed、QR 标 passed。任何负例未被拒绝，验收设施自身失败。

### 12.8 通用 Browser 证明边界

XHS 证明本次核心场景，不单独等于“通用 Browser 已可靠”。同一组合 gate 还必须运行：

1. 站点无关受控 fixture：多 tab、popup、iframe、download、navigation、延迟 DOM、target replacement、用户 takeover；
2. 不同页面形态的真实只读场景：Wikipedia 搜索结果 → 条目目录/表格 → 引用来源，证明非小红书 selector/流程也能工作。

两者都走同一个 `outputs/browser-live-grounded/<proofNonce>` manifest/validator。不得用 XHS 成功掩盖通用 fixture 失败，也不得用受控 fixture 代替 XHS 真实登录验收。

## 13. 压力与回归矩阵

| 场景 | 次数 | 必须证明 |
| --- | ---: | --- |
| Browser read/mutation loop | 150 tool calls | 无固定次数停机 |
| context rollover | 3 次 | work ledger 不丢 |
| Provider transient failure | 3 个不同位置 | 自动接力 |
| Browser service restart | 1 次 | target/effect 对账 |
| Renderer reload | 3 次 | Task 不变 |
| app restart | 1 次 | durable recovery |
| 用户 sibling tab 操作 | 20 次 | 不误 takeover |
| 用户同 target 输入 | 1 次 | 精确暂停/返还 |
| popup/download/dialog | 各 1 次 | scoped permission/finalize |
| result artifact readback | 全量 | digest 一致 |

## 14. 提交边界

唯一总顺序：

```text
Agent A0–A5
→ B0 fixtures
→ B0.5 background-pointer spike
→ B1 runtime service/session
→ B2 background work surface
→ B3 takeover/finalize
→ B4 tool surface
→ B5 BrowserResearchState/evidence
→ Agent A6+B6 联合 production cutover
→ Agent A7+B7 live proof/docs
```

B0–B5 可各自提交，但不能接生产入口。A6+B6 必须同一个不可拆提交/PR；B6 单独提交或合并由静态 gate 拒绝。

每个阶段先红测试、后实现、再真实入口。不得在 BrowserController 巨型文件继续堆业务；move-only 拆分与行为修改分开提交。

## 15. 后续并行能力的入场门

只有 B7 三轮全通过后，才可以另立 Browser target-isolated 并行计划。入场合同：

- 每个分支独占 target claim；
- Owner Agent 是唯一共享会话写者；
- Worker 无外部写权限；
- 分支结果先进入 candidate artifact；
- fresh verifier 接受后才能合并；
- 单 target 永远串行；
- 用户接管只暂停对应 target 分支。

本计划不实现该阶段。

## 16. 停止条件

只有以下情况需要 owner：

- 需要小红书登录/QR/安全验证；
- 需要新的付费 Provider 或外部账号；
- 需要迁移/删除无法恢复的真实 Browser session；
- 平台规则禁止计划中的自动操作；
- B0.5 证明所有不抢焦点的后台 pointer 路径均不可行，需要修改产品承诺；
- 当前 dirty tree 与 Browser 切换文件重叠且归属无法判断。

普通页面变化、选择器失效、测试失败或 Provider transient 不属于用户介入条件。
