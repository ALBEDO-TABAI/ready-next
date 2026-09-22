---
title: Phase I 微信 IM 远程完全体 — 现状调研
date: 2026-07-05
status: survey
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Phase I：微信 IM 远程完全体 — 现状调研（带 file:line 证据）

> 目标锚：让远程 IM 通道从"能收发"升级到"能力对等"——本地会话能做的（浏览器工作流、文档、
> 技能、任务续跑、附件资源、确认闸门），微信线程里同样能做、能看到进度、能确认。
> 分支：feature/vertical-tabs。本文只读调研，不改源文件。

## 关键前置发现（贯穿五切面）：`remote_channel` profile 是死配置

调研第一步就撞到一个改变全部叙事的事实：**能力 profile `remote_channel` 在整个 `src/` 里
从未被赋值**，微信/远程 run 实际全部以 `local_chat` 执行。

- 类型定义 4 个 profile：`local_chat | remote_channel | scheduled_run | embedded_workflow`
  （`src/shared/ai-capability-groups.ts:21-26`）。
- 全库 grep `capabilityProfile` 非测试命中里，**只有 `local_chat` 的赋值**，`remote_channel`
  只作为**比较值**出现一次：
  - `execution-intent-resolver.ts:347` → `profile: params.capabilityProfile || 'local_chat'`
  - `agent-sdk-utils.ts:1006` → `capabilityProfile: 'local_chat'`（硬编码）
  - `runtime.ts:964` → `profile: 'local_chat'`（能力快照）
  - `execution-intent-resolver.ts:256` → `params.capabilityProfile === 'remote_channel'` 仅用于
    "远程时强制放行飞书工具组"，是唯一消费点。
- 远程入站 run 的派发口 `RunCoordinator.runInboundChannel`（`run-coordinator.ts:85-90`）直接
  转 `executeRun`，**不传任何 profile**；`RequestEnvelope` 结构里也**没有 profile 字段**
  （`request-envelope.ts:67-102`）。

**推论**：`CAPABILITY_GROUPS[].defaultProfiles` 里对 `remote_channel` 的收窄设计
（`ai-capability-groups.ts:43-242`）**从未生效**。远程 run 拿到的是与本地一致的全量
model-visible 工具面，只受"环境可用性"（`browserHostAvailable` / `feishuConnected`，
`capability-resolver.ts:120-142`）和 intent 收窄影响。因此本切面的真实矛盾不是"远程被闸窄"，
而是"远程拿到了本地的全套能力、却没有本地那套 UI 交互面来兑现其中的交互型能力"。

> 归类：**设计缺失（配置存在但未接线）**。`remote_channel` 相当于预留的收窄开关，
> 既没接，也就没有一处"有意为远程调整能力面"的代码——远程完全体所需的"能力适配层"目前为零。

---

## 切面 1：远程侧能力面暴露差距盘点

### 现状（证据）
能力裁决链：`buildExecutionToolState`（`execution-intent-resolver.ts:300-354`）→
`resolveCapabilityResolution`（`capability-resolver.ts:61-227`）→
`run-capability-controller.resolveRunCapabilities`（`run-capability-controller.ts:215-433`）。

profile 是否放行某组的核心判定（`capability-resolver.ts:172`）：
`const enabledByProfile = mode === 'on' || group.defaultProfiles.includes(params.profile)`

按 `ai-capability-groups.ts` 的 `defaultProfiles` 声明，**若 `remote_channel` 曾生效**，
逐组对比 `local_chat` 的差集应为（仅列 local 有、remote 声明无的组）：

| 能力组 | local_chat | remote_channel（声明） | 证据行 | 若生效属于 |
|---|---|---|---|---|
| browser_content_tasks（结构化提取/滚动采集/下载/研究类） | ✓ | ✗ | `:56-65` | 有意闸（保留 browser_interaction 但砍内容任务） |
| rss | ✓ | ✗ | `:88-98` | 有意闸 |
| general_research（web_search/web_fetch/呈现） | ✓ | ✗ | `:165-175` | 有意闸（远程看不了搜索）—存疑 |
| map_planning | ✓ | ✗ | `:176-186` | 有意闸 |
| pet（桌面宠物便利贴） | ✓ | ✗ | `:143-153` | 有意设计（桌面专属） |
| mcp | ✓ | ✗ | `:209-219` | 有意闸 |
| agent_interaction（反问用户） | ✓ | ✗ | `:220-230`，注释"仅 local_chat" | 有意闸 |
| skill_install（安装技能） | ✓ | ✗ | `:231-241`，注释"仅 local_chat" | 有意闸 |

