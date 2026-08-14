---
title: Codex 内核下 Browser 接线第一性原理计划
date: 2026-08-14
status: implemented-slice
review_status: pending
reviewed_at: 2026-08-14
note: >
  只审查 Ready Browser 与固定 Codex 0.146.1 的接线。不复活第二套模型循环，
  不启用内核 hosted browserUse，不把 Matrix 0.1.85 的内层 Browser Agent 抄进 Ready。
  2026-08-14 已关闭执行绑定、技能零 Browser、页签越界、指针异步空窗、
  关闭通知重放、摘要结算身份，以及 observe/mutate 换页核对、观察入账前
  身份闸、click/type/collect 冻结代次、文字/按键发送前共用页面核对、
  Enter 按下后换页按部分生效结算，以及部分滚动结算。后续硬化计划已补
  click/drag 的 press 结算和 upload 精确回读/赋值前身份；下载消费者仍隐藏。
  08-14 §10 已删除的 BrowserView 巨门不移交、不重开。后续见
  docs/superpowers/plans/2026-08-14-codex-surface-hardening-and-split-implementation.md。
enforce: true
depends_on:
  - docs/architecture/current-runtime-contracts.md
  - docs/superpowers/plans/2026-08-11-ready-codex-matrix-wiring-closure-implementation.md
  - docs/superpowers/plans/2026-08-13-codex-capability-relight-index.md
  - docs/superpowers/audits/2026-07-24-chatgpt-app-agent-browser-runtime-study.md
  - docs/superpowers/audits/2026-07-24-ready-vs-chatgpt-agent-browser-gap-audit.md
evidence_inputs:
  - path: /Users/user/matrix-unpack/analysis/matrix-browser-v0.1.85/00-README.md
    sha256: 39c215f08b3c7f7d7dac1b320a12993586ce831947d4dc00cfe06d87e43c3328
    role: local_comparison_only
    enforce: false
---

# Codex 内核下 Browser 接线

## 0. 本计划何时算完成

本计划只定义实现合同，不把文档审查通过冒充代码或实机验收。实现完成必须同时满足：

1. Browser 的模型可见工具、operation、根 target 与派生规则来自同一份准入前冻结快照；精确运行期 target 只能来自绑定到该快照的 durable causal authority lineage。旧轮、旧页和自然语言猜测不能扩权。
2. 当前文档、当前 Browser 工作面、显式网页引用和技能可以组合，不再互相覆盖；显式网页引用只能读取，不能借引用获得点击权。
3. 下载在同一 Browser session 内完成，并有可重放、可 readback、绑定 run/turn/call/target/file/hash 的持久回执；失败或断线不能重复下载。
4. 任一 run 终态都释放全部 target claim；物理页签与临时授权通过持久 finalize intent 幂等清理，不把 Electron 副作用伪装成 SQLite 原子事务。
5. 所有指针路径在物理投递前重读 foreground/visible/active generation；投递前拒绝与「可能已经投递但不可确认」使用现有 action outcome 的不同组合，不能盲重试。
6. 自动化门覆盖真实生产组合器、模型网关、dispatch、native journal/claim/finalize/download 和真实 Electron BrowserView fixture；出包后再补登录站点体验证。
7. 独立对抗审查的 P0/P1/P2 全部清零。若保留风险，必须写成明确接受项并给出证据、责任人与复查条件；本计划当前不预留此类例外。

## 1. 范围与已定结论

生产主链只有：

```text
CodexHostOrchestrator
  → Codex ingress / product composition
  → ReadyCodexLifecycleAdapter
  → canonical closeout / projection
```

Browser 仍是 Ready 自己的 Electron BrowserView。Codex 只使用准入时注册的 `browser_*` 函数工具；不增加 `browser.task.message`、第二个 Browser Agent、Playwright 浏览器或非用户触发的 successor。

固定 `rust-v0.146.1` 只允许在 `thread/start` 注册 dynamic tools，`turn/start` 只能冻结其子集。因此：

- `use_browser` / `use_skill` 不得回到模型面；模型在 turn 内不能二次扩权。
- Ready 不声明 `browserUse` / `computerUse` 可选要求，固定 `thread/start` 合同也没有对应的 Ready 宿主控制路径，所以本计划不启用它们。现有证据不足以断言它们一定会启动或争抢某个会话，不写这种推断。
- 天气、新闻、股价等公开实时事实默认走 `web_search_domains / web_search / web_fetch`。只有可信当前 Browser 页面、显式只读网页引用或本轮已选技能，才可能打开 Browser 工具。
- 当前没有公开续跑。历史 `childRunId`、checkpoint、`canResume` 和「继续」文案都不能形成下一轮执行权。

## 2. 证据裁决

### 2.1 前置计划与当前代码

| 前置结论 | 本轮裁决 | 本计划如何处理 |
| --- | --- | --- |
| 08-11 域 11 的动作身份、观察屏障、fresh verifier、覆盖层归属 | `inherited` | 保留，不重造第二套状态机 |
| 08-11 对 Browser child closeout 已闭合的表述 | `partially_inherited_and_doc_drift` | canonical transaction 已释放 `held` claim；但其它 live claim、tab provenance/finalize outbox 和物理清理未闭合，不能笼统宣称 Browser closeout 已完成；B4 落地时同步修正前置权威状态 |
| 08-13 的 exact claim 重读和 `completed/rejected/unknown` 回执 | `inherited_but_incomplete` | 普通动作保留；下载和 Codex terminal closeout 尚未消费这份合同，分别由 B3/B4 补齐 |
| 07-24 的 `use_browser`、公开续跑、第二执行计划 | `retired` | 不恢复，也不作为本轮入口 |

### 2.2 当前代码事实

1. `BROWSER_INTERACTION_TOOL_NAMES` 当前等于全部 `BROWSER_PUBLIC_TOOL_NAMES`，`BROWSER_CONTENT_TASK_TOOL_NAMES` 为空。它们不是可继续沿用的最小分组。
2. `browser_tabs` 同时包含 list/open/switch/close；`browser_dialog`、`browser_collect`、`browser_download` 等也混合多种 operation。当前授权只检查工具名，不能把整名工具称为只读。
3. 无精确 tab/page 绑定时，部分观察工具会回退当前 active tab。仅有「Browser host 可用」不能授权读取用户当前页。
4. production composition 会让显式 browser reference 覆盖 active workbench；product envelope 又可能因 `currentDocumentAnchor` 强制写成 document。两处共同造成工作面和资源身份互相覆盖。
5. `browser_download` 被当作 state-patch 工具从 Codex root/turn 面整名排除；下载结果虽然带 `projectionPatch/contextModifier`，Codex bridge 没有持久消费它。
6. Codex terminal 路径除了清内存 lease，canonical transaction 已用 raw-DB helper 原子释放 `held` claim；缺口是 `user_owned/suspended` live state、tab provenance/finalize outbox 和物理 reconciler。`BrowserTargetClaimService.closeoutRun()` 自己开启事务，不能嵌入现有 canonical transaction。
7. click 已有 foreground readiness；hover、scroll、drag 和带滚动的 collect 仍可绕过同一物理投递边界。

这些是实现缺口，不再沿用「host 默认只读地板」「终态保留 claim」或「同一 DB 事务物理关 BrowserView」三种错误前提。

## 3. 机器合同

### 3.1 准入快照与 native 执行绑定

在调用 `resolveReadyToolTurnSnapshot` 前，由 Main 从可信宿主状态构造并冻结 `BrowserAdmissionAuthoritySnapshot`。最少字段是：

