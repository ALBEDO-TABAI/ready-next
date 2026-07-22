---
title: Browser Agent 单 Agent 长任务与标签页所有权收口实施计划
date: 2026-07-22
kind: implementation
status: approved-for-implementation
enforce: true
owner: 白
author: Codex
implementation_gate: approved-2026-07-22（白确认，范围=roadmap 裁决版）
scope: 单 Parent Owner、顺序 Browser 执行、物理标签页所有权、用户接管恢复、等待时钟、持久续跑、终态一致和真实 Electron 验收
blocked_followup:
  - docs/superpowers/plans/2026-07-22-agent-plan-execute-policy-hooks-and-branching-runtime-design.md
supersedes:
  - docs/superpowers/plans/2026-07-18-browser-agent-grounded-orchestration-and-capability-closure-implementation.md 的未通过实施门与后续追加收口
  - docs/superpowers/plans/2026-06-04-browser-collection-subagent-implementation.md 的旧 runner 与 surface lease 实施路径
  - docs/superpowers/plans/2026-06-04-agent-self-serve-browser-collection-implementation.md 的旧授权与站点策略实施路径
  - docs/superpowers/plans/2026-06-04-agent-browser-visible-crawler-implementation.md 的旧双浏览器实施路径
deferred_goal: 上述三份 2026-06-04 文档中的 Browser 子 Agent 功能目标没有被本计划交付；它被推迟到长任务架构与单 Agent 验收全部通过后的独立计划
requires:
  - docs/superpowers/audits/2026-07-22-browser-agent-long-task-root-cause-and-evidence.md
  - docs/architecture/current-runtime-contracts.md §5..§6
  - .claude/architectural-principles.md
review:
  reviewer: Claude
  date: 2026-07-22
  verdict: direction-adopted-with-scope-adjudication
  adjudication: docs/superpowers/plans/2026-07-22-agent-long-task-remediation-roadmap.md
  scope_delta: S3 收缩为 S3-min（定稿见 S3 章节）；§1.5 四张持久表移交架构计划 P3、§1.5.1 请求账本移交 P1；新增 §1.8 默认路由
  approved: 2026-07-22 白确认三项决策（S3-min / §1.8 默认路由 / L-1 选项 A）
---

# Browser Agent 单 Agent 长任务与标签页所有权收口实施计划

## 0. 决策、假设与硬门

### 0.1 当前决策

本计划只解决“一个 Parent Owner 顺序执行一个长程 Browser 调研任务”。不在本阶段开放：

- Browser 执行型子 Agent；
- 多 Agent 同时写不同标签页；
- 一个站点的多分支并行；
- candidate branching 或多路竞争；
- 站点名单、小红书专用兼容分支或固定搜索脚本。

理由不是保守，而是当前一把 surface 全局租约已能在单 Agent 跨 tab 时死锁；并行会让同一错误扩大成跨 Agent 越权。

2026-07-22 用户已确认本计划（范围=roadmap 裁决版：S3 定稿为 S3-min、新增 §1.8 默认路由），frontmatter 已同步 `approved-for-implementation / enforce: true`。后续任何范围变更必须先改 roadmap 裁决条目，再同步本文。

### 0.2 明确假设

1. 用户说的“标签页占用权限”是 Browser 控制权/写入权问题，不是 macOS 隐私权限或站点账号权限。真实日志和最小复现已证明该假设。
2. “用户切换到无关标签页”只是浏览行为，不构成对 Agent 目标页的接管。
3. “用户在 Agent 目标页产生真实键盘/指针输入”或点击明确接管按钮，才构成对该物理目标的接管。
4. 等待用户、确认、页面挑战或外部条件时，无进展计时不消耗；条件解决是一次新进展，应获得新的完整执行窗口。
5. 本计划不要求每次页面尝试都成功；它要求失败被正确归类、入账、恢复或停止，不会假成功、空转或重放未知写入。

### 0.3 总完成标准

以下全部成立才能把本计划标记 completed：

1. 标签页所有权的持久唯一资源键是 `(partition, tabId)`；当前进程内写入还必须精确绑定 physical target token + boot incarnation，surface 只表示呈现位置。
2. 写入准入、租约/所有权、workflow binding、permission binding、接管 fence 和 UI 监督读同一份 target claim。
3. Agent 可以在单线任务中先后操作多个标签页；一个 tab 被用户接管不影响无关 tab。
4. 接管后 UI 有真实“继续 Agent”动作；新 owner 从同一 Parent/Browser child/checkpoint 恢复，旧 owner 永久失效。
5. 等待用户超过 120 秒后，回答仍得到新的完整 no-progress window；多次反问不会累积成立即超时。
6. 任意控制冲突、stale target、页面挑战或权限拒绝都有持久 receipt，不依赖模型文本解释。
7. 超时、Provider 失败、应用重启或用户手动暂停后，按合同恢复原 taskId 的后继 run，不用“继续”建新 user_root 任务。
8. Parent、Browser child、run_meta、TaskProjection、scope run 和 Renderer 对任务类型、预算、进度和终态一致。
9. 原始小红书 18 组提示从干净 Parent 完整运行：18/18、账号适配分析、文件保存、文件回读、唯一最终回复和全链同步 done。
10. 真实 Electron 至少连续 3 次通过：一次无干预、一次人工接管后恢复、一次应用重启后恢复。
11. 全部专项 gate、native gate、typecheck、test 和 build 通过，受影响 native 路径不能靠 ABI skip 宣称覆盖。
12. 一份可重放验收报告记录 commit/build、隔离 userData/DB、run/task/browserTask IDs、关键日志、DB 摘要、输出文件 hash 和失败注入点。
13. 研究/采集型 Browser 工作默认在 agent 自有工作 tab 执行（§1.8）：A1 类验收运行全程用户活动 tab 的 URL、滚动与前台呈现零变化；用户查看 agent 工作 tab 不改变 claim；dormant 后台机器清理为零第三态。

### 0.4 子 Agent 入场硬门

上述 12 项完成前：

- Dynamic Delivery worker 继续零 Browser 工具；
- 不给 `parallel-branch-orchestrator` 注入 Browser facade；
- 不建第二套“临时多 tab 租约”兼容路径；
- 不把原始 18 组任务拆成子 Agent 来绕过当前错误。

## 1. 机器可验的目标合同

## 1.1 `BrowserTargetClaim` 是唯一写入所有权

不在旧 surface lease 旁边增加第二把 tab lock。本阶段直接将产品合同改为目标级 claim，旧 surface 互斥一次性退役。

```ts
interface BrowserLogicalTargetKey {
  partition: string
  tabId: string
}

interface BrowserPhysicalTargetKey extends BrowserLogicalTargetKey {
  physicalTargetToken: string
}

interface BrowserTargetClaim {
  version: 1
  claimId: string
  generation: number
  logicalKey: BrowserLogicalTargetKey
  physicalTargetToken: string | null
  bootIncarnationId: string | null
  profileId: string | null // 展示元数据，不参与资源唯一键
  surface: 'user-view' | 'agent-view' // 只供呈现/路由
  parentTaskId: string
  browserTaskId: string
  ownerRunId: string
  scopeId: string | null
  sessionId: string | null
  state: 'held' | 'user_owned' | 'suspended' | 'expired' | 'released'
  suspensionCheckpointId: string | null
  suspensionReason: string | null
  acquiredAt: number
  expiresAt: number
}
```

强制不变量：

1. 同一 logical target 同时最多一个 current row；`held` 写入还必须绑定当前 boot 的 exact `BrowserPhysicalTargetKey`。
2. 同一 Parent Owner 可以在多个 target 上分别持有 claim，但本阶段页面 mutate dispatch 仍串行。
3. `ensureGate(physicalTargetKey)` 必须核对 partition/tabId/current physical token/current boot。请求不同 target 时新建/取回该 target claim，不能 heartbeat 另一个 tab 的 lease。
4. 任何 write admission 同时核对 claimId、generation、ownerRunId 和 target key。
5. permission policy 只接受这份 claim 的签发回执，不再从 surface lease 猜 tabId。
6. physical target 被关闭、重建、重启或 token 变化时，旧 generation 立即 stale；旧 owner 后置写入为 0。
7. surface 切换、布局变化、BrowserView hide/show 不会改变 claim owner。

`partition` 是会话隔离的规范身份；默认 profile 的 `profileId`、本地 scope/session 都可以为 `null`，不得用空字符串伪造。permission binding、workflow binding 和 claim 都从同一 tab runtime 解析 partition/profile/scope/session，不能各自推导。

`physicalTargetToken` 当前包含随机 boot incarnation，跨应用启动必变，因此它不能作为 durable primary key。持久唯一键是 `(partition, tabId)`；physical token + boot id 只证明本次进程内的精确宿主。重启后旧 physical identity 必须失效，再从 logical tab materialize、fresh observe 并签发新 generation。

### 1.1.1 `browser_target_claims` 是持久唯一真值

claim 不放进某个 child 的 `payload_json`，也不与内存 lease 双轨。新增同一 SQLite 内的当前态表；历史由 control receipt 保留：

```sql
CREATE TABLE browser_target_claims (
  partition TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  physical_target_token TEXT,
  boot_incarnation_id TEXT,
  claim_id TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL,
  profile_id TEXT,
  surface TEXT NOT NULL,
  parent_task_id TEXT NOT NULL,
  browser_task_id TEXT NOT NULL,
  owner_run_id TEXT NOT NULL,
  scope_id TEXT,
  session_id TEXT,
  state TEXT NOT NULL,
  suspension_checkpoint_id TEXT,
  suspension_reason TEXT,
  acquired_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (partition, tab_id),
  CHECK (generation >= 1),
  CHECK (surface IN ('user-view', 'agent-view')),
  CHECK (state IN ('held', 'user_owned', 'suspended', 'expired', 'released')),
  CHECK ((physical_target_token IS NULL) = (boot_incarnation_id IS NULL)),
  CHECK (state != 'held' OR physical_target_token IS NOT NULL),
  CHECK (
    (state IN ('user_owned', 'suspended')
      AND suspension_checkpoint_id IS NOT NULL AND suspension_reason IS NOT NULL)
    OR (state IN ('held', 'expired', 'released')
      AND suspension_checkpoint_id IS NULL AND suspension_reason IS NULL)
  )
);
```