**但以上全部不成立**，因为 profile 从未被设为 `remote_channel`（见前置发现）。叠加两处
`defaultMode: 'on'` 的特例——`agent_interaction`（`:226`）与 `skill_install`（`:236`）——
在 `capability-resolver.ts:172` 的 `mode === 'on'` 短路下，**即使 profile 真是 remote_channel
也仍会放行**。也就是说注释宣称的"仅 local_chat"与解析器实际行为**自相矛盾**，而当前又因
profile=local_chat 使这对矛盾被掩盖。

### 差距
- 远程 run 的 model-visible 工具面 = 本地全量（除环境不可用组）。**没有任何"为 IM 场景收窄/
  适配"的实际逻辑**。
- 交互型能力组（`agent_interaction` / `skill_install`）在远程被暴露给模型，但其兑现依赖本地卡片
  UI（见切面 2），构成"暴露了、却兑现不了"的悬空能力。

### 归类
- `remote_channel` 收窄：**设计缺失（没接）**。
- `agent_interaction`/`skill_install` 的 `defaultMode:'on'` 与"仅 local_chat"注释冲突：
  **实现与合同不一致（潜在 bug）**，待核是否别处另有二次过滤。

### 修复面预估
- 涉及模块：`ai-capability-groups.ts`（profile 语义）、`execution-intent-resolver.ts` /
  `agent-sdk-utils.ts`（profile 注入点）、`run-coordinator.ts`（入站 run 携带 profile）、
  `runtime.ts` 入站派发。
- 规模：中。先接线"入站 channel run → capabilityProfile='remote_channel'"是 1 处贯穿改动
  （~10 行 + 全链 profile 透传），随后需重定义 remote_channel 到底该收窄哪些组（产品决策）。
  建议与切面 2 合并，否则一旦接上 remote_channel 反而把飞书/交互能力误伤。

---

## 切面 2：远程确认链路（frozen-call / ask_user_questions / browser takeover）

### 现状（证据）
- **行动确认闸门**：`resolveConfirmationGate`（`action-confirmation-policy.ts:300-344`）按
  (toolName, args) 静态表判 M1/M2/M3/M4。M2/M3 → `action:'confirm'`（`:229-243`，M3 阶段一降级同
  M2）。命中的工具含：`calendar_delete_event`/`feishu_calendar_delete_event`（`:104`）、
  `file_rename`/`file_move` overwrite（`:111-113`）、`file_organize_apply`（`:121`）、
  `feishu_message_send`/`reply`（敏感或外发，`:128`/`:144`）、`feishu_file_upload`（`:137`）、
  以及浏览器支付/改密/验证码破坏性锚点（`:175-194`）。
- **确认卡实现**：`runFrozenCallConfirmation`（`frozen-call-confirmation.ts:96-217`）把冻结调用
  包成一张 `ask_user_questions` 单选卡，直接复用 `executeAskUserQuestions`（`:146`）。
- **卡的出口**：`getAskUserQuestionsCardEmitter()`（`ask-user-questions-bridge.ts:34`），生产环境
  在 `ipc-handler.ts:732-735` 注册为
  `mainWindow.webContents.send('agent:askUserQuestions:push', event)`——**只推本地渲染进程**。
  答案回收也只经本地 `agent:askUserQuestions:*` IPC（`ipc-handler.ts:791`）。
- **入站 run 用的是同一个全局 emitter**：tool-executor 走 `getAskUserQuestionsCardEmitter()`
  （`tool-executor.ts:514`/`890`/`908`），入站 channel run 并未替换成 channel-aware emitter。