```ts
type BrowserAdmissionAuthoritySnapshot = {
  authorityId: string
  authorityDigest: string
  scopeId: string
  turnRequestId: string
  aliasGeneration: number
  messageVisibilityEpoch: number
  activeWorkbenchMode: 'browser' | 'document' | 'rss' | 'calendar' | null
  currentBrowserRoot: TrustedBrowserPageRef | null
  explicitBrowserReadRefs: readonly TrustedBrowserPageRef[]
  attachmentRefs: readonly TrustedAttachmentRef[]
  writableRoots: readonly TrustedWritableRoot[]
  selectedSkillToolNames: readonly string[]
  subtractivePolicies: readonly (
    | 'browser_negated'
    | 'public_research'
    | 'tag_forge_exclusive'
  )[]
  rootSurfaceContractVersion: string
}

type BrowserToolExecutionBinding = {
  admissionAuthorityDigest: string
  readyRunId: string
  parentTaskId: string // exact product readyTaskId
  browserTaskId: string
  codexThreadId: string
  codexTurnId: string
  journalRouteDigest: string
  bindingDigest: string
}

type BrowserRunEffectFence = {
  readyRunId: string
  parentTaskId: string
  browserTaskId: string
  ownerMainBootId: string
  generation: number
  state: 'active' | 'closing' | 'closed'
  effectCommandRef: string | null
  effectCommandDigest: string | null
  transitionChainHeadDigest: string | null
}

type BrowserEffectFenceTransitionReceiptBase = {
  version: 1
  receiptRef: string
  readyRunId: string
  commandRef: string
  commandDigest: string
  previousReceiptDigest: string | null
  productFenceBefore: { ownerMainBootId: string; revision: number }
  productFenceAfter: { ownerMainBootId: string; revision: number } | null
  effectFenceBefore: {
    ownerMainBootId: string
    generation: number
    state: 'active' | 'closing'
    commandRef: string | null
    commandDigest: string | null
  }
  effectFenceAfter: {
    ownerMainBootId: string
    generation: number
    state: 'closing' | 'closed'
    commandRef: string
    commandDigest: string
  }
  createdAt: string
}

type UnsignedBrowserEffectFenceTransitionReceipt =
  | BrowserEffectFenceTransitionReceiptBase & {
      transition:
        | 'select_terminal_command'
        | 'select_owner_loss_or_lifecycle_command'
        | 'replace_lifecycle_recovery_command'
        | 'transfer_closing_owner'
      productFenceAfter: { ownerMainBootId: string; revision: number }
      effectFenceAfter: BrowserEffectFenceTransitionReceiptBase['effectFenceAfter'] & {
        state: 'closing'
      }
      derivedCanonicalInputDigest: null
      productTerminalDigest: null
    }
  | BrowserEffectFenceTransitionReceiptBase & {
      transition: 'canonical_close'
      productFenceAfter: null
      effectFenceAfter: BrowserEffectFenceTransitionReceiptBase['effectFenceAfter'] & {
        state: 'closed'
      }
      derivedCanonicalInputDigest: string
      productTerminalDigest: string
    }

type BrowserEffectFenceTransitionReceipt =
  UnsignedBrowserEffectFenceTransitionReceipt & {
    receiptDigest: string
  }

declare const browserCloseoutOwnershipBrand: unique symbol
type BrowserCloseoutOwnershipHandle = {
  readyRunId: string
  ownerMainBootId: string
  expectedProductFenceRevision: number
  expectedEffectFenceGeneration: number
  commandRef: string
  commandDigest: string
  transitionChainHeadDigest: string
  readonly [browserCloseoutOwnershipBrand]: true
}

type BrowserEffectCommandIdentity = {
  version: 1
  commandRef: string
  commandDigest: string
  readyRunId: string
  parentTaskId: string
  browserTaskId: string
  readyScopeId: string
  readyAliasId: string
  codexThreadId: string
  codexTurnId: string
  expectedEffectFenceGeneration: number
  previousOwnerMainBootId: string
  aliasGeneration: number
  messageVisibilityEpoch: number
  productRuntimeRef: string
  productRuntimeDigest: string
  latestBrowserActionSeq: number
  createdAt: string
}

type BrowserCanonicalCloseoutCommandBase = BrowserEffectCommandIdentity & {
  toolPublicationReceiptSetRef: string
  toolPublicationReceiptSetDigest: string
}

declare const browserRuntimeFailureCodeBrand: unique symbol
type BrowserRuntimeFailureCode = string & {
  readonly [browserRuntimeFailureCodeBrand]: true
}

type BrowserRuntimeFailureDisposition =
  | {
      terminalStatus: 'interrupted'
      terminalReason: 'cancelled_runtime'
      initiator: 'codex_native' | 'codex_recovery'
      errorCode: BrowserRuntimeFailureCode
    }
  | {
      terminalStatus: 'error'
      terminalReason: 'proof_gap'
      initiator: 'codex_browser_verifier'
      errorCode: BrowserRuntimeFailureCode
    }
  | {
      terminalStatus: 'error'
      terminalReason: 'blocked_external'
      initiator: 'codex_native' | 'codex_browser_verifier' | 'codex_recovery'
      errorCode: BrowserRuntimeFailureCode
    }
  | {
      terminalStatus: 'error'
      terminalReason: 'persistence_failed'
      initiator:
        | 'codex_native'
        | 'codex_browser_verifier'
        | 'codex_recovery'
        | 'codex_host_failure_recovery'
      errorCode: BrowserRuntimeFailureCode
    }

type BrowserEffectCloseoutIntent =
  | BrowserCanonicalCloseoutCommandBase & {
      kind: 'requested_success'
      source: 'requested_terminal'
      productFenceDeathEvidenceDigest: null
      terminalStatus: 'done'
      terminalReason: 'done'
      initiator: 'done'
      engineTerminalCandidateRef: string
      engineTerminalCandidateDigest: string
      candidatePayloadRef: string
      candidateDigest: string
      workflowCloseoutSealRef: string
      workflowCloseoutSealDigest: string
      terminalQualityPatchRef: string
      terminalQualityPatchDigest: string
      verifierAttemptId: string
      verifierAttemptRef: string
      verifierAttemptDigest: string
      verifierReceiptDigest: string
      completionVerifierReceiptRef: string
      completionVerifierReceiptDigest: string
      durationDerivationRef: string
      durationDerivationDigest: string
    }
  | BrowserCanonicalCloseoutCommandBase & {
      kind: 'requested_failure'
      source: 'requested_terminal'
      productFenceDeathEvidenceDigest: null
      failureCommandRef: string
      failureCommandDigest: string
      failureEvidenceRef: string
      failureEvidenceDigest: string
      durationDerivationRef: string
      durationDerivationDigest: string
      engineTerminalCandidate:
        | {
            state: 'recorded'
            ref: string
            digest: string
          }
        | {
            state: 'not_recorded'
            ref: null
            digest: null
          }
      failureCause: {
        kind: 'runtime_failure'
        lifecycleActionRef: null
        lifecycleActionDigest: null
      }
    } & BrowserRuntimeFailureDisposition
  | BrowserCanonicalCloseoutCommandBase & {
      kind: 'requested_failure'
      source: 'requested_terminal'
      productFenceDeathEvidenceDigest: null
      terminalStatus: 'interrupted'
      terminalReason: 'cancelled_user'
      errorCode: 'cancelled_user'
      failureCommandRef: string
      failureCommandDigest: string
      failureEvidenceRef: string
      failureEvidenceDigest: string
      durationDerivationRef: string
      durationDerivationDigest: string
      engineTerminalCandidate: {
        state: 'recorded'
        ref: string
        digest: string
      }
      failureCause: {
        kind: 'lifecycle_action'
        lifecycleActionRef: string
        lifecycleActionDigest: string
        lifecycleActionEvidenceDigest: string
        lifecycleActionRequestedAt: string
        readyScopeId: string
        readyAliasId: string
        codexThreadId: string
        codexTurnId: string
      }
    } & (
      | {
          initiator: 'user_stop'
          failureCause: { kind: 'lifecycle_action'; lifecycleAction: 'stop' }
        }
      | {
          initiator: 'user_close'
          failureCause: { kind: 'lifecycle_action'; lifecycleAction: 'close' }
        }
      | {
          initiator: 'user_reset'
          failureCause: { kind: 'lifecycle_action'; lifecycleAction: 'reset' }
        }
    )
  | BrowserCanonicalCloseoutCommandBase & {
      kind: 'owner_boot_lost'
      source: 'owner_boot_lost'
      productFenceDeathEvidenceDigest: string
      terminalStatus: 'interrupted'
      terminalReason: 'browser_owner_boot_lost'
      initiator: 'startup_recovery'
      errorCode: 'browser_owner_boot_lost'
      failureCommandRef: string
      failureCommandDigest: string
      failureEvidenceRef: string
      failureEvidenceDigest: string
      durationDerivationRef: string
      durationDerivationDigest: string
      engineTerminalCandidateRef: null
      engineTerminalCandidateDigest: null
    }

type BrowserLifecycleRecoveryCommand = BrowserEffectCommandIdentity & {
  kind: 'lifecycle_recovery'
  source: 'lifecycle_recovery'
  productFenceDeathEvidenceDigest: string
  lifecycleAction: 'stop' | 'close' | 'reset'
  lifecycleActionRef: string
  lifecycleActionDigest: string
  lifecycleActionEvidenceDigest: string
  lifecycleActionRequestedAt: string
  initialPhase: 'lifecycle_action_frozen'
}

type BrowserEffectFenceCommand =
  | BrowserEffectCloseoutIntent
  | BrowserLifecycleRecoveryCommand

declare const verifiedBrowserCanonicalCloseoutBrand: unique symbol
type VerifiedBrowserCanonicalCloseout = {
  commandRef: string
  commandDigest: string
  command: BrowserEffectCloseoutIntent
  canonicalInput: CanonicalCoreCloseoutInput | CodexFailureCoreCloseoutInput
  derivedCanonicalInputDigest: string
  readonly [verifiedBrowserCanonicalCloseoutBrand]: true
}
```

约束：