只有 `BrowserTargetClaimRepository` 可以写该表：

1. acquire/resume 以 logical key + 当前 physical token/boot + 旧 generation 做 CAS，成功时 generation 单调加一并签发新 claimId；同 logical target 不可能同时有两个 current row。
2. heartbeat 只允许当前 `held + claimId + generation + ownerRunId`，并在每次 page mutation 前刷新；内存只缓存 read-through snapshot，不是授权真值。
3. `user_owned` 只能由 target-specific takeover 事务写入；`suspended` 只用于仍可续跑但当前无写 owner 的 checkpoint/page challenge/provider error。两者都必须绑定 `suspensionCheckpointId + reason`，但恢复权限不同：`user_owned` 只接受精确 target wake，`suspended` 只接受同 Parent/browserTask/checkpoint 的 task-level wake。
4. physical replacement、logical close 和 boot restart 不共用一条笼统转换，必须按下表结算；每次都 generation + 1、写 control receipt，旧 generation 永远不能写新宿主。
5. 启动恢复不得只改 claim row；必须与 Browser child suspension delta、Parent continuationRef、旧 run 的 interrupted/checkpoint 终态和 control receipt 同事务。
6. migration 必须覆盖 fresh install、旧库升级和重复执行；`PRAGMA quick_check` 与唯一键竞态测试属于 S1 gate。

| 事件 / 当前状态 | `held` | `suspended` | `user_owned` | `released/expired` |
| --- | --- | --- | --- | --- |
| 同 boot 的 physical token replacement/rematerialize | 旧 owner stale，原子写 `suspended + target_stale checkpoint`；新宿主只能 typed task wake + fresh observe | 保持 suspended，更新为新 physical identity 前仍无写权；task wake 后 fresh observe | 保留 logical user fence；清掉旧 physical identity，新宿主 materialize 仍 user_owned，只有 target wake 可解 | 保持无 owner，不自动 acquire |
| logical tab close | 写 expired + target-closed checkpoint/continuation | 写 expired，continuation 显式记 target absent | 写 released；logical target 已消失，不留永久用户 fence | 保持终结 |
| boot restart | 写 expired，清 physical identity，同事务保存 child/base+delta/Parent continuation 并结算旧 run | 保持 suspended logical state/checkpoint，清 physical identity | 保持 user_owned logical fence/checkpoint，清 physical identity | 保持终结 |

对 boot restart 时的 `held` 再分三类：0/18 且未 dispatch 时保存空进度 child；mid-action 且 effect unknown 时在 delta 中写 unknown-effect 并先对账；已有 observations 时保留已结算 evidence watermarks。三者都保留同一 Parent/browserTask/request anchor，不新建用户任务。

claim、Browser child suspension、clean checkpoint、Parent continuationRef 和 control receipt 由一个 `BrowserControlUnitOfWork` 使用同一 DB handle/事务提交。事务后 Renderer push 失败只进入 projection retry，不回滚已成立的物理 fence；任何 repository 各自提交都不算实现。

claim 的 closeout 不交给 TTL 兜底，与 `finalizeRunOutcome()` 在同一 closeout Unit of Work 内结算：

| run/child 结果 | claim 结算 |
| --- | --- |
| done | 当前 `held -> released`，写 `claim_released` |
| cancelled_user | 当前 `held -> released`，保留审计历史 |
| delivery_failed 且无可续跑状态 | 当前 `held -> released` |
| checkpoint/manual wait/provider error/page challenge 且可续跑 | 当前 `held -> suspended`，写原因和 checkpoint receipt；`ownerRunId` 只保留 last-owner 审计，不再具有写权 |
| target 已被用户接管 | 保留 `user_owned` logical fence，不被普通 finalizer 释放 |

closeout 的扫描范围是旧 `ownerRunId` 当前持有的**全部** target，不是“触发暂停的当前 tab”。例如同一 run 先后持有 A/B，而 A 发生接管或 Provider 故障，closeout 必须在一个事务内把 B 等其余 `held` claim 一并按上表结算；不得留下仍指向已终结 run 的隐形写 owner。

任何非 active run 收尾后都必须 `held count = 0`。新 run 复用同一 tab 时，`released/expired` 可立即 acquire；`suspended` 只能由同 Parent/browserTask/continuation checkpoint 的 task-level wake 授权，`user_owned` 只能由精确 target wake 解锁。两者都不得等 TTL 才解锁。事务失败时物理 fence 保持 fail closed，但重试仍使用同一 idempotency key，不产生第二个终态。

### 1.2 接管严格绑定目标

用户信号映射：

| 信号 | 是否接管 | 作用范围 |
| --- | --- | --- |
| 切换到无关 tab | 否 | 不改任何 claim |
| 查看 Agent tab 但不输入 | 否 | 只改呈现 |
| Agent action window 内的页面回声 | 否 | 保持 Agent owner |
| 目标 tab 内的真实键盘/指针输入 | 是 | 仅该 target |
| 地址栏/前进后退/刷新等 chrome 发起的用户导航 | 是 | 仅该 target |
| 监督 UI 的明确接管 | 是 | 当前明确 target |
| 其他 tab 上的用户输入 | 否 | 不影响 Agent target |

补齐信号源（现状缺口，S2 交付）：目标 tab 的真实指针输入当前没有任何监听；`'navigation'` 信号源已定义但生产从未记录；用户关闭被 claim 的 tab 当前静默潜伏到下次写入才暴露。三者都必须接为 target 级信号/结算——关 tab 按 §1.1.1 状态矩阵同事务结算并写 control receipt。

接管转换必须在首个 `await` 之前完成 target fence，再在同一个 SQLite 事务内写：

- claim `held -> user_owned`；
- Browser control receipt；
- Browser child 暂停原因；
- `suspensionCheckpointId`（引用既有 `cleanBaseCheckpointId`）；
- Parent 的 continuationRef 和可继续动作。

事务失败时保留物理 fence，不恢复 Agent 写入；持久化重试只写同一 idempotency key。

### 1.2.1 Agent 回声与真实用户输入必须可归因

删除 surface lease 时不得丢掉现有 begin/end action window 的作用。所有 Agent 产生的键盘、指针、导航、提交和 tab switch 都必须携带 host 签发的 `actionCorrelationId + physicalTargetToken + bootIncarnationId + ownerRunId + generation`，并贯穿 dispatch、native input bridge、页面回声和 action outcome。

归因规则由代码固定：

1. 与 active action correlation 精确匹配的 input/navigation/focus 回声归因为 `agent_action`，永不触发 takeover。
2. Agent 发起的 `tabs_switch` 显式标为 `agent_action`；Renderer 中用户切换 tab 标为 `user_presentation`，二者都只改呈现。
3. 页面自发导航、重定向、DOM 重绘和 focus 变化标为 `page_or_system`，不冒充用户输入。
4. 只有来自可信 native 用户输入通道、精确命中同一 physical target，且无匹配 Agent correlation 的键盘/指针事件，才能签发 `target_user_owned`。
5. 不得只靠时间窗口猜归属；无 correlation 但也无可信用户来源的事件 fail closed 为非接管诊断，不改 claim。

action correlation 的开始/结束和归因结果进现有 action journal；只有真正改变 claim 的用户输入才另写 control receipt。进程在 action window 内崩溃时，startup recovery 使旧 `held` 过期，不把孤儿回声升级为用户接管。

### 1.3 接管恢复与页面人工挑战分离

保留两个独立原因：

- `browser_target_user_owned`：用户接管该 target，通过监督 UI 的“继续 Agent”恢复。
- `browser_page_challenge_user_required`：验证码、登录、网站异常或空壳，通过页面挑战卡回答后复核。

不再让模型用 `browser_request_takeover` 解决 target owner 冲突。两种状态的 UI、typed action、继续凭据和文案均不复用。

监督 UI 对被用户接管 target 的“继续 Agent”必须：

1. 绑定 parentTaskId/browserTaskId/logical target/oldGeneration/checkpointId；恢复时由 Main 重读当前 physical token/boot。
2. 用一次性 wake receipt 签发 `generation + 1` 的新 claim。
3. 启动 `runOrigin: continuation` 的新 run，request anchor 保留原用户请求，wake 只是 steering receipt。
4. 从同一 Browser child journal/research/checkpoint 续跑。
5. 任何旧 run/old generation 的写入均返回 stale-owner，不能回收新 owner。

这是一个完整跨进程功能，必须同步交付：共享 IPC schema、Main handler、Preload API、Renderer 类型与按钮、一次性 wake receipt、重复点击幂等和行为测试。Renderer 发送的最小输入为 `parentTaskId / browserTaskId / claimId / oldGeneration / checkpointId / wakeNonce`；Main 从 DB 重读并校验，不能相信 Renderer 自报 owner 或新 generation。重复 wake、旧 generation、错误 checkpoint 与切换会话后的迟到点击全部零写入。

task-level continue 与 target wake 是两个不同授权：

1. 任务卡继续、Provider/checkpoint 恢复或页面挑战解决时，typed wake 只绑定 `parentTaskId / browserTaskId / continuationCheckpointId / wakeNonce`，创建同一任务的新 continuation run；它不批量把 claim 改成 `held`。
2. 旧 run closeout 后的全部 `suspended` claim 保持无写 owner。新 continuation 第一次再次访问某个 target 时，Main 才核对该 claim 的 suspension checkpoint 是否属于本 continuation、重读当前 physical identity、执行 fresh observe/unknown-effect 对账，并以 CAS 签发新 generation；这是逐 target 的 lazy resume。
3. target wake 除了解除当前 `user_owned` fence，也同时给同一 Parent/browserTask/checkpoint 创建 task continuation；因此“接管 A -> 继续 -> 再访问 B”可以恢复 B 的 suspended claim，但不会顺带解除其他 `user_owned` target。
4. 任一 wake 都不能恢复另一 Parent、另一 Browser child、不在 continuation ancestry 中的 checkpoint，或已 logical-close 的 target。一个任务存在多个 `user_owned` target 时必须逐 target 明确继续。
5. control receipt 分别记录 `task_resume_authorized`、`target_resume_authorized` 和逐 target 的 `claim_resumed`；这样可区分“任务允许续跑”和“某一页面已重新取得写权”。