- **browser_ask_user_takeover / waiting_human**：`TaskEventBridge` 发布 `waiting_human`
  （`task-event-bridge.ts:19`），恢复走 `resumeWaitingHumanBrowserTaskFromBridge`（`:122-134`），
  需 `confirmed:true` 由本地触发；无 channel 触发面。
- **channel 侧无确认解析**：`runtime.ts` 内无任何把 channel/inbound 文本回复解析成
  确认答案的路径；`parseInboundChannelCommand`（`:3105-3116`）只认以 `/` 开头的 slash 命令。

### 差距
远程 run 一旦命中 M2/M3 或模型主动 `ask_user_questions`：卡片 emit 到**本地 UI**、并持久化进
`chat_messages`，run 在 tool 内 `await` 答案；微信用户**看不到卡、也无法回答**。frozen-call 会在
TTL（`DEFAULT_FROZEN_CALL_TTL_MS`，10 分钟，`frozen-call-confirmation.ts:107`）后作废/拒绝，
普通 ask 卡默认更长 TTL——期间 run 挂起、单挂起卡槽被占。**微信里没有任何等价交互（无文本
回复解析、无按钮）**。

### 归类
**没接 + 设计缺失**：卡机制本身完备（store/emitter/persistor/renderer 齐全），但"远程出口 +
文本答案回收"从未实现。属于 Phase I 完全体的**硬阻断**。

### 修复面预估
- 涉及模块：`ask-user-questions-bridge.ts`（emitter 需支持 channel 目标）、`frozen-call-confirmation.ts`
  / `ask-user-questions.ts`（答案来源需接受文本解析）、`runtime.ts` 入站路径（把 pending 卡渲染成
  微信文本 + 把用户回复映射回 `submitAskUserQuestionsAnswersCore`）、`action-confirmation-policy`
  无需改。
- 规模：中大。MVP =（a）channel run 时把 ask/confirm 卡序列化成微信可读文本（动作+对象+风险+选项）；
  （b）在 `handleInboundChannel` 前置一层"该 scope 是否有 pending 卡"，命中则把这条微信消息当作
  答案解析（数字/关键词→选项）而非新 run。风险点：单选/多问卡的文本编解码、超时与
  scope 隔离一致性。**需真机（真微信）验证往返**。

---

## 切面 3：长任务进度投影与续跑

### 现状（证据）
- **TaskEventBridge**（`task-event-bridge.ts:64-109`）只有两类消费者：`projectionSinks`（本地任务
  投影 UI）与 `agentNotifiers`；构造时只注册了
  `enqueueBackgroundTaskTerminalReminderFromBridge`（`:109`）。**没有 channel/远程 sink**。
  且只发布浏览器能力任务的**终态**（completed/failed/paused/waiting_human，`:16-24`），
  running/queued 不发。
- **pending_task_events 表**：迁移建表（`migrations.ts`）；解析
  `parsePendingTaskEventPayload`（`runtime.ts:295-305`），取 scopeId
  `readScopeIdFromPendingEvent`（`:313-320`）。
- **自动播报续跑**：`startNarrationContinuationFromPending`（`runtime.ts:1208-1308`）——从 pending
  事件取 scope，`this.orchestrator.send(scope.agent, buildPendingTaskNarrationPrompt(event), scope.id, …)`
  （`:1265-1279`）产出一条 assistant 消息 + `emitScopeRunEvent`。**全程无 `sendChannelReply`
  调用**（`sendChannelReply` 仅在入站 handler 的 2 处出现：`runtime.ts:3031`、`3064`）。
- **入站 run 不带续跑意图**：入站派发 `runInboundChannel(...)`（`runtime.ts:2996-3004`）只传
  `{scope, message, requestId, coordinators}`，**不传 `continuationIntent`**；而
  `executeRun` 是支持 `request.continuationIntent` 的（`run-coordinator.ts:190`）。
- **"继续"命不中续跑**：微信自然语言"继续"不是 slash 命令（`parseInboundChannelCommand`
  `:3105`），落入普通 run。`continuationIntent` 的构建/`resumeRun`（`runtime.ts:2188-2280`）、
  自动续跑意图（`:1865-1911`）都挂在**本地 send/resume IPC** 路径，入站 channel 路径不经过。