- admission 快照生成于 `thread/start/turn/start` 之前，不能伪造尚未分配的 `readyRunId/codexThreadId/codexTurnId`。product runtime 持久化且 `thread/start/turn/start` 返回真实 native identity 后，只要本轮 Browser 工具非空，就在释放 provisional tool request 之前创建或 readback 唯一 browser workflow route，并以同一 post-start CAS 生成 execution binding 和初始 `BrowserRunTargetAuthority`。binding 的 parentTaskId 必须等于 product `readyTaskId`，并固定 browser task 与 journal route digest；tool call receipt 另加 `callId/actionId`。
- native tool request 在 execution binding 与初始 target authority 均持久 readback 前只能停在 provisional inbound buffer，不能进入 bridge。首个新 thread、已有 thread 的新 turn、绑定前抢先到达的 tool request 和 native identity 漂移都必须有行为测试。
- Browser execution binding 同时创建并 readback `BrowserRunEffectFence(state=active)`。所有 Browser dispatch、create/handoff worker 和启动恢复都必须核对 fence generation、state 与 owner boot；`closing/closed` 时工具桥不可恢复。
- `effectCommandRef + effectCommandDigest` 必须指向完整、版本化、digest 校验通过的 `BrowserEffectFenceCommand`。`commandDigest = digestCanonicalJson(unsignedCommand)`，其中 unsigned projection 只移除 `commandDigest` 自身；其它字段、null 对和顺序都 canonicalize。每个引用对象都按 `ref + digest` readback。最终 closeout command 是唯一终态语义真值；禁止再持久化一份可独立填写的 canonical input ref/digest。
- 四个 command kind 下的五个语义 variant 必须按 schema 真正互斥，禁止先造一个宽对象再靠运行时猜字段：`requested_success` 的 engine candidate、publication receipt set、candidate payload、workflow seal、quality patch、verifier attempt/receipt 与 completion-verifier receipt 全部非空；普通 `requested_failure` 的 death evidence 必须为 null，engine candidate 只能是完整 `recorded(ref+digest)` 或完整 `not_recorded(null+null)`；lifecycle `requested_failure` 还必须有 recorded candidate，并由 `action ↔ initiator` 的三分支固定为 stop/user_stop、close/user_close、reset/user_reset；`owner_boot_lost` 必须固定为 `interrupted/browser_owner_boot_lost/startup_recovery` 且 death evidence 非空；`lifecycle_recovery` 只绑定既有不可变 lifecycle action，不是产品终态，也没有 verifier 字段。
- 普通 runtime failure 的 status/reason/initiator 只能命中 `BrowserRuntimeFailureDisposition` 列出的现行组合，不能自由填字符串。`BrowserRuntimeFailureCode` 只能由 command schema parser 在核对 settled failure evidence 后签发；parser 明确拒绝空值及保留名 `done/cancelled_user/browser_owner_boot_lost/user_stop/user_close/user_reset/startup_recovery`。schema 还做反向约束：`user_stop|user_close|user_reset` 只属于 lifecycle final variant，`startup_recovery/browser_owner_boot_lost` 只属于 owner-loss variant，`done` 只属于 success；普通 failure 即使携带看似完整的其它 refs 也不能使用这些名称。
- `productRuntimeRef + productRuntimeDigest` 指向 command 创建时写入的不可变 identity snapshot，只含 run/task/scope/alias generation/thread/turn、admitted time/duration basis 等派生所需事实；不得引用会继续变更 status/revision 的 live product row。唯一 parser `parseBrowserCanonicalCloseout(commandRef, commandDigest)` 解析 command 和全部引用，并逐项证明：command 的 run/task/scope/alias generation/thread/turn 与该 snapshot、execution binding、engine candidate、publication receipts 全部相同；success 的 candidate body、seal、quality patch、verifier attempt/accept receipt、completion receipt 和 duration derivation 互相匹配；failure 的 status/reason/initiator/error、failure evidence 与 duration derivation 相同；lifecycle action/evidence 与 owner-death evidence 只出现在各自 variant。任一合法 digest 但语义字段不同也拒绝。
- parser 从唯一 command 与已验证证据确定性地产生现有 `CanonicalCoreCloseoutInput | CodexFailureCoreCloseoutInput`，并计算 `derivedCanonicalInputDigest`；映射的每个字段只能来自 command、已验证引用或版本化常量，不接受调用方覆盖。`VerifiedBrowserCanonicalCloseout`、`BrowserCloseoutOwnershipHandle` 的 brand/构造器和 parser 都是 closeout 模块私有；Browser 对外只接收由本 boot 在 command selection/combined transfer 提交后 readback 生成的 ownership handle。删除任何接收 raw canonical input、裸 command ref 或外部 constructed verified/ownership object 的 Browser overload。
- 现有通用 `commitCanonicalCoreCloseout(rawInput)` 与 `commitCodexFailureCoreCloseout(rawInput)` 必须在它们自己的最外层事务中先按 `readyRunId` 查询 `BrowserRunEffectFence`；只要 fence 存在，无论 active/closing/closed 都以 `browser_effect_command_required` 整笔回滚。无 fence 的普通 Codex run 保持原路径。Browser 唯一入口在同一 closeout 模块内调用私有 `writeVerifiedBrowserCloseoutInOpenTransaction`，不是给通用 API 增加可伪造的 bypass flag。
- 当前 host/native/recovery/lifecycle/verifier 成功与失败的每一个 raw closeout 调用点都必须显式迁移：运行时若对应 run 有 Browser effect fence，只能先冻结 command/selection receipt、取得本 boot ownership handle，再走 Browser 入口；漏迁分支会被上述事务 guard 拒绝而非静默绕过。
- 每次 command 被选中、lifecycle recovery command 被最终 command 替换或 closing ownership 跨 boot 转移，都在同一事务写一条 canonical `BrowserEffectFenceTransitionReceipt`，并把 fence 的 `transitionChainHeadDigest` 指向它。receipt 必须以 `previousReceiptDigest` 串起 product/effect before/after owner、revision/generation、state 与 command ref/digest；每次 effect transition generation 恰好加一，禁止分叉、跳代、换 command 不留 receipt 或单独转移 product owner。
- receipt 的唯一摘要公式是 `receiptDigest = digestCanonicalJson(unsignedReceipt)`。writer 先独立生成稳定 `receiptRef`，再构造严格的 `UnsignedBrowserEffectFenceTransitionReceipt`；`receiptRef` 参与摘要，null 字段保留，数组顺序依各字段合同，object key 由 canonical JSON 排序，未知/额外字段拒绝。对已存 receipt 验证时只移除 `receiptDigest` 自身，禁止 writer/parser/checker 各自选择不同 projection。
- effect fence 的 chain head 必须等于刚写 receipt 的重算 digest；chain parser、canonical transaction 与 fixture report checker 都从严格 unsigned schema 重新计算每一条，不相信数据库中的 `receiptDigest` 字符串。字段顺序变化应得到相同 digest；缺字段、额外字段、把 digest 自身纳入正文或任一值变化都必须失败。
- receipt 表把 ref/digest/previous head/after generation 存成可索引标量列并强制：`PRIMARY KEY(receipt_ref)`、`UNIQUE(receipt_digest)`、每 run 只有一个 `previous_receipt_digest IS NULL` 根、`UNIQUE(ready_run_id, previous_receipt_digest)`（非 null）禁止一个 head 有两个 child、`UNIQUE(ready_run_id, effect_after_generation)` 禁止同代双 receipt。约束冲突与 chain 验证失败一样整笔回滚，不能留待事后扫描。
- selection/replace 不转移 product owner，receipt 的 product before/after 必须逐项相同；combined boot transfer 必须让 product revision 与 effect generation 都恰好加一且 after owner 相同；canonical close 的 product after 固定为 null、effect after 固定 closed。chain parser 按 readyRunId 对 receipt digest 建唯一索引并逐条核对这些规则，不能只验证首尾。
- command 内的 `previousOwnerMainBootId + expectedEffectFenceGeneration` 只表示该 command 首次被选择前的 origin fence，不冒充当前 owner/generation；首条 selection/replace receipt 必须从这组 origin 精确过渡到 closing。提交当下的权威只来自 current fence + chain head + boot-local ownership handle。
- Browser canonical transaction 必须先以模块持有的 current Main boot 校验 ownership handle，再读取 product fence、effect fence 和从 command selection 到当前 head 的完整 receipt chain：首次提交时 effect fence 必须为 `closing(currentBoot,currentGeneration,commandRef,digest,head)`，product/effect owner 必须同为 current boot，product revision/generation/head 必须等于 handle，command 的 origin owner/generation 必须由首条 selection receipt 接上。old boot、错 generation/head/command、active fence、断链/分叉或 product/effect owner 不一致全部回滚。
- 同一 canonical transaction 的最后一步必须 CAS `closing(currentBoot,currentGeneration,commandRef,digest,head) → closed(currentBoot,currentGeneration+1,sameCommand,canonicalCloseReceiptDigest)`，同时写 `canonical_close` receipt、释放 product fence、提交产品终态、projection、claim receipt 与 outbox。CAS 失败全体回滚；旧 A/B 即使持有内容和摘要都合法的 command，也不能替当前 C 提交。
- terminal retry 若读到 closed，只允许一个零写入幂等分支：ownership handle 必须等于 `canonical_close` receipt 的 before owner/generation/command/previous head，且 receipt 的 derived input/product terminal digest 与已提交 readback 全相同；返回 `already_committed`。其它 closed handle 一律拒绝，不能再运行 participant 或 reconciler 业务动作。
- canonical receipt 同时保存 command ref/digest 与 derived digest，并在同一事务重算、提交后 readback；重启必须重新解析同一 command，不能从 live product runtime 另拼终态含义。derived digest 只是唯一 command 的确定性校验结果，不是可独立填写的第二份终态输入。
- 最终 command 的恢复只重放并重新解析 frozen command，不重跑 verifier、模型或页面业务动作。任一引用缺失/篡改、digest 不符、variant 含非法字段、semantic equality 不成立或 schema 版本未知时保持 closing 并报 recovery error，不能发布或恢复工具。
- `owner_boot_lost` 的 death-evidence digest 必须与 old boot/product fence 匹配；`requested_terminal` 的该字段恒为 null。active-owner-loss CAS 同时核对 old boot、expected generation 和 evidence digest，不能只换 owner id。若 exact turn 已有合法的 durable lifecycle action，则该用户动作优先，禁止生成 `owner_boot_lost`。
- `lifecycle_recovery` 必须逐项绑定现有 `codex_turn_lifecycle_action_v1` 的 action/run/task/scope/alias generation/thread/turn/requestedAt/evidence digest，且 command 的 thread/turn 必须等于 execution binding。它只准驱动现有恢复顺序：`thread/read → 同 turn 仍 inProgress 时 exact turn/interrupt → engine terminal candidate → effect settlement → lifecycle canonical closeout`；不得调用 `restoreActiveProductRun`、恢复 Browser writer/tool bridge、重建 target 或重跑 Browser verifier。
- lifecycle 恢复进度不另造第二套可变状态表：只读取既有 action、interrupt ack/unknown、engine terminal candidate、effect settlement 和 product terminal 行。每一步都核对 command ref/digest、effect fence generation、owner boot 和 exact identity；得到 terminal candidate 与 effect settlement 后，在同一事务写完整 `requested_failure(failureCause=lifecycle_action)` 并把 fence 的 command ref/digest 从 recovery command CAS 到该最终 command，fence 继续保持 closing，再进入既有 canonical participant。
- `activeWorkbenchMode` 只描述真实当前工作面；文档锚和网页引用是资源，不能改写它。
- `currentBrowserRoot` 必须同时来自可信当前 Browser 工作面和精确 pageRef。若 Browser host 存在但 pageRef 解析失败，记录准入诊断并保留 null，不暴露当前页 Browser 权限。
- `explicitBrowserReadRefs` 当前最多一项，必须有精确引用且 `canRead=true`；它永远不产生 mutation 权限。
- current root、explicit read refs 和 selected skill 是可组合的正交字段，不再用单值 `source/pageAuthority` 表达。所有数组按稳定 resource id/工具名排序、去重后参与 digest；同一 physical/document identity 同时是 current root 与 explicit ref 时合并为一个 target，只有真实 current root 可以保留 `browser_work`，否则保持 `observe_only`。同一组事实只有一个 canonical digest。
- `selectedSkillToolNames` 只接受 manifest 中的完整工具名，并仍要满足 page、附件、写入根目录等结构前置条件。
- 技能若没有初始 pageRef，只能获得无需 target 的 operation；若 manifest 明确包含 `browser_tabs`，可用 `tabs_open` 创建首个 receipted run target，之后只在该 lineage 内工作，不能回退读取当前 active tab。
- live-info、地图、用户说「网页」等自然语言分类只能用于选择 web research 或做减法，不能凭空产生 current root 或 explicit ref。
- `browser_negated`、`public_research` 和当前唯一代码真值 `tag_forge_exclusive` 均在最终阶段做减法，且负向表达优先；不在本计划静默建立 generic exclusive skill registry。任何上一轮 Browser 面不得继承。

### 3.2 唯一组合算法

生产组合器必须按固定顺序执行，SDK supporting executor 和旧 intent group 不再是 Codex 权威：

1. 从候选 allow-set 删除全部 `BROWSER_PUBLIC_TOOL_NAMES`，同时删除 `use_browser` / `use_skill`。
2. 根据同一份 frozen admission authority 选择 §3.3 的精确工具集；不得在旧 allow-set 上追加 `browser_interaction`。
3. 只在结构前置条件满足时加入附件、下载、归档或技能增量。
4. 应用负向减法与当前唯一 `tag_forge_exclusive` 排他面。
5. 生成同源的 `allowedToolNames` 和 `allowedBrowserOperationIds`；后者必须严格等于所有可见 Browser 工具在 registry 中的 operation 并集，不能暗藏更小子集。bridge 先校验工具名，再用 registry 解析 operation 并校验 operation id、target 和 effects。
6. 冻结后，模型网关和 dispatch 必须引用相同 `authorityId + authorityDigest + authorizationDigest`；product runtime 再把该组合 CAS 绑定到实际 run/thread/turn。不一致或 binding 尚未 readback 时直接拒绝，不能 fallback 到默认 Browser group。