所有 wake 还必须经过 Parent-level continuation admission CAS：同一 `parentTaskId + browserTaskId + ancestryCheckpointId` 同时最多一个 active successor。task continue、A target wake、C target wake 即使 nonce/idempotencyKey 不同，首个事务只创建一个 successor；后续 wake 重读该 successor，仅向它追加精确 target authorization/receipt，不再 admission 第二个 run。旧 ancestry、已 settled successor 或 source generation 不匹配时 fail closed。successor 结算后才能以新 checkpoint/generation 开下一轮 continuation。

### 1.4 Browser control receipt 进入同一 child 真值

不用假 page action 表示未 dispatch 的拒绝。在现有 Browser child payload/journal 中增加独立、单调的 `controlReceipts`：

```ts
interface BrowserControlReceipt {
  receiptId: string
  sequence: number
  parentTaskId: string
  browserTaskId: string
  ownerRunId: string
  logicalTargetKey: BrowserLogicalTargetKey | null
  physicalTargetToken: string | null
  bootIncarnationId: string | null
  previousClaimId: string | null
  previousGeneration: number | null
  nextClaimId: string | null
  nextGeneration: number | null
  cleanBaseCheckpointId: string | null
  suspensionCheckpointId: string | null
  wakeId: string | null
  successorRunId: string | null
  continuationGeneration: number | null
  idempotencyKey: string
  kind:
    | 'claim_acquired'
    | 'claim_rejected'
    | 'target_user_owned'
    | 'target_stale'
    | 'page_challenge'
    | 'permission_denied'
    | 'claim_resumed'
    | 'claim_suspended'
    | 'claim_released'
    | 'claim_expired'
    | 'task_resume_authorized'
    | 'target_resume_authorized'
    | 'target_closed_or_replaced'
    | 'resume_rejected'
  errorCode: string | null
  recoverable: boolean
  createdAt: string
}
```

它只记控制事实，不冒充页面效果证据。before/after claim identity 使 current-row 被覆盖后仍能证明 generation 历史；checkpoint/wake/idempotency 字段使验收器可以从 action/observation evidence 反向 join 到精确 claim 转换，而不是依赖日志推断。没有 claim 变化的 task-level receipt 将两组 claim 字段保持 `null`，但必须带 wake/checkpoint；claim 转换 receipt 必须按 kind 填齐相应 before/after identity，由 schema CHECK 和行为测试强制。Browser candidate closure 看到 recoverable control blocker 后立即停止模型空转，产生指向同一 receipt/checkpoint 的可继续终态。

#### 首次调用与 targetless operation 顺序

不能继续使用“取到 claim 后才进入 child/journal”的顺序。所有 Browser operation 固定为：

1. 先用 Parent identity 原子创建或恢复唯一 `browser_workflow` child，并登记 operationId；因此第一次调用失败也一定有 browserTaskId。
2. host 根据工具合同区分 targetless management、target-bound read 和 target-bound mutation；模型不能自报分类。
3. target-bound operation 解析完整 physical target；mutation 再 CAS 获取 claim。失败时直接向已绑定 child 写 control receipt。
4. claim 成功后才登记 page action begin 并 dispatch；页面 effect 仍只进入现有 action outcome/journal。

管理动作合同固定为：

| operation | claim 要求 | 持久结果 |
| --- | --- | --- |
| `tabs_open` | 打开前无 target claim | child operation receipt；成功后绑定新 physical target，首次页面 mutation 再取 claim |
| `tabs_switch` | 不取 claim | 只改呈现；不转移任何 target owner，不把离开 leased tab 当接管 |
| `tabs_close` | Agent 发起时必须持有被关闭 target claim；用户关闭走用户事件链 | close outcome 与 claim `released/expired` 同一事务结算 |
| snapshot/read/wait | 不取 write claim，但必须核对 workflow + exact target identity | observation receipt 或 typed stale-target |
| type/click/search/navigate/permission decision | 必须持有 exact target claim | action journal + effect receipt |

这样 R4 在“首次 acquire 失败”“新开 tab 后首次 mutation 失败”和“target 已关闭”三条路径上都不会复现。

#### checkpoint 名称与恢复关系

- `cleanBaseCheckpointId`：当前 owner 最后一次已验证、可作为模型恢复输入的完整 final input；暂停动作不得覆写它。
- `suspensionCheckpointId`：引用 clean base 的状态 delta，只记录暂停原因、control receipt、interaction/claim identity、未完成 operation 和最新域状态 refs；它本身不冒充 clean model input。
- 恢复输入由 `clean base + 已验证 suspension delta + typed wake/steering` 确定性组装；新 owner 首次安全结算后再写新的 clean base。

所有 continuationRef 同时保存这两个 id；只有 delta 没有 clean base，或二者 generation 不匹配时，必须 block repair，不能回放不明历史。

### 1.5 无进展时钟是显式生命周期

> **复核裁决（2026-07-22，roadmap 裁决 2）**：本节的显式 suspend/resume 时钟语义与“回答后获得完整新窗口”的行为验收保留在本计划 S3。但下文四张 interaction lifecycle / suspension epoch / outcome delivery / progress clock 持久表及其全边界崩溃注入矩阵，整体移交长任务架构计划 P1（该计划 §2.2 是同一套账本的归属地）。S3 以进程内 `InteractionLifecycleRegistry`（包装现有 ask / 技能 ask / 高危确认 / 页面挑战 / 接管等 pending 源）+ 显式时钟状态机实现同等可观察行为；重启期语义沿用现有 checkpoint 冷启动合同（contracts §5）与本文 §1.6。下文表结构作为移交后的目标设计原文保留，不在本计划内建表。

`DeliveryDeadlineHandle` 增加具名转换：

```ts
interface DeliveryProgressClock {
  noteProgress(reason: 'text_delta' | 'tool_result' | 'user_input_resolved'): void
  suspend(reason: 'user_input' | 'confirmation' | 'external_condition', interactionId: string): void
  resume(interactionId: string): void
  dispose(): void
}
```

clock 不再轮询两个零散 pending store。新增共享 `InteractionLifecycleRegistry`，统一记录 `created -> pending -> resolved | rejected | expired | cancelled`，并绑定 interactionId/runId/agentId/scopeId/type。至少注册：普通 ask、技能 ask、高危 action confirmation、Browser power confirmation、handoff、page challenge 和 human takeover。clock 只消费 lifecycle event；resolved/rejected/expired 分别查找创建时冻结的 outcome→disposition 映射，错误 run/agent/scope 的迟到事件零影响。registry 状态持久化，应用重启后只恢复可确定重建的 waiter，其余按合同结算。

不只是“持久一个布尔值”。四张 canonical 表固定为可直接演练的 SQLite 合同：