- **scope 隔离确凿**：`getScopedRemoteThreadKey` + `remote_channel_session_v1:${channelId}:${agent}:${threadHash}`
  （`runtime.ts:3339`/`3382`），迁移 `013_expand_chat_scopes_for_remote_channels`
  （`migrations.ts:516`）。所以续跑"该命中哪个 scope"是清楚的，缺的是命中逻辑本身。

### 差距
1. **进度不投影到微信**：mid-run 进度、checkpoint、waiting_human 都不会推到微信线程；微信只在
   入站 run 的 `onSuccess/onFailure` 收到**最终一条**回复（`runtime.ts:3038-3069`）。
2. **后台任务播报不回投**：即使 scope 是微信 scope，自动播报也只落本地会话/投影，不回投微信。
3. **续跑命不中**：微信"继续"只当新 run；结构化续跑（resumable actions、checkpoint 恢复）不触发。
   scope 历史仍在（模型能看到上下文），但"续跑机器"未启动。

### 归类
**没接**（TaskEventBridge 无 channel sink、narration 无 channel 回投、入站不带 continuationIntent）。
底层能力（pending_task_events、resumeRun、scope key）都在，缺"接到 channel 出口"这一段。

### 修复面预估
- 涉及模块：`task-event-bridge.ts`（加 channel sink 或复用 agentNotifier 派发到 channel）、
  `runtime.ts`（narration 完成后按 scope.sourceKind==='channel' 触发 `sendChannelReply`；入站
  path 前置续跑意图识别，复用 `normalizeContinuationIntent`/`resumeRun`）、`run-coordinator.ts`
  已就绪。
- 规模：中。进度投影可做"里程碑级"（planning/checkpoint/done/waiting）而非逐 token，成本可控。
  续跑命中依赖切面 2 的"scope 有无 pending 交互"判定，二者共享同一"channel 反向出口"基建。
  多数可**无人值守**用桩事件验证，末端回投**需真机**确认微信收到。

---

## 切面 4：出站可靠性（ret=-3/-2 + sidecar 心跳与在线语义）

### 现状（证据）
- **业务错误检测（含 ret=-3）**：`_raise_for_business_error`（`wechat_openclaw_adapter.py:178-187`）
  遍历 `("ret","errcode","error_code","code")`，非成功码即
  `raise RuntimeError(f"微信接口返回错误 {key}={value} …")`。**ret=-3/-2 无任何专门分支**——
  不区分"会话失效"vs 普通业务错误，无重登/重配对/降级播报触发。
- **出站发送**：`send`（`:385-400`）→ `_send_message_items`（`:479`）/ `_send_attachment`（`:501`）。
  发送失败以 `tuple[bool, str]` 返回，最终由 TS `sendChannelReply` 得到 `delivery.success=false`。
- **失败在 TS 侧的处理**：入站 `onSuccess` 里若 `!delivery.success`，标记事件 failed 并向**本地会话**
  追加 `处理未完全完成：${reason}` 系统消息（`runtime.ts:3070-3083`）。**无重试、无 re-login、
  无"改走另一条出站"降级**；且这条通知本身也进不了微信（微信出站已失败）。
- **sidecar 心跳**：`SidecarManager.startHeartbeatLoop`（`sidecar-manager.ts:344-347`）定时打
  `/heartbeat`；TS 把返回的 adapters 映射为 `healthy: Boolean(item.healthy)`
  （`runtime.ts:2554-2564`），errored/stopped 由 `reviveErroredAdapters` 定时重启
  （`:2598-2618`）。
- **"已连接≠在线"根因**：`base.py` 的 `mark_running()` 在 adapter 启动即置
  `status="running"; healthy=True`（`:43-46`），`beat()` 只要 status 是 running 就
  `healthy=True`（`:74-78`）。wechat adapter 连上 openclaw 后即 `self.mark_running()`
  （`wechat_openclaw_adapter.py:372`）。**微信登录/会话有效性单独存在 `login_sessions`
  （`get_login_status` `:642` 等），完全不反哺 adapter.healthy**。ret=-3 出站失败也不翻转
  healthy。故 `heartbeat.adapters[].healthy=true` 只代表"进程连上 openclaw"，**不代表微信在线可发**。