任何模型可见的混合 operation 工具，必须满足以下二选一：本档允许它的全部 schema operation，或在 thread root schema 中拆成不同公开工具。不能只在 dispatch 暗藏一个模型不可见的 operation 子集。本计划现有分档只选第一种；显式只读引用因此不包含任何混合 mutation 工具。

### 3.3 工具面

#### A. 无 Browser

条件：无精确结构来源、只有 host、Browser 工作面解析不到 pageRef、公开 research、明确否定或 Tag Forge 排他面。

结果：零 `browser_*`。整体工具面仍由其它 capability floor 保持非空；不为 Browser 单独造一个不安全地板。

#### B. 显式网页只读引用

精确集合：

```text
browser_snapshot
browser_find
browser_read
browser_screenshot
browser_wait
browser_status
```

机器断言：这些工具在 registry 的全部 operation 都是 `observe`；集合不含 `browser_tabs`、dialog、collect、resources 或任何 mutation/power 变体。每次调用都强制绑定 frozen explicit ref；缺省 tab、active-tab fallback、call 参数换 tab 均拒绝。

#### C. 当前 Browser 精确页面

从 turn 开始就提供正常 Browser 工作所需工具，避免「先启动 research 才能看见 research」的循环：

```text
browser_tabs
browser_navigate
browser_search
browser_snapshot
browser_find
browser_read
browser_screenshot
browser_wait
browser_click
browser_type
browser_fill_form
browser_select
browser_hover
browser_scroll
browser_press_key
browser_drag
browser_dialog
browser_research
browser_collect
browser_status
```

增量条件：

- `browser_upload`：还必须存在本轮显式 attachment authority；dispatch 只能使用该集合中的附件。
- `browser_download`：B3 完成、root surface 版本可用后加入；使用当前 Browser session，不能回退裸 fetch。
- `browser_archive`：还必须有显式 writable root。
- `browser_task`、`browser_console`、`browser_network`、`browser_resources`、`browser_eval`、`browser_cdp`、`browser_session`、`browser_permission`：仅由已选技能的 manifest 精确加入；其 operation/effect/target 约束照常生效。

`browser_tabs` 的 list/open/switch/close 在此档全部可见；B4 隐藏实现、B7 才公开 owner-control operation `handoff`。dispatch 逐 operation 校验：所有调用绑定 run/thread/turn/call；只有 registry 明示 `requiresPageLease=true` 的 operation 才要求 exact physical target 和 held claim；list 只返回 frozen 初始 target 与本 run 已 receipted 的后继 target；open 以 `postActionTabId` 回执并进入下述 causal lineage，不能伪造 pre-action claim；switch/close/handoff 只能指向该 lineage 中允许相应操作的 target，不能碰显式只读引用或未授权用户 tab。

#### C.1 同轮新页签与新 document

准入时冻结的是根 target 和派生规则，不是假装提前知道同轮产生的所有 tab/document。运行期以 durable `BrowserRunTargetAuthority` 保存因果 target：

```ts
type BrowserRunTargetAuthority = {
  readyRunId: string
  parentTaskId: string // exact product readyTaskId
  browserTaskId: string
  admissionAuthorityDigest: string
  journalRouteDigest: string
  causalActionId: string | null
  origin: 'current_root' | 'explicit_read_ref' | 'run_created'
  access: 'observe_only' | 'browser_work'
  tabId: string
  physicalTargetToken: string | null
  documentGeneration: number
  frameId: string | null
  frameDocumentToken: string | null
  state: 'tab_only' | 'observed_document' | 'handoff_pending' | 'released'
}

type BrowserTabCreateIntent = {
  intentId: string
  idempotencyKey: string
  generation: number
  parentTaskId: string
  readyRunId: string
  browserTaskId: string
  journalRouteDigest: string
  causalActionId: string
  popupOrdinal: number | null
  bootIncarnationId: string
  tabId: string | null
  physicalTargetToken: string | null
  status:
    | 'claimed'
    | 'provisional_bound'
    | 'settled'
    | 'rejected'
    | 'unknown'
    | 'terminal_fenced'
    | 'cleanup_claimed'
    | 'closed'
}
```

- execution binding CAS 时，current root 以 `browser_work` 入表，explicit ref 以 `observe_only` 入表并共同 readback。模型参数、tabs list 结果或 active-tab fallback 都不能新增 authority。
- Agent 的 `tabs_open` 在物理创建前先写 `BrowserTabCreateIntent(status=claimed, popupOrdinal=null)`。创建端改成按 intent/idempotency key 的 `createOrAdoptTab`：intent id 在 tab lifecycle 注册、对 Agent 可见之前同步挂到物理 tab；同 key 重入只 adopt，不能再创建。
- 页面 `window.open` 先由既有 popup policy 分 lane，不能把 Agent、manual、认证 popup 混成一个 target 来源：
  - 仅 `sourceOwner=agent + valid workflow route + policy=open-tab` 进入 create intent；同一 parent action 的每个 popup 先持久分配稳定 `popupOrdinal`，idempotency key 使用 `parentActionId + popupOrdinal + normalizedUrl`，相同 URL 多开也不冲突。
  - manual source 的 `open-tab` 保持 manual tab，不写 run intent/authority；nested Agent source 仍沿用原 browser route 和 ordinal。
  - `allow-popup` 保持受保护认证窗口，进入明确的用户等待/接管状态，不进入 causal target、不授予 Agent writer。
  - 只有 popup policy 原始判定为 `external` 才允许调用 `shell.openExternal`。Agent `open-tab` 的 intent/route/create 失败只能按真实阶段返回 rejected 或 unknown，external invocation 必须为零；`sourceOwner=agent` 但 route 缺失时拒绝并写 route error，owner 不明时也不得降级成 Agent target。
- Agent open-tab lane 不允许先生成无主 child 再补登记：window-open handler 拦截原生 child，先持久 intent，再调用 `createOrAdoptTab`；无法先写 intent 时拒绝 child 创建并记录该事实，parent action 仍按真实已投递/已观察结果结算，不伪造新 tab。
- 创建返回 tab id 后，在返回工具执行层前同步 CAS 写 `provisional_bound` 和 `run_created/tab_only` target；settled action receipt 再把 intent 转为 settled。若同时能证明 physical target 一并保存，否则由同 tab 的真实 observe 补齐。
- reconciler 区分「intent 已写但物理结果未知」与「tab id 已写但 action 未 settle」：先按 intent marker + boot incarnation 扫描 live/persisted tab，能证明则 adopt/close，不能证明则记 unknown；绝不以同一 idempotency key盲开第二页。Main 进程已重启且旧 BrowserView 不可能存活时，也只收口 intent，不替已终止 run 重建页面。
- `createOrAdoptTab` worker 在物理副作用前、物理返回后、写 provisional/settled receipt 前都按 generation 重读 intent 与 run terminal fence。任一步已是 `terminal_fenced/cleanup_claimed`，都不得新增 target authority、Agent owner 或 writer；若物理 tab 已出现，只能用 `terminal_fenced → cleanup_claimed` CAS 把 exact tab/token 追加到同一 finalize intent 的 cleanup item，再写 cleanup receipt，不能更新产品终态字段。
- create intent 的每次 `claimed/provisional_bound/settled/terminal_fenced/cleanup_claimed` 转换都必须使用 `intentId + expectedGeneration + expectedStatus` CAS 并递增 generation；迟到旧 generation 不能绑定 target、Agent owner 或 cleanup 到新状态。
- 新物理 tab 初始只能走独立 provisional create path：隐藏、`owner=provisional, required=false`，不得进入 `agentWorkTabs/agentTabId`、获得 writer、写持久 session，或向 Renderer 发 `browser:tabOpened`/tab-list/active/split 事件。只有在 `BrowserRunEffectCoordinator` 的 per-run 临界区内，post-create intent CAS、run effect fence 和 target authority 同时仍 active，才同步转成 `owner=agent`、立即 readback，并恰好发送一次正式 tab-open 事件；terminal closing 取得同一临界区后再也不能发生该转换。否则保持 provisional 交给 cleanup，整个事件序列保持零可见。为此 tab lifecycle owner 显式扩成 `manual | agent | provisional`。
- `tab_only` target 只允许 tab management、明确 navigation 和真实 observe；同 tab 的 snapshot/read readback 才补齐 physical target、frame/document token，转为 `observed_document`。
- navigation 或同 tab document replacement 写 successor generation 并立即作废旧 frame/document/target ref；必须 fresh observe 后，click/type/fill/hover/scroll/drag 等 document mutation 才能继续。
- `switch/close` 只能命中 current root 或本 run causal descendant；explicit read ref 永远只读。迟到旧 generation/action receipt 的 CAS 失败并记 drift，不能覆盖新 document authority。

正例必须覆盖 `open → switch → navigate → observe → click`；反例必须覆盖伪造 tab id、关闭无关用户 tab、explicit ref mutation 和导航后复用旧 document ref。另在「物理创建成功、provisional CAS/action settle 之前」分别注入崩溃，重启后网络/建页调用数不增加，原页必须能按 marker 精确 adopt 后关闭或完成归属。

### 3.4 资源组合而非工作面覆盖

Main 分别解析：

- 可信 active workbench；
- 当前文档锚；
- 显式 browser read reference；
- 当前 Browser pageRef。

然后再构造 product envelope。必须覆盖两组反例：

1. active document + document anchor + explicit browser reference：工作面仍是 document；文档 capability floor 与只读 Browser 集合并存。
2. active Browser + pageRef + document anchor：工作面仍是 browser；当前页完整 Browser 集合与文档资源并存。

显式 browser reference 不得把工作面改成 browser；文档锚也不得把真实 Browser 工作面改成 document。

### 3.5 动作身份与结果摘要

所有调用绑定 `parentTaskId + readyRunId + browserTaskId + journalRouteDigest + codexThreadId + codexTurnId + callId`。bridge 在 dispatch 前逐项 readback execution binding、target authority 和 workflow route；缺失、冲突、route 被替换或 digest 漂移均拒绝。只有有 document/target 边界的 operation 再绑定 exact tab/physical document；只有 registry 明示 `requiresPageLease=true` 的 operation 必须在投递前持有 held claim。management operation 允许 `target=null`，但仍有同一路由上的 call receipt。

不新增会被 mapper 忽略的顶层 `environmentHint`。动作结算后的短摘要放在既有 receipted `data.environmentSummary` 中：

```ts
type BrowserEnvironmentSummary = {
  targetTabId?: string
  predecessorTabId?: string
  postActionTabId?: string
  targetGeneration?: number
  sampledAt: string
  url?: string
  title?: string
  dialogState?: 'open' | 'closed'
  fileChooserState?: 'open' | 'closed'
  downloadState?: 'in_flight' | 'settled'
}
```