```sql
CREATE TABLE interaction_lifecycles (
  interaction_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  suspension_epoch_id TEXT NOT NULL,
  clock_revision INTEGER NOT NULL CHECK (clock_revision >= 1),
  agent_id TEXT NOT NULL,
  scope_id TEXT,
  interaction_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('created','pending','resolved','rejected','expired','cancelled')
  ),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  on_resolved TEXT NOT NULL CHECK (
    on_resolved IN ('resume_with_result','checkpoint','terminate')
  ),
  on_rejected TEXT NOT NULL CHECK (
    on_rejected IN ('resume_with_result','checkpoint','terminate')
  ),
  on_expired TEXT NOT NULL CHECK (
    on_expired IN ('resume_with_result','checkpoint','terminate')
  ),
  restart_disposition TEXT NOT NULL CHECK (
    restart_disposition IN ('restore','expire_to_checkpoint','terminate')
  ),
  business_payload_ref TEXT,
  business_payload_digest TEXT,
  created_at INTEGER NOT NULL,
  pending_at INTEGER,
  settled_at INTEGER,
  outcome_digest TEXT,
  create_idempotency_key TEXT NOT NULL UNIQUE,
  settlement_idempotency_key TEXT UNIQUE,
  CHECK ((business_payload_ref IS NULL) = (business_payload_digest IS NULL)),
  CHECK (restart_disposition != 'restore' OR business_payload_ref IS NOT NULL),
  CHECK (
    (state = 'created' AND pending_at IS NULL)
    OR (state != 'created' AND pending_at IS NOT NULL AND pending_at >= created_at)
  ),
  CHECK (
    (state IN ('created','pending') AND settled_at IS NULL AND outcome_digest IS NULL)
    OR (state IN ('resolved','rejected','expired','cancelled')
        AND settled_at IS NOT NULL AND settled_at >= created_at
        AND outcome_digest IS NOT NULL AND settlement_idempotency_key IS NOT NULL)
  )
);

CREATE INDEX interaction_lifecycles_pending_run
  ON interaction_lifecycles(run_id, suspension_epoch_id, state);

CREATE TABLE interaction_suspension_epochs (
  suspension_epoch_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  clock_revision INTEGER NOT NULL CHECK (clock_revision >= 1),
  state TEXT NOT NULL CHECK (
    state IN ('pending','resume_pending','delivered','checkpointed','terminated','cancelled')
  ),
  pending_count INTEGER NOT NULL CHECK (pending_count >= 0),
  aggregate_disposition TEXT NOT NULL CHECK (
    aggregate_disposition IN ('resume_with_result','checkpoint','terminate')
  ),
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  UNIQUE(run_id, clock_revision),
  CHECK (
    (state = 'pending' AND pending_count > 0 AND settled_at IS NULL)
    OR (state != 'pending' AND pending_count = 0 AND settled_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX interaction_suspension_epochs_one_open_run
  ON interaction_suspension_epochs(run_id)
  WHERE state IN ('pending','resume_pending');

CREATE TABLE interaction_outcome_deliveries (
  delivery_id TEXT PRIMARY KEY,
  source_run_id TEXT NOT NULL,
  suspension_epoch_id TEXT NOT NULL,
  clock_revision INTEGER NOT NULL CHECK (clock_revision >= 1),
  target_run_id TEXT,
  interaction_set_ref TEXT NOT NULL,
  interaction_set_digest TEXT NOT NULL,
  outcome_bundle_ref TEXT NOT NULL,
  outcome_bundle_digest TEXT NOT NULL,
  resume_checkpoint_id TEXT NOT NULL,
  target_runner_binding_ref TEXT,
  target_runner_binding_digest TEXT,
  state TEXT NOT NULL CHECK (
    state IN ('pending','applied','cancelled','suppressed')
  ),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  create_idempotency_key TEXT NOT NULL UNIQUE,
  apply_idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  applied_at INTEGER,
  cancelled_at INTEGER,
  suppressed_at INTEGER,
  UNIQUE(source_run_id, suspension_epoch_id),
  CHECK (
    (state = 'pending'
      AND target_run_id IS NULL
      AND target_runner_binding_ref IS NULL
      AND target_runner_binding_digest IS NULL
      AND apply_idempotency_key IS NULL
      AND applied_at IS NULL AND cancelled_at IS NULL AND suppressed_at IS NULL)
    OR (state = 'applied'
      AND target_run_id IS NOT NULL
      AND target_runner_binding_ref IS NOT NULL
      AND target_runner_binding_digest IS NOT NULL
      AND apply_idempotency_key IS NOT NULL
      AND applied_at IS NOT NULL AND cancelled_at IS NULL AND suppressed_at IS NULL)
    OR (state = 'cancelled'
      AND target_run_id IS NULL
      AND target_runner_binding_ref IS NULL
      AND target_runner_binding_digest IS NULL
      AND apply_idempotency_key IS NOT NULL
      AND applied_at IS NULL AND cancelled_at IS NOT NULL AND suppressed_at IS NULL)
    OR (state = 'suppressed'
      AND target_run_id IS NOT NULL
      AND target_runner_binding_ref IS NOT NULL
      AND target_runner_binding_digest IS NOT NULL
      AND apply_idempotency_key IS NOT NULL
      AND applied_at IS NOT NULL AND cancelled_at IS NULL
      AND suppressed_at IS NOT NULL)
  )
);

CREATE INDEX interaction_outcome_deliveries_state
  ON interaction_outcome_deliveries(state, source_run_id);

CREATE TABLE delivery_progress_clocks (
  run_id TEXT PRIMARY KEY,
  suspension_epoch_id TEXT,
  state TEXT NOT NULL CHECK (
    state IN ('active','suspended','resume_pending','closed')
  ),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  configured_window_ms INTEGER NOT NULL CHECK (configured_window_ms > 0),
  last_progress_at INTEGER NOT NULL,
  suspended_at INTEGER,
  deadline_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK (
    (state = 'active' AND suspension_epoch_id IS NULL
      AND deadline_at IS NOT NULL AND suspended_at IS NULL)
    OR (state = 'suspended' AND suspension_epoch_id IS NOT NULL
      AND deadline_at IS NULL AND suspended_at IS NOT NULL)
    OR (state = 'resume_pending' AND suspension_epoch_id IS NOT NULL
      AND deadline_at IS NULL AND suspended_at IS NOT NULL)
    OR (state = 'closed' AND deadline_at IS NULL)
  )
);

CREATE TRIGGER interaction_lifecycle_epoch_guard_insert
BEFORE INSERT ON interaction_lifecycles
WHEN NOT EXISTS (
  SELECT 1 FROM interaction_suspension_epochs e
  WHERE e.suspension_epoch_id = NEW.suspension_epoch_id
    AND e.run_id = NEW.run_id
    AND e.clock_revision = NEW.clock_revision
    AND e.state = 'pending'
)
BEGIN
  SELECT RAISE(ABORT, 'interaction_suspension_epoch_missing');
END;

CREATE TRIGGER interaction_delivery_epoch_guard_insert
BEFORE INSERT ON interaction_outcome_deliveries
WHEN NOT EXISTS (
  SELECT 1 FROM interaction_suspension_epochs e
  WHERE e.suspension_epoch_id = NEW.suspension_epoch_id
    AND e.run_id = NEW.source_run_id
    AND e.clock_revision = NEW.clock_revision
    AND e.state = 'resume_pending'
    AND e.pending_count = 0
    AND e.aggregate_disposition = 'resume_with_result'
)
BEGIN
  SELECT RAISE(ABORT, 'interaction_delivery_epoch_missing');
END;

CREATE TRIGGER interaction_lifecycle_epoch_identity_immutable
BEFORE UPDATE OF run_id, suspension_epoch_id, clock_revision
ON interaction_lifecycles
BEGIN
  SELECT RAISE(ABORT, 'interaction_epoch_identity_is_immutable');
END;

CREATE TRIGGER interaction_delivery_epoch_identity_immutable
BEFORE UPDATE OF source_run_id, suspension_epoch_id, clock_revision
ON interaction_outcome_deliveries
BEGIN
  SELECT RAISE(ABORT, 'interaction_delivery_epoch_identity_is_immutable');
END;

CREATE TRIGGER interaction_suspension_epoch_identity_immutable
BEFORE UPDATE OF suspension_epoch_id, run_id, clock_revision
ON interaction_suspension_epochs
BEGIN
  SELECT RAISE(ABORT, 'interaction_suspension_epoch_identity_is_immutable');
END;

CREATE TRIGGER delivery_progress_clock_epoch_guard_insert
BEFORE INSERT ON delivery_progress_clocks
WHEN NEW.state IN ('suspended','resume_pending') AND NOT EXISTS (
  SELECT 1 FROM interaction_suspension_epochs e
  WHERE e.suspension_epoch_id = NEW.suspension_epoch_id
    AND e.run_id = NEW.run_id
    AND e.clock_revision = NEW.revision
    AND (
      (NEW.state = 'suspended' AND e.state = 'pending')
      OR (NEW.state = 'resume_pending' AND e.state = 'resume_pending')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'delivery_progress_clock_epoch_missing');
END;

CREATE TRIGGER delivery_progress_clock_epoch_guard_update
BEFORE UPDATE OF run_id, suspension_epoch_id, state, revision
ON delivery_progress_clocks
WHEN NEW.state IN ('suspended','resume_pending') AND NOT EXISTS (
  SELECT 1 FROM interaction_suspension_epochs e
  WHERE e.suspension_epoch_id = NEW.suspension_epoch_id
    AND e.run_id = NEW.run_id
    AND e.clock_revision = NEW.revision
    AND (
      (NEW.state = 'suspended' AND e.state = 'pending')
      OR (NEW.state = 'resume_pending' AND e.state = 'resume_pending')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'delivery_progress_clock_epoch_missing');
END;

CREATE TRIGGER delivery_progress_clock_run_identity_immutable
BEFORE UPDATE OF run_id
ON delivery_progress_clocks
BEGIN
  SELECT RAISE(ABORT, 'delivery_progress_clock_run_is_immutable');
END;
```

`InteractionLifecycleRepository` 是 lifecycle 唯一写者，所有转换必须带 `expected revision + create/settlement idempotency key` CAS。业务回答/确认内容仍存原有 domain payload；lifecycle 只存 ref/digest，不复制第二份业务状态。

交互的**创建**和**结算**都属于 `InteractionLifecycleUnitOfWork`。创建首个 blocker 时，domain waiter/card payload、new suspension epoch、lifecycle pending row、clock revision+suspend 必须同一 SQLite 事务提交；同 epoch 的后续 blocker 原子增加 pending_count 并写 lifecycle。Renderer 只投影 commit 后的卡片。事务前崩溃得到“全部不存在”，事务后崩溃得到“pending card + pending lifecycle + suspended clock”，永远不能出现可见卡片但 active deadline 仍跑，或孤立 suspended clock。

结算事务同样原子更新 domain outcome、lifecycle、epoch pending_count/aggregate disposition、progress clock、outcome delivery 和必要的 checkpoint/finalizer receipt；Renderer push 只是事后投影。每轮 suspend 都创建新的 `suspensionEpochId + clockRevision`；同一 run 的下一轮 ask 不复用上一轮 epoch。

每个 interaction 创建时由代码分别冻结 `on_resolved / on_rejected / on_expired`：

- `resume_with_result`：包括确认允许/拒绝后都要把 typed 结果返回模型的场景；拒绝不得默认终止。
- `checkpoint`：如 page challenge 的 expired 结果，结算为可续跑 checkpoint，不留 active+suspended 空壳；同一 page challenge 的 resolved 则可是 `resume_with_result`。
- `terminate`：只用于明确用户停止或不可恢复合同，进唯一 finalizer。

同时冻结 `restartDisposition`：只有业务 payload、canonical checkpoint 和 waiter 都能从持久事实确定性重建的类型才是 `restore`。当前纯内存的普通 ask、skill ask 和确认 Promise/frozen call 不得伪装恢复，必须是 `expire_to_checkpoint`：启动事务将旧 lifecycle 结算 expired，销毁旧 active waiter，把 Renderer 旧卡标为 expired/reissue，并以新 run + typed result/steering 从 checkpoint 重建。高危 frozen action 始终保持未授权，不因重启自动释放。`terminate` 只适用于合同明确不可续跑者。

启动 reconciliation 必须以 suspension epoch 遍历全部 pending lifecycle，在同一 Unit of Work 内 restore 或按 restart disposition 结算；结束后不允许存在无业务 waiter 的 pending row，也不允许 active/suspended/resume_pending 但无 durable runner 或 continuation 的 run。epoch/lifecycle/clock 任一 identity 不匹配都 fail closed 并进入 repair，不能按 created_at 猜同一轮。

同一 run 的同一 suspension epoch 允许多个 pending blocker。clock 从第一个 interaction 的 `created_at` 起立即 suspend。聚合优先级固定为 `terminate > checkpoint > resume_with_result`：任一 blocker 结算为 terminate，立即进唯一 finalizer；任一结算为 checkpoint，立即做 checkpoint closeout。这两种情况都在同一事务将该 epoch 其余 created/pending interactions 写为 cancelled/expired、清掉 waiter并关闭 clock，不碰旧/新 epoch。只有该 epoch 的 pending_count 到 0 且全部实际 disposition 均为 resume_with_result，才从**该 epoch 的 lifecycle rows**生成按 interaction identity 稳定排序的 typed outcome bundle，并以 `(sourceRunId, suspensionEpochId)` 唯一写 delivery。上一轮 terminal rows 永不进入下一轮 bundle。