- 上层 `isChannelTypeAvailable`（`runtime.ts:980-993`）、能力快照 `feishuConnected` 等都建立在这个
  被高估的 healthy 之上。

### 差距
- ret=-3（出站会话失效）与普通错误同等对待，**无自愈/降级/用户可见提示**。
- 在线语义假阳性：微信掉线/未登录时系统仍显示"已连接/健康"，发送持续失败但状态面板不反映。

### 归类
**设计缺失**：缺"微信真实在线态"这一信号维度，以及 ret=-3 的专门降级路径。检测点存在
（`_raise_for_business_error`）但语义太粗。

### 修复面预估
- 涉及模块：`wechat_openclaw_adapter.py`（ret=-3 专门分支 → 标记 session 失效 / 触发重配对提示 /
  上报一个独立 online=false）、`base.py`（AdapterState 增"logged_in/online"维度）、
  `sidecar-manager.ts` + `runtime.ts:2554`（心跳映射透出 online）、状态 UI。
- 规模：中。核心是把"连接态"与"登录/会话态"拆成两个字段贯穿到 UI 与能力快照。
  ret=-3 复现**需真机**（触发微信会话失效）；心跳/字段透出可**无人值守**测。

---

## 切面 5：附件双向（入站 IM→资源层；产物→IM 回投）

### 入站现状（IM 图片/文件 → 资源层）
- sidecar 侧下载：`_extract_attachments`（`wechat_openclaw_adapter.py:270-298`）从 item_list 解出
  image/video/file，CDN 下载 URL 构建 `_build_cdn_download_url`（`:149-156`），落盘到
  `channel-attachments/<channelId>/`（`:342`）。TS 侧仅做缓存管理
  `getRemoteAttachmentCacheStats`/`clearRemoteAttachmentCache`（`runtime.ts:1707-1779`）。
- 入站进 run：`buildInboundChannelPayload`（`runtime.ts:4042-4073`）：
  - **媒体（图/视频）**：`tryInlineChannelAttachment`（`:4075-4121`）读盘 base64 内联为
    multimodal `image`/`video` block（视频 ≤40MB `:4089`；图片不限大小）。
  - **非媒体文件（pdf/docx/xlsx/…）**：不内联，只拼一行文本摘要
    `formatChannelAttachmentSummary` → `- 文件: <name>`（`:4026-4040`）。

### 入站差距
非媒体文件**只给文件名、不给正文也不给路径**——虽然文件已在本地盘（有 `attachment.path`），
但**不作为 `RequestEnvelope.resource` 暴露**（`request-envelope.ts:44-65` 的 resource 全部来自文
本标记块，无 channel-attachment 来源）。agent 无法对微信发来的文档执行 file 工具/读取内容。
媒体则受模型 vision 能力再过滤（`message-capability-filter.ts:213-236` 当前轮硬拒、
`:123-176` 历史轮剥离）。→ 前置锚"飞书/远程附件先进资源层"在**微信非媒体入站尚未落地**。

### 出站现状（任务产物 → IM 回投）
- `collectOutboundChannelAttachments`（`runtime.ts:2753-2813`）三重闸：
  1. `channelSupportsOutboundAttachments` **仅 `wechat-openclaw`**（`:2815-2818`）；
  2. `hasRemoteFileDeliveryIntent(inboundText)`（`:2759`，规则见 `remote-im-file-intent.ts:82-88`）
     ——**靠入站文本正则判定投递意图**，未命中则一个文件都不收集；
  3. 需 proofRefs 里存在 `present_file` 或 `document_save_tab` 的 `tool_result` 证据
     （`:2771-2777`），再收 artifact 路径（绝对路径、存在、≤100MB、非 run_state.json，最多 5 个
     `:2789-2812`）。
- 发送：TS `sidecar.sendChannel({attachments})` → python `send`→`_send_attachment`
  （`:501-544`）→ `_upload_attachment_to_cdn`（`:546-591`）上传后按 image/video/file 组装 item。