- 只从已结算动作的 target/predecessor/postAction 身份生成，绝不读取「返回时当前 active tab」兜底。
- URL 去凭据并限长，title 限长；未知字段省略，不能用 false 伪装已知。
- summary 只是诊断，不是 snapshot、fresh observation 或 verifier receipt，不能清 journal barrier。
- 不自动截图；需要页面证据仍由模型调用 observe 工具。

### 3.6 下载的单一路径

本计划选择「Codex 原生下载回执消费者」，不保留二选一：

1. `browser_download` 继续由现有 Browser session 执行。副作用前先写 exact action attempt 与 idempotency key。
2. 每个文件在网络副作用前按稳定 ordinal/idempotency key 单独写 `claimed`，并登记 `run/thread/turn/call/tab/url/tempPath/finalPath/size/sha256/status`；正常转为 `completed/rejected`，无法确认时转 `unknown`。aggregate 允许存在 active `claimed`，不能把多文件部分成功压成一个成功布尔值。
3. 窄消费者只接受白名单 `recentArtifacts`，在原子发布后重新打开 finalPath、核对 size/hash，并 CAS 写入当前 run/task projection 和 artifact refs。后续工具只从 durable receipt 读取路径。
4. 文件已发布但回执/投影提交失败时记 `unknown`，禁止自动重新下载。reconciler 只按 idempotency key + path/hash readback 补回执；无法证明时保留文件并给出 cleanup 状态。
5. transport 断线、进程崩溃和同一 call replay 先查 receipt；exact completed 直接重放结果，unknown 只核对本地状态。boot 时遗留的 claimed 必须先按 temp/final path/hash readback 转 completed 或 unknown，绝不再次产生网络副作用。
6. 只有消费者和 replay gate 通过后，才从 unsupported state-patch 集合及 Codex exclusion 移除 `browser_download`；不得先曝光后补持久化。

`browser_download` 加入 root 与 B4 的 `tabs_handoff` schema 变化合并为一次 thread root tool surface 版本升级。升级时：

- 已在执行的旧 generation 按旧面收口，不强杀、不重放；
- 下一条真实用户输入准入时若发现 `rootSurfaceContractVersion/tool_surface_digest` 漂移，先 retire 旧 native binding，再创建新 generation；
- 不创建 non-user successor，不把旧 turn 自动迁入新 thread；
- 行为测试必须证明第一轮无 Browser、下一轮当前 Browser 可用时只改变 turn allow-set；只有 root schema 真变化（本次合并的 download + tabs_handoff 版本）才换 generation。

### 3.7 终态 claim 与物理 finalize

claim 和 BrowserView 副作用分两层：

1. 保留现有 canonical raw-DB transaction 和已在其中执行的 `releaseHeldBrowserTargetClaims`，将它扩成纯同步 participant `releaseRunBrowserClaimsAndEnqueueFinalize(db, ...)`：在 caller 已开启的同一个事务内：
   - CAS 把本 run 所有非终态 `BrowserTabCreateIntent/BrowserTabHandoffIntent` 置为 `terminal_fenced`，把已知 tab/token/boot/generation 和未知 intent marker 都写进 finalize outbox；
   - 释放全部 `held/user_owned/suspended` live claim，把该 run 的 `BrowserRunTargetAuthority` 全部置为 released，写 claim receipt；effect fence 必须按 current boot/expected generation/selected command/chain head 精确 CAS 为下一 generation 的 closed，并写 `canonical_close` transition receipt。
   任一 current product/effect owner、generation、command、transfer chain、fence/release/outbox 写入失败，则 canonical product closeout、投影与候选发布一起回滚；此前 verifier 已形成的 `sealedCandidateDigest` 只保留为不可发布、不可复用的审计证据，不要求倒置现有 verifier 时序。
2. canonical participant 禁止调用会自行 `store.mutate()/BEGIN IMMEDIATE` 的 `BrowserTargetClaimService.closeoutRun()`。service 层若需复用，只能调用同一纯 participant，且由最外层持有唯一事务。
3. 两个现有通用 raw closeout API 也必须在这一最外层事务内做 effect-fence absence guard；不能在事务外先查，也不能以可传 boolean 跳过。只有 Browser 模块私有 verified participant 能在 fence 存在时继续。
4. 事务后幂等 reconciler 执行物理关页、解除 debugger、解除本 run 的 file-chooser interception 并清理 pending notice、撤销指针/短下载授权，再写 receipt。若此前已有未被 guard 拦截的 OS file chooser，只能记 `unknown/manual_cleanup`，不能声称可以自动关闭。Electron 副作用不能声称与 SQLite 一起回滚。
5. 物理 cleanup 失败不改写已经提交的任务语义结果；每个 finalize item 使用 `claimed/completed/rejected/unknown` receipt，投影 aggregate 只使用 `cleanup_pending/cleanup_completed/cleanup_unknown`。reconciler 可按同一 intent 重试 cleanup，但不能重做页面业务动作。

成功、失败、stop、close、reset、verifier nonaccept、transport terminal 和 terminal retry 必须共用该 participant。当前进程首次 terminal initiation 只有两个明确边界：一次 command+effect-fence transaction，再一次 canonical product transaction。若旧 Main 在 lifecycle action 持久化后崩溃，允许在唯一 combined ownership-transfer transaction 之后增加一次 recovery-command→final-command CAS transaction，再进入同一个 canonical participant；不能把任一 ownership transfer 拆成两笔。canonical 内部不得嵌套 BEGIN，claim receipt/outbox/fence=closed 与产品终态同提交或同回滚。

create/handoff worker 除 §3.3 C.1 的 create 三次重读外，也必须在 handoff 物理副作用前、物理返回后、写 receipt 前重读 intent generation/status。terminal fence 后的任何晚到结果只能补 exact cleanup receipt；不得创建 target、恢复 Agent owner/writer、写 completed handoff 或改写 terminal projection。

所有 create/handoff/popup promise 由 `BrowserRunEffectCoordinator` 具名跟踪，禁止裸 fire-and-forget。terminal 入口按以下顺序执行：

1. 在 per-run 临界区内，用独立事务先写完整最终 `BrowserEffectCloseoutIntent`，再对 `BrowserRunEffectFence` 执行 `active(owner,g) → closing(owner,g+1)` CAS，同时写 `select_terminal_command` receipt 与新 chain head；command、receipt 与 fence 必须同提交。提交后由本 boot 对三者 readback，才生成模块私有 ownership handle。这只是执行准入栅栏，不冒充产品终态。
2. readback 成功后，Main coordinator 才进入 closing，阻止新 worker/Agent-owner activation；随后只调用 `commitBrowserCanonicalCloseout(ownershipHandle)`，由它在 canonical transaction 内重读 current product/effect fence、完整 transition chain、解析 command 并生成 lexical-local verified object，不能传原始 input 或调用方另组对象。已在飞的物理创建即使晚到，也只能以 provisional owner 被 cleanup adopt。
3. canonical transaction 回滚时，durable fence 仍是 closing。当前 Main 与新 Main 都不得恢复工具桥；startup recovery 看到 closing 后，必须用下述 product/effect combined participant 同时转移 closeout-recovery ownership，再按 exact effect command 重试 lifecycle 或 canonical closeout/reconcile，不能先单独 claim product fence 或把 run 恢复为 active。
4. effect-fence CAS 自身失败时，terminal 请求不得被确认，也不得进入 canonical transaction；当前进程的 per-run 临界区保持阻断并重试/报明确非成功。closed 永远不可重新打开。所有 Browser dispatch 与 owner promotion 都重读该 durable fence，而不是只信内存 coordinator。
5. 正常 active Browser run 发生 Main 崩溃时也不恢复 Browser writer。新增 raw-DB participant `claimProductFenceAndFenceBrowserRunForOwnerLoss(db, ...)`，在同一个 `BEGIN IMMEDIATE` 中按固定顺序：
   - 核对 product fence 的 old boot/revision 与 death-evidence digest；
   - 先读取并验证 exact turn 上不可变的 `lifecycle_action + requested_at + evidence_digest`。若存在，写完整 `BrowserLifecycleRecoveryCommand`；若不存在，才写固定的 `owner_boot_lost` 最终 closeout command；动作记录残缺、身份漂移或 digest 错误时整笔拒绝，不能降级为 owner loss；
   - product fence `oldBoot → newBoot`；
   - Browser effect fence `active(oldBoot,g) → closing(newBoot,g+1)`，指向上一步唯一 command；
   - 写 `select_owner_loss_or_lifecycle_command` transition receipt，绑定 previous chain head、command kind/ref/digest、previous/new boot、两边 product revision/effect generation 与 death evidence，并把 fence head 指向该 receipt。
   任一步失败全部回滚，boot recovery 在该 participant readback 前禁止调用 `restoreActiveProductRun`。禁止 `active(oldBoot) → active(newBoot)`、重建旧 target authority 或新建页。
6. `lifecycle_recovery` 由窄恢复器接手，不注册 active product handle。恢复器每次先重读 command/fence/action 身份，再调用现有 lifecycle 恢复方法：
   - `thread/read` 已见 exact turn 终态时，不再 interrupt，直接持久化该 engine terminal candidate；仍为 inProgress 时才按原 action evidence 发送 exact `turn/interrupt`，并沿用现有 ack/unknown 记录后重读；
   - candidate 已存在时只 readback，不重复采集；effect settlement 只读取该 candidate 的既有工具回执，不执行 Browser 工具或 verifier；
   - candidate 与 effect settlement 均完整后，在同一事务冻结 `requested_failure(failureCause=lifecycle_action)` 最终 command，写链接 recovery head 的 `replace_lifecycle_recovery_command` receipt，并 CAS `closing(currentBoot,g,recoveryCommand,oldHead) → closing(currentBoot,g+1,finalCommand,newHead)`；readback 后生成本 boot ownership handle，再经同一个 parser 调用现有 lifecycle canonical closeout。stop 必须保持 `cancelled_user`，close 必须同事务 tombstone scope，reset 必须同事务建立空 generation 并推进可见 epoch；三者都不得被改写成 `browser_owner_boot_lost`。
   action 已写后、interrupt 已发但 candidate 未写、candidate 已写但最终 command 未写、最终 command 已写但 canonical 未提交四个 crash seam 都从既有 durable 行幂等继续；任何 identity/digest 漂移保持 closing，不恢复 writer，也不改走 owner loss。