最后一个 blocker 结算时不得直接 resolve 内存 Promise 或把 clock 改回 active。该事务必须同时写 outcome bundle ref/digest、确定性的 `resumeCheckpointId`、`interaction_outcome_deliveries(state=pending)`，并把 source clock 改成 `resume_pending`。提交后由唯一 delivery coordinator CAS 应用：若原 runner 仍以相同 generation 活着，则把 bundle 写入它的 canonical next-input frame；否则先以同一 Parent/Browser child/request anchor 创建 `runOrigin=continuation` 的 successor。无论哪条路径，都要在一次事务中持久 target runner binding/checkpoint、把 delivery 改成 applied，并将目标 clock 从提交时刻获得完整窗口（同 run 则 `resume_pending -> active`；新 run 则关闭 source clock 并创建 target active clock），之后才允许下一次 Provider 请求。

创建 successor 不是单独插一条新 run：恢复 Unit of Work 必须让 source run 经唯一 finalizer 结算为 `interrupted/checkpoint` 并写 continuationRef，同时 admission successor、切换 runner binding/generation、关闭 source clock、创建 target active clock和 apply delivery。事务前只能是 source active，事务后只能是 successor active；失败则全部不成立。旧 source 的 timer、Promise、Provider delta 和工具回调因终态/generation 不匹配永久零写入。

内存 Promise/事件只负责提醒 runner 重读 canonical frame，不承载回答真值。`applied` 只表示 outcome 已恰好一次写入 canonical input，不授予执行权。启动时必须同时扫描 pending delivery，以及 applied 但 target runner 当前未挂载的记录：前者按同一 idempotency key 应用；后者只有在 target run 仍为可执行态、finalizer 未终结、runner binding generation 精确匹配且 request ledger 允许时才重挂。target 已 terminal/cancelled/superseded、delivery 已 suppressed 或 generation 不匹配时永久不重挂。

用户停止与更高优先级 finalizer 对 pending delivery 做 `pending -> cancelled`；若 outcome 已 applied 但尚未有 Provider request `sent`，则在同一终态事务做 `applied -> suppressed` 并取消 target scope。request 已 sent 时仍终结 run、fence 迟到 delta/tool call，但保留 applied 审计。pending-stop 与 applied-before-send-stop 两条路径都必须做 stop→crash→restart 注入，后续 Provider/tool 调用为 0。

不变量：

1. suspend 是状态，不是每秒重新延迟一次 timer。
2. 不匹配 interactionId 的回答不能恢复该 run。
3. 最后一个 blocker 以 `resume_with_result` 结算时只进入 durable `resume_pending`；outcome bundle 被原子装入 target canonical frame 后才增加 clock revision，并从 apply commit 时刻获得完整 `progressWindowMs`。
4. 多次 suspend/resume 每次都得到新窗口；旧 timer 因 revision 不匹配无效。
5. 用户等待 TTL 由交互卡合同负责；执行 no-progress clock 不偷做卡片超时。
6. 真正的活跃无进展达上限时，已有 Browser plan/journal 的长任务先写 clean checkpoint，不以普通发送失败丢弃 child identity。
7. lifecycle、epoch、clock 和 delivery 都以同一 `suspensionEpochId + clockRevision` 关联；不得用时间戳、run 内所有 terminal interaction 或内存数组重建 outcome bundle。

### 1.5.1 最小 Provider 请求账本必须在本计划内落地

> **复核裁决（2026-07-22，roadmap 裁决 2）**：本节标题的“必须在本计划内落地”不再成立——四张 execution 账本表与 §1.5 持久表一并移交长任务架构计划 P1，本计划不前置实现一份尚未获批架构的最深层 schema（那会倒置评审顺序，也正是本节自述“互相阻塞”的根源）。S3-min 接受的过渡风险（崩溃窗口内的粗粒度恢复与潜在重复计费，不产生重复外部副作用——页面动作仍由既有 journal 去重）与理由记录在 roadmap 裁决 2。下文保留为移交后的目标设计原文。

outcome outbox 不能依赖后续长任务架构才会实现的请求账本，否则 Browser A1–A12 与后续计划互相阻塞。S3 先交付最终结构的共享最小底座；本计划只启用现有 Owner/continuation 的 `direct` scope，后续 Plan-and-Execute 直接复用并启用其他 scope kind，不得另建第二套：

```sql
CREATE TABLE execution_parent_budgets (
  parent_task_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  hard_limits_json TEXT NOT NULL,
  used_json TEXT NOT NULL,
  reserved_json TEXT NOT NULL,
  source_snapshot_ref TEXT NOT NULL,
  source_snapshot_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE execution_budget_entries (
  entry_id TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL,
  call_scope_id TEXT,
  request_index INTEGER,
  entry_kind TEXT NOT NULL CHECK (
    entry_kind IN (
      'initial','carry_forward','request_reserve',
      'request_settle','request_unknown','request_release'
    )
  ),
  debit_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  CHECK (
    (entry_kind IN ('initial','carry_forward')
      AND call_scope_id IS NULL AND request_index IS NULL)
    OR (entry_kind NOT IN ('initial','carry_forward')
      AND call_scope_id IS NOT NULL AND request_index IS NOT NULL)
  )
);

CREATE TABLE execution_call_scopes (
  call_scope_id TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (
    scope_kind IN ('admission','direct','node','replan','verifier','selector')
  ),
  scope_key TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  plan_id TEXT,
  plan_revision INTEGER,
  node_id TEXT,
  node_attempt_id TEXT,
  owner_run_id TEXT NOT NULL,
  owner_binding_json TEXT NOT NULL,
  input_ref_json TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  source_candidate_ref_json TEXT,
  clean_checkpoint_ref_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('prepared','running','checkpointed','settled','interrupted','cancelled')
  ),
  usage_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(parent_task_id, scope_kind, scope_key, attempt_number)
);

CREATE TABLE execution_provider_requests (
  call_scope_id TEXT NOT NULL,
  request_index INTEGER NOT NULL CHECK (request_index >= 1),
  request_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('prepared','sent','delta_accepted','settled','unknown_after_crash','cancelled')
  ),
  first_accepted_delta_kind TEXT CHECK (
    first_accepted_delta_kind IS NULL
    OR first_accepted_delta_kind IN ('text','reasoning','tool_call_partial')
  ),
  budget_debit_ref TEXT NOT NULL,
  usage_json TEXT,
  prepared_at INTEGER NOT NULL,
  sent_at INTEGER,
  settled_at INTEGER,
  PRIMARY KEY(call_scope_id, request_index),
  CHECK (
    (state = 'prepared'
      AND sent_at IS NULL AND settled_at IS NULL
      AND first_accepted_delta_kind IS NULL)
    OR (state = 'sent'
      AND sent_at IS NOT NULL AND settled_at IS NULL
      AND first_accepted_delta_kind IS NULL)
    OR (state = 'delta_accepted'
      AND sent_at IS NOT NULL AND settled_at IS NULL
      AND first_accepted_delta_kind IS NOT NULL)
    OR (state = 'settled'
      AND sent_at IS NOT NULL AND settled_at IS NOT NULL)
    OR (state = 'unknown_after_crash'
      AND sent_at IS NOT NULL AND settled_at IS NOT NULL)
    OR (state = 'cancelled'
      AND settled_at IS NOT NULL)
  ),
  CHECK (sent_at IS NULL OR sent_at >= prepared_at),
  CHECK (settled_at IS NULL OR settled_at >= prepared_at)
);

CREATE TRIGGER execution_call_scope_budget_guard_insert
BEFORE INSERT ON execution_call_scopes
WHEN NOT EXISTS (
  SELECT 1 FROM execution_parent_budgets b
  WHERE b.parent_task_id = NEW.parent_task_id
)
BEGIN
  SELECT RAISE(ABORT, 'execution_call_scope_parent_budget_missing');
END;

CREATE TRIGGER execution_provider_request_parent_guard_insert
BEFORE INSERT ON execution_provider_requests
WHEN NOT EXISTS (
  SELECT 1
  FROM execution_call_scopes s
  JOIN execution_budget_entries b
    ON b.entry_id = NEW.budget_debit_ref
   AND b.entry_kind = 'request_reserve'
   AND b.parent_task_id = s.parent_task_id
   AND b.call_scope_id = NEW.call_scope_id
   AND b.request_index = NEW.request_index
  WHERE s.call_scope_id = NEW.call_scope_id
)
BEGIN
  SELECT RAISE(ABORT, 'execution_provider_request_parent_or_budget_missing');
END;

CREATE TRIGGER execution_provider_request_identity_immutable
BEFORE UPDATE OF
  call_scope_id, request_index, request_digest, budget_debit_ref, prepared_at
ON execution_provider_requests
BEGIN
  SELECT RAISE(ABORT, 'execution_provider_request_identity_is_immutable');
END;

CREATE TRIGGER execution_budget_entries_immutable_update
BEFORE UPDATE ON execution_budget_entries
BEGIN
  SELECT RAISE(ABORT, 'execution_budget_entry_is_append_only');
END;

CREATE TRIGGER execution_budget_entries_immutable_delete
BEFORE DELETE ON execution_budget_entries
BEGIN
  SELECT RAISE(ABORT, 'execution_budget_entry_is_append_only');
END;

CREATE TRIGGER execution_call_scope_parent_immutable
BEFORE UPDATE OF parent_task_id, scope_kind, scope_key, attempt_number
ON execution_call_scopes
BEGIN
  SELECT RAISE(ABORT, 'execution_call_scope_identity_is_immutable');
END;
```

当前 Ready DB connection 没有启用 SQLite foreign-key enforcement，因此本合同不把一个实际不生效的 `FOREIGN KEY` 当安全边界。预算、scope 和 request 由同一 repository/事务写入，上述 trigger 另外阻止 orphan scope/request、非 `request_reserve` debit、身份改写和错误 debit 直写；startup query 也必须 inner-join scope + Parent budget + 精确 reserve entry，任何 orphan/不匹配 row 一律先结算损坏事实，绝不联网。native gate 必须证明直接插 orphan、拿 settle/unknown entry 冒充 reserve、更新/删除预算 entry 均由 trigger 失败，并额外跑 integrity/quick check；未来若全连接统一开启 `PRAGMA foreign_keys=ON`，仍保留这些业务身份检查。

新 Parent 在第一次 Owner 请求前以本次 admission 硬顶写 `initial` budget entry；已有 resumable Parent 在首次续跑前必须从唯一可验证的 current runtime budget snapshot 写 `carry_forward` entry，完整保留 hard limits/used/reserved 和 source digest。多个快照不一致或不能证明唯一来源时 fail closed 为 `budget_migration_blocked`，不得选择较小 used、清零或退款。每次 request prepared 在同一事务写 `request_reserve` entry 和 Parent budget revision；settle/unknown/release 追加新 entry，used 单调、reserved 只按精确 request 转换。本阶段先供 direct/continuation 使用，S4 在 R6 证明后让 run_meta/projection/UI 全部改读这本账。

