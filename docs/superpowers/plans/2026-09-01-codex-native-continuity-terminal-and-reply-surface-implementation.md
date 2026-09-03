---
title: Codex 原生连续性、终态单线与回复呈现修复实施计划
date: 2026-09-01
status: proposed
review_status: passed
enforce: true
---

# Codex 原生连续性、终态单线与回复呈现修复实施计划

## 0. 计划结论

本轮不应再把问题修成“失败后创建一个空 thread，再想办法给新 thread 塞一段历史”。最佳方案分为三条彼此独立、但各自闭环的改动：

1. **回复呈现**：把连续 numbered items 解析成一个语义化 `<ol start>/<li>`，由浏览器顺序编号；运行中删掉重复的“本轮进行中”标签，但保留现有 live elapsed，单行显示为“本轮用时 00:01”。这两项只改 Renderer，不增加状态或持久化。
2. **普通故障连续性**：Provider、网络或可确认没有历史分叉的失败，关闭本轮产品终态，但继续使用同一个 Codex native thread。失败不再天然等于 `publication_diverged`。
3. **真实历史分叉**：只有未发布的 assistant 尾部、QC 拒绝正文、协议失配或其他已证实的 native/Ready 历史分叉，才退役旧 generation；同一模型可见工具/根指令合同下，后继 generation 用 runtime 原生 `thread/fork(lastAcceptedNativePrefixHead)` 复制最后一个已接受前缀。禁止从 Ready 的 UI 消息、session recall 或自制摘要重建完整模型历史。

任务重试仍是另一条正交合同：它只允许diverged child中未被coverage、零工具/交互/资源依赖的失败task root作为current input一次，不承担会话历史交接；任何副作用、交互或资源依赖都改走ordinary完整重述。

## 1. 完成标准

只有同时满足以下条件，实施任务才能标记完成：

- Agent 连续写出 `1. / 1. / 1.` 时，语义列表显示为 `1 / 2 / 3`；自定义起始值、说明段落、嵌套列表和真正分裂的两个列表均符合 CommonMark/原生列表语义。
- live turn 保留计时，但 duration row 只出现一次“本轮用时 00:01”，不再同时出现“本轮进行中”和第二个“本轮用时”；终态后用时正确冻结。
- 无工具、无未发布尾部的 Provider/transport failure 命中 pinned-runtime failure-seam allowlist，且 native readback确认 identity/status 可续后不换 thread；下一条普通用户消息真实进入同一 thread，并能读取更早已成功上下文。
- 同一 runtime/model-visible tool/root-instruction 合同下发生 publication/history divergence 时，新 generation 不是空白 root，而是 runtime 原生 fork 的 accepted prefix；本次 boundary 之后的 divergent tail、被拒正文和 provisional 内容都不进入 child。boundary 之前的历史项不得靠 Ready 重建或删除。
- reset不fork，close不创建successor；首轮divergence无accepted prefix时只创建`fresh_root_with_tail`，每个exact user half-turn按policy交付/替换/省略，允许交付的恰好一次；不伪造assistant历史，也不把delivery当history committed。
- 自动/手动 compaction 仍完全由 Codex runtime 所有；修复不生成 Ready summary，也不把 compacted history 重放第二次。
- 当前轮资源、技能选择、工具执行权限、行动权限和输出义务均重新冻结；native fork只要求真正由 runtime继承的 `nativeInheritedContractDigest`与 source相等，target cwd与每轮 upstream/权限事实各归自己的正式合同；workspace-root行为只认 allowlist + pinned probe policy receipt，不伪造逐 child readback。旧附件、路径、资源正文或权限不会因 fork自动恢复。
- failure kind、terminal reason和 closeout 时 history/effect observation 来自一份 immutable Main facts；当前 Retry/发送/阻断能力由 facts + 最新 owner receipts 的同一纯投影生成，Renderer、ProductTurnPresentation 和 explicit retry 不再各自猜测。
- fork 请求在响应丢失时零盲重发；启动恢复能唯一对账成功 child，或保持 outcome unknown 并阻断新用户输入被消费。
- 旧 generation 的迟到 terminal、工具回执、interaction card、token usage、QC 或 next action 不能污染新 generation。
- focused tests、native SQLite gate、streaming/stability gate、build、真实 Electron 和同一 DMG 的隔离安装证明全部通过；源码、runtime、包体、安装态证据分开陈述。
- 对抗性复审 outstanding P0/P1/P2 全为 0；每个新增持久字段均有 producer、validator、live consumer、boot consumer、stale rejection 和 archive/cleanup consumer。
- same-inherited-contract fork continuity 必须 PASS；runtime、model-visible dynamic tools 或根 instruction drift 明确返回 blocked/reset-required，不得包装成“全量连续性已恢复”。

## 2. 范围与假设

### 2.1 本计划覆盖

- Agent Markdown 有序列表序号失真。
- “思考中”下方重复出现“本轮进行中 / 本轮用时”的 live 状态行。
- 长对话在 Provider/stream failure 后被换成空 generation，下一轮看不到此前书名、文档或任务语义。
- 失败原因被压成通用错误、终态/重试/下一动作多处重判、字段写出但未消费。
- 真正需要换 generation 时的 accepted-prefix handoff、崩溃对账、归档和旧回执隔离。

### 2.2 本计划不覆盖

- 不把 Codex runtime `0.149.0` 升到 Matrix 当前 `0.151.0-alpha.7.2`；升级必须走独立 runtime adoption gate。
- 不复制或依赖 ChatGPT Matrix 私有 ASAR 实现；只借鉴可由 pinned binary、生成 schema 和黑盒探针证明的协议语义。
- 不新增长期记忆、会话摘要、session recall 自动挂载或另一套模型循环。
- 不扩大显式重试词典，不把普通对话伪装成 `explicit_retry`。
- 不自动重发未知 Provider 请求、工具动作或 fork RPC。
- 不承诺 runtime/model-visible tool/root-instruction 不兼容换代也能自动保留上下文。0.149 与 0.151 黑盒均证明 `thread/fork` 不接受 model-visible `dynamicTools` 覆盖，`developerInstructions` 覆盖也不能替换 source root instruction；因此 fork 只允许 source/target 相应 digests 完全相等。漂移时在 Provider 请求前明确阻断，不能静默开空 thread。

### 2.3 当前工作树边界

当前工作树已有大量无关改动，也已经存在有序列表与 live duration 的修改雏形。本计划文档不得把这些工作树变更写成已验收实现。当前雏形把每一行原 marker 原样显示，并把 live elapsed 整行隐藏；这两点都超出了本计划的目标，实施时必须用截图等价红测先纠偏。只接管与本计划明确列出的文件和测试，不重排或清理相邻代码，不覆盖其他人的未提交改动。

## 3. 现场根因

### 3.1 这次不是 compaction

安装态失败回合的上下文用量仍明显低于窗口上限，native thread 中也没有对应的自动或手动 compaction 事件。故障发生在 Provider stream 断开后：Ready 将失败 native terminal 统一归为 `publication_diverged`，退役旧 generation，再为同一 alias 插入一个空 successor。下一次普通输入只带当前一句，模型自然不知道此前讨论的是哪本书。

现有链路是：

```text
Renderer 仍展示完整 chat_messages
  -> Main 看到旧 generation 已退役
  -> 创建空 successor binding
  -> thread/start 只注册本轮工具、模型和宿主指令
  -> turn/start 只发送当前用户输入
  -> Gateway 只转发 app-server 已组好的请求
  -> 模型丢失旧 native thread 的历史
```

`chat_messages` 是产品显示真值，不是 native 模型历史；Renderer 仍能显示旧消息不能证明模型仍能看到旧消息。

### 3.2 失败被过度退役

`resolveCodexUnownedNativeTerminalCloseout` 当前把除未分叉 interrupt 外的所有 failed/completed-rejected native terminal 都判成 `publication_diverged`。production composition 又只在 completed candidate 上做完整 `thread/read`/compaction readback，failed terminal 没有先核验真实 native history。

这与现有 exit-authority matrix 自己的合同冲突：provider auth/config、context overflow、external failure 应形成 typed product failure；只有协议或发布面可能导致历史分叉时才允许退役。

### 3.3 真退役后没有历史交接

当前 `publication_diverged` 只创建一个空 generation。`recoveredContextDigest` 被 schema 强制为 `null`，没有非空 producer 和 live consumer；它不是可恢复的合同。`session_search` 默认排除当前会话谱系，attached session recall 也没有 Codex prompt 消费者；它们都不能承担 generation handoff。

显式重试同样不能补洞：它只回放失败 run 自己的 task root。本例失败 task root 是“总结第一卷第五章”，书名和文档语义存在于更早普通回合，因此即使用户输入严格的“重试”，也不能恢复更早会话上下文。

### 3.4 终态和下一动作有多套矛盾真相

当前至少存在以下冲突：

- canonical failure copy 无条件承诺“再次尝试时会先核对已有结果”。
- terminal `SendScopedResponse` 固定写 `retryableByUser: false`。
- canonical closeout 固定写 `resumable_actions=['none']`、`continuation_ref=NULL`。
- `ProductTurnReceipt.failure` 再根据错误字符串 regex 重判 kind，几乎一律写 `reconcile_then_retry`。
- Renderer explicit retry和 Main retry lineage只检查 failure是否存在，不消费旧的重试/effect字段。

这会让请求、回执、终态、按钮、文案和下一动作互相打架。修复不能只改提示语。

### 3.5 回复呈现是两个独立的 Renderer 问题

- 自定义 Markdown 解析器把每个 numbered line 拆成独立节点后自己计数；说明段落、空行或嵌套结构会让计数重置或失真。当前工作树改为逐行照抄 marker 后，Agent 常见的 `1. / 1. / 1.` 写法仍会显示成三个 `1.`。正确做法是像语义 Markdown renderer 一样建立一个 ordered-list container，只保存列表起始值，让原生 `<ol>/<li>` 负责后续序号。
- `ThinkingIndicator` 已拥有 live activity 状态，但 `RunDurationMeter` 又为 live phase生成“本轮进行中 + 本轮用时”，同一行里出现两个状态标签。用户点名要删除的是“本轮进行中”部分，不是删除计时。正确做法是保留 heartbeat 和 elapsed，只把 duration row 收敛为单一短语“本轮用时 00:01”；终态后继续冻结用时。

这两项不需要接入 Main、DB、任务账本或 native runtime。

## 4. ChatGPT / Matrix 的可借鉴接线

当前 Matrix Runtime 的可证行为是：

- 普通下一轮始终对同一个 `threadId` 调用 `turn/start`。
- app-server 重启后按 `threadId + rollout path` 做 `thread/resume`，UI hydration 与模型恢复分离；UI 不把显示历史回灌给模型。
- 自动/手动 compaction 在同一 native thread 内替换 active model history，thread identity 不变。
- stream error 有 typed error 与 `willRetry`；`willRetry=true` 是非终态重连进度，不产生 failure closeout。普通最终 failure 也不自动换成空 thread。
- 真正需要新会话分支时使用 `thread/fork`。协议只保证 `lastTurnId` 为 inclusive 且目标 turn 不能 `inProgress`；“只能选择 Ready product-accepted/verified-compaction prefix head”是本计划更严格的 Ready policy，不冒充 runtime 协议要求。child 持久 `forkedFromId` 和独立 thread identity。
- `thread/fork` 没有 idempotency key。若 child 已创建但 response 丢失，不能盲重发。
- `thread/read` 返回给 UI 的 ThreadItems 是有损投影，不能用来反向重建完整模型历史。
- 0.149 与 0.151 黑盒均证明 archived source 不能 fork，必须先 unarchive；本计划不引入 unarchive -> fork -> rearchive 的第二套副作用状态机，因此 pending fork 从 closeout 起阻止 source archive，legacy archived source 只能明确 blocked/reset。
- 0.149 与 0.151 黑盒还证明 fork 中未知 `dynamicTools` 字段会被静默忽略，`developerInstructions` 也不能替换 source root instruction。Ready client 必须用 exact allowlist 拒绝这些字段，fork 只跨完全相同的 model-visible tool/instruction contract。

Ready实施时的协议字段权威是 pinned `package.json` runtime与 `assets/codex-runtime/schemas/stable/codex_app_server_protocol.v2.schemas.json`，其中 `ThreadForkResponse/ThreadResumeResponse` 的 effective settings与 `Thread`投影必须分别消费；Matrix 0.151只用于对照行为，不得覆盖 Ready 0.149的 schema/黑盒结论。所有探针 receipt记录 binary/schema hash，避免未来版本漂移后继续套用旧 allowlist。

因此 Ready 应借鉴的是“native thread 持有模型连续性、Ready 持有产品事实”的边界，而不是照搬 ChatGPT UI 或私有实现。