7. closing run 的跨 boot ownership 也用同类 combined participant，在一个事务中同时执行 product fence `B → C` 与 effect fence `closing(B,g,command,oldHead) → closing(C,g+1,sameCommand,newHead)`，写链接 old head 的 `transfer_closing_owner` receipt。C 只有在 command/fence/product/chain 全量 readback 后才取得自己的 ownership handle。若 B 在 combined transaction 中途崩溃，事务回滚后 C 仍看到两边 owner=A；若 B 在提交后崩溃，C 看到两边 owner=B。任何 product/effect owner 不一致、receipt 断链或 branch 都 fail-closed，不猜 transfer chain。没有 Browser effect fence 的普通产品 run 才继续用现有单 product-fence 恢复合同。

物理 tab disposition 来自持久 provenance，不猜标题：

| provenance / marker | 物理处理 | claim 处理 |
| --- | --- | --- |
| run 创建的 transient tab，未交付 | 关闭 | 终态释放 |
| run 创建的 work tab，research/collect 未完成且无 delivery receipt | 关闭；未完成不构成保留或续跑理由 | 终态释放 |
| 有 handoff intent 但尚无 completed receipt | 先禁止 destructive close 并标 `cleanup_pending`；readback 为 manual 则补 receipt 后保留，仍为 agent 则结算 handoff rejected 后按原 provenance 关闭，无法确认则 `cleanup_unknown` | 终态释放 |
| 有真实 durable delivery/handoff receipt | 保留并显示给用户 | 终态释放；不得伪装成 `user_owned` claim |
| 用户原有/manual tab | 保留 | 终态释放 |
| popup policy=`allow-popup` 的受保护认证窗口 | 保留给用户完成/关闭，不写 run target 或 claim | 不适用 |
| 用户在 exact target 上真实输入接管 | physical owner 转 manual，旧 writer 当场隔离 | 终态仍释放 |

本计划不从「未完成工作」「用户看见 tab」推导 continuation 或 `user_owned`。需要交付页时必须先有明确 action/receipt；否则按 provenance 默认处理。

```ts
type BrowserTabHandoffIntent = {
  intentId: string
  parentTaskId: string
  readyRunId: string
  browserTaskId: string
  journalRouteDigest: string
  tabId: string
  physicalTargetToken: string
  bootIncarnationId: string
  targetGeneration: number
  generation: number
  status:
    | 'claimed'
    | 'handoff_pending'
    | 'completed'
    | 'rejected'
    | 'unknown'
    | 'terminal_fenced'
    | 'cleanup_claimed'
}

type BrowserOwnerControlReadbackReceipt = {
  receiptId: string
  intentId: string
  parentTaskId: string
  readyRunId: string
  browserTaskId: string
  actionId: string
  journalRouteDigest: string
  operationId: 'tabs_handoff'
  tabId: string
  physicalTargetToken: string
  bootIncarnationId: string
  targetGeneration: number
  owner: 'manual'
  required: false
  activity: 'idle' | 'attention'
  agentWorkTabsAbsent: true
  agentTabIdCleared: true
  writerBindingCleared: true
  supervisorCleared: true
  pointerCleared: true
  readbackDigest: string
  createdAt: string
}
```

本轮把交付入口定死为 `browser_tabs action='handoff'`。B7 公开时，registry tuple 必须精确为：

```ts
{
  operationId: 'tabs_handoff',
  handlerGroup: 'act',
  mode: 'control',
  effects: ['page_mutation'],
  requiresWorkflowRoute: true,
  requiresDocument: true,
  requiresPageLease: true,
  requiresOwnerCleanup: true,
}
```

为此新增 `owner_page_control` boundary profile（四个 requires 字段全为 true），并同步 `BROWSER_OPERATION_IDS`、`browser_tabs` operation resolver、schema/catalog、invocation validator 和 registry drift gate。schema 对 `action=handoff` 强制 `tab_id`；handler 还必须核对 exact `observed_document`、held claim 与 owner-cleanup identity。其执行合同是：

1. 只接受本 run causal lineage 中 `origin=run_created + browser_work + observed_document` 的 exact target/generation；副作用前写 durable handoff intent，并立即把 target authority 置为 `handoff_pending`，旧 Agent writer 此后不能再投递。
2. 物理层把 tab readback 为 `owner=manual`、`required=false`、`activity=idle`（确有未处理提示时为 `attention`），清除 `agentWorkTabs`、`agentTabId`、writer binding、supervisor 关系和指针状态；它不生成 continuation，也不把 claim 伪装成 `user_owned`。
3. 上述字段全部 readback 后，在同一 journal transaction 中写 `BrowserOwnerControlReadbackReceipt`，把 action 结算为 `dispatch=accepted, delivery=delivered, effect=observed, mayHaveCommitted=true, needsObservation=false`，再把 handoff intent 置 completed、target authority 置 released。authority release 不得早于 action settlement 与 receipt 持久 readback。中途失败/崩溃保持 intent + `handoff_pending` blocked writer，由 reconciler 按 exact target 补做或记 unknown，不能恢复 Agent writer。
4. verifier 只对 `operationId=tabs_handoff` 接受精确匹配 run/task/action/tab/token/boot/target-generation 且全部 readback 字段完整的 `owner_control_readback`，据此消除该 owner-control action 的 unresolved 状态；它不是页面 observation receipt，也不要求额外 snapshot。其它 `page_mutation` 仍必须走原 observation barrier，不能复用此豁免。receipt 缺失、错代、错 boot 或 readback 不完整时，handoff 保持 unresolved，候选不得发布。
5. closeout participant 只认 completed owner-control receipt（或 reconciler 对同一 intent 的等价 exact receipt）决定保留 run-created tab；只有物理交接 receipt 完成，handoff cleanup 才能标 completed。

该 schema 变化与 B3 的 `browser_download` root 变化合并为同一个 `rootSurfaceContractVersion`，发布时只迁移一次 generation。

### 3.8 指针投递边界

统一 preflight 放在 Browser mutation boundary 内，紧邻最终 `dispatchMouse`，覆盖 click、hover、scroll、drag 以及所有 pointer-backed collect 路径：

- 每次投递前以 generation/CAS 重读 exact target 的 visible + active + foreground host；不自动切回 Browser、不切用户 active tab。
- 投递前失败严格使用现有 outcome：`dispatch=rejected, delivery=not_delivered, effect=not_applicable, mayHaveCommitted=false, needsObservation=false`；claim 保持 held，返回结构化 `foreground_required` / `browser_surface_required`。
- drag 等多步动作在接受后失去前台且无法证明投递量：`dispatch=accepted, delivery=unknown, effect=unknown, mayHaveCommitted=true, needsObservation=true`，禁止原样重放。本计划不发明 `partial_or_unknown` 或未注册的 `settled` 值；若未来确需独立 `partial`，必须另改 shared schema、journal validator、verifier、readback 与 drift gate。
- readiness 失败不写 `cancelled_user`、不生成 resumable/checkpoint、也不直接替整个 run 判失败。模型可换非指针路径；若无替代，canonical closeout 才给出清楚的非成功结论。

## 4. 实施工单

### B0 — 先立合同并切断旧权威

1. 新增 `BrowserAdmissionAuthoritySnapshot`、含 parent/browser-task/journal route 的 `BrowserToolExecutionBinding` 及 digest/CAS/assertion；tool request 在 route、binding 和 initial target readback 前不出 provisional buffer。
2. 在 production composer 中实现「先删 Browser 全集，再按 frozen authority 加精确集合」；SDK intent group 只保留 supporting 身份。
3. 删除 `exposeBrowserActivation/use_browser` 的 Codex 死路径；旧 SDK 测试不得再冒充 production gate。
4. 新增 operation、`BrowserRunTargetAuthority`、effect 的同源 dispatch authorization；模型 gateway 与 bridge 校验同一 digest。
5. 把 08-11 closeout 过度宣称和 08-13 未接入项同步到唯一受影响的权威文档。

### B1 — 解耦工作面与资源

按 §3.4 分开读取、传递 active workbench、document anchor、current pageRef 和 explicit read ref。禁止任一资源通过对象覆盖改写工作面。

### B2 — 落地精确工具面

实现 §3.3 三类面和技能增量，以及 §3.3 C.1 的 `BrowserRunTargetAuthority + BrowserTabCreateIntent + createOrAdoptTab + popup lane/ordinal`；新增 registry gate，证明显式引用集合的全部 operation 都是 observe，且 `browser_tabs` 不在其中。删除对空 `browser_content_tasks` 分组的生产依赖；排他面只认当前 Tag Forge 代码真值。

### B3 — 隐藏实现下载回执消费者

按 §3.6 完成 attempt、逐文件 receipt、readback、projection consumer 和 replay/reconcile，先从内部执行缝与 native 测试证明；本工单不改 public root、exclusion 或 generation。任何一个环节缺失时继续隐藏 `browser_download`。

### B4 — Codex closeout participant 与 finalize outbox

扩展现有 canonical raw-DB claim participant，不调用会另开事务的 service `closeoutRun()`；新增 durable `BrowserRunEffectFence`、真正互斥且作为唯一终态真值的 `BrowserEffectFenceCommand` variants、只从 command 确定性产生 canonical input 的私有 parser、通用 raw closeout 的事务内 Browser-fence guard、command selection/owner transfer 的连续 receipt chain 与 boot-local ownership handle、combined product/effect boot-transfer participant、用户 lifecycle 优先的窄恢复分支、无 lifecycle action 时的 active-owner-loss 非成功分支、tab provenance、内部 `tabs_handoff` handler/owner-control receipt、create/handoff terminal fence、finalize intent、幂等 reconciler 和 cleanup projection。participant 必须在清空 claim 的 physical token 前把旧 token、boot、target generation、provenance 与 handoff receipt ref 固化进 intent；worker 在副作用前后和 receipt 前重读 fence。stop、close、reset、verifier nonaccept、transport failure 与普通 terminal 共用同一个 canonical participant；startup lifecycle recovery 复用现有 `thread/read → interrupt if needed → terminal candidate → lifecycle closeout`，不恢复 Browser writer。本工单先走内部 seam 测试，不单独发布新的 root schema。

### B5 — 既有回执内的 bounded environment summary

按 §3.5 扩展已存在的 action receipt/data mapper，不另建平行状态；覆盖 dialog/file chooser/download unknown 与 target 切换竞态。

### B6 — 中央指针 preflight

删除 hover/scroll/drag/collect 的旁路，在唯一物理投递边界执行 §3.8。多步动作无法确认投递量时必须写完整既有 tuple：`dispatch=accepted, delivery=unknown, effect=unknown, mayHaveCommitted=true, needsObservation=true`；只允许观察与收口，不允许自动重试。

### B7 — 一次性 root cutover

B3 download consumer 与 B4 handoff handler/finalize 的 readiness gate 都通过后，才在同一个发布步骤中：