强制顺序：outcome apply 与 target direct scope/input checkpoint 同事务；事务提交后才可创建 request `prepared` + 当前 Parent budget debit；真实联网前写 `sent`；首个 text/reasoning/partial tool-call delta 先写 `delta_accepted`，再进入隔离 candidate，绝不直接进 session/UI。启动或发送 `prepared` row 前必须再次 CAS 校验 call scope 仍为 running、target run 可执行、finalizer 未终结且 runner binding generation 精确匹配；任一不满足就在同一终态事务把 request 写 cancelled，网络调用为 0。`prepared` 崩溃只有通过这次准入才可发送原 row；`sent` 后崩溃统一写 `unknown_after_crash`，旧 scope/run 结算 interrupted/checkpoint，从 clean checkpoint 创建新 continuation scope，不能在旧 scope 重发。已 applied outcome 按 deliveryId 从 canonical input 确定性装入一次，新 scope 不重复追加；旧 scope 的迟到 delta/tool call 因 generation 失配零写入。

这份最小账本只解决“输入已持久化后，下一次模型调用是否已发送/是否已接收语义输出”的恢复边界；Parent 全类型预算、admission/replan/verifier/selector 和 plan/node 归属仍由被本计划阻塞的长任务架构阶段扩展，但必须原地复用这四张表。A7 所谓不重复，是同一 scope/request 不重发、同一 outcome 不重复注入、工具不重复 dispatch；`sent` 后崩溃允许从 checkpoint 创建新 scope 的新请求，并将旧请求按未知成本记账，不能声称外部服务恰好一次。

### 1.6 续跑保留原请求、Parent 和 Browser child

终态映射固定为：

| 事件 | 终态 | 是否保留 Browser checkpoint |
| --- | --- | --- |
| target 被用户接管 | `manual_suspend` | 是 |
| 页面挑战需人工处理 | `checkpoint_user_input` | 是 |
| 长任务活跃无进展 | `checkpoint_incomplete` | 是 |
| Provider/transport 有界重试耗尽，且已有 durable Browser child/plan/journal 或任一 resumable state（允许 0/18） | `blocked_tool_error` | 是 |
| 用户显式停止 | `cancelled_user` | 否自动续跑，可保留审计账本 |
| 无任何可续跑状态的普通发送失败 | `delivery_failed` | 否 |

主路径是任务卡或监督 UI 的 typed “继续 Agent”，它直接携带 task/checkpoint identity。自然语言“继续”不由代码做字符串匹配，也不静默选择“最近任务”：模型从 TurnFrame 中的结构化 resumable candidates 做语义选择，再调用 typed resume action；候选超过一个且用户没有指明时，必须通过一次结构化反问确认。零候选时按普通新请求处理。恢复时：

- taskId 不变；
- browserTaskId 不变；
- initial requestAnchor 不变；
- 新轮文本作为 steering/wake receipt；
- runId 新建且 `runOrigin=continuation`；
- 已结算 action/observation 不重放。

### 1.7 终态和预算只有一条写入方向

1. `finalizeRunOutcome()` 仍是唯一终态入口。
2. Browser child 域真值 + Parent outcome 在同一 closeout 事务内产生 TaskProjection/run_meta 结果。
3. scope run 和 Renderer 不再独立猜“完成”；IPC `success=true` 不是任务 done。
4. 任务类型从 Parent 绑定后不回落 `short_task`。Browser 18 项研究始终为 `research`。
5. 预算的 max/used/remaining 由同一 runtime ledger 派生；run_meta、checkpoint 和 TaskProjection 不各自初始化。
6. `checkpoint_incomplete` 在 Main、DB、TaskProjection、scope run 和 UI 统一显示“已暂停、可继续”，不显示已完成。

### 1.8 研究型工作的默认目标路由（裁决 5，2026-07-22 定稿）

目标状态：用户和 Agent 在同一个浏览器里各干各的。claim（§1.1）让冲突安全，归因（§1.2/§1.2.1）让冲突可判，本节让冲突罕见。

1. 绑定 browser research plan 或 collection workflow 的页面工作，默认在 Agent 自有工作 tab（`owner='agent'`，绑定 parentTaskId/browserTaskId）上执行；禁止把多页调研的页面动作缺省落在用户当前活动 tab。
2. Agent 创建工作 tab 不得自动切换用户当前活动 tab；工作 tab 在 tab rail 正常可见并带占用标识，呈现层不遮挡、不抢占用户当前页面。
3. 只有两种情况允许驱动用户所在 tab：任务目标就是用户当前页面（绑定资源即当前页），或用户明确要求在当前页协作/观看。单步“操作当前页”类请求不受本节限制。
4. 用户切换到 agent 工作 tab 查看不构成接管（§1.2 信号表）；其中的真实键盘/指针输入只 fence 该 target。
5. 工作 tab 与用户 tab 共享同一 partition/profile（登录态延续）；会话隔离仍由 partition 决定，本节不引入第二种会话身份。
6. 任务收尾（done/cancel/checkpoint）时工作 tab 的 claim 按 §1.1.1 结算；tab 本身保留由用户处置，不自动关闭。

## 2. 分阶段实施

## S0：冻结基线和先写失败 gate

### 改动

1. 把 2026-07-21 两次手测和原始 18 组任务固化为脱敏 fixture manifest，保留 request digest、结构目标、输出约束和验收字段。
2. 每次基线先记录运行二进制的 commit/build id、源码 dirty digest、app version、userData/DB、profile policy 和日志文件信息；无法关联真实运行 binary 时，该轮只能作诊断样本，不能作发布证据。
3. 新增定向失败测试：
   - old run 在 tab A 收到 tab-switch takeover 并 release 后，fresh run 的 tab B 不能继续命中 sticky surface takeover；
   - 同一 turn 在 tab A 取 claim，target-specific takeover 后对 tab B 重新取 claim；
   - 同一 turn 从 tab A 转 tab B 不得复用 A 的 target claim；
   - 切换无关 tab 不改 A owner；
   - 等待超过 no-progress window 后回答，不得在 1 秒内 timeout；
   - Browser child 已建 18 项但 0 项完成、首次 claim/动作前注入 Provider failure，仍写 base+delta 并可续跑；
   - timeout/Provider 失败后，typed continue 与唯一自然语言候选都续回同一 Parent/Browser child；多个候选不误选。
   - Agent key/mouse/navigation/tab-switch 回声与真实用户输入交错到达时，只有后者精确 fence 同 target；
   - done/cancel/checkpoint/provider error 后所有非 active claim 的 `held count=0`，fresh run 可立即复用同 tab；
   - deadline 中止的终态断言：现状产出不可续跑 `delivery_failed`（修复后同一注入断言产出可续跑暂停并保留 child 身份）；
   - 目标 tab 指针输入、chrome 发起导航（地址栏/前进后退/刷新）、用户关闭被 claim 的 tab 三类信号：现状分别为无监听、未记录、潜伏到下次写入；失败测试先锁定现状，修复后按 target 级归因/结算重写断言；
   - R8：复现绕过 workflow unit-of-work 写绑定 Browser Parent 投影的路径（`declare_completion_criteria` 的 tool_handler_failure 与 sendScoped 失败样本，见审计 §6.4）；
   - R9：复现 handoff 启动恢复对 `core_closeout_owner_mismatch` 的无限重试，并为“恢复失败 N 次后写终态 receipt 出口”写失败测试；
   - stale-projection 30 分钟收尾与 Main 15 分钟守卫真实击杀路径的直接行为测试（当前均无覆盖）。
4. R6 当前只有 95% 置信度，因此先写独立 proof gate：对同一 run/Parent/Browser child 稳定注入并读回 `research -> short_task` 覆盖、`checkpoint_incomplete` 在 Main/DB/projection/scope/UI 的冲突映射，以及 budget max/used/remaining 被新默认值覆盖的链路；通过带 writer identity 的定向行为测试锁定每条最后唯一写者。
5. 让 R1–R3 与 R6 proof 测试在现状下稳定失败，保存基线输出。R6 任一条无法重现或存在多个不可区分写者时，S4 保持 locked，另立待证切片，不随本计划改产品。
6. 冻结现有 gate 中把“tab switch -> surface takeover”当成正确的断言，在 S1 一次性替换。
7. R7（无终态孤儿 run）与 R10（排他技能组合误选择）为 S0 调查项：产出定性结论追加进审计 §6.4，不阻塞 S1 开工；R7 需一并修复 process-events 日志 07-20 后停摆的观测缺口。

### Gate

- 不改产品代码前，新测试精确重现 R1–R3；R8/R9 失败测试在现状下稳定失败并留基线输出。
- S4 解锁前，R6 三条分裂都必须在同 identity fixture 上可重现、可回读且归因到唯一写者；否则 S4 不开工。
- 证据报告记录现有 gate 哪些是结构检查、哪些是真实行为。

## S1：用 target claim 替换 surface 全局租约

### 主要改动面

- `browser-write-lease.ts`：收缩/替换为 target claim service，删除每 surface 唯一状态。
- migration / `BrowserTargetClaimRepository` / `BrowserControlUnitOfWork`：实现 §1.1.1 的 SQLite 真值、CAS 与跨表事务。
- `agent-browser-turn-lease.ts`：改成按 target key 管理多把 claim，不再使用两个固定 surface slot。
- `browser-tools.ts` / action executor：先绑定 Browser child 与 operation，再按 §1.4 分类；target-bound mutation 才解析 target、取 claim并进入 page action journal。
- `browser-permission-policy.ts`：消费同一 target claim receipt。
- `browser-surface-binding.ts`：surface 仅路由/呈现，不铸造所有权。
- native input/action bridge：贯穿 target-scoped `actionCorrelationId`，明确区分 Agent 回声、用户呈现操作、页面自发事件与真实用户输入。
- supervision snapshot / Renderer types：从每 surface 一条状态改为 target claim 列表和 active target 派生。
- 默认路由（§1.8）：`browser-tools.ts` 的 target 解析在绑定 research plan/collection workflow 时不得缺省 active tab，默认新建/复用本任务的 agent-owned 工作 tab；`tabs_open` 创建的工作 tab `owner='agent'` 并绑定 parentTaskId/browserTaskId，不自动切换用户活动 tab。
- dormant 清理：`ensureAgentTab` / `ScopedBrowserFacade` / `releaseForBackgroundHandoff` / bounds-lock tokens / 未接线 `'navigation'` 信号源，一律删除或改写为 claim 时代等价物；禁止保留未接线第三态，禁止直接复活旧后台路径（07-18 计划已指认其可绕过 ownerRunId/journal/stop 纪律）。