- send-im 技能工具侧另有一套本地意图闸 `hasLocalSendImFileIntent`
  （`remote-im-file-intent.ts:106-134`）与否定闸 `hasNegatedLocalSendImFileIntent`（`:90-93`）。

### 出站差距
- 回投强绑定"入站文本命中投递意图正则"。产物是任务**中途/自动**产生、或用户用非常规措辞要文件时，
  正则漏判 → 文件静默不回投（前置锚"send-im 两层失败面"之一：**曝光/意图闸**）。
- 仅 `wechat-openclaw` 支持出站附件；其他 channel 无。
- 与切面 4 叠加：即使收集到附件，`_send_attachment` 命中 ret=-3 同样只抛通用错误、无自愈。

### 归类
- 入站非媒体不进资源层：**没接（资源层入口缺失）**。
- 出站三重闸：**有意闸**（防误发），但意图判定过窄导致**可用性缺失**。

### 修复面预估
- 涉及模块：`request-envelope.ts` + 入站 path（新增 channel-attachment → resource，带 path/canRead）、
  `runtime.ts:4042` 非媒体分支、`runtime.ts:2753` 出站闸（放宽为"任务显式产物 + 轻确认"而非纯正则）、
  `remote-im-file-intent.ts` 规则。
- 规模：中。入站资源化是较独立的一段（可无人值守测：构造带 docx 的入站 payload 验 resource 生成）。
  出站放宽建议与切面 2 的确认能力联动（"要不要把这个文件发你微信？"用远程确认卡兜误发风险）。
  末端收发**需真机**。

---

## 优先级排序（用户价值 × 实施风险）

| 序 | 切面 | 用户价值 | 实施风险 | 无人值守可测 | 需真机 | 一句话理由 |
|---|---|---|---|---|---|---|
| **P0** | 2 远程确认链路 | 极高 | 中 | 部分（卡文本编解码/答案解析可桩测） | 是（往返） | 硬阻断：碰 M2/M3 或反问即静默挂死；是 3/5 回投的公共底座 |
| **P1** | 3 进度投影+续跑 | 高 | 中 | 高（桩事件驱动） | 末端回投需 | "看得到进度、能续跑"是完全体体感核心；复用 P0 的 channel 反向出口 |
| **P2** | 4 出站可靠性/在线语义 | 高 | 中 | 心跳字段可测 | ret=-3 复现需 | "已连接≠在线"造成误判与静默失败，信任基础 |
| **P3** | 5 附件双向 | 中高 | 中 | 入站资源化可测 | 收发需 | 入站非媒体资源化 + 出站放宽；出站放宽建议等 P0 落地做确认兜底 |
| **P4** | 1 能力面接线 | 中 | 中 | 高 | 否 | 需先定 remote_channel 收窄产品语义；贸然接线会误伤飞书/交互组，宜殿后 |

### 无人值守 vs 需真机
- **可基本无人值守推进**：切面 3 的进度投影桩测、切面 4 的在线字段透出、切面 5 入站资源化、
  切面 1 的 profile 接线与单测。
- **必须真机（真微信）**：切面 2 的确认往返、切面 3 末端回投、切面 4 的 ret=-3 会话失效复现、
  切面 5 的图片/文件实际收发。

## 待核清单
1. `agent_interaction`/`skill_install` 的 `defaultMode:'on'` 与注释"仅 local_chat"矛盾，是否别处
   （消息级/工具级 filter）另有二次 profile 过滤——本次未找到，但未穷尽 tool-gateway/registry 全路径。
2. 自动播报 `orchestrator.send` 的下游是否存在未追到的 channel 回投分支——已确认
   `sendChannelReply` 仅 2 处调用点（均在入站 handler），倾向"无"，但未逐分支展开 orchestrator.send。
3. `browser_ask_user_takeover` 在远程 run 中的具体触发与 waiting_human 投影是否有除
   TaskEventBridge 之外的旁路——本次按"无 channel 面"结论，未逐工具核 browser-act-tools 全量。