1. 更新 registry/schema，加入 `tabs_handoff`；从 Codex unsupported/exclusion 移除 `browser_download`。
2. 只增加一次 `rootSurfaceContractVersion/tool_surface_digest`，下一条真实用户输入按 §3.6 retire 旧 binding 并建新 generation；不迁移当前 turn，不自动重放。
3. cutover 前两条能力在模型面都不可见；cutover 后必须同时可见并可 dispatch。任一 readiness 缺失则两条都保持隐藏，不能只上线一半。
4. gate 断言版本只增加一次、旧 generation 仍按旧面收口、新 generation 同时具备两条新 operation。

## 5. 必须先红后绿的行为门

### 5.1 准入与组合

新增 production composition/admission 行为测试，并接入 `verify:codex-workbench-surface`：

1. document + 天气 → web research 有，Browser 为零；自然语言 live-info/map 不能加 Browser。
2. Browser host 无 pageRef → Browser 为零，不能从 active tab 偷读。
3. document + document anchor + explicit read ref → 文档地板 + 精确只读集合；无 tabs/click/type/upload/download。
4. current Browser + exact pageRef + document anchor → 当前 Browser 标准集合 + 文档资源；工作面仍是 browser。
5. selected skill → 只加入 manifest 完整名且满足 target/attachment/root 条件；当前只有 `tag_forge_exclusive` 和 negative policy 做减法，未知 generic exclusive 声明拒绝。
6. 上一轮有 Browser、下一轮无 Browser → 不继承；第一轮无 Browser、下一轮当前 Browser → root 不变时只换 turn allow-set。
7. 模型网关与 dispatch 使用同一 authority/authorization digest；错配、未知 operation、换 target 全部拒绝。
8. 显式只读集合逐项验证 registry 全 operation=`observe`；`browser_tabs` 明确缺席。
9. 首个新 native thread、已有 thread 新 turn、binding 前到达 tool request、native thread/turn identity 漂移；execution binding、browser workflow route 或初始 target authority 任一未持久 readback 时 bridge 零执行。missing/conflicting/replaced `parentTaskId/browserTaskId/journalRouteDigest` 全部拒绝。
10. current root + explicit read ref + selected skill 的输入顺序不同但 canonical digest 相同；权限按 target 分开，不能用 current root 的 mutation 工具写 explicit ref。
11. `open → switch → navigate → observe → click` 正常；伪造 tab、无关用户 tab close、导航后旧 document ref 和迟到旧 generation receipt 全部拒绝。
12. tab create intent 已写但物理结果未知、物理 tab 已创建但 provisional target 未写、provisional target 已写但 action 未 settle 三个 crash point；重启 reconcile 不重复建页，且原页可精确 adopt 后关闭或归属；迟到旧 create-intent generation 不能绑定 target/owner/cleanup。
13. B7 cutover 前 `browser_download/tabs_handoff` 同时不可见，readiness 齐全后同时可见可 dispatch；root contract version/digest 只增加一次。
14. popup regular/auth/manual/nested/missing-route/create-failure/external 各 lane；同一 action 同 URL 多次 popup 的 ordinal/idempotency 不冲突，manual/auth/external 均不生成 Agent causal target；regular/missing-route/create-failure 的 `shell.openExternal` 调用数严格为零，只有 policy=`external` 为一。

旧 `codex-browser-preturn-capability.test.ts` 中对 `use_browser` 和自然 intent 扩权的断言应删除或改成 supporting/retired 事实，并由上述生产测试替代。

### 5.2 下载与终态

新增并实际接入 native runner：

- download 单文件/多文件部分成功、文件已发布但 receipt 失败、断线、进程重启、同 call replay、hash readback 不符；特别覆盖第二个文件下载中崩溃时「首个 completed、第二个 claimed→unknown、重启后网络调用总数不增加」。
- canonical closeout 对全部 live claim 状态的 durable release；outbox crash recovery；transient close、manual keep、delivery keep、用户接管；证明 terminal 后零执行 claim。
- stop、nonaccept、transport failure 与普通 terminal 使用同一 participant，旧 run 的迟到 receipt 不能影响新 run。
- 以上每种 terminal 路径断言 canonical claim receipt、outbox 和产品终态只经过一个 DB transaction，并同提交或同回滚。
- handoff 断言 physical owner/required/activity、`agentWorkTabs/agentTabId`、writer/supervisor/pointer 全量 readback；缺任一项不得写 completed receipt，且 unknown 恢复不能重新授权 Agent writer。
- 完整 owner-control receipt 允许 `tabs_handoff` 无额外页面 snapshot 收口；receipt 缺失、错 action/target generation/boot 或任一 readback 不完整时仍 unresolved，且普通 page mutation 不能借此跳过 observation barrier。
- 注入 canonical participant 失败时，内部 verifier seal 仍只读留档，产品 closeout/projection/publication 均未提交且该 digest 不能被下一轮复用。
- 在 create 的 claimed/物理返回/provisional_bound 三点和 handoff_pending 点分别注入 stop、nonaccept、transport terminal；断言 terminal fence 后无新 authority/Agent owner，所有晚到 tab 只进入 cleanup receipt，迟到结果不能改写 terminal projection。
- 注入 canonical participant 失败后立即杀 Main，再启动跨 boot product-fence reclaim；readback durable effect fence 仍为 closing，新 Main 只能重试 closeout/reconcile，Browser 工具执行、建页、owner promotion 与页面写入计数均为零。
- 在 effect fence 仍为 active 时直接杀 Main：exact turn 无 lifecycle action 时，只有 combined product/effect participant 证明旧 boot 死亡后才允许 `active(oldBoot) → closing(newBoot)` 并生成 digest 可重放的 `owner_boot_lost` closeout command；已有合法 lifecycle action 时必须生成 `lifecycle_recovery` command，绝不生成 owner-loss。两路都不得恢复旧 Browser writer/target/建页，command 任一 ref/字段/digest 错误时继续封锁。
- 分别对 stop/close/reset 注入四个 crash seam：action row 已提交后旧 Main 退出、interrupt 已发但 terminal candidate 未写、candidate 已写但最终 effect command 未写、最终 command 已写但 canonical 未提交。重启后必须按 exact action/run/thread/turn/evidence 继续既有路径，且 stop=`cancelled_user`、close=tombstone scope、reset=空 generation + 新可见 epoch；owner-loss command、Browser writer/tool dispatch、target promotion、建页与 verifier 调用数都为零。
- command schema gate 拒绝所有非法组合：success 携带 owner-loss/lifecycle source、success 任一 candidate/seal/quality/verifier/completion receipt 为空、requested terminal 带 death evidence、普通 failure candidate ref/digest 半空、lifecycle failure 无 recorded candidate 或 action/initiator 交叉错配、owner-loss death evidence 为空或 terminal status/reason/initiator 非固定值、lifecycle recovery 缺 action/requestedAt/evidence 或 run/task/scope/alias/thread/turn/digest 不匹配。另逐个反测 `runtime_failure + user_close`、`runtime_failure + user_reset`、`runtime_failure + cancelled_user`、`runtime_failure + startup_recovery/browser_owner_boot_lost`，以及任意未列入 `BrowserRuntimeFailureDisposition` 的 tuple；未知 variant/额外终态字段同样 fail-closed。
- parser/gate 还必须覆盖“内容另算合法 digest，但语义不相等”：普通 failure command 引用 success/lifecycle/owner-loss evidence，success command 引用 failure payload，command 与 product runtime 的 run/task/scope/thread/turn 不同，errorCode 与 failure evidence 不同，candidate/tool receipt/seal/quality/verifier/completion/duration 任一 identity 或 digest 交叉。全部拒绝，且 Browser canonical participant 不能以 raw canonical input 绕过 parser。
- 分别直接调用现有 generic success/failure raw API 命中 Browser-fenced run 的 active、closing、closed 三态，必须都得到 `browser_effect_command_required`，且产品终态、projection、claim、outbox、product/effect fence 与 receipt 数全部不变；无 Browser effect fence 的普通 Codex run 仍按原行为成功。host failure、native terminal、verifier accept/nonaccept、run-local recovery、stop/close/reset 的每个现有直接调用点都要有 Browser-fenced 行为用例，证明不是只迁移主成功路径。
- transition receipt 摘要门覆盖：writer/parser/checker 对同一 unsigned receipt 得到同一 digest；object key 顺序变化 digest 不变；把 `receiptDigest` 自身纳入、漏字段、额外字段、null 被省略均拒绝。另对 previous head、product/effect before/after、command 或 generation 修改后重新计算合法 digest，证明仍会因 fence head/连续性不符而回滚；双 root、同 previous head 分叉、同 after generation 或重复 digest 由数据库约束直接拒绝。
- 构造 A→B→C 连续 transfer 后，A/B 用各自旧 ownership handle 迟到提交、C 用错 generation/head/command、fence 为 active、closed receipt 不匹配、receipt 断链/分叉、product/effect owner 不一致时，全部在同一 canonical transaction 回滚；只有 current C 的 exact handle 能提交一次，并以 `canonical_close` receipt 将 fence generation 加一后置 closed。C 的 exact terminal retry 只返回同一已提交 readback，所有写入计数保持不变。
- effect-fence/closeout-command 事务已提交、canonical transaction 前崩溃：重启逐个 ref+digest readback frozen command，经 parser 重新派生相同 canonical input/digest，不重跑 verifier；篡改或语义错配 candidate/publication/seal/quality/verifier/failure/duration 任一对象都只能保持 closing。
- A 崩溃后，在 combined transaction 的 product transfer 与 effect CAS 之间注入 B 崩溃，证明整笔回滚；C 只能形成一个与 durable lifecycle action 是否存在相符的 effect command，并完成唯一对应收口。再覆盖 B 在整笔提交后崩溃，C 以 combined closing transfer 接管。全程 Browser writer、target promotion、建页与重复 verifier 计数为零。

### 5.3 指针、观察与真实 BrowserView