### 实施约束

1. 不保留“新 target claim + 旧 surface lock”双重检查。
2. 单次 DB migration 只把当前可恢复 target fence 转成新 claim；运行时不读旧格式兼容分支。
3. 所有 caller 与测试在同一工单切换，不允许某些工具继续用 surface lock。
4. operation 先绑定 Browser child，再按 §1.4 区分 targetless/read/mutation；任何 claim 拒绝都可从 child control receipt 回读。

### Gate

- A/B 标签页互不污染；同 target 单写者；旧 generation 后置写入为 0。
- Agent 生成的 key/mouse/navigation/tab-switch 回声不改 claim；交错的真实用户输入只 fence 精确 target。
- 关闭/重建 target 返回唯一 stale-target，不循环 `Tab not found`。
- done/cancel/error/checkpoint 收尾的 claim transition 与 Parent/child 终态同事务；非 active run 遗留 `held=0`，同 tab 新 run 无 TTL 等待。
- 同一 run 持有 A/B 后由 A 触发暂停，closeout 必须处理该 run 的全部 held claim；续跑后 A 的 target wake 与 B 的 task-level lazy resume 分开验收，其他 user-owned target 保持锁定。
- `held/suspended/user_owned × physical rematerialize/logical close/boot restart` 状态矩阵全部走真实 tab dormant→materialize/close/restart 行为，不以直接改 row 代替。
- fresh/upgrade/idempotent migration、并发 CAS、boot-local token 重绑、启动恢复和 `PRAGMA quick_check` 全通过。
- 研究型运行全程用户活动 tab 零打扰：URL、滚动、前台呈现不变，无自动 switchTab；用户切到 agent 工作 tab 查看不改 claim，在其中真实输入只 fence 该 target。
- dormant 清理后 `ensureAgentTab` / `ScopedBrowserFacade` / `releaseForBackgroundHandoff` 无生产调用面残留（删除项以编译与 grep 双证）。

## S2：接管—暂停—继续闭环

### 改动

1. `ipc-handler.ts` 的接管信号改为 target-specific；移除“离开 lease tab 就接管 user-view”。
2. Browser child 持久 `controlReceipts` 和 suspension checkpoint。
3. supervision UI 新增真实“继续 Agent”，显示具体被接管 tab/任务，不显示整个 Browser 冻结。
4. 同步共享 IPC schema、Main、Preload、Renderer types/UI；typed wake 产生一次性 receipt 和新 generation，不通过普通文本解决 owner。
5. 页面挑战卡继续使用现有 grounding probe，但不再与 Browser owner 接管混合。
6. 补齐 target 级用户信号源（§1.2 现状缺口）：目标 tab 的真实指针输入监听；chrome 发起的用户导航（地址栏/前进后退/刷新）；用户关闭被 claim 的 tab 立即按 §1.1.1 状态矩阵同事务结算并写 control receipt。

### Gate

- 接管 A 只暂停 A；B 与无关 target 继续可用。
- 无真实页面挑战时 `browser_request_takeover` 仍拒绝，但模型不再用它解释 owner 冲突。
- 重启后 UI 从 DB 还原接管 target 和可继续动作。
- 重复点击、旧 generation、错误 checkpoint 和迟到 Renderer action 全部零写入。
- task-level wake 不批量恢复 claim；target wake 只解精确 user fence；首次访问其他 suspended target 时才 fresh observe + CAS 新 generation。
- A/C 两个 target wake 与 task continue 三方并发时，Parent-level admission CAS 只创建一个 successor；三份 receipt 都绑定它，A/C 各自授权、其他 user-owned target 不解锁，同一 Parent active run 数始终为 1。
- 指针/导航/关 tab 三类信号只 fence/结算精确 target 并写 receipt；命中 agent action correlation 的同类事件零接管。

## S3：修正等待时钟和持久续跑

> **范围定稿（2026-07-22，白已确认）**：本阶段为 S3-min。§1.5 四张持久表移交长任务架构计划 P3、§1.5.1 请求账本移交 P1，随之移交的还有 SQL adversarial 与全边界崩溃注入 Gate；本阶段以进程内实现交付同等可观察行为，重启期语义沿用 contracts §5 冷启动合同与 §1.6。下述改动与 Gate 即为执行版原文。

### 改动（S3-min 执行版）

1. `delivery-deadline.ts` 改为显式 suspend/resume 状态机：交互创建即 `suspend(interactionId)`，结算即 `resume(interactionId)` 并作为一次进展从当刻重置**完整** `progressWindowMs`；废除等待期 1 秒轮询。`noteProgress` 增加 `user_input_resolved` 入口。与 Main no-progress 守卫的 awaiting-input 豁免对齐为同一语义源：delivery clock 是长任务无进展的唯一权威时钟，Main 守卫只作最后兜底。
2. 新增进程内 `InteractionLifecycleRegistry`（**不建表**）：统一包装普通 ask、技能 ask、高危 action confirmation、Browser power confirmation、页面挑战、handoff、人工接管的 pending 状态，绑定 interactionId/runId/agentId/scopeId/type；clock 只消费该 registry 事件，错误 run/agent/scope 的迟到事件零影响。多 blocker 行为语义保留 §1.5 行为面：同一等待轮内最后一个 blocker 结算才 resume，聚合优先级 `terminate > checkpoint > resume_with_result`。
3. 实施 §1.6 终态映射：deadline 中止时存在 durable Browser child/plan/journal 或任一 resumable state（允许 0/18、首次 claim 前失败）→ 经既有 browser suspension 控制器（`agent-sdk-browser-suspension.ts`）产出可续跑终态并保留 clean base + suspension delta；仅在无任何可续跑状态时才允许 `delivery_failed`。
4. 修正 continuation candidate 选择与 run coordinator：typed 任务卡/监督 UI continue 直接携带 task/checkpoint identity 恢复；自然语言“继续”由模型从 TurnFrame 结构化 resumable candidates 语义选择后调用 typed resume，多候选必须反问，零候选按普通新请求；代码不做字符串匹配、不静默选最近任务。
5. 恢复时 taskId / browserTaskId / 初始 requestAnchor 不变，新轮文本作为 steering/wake receipt，runId 新建且 `runOrigin=continuation`；已结算 action/observation 不重放。
6. 应用重启时 pending 交互按现有冷启动合同结算：run 转可续跑暂停（有 checkpoint）或按 startup reconciler 收口；Renderer 旧卡标 expired/reissue；高危 frozen action 保持未授权。不实现 durable waiter 还原（属架构计划 P3）。

### Gate（S3-min 执行版）

- 等待用户超过 2 个 no-progress window 后回答，回答后在完整新窗口内不超时；连续 3 次 ask/resume 不即时 timeout；不消费迟到或错误 interaction 的回答。
- deadline 中止在已有 durable Browser child（含 0/18）时产出可续跑暂停而非 `delivery_failed`；故障后与主动接管后的续跑均保留原 18 项，不变成 4 项新计划。
- 同 run 两个 blocker 交错：第一个结算不 resume，最后一个结算才重建完整窗口；任一 blocker 结算为 terminate/checkpoint 时按硬优先级立即收口并结算其余 pending。
- 同一 page challenge 的 resolved 走 resume，expired/TTL 走 checkpoint；高危确认 reject 把 denied 结果返回模型，不留 active+suspended 空壳。
- 同 scope 两个可续跑任务时，裸“继续”只产生反问，零任务被误恢复；typed continue 与唯一自然语言候选都续回同一 Parent/Browser child。
- 应用在普通 ask、skill ask、高危 confirmation pending 时分别重启：恢复后无 orphan pending、无自动授权，run 为可续跑暂停或按合同收口，旧卡不可再提交。
- 同一 run 先取得 A/B，再在 A 接管或 fault：closeout 后 A=user_owned、B=suspended、held=0；target wake A 后续跑 A，首次访问 B 时 lazy resume B（依赖 S1/S2 机器，此处验证 S3 接线）。
- 移交项（架构计划 P1/P3 落地前不作为本阶段验收）：SQL adversarial、全边界崩溃注入、outcome outbox 恰好一次、request prepared/sent/delta 账本、durable waiter 还原。

## S4（只在 R6 proof gate 达到 100% 后）：统一进度、预算与终态投影

### 改动

S0 未同时锁定 R6 的稳定触发、唯一最后写者和可观察后果时，本节不是实施授权，必须移入独立待证计划。

1. 找出 `research -> short_task` 的最后写者，从 Parent bind 开始冻结 task type；子域只能继承，不能降级。
2. 从同一 budget runtime 派生 run_meta/projection/checkpoint 数字；禁止投影使用新默认值覆盖实际使用量。
3. 删除 scope run 对 `checkpoint_*` 的 done 假映射；Renderer 任务卡只从持久投影派生。
4. 增加终态交叉表全枚举测试，任何两层状态冲突使 gate 失败。

### Gate

- 任意时刻从 DB 读回的 Parent/browser child/run_meta 可以确定性派生唯一 UI 状态。
- `checkpoint_incomplete` 零“已完成”；`cancelled_user` 零成功交付；IPC success 不修改任务终态。

## S5：真实 Electron 验收与切换

### 验收 harness

新建唯一 `verify:browser-live-grounded` 入口，必须在一次命令内：