公开文档只作为方向性旁证，不替代 pinned runtime探针：[OpenAI Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)明确多轮信息必须由正式 conversation state机制保存；[Compact a response](https://developers.openai.com/api/reference/java/resources/responses/methods/compact)返回的是 user messages加一个 compaction item，而不是让应用层把 UI文本重写成另一份历史。Ready具体采用 native thread/resume/fork的结论仍以本地 schema、rollout与黑盒证据为准。

## 5. 目标事实所有权

| 事实 | 唯一 owner | 正式生产消费者 | 明确禁止 |
| --- | --- | --- | --- |
| 模型可见历史与 compaction | Codex native thread / accepted-prefix fork | app-server model loop、`thread/read/resume` parity gate | Ready `chat_messages`、session recall、自制 summary 重建 |
| 产品终态与正文发布 | canonical closeout + `codex_turn_bindings` | ProductTurnReceipt、Renderer、accepted-boundary selector | native `completed` 直接冒充产品成功 |
| Provider/native 失败事实 | Gateway wire evidence + collector native terminal | terminal facts fold、日志与诊断导出 | Gateway 猜工具效果/持久化、error string regex 重判、直接触发重试 |
| 工具效果、文件和产物 | action/delivery/materializer receipts | QC、retry、GC、available-action fold | native history或 assistant 文案证明副作用 |
| 当前轮资源和权限 | Prepared run + frozen authorization | Codex admission、Gateway、tool dispatch | forked history、旧附件、旧 resource ref 自动授权 |
| closeout 时的终态与历史观察 | Main 侧 immutable terminal facts | closeout、退役/保留、successor seed、action projection | 事后改写、Renderer/model/文案自行判断 |
| fork 交接身份 | 现有 thread materialization transaction 的最小 immutable seed | fork dispatch、response reconciliation、boot recovery、archive gate | predecessor run、task projection、Renderer store 重复保存 |
| 任务重试 lineage | explicit retry predecessor/task root | zero-tool/action/interaction/effect gate、资源复核 | 不表示conversation generation祖先；不得复用旧receipt |
| 当前可用动作 | immutable terminal facts + 当前 materialization/head 的纯投影 | ProductTurnReceipt、Retry 控件、Main ingress | 落库为第二终态、Renderer 按消息文本重猜 |
| 回复序号与 live 状态 | ordered-list 的首个 marker + 当前 run phase/timestamps | 原生 `<ol>/<li>` / ThinkingIndicator / duration row | 逐行 marker counter、DB、Main、任务账本新增 UI 状态 |

## 6. 核心合同 A：不可变终态事实与动态动作投影

### 6.1 Producer-owned failure evidence

Gateway 不再把所有未知 stream error 只压成 `gateway_native_stream_failed`。它只在现有 gateway evidence 中写一份脱敏、有限枚举的 wire failure record：

- failure class：provider、transport、protocol、context；
- failure stage：connect、headers、stream-before-item、stream-after-item、terminal-validation、post-terminal；
- response identity 是否已见；
- wire 上是否观察到 partial assistant item 或 tool-call item；
- elapsed、event count、wire byte count；
- safe cause code 与 evidence digest。

不得持久化 token、完整 URL、原始响应正文或不受控 exception message。Gateway 不判断工具是否执行、effect 是否成立、产物是否交付或 Ready 是否持久化；这些事实分别来自 action/effect receipts 与 closeout repository。wire record 只提供线路事实，不拥有 retry 或产品终态。

持久位置复用现有 `ready_model_gateway_exchange_events` 账本，但扩展一个互斥 immutable `response_failed` event kind；不得拿 `response_completed`冒充。`codex-model-gateway-authority.ts`是唯一writer，在请求已admit后按 request/run/thread/turn/attempt/event-sequence绑定上面的有限枚举JSON与canonical digest，事件一旦写入不可改。Gateway live诊断、collector/terminal fold、boot crash recovery与archive都按typed event ref读取；不同request/sequence/digest、迟到成功或重复失败由exchange CAS拒绝。`response_failed`写入后、canonical closeout前崩溃必须由native test证明boot仍能用同一证据收口一次。

`willRetry=true/false` 的 error notification 都不是终态，只更新 transient reconnect/error projection，不得写 canonical failure、terminal facts、retirement/fork seed或 Retry UI。只有同身份 `turn/completed`，或连接 owner 证实连接已关闭且按现有 recovery 合同完成 native readback，才能进入 closeout fold；迟到的 `turn/completed` 仍由唯一 terminal CAS裁决。`error(true) -> success`、`error(true) -> error(false) -> failed completed`、`error(false) -> late completed` 都必须有行为测试。

Collector 将 wire record、native turn terminal 与 `thread/read` 交给一个纯函数 `resolveCodexTerminalFacts`；composition 同时把 publication barrier、canonical candidate 与 effect receipts 作为各自 owner 的 typed input 加入该 fold。不在 closeout、presentation、Renderer 再写第二个分类器。

terminal用途的native readback不复用 ingress/checkpoint 的 `current_thread_read_evidence_digest`。`codex_turn_bindings`新增 immutable `terminal_native_readback_receipt_json/digest/revision`：canonical closeout participant是唯一writer，把 exact connection epoch、thread/turn identity/status、read revision、有限items/compaction identity digests与receipt id同terminal facts在一事务写入，`kind='native_readback'` ref只指向该row。若readback后closeout前崩溃，boot可以安全重读同一terminal turn后再写一次；不同identity/revision/digest或late writer CAS失败。live terminal fold、boot、archive都消费同一receipt，必须有readback->crash->boot closeout exactly-once native test。

### 6.2 Canonical terminal facts

closeout 只持久化当时已经成立、以后不会改变的事实：

```ts
type EvidenceRefBase = {
  evidenceRefId: string
  readyScopeId: string
  messageVisibilityEpoch: number
  aliasGeneration: number
  readyRunId: string
  codexThreadId: string | null
  codexTurnId: string | null
  revision: number
  digest: string
}

type CodexReceiptRef =
  | (EvidenceRefBase & {
      kind: 'gateway' | 'native_turn' | 'native_readback' | 'publication' | 'verifier' | 'artifact' | 'lifecycle'
      receiptId: string
      ownerIdentity: Record<string, string | number>
    })
  | (EvidenceRefBase & {
      kind: 'effect'
      effectEvidence:
        | {
            state: 'confirmed'
            readyActionId: string
            actionIdentityDigest: string
            receiptId: string
          }
        | {
            state: 'indeterminate'
            readyActionId: string
            actionIdentityDigest: string
            sourceRevision: number
            resolutionEvidenceDigest: string
          }
    })

type CodexTerminalFacts = {
  product: {
    terminal: 'done' | 'error' | 'cancelled' | 'interrupted'
    terminalReason: ExecutionHostTerminalReason
    failureKind: ProductTurnFailureKind | null
    evidence: CodexReceiptRef[]
  }
  history:
    | {
        kind: 'continuation_safe'
        seamId: string
        policyVersion: string
        runtimeProbeReceiptDigest: string
        retainedFormalInputMappingDigest: string
        evidence: CodexReceiptRef[]
      }
    | { kind: 'diverged'; reason: HistoryDivergenceReason; policyVersion: string; evidence: CodexReceiptRef[] }
    | { kind: 'unknown_reset_required'; reason: HistoryUnknownReason; policyVersion: string; evidence: CodexReceiptRef[] }
    | { kind: 'reset' | 'closed'; evidence: CodexReceiptRef[] }
  effect:
    | { state: 'none'; evidence: [] }
    | { state: 'confirmed' | 'indeterminate'; evidence: CodexReceiptRef[] }
}
```

实现时把每个 `ownerIdentity`继续落成具名discriminated union，而不是让 `Record`进入生产schema：`lifecycle`必须且只能带lifecycleActionId；`native_turn`带turn identity；`native_readback`带connection epoch/read revision/被核验thread-turn；gateway带exchange request/event sequence。effect使用上面的专属union：indeterminate不存在receiptId，confirmed必须有receiptId；不能拿readyActionId冒充receipt。其他kind出现owner-only字段即reject。公共base只有evidenceRefId、scope/run/native身份、revision与digest。

`terminalReason` 与 `failureKind` 必须由该 fold 明确产出，`run_meta` 与 ProductTurnReceipt 只做等值投影，不能再靠字符串重判。typed reference validator 必须核对 kind、owner run/thread/turn/call、scope、epoch、generation、revision、digest，拒绝跨 run、未知 kind、重复和过期引用；terminal facts digest 覆盖规范排序后的 references。

关系 invariant 同时由 schema/transaction test 强制：

- `done -> terminalReason=done && failureKind=null`；非 done 必须有与 terminal reason 映射唯一的 failure kind。
- `history.continuation_safe/diverged/unknown/reset/closed` 五类互斥；reset/closed 必须有 `kind='lifecycle'` 且 `lifecycleActionId`、scope/epoch/generation 与实际 reset/close CAS 完全一致的 receipt，其他 kind 不得冒充生命周期证据。
- `continuation_safe`必须冻结 exact seamId、history-policy version、本包pinned-runtime probe receipt digest与本轮formal model-input mapping digest；该mapping必须只有一个current user origin，不能含任何`deliver_untrusted_history`或其他additional tail origin。diverged/unknown冻结policy version。boot/后继消费者只读immutable结果，不按升级后的allowlist重分；probe/mapping digest进入terminal facts digest与包体验收。
- `effect.none` 的 evidence 必须为空；confirmed/indeterminate 必须至少有一条同 run/call 的 effect receipt。
- `effect.confirmed` 只表示已有工具/action ledger已settled，不授权跨run复用，也不陈述某个外部动作可安全重放。
- product/history/effect 各自只保存本角色 references，不再维护顶层重复并集。

聚合只用同一张确定性映射表驱动：任一可枚举tool/action receipt真实terminal为indeterminate，aggregate=`indeterminate`并引用全部indeterminate/confirmed evidence；否则至少一条confirmed，aggregate=`confirmed`；全部proven_absent或零tool/action activity时aggregate=`none`且effect evidence=`[]`，proven-absent证据仍留原账本审计，不伪装confirmed。任何legacy、无法枚举或缺receipt的activity按indeterminate处理；`confirmed + indeterminate`永远不能被下游投成confirmed，必须有table test。

现有 `ready_tool_action_receipts` 只有action id与结果状态，不能从一轮反查 Tag Forge/Document 等工具在执行期间创建的全部nested product actions；顶层tool result也不保证带回全部 `effectActionId`。因此只新增一个**归属索引** `codex_product_effect_bindings`，不复制结果：每行冻结 `effectActionId/actionIdentityDigest + readyRun/scope/epoch + codexThread/turn/call + parentReadyActionId + tool/action/ordinal/argsDigest`。`CodexToolActionJournal.beginBoundProductEffect` 在同一SQLite事务先核对owner run/turn仍nonterminal且effect authority未关闭，再同时插入pending action receipt与binding；重复exact identity幂等，foreign parent、ordinal冲突或closeout后的late begin拒绝。closeout、Retry classifier、boot与archive只沿 `codex_tool_call_bindings -> codex_product_effect_bindings -> ready_tool_action_receipts` 枚举，不能从hash、tool output或自然语言反推。该表不提供跨run查找、结果复用、重放或新的副作用状态机。

canonical closeout前先关闭该run的tool/effect authority并对上述完整枚举集做settle gate：每行必须真实进入DB terminal `confirmed|proven_absent|indeterminate`，`read()`把pending临时显示成indeterminate的返回值不具备closeout资格。确认从未dispatch才可proven_absent；已dispatch或无法证明时用同一closeout evidence CAS为真正indeterminate。settle、terminal facts与action-sequence写入由同一canonical closeout transaction participant编排；之后任何late begin/commit CAS失败，boot也只能读terminal row。legacy缺归属索引或绑定链不完整时明确 `retry_evidence_incomplete`，不能假装已枚举。必须覆盖nested action pending -> closeout-indeterminate -> late result、同一call多action、缺一个nested binding、崩溃恢复与archive readback反例。

同一closeout事务还必须关闭该run的ask-user waiter、pending interaction与action confirmation authority。普通clarification的答案正文唯一owner仍是现有 `chat_messages.meta_json.askUserQuestions`；action confirmation则由linked ask card与existing `pending_confirmations` row共同构成一次canonical交接，不新建/复制answer、decision或terminal evidence ref。小型raw-DB `CodexInteractionTransitionRepository`成为**所有Codex-bound interaction canonical transitions**的唯一serializer：普通ask card的pending create/submit/用户主动cancel/closeout cancel-or-expire/boot settle，以及action confirmation的linked pending create/respond/用户cancel/timeout-or-abort/closeout/boot settle都经具名CAS方法；generic non-Codex interaction才可留旧API。

两个pending create入口也必须共享single-pending事实，不能在各自内存store先查再异步落库。`createAskPendingAtomic`与`createLinkedConfirmationPendingAtomic`都用同一`BEGIN IMMEDIATE`，在exact scope/session/run/epoch/source下同时查询existing pending ask-card meta与`pending_confirmations + actionConfirmationOwnerRef` linked row；任一类已pending即返回`overlapping_card`并零card/pending-confirmation/waiter/event写。只有查询和对应普通ask row插入、或confirmation row+linked card双行插入在同一事务commit后，调用方才注册内存waiter并emit。ordinary-vs-ordinary、ordinary-vs-confirmation与confirmation-vs-confirmation并发都由数据库串行化，只能一个成功；loser不猜哪一类卡、也不覆盖winner。commit后注册waiter前崩溃由既有boot settle收口，不允许先emit一个尚未提交的卡。本阶段不新增single-pending表或第二锁。

action-confirmation card的pending meta新增最小link `actionConfirmationOwnerRef={frozenCallId,pendingConfirmationSourceDigest}`，不复制decision或params。create时repository核对pending confirmation row与exact run/scope/epoch/source后冻结该ref；后续删除按session+question id的`findPendingForSession`猜关联。action confirmation只能调用`respondActionConfirmationAtomic(cardId,frozenCallId,decision,...)`：按owner ref核对exact card-question-pending row-run-scope-epoch-source-link digests，在同一SQLite事务把card投影写为submitted/cancelled并把pending confirmation写为released/denied；approve仅在commit后才产生typed `ActionConfirmationTransitionOutcome={decisionRef,frozenParams}`（params只作内存交付，不另持久化），随后用该outcome resolve confirmation waiter。普通clarification waiter仍只返回answers。`frozen-call-confirmation.ts`调用方直接消费已提交outcome，删除await之后再次`store.release/deny/expire`的第二次transition。用户cancel、TTL、abort同样在一个事务把card与pending row共同settle为cancelled + denied/expired；两次写之间的状态永不可见。commit后内存resolver缺失不回滚canonical rows，也不dispatch，由现有terminal/boot路径按已settleddecision + 零action-dispatch receipt收口；closeout先赢则用户transition零写、零params、零dispatch。

前置条件分三类，不能用一个“owner nonterminal”把boot自锁：create/submit/user-cancel/respond/TTL只允许exact run/scope/epoch/source digest且owner nonterminal；canonical closeout只允许持有同一run的terminal-transition fence并在open transaction内settle；boot settle允许exact owner已terminal且terminal/closeout digest相等，或由boot recovery持有该nonterminal run的closeout owner，只做pending->expired/cancelled CAS。无法exact绑定owner但仍Codex-shaped的旧行不新增quarantine状态：boot由同一repository把existing ask row CAS为`cancelled`并在其现有meta记录`app_restart_identity_ambiguous`；confirmation只CAS现有`status='expired'`，不声称不存在的reason/meta/audit/digest列。confirmation的ambiguous原因由纯ownership resolver基于缺失/冲突owner/link稳定派生，供诊断、Retry-incomplete与archive read，不绑定或关闭任何猜测run。`FrozenCallStore`对Codex rows只调用repository，不能在release/deny/expire/TTL sweep中直接UPDATE。本地IPC与远程渠道都复用相同submit/cancel cores，remote service不得再建写分支。任一用户transition先赢则closeout直接读canonical rows并分类task-restatement；closeout先赢则late transition `waiting_task_gone`零写，commit后才退内存。classifier/Retry gate按exact run读取canonical rows；ambiguous legacy关联令Retry evidence incomplete，FTS/content只是projection。

`FrozenCallStore`构造器不得再做`UPDATE pending_confirmations ... WHERE status='pending'`的隐式全表boot写。构造器只初始化内存。唯一纯`resolveCodexInteractionOwnership`同时检查explicit `codexRunIdentity`、ask `requestId`关联的run/scope/product binding与confirmation owner/link，输出`exact_codex | codex_shaped_ambiguous | proven_non_codex`；ask/confirmation boot与generic fallback都复用它，不各自猜。Codex boot先通过上述repository结算exact rows，并把ambiguous/invalid但Codex-shaped rows按上段直接一次性fail-closed终态化。随后generic fallback只处理`proven_non_codex`，即`NOT EXISTS`任何Codex product/run关联且无Codex-shaped证据。两种fallback都严格排在Codex boot closeout之后；ambiguous row二启不再pending、list不再占位、archive仍可读，且缺`codexRunIdentity`但`requestId`命中Codex run的旧卡不会被第二writer改写。

单问 `skill_ask_user` 的owner仍是现有 `EphemeralExecutionStore`，不为答案新增持久表；其top-level tool binding已经让Retry保守不可用。store新增按exact agent/scope/run的terminal fence：canonical closeout participant在事务前prepare fence，commit后`rejectByRun(waiting_task_gone)`并删除record，rollback才释放fence；`skills:askUser:submit`先核对exact record、fence与owner run仍nonterminal再resolve。executionId不复用，record不存在即可让late submit返回gone，不再另留会增长的内存tombstone。closeout先赢或并发跨过fence都返回gone，任何迟到tool-result写仍由run terminal CAS拒绝；重启时ephemeral store为空。覆盖terminal-vs-single-answer并发与rollback反例。

fork pending/unknown/confirmed、当前资源状态与当前可用动作都不是 terminal facts，不得事后改写该记录。`history.unknown_reset_required` 不创建 successor seed 或隐藏 reconciliation owner，也不承诺“等待后恢复”：closeout 事务保留原 source binding 为该 alias 唯一 active、但 history-blocked 的 head，`actionHeadIdentity` 指向它；只允许针对同 binding/revision/epoch 的 reset/close CAS。closeout 前可以做一次受界定的 native readback，仍未知就永久按本结果处理。它与“target seed 已成立、仅 materialization outcome unknown”是两种不同状态，后者仍由既有 materialization owner 对账。

### 6.3 唯一持久位置与消费者

将 terminal facts 及 digest 作为 `codex_turn_bindings` canonical closeout 的不可变组成部分；不要同时把完整 facts 复制到 `run_meta`、task projection、message meta 和 Renderer store。

| 新持久字段 | producer | validator | live consumer | boot/archive consumer | stale rejection |
| --- | --- | --- | --- | --- | --- |
| gateway `response_failed` exchange event | model gateway authority唯一writer | admitted request/run/thread/turn/attempt/sequence + limited wire schema/digest | collector、terminal fold、live diagnostic | crash-before-closeout recovery、archive audit | response_completed互斥、foreign/duplicate/late event CAS |
| `codex_product_effect_bindings` ownership index | `beginBoundProductEffect`与pending action receipt同事务唯一写 | exact run/scope/epoch/thread/turn/call/parent action/tool/action/ordinal/args/action identity；owner nonterminal | closeout settle、effect fold、Retry gate | boot settle/readback、archive audit | foreign parent、duplicate ordinal/different digest、terminal后late begin拒绝 |
| card meta `actionConfirmationOwnerRef` | Codex confirmation pending-create transaction与card/pending row一同冻结 | frozenCallId/source digest及card-question-run-scope-epoch exact；仅confirmation card允许 | atomic respond/cancel/timeout join，删除session/question猜关联 | closeout/boot settle、archive audit | missing/foreign/ref digest漂移、linked row已terminal即拒绝 |
| terminal native readback receipt | canonical closeout participant与terminal facts同事务写turn binding | connection epoch、thread/turn/status/read revision/items-compaction digests exact | terminal fold/ref validator | crash前无row则boot安全重读后写；archive audit | foreign identity/revision/digest、late writer CAS |
| `terminal_facts_json` | canonical closeout transaction | strict schema + typed receipt identity + terminal/run等值检查 | ProductTurnReceipt/action projector、history policy | boot reconciliation、accepted-prefix selector、legacy projector | run/scope/epoch/generation/revision CAS |
| `terminal_facts_digest` | 同一 canonical serializer | 每次读回重算；覆盖规范排序的 typed refs | presentation digest、successor seed builder | recovery/cleanup evidence | late terminal或不同 facts digest拒绝 |
| `codex_thread_bindings.action_projection_sequence` | binding repository唯一 increment helper | 非负单调整数；影响动作投影的事务必须 `+1` | receipt refresh/version比较 | boot readback、reset/close/archive audit | sequence较小或跨epoch事件拒绝 |

生产消费顺序固定为：

```text
Gateway/collector facts
  + publication/verifier/effect owner receipts
  -> resolveCodexTerminalFacts (唯一 immutable fold)
  -> canonical closeout 同事务持久 facts + 产品终态 + publication seal
  -> binding 保留/退役 + successor seed
  -> materialization owner 推进现有 start/reconciliation receipts
  -> projectCodexAvailableActions (同一 reducer，不落库)
  -> scope/head projection（普通发送）+ per-run ProductTurnReceipt（Retry）
    ；reset/stop/close/manual compact继续由现有 lifecycle projection 单独拥有
  -> Main ingress 在事务内重算并校验
```

`ProductTurnReceipt` 增加：

- immutable `ownerAliasGeneration`，永远表示该 failure run 所属 generation；
- `retryEvidenceKind='complete'`时才有`headProjectionRef`、`currentReadyMemoryRef={scopeEpoch,stateRevision,revocationRevision,semanticIngressDigest,modelVisiblePayloadEmpty,eligibilityDigest}`与`currentTrustedEnvironmentRef={requestedWorkbenchMode,trustedWorkbenchMode,modeDigest}`；memory ref不复制payload，environment ref只冻结Main trusted resolver给出的模式对，不复制页面、文档或资源状态；
- `retryEvidenceKind='unavailable_legacy'`用于legacy/malformed/missing-terminal-facts行：三类动态refs必须显式null，Retry固定not-applicable，只以owner run/revision与audit digest封口，绝不补synthetic B/memory/environment digest；
- complete分支的`productTurnActionProjectionVersion={ownerTurnRevision,headProjectionVersion,readyMemoryStateRevision,readyMemoryRevocationRevision,trustedModeDigest,evidenceDigest}`；unavailable分支只有`{ownerTurnRevision,auditDigest}`。

普通发送不依赖 terminal run或伪造 ProductTurnReceipt。新增独立 `CodexHeadActionProjection`，从scope epoch + active binding/generation/revision/sequence + materialization/live-tail事实以及**当前pinned runtime/protocol digest**只生成`send_new_message` gate；已知head runtime/protocol drift直接`blocked/head_contract_drift`。严格pristine drift先走§8.1具名refresh再投影；非pristine/legacy drift不允许UI先显示ready再由ingress拒绝。只有依赖当前输入prepare后才能知道的tool/instruction/resource/Ready-memory payload drift保留在同一run-preparer的ingress-specific gate。reset/stop/close/manual compact继续由现有`agent-lifecycle-snapshot`域唯一拥有，但把它从“snapshot后由Renderer/Main分别推断”升级为一个shared pure projector，直接输出四个具名action gates；ChatHeader/useAgent与Main lifecycle adapter都只能消费这些gates，不再分支重判。head projection不复制生命周期动作，只消费其fence/closed事实作为发送阻断。为避免两个正确projector在不同DB时刻组合成错误UI，正式read由同一只读事务生成`CodexActionSurfaceEnvelope`：`readCodexActionSurface(scopeId)`一次携带head projection和lifecycle action projection，后者带同一`scopeEpoch + headProjectionRef`锚。typed`agent:codexActionSurfaceInvalidated`只携带已提交的`{scopeId,scopeEpoch,actionProjectionSequence}`并触发atomic read，不携带in-transaction projection。即使新scope/reset后的pristine `fresh_start`尚无任何run，envelope也必须含合法head projection，首条发送因此有`actionAdmissionRef`；不得创建synthetic run/receipt。事件丢失由scope hydration read与stale-send后的强制read恢复。

`failure.kind/effectState` 直接投影 terminal facts，删除错误字符串 regex；现有无生产消费者的 `retryPolicy` 直接删除，不保留 alias、双读或兼容期。Renderer 只展示 projection，Main explicit retry 在同一事务内重新读取 owner facts/head，不能信任 Renderer 传回的 action 或只看 `failure !== null`。

共享合同一次性升级为 `ready_product_turn_receipt_v3`；Main 对 legacy DB 行只生成上述`unavailable_legacy`保守分支，Renderer/IPC 不同时接受 v2/v3。历史行缺 terminal facts/formal semantic ingress时不得调用B-based projector或填空digest，按 §15 禁用 Retry，而不是保留旧 `retryPolicy` 推断。

materialization/head或较新的product terminal变化后，正式event只广播已提交action-surface invalidation；Renderer随后atomic read同一`CodexActionSurfaceEnvelope`的head+lifecycle。event没有Renderer当前workbenchMode，禁止后台猜并直接刷新动态per-run gate。head ref前进会让旧per-run projection立即失配，Renderer隐藏Retry后以当前mode + loaded terminalRunIds调用batch read。terminal receipt若附带request-time per-run projection，只在其trusted mode ref与当前mode exact匹配时可暂用，否则同样隐藏并hydrate。actions不持久化。binding repository 的唯一 helper在这些事务中递增 `action_projection_sequence`。active head version按 epoch -> head generation -> sequence形成严格单调全序；closed projection不新增tombstone revision，只引用现有canonical close evidence `{scopeId,messageVisibilityEpoch,closedAt,closeEvidenceDigest}`，其typed ref/digest由lifecycle projection验证并封口，不能伪造不存在的active head。per-run version额外绑定owner turn revision/current mode/memory refs，但不能反向充当head身份。新 epoch或canonical close淘汰旧head/per-run缓存；乱序、重复或不匹配lineage/mode全部拒绝。canonical assistant message与immutable terminal facts不改写。显式Retry携带当前`presentationDigest`，过期digest由Main拒绝并要求刷新。

per-run Retry projector还必须从ReadyMemory唯一owner读取上述current ref：payload非空即`not_applicable/current_memory_restatement_required`。不能复用`ReadyMemorySnapshot.snapshotDigest`，因为它含每次read变化的`frozenAt`。唯一`deriveReadyMemoryRetryEligibilityRef(effectiveSemanticIngress)`按global policy与该B实际选中的active entry identities/content digests/source refs规范化生成`eligibilityDigest`，排除`frozenAt/readAt/lastUsedAt`等时间投影；相同state/revocation revision与B连续读取必须byte-identical。过期时间到了但正式`expireMemories`尚未提交/推进revision时保守视为nonempty，不能按墙钟临时改空。

当前代码没有memory change事件，本计划新增唯一typed `ReadyMemoryStateChanged` producer，但repository自身永不发布或猜外层commit。每个会推进global`stateRevision/revocationRevision`的repository mutation都返回`ReadyMemoryStateChangeCandidate | null`，candidate永远交给**实际调用方/最外层应用事务owner**：runtime service负责set-global/add/edit/pin/delete/reset等UI mutation；generation worker负责standalone `expireMemories`及generation/consolidation outer transaction。一个outer transaction内多个candidate只coalesce到最终global revision并在成功返回后发一次，rollback全部丢弃；standalone repository-owned transaction也由其调用方在方法成功返回后发。post-commit发布是best-effort invalidation：publisher/listener异常只记诊断，绝不能把已提交mutation返回成失败或触发业务重试；事件原本即可丢，hydrate/click readback兜底。禁止repository方法返回时自行发、microtask猜commit或in-transaction静默漏发。conversation contribution只改conversation policy、不影响global model-visible snapshot，明确不发该event。结构gate枚举set-global/add/edit/pin/delete/reset/expire/supersede/consolidation的每条revision mutation，证明恰有一个outermost publisher且no-op不发；standalone expire单列event测试。

Main production composition收到`{stateRevision,revocationRevision}`后只广播global invalidation，不扫描/重投影全库失败run。Renderer对当前已加载消息中的terminalRunIds调用现有批量presentation read；scope hydration同样只传loaded/visible runIds，Main逐请求run用同一projector计算，不让Renderer自己算eligibility。Renderer按`stateRevision -> revocationRevision`只接受更大revision，同revision同eligibilityDigest幂等、同revision不同digest拒绝并hydrate。事件丢失时点击Retry由Main按runId重读memory ref并stale reject后hydrate；boot/archive无需预生成全库actions，只在对应run被UI hydrate或审计时派生。native tests覆盖nested consolidation commit/rollback后listener同步read（commit一次/立即可读，rollback零event），以及大量历史+单可见scope只请求loaded runIds。该ref不进入head send sequence，也不复制memory payload；它只让Retry按钮与pre-persistence admission消费同一current-memory事实。

per-run projection read额外接收Renderer当前`workbenchMode` hint。Main用现有`resolveTrustedRequestEnvironment`只解析trusted mode，生成`currentTrustedEnvironmentRef`；source侧从stable root ingress contract验证当时冻结的mode及全部ambient/resource fields。source或current任一为`rss|calendar`、source/current mode不等，或source任一page/document/resource/target字段非空，Retry立即`not_applicable/current_environment_restatement_required`。当前browser page、document anchor、attachments、resources、product targets与split-mode targets没有共同单调revision，因此绝不进入动态projection、version、digest或cache；projector也不得谎称已核验这些事实。

按钮与自然语言明确重试消费同一 Main explicit-Retry 合同。Renderer 保留当次原始文档观测（含 document 分屏），不以 raw anchor 的存在重判资源资格；显式附件、引用、externalReadSlice 和 workbench 目标仍不得被剥离。合法观测交给 Main：先校验控制请求与精确来源，再用原任务 B 在唯一 prepare 中解析 activation；源准备记录和本次激活结果分别验证。真实 browserPageRef、activated currentDocumentAnchor、附件、显式资源与产品目标非空时零 user/run/Provider bytes，并保留草稿。projection 仅表示允许发起最终检查，不能伪造 current facts。模式变化沿用原有 scope/epoch/version 保护重读；无环境 revision 时，最终资格仍只由 prepare 及提交前核对决定。

Main不能只看到`explicitRetry` metadata就相信Renderer，但transport parse与semantic admission必须分层。`parseSendScopedRequestTransport`只裁有界、可识别的基础类型/身份，让“resources空但count非零”“arbitrary C + explicitRetry”“nontext message + strict userMessage”等**结构可解析但语义矛盾**的payload仍能进入唯一pre-persistence validator；完全无法识别scope/request或基本类型错误才作为IPC结构错误。runtime validator把合法请求收窄为ordinary或`ValidatedExplicitRetrySendScopedRequest` exact分支，并对后者要求：`message`只能是string且与`userMessage.content`逐字相等；二者都由Main复用`src/shared/resume-lexicon.ts`同一strict parser判为retry control（按钮只发送canonical `再试一次`）；AgentIngressMessageBlock数组、任意新正文C或非strict文本一律拒绝。`resources`必须省略，`currentDocumentAnchor`允许作为原始观测传入唯一 prepare（本次激活结果必须为空），`userMessage.attachmentConfirmation`四个count必须全0，`userMessage.meta`只允许exact keys `sourceKind,sourceId,threadKey,direction,workbenchMode,actionAuthorizationMode`；其中`direction='local-input'`，source/thread三项必须与当前scope row exact相等，action mode必须与Main读取的scope policy相等，workbenchMode只作requested hint并由Main trusted resolver复核；`attachments/codexExternalReadSlice/skill/mention/target`及任何其他key必须不存在。

Renderer在构造request前若看见附件、`@`引用、文件池命中或workbench surface resource，直接保留composer并不调用IPC；不能像现代码一样先令`currentAttachments=[]`后仍继续收集引用/文档/workbench资源。结构可解析但未通过上述semantic validator的direct IPC必须调用现有`createRejectedBeforePersistence`生成完整`SendScopedResponse`（`success=false, disposition='rejected_before_persistence', shouldClearInput=false, preserveInput=true, errorKind='explicit_retry_control_invalid', persistence=SkippedIngress, admissionEvidenceDigest`），不得throw/reject promise；`agent-lifecycle-group`只做transport parse并原样转发这个typed结果。validator固定为`AgentControlRuntime.sendScoped(transportPayload)`的第一步，早于`ensureReadyForUserIngress`、reference-hint/authorization read-write、start-identity resolution/reservation、scope/message/user/run写入和任何sidecar调用；失败时这些调用计数全部为0。通过后才生成`canonicalUserMessage`并进入现有`runConfirmedSendScoped`。e2 `controlAuditMessageRef`只能由验证后的narrowed分支签发，其digest覆盖完整control-only envelope；R只作产品审计，绝不成为任务语义。register/IPC与runtime direct tests必须断言arbitrary/nontext/count/meta矛盾得到typed response、reservation/ensureReady/持久写均为0；不是只断言Zod抛错。

当前session reference hint、显式技能选择、安装后新增的candidate primitives与每轮**执行授权**同样不是可单调投影事实，不进入v3 receipt/version。Main在任何hint remember/skill authorization mutation及user/run写入前，用source ordinary prepared contract和稳定`sourceIngressContractDigest`派生两份不同角色的事实：`sourceRetryToolDefinitionDigest`是thread-sticky完整model-visible definitions，只允许exact equality；`sourceRetryExecutionCeiling`只含规范化`allowedToolNames`、selected-skill identity、typed actions、allowed primitives、candidate `{skillId,primitive}` pairs与action permission set。再以effective B在当前scope做**只读**skill relevance/capability解析，得到ephemeral current facts。当前request有显式skill/mention选择，或现存reference hint会对B判relevant时，Retry直接`not_applicable/current_skill_context_restatement_required`，保留composer并要求ordinary完整重述；不得静默忽略用户选择，也不得调用remember方法。

为使“只读”成为可接线合同而非口头要求，skill hint owner先提供唯一`captureReferenceSkillHintSnapshot(sessionId,epoch,observedAt)`：直接读取并clone当前entry与durable epoch，返回`active | absent | expired | epoch_drift | closed`、完整`id/name/applicableToolNames/at/messageVisibilityEpoch/entryDigest`，但绝不delete、刷新`at`、emit或持久化。现有`peekLastReferenceSkill`也会在expired时delete，不能冒充该API。一次authorization resolution只capture一次，并把**同一个immutable snapshot**传给hint relevance、`buildPreferredSkillToolNames`、manifest/candidate过滤；这些函数不得再内部调用`getLastReferenceSkill/peekLastReferenceSkill`。

唯一现有skill resolver及`CodexRuntimeHostPort`把调用模式改成必填`resolutionMode:'observe'|'commit'`，没有默认值：两种模式共用上述snapshot、同一个hint relevance、显式skill识别、manifest过滤和candidate生成函数。`observe`返回`{authorization,hintSnapshotRef,hintRelevance,explicitSelectionPresent}`且禁止任何writer；`commit`先用同一snapshot得出相同decision，再由一个具名commit步骤touch/clear/remember applicability，普通轮才能产生现有change event。`codex-product-turn-authorization.ts`继续作为requestEnvelope+skill authorization的唯一正式组合器：ordinary传commit，Retry以effective B传observe并把resolution交给ceiling；production composition/run preparer不得复制skill分类器或直接调orchestrator私有方法。真实hint-store测试覆盖active/expired/epoch-drift：observe前后raw entry、`at`、change-event计数与持久meta必须byte-identical，commit才允许预期变化。

完整model-visible definitions绝不做交集：native-fork继续消费既有`nativeInheritedContractDigest`并要求child/body definitions与source exact相等；fresh-root Retry也只能在当前resolver可重现`sourceRetryToolDefinitionDigest`时用source exact definitions启动，缺项、多项或schema不同即`not_applicable/current_tool_surface_restatement_required`，不得拼出缩小/扩大的新thread合同。为避免给本次修复扩建多owner execution-entry schema，source/current各自派生`bridgeSyntheticHostPrimitiveNames = hostPrimitive(allowedToolNames) - primitives already represented by exact serialized selected/candidate authorization`。只有这个差集非空才使explicit Retry `not_applicable/current_host_primitive_restatement_required`；默认lark candidate已以同一skillId拥有的`skill_read_artifact`不在差集，仍可参与正常source/current求交。现有ordinary bridge行为不改。

无上述定义、host-primitive或意图冲突时，现有`codex-product-run-preparer`内的唯一纯`resolveRetryCapabilityCeiling`才使用既有`ReadyTurnToolAuthorization`表达能力，对source/current的`allowedToolNames`、selected-skill identity、typed actions、allowed primitives、单一candidate `{skillId,primitives}`与action permission set分别规范化求交；同名primitive必须同skillId。当前撤销可以收紧，当前安装/环境/hint绝不能新增，action permission不靠字符串比较宽松度。

求交结果写入既有e2 frozen execution-authorization snapshot，不新增ceiling字段、账本、event或跨run授权引用。`codex-tool-bridge.authorizationOf`保留ordinary的现有host folder-export兼容行为；但当binding的e2 attempt kind为explicit Retry时，必须断言source/current `bridgeSyntheticHostPrimitiveNames=[]`，再按现有代码重建authorization并验证重建前后canonical serialized auth完全相等；任何新增primitive、skillId变化或candidate合成即拒绝。Retry execution context同时冻结`consumeLiveAuthorizationFacts=false`；`tool-executor -> resolveConfirmationGate`不得读取或consume当前scope `AuthorizationFactStore`来跳过M3确认，普通ordinary仍沿现有owner。Gateway先核验body definitions exact thread/source digest，再核验execution authorization是source/current交集；admission filter、Retry bridge、confirmation gate与dispatch只消费这份frozen snapshot。Main click时current facts缺失、source contract/digest不符、definition digest不等、observe发生任何writer调用、synthetic host差集非空或任一authorization set不是source子集，均零user/run/Provider bytes；projection-time `ready`仅表示可以发起这次preflight。

sequence只在影响head/retry/lifecycle gate的正式事务中递增：terminal facts/active fence release/新product terminal（同事务product/automatic coverage不重复加）、lifecycle request/interrupt request/acknowledge/mark-unknown/settle、manual-compaction reservation及其success+coverage/proven-absent/unknown/abandon、target seed/head创建、materialization状态、**任何成功的 `persistIngressAtomic` 新user/run admission**、abandon/reset/close。所有路径调用binding repository同一个现有`action_projection_sequence` increment helper，不新增lifecycle counter；一次事务最多`+1`，同事务多个事实变化只增一次。admission内assignment/supersession不另加，manual success+coverage也只加一次，derived deliveryAudit/重复readback/幂等重放零增。envelope以epoch -> head generation -> action sequence为唯一单调version：Renderer只收更大version，同version同digest幂等，same-version different digest拒绝并atomic hydrate。admission/lifecycle事务同事务+1立即让旧projection失效；事件丢失或崩溃后Renderer hydration按DB最新sequence与正式owner重建，旧事件不能倒灌。

sequence helper只返回`CodexActionSurfaceInvalidationCandidate | null`，永不在repository或未提交事务中发事件。每个真正拥有最外层SQLite事务的调用方收集并按scope coalesce candidate；只有最外层commit成功后才广播一次`agent:codexActionSurfaceInvalidated`，rollback/no-op/幂等重放均零事件。该post-commit广播同样best-effort：publisher/listener异常只记诊断，不能反转已提交的admission/lifecycle/closeout返回，也不能诱发第二次业务操作。嵌套repository、closeout participant、migration和read path都没有发布权。Renderer收到事件后唯一动作是调用`readCodexActionSurface(scopeId)`读取已提交envelope，绝不消费事件携带的projection。native test必须让listener同步回读并看到已提交sequence，证明rollback零事件、publisher throw后业务仍返回committed且DB只写一次，并证明故意丢事件后scope hydrate仍恢复同一最新版；ReadyMemory publisher也跑同一throw反例。

以下动态read/event/version规则只适用于`retryEvidenceKind='complete'`；`unavailable_legacy`只按owner run/revision/audit digest幂等读取，永不因head/memory/mode变化转成ready。complete per-run projection使用唯一字典序比较器：`scope epoch -> head generation -> action_projection_sequence -> ownerTurnRevision -> ReadyMemory stateRevision -> revocationRevision`。requested/trusted mode pair不是单调数，只划分Renderer cache slot：响应只有在requested mode仍是当前mode且trusted mode等值时才进入该slot，旧mode响应直接丢弃；同一mode slot内相同单调tuple+digest幂等、相同tuple不同digest才拒绝并hydrate。每次project先trusted-resolvemode，再在一个DB read snapshot读取head/terminal/memory owner refs；读后若owner revision变化就重读，不拼不同快照。较旧head永远拒绝，即使携带较大memory revision。交叉乱序测试覆盖“新memory+旧head”“新head+旧memory”、terminal与mode切换；页面/文档/resource变化只测试Main click-time gate，不进入这个比较器。

跨 generation Retry 不要求 owner generation 冒充 current head。Main 只允许两种关系：action head 就是 owner head；或 action head 是由该 owner terminal facts digest 原子创建、仍为唯一 current head 的**直接** `native_fork/fresh_root_with_tail` successor。该 owner/其唯一 retry chain tail还必须是当前最新可见失败；第二个 successor、无关 generation、任何更新用户 turn/terminal、seed/digest/revision漂移都拒绝。

canonical failure message 只陈述不会变化的事实，例如“本轮未完成”与有限 failure class；删除“再次尝试时会先核对已有结果”等动态承诺。“上下文已保留 / 正在对账 / 可以重试”只出现在 ProductTurnReceipt 的当前 action projection UI 中。

### 6.4 消费映射必须一次定义、全链复用

`projectCodexAvailableActions` 读取 immutable terminal facts、当前 active head/materialization、scope/epoch，返回：

```ts
type CodexActionGate = {
  availability: 'ready' | 'blocked' | 'not_applicable'
  blockers: HistoryOrRetryBlockingReason[]
  consequence:
    | {
        kind: 'supersedes_uncommitted_structured_tail'
        omittedItemCount: number
        resourceReattachItemCount: number
        itemsDigest: string
      }
    | null
}

type CodexHeadActionProjection = {
  kind: 'scope_head'
  scopeId: string
  ownerRunId: null
  historyState:
    | 'same_thread_ready'
    | 'ready'
    | 'fresh_root_ready_for_ingress'
    | 'materializing'
    | 'materialization_unknown'
    | 'terminal_unknown'
    | 'legacy_context_boundary'
    | 'closed'
  actionHeadIdentity: ActionHeadIdentity | null
  closedByLifecycleRef: CanonicalScopeCloseEvidenceRef | null
  actions: {
    send_new_message: CodexActionGate
  }
  actionProjectionVersion: ActionProjectionVersion
  evidenceDigest: string
}

type CodexProductTurnActionProjection =
  | {
      kind: 'product_turn'
      retryEvidenceKind: 'complete'
      ownerRunId: string
      ownerAliasGeneration: number
      ownerTurnRevision: number
      headProjectionRef: { version: ActionProjectionVersion; digest: string }
      currentReadyMemoryRef: {
        scopeEpoch: number
        stateRevision: number
        revocationRevision: number
        semanticIngressDigest: string
        modelVisiblePayloadEmpty: boolean
        eligibilityDigest: string
      }
      currentTrustedEnvironmentRef: {
        requestedWorkbenchMode: 'browser' | 'document' | 'rss' | 'calendar'
        trustedWorkbenchMode: 'browser' | 'document' | 'rss' | 'calendar'
        modeDigest: string
      }
      productTurnActionProjectionVersion: {
        ownerTurnRevision: number
        headProjectionVersion: ActionProjectionVersion
        readyMemoryStateRevision: number
        readyMemoryRevocationRevision: number
        trustedModeDigest: string
        evidenceDigest: string
      }
      retry_failed_task: CodexActionGate
      evidenceDigest: string
    }
  | {
      kind: 'product_turn'
      retryEvidenceKind: 'unavailable_legacy'
      ownerRunId: string
      ownerAliasGeneration: number
      ownerTurnRevision: number
      headProjectionRef: null
      currentReadyMemoryRef: null
      currentTrustedEnvironmentRef: null
      productTurnActionProjectionVersion: {
        ownerTurnRevision: number
        auditDigest: string
      }
      retry_failed_task: CodexActionGate & {
        availability: 'not_applicable'
        blockers: ['legacy_or_evidence_incomplete']
        consequence: null
      }
      evidenceDigest: string
    }

type CodexAvailableActionProjection = {
  head: CodexHeadActionProjection
  productTurn: CodexProductTurnActionProjection | null
}

type CodexActionSurfaceEnvelope = {
  scopeId: string
  scopeEpoch: number
  head: CodexHeadActionProjection
  lifecycle: LifecycleOperationProjectionV2
}

type LifecycleActionRequestRef =
  | {
      ownerKind: 'run_owner'
      action: 'stop' | 'reset' | 'close'
      aliasId: string
      scopeId: string
      scopeEpoch: number
      aliasGeneration: number
      targetReadyRunId: string
      lifecycleEvidenceDigest: string
      headProjectionDigest: string
      digest: string
    }
  | {
      ownerKind: 'head_owner'
      action: 'reset' | 'close' | 'manual_compact'
      aliasId: string
      scopeId: string
      scopeEpoch: number
      aliasGeneration: number
      threadBindingId: string
      headRevision: number
      materializationIntentRef: { id: string; digest: string } | null
      lifecycleEvidenceDigest: string
      headProjectionDigest: string
      digest: string
    }

type LifecycleActionGate =
  | { availability: 'ready'; blockers: []; requestRef: LifecycleActionRequestRef }
  | {
      availability: 'blocked' | 'not_applicable'
      blockers: [LifecycleActionBlockingReason, ...LifecycleActionBlockingReason[]]
      requestRef: null
    }

type LifecycleOperationProjectionV2 = LifecycleOperationProjection & {
  contractVersion: 'ready_lifecycle_operation_projection_v2'
  scopeId: string
  scopeEpoch: number
  headProjectionRef: { version: ActionProjectionVersion; digest: string }
  actions: {
    stop: LifecycleActionGate
    reset: LifecycleActionGate
    close: LifecycleActionGate
    manual_compact: LifecycleActionGate
  }
  evidenceDigest: string
}
```

V2是现有projection的严格superset，必须保留并等值投影现有`identity, activeReadyRunId, latestReadyRunId, interruptRequested, interruptAcknowledged, requestedAction, snapshot`等字段；schema/IPC/upgrade tests用exact-key fixture锁定。变化只在于按钮决定迁到`actions` gates，旧字段继续服务状态、身份与恢复说明，不能再被Renderer或Main拿来第二次推导动作。

四个gate各自冻结真正owner：stop只能是exact active `run_owner`；reset/close在存在需interrupt的active turn时也是run owner，在idle/pristine、无run pending或unknown native-fork/fresh-root、e1 head时必须是`head_owner`，冻结exact binding/generation/revision/materialization-intent/epoch；manual compact只允许ready nonlegacy `head_owner`。不得伪造source/latest run，也不得回到`activeReadyRunId || latestReadyRunId`或统一nullable run id。Renderer原样提交相应`requestRef`，Main用同一projector重算全对象/摘要等值后，run owner走现有run transaction，head owner走最小binding/head CAS；ready gate若action literal或owner shape不匹配其字段即schema reject。repository tests覆盖无run pending fork、fresh-root seed、pristine head、e1 head与active run。

head/per-run成对结果由同一个纯 reducer在同一事实快照上生成，不持久化。每个动作独立表达可用性与零到多个阻断原因；不得再同时维护 `canSendNewMessage`、`availableActions[]`、单值 `retryAction/blockingReason` 等可互相打架的镜像。Renderer/Main普通发送只读 `head.actions.send_new_message`，某失败轮Retry只读该run的 `productTurn.retry_failed_task`；两者用 `headProjectionRef`证明基于同一head事实，但不复制动作。生命周期控件与Main reset/stop/close/manual-compact入口只读envelope中的V2 lifecycle gates；`snapshot/requestedAction`只作状态说明，禁止再映射按钮。Renderer只有在lifecycle的`scopeEpoch/headProjectionRef`与envelope head exact相等时才组合显示；不等时保守隐藏send并触发atomic hydration，不能把旧stop/reset状态和新send状态拼在一起。Main各动作入口对同一shared lifecycle projector重算gate并做owner CAS，envelope不变成新动作owner。

机器不变量由同一projector、validator、boot hydration与action click入口复用：head/retry `availability='ready'`当且仅当`blockers=[]`，`blocked|not_applicable`当且仅当`blockers`非空；lifecycle ready还必须有action-matched nonnull requestRef，非ready必须requestRef=null。`retry_failed_task.consequence`恒为`null`；`send_new_message.consequence=null`当且仅当`omittedItemCount=0`，否则该单值对象的counts/itemsDigest与该次projection使用的同一tail resolution完全相等。`CODEX_ACTION_BLOCKER_PRECEDENCE`与`LIFECYCLE_ACTION_BLOCKER_PRECEDENCE`分别是覆盖各自有限reason union全部literal的唯一tuple；projector按tuple顺序去重输出，validator拒绝unknown、duplicate或out-of-order blocker，新增reason未进入tuple时结构/类型gate失败。加入source fact/SQL返回顺序全排列仍得到同一blockers/digest的测试。Renderer不得补默认值或重判。

最小确定映射（send来自head projection，retry来自所选terminal run projection）：

| 当前 owner facts | send | retry |
| --- | --- | --- |
| divergent target满足readiness（native-fork child exact ready；或fresh-root ready-for-ingress），selected origin未coverage且是seed内single eligible item，失败run零执行/交互/resource阻断 | ready | ready |
| same_thread_ready，或origin已在accepted/manual/automatic-compacted coverage | ready | not applicable：完整重述 required |
| history ready，失败run存在任一tool/action/interaction answer/effect/legacy或证据不全 | ready | not applicable：完整重述 required |
| history ready，旧资源必须重新附加 | ready；显示“重新附资源并完整重述”consequence | not applicable：resource restatement required |
| history ready，旧资源漂移或任一tool/action/interaction/effect证据存在 | ready；显示完整重述/重新附资源consequence | not applicable：完整重述 required |
| projection未读取当前skill hint/candidate；click时发现relevant hint、显式skill选择或source ceiling外能力 | ready | Main preflight not applicable：保留composer并完整重述；零run/Provider bytes |
| fresh-root seed等待首个 ingress冻结合同 | ready | 按pure-text/zero-execution facts求值 |
| active persisted newer user run、thread/turn-start dispatch fence | blocked：thread busy | not applicable：newer user run（终态后也不复活旧Retry） |
| manual compaction reserved/pending | blocked：manual compaction pending | blocked：manual compaction pending |
| manual compaction outcome unknown | blocked：manual compaction unknown | blocked：manual compaction unknown |
| native-fork seed/RPC 正在 materialize | blocked：history materializing | blocked：history materializing |
| fork/root-tail outcome unknown | blocked：history outcome unknown | blocked：history outcome unknown |
| terminal history unknown，原 binding blocked | blocked：terminal history unknown | blocked：terminal history unknown |
| 已知head runtime/protocol digest与当前pinned值漂移 | blocked：head contract drift | blocked：head contract drift |
| e1 prepared/pending active run或fence | blocked：legacy prepared contract | blocked：legacy prepared contract |
| started legacy head | ready | not applicable：legacy boundary |
| closed scope | not applicable | not applicable |

`send`表示新的普通 ingress，`retry`表示新 user run；二者不是旧 terminal parent的 resumable action。head projector必须直接消费现有active product/start dispatch fence、manual-compaction binding与lifecycle closed facts，`agent-send-orchestration`/composer删除平行的thread_busy/compaction推断，只显示该send gate。若历史ready但failure task本身不可重试，retry为not applicable，send不受影响。现有lifecycle projection独立扩展读取materialization/history/e1状态：history/materialization unknown与e1 pending时只允许reset/close，active run/fence或manual compaction时仍由原transaction owner执行stop/reset/abandon，closed scope不提供动作；started legacy head可ordinary continuation/reset/close，但`manual_compact=not_applicable/legacy_context_boundary`，避免缺Ready-message mapping的旧历史被压缩后才变unknown。ChatHeader/useAgent与`classifyLifecycleOperation` tests证明它是reset/stop/close/manual compact唯一真值。组合状态用table-driven tests覆盖。

若当前 head仍含 structured live uncommitted items，普通 `send_new_message`可以保持 ready，但必须携带单值 `supersedes_uncommitted_structured_tail` consequence及同一 classifier产出的 omitted/resource-reattach counts。canonical projector强制两者均为nonnegative safe integer、`0 <= resourceReattachItemCount <= omittedItemCount`；omitted=0时`consequence=null`，omitted>0时必须是该对象。`itemsDigest`精确覆盖按序被omit的structured `{messageId,digest,policy}`集合。UI在count=1显示“上一项…”，count>1显示“前面N项不会作为当前任务带入；如仍需要，请完整重述”；resource count非零再显示“其中N项需重新附加资源”。head不抄某个失败run的Retry gate，只有per-run gate真ready时按钮旁才提示“先重试”。普通点击提交§8.1 `actionAdmissionRef`；Main复核head/version/counts/items/consequence digest。成功后e2 ingress、supersession refs与user/run同事务写入；不得改写旧seed assignment。1项/多项/resource子集/点击前集合变化都必须走真实`ChatPanel`测试。

explicit Retry不承担多任务选择：除selected origin外若还存在任一structured live item，`retry_failed_task`必须`not_applicable/multiple_uncommitted_structured_items`。只有direct divergent child中“selected未coverage、非resource/task-restatement、zero-execution/interaction + 其余live全是可deliver更早untrusted text”时Retry才ready；因此admission不静默supersede/永久omit其他structured items，也不新增任务队列或第二按钮。

消费约束：

- terminal parent 仍是已结束 run，`taskProjection.resumableActions=['none']`、`continuation_ref=NULL`；explicit retry 是新 user run，不能把任务 retry 冒充旧 run 续跑。
- post-persistence terminal `SendScopedResponse.retryableByUser` 保持 false；该字段只表达能否重放一条**尚未持久化**的传输，不表达任务 Retry。
- Retry 控件只在 per-run `retry_failed_task.availability==='ready'` 且其headRef等于当前head时出现。旧资源、工具/action、交互答案、effect或legacy evidence任一存在时Retry为not applicable，用户只能完整ordinary重述并按需重新附资源；点击Retry只提交predecessor run/presentation digest，Main再按最新facts/head/receipts及ephemeral current resource/skill capability facts原子复核。动态projection不声称当前hint/candidate/resource已安全，只开放preflight。
- `ChatMessages`删除 `terminalReason !== done` 之类的按钮推断，只按 v3 action gate渲染；`ChatPanel`点击入口不得只看 `receipt.failure`。Retry提交当前 projection/presentation digest，ordinary send提交规范 `actionAdmissionRef`；Main点击时重读current action projection，并对projection revision/action sequence、terminal-facts digest、head identity与actionAdmissionRef做exact CAS，任一漂移即stale reject。普通 send的 supersede consequence也由同一 v3 projection在 composer附近显示，不能另查 message meta。
- Renderer维护两份**只读缓存而非两份事实**：`scopeHeadActionProjectionByScopeId`消费独立head read/event，只供composer首条/普通发送；`productTurnActionProjectionByRunId`由v3 receipts填充，供旧failure Retry。hydration只读取current/loaded scopeIds的head（即使该scope零run），不会在boot扫描全库未加载active scopes；per-run也只批量读取当前已加载消息的terminalRunIds，切scope/分页再按需读取。事件按其scope id更新已加载cache，未加载scope等用户打开再read。`ChatMessages`按message.runId读per-run gate，composer只读scope head gate；现有lifecycle projection负责reset/close/epoch切换并触发这两map清理。不得写回 `chat_messages`/message meta，也不得只复用会在active requestId变化时丢旧receipt的 `ScopeRunState`。
- 两条事件可能独立丢失：complete分支只有在per-run `headProjectionRef.version+digest`与当前scope head projection exact相等时才显示/点击Retry；不等立即隐藏/blocked并触发该run receipt + head projection hydration，不能继续展示旧ready按钮。`unavailable_legacy`因refs显式null而直接稳定隐藏Retry，不触发B/memory/environment hydration循环。只收到head advance、per-run refresh丢失时必须有行为测试；Main admission仍做最终CAS。
- 普通输入只受history head是否ready与当前head fence约束。旧tool/action/effect evidence不阻止新问题，但一律关闭exact Retry；完整ordinary重述是新命令，只按当前资源/授权/行动确认执行，不自动复用或重放旧receipt。
- `historyState=fresh_root_ready_for_ingress` 时普通 send 或 exact Retry 正是启动 current-ingress prepare 与同 run start owner 的合法入口，不能被 materialization gate挡住；`materializing` 只表示 native-fork RPC 尚未 exact bind，此时保留待发输入但不得持久化。`materialization_unknown/terminal_unknown/closed` 时 pre-persistence reject并保留 composer。

## 7. 核心合同 B：native history disposition

### 7.1 `continue_same_thread`

只有同时满足以下证据才可继续旧 thread：

- native terminal 为 completed/failed/interrupted 中已知的一种，且没有 `inProgress` turn；
- `thread/read(includeTurns=true)` 能精确定位本轮 turn；
- failure seam命中 Stage 0对 pinned runtime实测锁定的 `continuation_safe` allowlist；每个 allowlist entry除 Gateway wire facts、final native terminal/status、publication facts与 protocol phase外，还必须绑定 `failed_user_retention='prior_user_exact_once'` 的 probe receipt：下一轮真实 Provider capture中失败 B作为 prior user恰好一次，且 B之后无不安全 assistant/tool suffix；
- 本失败run的e2 formal model-input mapping必须恰好只有一个current user origin；只要本轮曾交付任一`ready-uncommitted-user-tail` item、存在多个formal origins或additional tail，便不得套用single-user seam probe，直接判`diverged_uncommitted_tail_failure`；
- source thread 的 runtime、protocol、model/provider、tool surface、instruction contract 与当前 active binding 一致；
- 没有 reset、close 或显式清空可见历史的 lifecycle action。

典型适用是formal mapping只有本轮current user、经probe证明该user仍保留且无不安全assistant/tool suffix的连接前失败或无 item Provider failure。产品层写失败消息，但该消息是 Ready的产品说明，不注入 native model history。下一条普通消息仍对同一 `threadId`调用 `turn/start`。

`thread/read` 的 items是有损投影，只能证明 thread/turn identity、terminal status、无 inProgress与可 resume；不得根据“readback中没看到某 item”推导 raw model history不存在隐藏尾部，也不能替代 next-provider wire capture证明 failed user retention。某 seam若 B不可见，即使 assistant/tool tail为空也必须归为 `diverged_missing_user_half_turn`，走 accepted-prefix fork + per-item uncommitted tail。任何带delivered tail的turn失败都按上一条直接diverge：accepted-prefix fork后，live reducer从本轮formal mapping把所有未coverage、未supersede的B/C按序carry一次，control R仍为零；不拿只证明current C retention的probe替整组origin背书。任何其他不在 pinned-runtime allowlist的 seam一律 fork accepted prefix，cutoff/seed不可证明时required。

history safety 与执行活动完全正交。旧turn存在tool/action/effect不会把native history判成不安全，也不阻止用户提出普通新问题；它只让该旧任务的exact Retry不可用，旧receipt不进入新run。

### 7.2 accepted native prefix head

新增唯一 `resolveAcceptedNativePrefixHead` reducer；fork cutoff、live-uncommitted reducer、boot readback和测试都消费它，不各自查“最近成功 run”。输出是 `accepted(head + coverage) | proven_native_first_turn_no_prefix | unknown`。accepted同时包含 `acceptedNativeTurnId`、最近的 `acceptedProductReadyRunId: string|null`与 immutable `acceptedNativeCoverageReceiptRef`；compaction-only head允许product run为null。coverage receipt只保存 native turn/compaction identities及其精确覆盖的 Ready user `{messageId,digest}` refs，不保存或猜测 summary正文；它是判断某 item是否已进入 accepted native prefix的唯一边界。

coverage不是每次复制一份越来越大的全量数组，而是同一 `coverageLineage` 的增量不可变链：`parentCoverageReceiptRef + newlyCovered[{messageId,digest}] + acceptedNativeHeadIdentity + producerIdentity + digest`。持久位置固定为单一 append-only `codex_native_coverage_receipts`表，包含全局receipt id、source/current binding、parent ref、`producerKind='product_closeout'|'automatic_compaction'|'manual_compaction'`及对应owner id、native head、newly-covered JSON/digest；只有 binding repository 的 `appendAcceptedNativeCoverageReceipt`能写。turn/manual binding只保存typed receipt ref，不复制coverage正文。同一 binding内正常续接parent；跨 binding只允许 exact direct `native_fork` successor的第一条 coverage，以 target seed冻结的 source `acceptedNativeCoverageReceiptRef`为parent，并同时核验 alias/scope/epoch、generation+1、source terminal facts与fork boundary。`fresh_start/fresh_root_with_tail`从 parent=null开始。除此之外任意跨 binding/source引用都拒绝。同一 message第一次被覆盖时写一次，重复、回退、无seed跨代或同一 native head给出不同覆盖均拒绝；reducer与boot/archive核验整条 lineage，source归档不得删除链，内存缓存只能加速，不能成为另一份真值。product/automatic closeout事务与manual consume/readback事务都只调用该唯一writer；target seed只引用 parent receipt，不能成为第三个写者。

1. 一个位于**nonlegacy完整合同binding**、且未发生automatic compaction的product turn，只有同时满足 native engine completed、candidate accepted、product done、candidate/canonical body digest相等、publication accepted、所需 verifier/QC accepted，才以`producerKind='product_closeout'`写恰好一条receipt并把head推进到该 `codex_turn_id`；其coverage由该turn真实Provider/history capture、e2 formal model-input mapping与已映射native prefix生成，因此可以覆盖更早retention-safe failed user item，但每个message必须exact-once映射。explicit Retry只映射selected predecessor B，control audit R永不进入coverage。started legacy binding即使本轮新e2产品成功也走下述保守分支，不得用这一个turn补造缺失的历史parent。
2. 已成功 consume并 readback的 manual compaction若发生在当前 head之后，可把 head推进到 `codex_manual_compaction_bindings.codex_compaction_turn_id`；coverage只来自 frozen `preDispatchTurnIds`、binding/readback与每个turn的e2 formal model-input mapping，禁止直接按`ready_user_message_id`或UI row映射。A accepted -> failed B retained -> compact M时，M coverage可以包含 B；Retry(B)+control R -> compact M时也只覆盖B、永不覆盖R。映射缺失、多义或 digest不符则 reducer返回 unknown/reset-required，不能读 summary猜。
3. nonlegacy product turn内的automatic compaction与第1项互斥：若同一product turn最终accepted，只以`producerKind='automatic_compaction'`写**一条**receipt。`effectiveCandidate`严格等于exact automatic-compaction input/turn mapping所覆盖的全部Ready origins与本轮formal model inputs的有序并集，`newlyCovered = effectiveCandidate - parentEffectiveCoverage`；这样既不重复写parent已覆盖项，也能纳入compaction真正吸收、此前尚未coverage的retention-safe failed B。该receipt在同一closeout事务以compaction后的native head推进；禁止先写`product_closeout`再写`automatic_compaction`，也禁止同一terminal产生两个Ready history head/两次sequence。若compaction已写native history但同turn随后failed/disconnected/QC rejected，Stage 0必须实测它是否产生可被 `thread/fork(lastTurnId)`单独选择的terminal cutoff：可证明时由`producerKind='automatic_compaction'`单独追加coverage/head；不可隔离时，不得借失败turn推进，也不得按普通tail猜，真实divergence直接`unknown_reset_required`。continuation-safe same-thread仍只按§7.1 seam probe决定。legacy binding上的automatic compaction只属于native history，不生成Ready coverage/head authority，后续一旦需要fork仍reset-required。
4. 除第3项probe证明可单独fork的automatic-compaction cutoff外，failed、error、cancelled、interrupted、QC rejected、failure-copy-only closeout和只有 publication seal 的 turn都不推进。

成功推进coverage的nonlegacy product/automatic closeout沿现有terminal事务递增一次sequence；manual compaction reservation先+1使send blocked，success+coverage、proven-absent、unknown或abandon各自在自己的settle事务再+1，success与coverage同事务只加一次，重复readback/幂等重放不增。started legacy上的新e2 turn可正常product done并发布正文、按product terminal只增一次sequence，但明确零coverage writer/head推进；binding持续`legacy_context_boundary`，普通下一轮仍可沿同一native thread，任何后续divergence都`unknown_reset_required`。coverage只回答“该user item是否已在accepted native history”，不回答任务是否完成：A accepted -> B failed -> manual compact M后，B从live tail释放但任务仍失败且Retry不可用，用户ordinary完整重述。不得把B既留在compacted prefix又再次作为tail，也不得因coverage包含B就呈现为已回答。

`proven_native_first_turn_no_prefix` 只在新合同 source上成立：Ready DB中该 source只有当前 divergent `codex_turn_binding`、零先前 product/compaction binding，native turn list也证明当前 turn是第一 turn且无早期 compaction/history。任一 legacy row、分页/rollout不完整或双边证据不一致都返回 unknown，绝不能因为“selector返回 null”就当首轮。

failed、error、cancelled、interrupted、QC rejected、failure-copy-only closeout本身不推进 head，但它们的 user item可在后续 accepted product turn或 verified compaction的 coverage receipt中成为 history committed。`thread/fork.lastTurnId`使用 reducer最终 native turn id；tail selector以 coverage差集为准，不再只从 `acceptedProductReadyRunId`后盲选。A accepted -> failed B -> compact M -> divergent C必须 fork through M，B只来自 compacted native prefix，Ready tail不得再注入。

### 7.3 `fork_accepted_prefix`

只有存在真实 history divergence 且已找到 accepted boundary 时使用：

- partial assistant、QC/Browser verifier 拒绝 completed candidate、protocol/item ordering 失配，或 native history 中存在 Ready 未发布尾部；
- accepted boundary 必须等于同一 source thread 的 `resolveAcceptedNativePrefixHead` 输出；
- 被拒 turn、provisional/commentary、Ready failure copy 和不确定 tool result 全部位于 boundary 之后；
- fork source、boundary、target generation、runtime/protocol/model/tool/instruction digests 在 dispatch 前冻结；
- source/target的 `nativeInheritedContractDigest`必须完全相等；fork后合法变化的 target cwd与每轮 upstream/执行事实分别由 materialization/per-turn合同冻结，workspace-root策略由 pinned probe证明，不能混入 inherited equality或假装可逐 child读取；
- 同 scope/epoch/source lineage已持久化、但不在 `acceptedNativeCoverageReceiptRef`中的 user messages，形成一个有界、按序的 `uncommitted_user_tail`；product boundary只用于审计定位，不能覆盖 coverage差集。

执行使用 pinned runtime 的原生：

```text
thread/fork({
  threadId: sourceCodexThreadId,
  lastTurnId: acceptedNativePrefixHead,
  cwd: targetCwd,
  model: exactSourceModel,
  modelProvider: exactSourceProvider,
  approvalPolicy: 'never',
  sandbox: 'read-only'
})
```

必须把三类合同拆开，禁止为了“一个大 digest”把允许变化、无法观测和真正继承的事实混在一起：

| 合同 | 只覆盖 | producer / 正式消费者 |
| --- | --- | --- |
| `nativeInheritedContractDigest` | pinned runtime manifest/protocol/history mode、native model/provider、被 pinned probe证明 thread-sticky 的 canonical `threadConfig`（包括 source start receipt中存在的 context-window字段）、base/developer/root instructions、model-visible tool definitions、固定安全 policy class | source thread-start receipt + generated schema + pinned binary probe生产；fork admission做 source equality，client allowlist、可见 Gateway body子集和resume parity分别消费 |
| `materializationRequestDigest` | method、source/cutoff、target cwd、exact fork allowlist中的 model/provider/sandbox/approval、connection/rpc identity；response后绑定 runtime实际返回的 target cwd与 effective settings | durable materialization reservation生产；RPC response、boot discovery与archive owner消费 |
| existing per-turn Ready contract digest | 当前 upstream route/profile/credential snapshot、reasoning/service tier、resource/skill/tool/action authorization、output contract、untrusted additionalContext与current input | current ingress prepare生产；Gateway、tool execution、closeout与同 run boot recovery消费 |

target cwd可以按正式 fork请求合法不同于 source；upstream route/profile/credential、reasoning和service tier本来就按 turn重新冻结。它们不得成为 source/child inherited equality，也不得因为 Gateway当轮看到了就反向改写 native inherited合同。pinned schema不暴露 `runtimeWorkspaceRoots`，因此 workspace-root行为只能由 exact fork allowlist（禁止覆盖）+ target cwd + pinned blackbox policy receipt证明；未来若 runtime新增正式可观测字段，再独立纳入合同。

client validator 使用上述 fork exact allowlist并本地拒绝 `dynamicTools`、`developerInstructions`、`baseInstructions`、`config`、`runtimeWorkspaceRoots`、`threadSource` 和任意未知字段；这些 thread-level事实必须从 source继承，不能用 fork override。实测不传 `threadSource` 时 child自然保持 `source='vscode' && threadSource=null`；显式传入反而破坏现有 root合同。

`ThreadForkResponse/ThreadResumeResponse`核验其 top-level完整 effective settings；`thread/started`与 `thread/read`只核验 `Thread`真实暴露的 identity/status/cwd/path/modelProvider/turns等字段，不能用斜杠并列成它们也能看到 model/sandbox/approval，更不能假装读到 tools/instructions/context window/workspace roots。child首个 Gateway request在上游 bytes前只核验它真实看到的 body/metadata：model/provider、model-visible tools、instructions、sandbox metadata与当前 per-turn upstream snapshot；不符则零上游 bytes并进入 reset-required。context window与 workspace-root策略由 source start receipt + exact client allowlist + pinned binary probe证明，target cwd由 materialization response验证。kill/resume后分别重做 resume effective-settings parity、可见 inherited子集和当前 per-turn合同核验，禁止再把三者合成不可实现的全量 attestation。

fork仍拥有完整 accepted模型历史；Ready只补 native fork无法表达的半轮事实。新增唯一纯 `classifyUncommittedOriginPolicy`，只读该origin immutable ingress/resource facts与closeout前已settled的tool/action/interaction facts，不读自然语言、不落另一份分类。divergent seed builder冻结其逐item输出；same-thread per-run action projector、Main admission、boot/live reducer调用同一函数并按input digest等值复算。没有target seed的same-thread failure因此也不会在重启后丢失或另判策略。seed对tail逐item冻结以下policy，不能因一项带资源把其他项整体降级：

- `untrusted_text_history`：**该 item/origin message**为纯文本，且其来源run没有绑定tool/action/Browser产品动作、interaction answer、typed resource、skill/mention、非文本input、non-empty `actionObligations.requirements`、explicit action grant或output contract；Prepared run中的`browserPageRef/currentDocumentAnchor/externalReadSlice`必须为null，`productSurfaceTargets/resourceAuthorities/resourceAdditionalContext`必须为空，`readyMemorySnapshot`的**model-visible payload**必须为空（不是要求snapshot对象不存在）。常驻的 `actionAuthorizationMode`（包括默认`ask`）与普通per-turn allow-set不参与eligibility；它们只约束当前C执行，否则semantic bridge会因每轮都有该字段而永远不可达。
- `resource_restatement_required`：**该 item/origin message**依赖旧资源/路径/当前文档权限、包含任一非文本input，或上述`browserPageRef/productSurfaceTargets/externalReadSlice/currentDocumentAnchor/resourceAuthorities/resourceAdditionalContext`任一非空；旧task不可直接Retry，用户必须重新附资源或重新选择当前对象，并完整重述为ordinary ingress。本阶段不假设图片、文件、页面、RSS/calendar/widget目标或文档anchor能由message正文重建。
- `task_restatement_required`：该origin带skill/mention、non-empty action obligation、explicit action grant或output contract、non-empty model-visible Ready memory payload，或已产生任一tool/action/Browser产品动作、已提交clarification/confirmation answer、执行证据不完整；不桥接旧skill/tool result/answer/授权/输出义务/memory receipt，也不开放Retry，只允许ordinary完整重述并重新选择所需能力。

每个新ordinary e2 prepared contract必须冻结`trustedWorkbenchMode`，来源只能是Main `resolveTrustedRequestEnvironment`，不能直接信任Renderer meta。source mode为`rss|calendar`时，即使其余resource/target字段为空，也固定`resource_restatement_required`，因为这些mode会增加隐式capture/read floor；`browser|document`只有在上述page/document/target字段全空时才可能是untrusted text。该classifier优先级固定为resource-restatement > task-restatement > untrusted-text；带资源/非文本时优先保留“重新附加”的用户后果。不得因同一tail另一项带资源而整体降级，也不得把其他run常驻授权模式并入。本阶段不保留“结构化旧请求可直接重试”的第四分支。

TurnInputBuilder不读取“整 tail policy”，只读取本 run冻结的 per-item assignment：按原顺序选出全部且仅有 `deliver_untrusted_history`的 items，放入按交付序号命名的 typed `additionalContext['ready-uncommitted-user-tail:N']`并固定使用 runtime已证明的 `kind:'untrusted'`；`replace_with_explicit_retry`的 selected origin只作为当前 active input；`omit_from_current_run` items产生零 Provider context/input bytes。真实 Provider request中 deliver子集必须保持为位于当前 C **之前**的历史 user messages；ordinary `params.input`仍只包含当前用户 C，C必须是最后一条 current user message。禁止使用 `kind:'application'`，因为 pinned 0.149会把它提升成 developer message；也禁止 prepend到当前 active input。相同 origin message按 id/digest去重。

该 key由 `codex-model-gateway-contract.ts`的正式 current-context parser消费。绑定读取先通过既有 runtime reader校验 immutable prepared contract，再由与 TurnInputBuilder相同的纯 producer从 frozen ingress + per-item assignments派生本轮 `deliveredUserTail`；这是非持久 binding字段，不新建 DB字段或第二份账本。parser只穿过这组按原顺序交付的 exact payload，并核对 indexed key、origin message id、input/input digest、count/order及 native envelope。pinned 0.149.0把 application context排在 untrusted context前，后者必须是 `<external_ready-uncommitted-user-tail:N>`包裹的 user/message + 单一 input_text，只有 native可选 id以及 type/role/content/text字段；缺失、重复、篡改、未知字段或part、角色提升、边界夹杂、最后 tail伪装 current user均在上游 bytes前拒绝，不能跳过未知 user块。selected replace item与 control R不进入这组尾项。

已有持久 `additionalContextDigest`继续只覆盖 resource/retry/memory，**不包含 tail**；tail属于原有 immutable prepared/assignment/turn合同，并由 Gateway独立精确核验，旧 e2回执不迁移、不改变 digest语义。Gateway只在 product binding validation计算一次 current context与 memory/user边界，request receipt准备与 memory-history redaction消费同一结果；automatic/manual compaction没有当前 product尾项与memory边界，不能把历史 last user当成本轮重新核验。tail不进入 immutable instruction transcript digest或 native inherited contract digest，否则历史 user message会被错误升级成 instruction事实。

policy为 `resource_restatement_required/task_restatement_required`的items在ordinary assignment中计划为 `omit_from_current_run`，产生零Provider bytes；它们是否停止后继carry只由同一ordinary ingress事务写入的immutable supersession refs决定，assignment本身无权改变live状态。action projection允许新普通消息并显示中性完整重述/resource consequence；只有纯文本 `untrusted_text_history` 且§9.2零执行/交互证据的single selected origin可走Retry。无论历史纯文本B写了什么，intent/task、resource envelope、skill/tool/action authorization与output obligations都只读当前ingress/explicit-retry root。反例B=`删除目录 X`、C=`现在几点`时，若B从未产生执行/交互，它可作为untrusted历史user message但不能签发C权限；若B已有任何tool/action/answer receipt则policy必须task-restatement且零Provider history bytes。

Stage 0 是硬门：必须从真实 Provider request capture证明 B以 untrusted user role位于 C之前、C是最后一条 current user message，prompt-injection文本不能进入 developer/root instruction digest，并证明 child后续 D仍能理解 B且没有重复持久化。若 pinned runtime不能同时保持 role、order与后续语义，整个 ordinary-tail bridge保持 disabled并停止 Stage 3；不得回退到 application、prepend、摘要或自然语言分类器。

这不是用 Ready 重建完整历史：accepted conversation 仍只来自 native fork，Ready 只桥接产品已经持久化而 turn 粒度 fork 无法单独保留的 user half-turn。`lastTurnId` 只能截断 suffix，不能删除 prefix 中间项；因此 A success -> B safe failure -> C success -> D divergence 时，fork through C 必然保留 B，计划不得为了删 B 改成 Ready history重建。tail 超过 frozen context budget 时必须 `context_recovery_required`，不得做 lossy summary。

不得把 ThreadItems、ProductTurnReceipt summary 或 session recall 拼入 prompt，也不得调用 deprecated rollback/revert 修改 source thread。

### 7.4 accepted prefix 为空

只有 reducer 返回 `proven_native_first_turn_no_prefix` 时，successor 才可使用 `fresh_root_with_tail` materialization：创建 clean native root，并把有界 exact tail按其 policy交给首个 child run。explicit retry把失败 task root作为当前 active input恰好一次；ordinary input保持自己为唯一 active input。代码不需要、也不得猜当前自然语言是否“依赖旧上下文”。

只有 tail 身份/内容 digest 不唯一、超预算或资源安全边界无法证明时才 `context_recovery_required`。用户明确 reset 时创建 `fresh_start` 且 tail 为空；close 后的新自然会话创建新 scope，不是旧 alias successor。

### 7.5 `context_recovery_required`

以下任一事实不明时，在 Provider 请求和用户消息消费前阻断：

- failed turn 是否含未发布尾部不明；
- accepted boundary 不唯一或 digest 漂移；
- fork child 已可能创建但无法唯一对账；
- source 已归档，runtime 明确拒绝 fork；
- runtime/protocol/model-visible tool/root-instruction digest不相等；
- failure seam 不在 pinned-runtime safe allowlist，且 strict accepted prefix/tail 也无法证明。

若 immutable terminal facts是 `history.unknown_reset_required`，只允许 reset/close，不存在后续 history reconciliation。若 seed已经成立而只是 fork materialization outcome unknown，现有 materialization owner可继续后台对账，用户可以等待、reset或close；不得重发 fork。资源/非文本origin要求重新附加并完整重述，task-restatement origin要求完整重述；只有纯文本untrusted origin可进入§9.2 Retry gate。任何分支都不得自动开无 tail的 root、生成摘要或调用 session search。

### 7.6 lifecycle matrix

| 场景 | history disposition | 是否继承旧资源/权限 | 说明 |
| --- | --- | ---: | --- |
| 无 partial/tool 的 Provider/transport failure | `continue_same_thread`，须 readback | 否 | 不再 blanket retire |
| partial assistant / protocol divergence | `fork_accepted_prefix` | 否 | 截断本次 boundary 后的 divergent suffix |
| QC/Browser verifier 拒绝 native final | `fork_accepted_prefix` | 否 | 被拒正文不得进入 child |
| 用户 stop | readback 安全则 same thread，否则 fork accepted prefix | 否 | stop 不等于 reset |
| 任一tool/action/interaction/effect证据 | history仍按native parity；exact Retry不可用 | 否 | 普通新问题/完整重述按当前授权继续，旧receipt不复用 |
| 首轮 divergence、无 accepted prefix | `fresh_root_with_tail`；证据不全才 required | 否 | exact user half-turn 恰好消费一次 |
| runtime/protocol/model-visible tool/root instruction变化 | `context_recovery_required/reset` | 否 | fork override 实测无效，不宣称全量连续性 |
| automatic compaction；完整新合同head上的manual compaction | 同一 thread | 不适用 | native runtime 独占；legacy head不开放manual compact |
| user reset | `fresh_start` | 否 | epoch 前进，旧 history 派生为零 |
| close | `no_successor` | 否 | 不创建 generation |

## 8. 核心合同 C：fork 复用现有 materialization transaction

### 8.1 不建第二套状态机

Ready 已有 `thread_start_*` reservation、dispatch intent、child-write confirmation、response、reconciliation、late-response guard 和 boot recovery。fork 必须作为同一套“native thread materialization”的第二种 method 接入；不新建 ForkManager、HistoryRepository、ContinuityStateMachine 或独立 fork 账本。

为了让 intent 在 RPC 前可恢复，本计划固定选择以下 schema，不保留“列或 JSON 二选一”的实现分叉：

- `thread_materialization_kind`: `legacy | fresh_start | native_fork | fresh_root_with_tail`；
- `history_source_thread_binding_id`；
- `history_source_terminal_facts_digest`；
- `fork_accepted_through_codex_turn_id`；
- `accepted_product_boundary_ready_run_id`；
- `accepted_native_coverage_receipt_id/digest`；
- `uncommitted_user_tail_json`：严格有序数组，每项仅 `{messageId,digest,policy}`，其中 policy为 `untrusted_text_history | resource_restatement_required | task_restatement_required`；
- `native_inherited_contract_digest`：native fork在 closeout复制 source inherited subset digest；fresh root/start在首个 ingress prepare从正式 start snapshot冻结；
- `thread_materialization_effective_settings_receipt_json/digest`：discriminated `response_evidence | resume_reconciliation_evidence`。response分支绑定并拥有exact start/fork RPC response正文；resume分支只存 `resumeEvidenceRef={id,digest,connectionEpoch}` + canonical effectiveSettingsDigest，完整 `ThreadResumeResponse`只由现有 `codex_thread_resume_evidence` row拥有。两分支经同一resolver/validator得到 cwd、model、modelProvider、approvalPolicy、approvalsReviewer、sandbox、reasoningEffort、serviceTier、instructionSources与thread identity；唯一writer只允许null->一条canonical receipt，相同digest迟到response幂等，缺ref/篡改/冲突则outcome unknown；
- `history_seed_digest`；
- `history_seed_assigned_to_run_id`：nullable，首个 admission CAS 写入但不等于 native 已消费；
- `history_seed_assignment_items_json/digest`：nullable，与 assigned run同事务写入；每个 tail item恰有一个本轮 plan：`deliver_untrusted_history | replace_with_explicit_retry | omit_from_current_run`。

本阶段把 prepared/ingress合同一次性升级为 exact-key `codex_product_run_e2` union并删除 `recoveredContextDigest`：ordinary分支必须有规范化 `actionAdmissionRef`与`supersededUncommittedItems[]`；explicit-retry分支必须有指向**当前最新失败run**的`predecessorPresentationRef`、由上一段Main strict validator签发且digest覆盖完整control-only raw envelope的`controlAuditMessageRef={messageId,digest}`、永远指向**最初ordinary e2 root-origin prepared contract**的稳定`modelVisibleRootOriginRef={sourceReadyRunId,sourceIngressContractDigest,rootOriginMessageId,messageDigest,taskRootInputDigest}`，以及每轮绑定**当前direct successor seed**的`selectedHistorySeedItemRef={threadBindingId,historySeedDigest,messageId,messageDigest,itemPolicy}`；禁止actionAdmissionRef且superseded固定显式`[]`。TurnInputBuilder只通过root ref解出exact `taskRootInput`，重算digest并证明它是纯文本origin：除skill/mention/resource/nontext/action obligation/grant/output contract均为空外，`browserPageRef/currentDocumentAnchor/externalReadSlice`必须null，`productSurfaceTargets/resourceAuthorities/resourceAdditionalContext`必须空，source prepared contract的model-visible Ready memory payload必须空；它不从control message或展示正文猜task root，也不恢复predecessor skill/tool/resource/ambient target/memory floor。selected seed ref必须是current head的single live/uncovered `untrusted_text_history` item，message/digest与stable root一致，且seed的owner terminal/head与当前direct-successor关系exact。Retry当前pre-persistence prepare还必须证明**当前**model-visible Ready memory payload为空；非空或在点击前漂移则同一eligibility reducer返回`not_applicable/current_memory_restatement_required`，零user/run/Provider bytes，不复制或复活旧memory receipt。连续Retry时，immediate predecessor run自己的formal model-input mapping必须解回同一个root ref，predecessor chain无环且该run仍是最新可见失败；R1/S1 -> R2/S2时root ref保持相同、selected seed ref必须更新，不能把S1冒充S2，也不得把上一次control R当成新的source或root message。每轮control message R只是product-control audit，永不进入model history/live tail/coverage；Provider current input始终唯一映射最初B的上述task root。不得用optional/null/canonical empty head ref混出第三种语义。新生产路径只写/读e2；e1只走§15保守迁移门，不允许同一run双读或补默认继续。

在任何semantic prepare之前先调用唯一纯`resolveEffectiveSemanticIngress`：ordinary分支返回当前user request；explicit Retry分支只解稳定root ref返回B的exact task root。它的typed output/digest是request envelope、intent classification/map route、tool-turn candidate snapshot、action obligations、output contract/product target推导、TurnInputBuilder current input和Gateway contract的**唯一语义输入**。Retry的完整model-visible tool definitions必须与source/thread exact相等；只有per-turn execution authorization由上一段`resolveRetryCapabilityCeiling(source prepared contract, current B candidate)`求交。profile/credential、当前安全policy与资源状态仍从current scope重算，只能继续删除执行能力，不能从predecessor恢复旧选择，也不能由当前hint/安装态扩权。control R不进入任何这些消费者。删除`recoverCodexRetryLocalResourceSelections`、`recoverCodexRetrySkillSelection`及同类predecessor恢复路径，不保留fallback；Retry eligibility已经要求旧resource/skill/target/memory为空。行为gate用B=`查今天新闻`、`现在几点`和普通文本分别捕获route/tool definition digest、source execution ceiling、effective authorization与Gateway bytes，证明各消费者都读B、R零语义影响、definitions exact equality且execution集合严格是source/current交集。

普通发送请求必须携带 Renderer真正展示过的 `actionAdmissionRef={actionHeadBindingId,actionProjectionVersion,consequenceDigest,omittedItemCount,resourceReattachItemCount,itemsDigest,digest}`；没有 consequence时也携带 canonical empty counts/digest。Main在任何 user/run写入前用同一个 action projector重算并做 head/version/counts/items/digest CAS；missing、stale或不相等返回 `action_projection_confirmation_required`，零 user row、零 run、零 Provider bytes并保留 composer，Renderer刷新后让用户基于新后果再次确认发送。不得让旧客户端或另一条 send入口静默接受最新版 supersession集合。

每个新run的immutable e2 ingress含`supersededUncommittedItems[]`。每项用统一origin union：`seed_item{historySeedDigest,messageId,messageDigest}`或`same_thread_origin{originIngressDigest,sourceTurnBindingId,sourceTerminalFactsDigest,messageId,messageDigest}`，再带`policy,actionAdmissionDigest,consequenceDigest,actionHeadBindingId,preAdmissionSequence,resultingSequence,supersededByReadyRunId,digest`；不得给same-thread伪造seed。写入时binding是exact current head且CAS current=pre，成功后resulting=pre+1。后续验证successful admission、epoch未reset、ref binding/turn仍是当前coverage/materialization lineage的认证祖先（可经direct successors）且其最终sequence>=resulting；不得要求等于今天current head。ordinary `persistIngressAtomic`把head projection确认的live structured origins与新run原子写入；Retry不写未选supersession。

`codex_forked_from_id`继续只作为 native response/readback，不是 intent，也不是幂等键。SQLite合同不依赖 `PRAGMA foreign_keys`；同事务显式查询/CAS并用 CHECK/trigger保证：`native_fork/fresh_root_with_tail` 的 target generation = source + 1且 alias/scope/epoch一致；新 scope的 `fresh_start` generation=1；reset的 `fresh_start` generation=上一 generation+1且 epoch+1但 source lineage字段仍全 null；pristine contract refresh的 `fresh_start` generation=上一generation+1、epoch不变且source lineage仍全null，并要求旧head严格zero-turn/zero-message/zero-start/zero-effect；source型 materialization必须按同一 terminal facts退役、boundary属于 source且 fork-eligible；所有类型都不得有竞争 active head/seed，seed写入后不可变。

互斥规则：

- `fresh_start`：source/source facts/native boundary/product boundary/coverage ref均 null，tail必须 `[]`；只用于reset、新scope或下面具名的pristine contract refresh。`native_inherited_contract_digest`在首 ingress prepare前必须 null，并从同一 run的正式 start snapshot一次性写入，不能因没有 source而漏写未来 fork所需合同。
- `native_fork`：source、source facts、native boundary、accepted native coverage ref、native inherited contract digest均非null，tail可空或非空；`accepted_product_boundary_ready_run_id`是审计nullable：head由product accepted推进时必填，head只由verified manual/isolatable automatic compaction coverage推进且之前无product accepted时可null，并由coverage producer/head identity证明。native boundary不能因product boundary null而降级成unknown。
- `fresh_root_with_tail`：source/source facts非 null，两个 boundary与 coverage ref均 null，tail非空；native inherited/start contract digest在current ingress prepare前必须为null，随后从同一run start snapshot写一次。ordinary可用当前完整start contract；explicit Retry必须把当前准备出的runtime/protocol/model/provider/history mode/root instructions/model-visible definitions与original source thread-start contract逐项exact比较，完全相等才写，只有per-turn execution authorization按§6.3收紧。
- `legacy`：只由 migration 写给旧行；新生产路径禁止创建。
- tail为空时 assignment fields全 null；tail非空时每项 policy必须合法。
- `history_seed_digest`只覆盖 target binding、materialization kind、source binding/native id/source terminal facts、native/product boundaries、accepted native coverage ref、带 per-item policy的 tail、scope/epoch/generation；独立 `materialization_request_digest`再组合 exact RPC allowlist、target cwd与 expected `native_inherited_contract_digest`，避免 fresh root在当前 ingress前伪造未知合同。
- `history_seed_assigned_to_run_id + history_seed_assignment_items_json/digest`只有tail非空且该run在同一`persistIngressAtomic`中冻结exact per-item plan、tail context与active input digests时才可从null写一次。assignment必须按原顺序覆盖每个`{messageId,digest}`恰好一次：ordinary把untrusted计划为deliver，把resource/task-restatement计划为omit并同事务写对应supersession ref；explicit retry只在single selected-origin gate与§9.2通过时，把`selectedHistorySeedItemRef`选中的pure-text untrusted origin计划为replace，并通过稳定`modelVisibleRootOriginRef`只作为current task root一次，位于它之前的其他live items必须全是untrusted并deliver。resource/task-restatement item永远不能replace，Retry assignment不得用omit偷丢任何structured item。
- 不新增per-item resolution字段或writer。`deliveryAudit`纯派生为：immutable assignment + 现有 exact turn contract/input/context digest + turn-start child-write/response或reconciliation receipt + native identity readback；任一不齐即unknown。boot、diagnostic与测试调用同一个deriver，它不参与live/history commit，也不复制已有turn-start事实。

现有runtime/protocol等binding identity列在head创建时即为NOT NULL且受immutable trigger保护，不能在首个ingress“原地刷新”。唯一例外事务固定命名为`refreshPristineFreshStartHeadAtomic`：scope hydration/boot可主动调用，ingress preflight作最后CAS。它只接受同scope/epoch的active non-legacy `fresh_start`，且旧head必须同时满足零Codex thread/session、零thread-start reservation/request/dispatch/response/reconcile、零turn/product run、零user/assistant product message、零compaction/coverage/tail、零tool/action/interaction；事务原子退役该空head（reason=`pristine_contract_refresh`）、按current runtime/protocol immutable identity创建generation+1空`fresh_start`并把action sequence推进一次，只返回invalidation candidate，由outer owner commit后best-effort广播。任一条件不满足即`context_recovery_required/reset`，不得套用此例外。若ingress preflight先完成refresh，旧`actionAdmissionRef`按stale拒绝且零user/run/Provider bytes、composer保留；Renderer读取新projection后再提交。该事务不复制历史、不消费tail，也不能替代new-scope/reset/canonical-closeout。

`resolveLiveUncommittedTailItems`是唯一live reducer，并先要求current/source binding属于nonlegacy、可建立coverage的history authority。started legacy binding上的e2 mappings全部是product/audit-only：reducer固定返回空候选和`legacy_context_boundary`，head projection不显示tail/supersession consequence，legacy ordinary ingress固定`supersededUncommittedItems=[]`；它只把当前C交给同一native thread，不把C登记成未来可fork tail。这样“成功但无coverage”不会让已在native history中的legacy C无限积累；一旦需要fork、依赖compaction mapping或发生history divergence，直接reset-required。

nonlegacy候选集合只来自e2正式 **model-input mapping**（ordinary active user origin、seed origins、explicit Retry selected predecessor B），不是所有chat user rows。explicit Retry的control audit message R永远排除。公式为候选origin减accepted coverage、合法supersession与reset/close tombstone；assignment/deliveryAudit不作减项。下一divergent seed合并本轮formal model-input origins并按`{messageId,digest}`去重。Retry成功coverage覆盖B及delivered earlier items而不覆盖R；Retry失败再diverge时carry B一次/R零次。ordinary omit必须同事务有supersession ref；Retry有其他live structured item即not applicable，不能靠omit偷丢。

source Codex thread id、accepted product run 的正文与配置正文从现有 binding/turn 行读取，不复制成第二份；seed 只保存交接所需的身份引用并以 digest 冻结版本。

`codex_product_run_e2`两分支都有exact common key `sourceTrustedEnvironmentRef={workbenchMode,environmentDigest}`：ordinary由该run Main trusted resolver写，source digest覆盖当时冻结的ambient/resource fields；Retry通过`modelVisibleRootOriginRef.sourceIngressContractDigest`从stable ordinary root contract解出并等值验证该ref，同时另写只含requested/trusted mode pair的`currentTrustedEnvironmentRef`。缺source ref、RSS/Calendar source、current非browser/document、mode不等或source ambient refs非空都使projection unavailable；当前ambient/resource fields只由本轮唯一pre-persistence prepare要求为空并拒绝非空值，不得从control R、当前UI mode或projection反推，更不得由Renderer先删掉再冒充为空。

e2 formal model-input mapping必须显式产出`canonicalCurrentInputRef`：ordinary指当前C的message/input digests，Retry指stable root B；product-control`origin_user_message_id`可继续指UI audit R，但任何任务/语义消费者不得使用它替代canonical current input。tool runtime、Browser workflow与`agent-session-checkpoint-route`的`sourceMessageId/DurableRequestAnchor`都改读canonical ref，因此Retry冻结B、ordinary tail轮冻结C，R永不成为任务锚。ReadyMemory successful-source admission也必须先读formal mapping：只有simple ordinary“单一current origin恰等于origin_user_message_id、无delivered tail/replace/control”的run可沿现有pair逻辑取证；Retry或delivered-tail轮直接返回现有`untrusted_context`、不生成长期记忆，绝不能把R+C/B回答配对或漏掉历史origin。本阶段不为复杂多origin回答扩建memory evidence schema。

实施前用`rg`枚举全部`origin_user_message_id|sourceMessageId|canonicalCurrentInputRef`消费者并逐个标注`product_audit | semantic_current | history_mapping`；semantic consumer必须切到formal mapping，audit consumer可保留R，未知消费者阻断实现。行为测试证明Retry R/B、ordinary B+C tail时checkpoint/task anchor、tool/Browser source与ReadyMemory admission均符合上述边界。

### 8.2 seed 字段生产消费矩阵

| 字段 | producer | validator | live consumer | boot consumer | archive/cleanup consumer | stale rejection |
| --- | --- | --- | --- | --- | --- | --- |
| materialization kind | source closeout 同事务创建 target | fresh/fork/tail/legacy 互斥 CHECK + CAS | pre-persistence materializer | boot reconciler | target/source cleanup router | reset/epoch/current-head CAS |
| history source binding | source closeout | 同 alias/scope/epoch、较早 generation、已退役 | fork/root-tail preparation | child discovery/readback | source hold/release | source identity/config drift |
| source terminal facts digest | source closeout | 等于触发退役/target seed的 immutable facts | direct-successor Retry/action projection | boot lineage readback | audit/cleanup | newer/foreign source terminal |
| accepted native turn | source closeout事务持久；值只来自 strict head reducer | 属于source，且为product-accepted turn、verified manual compaction或probe证明可单独fork的automatic compaction；accepted+automatic只允许automatic这一条互斥receipt | `thread/fork` request | exact child prefix readback | archive eligibility | turn/digest/source drift、同turn双producer拒绝 |
| accepted product run（nullable audit） | source closeout事务持久；值只来自 strict boundary selector | 非null时属于source且product accepted；compaction-only head允许null并由coverage producer证明 | product审计定位，不决定tail/cutoff | boot/readback | audit/cleanup | forged null/non-null、run/product digest drift |
| accepted native coverage receipt chain | canonical closeout或manual compaction事务仅经 `appendAcceptedNativeCoverageReceipt`追加 | parent/head/producer exact；同binding续接，跨binding仅direct native-fork seed parent；`newlyCovered`首次覆盖、无重复/回退 | accepted-head、live-uncommitted、fork tail、action projector | boot折叠整条lineage并核验latest ref；cache非权威 | source/compaction archive持有链；target seed只冻parent ref | missing parent、无seed跨代、duplicate/regression、summary猜测、turn/digest/epoch drift |
| uncommitted user tail + per-item policy | nonlegacy source closeout事务持久；值只来自 canonical user selector + live reducer + typed task/resource/action fold | binding必须有完整coverage authority；coverage差集、user-only、同 scope/epoch/seed lineage、按序、有界；legacy固定audit-only/空候选 | per-item additionalContext/retry/resource-restatement consequence/assignment | pending-run/start recovery | coverage/supersession/reset/close释放live ref，audit保留 | legacy/explicit-retry去重、reset/head/source-fact CAS |
| native inherited contract digest | native-fork closeout复制 source；fresh-start/fresh-root首 ingress从正式 start snapshot写入 | generated schema + pinned probe限定的 inherited subset；禁止 per-turn/upstream/cwd混入 | fork equality、client allowlist、Gateway可见子集核验 | resume parity + 可见子集核验 | archive audit | runtime/threadConfig/tool/instruction drift |
| existing thread-start request digest（fork时即 materialization request digest） | durable materialization reservation | exact method/source/cutoff/target cwd/RPC allowlist/connection identity | dispatch/result bind | boot discovery/readback | archive/orphan cleanup | late response、different cwd/request/connection |
| materialization effective-settings receipt | response正文由现有writer；resume分支只能由`reconcileAndBindMaterializedThreadFromResumeAtomic`写typed ref | response正文exact；resume ref解析同事务existing resume row；同一canonical validator/target/request/effective digest | child bind、Gateway可见子集anchor | response丢失时list/read/resume完成后原子bind+ref | archive/orphan audit统一解ref | 多producer、缺/篡改ref、迟到response digest冲突=>quarantine/reset-required |
| resume effective settings | 每connection epoch由`reconcileAndBindMaterializedThreadFromResumeAtomic`在target临时bind后同事务插入`codex_thread_resume_evidence` | pinned `ThreadResumeResponse`字段 + pre-read/thread/request identity；parent trigger见到同事务target thread id | resume admission、下一Gateway可见子集anchor | boot resume owner | archive audit | different thread/epoch/settings digest；任一步rollback全无 |
| history seed digest | canonical seed builder | 每次读取全字段重算 | dispatch/result bind | boot reconciliation | cleanup proof | late response/CAS mismatch |
| tail assigned run + per-item assignment plan | first ingress transaction | run/scope/epoch/head、全 item覆盖、plan/policy、context+input digests exact | turn-start owner；omit只表示本 run零bytes，不改变live性 | persisted-run recovery | terminal/archive audit | second run、旧 run、遗漏/重复 item、迟到事件 |
| e2 `actionAdmissionRef` | Renderer只提交所见candidate；Main projector在 `persistIngressAtomic` 内重算/CAS/canonicalize并作为唯一持久writer | head/version + consequence counts/items/digest规范相等；empty也显式 | supersession producer、send response | e2 ingress boot audit | run/archive audit | missing/stale/different projection零写入并要求刷新确认 |
| per-run `supersededUncommittedItems[]` | ordinary `persistIngressAtomic`与user/run/sequence同事务写；Retry为空 | seed-item或same-thread-origin union exact；同scope/epoch/origin digests；CAS pre且resulting=pre+1；全覆盖 | live reducer沿认证ancestor/direct-successor lineage消费 | boot核验successful admission、未reset、ancestor sequence>=resulting | run/archive audit；reset/close后仅审计 | forged seed/direct origin、partial、回退sequence、foreign lineage/无admission |
| e2 explicit-Retry control/root/seed refs | 首次Retry从ordinary root contract生成稳定root ref；每轮run preparer更新immediate predecessor、本轮control R与current seed-item ref | root必须pure-text且source/current model-visible memory payload均空；current seed item single/live/uncovered且message映射root；seed owner terminal/head为exact direct successor；predecessor formal mapping回指同root、链无环/最新 | TurnInputBuilder解root取exact B；admission以current seed ref授权replace；Gateway核验B唯一current、各R及memory context零model bytes | boot恢复同一persisted run/input；coverage/live reducer只认B | run/archive区分产品控制、immediate retry lineage、稳定模型root与逐代seed | missing/foreign/source或memory drift、旧seed复用、predecessor root变化/成环/非最新、R=B、structured/resource facts存在即拒绝 |
| e2 prepared/ingress contract | run preparer + atomic ingress唯一writer | literal e2 + required sourceTrustedEnvironmentRef；ordinary/actionAdmission/supersession 与 explicit-retry/predecessor/root/current-env/empty-supersession互斥；`recoveredContextDigest`禁止 | semantic ingress、Gateway/turn input/action projector | boot仅恢复完整e2分支 | archive按e2 typed refs审计 | e1/wrong-branch key/optional default/environment/input digest drift一律recovery-blocked |

### 8.3 active head、dispatch 与结果对账

source closeout 的同一事务执行：source generation 变为 retired immutable history source；target pending binding 成为该 alias **唯一 active head**。child bind 前 source 也不再是 active head。

两种 materialization 的时序明确不同：

- `native_fork`：`nativeInheritedContractDigest` 必须等于 source，target-specific materialization request另行冻结，因此 closeout后可由现有 materialization owner立即主动 fork；boot recovery同样驱动。下一条 ingress在 **`persistIngressAtomic` 前**preflight：child exact bind才继续。仍由唯一 owner推进的 pending/proven-absent retry返回 `conversation_context_materializing`；outcome unknown、多候选或 identity mismatch返回 `conversation_context_recovery_required`。二者都零 user row、零 run、零 Provider bytes并保留 composer，但前者等待投影刷新，后者只开放 reset；不得用一个 error kind把可等待与必须 reset混为一谈。
- `fresh_root_with_tail`：没有native child可预先继承，必须等current ingress完成资源/技能/工具面/指令prepare，才能冻结`thread/start` snapshot。ordinary用当前完整start合同；explicit Retry则以original source ordinary thread-start合同为上限，current full native contract必须exact相等，execution authorization才允许收紧，不能借fresh root扩张或更换definitions/instructions。之后采用现有exactly-once顺序：`persistIngressAtomic`同事务写user/run、tail assignment与thread-start snapshot，再由同一run的start owner执行thread/start/turn-start。unknown只恢复该persisted run，composer按已持久化事实清空，不允许第二个run；不在closeout预创建猜测工具面的root。
- `fresh_start`：保持现有普通 post-persistence owner，不带 tail。

`native_fork` proven absent 且 child write 可证从未发生时，同一 owner才可安全发起一次；其他 unknown零重发。

fork dispatch 必须复用现有规则：

1. 在父进程写 RPC 前先持久化 reservation、method、source、boundary、target cwd、request digest 和 connection/rpc identity。
2. child write confirmed 后才进入 accepted-or-unknown 区间。
3. response返回时核验新 thread id、`forkedFromId`、独立 path/cwd、session lineage、turn prefix、最后 turn id恰为 accepted native head、cutoff后零 turn、无 inProgress turn，并把 `ThreadForkResponse`暴露的完整 effective settings写成 typed receipt；prefix中更早的 safe failed item允许保留。工具/指令正文等 response未暴露字段留给 Gateway可见子集核验，不得伪装成 response事实。
4. response丢失后禁止重发。boot reconciliation用唯一 target cwd/path + `forkedFromId` + exact accepted prefix + scope/epoch/generation + runtime/model/provider/materialization-request identity查找 child；恰好一个才可进入resume补验。外部`thread/list -> thread/read -> thread/resume`完成后只能调用`reconcileAndBindMaterializedThreadFromResumeAtomic`：同一SQLite事务CAS pending intent/candidate/current head，先更新target的exact native thread/session/path/source identity，再插入完整`codex_thread_resume_evidence`（满足现有parent trigger），写materialization的`resumeEvidenceRef`/effective digest、标reconciled并把action sequence推进一次；任一步失败整体rollback，所以提交前live/boot/archive仍只见unbound pending。不得串联会自行开事务的`recordThreadResumeEvidence`与另一次bind。created time window只用于诊断，不能成为接受身份。
5. 零匹配且 child write 可证未发生，才允许 proven-absent；一匹配以外、路径/turn/digest 不一致均保持 unknown。
6. target pending row始终是唯一 active head；新 native child 只有 exact bind 后才成为该 head 的 `codex_thread_id`。不得让 Renderer、source binding 或下一条 ingress 自行选择 child。
7. 首个 user/run admission只 CAS assigned run与 exact per-item assignment plan，并冻结 tail-context/current-input。ordinary的 `omit_from_current_run`只有同时写入经 `actionAdmissionRef`确认的 supersession ref才终止该 item的 live carry；deliver/replace仍不表示 native已消费。turn-start后的delivery事实只由 `deliveryAudit`从既有assignment/turn-contract/start/readback receipts派生，不写第二份resolution。
8. turn-start unknown 由同一个 persisted run恢复；proven absent 由现有 start owner对**同一 run、同一 input/context digest**安全再 dispatch，不创建第二 run。永久 identity/config rejection保持该 run recovery-blocked，只允许 reset/close，不把 seed误标 consumed。

连续失败时不得把一次 assignment或 delivery当成 history commit。下一次 divergent closeout只调用 `resolveLiveUncommittedTailItems`，把其结果与本轮 active user message按原顺序合并并按 `{messageId,digest}`去重；即使 turn/start尚未accepted或deliveryAudit为unknown也必须 carry。deliveryAudit不能成为 carry资格，合法 supersession也不得被 assignment或旧 seed复活。assigned run满足 §7.2 的 product accepted条件后，只有新 coverage receipt明确列出的 items才从 live集合释放；deliveryAudit不替 coverage，也不声称 assistant“回答了”任何 item。reset/close只做显式 tombstone，不生成回答事实。

`thread/fork` 不发送 `threadSource`；response/notification/readback 必须保持 `source==='vscode' && threadSource===null`。boot `thread/list.sourceKinds=['vscode']` 过滤的是 `Thread.source`，不依赖 analytics `threadSource`。现有 provisional inbound buffer 必须新增 `thread/started` 的 exact intent 绑定：notification 或 RPC response 任一先到都只写同一个 child candidate，随后 `thread/read` 验证；unmatched/ambiguous notification 隔离，response/notification child id 不一致则 outcome unknown。

崩溃后 discovery找到 child不能直接标 loaded或开始 turn。在同一个 live sidecar client/connection epoch内依次完成 `thread/list -> thread/read -> thread/resume`并核验source/prefix、materialization settings与inherited可见子集；随后只能经上述原子事务让target bind、resume evidence、materialization receipt与reconciled状态一起可见，下一 Gateway请求再核验工具/指令正文和当前per-turn snapshot。迟到原RPC response若canonical child/effective digest完全相同则幂等；若冲突，只能由现有late-response guard隔离并把该head投成reset-required，不能改写已提交receipt、另绑child或继续Provider。

### 8.4 archive 与 cleanup

0.149 与 0.151 黑盒已经证明 archived source 的 `thread/fork` 会被 runtime 拒绝。因此：

- pending/unknown fork intent 从 source closeout 起必须阻止 source archive cleanup；不能等待下一 ingress 才加 hold。
- confirmed fork child 后，generic descendant rule 只对“未结算后继”继续阻断；已精确核验的同 alias native-fork successor 不应永久阻止 source archive。
- 用户 reset/close 不被 unknown fork永久阻塞：同一事务先推进 epoch或写 tombstone，将 target/source移出 active head，并复用 late-response guard把 intent标成 `abandoned_by_reset/close`。之后到达的 response/notification永远只能进 quarantine/async orphan cleanup，不能再绑定任何 active head；discovery/archive可后台继续，不影响用户新 scope/reset结果。
- legacy source 已归档时，本计划返回 `context_recovery_required/reset`；不新增 unarchive -> fork -> rearchive 的第二套副作用状态机。

## 9. 核心合同 D：任务重试、资源和副作用保持独立

### 9.1 explicit retry 不承担 conversation handoff

- `predecessor_run_id` 只表示失败任务 lineage，不表示 generation ancestry。
- 每次Retry的`predecessor_run_id/predecessorPresentationRef`只指当前最新失败run；稳定`modelVisibleRootOriginRef`始终指最初ordinary B的source ingress contract，每轮`selectedHistorySeedItemRef`只指current direct-successor seed中的B。若predecessor本身是Retry，它的formal mapping必须exact回指同一B root；不得沿R1/R2控制消息改根、复用上一代seed、形成环或选择较旧失败run。
- 明确的重试短语只有在显式resource/target envelope为空且v3 gate ready时绑定最新可见失败receipt；Renderer与Main复用同一 exact-retry parser（继续/continue/resume及新要求正文不属于重试），Main还要求raw `message===userMessage.content`、string-only、attachment counts全0与meta/resource exact shape。带任何附件/当前目标、任意新正文或非文本block时不剥离输入、不转explicit，保持composer并要求ordinary完整重述。普通完整任务仍是`user_ingress`。
- 本阶段只有一种Retry input mapping，但两种head readiness：`native_fork` target必须child exact bind ready；`fresh_root_with_tail`只需 `fresh_root_ready_for_ingress`，该Retry e2 run在persist后成为唯一thread/start owner并按同run crash recovery。两者都要求source diverged、selected origin未coverage且是seed内single live retry-eligible item，assignment=`replace_with_explicit_retry`，原task root作current input一次。e2 predecessor + control/model-input refs + seed/assignment就是完整合同，不另加invocation mode。
- `continuation_safe`同thread已经含failed user B，Retry固定 `not_applicable/same_thread_failed_turn_restatement_required`；不探测或发明native retry语义。B后来被manual/automatic compaction纳入coverage时同样 `not_applicable/compacted_failed_turn_restatement_required`。两者都允许ordinary完整重述，B不能再进tail，也不能显示为任务成功。
- B不可见的seam不能进入same-thread；closeout先走accepted-prefix fork + live tail，只有上面唯一child条件满足才开放Retry。不得在点击时改判immutable history facts、临时fork或新增第二materialization producer。
- 普通新消息走 same-thread 或 child tail handoff，不被自然语言词典改写成 retry。
- `NonUserSuccessorIngress` 和 `recoveredContextDigest` 不复活；后者在本计划落地时从 prepared contract、schema 与测试中删除。

### 9.2 本阶段只允许纯文本、零执行/交互的 exact Retry

这次故障的根因是 conversation history handoff，不是通用副作用恢复。为避免把一次连续性修复扩成覆盖所有工具与产品动作的第二套对账系统，本阶段不做跨run副作用去重、结果回读、输出复用、通用身份注册或新对账账本。

新增唯一纯 reducer `resolveExactRetryEligibility`，只读 immutable terminal facts 与现有正式账本引用；它不新增持久状态。它接受discriminated fact availability：projection调用只提供source ambient facts与current mode，产出的`ready`只表示允许发起一次preflight；pre-persistence调用必须提供Main刚解析的完整current resource facts、只读current skill capability facts与`resolveRetryCapabilityCeiling`结果，并执行同一规则集的required-empty/subset分支，最终CAS才有提交权。缺少完整current facts时绝不能从projection推导“当前资源为空/授权未扩张”，也不得另写第二个resource或skill classifier。Retry最终只有同时满足以下条件才可落库：

- predecessor仍是当前最新可见失败 task，history head按前述合同ready，且没有resource/interaction/legacy阻断；
- source/current trusted workbench mode必须exact相等且都为`browser|document`；source准备记录中已激活的page/document anchor、product/resource targets必须为空；Renderer保留当次原始文档观测，Main取得原任务根B后只解析一次activation，最终资格消费本次准备的激活结果并要求其为空；显式资源、附件及真实目标不得静默清除；RSS/Calendar即使显式resource数组为空也因ambient tool floor而不合格；
- source prepared contract与stable root digest可解出exact tool-definition digest和execution ceiling；current request零显式skill/mention，current session reference hint对effective B不relevant，完整model-visible definitions与source/thread exact相等；只有`allowedToolNames`、typed actions、allowed/candidate primitives与action permissions逐集合是`source ceiling ∩ current allowed`。definition drift、current-only candidate、不同skillId同名primitive、hint mutation或缺source proof一律不合格；
- source root与当前Retry prepare两边的model-visible Ready memory payload都为空；snapshot对象存在但payload为空仍合格，任一非空/撤销后digest漂移都不复制旧memory、只要求ordinary完整重述；
- 该run在 `codex_tool_call_bindings` 中零tool call，`ready_tool_action_receipts` 中零direct/nested action，零Browser/产品动作receipt；
- 没有已提交的 `ask_user_questions` answer、行动确认答案或其他同turn interaction result；
- terminal facts的effect为none，且不存在pending、confirmed、indeterminate、legacy或无法枚举的执行证据；
- failed user root必须由`modelVisibleRootOriginRef`解出exact source `taskRootInput`，且`selectedHistorySeedItemRef`证明同一message是当前eligible direct successor frozen seed/head中未coverage的single selected origin：`native_fork`要求已materialized并exact bind；`fresh_root_with_tail`要求`fresh_root_ready_for_ingress`，当前Retry admission/run成为唯一thread/start owner。两者都只把该纯文本origin作为current input一次；native-retained same-thread/compacted origin不合格。

任一工具/产品动作/交互答案/confirmed或indeterminate effect出现时，Retry固定为 `not_applicable/effectful_or_interactive_retry_unsupported`；legacy或证据不完整为 `not_applicable/retry_evidence_incomplete`。read-only tool也不例外：本阶段宁可要求完整重述，也不猜它是否可安全重放。普通新消息仍按head projection独立可用，reset也不受影响。

旧action/effect/interaction receipt只允许被纯gate/classifier只读，用于陈述原run事实、boot/archive审计和阻止旧事件污染新head；不得嵌入或复制到e2、Gateway、工具执行或新run结果证据，也不新增跨run副作用引用。用户完整ordinary重述是新的显式命令，重新走当前资源、工具、授权、行动确认与输出合同；它不被包装成旧task Retry，也不承诺自动判断旧外部动作是否已经发生。failure copy必须继续明确显示原结果未知，不能用“已安全重试”覆盖。

对含已回答 clarification/confirmation 的failed origin，tail classifier固定为 `task_restatement_required`：不把answer/tool result桥接成untrusted history，不继承旧授权，也不再次自动提交原task root。用户需把当前目标与必要事实完整重述；行动确认必须重新取得。

| derived fact | producer | validator | live/boot consumer | stale rejection |
| --- | --- | --- | --- | --- |
| exact Retry eligibility | `resolveExactRetryEligibility`读取terminal facts + tool/action/interaction账本 + ReadyMemory typed current ref；projection与pre-persistence传discriminated fact availability | exact run/scope/epoch/generation、零相关rows、history/resource policy、source/current memory payload均空；projection只验source ambient+mode，最终调用必须带Main刚解析的current resource与skill capability facts及ceiling结果 | ProductTurnReceipt per-run gate只开放preflight；Main pre-persistence同一reducer+最终CAS；boot hydration | newer run/head/memory revision、legacy/unknown即not applicable；current facts缺失/非空、capability非source子集、terminal后late evidence一律零写拒绝 |
| explicit Retry raw control envelope | shared strict parser + Main raw request validator在任何持久化前签发`controlAuditMessageRef` | string `message===userMessage.content`且strict；resources absent；raw document anchor可传入Main供原任务B解析，激活结果须为空；四个attachment counts=0；meta audit allowlist exact；explicit ref与latest projection exact | e2 control audit、product message展示与archive audit；semantic consumers只读root B | arbitrary/nontext R、message/content不等、nonzero count、forbidden meta/resource或foreign predecessor均零写拒绝 |
| Retry tool definition parity + execution ceiling | source ordinary prepared contract + stable `sourceIngressContractDigest`派生definition digest与现有authorization ceiling；current B candidate由单次immutable hint snapshot的observe resolver生成 | full definitions exact；既有allowed names/selected skill/typed/primitives/single candidate/action permissions求交；仅`host allowed - serialized-owned primitives`差集非空、relevant hint、observe mutation或live fact消费阻断 | fork/source Gateway body与fresh-root start消费exact definitions；run preparer冻结既有e2 authorization；Retry bridge重建前后canonical-equal，confirmation/dispatch禁live grant；ordinary bridge不变 | definition/source digest漂移、current-only/foreign-skill auth、synthetic host差集、hint mutation、Retry读取live grant拒绝；不新增entry schema/ceiling副本 |
| current ReadyMemory Retry ref | ReadyMemory owner按stable B生成eligibility ref；state-changing transaction commit后发revision event | exact scope/B digest，revision单调；eligibility digest排除read-time字段且由实际selected payload重算 | per-run projector/UI、Main click复算、boot hydrate | smaller revision拒绝；same revision different eligibility digest拒绝并hydrate；payload非空关闭Retry |
| effective semantic ingress + canonical current input ref | `resolveEffectiveSemanticIngress`从e2 branch/current request或stable root ref纯派生 | ordinary=current C；Retry=root B；digest与formal model-input mapping exact，control R排除 | request envelope、intent/route、tool snapshot、obligations/output/targets、TurnInputBuilder、Gateway、tool/Browser source anchor、checkpoint route、ReadyMemory admission、boot same-run recovery | branch/ref/input digest drift、任一semantic consumer使用control/audit origin即结构/behavior gate失败 |
| origin continuation policy | `classifyUncommittedOriginPolicy`纯派生；divergent seed只冻结输出 | exact origin immutable ingress/resource + settled tool/action/interaction refs；不读自然语言 | same-thread per-run gate、seed builder、ordinary supersession、boot/live reducer | foreign run/ref、missing/unsettled evidence、输入digest/epoch漂移拒绝 |

专项 effectful Retry若未来确有产品价值，必须按具体业务owner另立计划逐工具接入；不得在本次实施中顺手加入通用fallback。

### 9.3 resource 与 capability floor

fork 只保留 native 语义历史，不授予资源能力：

- 当轮 `resourceDigest` 只计算当前输入/附件/当前文档锚；
- 历史 `<ready-resource>` 只能作为对话文本，不能形成当前 resource authority；
- 旧 selected skill、dynamic tool **执行授权**、action authorization、output contract、Browser journal、ask-user waiter 全部不跨 run 自动继承；thread-sticky model-visible definitions始终与source exact相等，Retry只在bridge synthetic-host差集为空时用既有authorization schema把original source ceiling与current allowed逐集合求交；serialized candidate已经拥有的同skill primitive允许，reference hint、显式current skill、安装后candidate、Retry bridge新增项或live authorization fact都不能扩权/跳过确认；普通ordinary重述才按当前事实重新授权；
- 任一旧资源依赖都使explicit Retry不可用；用户必须在ordinary输入中重新附加并完整重述，当前run重新冻结resource identity/权限。不得用旧path/digest readback把资源重新授权给Retry。

## 10. 核心合同 E：回复呈现最小修复

### 10.1 有序列表

只改 `src/renderer/components/agent/chat-panel/markdown/index.tsx` 及直接行为测试：

- parser将同一缩进层级、同一 delimiter family（`.` 或 `)`）的连续 numbered items聚合为一个 `ordered-list` node，保存 `start`、delimiter与有序 `items`；
- item 可包含产品明确支持的 lazy continuation/缩进说明段和嵌套 list；是否跨空行继续由该 Markdown 子集与行为测试决定，不能把所有空行无条件并入同一列表；
- renderer 只输出语义化 `<ol start={start}><li>…</li></ol>`，不逐 item 手写数字、不使用 node index、不在 CSS 再维护 counter；
- Tailwind preflight 会把 `ol/ul` 重置为 `list-style:none`；组件必须用 `.ready-agent-prose` 范围内的样式或 inline style显式恢复 `list-style-type:decimal`、合理的 marker gutter/padding，并保持 `li{display:list-item}`。这只是恢复原生 marker，不是新增 CSS counter；
- `1.` 与 `1)` 都是 ordered-list marker，但 delimiter改变会结束前一个 container；`1. -> 2)` 必须形成两个 list。delimiter不变时，后续 item即使都写 `1.`，同一 list仍由浏览器显示 `1/2/3`；
- 非 1 起始值用 `<ol start>`；嵌套 list 有自己的起始值；标题、代码块或真正退出 list 的同级段落才结束当前 container；
- 不为了这一问题引入第二套 Markdown 库；若现有 parser 无法在小范围内正确表达 nested/lazy items，才单独提出 parser replacement，不在本修复里半接入两套 renderer。

行为测试除 DOM 结构外，还要在真实 Electron 读取 computed `list-style-type` 并截图确认 marker可见；只断言存在 `<ol>` 不算通过。

这与 Matrix 当前 Marked token -> 原生 `<ol>/<li>` 的实际消费方式一致。Matrix 只保留列表起始值与结构，不逐行照抄每个 authored marker。

### 10.2 运行状态与用时

只改 `RunDurationMeter`、其调用处和直接测试：

- `queued/planning/tool_running/takeover/resuming/responding` 继续按 `Date.now() - startedAt` 每秒更新；
- live model 的 label 直接为“本轮用时”，组件只渲染一次 `本轮用时 00:01`，删除“本轮进行中”和重复的 duration prefix；
- `ThinkingIndicator` 仍显示“思考中”或当前简短 activity narration，不承担第二套计时状态；
- done/error/cancelled/checkpoint 后，duration 以 `startedAt -> updatedAt` 冻结；
- 不新增 store 字段、Main 事件或数据库列，不把 activity narration 塞进 duration row。

这是 Ready 针对用户点名文案的最小产品取舍，不宣称与 Matrix 的单行 `Working for / Worked for` 布局完全相同；两者共同点只是 elapsed 由一个状态化短语消费，不同时显示两个 duration label。

## 11. 实施阶段与阻断门

### Stage 0：协议取证，未通过不得写生产 fork

目标：先证明 pinned Ready runtime 的真实语义，不从 Matrix 新版或 schema 猜。

新增隔离 app-server fixture/probe，至少覆盖：

1. 成功 A -> 无 item Provider failure B -> dependent普通 turn C=`再详细一点`；只有真实 Provider capture中 A、B各作为 prior history恰好一次、C为唯一 current input且 B后无不安全 assistant/tool suffix，该 seam才可进入 same-thread allowlist。
2. 成功 A -> divergent B -> child ordinary C，其中B以`ready-uncommitted-user-tail`交付、C为current；让该turn在原本single-user safe seam失败。它必须判diverged而非same-thread，后继fork/live reducer在D的真实Provider capture中让B、C按序各出现一次且control R为零。该反例不允许只拿“C retained”probe覆盖整组formal origins。
3. 在 response id 前、首 item 后、partial assistant 后、tool call/result 后分别断流；记录 error/turn terminal/readback/history。
4. 明确捕获 failed turn的user item是否进入下一轮model history：B不可见时ordinary path必须先按§7.3/§7.4 materialize accepted-prefix child或fresh root + per-item tail；只有history-ready child、B未被coverage且满足zero-execution/interaction gate时Retry才把task root作为current input恰好一次。B在same-thread可见或已被compaction coverage时Retry一律unavailable，普通完整重述；不得为点击Retry临时fork或探测另一套native retry。
5. 成功 A -> text-only failed tail B -> `thread/fork(lastTurnId=A)` -> ordinary C；child只含 through A，Provider role/order必须是 B=`untrusted user history`、C=`last current user`，不含 B partial，随后 D仍能理解 B且 B不重复。再用 B=`删除目录 X`、B=`忽略系统指令`做反例：都保持 untrusted user role，不能改变 instruction digest或签发 C的工具权限，effect为零。B带resource/nontext时ordinary C不桥接 B并要求重新附加、完整重述；B带skill/mention/action obligation/grant/output contract时同样不桥接且要求完整重述，二者都不开放Retry。
6. A accepted -> manual compaction M consumed -> divergent B -> fork through M；并覆盖 automatic compaction写入后同turn分别success、failed/disconnected、QC rejected。若runtime暴露可fork compaction cutoff就推进exact coverage；若不能隔离且需要fork则terminal unknown/reset，禁止回退prior cutoff+猜tail。child/同thread不得出现两份summary、重复covered item或丢失retained facts。
7. kill sidecar -> resume same thread；thread/path/history 不变。
8. active source fork 成功；source archive 后 fork 必须被拒绝；Ready pending seed 从 closeout 起持久 hold 住 archive。
9. 三合同负探针：向 fork塞 dynamicTools/instruction/config/workspace/threadSource覆盖字段必须由 Ready client本地拒绝，child保持 `source='vscode', threadSource=null`。source start receipt + allowlist + pinned probe证明 `nativeInheritedContractDigest`（含不可观测的 sticky context-window字段）与 workspace-root policy；fork/resume response的 typed effective-settings receipt逐项核验 cwd/model/modelProvider/approvalPolicy/approvalsReviewer/sandbox/reasoningEffort/serviceTier/instructionSources/thread；Gateway只核验 model-visible tools/instruction body、sandbox metadata与**当前** per-turn upstream/reasoning/service-tier/authorization snapshot。target cwd与 per-turn route可以按各自合同合法变化；不得要求它们等于 source，也不得声称逐 child读到了 runtime roots。
10. fork child write 成功后丢 response；捕获 pinned runtime 的 child `threadId/sessionId/parentThreadId/forkedFromId/source/threadSource/path` exact contract。`thread/started` notification 与 response 任一先到都只形成一个候选，再经 thread/read 核验。两者冲突、unmatched/ambiguous notification 均 quarantine/unknown；通知也丢或进程崩溃才走 boot discovery。
11. `error(willRetry=true) -> success` 不得产生 failure/retire/Retry UI；`error(true) -> error(false) -> failed completed` 与 `error(false) -> late completed` 只由最终 terminal/connection-owner closeout一次。

Stage 0 输出一份机器可读 probe receipt，记录 runtime binary/schema hash、fixture、source/child thread IDs、turn prefix、tool surface digest 与断点结果。不得做付费 Provider 调用。

### Stage 1：回复呈现收口

目标：先把两项不依赖 Main 的 UI 修复单独验收，避免与状态机改动互相遮蔽。

- 为有序列表写当前实现会失败的 `1./1./1.` + lazy explanation + blank line 测试，并覆盖 start=3、嵌套重置、真正分裂的两个列表和 streaming 半成品。
- 为 live duration 写所有 live phase 均只渲染一个 elapsed 短语、每秒更新且 running -> done/stop/wait 后冻结的测试。
- 在真实 Electron 中用截图场景检查第一章分点内容和“思考中”状态。
- 不因为 UI gate 通过宣称上下文连续性已修复。
- UI 形成独立变更集和 gate；若后续获授权提交，与 runtime continuity 分成不同 commit。

### Stage 2：失败事实与终态单线

目标：消除 blanket retire、regex 重判和下一动作冲突。

- Gateway 只产出 typed wire failure evidence；collector 保留 exact typed evidence ref。
- 新增纯 `resolveCodexTerminalFacts` 与 table-driven exit matrix tests。
- failed candidate 也必须做 native readback/parity gate。
- canonical closeout 原子写 immutable terminal facts；ProductTurnPresentation 从 facts + 最新 owner receipts 投影 available actions。
- failure copy 只陈述 immutable facts；Retry UI 与 Main retry admission消费同一 action projection/reducer，terminal parent 与 send response 不再冒充任务 Retry。
- 删除 `recoveredContextDigest` 与静态过度承诺文案；不保留兼容双读。

Stage 2的首个红测必须是：命中 retention-safe allowlist的无工具 `response.failed`后普通 dependent下一轮保持同 thread，并从真实 Gateway request capture看到此前 accepted history与 failed user B各恰好一次、当前输入 C恰好一次，B后无不安全 assistant/tool suffix。B不可见的 seam必须在同一测试组证明转入 fork+tail而非 same-thread。

### Stage 3：accepted-prefix fork

目标：只为真实 divergence 增加 native fork，复用现有 materialization owner。

- client 精确开放 `thread/fork` schema 和 response validation。
- 扩展现有 unstarted binding/materialization method，不建立第二套 owner。
- closeout用 strict reducer选择 accepted native prefix head + accepted product boundary + coverage lineage差集得到的 ordered live uncommitted tail，原子退役 source并创建唯一 active target seed；product/manual/automatic推进只经唯一增量coverage receipt writer。
- `native_fork` 在 closeout 后由现有 owner主动 materialize，boot 同步恢复；下一 ingress 在 `persistIngressAtomic` 前 preflight，child 未 exact bind 时零 user/run/Provider write并保留 composer。
- `fresh_root_with_tail`不在closeout猜thread contract：首个ingress prepare冻结snapshot，ordinary取current full contract，Retry先做original source full contract exact parity+execution ceiling；`persistIngressAtomic`同事务写user/run、逐item assignment plan与start snapshot，再由同一persisted run的既有start owner materialize/recover。其`fresh_root_ready_for_ingress`必须允许这次send/Retry进入，不得套native-fork的pre-persistence child gate。
- target首个 admission按 item分配：ordinary current input仍只有 C；untrusted items走正式 Gateway typed additionalContext，resource/task-restatement items计划为 `omit_from_current_run`，但只有经 Renderer `actionAdmissionRef`确认并在同一e2 admission事务写入 supersession refs才停止live carry；explicit retry只 replace经typed source-ingress ref证明的pure-text untrusted origin，可安全保留的更早 untrusted items仍 deliver。turn-start delivery只由既有receipts派生audit；后继 seed始终重新调用 live reducer，直到coverage/supersession/reset/close真正释放。
- prepared/ingress合同只写 `codex_product_run_e2`；e1 pending/缺数组不补默认值，boot直接 reset-required。
- root binding 对 `forkedFromId !== null` 的旧拒绝合同改为 exact fork intent/readback 合同。
- `resolveUserIngressAliasBinding`退役两条旧fallback：不得因 `publication_diverged` 或一般used head/tool-instruction contract drift调用 `insertEmptyAliasGeneration`。它只解析由new-scope/reset/canonical closeout或具名`refreshPristineFreshStartHeadAtomic`正式创建的唯一active head，并消费同一个current head send gate。严格pristine head发生runtime/protocol identity drift时只允许该原子refresh；其他已知runtime/protocol drift已由head projector直接block，点击时只是同gate重算/CAS，不再另有平行判定。只有当前输入prepare后才显现的tool/instruction/resource/Ready-memory drift由同一run-preparer gate阻断。refresh若使旧action ref失效，本次提交零user/run/Provider bytes并保留composer，Renderer读取新projection后再提交；不得把旧空generation悄悄当成已恢复历史。
- archive eligibility 与 boot reconciliation 同步消费 fork intent。

### Stage 4：任务重试、资源、旧回执与迟到事件

目标：证明 conversation lineage 与 task lineage 互不污染。

- explicit retry 继续精确绑定失败 task root，不承担旧对话回放。
- raw send合同先验证control-only exact shape：Renderer不得清空附件/引用后伪装Retry；Main复用strict lexicon拒绝arbitrary/nontext R、计数与资源矛盾及forbidden meta，验证完成前零持久化。
- Main从terminal facts + 当前materialization/head生成并正式消费available-action projection；不持久化nextAction。Renderer按runId内存map保存v3 gate，Retry与ordinary actionAdmission都提交所见版本。`resolveExactRetryEligibility`只允许零tool/action/interaction/effect的旧任务；其他旧receipt仅审计并使Retry不可用，不进入e2或新run。
- resource/tool/skill/action/output-contract floor 全部按当前turn重算；Retry先要求完整tool definitions与source/thread exact相等，再把当前execution authorization与original source prepared ceiling求交；relevant session hint或显式current skill使Retry不可用，且preflight前零hint mutation。
- 每个旧 receipt 的查询都加 exact run/scope/epoch、immutable owner generation与当前 action-head直接 lineage条件；不得简单要求两者 generation相等，也不得把 owner改写成 successor。
- 旧 terminal、tool result、Browser verifier、ask-user answer、usage 事件对新 head 必须 CAS 失败。
- runtime continuity 形成独立变更集/gate，不得由 Stage 1 的 UI 绿测掩护。

### Stage 5：crash、native DB 与安装态验收

目标：证明不是只在单进程 source test 中成立。

- 覆盖 fork dispatch前、child write后、response/notification前后、binding CAS前后、ordinary/Retry admission与 action-sequence同事务前后、tail assignment后、turn-start accepted/reconciliation/readback前后、closeout前后的 crash seams；deliveryAudit始终从这些既有receipts派生。
- 运行 native SQLite gate，零 ABI skip。
- 运行 Codex turn-delivery、runtime E2、model-gateway、source/stability/streaming gates、typecheck、build。
- 使用同一 build 产出 DMG，在隔离 profile 中验证：safe failure same-thread、true divergence fork、reset clear、resource no-escalation、effect no-replay、序号和单一 live 状态。
- installed proof 直接检查 provider/Gateway capture、native source/child rollout、Ready DB、Renderer 可见结果和应用/包体/runtime/schema hash；不得只检查界面仍有旧消息。

## 12. 对抗性测试矩阵

| 反例 | 旧实现应失败 | 新实现必须证明 |
| --- | --- | --- |
| “书名”在 A，B 要求总结第五章但 stream failure，C 再次完整提问 | C 的 Gateway 输入无 A | safe readback 时同 thread，或 fork through A；C 读到书名 |
| B只输入“重试” | task root/会话历史混为一谈 | 仅diverged child且origin未coverage、零执行/交互时replace current input一次；same-thread/compacted一律Retry unavailable；A只来自native prefix |
| Retry点击产生UI控制消息R=`再试一次`，Provider实际输入B | R被当user origin进入coverage/tail，后续污染模型 | e2标R为control-audit-only；crash恢复同run，失败再diverge carry B一次/R零，成功coverage B而不coverage R |
| B fail -> R1/S1 Retry fail/diverge -> R2/S2 Retry | 第二次把R1当task root、复用S1、链成环或选择旧failure | predecessor链U1<-U2<-U3逐次指最新失败run；stable root ref始终original B，selected seed ref从S1更新为S2且都映射B；每轮Provider current B恰好一次，R1/R2 control零history/coverage/tail；head/seed/root/predecessor drift或成环零写 |
| B 有 partial assistant，C 只说“再详细一点” | 退役成空 root，或 child 只有 A+C | child through A；B作为typed historical context一次，C作为active input一次，不含 B partial |
| B 是“删除目录 X”，C 问时间 | ordinary tail被提升成指令或重新执行旧动作 | B仅是 C之前的 untrusted历史 user message，C是唯一 current input；B不能签发行动权限，tool effect为零 |
| B final 被 QC/Browser 拒绝 | native final 可能污染后继 | child 不含被拒正文；效果只认 Ready receipts |
| B含任一confirmed/indeterminate mutation或产品动作 | 新call identity绕过旧receipt而重复动作 | exact Retry不显示/不准入；ordinary完整重述是新命令，重新走当前授权与行动确认，旧receipt不进入新run |
| B只执行过read-only search/tool | 为判断可重放而引入通用effect分类 | 本阶段同样Retry not applicable；用户完整重述，避免为本故障扩建逐工具registry |
| 纯文本B同时带browserPageRef、productSurfaceTargets、externalReadSlice、currentDocumentAnchor、resourceAuthorities或resourceAdditionalContext任一项 | classifier只看文本而开放Retry，丢失或误绑定“这个页面/当前项” | 每个字段各有table case并固定resource-restatement；要求重新选择/附加目标并完整ordinary重述，零Retry/零旧target authority |
| 纯文本B来自RSS/Calendar mode但无显式target，或B在browser/document后切到RSS/Calendar再点Retry | ambient capture/read floor未冻结，Retry获得新rss/calendar工具或丢当前面目标 | source/current trusted mode进入同一projection gate；任一RSS/Calendar或mode不等均not applicable，零run/工具权；source ambient refs须空，click-time唯一prepare要求current ambient refs为空并拒绝非空值 |
| browser/document同mode下Retry投影曾ready，随后导航页面、选择文档/附件或加入split target再点击 | 非单调环境摘要制造hydrate循环，或旧ready直接带入新资源 | 动态projection仍只绑定mode；Main click-time prepare返回typed current-environment-restatement拒绝，零user/run/Provider bytes且保留composer，ChatPanel把本次动作收口为ordinary完整重述提示；清除/改变本地资源后仍须重新preflight，不新增环境revision |
| 用户键入严格“重试”同时附文件、选当前文档/RSS页面或split target，或已有选择时点击Retry按钮 | Renderer为满足zero-resource schema静默清空输入，用户意图与证据丢失 | natural resolver不转explicit，按钮也不提交；正文、附件和选择原样保留并提示完整ordinary重述，零user/run/Provider bytes；Main仍拒绝伪造nonempty explicit envelope |
| direct IPC伪造`explicitRetry`并携任意正文C、非文本message block、`message!=userMessage.content`，或resources为空但attachmentConfirmation非零 | UI审计落C但模型执行旧B，或伪造“无附件”绕过资源门，形成双任务真相 | Main shared strict/exact raw validator在任何message/user/run写入前拒绝；canonical按钮R与合法strict自然短语通过，control R零model/history/coverage |
| source B无skill mention；Retry前有relevant hint/显式skill/definition变化；默认lark candidate已含`skill_read_artifact`；folder floor又让allowed names多出未归属write/export；或有M3 live grant | 粗暴“任一host primitive”误杀正常Retry，或bridge后补/dispatch live grant扩权 | pure hint snapshot零变更，definitions exact；已由candidate同skillId拥有的read可正常求交且bridge canonical-equal；只有`allowed host - serialized-owned`的write/export差集非空时block，ordinary bridge不变；Retry不consume live fact并正常确认 |
| B或当前Retry prepare的Ready memory snapshot对象存在 | 只看对象存在误杀empty payload，或只看B文本而复活旧/变化memory | table覆盖root/current payload empty/nonempty/revoked-drift四种组合；仅两边model-visible payload均空可Retry，Gateway capture中memory context为零，其他均ordinary完整重述 |
| 相同memory state连续读取、或edit/revoke/expire后event乱序/丢失 | `frozenAt`使同revision digest变化形成hydrate循环，或旧Retry按钮继续ready | eligibility ref排除read-time字段：同state+B两读完全相等；edit/revoke/正式expire严格增revision；事件刷新per-run gate，丢失由click stale CAS+hydrate，same-revision different digest拒绝 |
| 一个Tag Forge/Document tool call触发多个nested product actions，部分pending | 顶层result未带全effectActionId，closeout漏枚举并误判effect none/confirmed | 每次bound begin原子写parent/run/call/ordinal索引；closeout沿索引枚举全部receipt，pending真实settle为indeterminate，缺binding即evidence incomplete |
| closeout撤销effect authority与nested action begin并发 | late begin在terminal后新增未被facts覆盖的receipt | `beginBoundProductEffect`与closeout在DB上CAS同一owner terminal/authority；只允许一方提交，late begin/commit零写或CAS失败 |
| B提交过clarification/confirmation answer后divergence | fork截掉tool result，Retry只重放task root导致再次追问或继承旧授权 | policy=task_restatement_required；answer/授权零桥接，用户完整重述并重新确认 |
| action row在closeout时仍pending，late result随后到达 | immutable terminal引用临时read状态并被迟到结果改写 | closeout先撤销authority并CAS真正indeterminate；late commit失败，Retry仍不可用，boot等值 |
| terminal closeout与ask/confirmation answer并发，answer稍晚到 | zero-interaction gate先ready，late receipt再改变资格但version不变 | closeout同事务关闭waiter/confirmation；late submit CAS失败，已提前接受的answer则固定task-restatement policy |
| Codex pending ask card/confirmation重启时generic constructor或boot sweep先运行；旧卡缺codexRunIdentity但requestId命中Codex run | 通用meta update/全表expiry抢先写，或旧卡被当non-Codex二次cancel | constructor零写；统一ownership resolver三态；exact先settle，ambiguous ask写existing cancelled+meta reason、confirmation只写existing expired且原因纯派生；generic只处理proven non-Codex，二启幂等/list零pending/archive可读 |
| confirmation release/deny/TTL sweep与closeout并发 | release先返回冻结参数导致closeout后仍dispatch，或direct UPDATE写出第二终态 | 全部Codex transitions经同一DB CAS；release仅commit后返回params，closeout先赢则gone+零dispatch；deny/TTL先赢则closeout只读已提交canonical row |
| action-confirmation card与pending row两次写之间崩溃，或同session有相似question | card显示已确认但action仍pending，或猜中错误frozen call | pending meta先冻结exact owner ref；respond/cancel/timeout单事务更新linked双行，两次写间不可见；commit后resolver miss仍以DB settled为真，零重复dispatch |
| 同session ordinary ask与ordinary ask/action confirmation并发create | 两边在async persist前都看到内存为空，最终出现两张pending卡或两个waiter | 两个create入口共用BEGIN IMMEDIATE并同时查两类DB pending；只有一个commit，loser=`overlapping_card`零写；waiter/event只在commit后注册，重启可收口commit后崩溃 |
| owner run已terminal但interaction settle前崩溃 | user transitions要求nonterminal、generic又排除Codex，pending永不收口 | boot repo凭exact terminal/closeout digest做pending->cancelled/expired；无法绑定但Codex-shaped的row同repo fail-closed终态化，绝不交generic |
| terminal closeout与内存 `skill_ask_user` 单问答案并发 | closeout后纯内存store仍resolve旧promise | per-run terminal fence先挡submit，commit后rejectByRun，rollback才释放；tool binding已使Retry不可用，零新答案表 |
| 首轮即 divergence | 无 accepted cutoff | fresh root把 text-only B仅作为 typed untrusted user history，把 C作为唯一 active input；explicit retry只提交 B task root一次 |
| 首轮divergence后用户直接点Retry | 等待“已materialize child”而fresh-root永远没有start owner | fresh_root_ready-for-ingress即允许e2 Retry persist；该run唯一start owner，崩溃恢复同run/同input mapping |
| fresh-root seed等待首个 C | materialization gate把 C挡住形成自锁 | UI/Main允许 C进入；同一 run冻结合同、持久化并负责 thread/start，第二 ingress被拒绝 |
| admission后active run/fence事件丢失 | head UI仍ready，或terminal后旧failure Retry复活 | hydration从同一fence owner投影send blocked；terminal/fence release后send恢复，但旧failure因newer_user_run永久not applicable |
| manual compaction reserved/pending/unknown且事件丢失 | composer仍ready或另靠旧compaction状态拦截 | head projector直接消费binding并按sequence显示pending/unknown blocker；reset可由ownerabandon，success+coverage只+1一次 |
| 用户 stop | stop 被当 publication divergence | readback 安全则 same thread，否则 fork prior prefix |
| 用户 reset | 旧 generation 仍可被迟到事件命中 | epoch 前进、零 fork、旧事件 CAS 失败 |
| close | 创建无用 successor | no successor，archive 可收口 |
| runtime/tool/root-instruction drift | runtime 静默忽略 fork override | client 拒绝覆盖字段；digest不等时 provider 前 blocked/reset |
| archived source | runtime 明确拒绝 fork | pending seed阻止 archive；legacy archived source required/reset |
| fork response 丢失 | 盲重发生成多个 child | 唯一对账或 unknown freeze，零第二次 RPC |
| response-loss child已被list/read/resume找回，但resume evidence先于target bind写入 | 现有parent trigger因target thread id仍null而中止，boot反复自锁 | 单一reconcile-and-bind事务先做未提交target bind、再插resume evidence/ref并commit；任一步故障全rollback，重启可重做同一候选 |
| resume reconcile提交后迟到原fork response | 第二writer改写settings或重新绑定 | same child/effective digest幂等；冲突由late-response guard隔离并投影reset-required，零新bind/Provider bytes |
| fork response 在 C 到达后丢失 | C 先落库再被重复提交 | C 的 chat row/run/Provider bytes 均为零，composer 保留 |
| publication_diverged或used head contract drift后新输入 | resolver旧fallback无条件插空generation | 只有exact zero-turn/zero-message/zero-start pristine head可由具名refresh事务同epoch换空generation并使旧action ref stale；其他缺失/漂移pre-persistence reset-required，结构gate禁止旧fallback |
| tail assigned后 turn/start unknown/proven absent | seed提前标 consumed，B/C永远丢失 | unknown恢复同run；proven absent同run exact re-dispatch；accepted+readback只形成derived deliveryAudit，不改live |
| tail items已assigned，run在turn/start accepted前或delivery后失败/分叉 | assignment/delivery被误当 history committed，旧请求永久丢失 | 下一seed按live reducer重带全部未coverage/未supersede items并去重；deliveryAudit可unknown，合法supersession不复活 |
| tail=[B纯文本,C带资源]，用户仍发送普通 D | 全数组共用 policy或整 tail被误释放 | admission计划 B=deliver、C=omit并同事务写supersession ref且先显示consequence；D若未accepted只carry B，若accepted仅coverage列出的B进入prefix；C只留audit、不称answered/committed |
| ordinary发送存在一般重述项/资源重述项 | head错误提示一个并不存在的Retry，或UI/Main各算一份 | ChatPanel始终显示中性完整重述，资源项再加重新附加提示；提交同一actionAdmissionRef，stale/missing零user/run |
| omit assignment写成但supersession事务崩溃/伪造旧epoch ref | item被永久丢失 | live reducer忽略omit/无效ref继续carry；只有同一e2 admission合法ref才释放 |
| D合法supersede C后又有terminal/新admission、direct fork child并重启 | validator要求ref sequence/head等于最新而复活C | ref验证successful ancestor admission与epoch lineage、current>=resulting；后续增长/直系child/reboot均不复活C |
| compaction 后 fork | Ready 再拼一份 summary | native compacted prefix 恰好一次 |
| A accepted -> manual compact M -> divergent B | cutoff 仍选 A 丢掉 active compacted head | accepted-prefix reducer选 M；retained facts恰好一次 |
| Retry把predecessor B作为native current input、UI另有control R，随后manual/automatic compaction | compaction按`ready_user_message_id`覆盖R、漏掉B | 所有coverage producer只读e2 formal model-input mapping；M覆盖B且永不覆盖R，后继tail/Retry状态一致 |
| 首轮B failed -> verified compact M（无product accepted）-> 后续divergence | native_fork强制product boundary非空而拒绝合法M | product boundary=null但coverage producer/head exact，fork through M；tail/任务状态仍按coverage差集 |
| A accepted -> B safe failed -> compact M -> divergent C | B既在compacted prefix又被tail重注入 | coverage chain只覆盖B一次，live差集移除B；task仍失败且Retry固定不可用，用户完整重述 |
| accepted product turn 同时发生automatic compaction | product closeout与automatic各写一条，或把parent coverage重复塞进`newlyCovered` | 互斥分支只写一条`automatic_compaction` receipt；candidate来自exact compaction mapping+本轮inputs，减parent effective coverage后追加，head/sequence只推进一次 |
| automatic compaction已写native history、同turn随后failed/QC rejected | 既不推进coverage又按普通failed tail重注入 | 有独立可forkcutoff才推进automatic coverage；否则divergence为unknown/reset，零猜测fallback |
| A fork到child后child首次accepted D | child coverage从空开始，后续再fork重复A | child首coverage以seed冻结的source coverage为parent，整条coverageLineage跨direct successor折叠 |
| 旧附件曾可读 | fork 后沿用旧权限 | 模型可知历史语义，但当前读取被 authorization floor 拒绝 |
| 旧 failure receipt 后已有新成功 | Renderer 仍可 Retry 旧失败 | old receipt 不能控制新 run/next action |
| divergence -> child bind -> 立即 Retry | owner generation与current head冲突 | owner generation不改写；exact直接successor关系通过，第二successor/无关head拒绝 |
| A success，B retention-safe failed留在同 thread，C partial divergence | B 被误选为 fork boundary | strict boundary仍为 A，uncommitted tail B+C逐项按序且首 child turn恰好一次 |
| A success -> B safe failure -> C success -> D divergence | 为删 B重建历史 | fork through C且保留 prefix 中的 B；只截 D suffix |
| error(willRetry=true) -> success | 中途生成 failure/Retry UI | 零 closeout/retire；最终 success一次 |
| 任一tool/action/effect/interaction evidence后点击Retry | 旧receipt被后台改写、复用或盲重试 | v3 gate固定not applicable，零Retry按钮/零新run；ordinary完整重述仍可用 |
| message terminalReason=error，但 v3 retry gate not applicable | `ChatMessages`仍按terminalReason画Retry | 零Retry按钮；只有零执行/交互证据且其他合同ready才显示，`ChatPanel`点击仍交Main复核digest |
| terminal parent 与 Retry | parent 被标成可续跑 | parent仍 `resumableActions=['none']`；Retry 创建新 user run |
| legacy 长 thread 升级后首个新 turn divergence | null prefix被误判为 native首轮 | legacy/no完整双边证据返回 unknown_reset_required，绝不 fresh root |
| legacy/malformed terminal缺facts或无法解effective B | v3 complete分支被迫填空memory/environment digest | 只生成`unavailable_legacy` exact union：dynamic refs=null、Retry稳定not applicable；不得调用B-based projector或因hydrate补synthetic值 |
| started legacy head点击manual compact | native压缩成功后因Ready origin mapping不全才变unknown/reset | lifecycle projection预先返回`not_applicable/legacy_context_boundary`；ordinary continuation、reset、close仍可用，零compaction dispatch |
| started legacy head上新e2 turn成功（含native automatic compaction），随后ordinary D或history divergence | 成功closeout被exact-one coverage卡死，或零coverage让C进入live tail无限积累/用单turn伪造legacy parent | 成功正文与product terminal正常发布但零coverage/head/tail/supersession；状态仍legacy，D只走same native thread且UI无tail consequence；后续divergence或需Ready compaction mapping时reset-required，不建bootstrap兼容receipt |
| materialization/新 terminal refresh乱序到达 | 旧按钮状态倒灌 | actionProjectionVersion按 epoch/head generation/action sequence单调拒绝旧事件 |
| admission/terminal/reset事件任一丢失或head与lifecycle事件乱序 | UI同时显示旧stop/reset状态与新send ready，Main再各自重判 | atomic action-surface envelope给两projection同一epoch/head ref；ref不等先隐藏send并hydrate，Renderer/Main都只消费shared gates，最终action仍由各owner CAS |
| lifecycle request -> acknowledged -> unknown事件乱序/丢失 | head sequence未变，旧ready gate以相同version覆盖新unknown | 每个正式lifecycle事务用同一action sequence helper至多+1；只收更大version，同version不同digest拒绝并hydrate，Main按最新shared gate CAS |
| action-surface或ReadyMemory事务已commit，post-commit publisher/listener抛错 | 调用方收到假失败而重试，形成重复admission/lifecycle/memory mutation | publisher异常只记诊断且不改变committed返回；DB只写一次，事件可丢并由后续hydrate/click读回最新版 |
| ReadyMemory与head/per-run refresh交叉乱序 | 较新memory+旧head覆盖较新head，旧Retry复活 | 唯一tuple先比epoch/head generation/sequence，再比turn+memory revisions；旧head永拒，same tuple异digest hydrate；mode ref只作exact cache identity |
| same-thread failure后普通 C已admit、尚未turn-start即崩溃 | generation未变，旧Retry仍显示 | admission事务 action sequence+1并失效旧projection；boot hydration先恢复C，再按新version隐藏旧Retry |
| C admission后旧failure B收到较新action refresh | active ScopeRunState丢掉B receipt | per-run内存projection map按B runId更新；ChatMessages读B gate，composer只读当前head；reset/close清理 |
| 只收到head advance、B的per-run refresh事件丢失 | UI继续显示旧Retry直到用户点后才被Main拒绝 | B.headProjectionRef与当前head不等即隐藏/blocked并主动hydration，旧ready按钮不污染UI |
| e1 pending run/fence升级启动 | 缺字段默认空数组后继续或永久thread_busy | head只开放reset/close；reset原子释放旧fence并前进epoch，下一条输入才新建e2，不双读/原地补造 |
| 列表输入是 `1./1./1.`，含说明段与嵌套 `1)` | 每项都显示 1 或按 node index 错位 | 同一 `<ol>` 显示 1/2/3；nested list 独立编号 |
| 同级 marker 从 `1.` 改为 `2)` | parser把不同 delimiter硬并成一表 | 结束前一个 `<ol>` 并按新 delimiter创建第二个 list |
| live turn | 同一行出现“本轮进行中 本轮用时”，或计时整行被删 | 只显示“本轮用时 00:01”，持续更新；终态冻结 |

## 13. 文件级实施边界

预计直接修改：

- `src/renderer/components/agent/chat-panel/markdown/index.tsx`
- `src/renderer/styles/markdown.css`（仅现有 `.ready-agent-prose` scoped native list marker；不得把规则回填 `styles/index.css` 或改全局 reset）
- `src/renderer/components/agent/chat-panel/RunDurationMeter.tsx`
- `src/renderer/components/agent/chat-panel/ChatPanelBody.tsx`（仅必要消费接线）
- `src/renderer/components/agent/ChatMessages.tsx`（删除 terminalReason下游重判，只按 v3 action gate显示 Retry）
- `src/renderer/components/agent/ChatPanel.tsx`（Retry digest gate与ordinary-send consequence/actionAdmission正式入口）
- `src/renderer/components/agent/ChatHeader.tsx` 与 `src/shared/ipc-contracts/agent-lifecycle-snapshot.ts`（V2严格保留现有identity/state字段，由唯一shared pure projector新增reset/stop/close/manual-compact gates与head ref；Renderer/Main都删除snapshot下游重判）
- `src/shared/ipc-contracts/agent-runtime.ts`（区分bounded transport parse与validated ordinary/explicit Retry exact union；新增typed `explicit_retry_control_invalid` pre-persistence response，不能让结构可解析的语义矛盾payload在IPC层直接throw）
- `src/shared/resume-lexicon.ts`（Renderer/Main复用同一strict retry parser；若无需改则作为verified no-change consumer）
- `src/main/modules/claude-bridge/ipc/conversation-group.ts` 与其 `ConversationGroupDeps`装配（新增按scope原子读取action-surface envelope，不伪造readyRunId）
- `src/preload/index.ts`、`src/renderer/types/electron.d.ts`（typed action-surface read/event bridge）
- `src/main/modules/agent-control/codex-runtime/codex-model-gateway.ts`
- `src/main/modules/agent-control/codex-runtime/codex-model-gateway-contract.ts`（接纳并绑定唯一 typed uncommitted-tail additional context）
- `src/main/modules/agent-control/codex-runtime/codex-turn-collector.ts`
- `src/main/modules/agent-control/codex-runtime/codex-provisional-inbound-buffer.ts`
- `src/main/modules/agent-control/codex-runtime/codex-automatic-compaction-evidence.ts`、`codex-manual-compaction-controller.ts`（producer把native turn/readback接到e2 formal Ready-origin mapping；Retry覆盖B不覆盖control R，manual不只传turnIds）
- `src/main/modules/agent-control/codex-runtime/codex-product-closeout-support.ts`
- `src/main/modules/agent-control/codex-runtime/codex-pending-interaction-restart.ts` 与 `src/main/modules/agent-control/safety/frozen-call-store.ts`（closeout同事务关闸；constructor移除全表boot expiry，generic显式sweep排除Codex rows；late answer/confirmation CAS拒绝）
- `src/main/modules/agent-control/safety/frozen-call-confirmation.ts`（confirmation create经repository冻结owner ref；waiter消费已提交`ActionConfirmationTransitionOutcome`，删除await后的第二次release/deny/expire与session/question猜关联）
- 新的小型 `src/main/modules/agent-control/codex-runtime/codex-interaction-transition-repository.ts`（raw DB单事务串行化Codex ask-card与confirmation canonical transitions；不复制答案/decision）
- `src/main/modules/claude-bridge/ask-user-questions-card-persistence.ts`（Codex-bound pending create改走同一repository）
- `src/main/modules/ask-user-questions-sweep.ts`、`src/main/modules/database.ts`、`src/main/modules/claude-bridge/ipc-handler.ts`（所有generic boot/session sweep先调用统一ownership resolver：仅`proven_non_codex`可写；`exact_codex`由repository settle，`codex_shaped_ambiguous`由同repo一次终态化；严格排在Codex boot closeout之后）
- `src/main/modules/tools/builtins/ask-user-questions.ts` 与 `src/main/modules/claude-bridge/ipc/ask-user-group.ts`（调用原子repository更新canonical meta/content projection并返回derived typed view；不新建answer receipt正文，commit后才解内存waiter）
- `src/main/modules/agent-control/runtime-core/remote-channel-service.ts`（verified consumer：远程cancel继续只复用`cancelAskUserQuestionsCardCore`，不得新增数据库写分支）
- `src/main/modules/tools/skill-primitives/ephemeral-execution-store.ts`（`skill_ask_user`按run prepare/commit/rollback terminal fence与`rejectByRun`；零持久答案）
- 新的、单一用途纯模块 `codex-terminal-facts.ts`（immutable fold + current-action projection 两个具名函数）
- 新的叶子模块 `codex-history-continuity-policy.ts`（accepted-head/coverage lineage/live-tail/origin-policy纯函数；repository只供原子读写，不承载policy）及focused tests
- `src/main/modules/agent-control/codex-runtime/codex-product-turn-presentation.ts`
- `src/main/modules/agent-control/codex-runtime/codex-ingress-preparation-error.ts`
- `src/main/modules/agent-control/codex-runtime/codex-app-server-client.ts`
- `src/main/modules/agent-control/codex-runtime/codex-native-runtime.ts`
- `src/main/modules/agent-control/codex-runtime/codex-runtime-composition.ts`
- `src/main/modules/agent-control/codex-runtime/codex-start-identity-registry.ts`
- `src/main/modules/agent-control/codex-runtime/codex-durable-start-dispatch.ts`
- `src/main/modules/agent-control/codex-runtime/codex-boot-recovery-actions.ts`
- `src/main/modules/agent-control/codex-runtime/codex-product-boot-recovery.ts`
- `src/main/modules/agent-control/codex-runtime/codex-runtime-boot-reconciler.ts`
- `src/main/modules/agent-control/codex-runtime/codex-thread-resume-authority.ts`（持久并核验 typed resume effective settings）
- `src/main/modules/agent-control/codex-runtime/codex-thread-archive-owner.ts`
- `src/main/modules/agent-control/codex-runtime/codex-thread-archive-cleanup.ts`
- `src/main/modules/agent-control/codex-runtime/codex-model-gateway-authority.ts`
- `src/main/modules/agent-control/codex-runtime/codex-product-lifecycle-store.ts`
- `src/main/modules/agent-control/codex-runtime/codex-product-run-preparer.ts`（e2 union与zero-execution explicit Retry gate）
- `src/main/modules/agent-control/codex-runtime/codex-product-turn-authorization.ts`（requestEnvelope+skill authorization唯一组合器：ordinary用commit，Retry对effective B用observe再接ceiling；不复制envelope/skill classifier）
- `src/main/modules/agent-control/codex-runtime/codex-runtime-composition.ts` 的 `CodexRuntimeHostPort`、`src/main/modules/agent-control/runtime-core/runtime.ts`装配及`sendScoped`首步raw Retry validator、`codex-host-orchestrator.ts`、`agent-sdk-skill-intent-utils.ts`、`skill-turn-authorization-resolver.ts`、`agent-sdk-types.ts`、`agent-sdk-runtime.ts`（仅作为共享resolver的ordinary commit调用方，不是Codex生产权威）、`src/main/modules/agent-control/skills/skill-tool-authorization.ts`、`skill-context-orchestrator.ts`、`skill-reference-hints.ts` 与 `codex-tool-surface.ts`（一次pure hint snapshot；唯一resolver显式`observe|commit`且无默认；observe零TTL/delete/emit/remember；Retry要求definitions exact、synthetic-host差集为空，并用既有authorization schema求交）
- `src/main/modules/agent-control/codex-runtime/codex-tool-bridge.ts`、`src/main/modules/tools/tool-executor.ts`、`src/main/modules/agent-control/safety/action-confirmation-policy.ts`、`authorization-fact-store.ts`（ordinary bridge现有host primitive行为不动；Retry断言synthetic-host差集为空且重建前后canonical auth相等；Retry dispatch显式禁止读取/consume live authorization fact，ordinary路径不变）
- `src/main/modules/agent-control/codex-runtime/codex-turn-input-builder.ts`
- `src/main/modules/repositories/agent-session-checkpoint-route.ts`（DurableRequestAnchor/sourceMessageId只消费e2 canonical current input ref，Retry锚B不锚control R）
- `src/main/modules/agent-control/ready-memory/ready-memory-repository.ts`、`ready-memory-runtime-service.ts`、generation/consolidation写入口与shared types（所有global revision mutation由实际outer owner commit-after event；稳定eligibility digest排除read-time字段；source admission遇Retry/delivered-tail formal mapping fail-closed，不复制payload/扩证据schema）
- `src/main/modules/claude-bridge/ipc/ready-memory-group.ts`、`src/preload/index.ts`、`src/renderer/types/electron.d.ts`、`src/renderer/stores/useAgent.ts`（新增typed memory-state change bridge，触发per-run hydration；Renderer不重算eligibility）
- `src/main/modules/agent-control/codex-runtime/codex-product-action-requester.ts`、`codex-product-effect-identity.ts`及direct tests（nested product action改走bound begin，传入exact parent/run/call/ordinal；不靠tool output反查）
- `src/main/modules/agent-control/codex-runtime/codex-tool-action-journal.ts` 与 `codex-tool-binding-repository.ts`（新增`beginBoundProductEffect`原子归属索引；closeout pending->terminal settle与zero-activity查询；不新增跨run复用）
- `src/main/modules/agent-control/codex-runtime/ready-codex-lifecycle-adapter.ts`（四个lifecycle入口只重算/消费shared V2 gate再做原owner CAS，删除本地状态分支重判）
- `src/main/modules/claude-bridge/ipc/agent-lifecycle-group.ts`（Main IPC正式消费者：四个lifecycle channel原样传递action-matched V2 requestRef；sendScoped只做transport parse，结构可解析的invalid explicit control必须返回typed pre-persistence response而非throw；register test锁四动作与send返回值）
- `src/main/modules/agent-control/codex-runtime/codex-binding-schema.ts`（`codex_product_effect_bindings` immutable/no-delete parent guards；archive保留binding与receipt）
- `src/main/modules/migrations.ts` 与具名 `118_codex_native_continuity_terminal_head_v3` helper/native upgrade test（以实施时仍为next available为CAS前提；若编号已占用先顺延并更新引用）
- `src/main/modules/agent-control/codex-runtime/codex-binding-repository.ts`（只放原子 SQL/约束消费，不放 policy）
- `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts`（只做 orchestration 接线；request/intent/route/tool/Browser source/obligations/output targets统一消费effective semantic ingress，不放第二个 reducer）
- `src/main/modules/agent-control/codex-runtime/codex-explicit-retry-lineage.ts`
- `src/renderer/modules/agent/explicit-retry-routing.ts`（exact-retry自然短语只在显式资源为空时转explicit；raw文档观测保留并交Main唯一prepare解析；不清附件/引用/目标）
- `src/renderer/modules/agent/error-message-mapping.ts`（区分 materializing 与 reset-required，composer均保留）
- `src/renderer/modules/agent/productTurnReceipt.ts`
- `src/renderer/modules/agent/runtime-driver-canonical-terminal.ts`
- `src/renderer/modules/agent/runtime-driver-scope-events.ts`
- `src/renderer/stores/agent-send-orchestration.ts`
- `src/renderer/stores/useAgent.ts`及直接state/helper类型（维护按scope head与按runId两张内存projection map、hydration/version gate，不重判或持久化 action）
- `src/main/modules/agent-control/send-scoped-confirmation.ts` 与 `runtime-core/runtime.ts`（只接 history-seeded head 的 pre-persistence gate）
- 直接行为测试、native tests、fixture/probe 和安装证明脚本
- `package.json`（只把新增native tests接入现有`verify:native` gate；不改version、依赖或其他脚本语义）
- `docs/architecture/current-runtime-contracts.md` 与 exit-authority matrix 的生成源/产物
- `docs/code-health/large-file-health-log.md`（按所有净增代码文件动态检查，不只预列两份大文件）

实施前后各运行一次 `rg` 生成 `thread/start|turn/start|thread/fork` method union、thread identity、boot list/read/resume、archive eligibility、Gateway attestation、ProductTurnReceipt、lifecycle action、ReadyMemory revision mutation/event、interaction transition，以及`requestEnvelope|intent|route|tool snapshot|obligations|output/targets|TurnInputBuilder` semantic-ingress consumers的exact清单；清单中每个live consumer必须更新或由行为测试证明无需修改，不能只在client/type层加method或让control R漏进某个下游。

禁止借机修改：

- session recall、旧 AgentSdkRuntime、ReadyAgentOrchestrator、direct-chat、turn-engine；ReadyMemory只允许本计划明确列出的stable Retry eligibility、global revision event/投影刷新，以及formal model-input mapping不等于单一ordinary origin时的fail-closed source-admission guard；不改长期记忆内容、生成/选择策略或复杂证据schema；
- Dynamic Delivery、Boost、worker/owner、旧 resume/checkpoint successor；
- 与当前故障无关的 Browser、RSS、Pet、MCP 或技能重构；
- runtime 版本、release version 或模型默认值。

收尾以 `git diff --numstat`枚举**所有净增代码文件**并检查总行数，不只预判binding repository/production composition。当前 `migrations.ts`、`ChatPanel.tsx`、`useAgent.ts`以及两份Codex大文件都可能命中危险门；新增policy优先放纯reducer/小型叶子模块，任何>1000行且净增的文件都按根指引更新large-file health log与风险/复查信息，不以顺手重构扩大计划。

## 14. 验证命令与证据分层

实现阶段先根据 `package.json` 核对实际脚本，再运行至少：

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/chat-content-visual-contract.test.tsx \
  src/__tests__/agent-run-duration-meter.test.ts \
  src/__tests__/run-duration-meter-heartbeat.test.ts \
  src/__tests__/codex-product-closeout-support.test.ts \
  src/__tests__/codex-automatic-compaction-evidence.test.ts \
  src/__tests__/codex-manual-compaction-controller.test.ts \
  src/__tests__/codex-explicit-retry-lineage.test.ts \
  src/__tests__/codex-explicit-retry-control-envelope.test.ts \
  src/__tests__/send-scoped-explicit-retry-preflight.test.ts \
  src/__tests__/codex-retry-capability-ceiling.test.ts \
  src/__tests__/skill-authorization-observe-commit.test.ts \
  src/__tests__/natural-explicit-retry-routing.test.ts \
  src/__tests__/codex-agent-runtime-contract.test.ts \
  src/__tests__/codex-renderer-admission-contract.test.ts \
  src/__tests__/skill-reference-hint-persistence.test.ts \
  src/__tests__/skill-allowed-tools.test.ts \
  src/__tests__/agent-sdk-runtime.test.ts \
  src/__tests__/codex-tool-bridge.test.ts \
  src/__tests__/codex-retry-execution-authorization.test.ts \
  src/__tests__/action-confirmation-policy.test.ts \
  src/__tests__/authorization-fact.test.ts \
  src/__tests__/codex-ingress-preparation-error.test.ts \
  src/__tests__/codex-model-gateway-contract.test.ts \
  src/__tests__/codex-product-action-bridge.test.ts \
  src/__tests__/codex-product-turn-authorization.test.ts \
  src/__tests__/codex-product-run-preparer.test.ts \
  src/__tests__/codex-semantic-ingress-consumers.test.ts \
  src/__tests__/product-turn-receipt-renderer.test.ts \
  src/__tests__/product-turn-action-projection-store.test.ts \
  src/__tests__/codex-head-action-projection.test.ts \
  src/__tests__/codex-lifecycle-operation-snapshot.test.ts \
  src/__tests__/ready-codex-lifecycle-adapter.test.ts \
  src/__tests__/agent-lifecycle-group-register.test.ts \
  src/__tests__/conversation-group-register.test.ts \
  src/__tests__/ready-memory-group-register.test.ts \
  src/__tests__/codex-action-surface-event-bridge.test.ts \
  src/__tests__/codex-reset-action-handoff.test.ts \
  src/__tests__/codex-retry-default-document-handoff.test.ts \
  src/__tests__/codex-pristine-head-refresh-native.test.ts \
  src/__tests__/codex-renderer-lifecycle-contract.test.ts \
  src/__tests__/ready-memory-retry-action-refresh.test.ts \
  src/__tests__/frozen-call-release.test.ts \
  src/__tests__/ask-user-terminal-race.test.ts \
  src/__tests__/renderer-error-mapping.test.ts
node scripts/check-css-cascade-layer-reset.cjs
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron ./node_modules/tsx/dist/cli.mjs \
  --test --test-concurrency=1 \
  src/__tests__/codex-product-turn-presentation-native.test.ts \
  src/__tests__/codex-binding-repository-native.test.ts \
  src/__tests__/codex-tool-action-journal-native.test.ts \
  src/__tests__/ready-memory-repository-native.test.ts \
  src/__tests__/ready-memory-runtime-service-native.test.ts \
  src/__tests__/codex-thread-archive-cleanup-native.test.ts \
  src/__tests__/codex-interaction-transition-repository-native.test.ts \
  src/__tests__/ask-user-terminal-race-native.test.ts \
  src/__tests__/migration-118-codex-native-continuity-native.test.ts
npm run verify:codex-runtime-source
npm run verify:codex-runtime-e0r
npm run verify:codex-turn-delivery
npm run verify:codex-tool-bridge
npm run verify:codex-runtime-e2
npm run verify:codex-model-gateway
npm run verify:stability
npm run verify:streaming
npm run verify:ipc-contract
npm run verify:native
npm test
npm run verify
npm run typecheck
npm run build:dist
shasum -a 256 "<本次 build:dist 在 exports/ 新产出的 Ready-版本-架构.dmg>"
node scripts/run-codex-context-continuity-installed-proof.mjs "<上一步同一个绝对 DMG 路径>"
node scripts/run-codex-context-continuity-installed-proof.mjs \
  "<同一个绝对 DMG 路径>" --profile-mode=upgrade --legacy-db-fixture="<pre-118 fixture>"
```

`verify:ipc-contract`与全量`npm test/npm run verify`是跨Main/Preload/Renderer/shared resolver改动的正式门，focused register tests不能替代；若dirty baseline已有无关失败，必须先在未接管快照复现、记录exact差异，并证明本次新增/受影响test全绿，禁止用skip或口头“历史失败”算通过。`build:dist`开始前记录source/package/runtime/schema digests与开始时间；只接受命令报告、mtime晚于开始且digests回读相符的DMG。安装证明复用同一路径/SHA，不按“最新文件”猜。必须跑两个隔离profile：fresh profile验证正常主链；upgrade profile从真实pre-migration schema fixture复制出旧DB/e1 pending/legacy/malformed-ingress rows及“无codexRunIdentity但requestId命中Codex run”的pending card，再由**同一新DMG首启**迁移，验证schema/index/trigger parity、e1 fence只开放reset/close、reset后e2、legacy `unavailable_legacy` projection零synthetic refs、ambiguous interaction一次终态化/二启幂等、late tool/answer CAS。不得触碰用户真实profile。focused native tests在正式并入verify:native前保持必跑。

两份interaction native test必须正式并入`package.json`的`verify:native`；在并入完成前，上述Electron命令是不可省略的发布前gate。repository test覆盖ask pending create、canonical meta/content+FTS submit、local/remote user-cancel，confirmation linked create/atomic respond/deny/TTL-expire，以及每种transition-first/closeout-first、双行写中间crash不可见、release只有commit后才返回params、late transition零写；race test覆盖ordinary-vs-ordinary/ordinary-vs-confirmation/confirmation-vs-confirmation create只能一条pending、ownership三态、terminal-before-settle crash、ambiguous boot一次终态化/二启幂等/list零pending、Codex boot先于generic sweeps、constructor零写、generic只处理proven non-Codex。`frozen-call-release.test.ts`还必须从真实caller证明await已提交outcome后不会再调用第二次release/deny/expire。

证据必须分层：

1. **协议探针**：pinned binary/schema、thread/read/resume/fork、compaction、fault injection。
2. **源码行为**：旧实现红测、新实现绿测、真实入口与 exact request capture。
3. **原生持久化**：SQLite transaction、boot/crash reconciliation、stale event rejection、archive cleanup。
4. **Electron UI**： authored ordinals、单一 live 状态、failure/next action 显示。
5. **构建与包体**：source hash、app.asar、runtime binary/schema、DMG hash/signature。
6. **隔离安装**：同一包、隔离 profile、真实 packaged main/renderer/runtime/DB/provider fixture。
7. **真实 Provider**：只有用户明确授权后才做；未做时只能宣称 deterministic installed proof，不能宣称真实外部生产已验证。

## 15. 删除与迁移策略

- 新具名migration负责把旧安装库升级到与clean `CODEX_BINDING_SCHEMA_SQL`等价的schema：terminal facts/readback、head action sequence、materialization/seed/supersession字段、coverage表、`codex_product_effect_bindings` ownership index、parent/immutable/no-delete triggers与Gateway failure rebuild全部在同一migration合同中落地；不得只改fresh-DB schema。effect binding与其action receipt都为append-only审计事实，archive不删除；legacy receipt没有可证明owner binding时只保留审计并令Retry evidence incomplete，不做hash反推回填。native test从真实pre-migration fixture升级，逐表/列/index/trigger与clean DB等价回读，并验证旧行无损、重复运行幂等。
- prepared/ingress schema直接从 `codex_product_run_e1`切到 `codex_product_run_e2`：删除 `recoveredContextDigest` 的类型、schema、固定null writer与测试；新增ordinary/actionAdmission/supersession和explicit-retry/predecessor两个exact-key分支；不保留deprecated字段、optional默认值或双读。
- 已持久化e1 prepared/pending run一律进入 `legacy_prepared_contract_reset_required`：boot不把缺失数组推成`[]`，不补造action admission/supersession，也不在同一run转写e2。用户reset后以完整输入新建e2 run；e1已终态行只保留审计和保守v3呈现。schema、turn-input、ingress persistence与boot tests都必须覆盖e1/e2不能混续。
- e1 pending若仍持有active run/thread/turn-start fence，head/per-run projector把send/retry阻断；现有lifecycle projection是唯一开放reset/close的owner。reset事务原子推进epoch/canonical close-reset evidence、abandon/quarantine旧start intent、释放旧active fence并让迟到事件CAS失败；**事务完成后的下一条**ordinary输入才在新fresh-start head创建e2。不得直接把e1 row/fence改写或“恢复”为e2。
- `ready_model_gateway_exchange_events`用SQLite rebuild-copy-swap迁移扩展 `response_failed`：无损复制既有 admitted/completed行并恢复immutable/no-delete triggers；CHECK强制failure JSON/digest只在failed非空、completed字段只在completed非空；partial unique index/trigger保证同一request receipt最多一个terminal event，`response_completed`与`response_failed`跨行互斥而非只靠 `(receipt,event_kind)`。旧库迁移无损、failed-vs-late-completed CAS与failed后崩溃boot closeout exactly-once必须跑native test。
- 删除 ProductTurnPresentation 的 failure regex classifier。旧 turn 没有 terminal facts 时，只展示已有 canonical message/tool/artifact；不得推导 history safety、retry policy或 available actions，Retry 默认禁用。
- schema migration 把所有旧 binding 标成 `thread_materialization_kind='legacy'`，绝不默认 `fresh_start`。
- legacy binding 的 `action_projection_sequence` 从 0 初始化；任何迁移/后续 terminal/materialization变化只通过唯一 increment helper推进。
- 已经 start/使用过的旧空 successor 保留其真实 native generation，不追溯合并；projection 明确标 `legacy_context_boundary`，不承诺更早可见消息在模型历史中。普通输入只延续它现有 native history，旧 failure receipt不能控制新 run；用户可重述或 reset。其后新e2 turn可正常product success/failure，但product/automatic closeout都不写coverage或建立accepted-head authority，其model-input origins也不进入live-tail/supersession模型；binding始终legacy，ordinary只延续native thread且UI consequence为空，后续divergence只要求reset。本计划不新增legacy-prefix bootstrap receipt/validator兼容层。
- legacy 行没有本计划要求的 typed terminal facts/source digest，任何 pristine/unstarted旧 successor也不得自动转成 `native_fork` 或 `fresh_root_with_tail`；统一保持 `context_recovery_required/reset`。本计划不为一次性迁移另造 provenance、兼容 seed或第二套 validator。
- source 已归档、候选不唯一、配置/epoch/turn/digest不明同样保持 `context_recovery_required/reset`；不得 unarchive自动修、不得按相邻消息猜 predecessor、不得静默 fresh start。
- 删除 `resolveUserIngressAliasBinding` 内 publication-diverged/used-head-drift通用空generation分支及其 `insertEmptyAliasGeneration`调用；结构gate与行为测试必须证明只有new-scope/reset/canonical-closeout和具名`refreshPristineFreshStartHeadAtomic`事务能创建head。后者受zero-turn/zero-message/zero-start/zero-effect完整CHECK与transaction test约束；其他缺失/漂移零user/run/Provider bytes并要求reset，绝不保留通用旧fallback作“保险”。migration同步增加`pristine_contract_refresh` retirement reason及fresh/upgraded schema parity。
- 旧 failure copy 不反向改写；新的 copy 只来自 immutable terminal facts，不包含动态动作承诺。
- 不提供 Ready history fallback、session search fallback、summary fallback 或 fork 重发 fallback。

## 16. 独立对抗性审查门

审查者必须逐条回答，不能只写“总体合理”：

1. 是否仍有普通 Provider failure 被 blanket retire？
2. 是否有真实 divergence 被 same-thread 继续？
3. 是否有同一事实被写入 turn binding、run meta、task projection、message meta、Renderer store 后再相互校验？
4. 每个新增字段是否有 producer、validator、live/boot/archive consumer 与 stale rejection？
5. fork unknown 是否存在任何盲重发或 silent fresh start？
6. accepted native prefix head 是否只由 product-accepted turn与verified compaction推进，而非“有 closeout/seal”、UI message 或模型判断？
7. task retry lineage 与 generation lineage 是否完全分开？
8. resource/tool/skill/action/output-contract 是否在 fork 后重新冻结？
9. 任一tool/action/interaction/effect evidence是否一律关闭exact Retry，同时普通新消息仍按head合同可用且旧receipt零跨run消费？
10. failure copy 是否只陈述 immutable facts；按钮与 ingress 是否消费同一份不落库 available-action projection，而 terminal parent/send response 没有冒充任务 Retry？
11. compaction 是否仍只有 native owner，且 accepted history/current input 都恰好一次？
12. reset、close、stop、first-turn failure、QC rejection、partial output、uncommitted user tail、tool effect、manual/automatic compaction、runtime/tool drift、archived source、willRetry与 crash seams是否都有反例？
13. UI 是否用一个语义 `<ol>` 而非逐行 marker/counter；live elapsed 是否保留且只出现一个 label，并且两者保持 Renderer-only？
14. 是否新增了 fallback、兼容双读、旧路径复活或第二套状态机？
15. 包体验收是否读取真实 Gateway/native/DB 证据，而不是只看 Renderer？
16. coverage是否为跨direct native-fork successor连续的增量链，且只由closeout/manual-compaction事务的同一writer追加？
17. assignment/deliveryAudit是否仍被误当live/commit；是否删除冗余resolution持久字段；ordinary supersession是否强制消费用户所见的同一actionAdmissionRef？
18. e1 prepared run是否被保守阻断而不是补默认空数组混续e2？
19. 是否彻底没有为本阶段引入通用副作用身份、跨run去重/回读/输出复用或产品动作改造；zero-execution Retry gate是否覆盖read-only tool与answered card？
20. Renderer是否按runId保存当前已加载terminal投影，旧failure刷新不会因active request变化而消失，同时memory/boot hydration不会扫描全库且没有写回message meta？

任一 P0/P1 未关闭，review 状态保持 `changes_requested`。只有两名独立审查者均给出 `PASS`，且 outstanding P0/P1/P2 均为 0，本文 `review_status` 才能改为 `passed`。

## 17. 审查记录

### Round 1：CHANGES_REQUESTED

三条独立审查分别从 Ready 全链消费、历史反模式和 Matrix/runtime 协议攻击初稿。已确认并修订的阻断项：

- authored marker 与 live elapsed 的初始 UI 方案偏离真实用户诉求/Matrix 语义；改为 semantic `<ol>/<li>` 与保留计时只删重复 label。
- blanket failure retirement 与自己的 exit-authority matrix 冲突；same-thread safety 改为 pinned-runtime failure-seam allowlist。
- accepted-prefix fork会丢失已持久 user half-turn；新增 exact bounded uncommitted-user-tail seed与首 child turn一次性 delivery/commit分离。
- terminal decision 混入未来可变状态且单一 nextAction表达不足；拆成 immutable terminal facts、owner receipts与不落库 available-action projection。
- native fork 放在 post-persistence `ensureThread` 会让输入落库后再变 unknown；改为 closeout 后主动 materialize + 下一 ingress pre-persistence preflight；fresh root另走同一首 ingress的 persisted-run start owner。
- 旧稿曾把indeterminate effect扩大成conversation/冲突mutation阻断；最终收窄为任何执行/交互证据只关闭exact Retry，普通send仍按head合同可用。
- fork 不可覆盖 dynamic tools/root instructions，archived source也不能 fork；改为 same-contract only、source archive hold与legacy blocked/reset。
- accepted head 漏掉 verified manual compaction；新增 accepted native prefix head reducer与 product boundary双身份。
- response-loss 漏掉 `thread/started`，boot discovery 漏掉 resume；补 inbound intent binding与 list/read/resume receipt。
- legacy terminal/empty successor、typed evidence refs、willRetry、prefix 中间 safe failure和严格 seed消费链均补齐。

Round 2 在上述修订完成后重新发起。计划通过不等于实现完成；本文 `status` 在代码、gate 和安装证明完成前保持 `proposed`。

### Round 2：CHANGES_REQUESTED

三条审查继续发现并关闭以下问题：

- source failure receipt 与 successor action head 的 generation 身份冲突；拆成 immutable owner generation 与 derived direct-successor head identity。
- tail在user/run落库时过早算consumed；最终只保留assignment，delivery由既有turn-start/readback receipts派生audit，live只认coverage/supersession/tombstone。
- 旧稿试图为indeterminate effect增加点击对账；Round 3判定超出本次根因，最终任何tool/action/interaction/effect evidence都关闭exact Retry，零跨runreceipt消费。
- ordinary tail可能被 application提升成 developer事实，且自然语言 mutation分类不可穷尽；纯文本统一走 untrusted user history，resource/nontext要求重新附加并完整重述，typed skill/mention/action/output要求完整重述；Retry只允许typed source-ingress ref可解出的纯文本origin，当前行动权限始终只读当前输入。
- legacy 长 thread 可能被 null cutoff误当首轮；prefix reducer新增 `proven_native_first_turn_no_prefix`，legacy永不 fresh-root。
- terminal facts重复 evidence与 history unknown无 owner；改为 product/history/effect分角色 refs，unknown永久 reset-required。
- fresh root不能在 closeout提前猜当前工具面；改为首 ingress exactly-once admission后按当前 snapshot start，同一 run恢复。
- fork unknown不能阻止 reset/close；复用 late-response guard做 abandoned/quarantine，orphan异步清理。
- `threadSource` 黑盒证明不应发送；child保持 `source=vscode/threadSource=null`。
- 旧版把 inherited、materialization与 per-turn事实塞进一个不可观测 digest；拆成三份合同，fork/resume response持久 typed effective settings，Gateway只验可见 body/metadata与当前 turn snapshot。
- Tailwind reset会隐藏 native marker；补 scoped decimal marker样式与 computed-style/Electron gate。
- 补齐 start identity、durable dispatch、boot/archive、Gateway authority等正式消费者和 exact `rg` 清单 gate。

Round 3 以本版重新从零审查。

### Round 3：PASS

- reviewed body SHA-256：`6cac69986e5b1e96d312df9fe46e03886c9921b64eb75f05e95669b432a44f16`；本SHA不含本节审查元数据。
- 独立审查者：`final_contract_review`、`ready_handoff_audit`；两者对同一正文均给出 `P0=0 / P1=0 / P2=0 / PASS`。`round3_edge_sweep`另做边缘反例复核并给出同样结论。
- 最终收口包括：delivered-tail再次失败不得误走single-user same-thread；legacy成功轮不建立coverage且不进入live-tail；raw Retry control在任何副作用/预留前做typed exact校验；资源不静默清空；skill hint observe零TTL/delete/emit，definitions exact、execution授权只收紧，Retry bridge不补权且不消费live grant；interaction pending create与transition均由数据库单线串行；action/memory invalidation只在commit后best-effort发布。
- 此PASS只证明计划合同内部一致、生产消费者与验证门完整。`status`继续为`proposed`；代码实现、构建、DMG与隔离安装仍须按§11–§14逐层通过后才能宣称完成。


## 18. 2026-09-03 已批准的入口与动作消费修订

依据 Revision 4 及限定范围审查，用户已授权实施第 1–2 步及直接相关的重复判定清理。rollback/revert、扩大 safe-seam 集合、持久字段删除不在本批范围。

机器验收合同（先于实现）：

- `codex-retry-default-document-handoff.test.ts`：真实默认文档与 browser/document 分屏保留观测，自然重试及按钮仍携带精确前驱进入 Main；继续类文本走 ordinary。
- `send-scoped-explicit-retry-preflight.test.ts` / `codex-explicit-retry-control-envelope.test.ts`：两端 exact-retry 词义一致；早期校验允许 raw 观测，拒绝明确资源/附件/新正文。
- `codex-exact-retry-eligibility.test.ts`：projection 不伪造 current facts；pre-persistence 缺失或不完整事实拒绝；source/current 分别检查；同线程与真实 compaction coverage 给不同 blocker。
- `codex-binding-repository-native.test.ts` / `codex-product-turn-presentation-native.test.ts`：持久覆盖事实驱动 blocker；两种后继、陈旧来源及原任务单次输入保持成立。
- `codex-retry-production-handoff.test.ts`：真实 Main prepare 消费默认文档、browser/document 分屏、正常/空/降级页面与当前目标变化；B 决定资源激活，R 仅保留审计，真实资源拒绝后不落库。
- `codex-renderer-lifecycle-contract.test.ts`：原子读取失败具名 head_unavailable，用户可重读；保留草稿、零自动发送；保留 scope/epoch/版本下界并拒绝旧读取。
- `chat-panel-baseline.test.ts`：真实组件显示省略数量/资源数量，点击携带所展示 head 引用；集合变更在 Main 持久化前拒绝，重新读取后由用户再次发送。
- `scripts/run-codex-context-continuity-installed-proof.mjs`：同包 fresh/upgrade，真实默认文档 Retry 按钮与自然语言重试、两种后继、资源拒绝、控制语义拒绝与省略后果展示；记录实际 Main/Provider 输入，拒绝场景零 run/Provider。环境变化、压缩覆盖、读取恢复与省略集合竞态分别由上述真实 Main/SQLite/组件行为测试证明，不把替身读口或源码测试描述成安装态覆盖。

动作恢复复用现有原子 hydrate 及其 scope/epoch/序号保护；不新增持久动作账本，不自动重发任务。普通发送与按钮复用现有 Main head/per-run 决定与同一上下文匹配函数。所有新增持久字段为零。