- hidden/parked/background target 下 click/hover/scroll/drag/collect 全部零 dispatch、零 focus、零 tab switch。
- drag 中途失 foreground 且投递量不可确认时，写 `dispatch=accepted, delivery=unknown, effect=unknown, mayHaveCommitted=true, needsObservation=true`，不重放。
- environment summary 绑定动作 target/postActionTabId；用户同时切 tab 时不读错页；unknown 字段省略。
- dialog 未处理时 summary 可见但 barrier 仍在；不调用真实 observe 工具不能 seal。
- 新增命名门 `npm run verify:codex-browserview-fixture`：`scripts/run-codex-browserview-fixture.mjs --timeout-ms 90000` 使用隔离临时 userData 和 `scripts/fixtures/codex-browserview/` 的 loopback fixture，启动真实 Electron，并验证：
  - visible/foreground、hide→show bounds、hidden pointer 零投递和 session 下载落盘；
  - Agent regular/nested popup 按 intent 精确 adopt，manual open-tab 与 auth `allow-popup` 不进入 run authority，missing-route/create-failure 不生成 Agent tab 且 external invocation 为零；只有 policy=`external` 真调用外部路径；
  - 记录完整 Main→Renderer tab 事件、每次 tab-list/active/split 快照与 session 持久写；provisional 阶段四者必须全部不可见，成功 promotion 后恰好一次正式 opened，terminal/cleanup 路径事件数为零；
  - handoff 后页签仍显示且 physical owner/required/activity、Agent maps、writer/supervisor/pointer 全量 readback 正确；
  - stop/nonaccept/transport terminal 与 create 返回、handoff_pending 竞争后，没有新 Agent tab、旧 run target/writer 或迟到 completed receipt；canonical participant 失败后杀 Main 并重启，closing fence 阻止跨 boot 恢复写入；active Browser run 直接崩溃时，无 lifecycle action 才通过 combined product/effect transfer 转 owner-boot-lost 非成功收口；stop/close/reset action 已持久化时分别保持其既有产品语义。两类均覆盖 A→B 事务中崩溃→C、A→B 提交后 B 崩溃→C，以及 A/B 迟到 closeout 均被拒绝、只有 C 精确提交。
- runner 写临时 JSON report，`scripts/check-codex-browserview-fixture-report.cjs` 除 action/target/generation/file/hash 外，还强制 readback `intentId/intentGeneration/popupOrdinal/popupLane/externalInvocationCount/provisionalOwner/rendererEventSequence/sessionWriteSequence/agentActivationFence/productFenceOwnerBootId/productFenceRevision/effectFenceBootId/effectFenceGeneration/transitionChainHeadDigest/commandSelectionReceipt/productEffectTransferReceipt/canonicalCloseReceipt/effectCommandKind/effectCommandDigest/lifecycleActionEvidenceDigest/derivedCanonicalInputDigest/handoffReceipt/ownerControlReadback/physicalOwner/cleanupReceipt/terminalFence`。checker 对每条 transition receipt 先用严格 unsigned schema 重算 digest，再检查 head/previous/owner/generation 连续；任一缺失、超时、skip、非 settled receipt、provisional 可见、owner/generation/chain 不连续或 Agent map 未清都非零退出。lifecycle 用例还必须拒绝 action 与最终语义不一致，且 report 中的 derived digest 必须由 checker 从 command/evidence 重算一致。
- 把 `verify:codex-browserview-fixture` 串入 `verify:browser-orchestration`；`ELECTRON_RUN_AS_NODE=1` 只证明 ABI，不能替代这条。

## 6. 验证命令与归属

| 门 | 本轮必须新增/证明 |
| --- | --- |
| `npx tsx --test src/__tests__/codex-tool-surface.test.ts` | root/turn 冻结、控制工具和 download 迁移 |
| `npm run verify:codex-workbench-surface` | 新 production Browser admission/composition 测试已列入脚本，不是孤立测试 |
| `npm run verify:browser-surface` | registry、schema、显式只读集合、公开名一致 |
| `npm run verify:browser-orchestration` | exact target、operation authorization、barrier、summary、pointer preflight 用例已列入脚本 |
| `npm run verify:browser-grounded-orchestration-native` | runner 明确包含 download artifact、Codex closeout/finalize、crash/replay 新用例 |
| `npm run verify:codex-browserview-fixture` | 上述固定 runner/fixture/report checker 的真实 Electron BrowserView 可见性、输入与下载 smoke；同时列入 `verify:browser-orchestration` |
| `npm run typecheck` | 公开合同和组合器类型 |
| 出包后登录站点手验 | 只补真实登录态、用户接管与体验，不替代自动门 |

执行前必须先检查 `package.json` 和 native runner 的测试清单；测试文件存在但未列入命名 gate 不算覆盖，skip 不算通过。

## 7. 实施顺序与停止条件

1. B0 合同、旧事实裁决与红测。
2. B1 工作面/资源解耦 + B2 精确工具面，一次改 production composition。
3. B3 隐藏 download consumer。
4. B4 隐藏 handoff handler + claim closeout/finalize outbox。
5. B5 结果摘要 + B6 中央指针边界。
6. B7 一次性 root cutover 与 generation migration。
7. 跑 §6 全部门，修复到绿；更新 `current-runtime-contracts.md` 和被本计划明确判定漂移的前置状态。
8. 独立对抗复审 P0/P1/P2 清零后，才允许把实现状态改为 completed。

任何阶段出现以下情况立即停在非成功状态，不继续堆补丁：无法写出 target/operation 合同；模型可见面与 dispatch 授权来源不同；副作用已发生但 receipt 不可确认；terminal 后仍有执行 claim；命名 gate 未实际收录新测试；真实 BrowserView smoke 未跑。

## 8. 明确不做

1. 不引入第二 Browser Agent、Playwright、Matrix MCP supervisor 或坐标工具替换现有结构 ref。
2. 不启用 Codex `browserUse/computerUse`，不修改 `rust-v0.146.1`。
3. 不恢复 `use_browser/use_skill`、同轮扩权、公开续跑、continue 按钮或 non-user successor。
4. 不用关键词/站点规则替模型选择 Browser 下一步；代码只做结构准入、权限、状态机、确认和可重复转换。
5. 不自动 snapshot/screenshot，不把摘要冒充观察证据。
6. 不证明 hidden host 后台指针；本轮只保证不可投递时诚实、无旁路、无偷切页面。

## 9. 审查记录

| 轮次 | 结论 | 主要处理 |
| --- | --- | --- |
| 1 | FAIL | 发现 host 默认面越权、Browser 全集未先删除、terminal claim 自相矛盾、下载无 consumer、物理 finalize 假原子、指针旁路与 gate 伪覆盖；已全部进入机器合同和命名门 |
| 2 | FAIL | 继续发现准入与 native identity 时序、existing canonical held-claim participant、同轮 causal target、现有 action outcome、逐文件 claimed、Tag Forge 排他真值与真实 Electron 命名门；已按真实主链重写 |
| 3 | FAIL | 继续发现建页后 settle 前的崩溃窗口、parent/browser-task/journal route 缺失、handoff 幽灵 owner、root 双迁移顺序、verifier seal 时序与 outcome 文案漂移；已补 intent/adopt、物理交接 readback 与一次性 cutover |
| 4 | FAIL | 继续发现 terminal 与晚到 create/handoff 竞态、popup lane 混淆、handoff registry tuple 未冻结、真 Electron 门未覆盖新增物理路径；已补 terminal fence、lane/ordinal、完整 tuple 与实机 readback |
| 5 | FAIL | 继续发现 in-memory closing 无法跨回滚/重启、create intent 无 generation、旧 external fallback 可伪通过、provisional 瞬时泄漏与 handoff boot identity 缺口；已补 durable effect fence、CAS、零 fallback 与完整事件序列门 |
| 6 | FAIL | 上轮缺口已清零；新发现 active run 跨 boot 归属未定与 handoff 被普通页面观察屏障卡死。已固定 Browser owner-loss 只做非成功收口，并新增仅限 owner-control 的完整 readback receipt |
| 7 | FAIL | handoff 已闭合；继续发现 closeout intent 不是完整可重放命令，以及 product/effect fence 分事务留下 A→B→C 二次崩溃缝。已补全量 ref+digest 命令与 combined transfer participant |
| 8 | FAIL | 上轮缺口已清零；继续发现 durable stop/close/reset 与 owner-loss 竞争时会吞掉用户动作，以及终态 schema 允许矛盾字段组合。已固定 lifecycle action 优先的窄恢复路径，并改成互斥 command variants |
| 9 | FAIL | 上轮两项已闭合；继续发现普通 runtime failure 的自由字符串可冒充 lifecycle、owner-loss 或 success。已改为现行有限 disposition，并对所有保留名称做正反向隔离 |
| 10 | FAIL | 上轮缺口已闭合；继续发现 effect command 与持久 canonical input 形成两套可互相矛盾的终态真值。已删除第二份持久输入，改为验证唯一 command 后确定性派生 branded canonical input |
| 11 | FAIL | 上轮缺口已闭合；继续发现通用 raw closeout 可绕过 Browser 私有入口，且 A→B→C 后旧 owner 可持合法旧 command 抢提交。已新增底层事务 guard、连续 transition chain 与 current-boot ownership CAS |
| 12 | FAIL | 上轮两项已闭合；继续发现 transition receipt 摘要未定义 unsigned projection，导致接管链摘要可能自引用或各端算法漂移。已固定唯一公式、严格 schema、重算规则与防双根/分叉/同代重复的数据库约束 |
| 13 | PASS | 独立审查者复核 P0/P1/P2 全部为零；同时复查 raw closeout 防旁路、A→B→C owner/generation 链、lifecycle action 优先、单一终态真值、B7 单次切换、真实 Electron 命名门与旧路径退役，未发现新的物质缺口 |
| 14 | IMPLEMENTATION SLICE | 文档合同保留；本轮不新建 BrowserRunEffectFence / command variant / tabs_handoff / createOrAdoptTab。落地 B0–B2 生产组合、B4 扩现有 claim release、B5 摘要、B6 指针 preflight；下载与 handoff 继续隐藏 |

## 10. 本轮实施切片（去掉过度防御）

Codex 审查补上的身份、组合、不扩权原则是对的。下面这些对，但明显过重，本轮不实现：

- `BrowserRunEffectFence`、互斥 command variants、transition receipt chain、branded ownership handle：这是第二套 closeout 内核。现有 product fence + `releaseHeldBrowserTargetClaims` + lifecycle adapter 已能收口。
- `BrowserTabCreateIntent` / `createOrAdoptTab` / provisional owner / popup ordinal：页签因果链另立项。
- `tabs_handoff` 与 B7 root cutover：没有公开交付入口前不上线新 schema。
- 新的 `verify:codex-browserview-fixture` 巨报告门：沿用现有 browser orchestration / native 门。

本轮必须落地：

1. B0/B1/B2：准入快照 +「先删全部 Browser 再按结构加精确集合」；文档锚/显式网页引用/当前页不再互覆盖；live-info 不能造 Browser。
2. B3：`browser_download` 继续排除，直到有独立回执消费者。
3. B4：canonical closeout 释放本 run 全部 live claim（held/user_owned/suspended），不另开事务。
4. B5：动作回执可带 bounded `environmentSummary`。
5. B6：hover/scroll/drag/collect_scroll 走与 click 同一 `trusted_pointer` preflight。