1. 先生成 source build manifest：HEAD、分支、应用版本，以及所有实际进包源输入（已跟踪 + 未跟踪）的排序 `path + SHA-256` 和总 digest；明确排除 build output、userData、DB 和 proof report，并把 manifest 嵌入本次 app.asar。
2. 由本次命令构建并启动隔离 Ready Electron；启动前生成随机 proof nonce，不接受旧报告。
3. runtime handshake 必须回传 proof nonce、PID、exec path/SHA、asar path/SHA、嵌入 source manifest digest、bootIncarnationId、userData path、DB path 和 app version；任一与 harness 重算不一致就立即失败。
4. 驱动 Renderer 和真 BrowserView，用受控 fixture 发送键盘、指针、tab switch、takeover、resume 和 restart。restart 必须证明旧 PID 已退出，新 PID/boot id 已变，不能在同进程里伪装重启。
5. 读取 handshake 指向的同一隔离 SQLite，并将 DB/run/task/browserTask ids 与日志、Renderer 回执及报告交叉核对。
6. 自动生成只属于本 proof nonce 的 JSON 报告，随后在同一命令中校验完整性和必须断言。
7. validator 重算 source manifest、exe/asar/hash/path，拒绝预存 report、source drift、artifact drift、userData/DB drift、proof nonce 或 runId 不匹配。
8. 报告另外冻结 provider/model、脱敏 endpoint identity、capability snapshot、tool schema digest、原始 18-item fixture manifest digest 和 profile policy digest，不记密钥、cookie 或用户正文。
9. validator 必须对原始 18 个 required work item 逐一证明 evidence coverage 完整；每个 evidence ref 能通过 durable control receipt 的 previous/next claimId+generation、checkpoint、wake 和 idempotency identity，回链同一 browserTaskId、physical target token/boot/generation、真 BrowserView observation/read receipt 和 resource digest，不能靠日志猜代次。失败结果、URL、标题或工具说明不能冒充用户要求的正文证据；最终 verifier acceptance digest 必须精确对齐这组 sealed evidence 和 artifact readback。产物还必须回链本 proof nonce/run 的写入 receipt、输出路径、写后 hash 和独立回读 receipt/hash，旧文件不得复用。改走 web/research 工具或模型自生成内容即使文件存在也不算 Browser gate 通过。

不允许“校验一个事先不存在的 JSON”冒充 live gate。

### 验收顺序

1. 纯函数/行为单测。
2. Browser surface/orchestration/reliability/native 专项 gate。
3. controlled Electron：12 个结构变体、4 种语言，每变体 3 次。
   - A7 不用 fake timer 或缩短配置替代；report 必须记录 `configuredWindowMs=120000`、interaction created/suspended/resolved 时刻、pending 实时超过 120000 ms，以及 resolve 后完整新窗口。suspend 起点必须是 interaction creation，不能等 UI 显示或下一次 poll。
4. 真实公共网站：原始小红书任务 + 2 个不同形态站点。该门只使用用户明确授权的专用 acceptance userData/profile，不直接使用日常 Ready profile，不复制 cookie/token，不把 profile 内容写进报告。实施 Main 与 worker 共用的显式 isolated DB override，使 Chromium 登录 session 可持续，但每个验收 run 的 `ready.db`/日志/输出独立；测试必须证明 Main/worker 都只打开 override DB，日常 DB 读写为 0。
5. 原始小红书任务连续 3 次，分别覆盖无干预、接管恢复、重启恢复。
6. 全库验收和 build。

### 切换条件

一次性移除旧 surface ownership caller 后才能切换。若任一真实场景失败：

- 保留新合同和证据，修根因后重跑；
- 不重新打开旧 surface lock 兼容分支；
- 不在下一阶段用子 Agent 掩盖失败。

controlled/CI gate 与 real-site release gate 必须分开：前者使用全新隔离 userData + localhost fixture，可自动重放；后者只证明真实登录站点行为，不进入 CI，也不能靠复制用户 profile 伪造隔离。两门都通过才算 A1–A12 完成。

## 后续独立切片 C1：上下文性能（不阻塞本计划）

原始任务首次通过 S5 后，才可另立实施切片优化长研究输入。canonical clean checkpoint 继续保存完整 final input，仍是唯一持久输入真值；所谓“当前 work item + 摘要”只能由它确定性派生为本次 node working view，不能覆盖 checkpoint。

该切片必须单独证明：18 项任务输入不随历史页面全文线性膨胀；compaction 前后 coverage/journal/final result 一致；恢复时 working view digest 可从 canonical checkpoint 重算。任何失败都回滚该性能切片，不回滚已经通过的 target claim 合同。

## 3. 验收矩阵

| Gate | 场景 | 必须观察到 |
| --- | --- | --- |
| A1 | 原始 18 关键词，无人工干预 | 18/18 required fields 均由同 browser child 的真 BrowserView read/observation 证据覆盖，可回链 target generation/resource digest；verifier digest 对齐 sealed evidence；账号分析；文件的本 run 写入+独立回读 receipt/hash 一致；唯一终稿；全链 done；收尾 held=0，fresh run 立即复用同 tab；运行全程用户活动 tab 的 URL/滚动/前台呈现零变化（§1.8 默认路由生效） |
| A2 | Agent 在 A 产生 key/mouse/navigation 回声，用户切换/输入无关 B | A 继续；Agent 回声不接管；B 不夺 A owner；零 surface takeover |
| A3 | Agent 回声与用户在 A 的真实输入交错 | correlation 精确区分；只 fence A；旧 owner 后置写入 0；其他 target 不受影响 |
| A4 | 无页面阻塞却请求 page takeover | 零 claim/任务变化；明确 `human_takeover_not_grounded` |
| A5 | `held/suspended/user_owned` 三态下关闭或同 boot 替换 target | 按 §1.1.1 状态矩阵唯一结算；一次 stale/closed receipt；零错 tab 写入；零循环；旧 physical identity 永不复活 |
| A6 | 同一 run 先持有 A/B，再于 0/18 首次动作前、动作后、A 接管时注入 502/522 或 Provider 失败 | closeout 覆盖旧 run 全部 held；同一 Parent/child/base+delta 恢复；A target wake 与 B task lazy resume 分离；已结算动作不重放；其他 user_owned target 不被批量解锁 |
| A7 | 真实等待用户 >120000 ms；普通 ask/skill ask/confirmation pending 时重启 | 报告记录 configuredWindowMs=120000 与 interaction created/suspended/resolved 时刻、pending 实际超过 120000 ms、resolve 后在完整新窗口内继续执行；重启后无 orphan pending、无自动授权、run 可续跑；同 Parent 同时 active run 最大 1。（outcome/Provider 各边界崩溃与 stop 竞态矩阵随 §1.5/§1.5.1 移交架构计划 P3/P1） |
| A8 | target/task typed 继续、A/C target wake + task continue 三方并发；自然语言一个/多个候选 | Parent admission CAS 只建一个 successor；target wake 只解精确 user fence；task wake 只授权同 ancestry 的 suspended lazy resume；唯一候选由模型选择；多个候选反问；原 request anchor/18 项/child 不变 |
| A9 | `checkpoint_incomplete` | Main/DB/projection/scope/UI 全部为暂停可继续，claim=suspended、held=0，零完成文案 |
| A10 | 长任务预算 | taskType=research；max/used/remaining 跨层一致 |
| A11 | 分别在 0/18、mid-action effect unknown、已有 observations 时应用重启 | logical user fence 保留；旧 physical token 失效；保存对应 base+delta/evidence watermark；materialize+fresh observe/unknown-effect 对账后以新 generation 恢复同 Parent/child/checkpoint；迟到旧 run 零写入 |
| A12 | 证据报告与迁移 | source manifest/HEAD/dirty content digest、proof nonce、PID/exec/asar/boot/userData/DB/IDs/log/SQL/artifact hash、provider/model/脱敏 endpoint/capability/tool schema/18-item manifest/profile policy digest、fresh/upgrade/idempotent/quick_check 齐全，可重放 |

## 4. 建议验证命令

实施时以 `package.json` 当时真实脚本为准，最少运行：

```bash
npm run verify:browser-surface
npm run verify:browser-target-claims
npm run verify:browser-orchestration
npm run verify:browser-reliability
npm run verify:browser-lane
npm run verify:agent-continuation-clock
npm run verify:stability
npm run verify:native
npm run typecheck
npm run test
npm run build
npm run verify:browser-live-grounded
```

如新 `verify:browser-live-grounded` 还没有在 `package.json` 中绑定到“启动 -> 执行 -> 生报告 -> 校验”全链，S5 不得通过。

`verify:browser-target-claims` 是本计划需新增的专项入口，至少绑定 claim migration、CAS/TTL/startup、operation 分类、跨进程 continue 和 control receipt 行为测试。涉及 SQLite 的用例必须由 Electron runtime 执行，并由 `verify:native` 覆盖，不能用 host ABI skip 代替。

`verify:agent-continuation-clock` 是 S3-min 必须新增并接入 package 的真实行为入口：绑定显式时钟状态机（>120s 等待后完整新窗口）、§1.6 终态映射（deadline 中止产出可续跑暂停）、typed resume/多候选反问与 pending 重启结算。`verify:agent-interaction-lifecycle` 与 `verify:provider-request-ledger` 随 §1.5/§1.5.1 移交，在长任务架构计划 P3/P1 建立；它们缺席不阻塞 A7 的 L0 行为面，但对应架构阶段未落地前不得宣称崩溃恰好一次语义。脚本缺失、只做 source grep 或 native 用例 skip 时，A7 不得通过。

切换前还必须：

1. `git diff --check` 通过，确认没有把无关 dirty-tree 文件纳入本阶段。
2. 代码文件只要净增行数就按 AGENTS 的 1000 行规则检查并更新 `docs/code-health/large-file-health-log.md`。
3. A1–A12 全通过后再同步 `docs/architecture/current-runtime-contracts.md` 的当前权威合同；未通过时只保留本 proposed plan，不提前宣称 runtime 已切换。
4. 报告记录失败 gate，不用 skip、缺失 live report 或 IPC `success=true` 代替真实通过。

## 5. 独立复审门

S0–S5 完成后必须启动一个没有参与实施的具名 reviewer，按以下顺序反向审查：

1. 从最终完成声明回追每个 DB/receipt/artifact 证据。
2. 搜索所有仍在使用旧 surface ownership 的 production caller。
3. 注入旧 run、迟到工具结果、重启和接管竞态。
4. 验证原始 18 组任务的产物内容，不只看终态字段。
5. 审查是否为通过特定站点而加了站点名、文案或固定 URL 分支。

reviewer 无输出不算通过；发现问题必须修复并重跑受影响 gate。
