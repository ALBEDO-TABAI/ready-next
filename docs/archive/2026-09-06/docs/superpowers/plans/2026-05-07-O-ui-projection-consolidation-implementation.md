---
stage: O (Stage 9 — UI 与投影收口)
sequence: after N (parent loop retire force-typed-action)
status: draft v8 (2026-05-07)
verify_target: verify:o
inherits: verify:n
enforce: false
revision_history:
  - v1 (2026-05-07): initial draft.
  - v8 (2026-05-07): codex YELLOW on v7 (0 RED + 3 YELLOW). v8 fixed:
      [Y01] §0.3 `cleanupAgentRuntime` 签名错——源文件是
      `export async function cleanupAgentRuntime(): Promise<void>` 并
      `await runtime.stop()`（`ipc-handler.ts:160`）；v7 写的是 `function
      cleanupAgentRuntime(): void`。v8 改为 async 签名并显式说明 unsubscribe
      调用排在 `await runtime.stop()` 之前（store 仍存在时执行 off）。
      §3.3 gate + §5.1 test 也加一条：模拟 dev-reload（连续 setupAgentIPC
      两次）后，repository emit 一次 change 应该触发 webContents.send 一次
      （没有 leak 导致两次）。
      [Y02] §6 Files map 漏 `AGENTS.md`。CLAUDE.md §12 / AGENTS.md §12 要求
      指引必须同步；v8 把 `AGENTS.md` 加到 Modify 列表并在新增的 §6.22
      Stage O 简短说明里"两份同步"。
      [Y03] §1.1 `createDebouncedFetch` 没有 cancel 路径——dev-reload 或
      `filteredScopes` 变化时 useEffect cleanup 只 unsubscribe IPC 但不取消
      pending timer。v8 把 helper 接口改成
      `function createDebouncedFetch(fn, delay): { run, cancel }`，effect
      cleanup 同时调用 `unsubscribe()` + `debouncer.cancel()`。
  - v7 (2026-05-07): codex YELLOW on v6 (0 RED + 3 YELLOW) — three narrow
      wording / cleanup gaps. v7 fixed:
      [Y01] §0.3 IPC subscribe path didn't specify a teardown for the
      `agent:taskProjectionsChanged` push. v7 stores the unsubscribe in
      a module-level `currentTaskProjectionsChangeOff` slot, and calls
      it both at the top of `setupAgentIPC` (re-entry on dev reload) and
      from `cleanupAgentRuntime` (`ipc-handler.ts:160`). Also adds
      `runtime.removeAllListeners` symmetry for the `change` listener so
      dev-reload doesn't leak.
      [Y02] O1 invariant wording was stricter than the body. v7 widens
      O1 to: "blacklist 字段值必须来自 projection 链 / 命名 helper /
      bare literal — 三类形态由 §3.1 case 1-4 完整定义" so the invariant
      matches the gate's actual allowed forms.
      [Y03] O5 listed `task-card-from-projection.ts` as a whitelisted
      file for the debug placeholder, but the placeholder lives only in
      `task-status-vocabulary.ts`. v7 removes the spurious entry from
      the O5 whitelist (and §3.5 already correctly scopes the literal).
  - v6 (2026-05-07): codex RED on v5 (1 RED + 1 YELLOW). v6 fixed:
      [R01] §1.3 现状-vs-Stage-O 对照表里 `steps` 行的目标列还是
      `projection?.steps ?? []`（与 §1.3 后续代码 sample 与 §3.1 gate
      case-3 描述彼此矛盾）。v6 把表格行改为
      `normalizeProjectionSteps(projection?.steps) ?? []` 与 sample 对齐。
      [Y01] O1 invariant 顶部还写"3 处 constructor"，遗漏
      `parseSerializedTaskSnapshot:2453`。v6 改为"4 处"并显式列出 4 个
      file:line 与对应 plan 节号。
  - v5 (2026-05-07): codex RED on v4 (2 RED + 3 YELLOW). v5 fixed:
      [R01] §3.1 gate allowlist was too strict — it would reject v4 §1.2's
      own `inMemoryTaskRuns` rewrite (`taskTitle: null`, `status: undefined`,
      `interactionState: undefined`, `taskType: undefined`, `steps: []`,
      `waitingFor: 'none'`). v5 adds case (4) "bare literal RHS" to the
      allowed forms: `null`, `undefined`, `[]`, `{}`, `'<single-quoted>'`,
      `"<double-quoted>"`, integers, `true`, `false`. R9 stays consistent
      (literals are legal for blacklist fields when *not* sourced from a
      non-projection identifier).
      [R02] §1.3 `steps: projection?.steps ?? []` drops the
      `normalizeProjectionSteps(...)` adapter that today bridges
      `TaskProjectionStepData` (optional fields, electron.d.ts:448-455)
      → `ScopeRunState['steps']` (required `title/status/updatedAt`,
      types.ts:175-181). v5 changes §1.3 to `steps:
      normalizeProjectionSteps(projection?.steps) ?? []` (the helper
      already returns `[]` for a missing input; the trailing `?? []` is
      defensive). §3.1 case (5) "allowed normalizer/helper" is widened
      to include `normalizeProjectionSteps(projection?.steps)` alongside
      the two `resolveProjection*(projection)` helpers.
      [Y01] §1.8 wording was misleading — v4 said `SerializedTaskSnapshot`
      is "frozen projection-shaped". codex correctly points out the
      snapshot is built from `ScopeRunState` (`runtimeDriver.ts:27-58`)
      and carries fields like `agent/phase/toolTrace` that don't exist
      on `TaskProjectionRecordData` (`electron.d.ts:468-495`). v5 reframes
      §1.8 honestly: it is a **historical-snapshot exception** — the
      rename `snapshot → projection` is a deliberate gate-vocabulary
      choice that documents "this constructor reads from a frozen,
      message-attached, projection-shape-compatible record". The two
      types share enough shape for the constructor to work, but they
      are NOT the same type. v5 also adds explicit gate documentation
      that the §3.1 algorithm treats any identifier literally named
      `projection` as projection-source — the gate trusts the caller to
      pick this name only for projection-equivalent reads.
      [Y02] R9 wording was too optimistic. v5 reframes: there IS a real
      visibility gap from "first in-memory scope-run update" until "first
      successful projection write+push fetch", bounded by IPC RTT in the
      happy path. If projection write or push fails, the card stays
      missing until the renderer-driven `refreshPersistedTaskProjections`
      (still on `currentScopeId / filteredScopes.length` triggers) catches
      up — which can be long. v5 explicitly lists this as observable
      behavior and adds a follow-up note: if observed in production, the
      mitigation is the §1.2 literal `taskTitle: '正在启动…'` placeholder
      (legal under case-4 of the v5 gate).
      [Y03] §1.8 used `projection.currentStepId || null` which v4 §3.1
      did not list as an allowed form (only `??` was mentioned). v5 §3.1
      case (2) extends to "(1) ?? <literal>` OR `(1) || <literal>`" since
      both achieve identical "projection-prefixed RHS with a literal
      tail" semantics; this is a gate vocabulary widening, not a behavior
      change. parseSerializedTaskSnapshot keeps its existing `||` forms.
  - v4 (2026-05-07): codex RED on v3 (2 RED + 2 YELLOW). v4 fixed:
      [R01/R02] missed 4th `taskProjectionToTaskCardRun` constructor at
      `ChatPanel.tsx:2449-2487` (`parseSerializedTaskSnapshot`). It builds
      a historical task-card from `message.meta.taskSnapshot`, reading
      blacklist fields (`taskTitle / steps / waitingFor / resumableActions
      / taskContinuation / progress / blockedReason / recentArtifacts`)
      from a `snapshot: SerializedTaskSnapshot` parameter (`:133-159`).
      v4 treats `SerializedTaskSnapshot` as a frozen projection-shaped
      historical record (it IS the projection, snapshotted at message-save
      time — that's why the chat persists it). To make the gate honest,
      v4 renames the local from `snapshot` to `projection` inside
      `parseSerializedTaskSnapshot` so the gate's "RHS must start with
      `projection.` / `projection?.`" rule covers this constructor too.
      Gate algorithm in §3.1 is rewritten as a hard whitelist: blacklist
      field RHS must start with `projection` (any of `projection.X` /
      `projection?.X` / `projection?.X ?? <literal>`) — anything else
      (including `snapshot.X` if not renamed, `cached.X`, etc.) fails.
      [Y01] `resolveProjectionWaitingFor` deletion was over-aggressive.
      Current helper maps `projection.interactionState` →
      `awaiting_confirmation/awaiting_clarification/human_takeover` to
      `confirmation/clarification/agent_result` (`ChatPanel.tsx:221-224`),
      which v3's `projection?.waitingFor ?? 'none'` would drop and break
      the action-button rendering at `:1166-1193`. v4 KEEPS the helper
      with single-parameter signature (`fallback` parameter dropped) and
      preserves the interactionState mapping; uses `?? 'none'` only when
      neither `waitingFor` nor `interactionState` is set.
      [Y02] R9 risk register wording was wrong. v3 claimed whitelist-only
      `inMemoryTaskRuns` "preserves the scopeRunStates-only edge case" —
      codex pointed out `isTaskVisible` (`:624-632`) drops cards with
      empty `taskTitle / taskSummary / steps / progress / memoryCapture`,
      so blanked cards correctly DISAPPEAR rather than show fake state.
      v4 R9 reframes: the disappearance IS correct behavior (no fake
      state); first-frame visibility is restored via O2 push event +
      §0.2 main-side placeholder title (within ~50ms), so user-perceived
      flicker is bounded by IPC latency, not by polling.
  - v3 (2026-05-07): codex RED on v2 (2 RED + 2 YELLOW). v3 fixed:
      [R01] `inMemoryTaskRuns` (`ChatPanel.tsx:2247-2286`) was a parallel
      non-projection `TaskCardRun` constructor that the v2 gate would not
      have caught (it spreads `...run` from a scopeRunStates-only object).
      v3 restricts `inMemoryTaskRuns` body to **WHITELIST fields only**
      (phase / terminalReason / title / toolTrace / responseMessageId /
      responseSegmentToolTraceStart / error / updatedAt / memoryCapture /
      scopeId / taskId), nulls/blanks every blacklist field, and replaces
      the `...run` spread at `:2347-2348` with an explicit whitelist copy.
      v3 also strengthens `check-task-card-projection-only.cjs` to reject
      ANY spread (`...identifier`) inside `taskProjectionToTaskCardRun({...})`
      calls — closing the parser gap codex flagged.
      [R02] same gate fix as above (parser must reject spreads).
      [Y01] `task-projection-sync.ts:247-257` supersede call now passes
      `{ reasonHint: 'supersede' }` so the emit reason is `'supersede'`,
      not `'update'`. The §3.3 gate self-test for the supersede event
      shape now has a real call site to assert against.
      [Y02] `isBackgroundTaskRun` (`ChatPanel.tsx:635-653`) is refactored
      to consume `deriveTaskCardRuntimeState(run).visualState` plus an
      explicit `childOrDetachedIdentity` sub-clause; the existing per-card
      `budget_paused` grouping (cards go into background pile, single-card
      visual state still shows "预算已暂停") is preserved as documented
      behavior — both predicates now share one source of truth without
      fighting CLAUDE.md §6.13's distinct labels.
  - v2 (2026-05-07): codex RED on v1 (3 RED + 3 YELLOW). v2 fixed:
      [R01] dropped invented `hasLiveBackgroundChildRun` derived from a stale
      mount-time `activeChildRuns` snapshot; reuse the existing per-card
      `hasBackgroundSignal(run)` (waitingFor / terminalReason /
      taskContinuation.blockerType / step.childTasks) at
      `taskCardViewModel.ts:353` — already projection-derived and per-card.
      [R02] dropped the parallel `deriveTaskCardVisualState` function; instead
      Stage O **fixes** the existing `deriveTaskCardRuntimeState`
      (`taskCardViewModel.ts:372`) — re-orders priority to match CLAUDE.md
      §6.13 (`background_running > budget_paused`, `failed` only requires
      `!hasBackground`) and unifies the duplicated `TaskCardVisualState` enum
      between `taskCardViewModel.ts:77` (with `'waiting'`) and
      `task-status-vocabulary.ts:44` (with `'waiting_input'|'waiting_handoff'`).
      [R03] removed reference to non-existent `TurnTerminalReasonName`; the
      signal lives in `run.terminalReason: ScopeRunTerminalReason`
      (`renderer/modules/agent/types.ts:313,363`) which the existing helpers
      already consume.
      [Y01] narrowed `check-renderer-no-status-text-guess.cjs` scope: only
      scan files that import `TaskProjectionRecordData |
      ActiveChildRunSummaryData | TaskCardRun` (mirror of
      `check-status-vocabulary-single-source.cjs:9,101`); forbid only the 5
      full canonical phrases (`后台任务已完成` etc.) plus a closed list of
      reverse-includes patterns (`includes('完成')|includes('失败')|...`)
      restricted to lines that also contain `if(`/`return `/`set...(` —
      avoids `提交失败` (`SkillAskUserPrompt.tsx:98`) and `取消后台任务`
      (`ChatPanel.tsx:1127`) false-positives.
      [Y02] removed the `taskTitle / taskSummary` `?? run.X` exception; gate
      §3.1 puts both fields in the BLACKLIST. Flicker fix moves to main side:
      `task-projection-sync.ts` writes a `'正在生成…'` placeholder when
      summary has no title yet (one-line addition).
      [Y03] write events get a `silent?: boolean` option; reconciler-driven
      writes (`task-projection-reconciler.ts:779` via `params.store.update`)
      pass `silent: true` so renderer-fetch-triggered reconciliation does
      not loop a second push fetch.
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Stage O — UI 和投影收口（v2）

> Stage M 把 frame 写回收敛成两条声明的通道，Stage N 把"长任务父循环 force typed-action" 退役。Stage O 把任务卡 / 聊天胶囊 / 继续/重试/打开产物 按钮和 main↔renderer 之间剩下的 **状态 + 行动** 表面收敛成"只读 projection / 账本"，消灭所有"读消息正文/猜状态"的 UI 决策路径。

## 0. Why this stage now

Stage 6 L6 已经把 `TaskCardRun` 类型品牌化，并把"primary task-card 来源 = `task_projections`、debug 退化 = `agent:listActiveChildRuns`" 的形状钉死，但 4 个 follow-up 仍然挂着：

1. **Polling 投影：** renderer 通过 `useEffect(refreshPersistedTaskProjections, [persistedScopeRuns])`（`ChatPanel.tsx:2716-2718`）pull `agent:listTaskProjections`，且每 2 秒 pull 一次 `agent:listActiveChildRuns`（`ChatPanel.tsx:2720-2740`）。两者都没有 push 通道，状态在用户视角里抖动 / 落后。

2. **debug 行仍在拼"猜状态"文本：** `childRunTaskSummary(row)`（`ChatPanel.tsx:259-267`）和 `activeChildRunDebugRow`（`:298-349`）会把 `row.progress / row.blockedReason / row.closeStatus` 拼成 `'后台任务已完成'` / `'后台任务正在运行'` 这类中文摘要，并塞进 `taskSummary / steps[].detail`。即便 projection 已经覆盖该 child run，这条 debug 路径仍是合法 fallback。Stage O 要把它降级为"projection-空白时的最后一档"，并把 fallback 文案改成不带状态判断的占位（"后台任务（projection 暂未覆盖）"），消除 UI 自行翻译状态的入口。

3. **状态 + 行动的 fallback 链路读"运行态推导值"：** `mergedTaskRuns` 合并里 `resumableActions / recentArtifacts / taskContinuation / waitingFor / blockedReason` 都允许 `projection?.X || run.X` fallback（`ChatPanel.tsx:2298-2379`），其中 `run.X` 来自 `scopeRunStates[scopeId]`（in-memory，由 `agent:scopeRunEvent` 推导），projection 的写入又是 async（`runtime.ts:2172` `void syncTaskProjection(...)`）——这就是"失败被'继续中'盖住"的物理路径：一个 transient `running` `scopeRunEvent` 在 projection 还没把 `failed` 落地的瞬间被 fallback 选中。

4. **`deriveTaskCardRuntimeState` 现存优先级与 §6.13 文档不一致。** `taskCardViewModel.ts:372-412` 的现实顺序是 `failed (only when !hasBudget && !hasBackground) → budget_paused → background_running → waiting → done → running`。但 CLAUDE.md §6.13 要求 `失败且无后台存活 > 后台运行 > 预算暂停 > 等待用户 > 完成 > 普通运行`——即 `background_running > budget_paused`，且 `failed` 只需 `!hasBackground`（与 `hasBudgetPaused` 无关）。现状是"失败但同时预算暂停" → `budget_paused`（错），"后台 + 预算暂停" → `budget_paused`（错）。同时 `taskCardViewModel.ts:77` 自定义的 `TaskCardVisualState` 类型用 `'waiting'` 单成员，而 `task-status-vocabulary.ts:44` 用拆分的 `'waiting_input' | 'waiting_handoff'`——两份 enum 并存，写起来割裂。

Stage O 的可观察成果：

- `TaskCardRun` 全状态/行动字段（status / interactionState / waitingFor / resumableActions / continuationRef / recentArtifacts / blockedReason / progress / taskTitle / taskSummary）只来自 projection；`run.X` 只参与 phase / latestText / toolTrace / responseMessageId / 4 个 view-only 渲染字段。
- 没有 2 秒 timer 拉 `agent:listActiveChildRuns`；renderer 通过新 push 事件 `agent:taskProjectionsChanged` 接收增量更新。
- `deriveTaskCardRuntimeState`（**现存唯一决策点**，`taskCardViewModel.ts:372`）按 §6.13 重新排序，并且复用 `hasBackgroundSignal(run)`（已是 projection-derived，per-card）。
- `TaskCardVisualState` enum 唯一化（drop `'waiting'`，统一为 `waiting_input | waiting_handoff`）。
- `activeChildRunDebugRow` 即便走 fallback，不再翻译状态——`taskSummary` 退化为 `DEBUG_PLACEHOLDER_TASK_SUMMARY`；`childRunTaskSummary(row)` 删除。
- 4 条新硬门 + 1 条扩展现有硬门，把以上 invariant 钉到 CI。

## 1. Invariants this stage establishes

**O1. Projection 是 TaskCardRun 全部"状态 + 行动 + 标题"字段的唯一读源。** 具体而言，**所有** `taskProjectionToTaskCardRun({...})` 调用（**4 处** — `inMemoryTaskRuns:2262`、`mappedPersisted:2298`、`merged:2347`、`parseSerializedTaskSnapshot:2453`，分别对应 §1.2 / §1.3 / §1.3 第二轮 / §1.8）为下列 blacklist 字段（`status / interactionState / waitingFor / blockedReason / resumableActions / taskContinuation / recentArtifacts / progress / budgetUsagePercent / stepBudget / budgetWarningLevel / degradationReason / recoveryHistory / taskType / currentStepId / steps / taskTitle / taskSummary`）提供值时，RHS 必须满足 §3.1 gate 列举的 4 类合法形态之一：**(1) `projection.X` / `projection?.X` 链**；**(2) `(1) ?? <literal>` 或 `(1) || <literal>` 链 + literal 收尾**；**(3) 命名 helper**（`resolveProjectionWaitingFor(projection)` / `resolveProjectionBlockedReason(projection)` / `normalizeProjectionSteps(projection?.steps)`，可加 `?? <literal>`）；**(4) bare literal**（`null` / `undefined` / `[]` / `{}` / `'<str>'` / `'none'` / 整数 / `true` / `false`）。

不允许 `projection?.X || run.X` 或 `?? run.X` fallback；**不允许在调用对象字面量中使用 spread**（`...run` / `...persistedRun` / `...<任何标识符>`）——因为 spread 隐式携带源对象上的同名 blacklist 字段，绕过字段级检查。所有需要的字段必须显式列出。`parseSerializedTaskSnapshot` 通过 §1.8 的 `snapshot → projection` rename 进入 case-1/2/3 通用规则。Bare literal（case-4）的合法用途是 `inMemoryTaskRuns` 的 blacklist 字段空白化（§1.2）以及实测后的 placeholder fallback（§R9）。
   - `status`, `interactionState`, `waitingFor`, `blockedReason`
   - `resumableActions`, `taskContinuation`/`continuationRef`
   - `recentArtifacts`, `progress`
   - `budget*`, `degradationReason`, `recoveryHistory`, `taskType`
   - `taskTitle`, `taskSummary`（v2 移除 `phase=responding` 例外，flicker 由 main 侧 placeholder 修复）
   - `currentStepId`, `steps`
   仍然允许从 `run.X`（`ScopeRunState`）派生的字段（O1 白名单）：`phase`, `terminalReason`, `title`, `toolTrace`, `responseMessageId`, `responseSegmentToolTraceStart`, `error`（仅 phase==='error' 时展示一次性副本，不参与状态判定），`updatedAt`（仅 sort key），`memoryCapture`（独立侧通道）。

**O2. Projection 写入即推送。** 任何对 `taskProjectionStore.create / update / deleteByScope / supersede` 的成功提交，都通过 `taskProjectionStore.events`（新引入的 `EventEmitter`-shaped writer wrapper）触发 `'change'`，main 进程 IPC 转发为 `agent:taskProjectionsChanged`（payload `{ scopeId, changedTaskIds: string[], reason: 'create'|'update'|'delete'|'supersede' }`，**不**携带 record 主体）。Renderer 收到后用 scopeId 触发一次"重新 fetch projection"，保持 pull-based store 语义，把它从"timer 驱动" 换成"事件驱动"。

   **O2.1 Reconciler-driven write 静默。** `task-projection-reconciler.ts` 通过 `params.store.update(...)` 触发的写入是 **renderer-fetch-driven**（`runtime.listTaskProjections` 内联 reconcile，`runtime.ts:611-623`），如果它也 emit push 会形成 fetch→reconcile-write→push→fetch 死循环（虽然幂等收敛，浪费 IPC）。Repository write 接口加 `silent?: boolean` 选项；reconciler 调用方传 `silent: true`，其它 writer 默认 `silent: false`。

**O3. 2 秒 polling timer 退役。** `ChatPanel.tsx:2720-2740` 的 setInterval 删除；只保留一次启动期 fetch。`agent:listActiveChildRuns` 仅作为 debug 控制面（`activeChildRunDebugRow` 的 fallback 数据源）按需 fetch，不再常驻。

**O4. Visual state 物理化于 `deriveTaskCardRuntimeState` 单点，按 §6.13 排序。** 优先级固定：
   ```
   failed_no_background_alive (rank 100, = `failed` && !hasBackground) >
   background_running         (rank 90)  >
   budget_paused              (rank 80)  >
   waiting_handoff/input      (rank 70)  >
   done                       (rank 50)  >
   running                    (rank 10)
   ```
   实现：现有 `deriveTaskCardRuntimeState`（`taskCardViewModel.ts:372`）重排分支顺序为 `failed → background → budget_paused → waiting → done → running`；`isFailed` 的条件从 `!hasLiveBackground && !hasBudgetPaused` 收紧为 `!hasLiveBackground`（与 budget 无关）。`hasBackgroundSignal(run)`（`taskCardViewModel.ts:353`）保持原状——它已经是 per-card / projection-derived（消费 `run.waitingFor / terminalReason / taskContinuation.blockerType / step.childTasks`），不引入新的全局 `activeChildRuns` 扫描。

   **O4.1 `TaskCardVisualState` 单源。** 删除 `taskCardViewModel.ts:77` 的本地 enum；`deriveTaskCardRuntimeState` 直接 `import type { TaskCardVisualState } from './task-status-vocabulary'`。函数 return 值在原来返回 `'waiting'` 的分支改为按 `isAgentHandoff` 选择 `'waiting_handoff'` 或 `'waiting_input'`（与现有 `statusLabel` 派生逻辑一致，等同于把 `statusLabel` 的判定上移到 `visualState`）。下游消费方（`TaskPanel.tsx:327` + ChatPanel CSS class）做配套：CSS `data-state="waiting"` 的样式改成同时匹配 `data-state="waiting_handoff" | data-state="waiting_input"`（grep 一次确认 selector）。若 selector 不存在或仅在 className 中使用 visualState 字符串渲染中文 label（已经走 `taskCardVisualStateLabel`），则无 CSS 改动需要。

**O5. UI 不再自行把数据 → 中文状态文案。** Renderer 不允许：
   - 在 task-card / 胶囊文件里硬写 5 个完整短语：`'后台任务已完成' | '后台任务已取消' | '后台任务失败' | '后台任务等待继续' | '后台任务正在运行'`（**不在** `task-status-vocabulary.ts` 单源文件，该文件托管 `DEBUG_PLACEHOLDER_TASK_SUMMARY` 常量）。
   - 在 *决策上下文*（同一行含 `if (`、`return `、`set<Identifier>(` 之一）中使用 `.includes('完成') | .includes('失败') | .includes('等待') | .includes('后台') | .endsWith('中') | .startsWith('已')`。
   `childRunTaskSummary(row)` 删除；其唯一调用方 `activeChildRunDebugRow` 改写为返回固定 `taskSummary: DEBUG_PLACEHOLDER_TASK_SUMMARY`；常量集中在 `task-status-vocabulary.ts`。

**O6. CI 强制以上五条。** 4 条新硬门 + 1 条扩展现有硬门：见 §3。

## 2. Concrete changes

### Phase 0 — Inventory & main 侧推送通道

#### 0.1 Inventory（无代码改动）

锁定以下读 / 写位点：

| 类型 | 位置 | 说明 |
|---|---|---|
| 写 | `runtime.ts:2172` `syncTaskProjection(...)` | scope-run-event 同步派生写 |
| 写 | `skill-child-runner.ts:1682,1688,1697,1717,1732` | child-runner 直接写 |
| 写 | `runtime.ts:903` `taskProjectionStore.deleteByScope(scopeId)` | scope 销毁清理 |
| 写 | `task-projection-sync.ts:247,545,682,692,708` `store.update / store.create` | sync 内部 |
| 写（fetch-driven） | `task-projection-reconciler.ts:779` 通过 `params.store.update` | renderer-fetch 触发 reconcile，O2.1 必须 silent |
| 读 | `runtime.ts:608-624` `listTaskProjections(scopeId)` | renderer pull 入口（内联 reconcile） |
| 读 | `runtime.ts:626-630` `getTaskProjection(taskId)` | 单点查询 |

只要 wrap 写入端的 `TaskProjectionRepository` 即可一站式触发推送（详见 0.2）。

#### 0.2 主进程：把 `TaskProjectionRepository` 包装成"写后即推"

**File: `src/main/modules/repositories/task-projection-repository.ts`**

- 类内增加 `private readonly emitter = new EventEmitter()`，暴露
  ```ts
  on(event: 'change', listener: (payload: TaskProjectionChangeEvent) => void): this
  off(event: 'change', listener: (payload: TaskProjectionChangeEvent) => void): this
  ```
- 类型 `TaskProjectionChangeEvent`（新增于 `run-contracts.ts`）：
  ```ts
  export interface TaskProjectionChangeEvent {
    scopeId: string
    changedTaskIds: string[]
    reason: 'create' | 'update' | 'delete' | 'supersede'
  }
  ```
- Write 接口加 `options?: { silent?: boolean; reasonHint?: 'sync' | 'child' | 'supersede' | 'reconcile' }`；现有调用方默认 `silent: false`，`reasonHint` 默认 `undefined`（emit 时 reason 字段按操作类型 `create/update/delete` 决定）。仅 `task-projection-reconciler.ts` 写入传 `silent: true`。
- `create` / `update`：SQLite 提交成功后，若 `!options.silent` 则 emit `change`；payload `changedTaskIds: [taskId]`，reason 来自操作类型（如 `reasonHint==='supersede'` 则 reason='supersede'）。
- `deleteByScope(scopeId)`：先 `listByScope(scopeId)` 拿到 taskIds，再 delete，emit 一次 `change` 携带 `changedTaskIds: taskIds, reason: 'delete'`（非 silent）。
- 节流：repository 不做节流；renderer 侧 `createDebouncedFetch`（§1.1）在 100ms 窗口合并多次触发。

**File: `src/main/modules/agent-control/run-contracts.ts`**

- 新增 export `TaskProjectionChangeEvent`。
- `TaskProjectionStore` 接口加可选 method `on?: (event: 'change', listener: (e: TaskProjectionChangeEvent) => void) => this`（可选保持不破坏 mock-store 测试）。

**File: `src/main/modules/agent-control/task-projection-reconciler.ts`**

- 调用方 `params.store.update(...)` 改为 `params.store.update(taskId, patch, { silent: true })`（如果 `TaskProjectionStore.update` 当前签名不支持 options，需要先扩签名 — 先扩签名为 `(taskId, patch, options?)`，repository 实现已有此 options，sync 端仍传旧式调用兼容）。

**File: `src/main/modules/agent-control/task-projection-sync.ts`**

- 现有 `store.update / store.create` 不传 options（默认 `silent: false`，emit）。
- 单点新增 placeholder title（Y02 修复）：在 `effectiveSummary` 计算后、`return { ..., taskTitle: ... }` 之前，若 `effectiveSummary.taskTitle` 与 `previous?.taskTitle` 都为空且 `status === 'running'` 或 `'queued'`，把 record 的 `taskTitle` 设为 `'正在生成…'`（一行 nullish 兜底）。一次性，不影响后续真实 title 写入（write-after-write 直接覆盖）。

#### 0.3 主进程 IPC 转发

**File: `src/main/modules/claude-bridge/ipc-handler.ts`**

dev-reload 会重跑 `setupAgentIPC`；当前文件在 `:204` 只 `removeHandler` IPC `invoke` 入口，对 `runtime.on(...)` 类直接监听没有 unregister 路径。`cleanupAgentRuntime`（`:160`）只 stop runtime，不解绑这条新监听。Stage O 显式管理一份 module-scoped 的 unsubscribe slot：

```ts
// module-level, 与现有 mainWindow / runtime 模块状态同级
let currentTaskProjectionsChangeOff: (() => void) | null = null

export function setupAgentIPC(...) {
  // ... 现有逻辑 ...

  // O2 push 监听 —— dev-reload 时先解掉上一次的，避免 leak
  if (currentTaskProjectionsChangeOff) {
    try { currentTaskProjectionsChangeOff() } catch { /* ignore */ }
    currentTaskProjectionsChangeOff = null
  }

  const onProjectionChange = (event: TaskProjectionChangeEvent): void => {
    if (mainWindow.isDestroyed()) return
    mainWindow.webContents.send('agent:taskProjectionsChanged', event)
  }
  const projectionStore = runtime.getTaskProjectionStore()
  projectionStore.on('change', onProjectionChange)
  currentTaskProjectionsChangeOff = () => {
    try { projectionStore.off('change', onProjectionChange) } catch { /* ignore */ }
  }
}

// `cleanupAgentRuntime`（`ipc-handler.ts:160`，源文件签名 async/Promise<void>）追加：
export async function cleanupAgentRuntime(): Promise<void> {
  // 先 unsubscribe（trailing emit 有可能在 stop 内部触发）
  if (currentTaskProjectionsChangeOff) {
    try { currentTaskProjectionsChangeOff() } catch { /* ignore */ }
    currentTaskProjectionsChangeOff = null
  }
  // 然后 await 现有的 runtime.stop()（保留原有逻辑）
  // ... 现有 await runtime.stop() / 其它 cleanup ...
}
```

`TaskProjectionRepository.off` 在 §0.2 已经声明（`on/off` 对称），不引入新 API。

**File: `src/main/modules/agent-control/runtime.ts`**

- 新增 `getTaskProjectionStore(): TaskProjectionRepository`（read-only getter，返回 `this.taskProjectionStore`）。

#### 0.4 Preload 暴露订阅 API

**File: `src/preload/index.ts`**（参照 `onScopeRunEvent`/`onReferenceSkillHintChanged` 形状）

```ts
onTaskProjectionsChanged: (callback: (data: TaskProjectionChangeEvent) => void) => {
  const handler = (_e: unknown, data: TaskProjectionChangeEvent) => callback(data)
  ipcRenderer.on('agent:taskProjectionsChanged', handler)
  return () => ipcRenderer.removeListener('agent:taskProjectionsChanged', handler)
},
```

**File: `src/renderer/types/electron.d.ts`**

- 暴露 `TaskProjectionChangeEvent` 类型 + `agent.onTaskProjectionsChanged(...)` 签名。
- Codex review 确认时若文件名不是这个，改名以匹配 — 文件本体已存在（plan §1.4 引用 `RecoveryRecordData / TaskProjectionRecordData` 都来自该文件）。

### Phase 1 — Renderer：换成 push 驱动 + projection-only 字段 + 状态优先级修复

#### 1.1 删除 2 秒 polling，改为 push 驱动

**File: `src/renderer/components/agent/ChatPanel.tsx`**

- 把 `:2720-2740` 的 setInterval 整段删除；保留**仅一次**的"组件 mount 后 fetch"：
  ```ts
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      if (!window.electronAPI?.agent?.listActiveChildRuns) return
      const result = await window.electronAPI.agent.listActiveChildRuns().catch(() => null)
      if (cancelled) return
      setActiveChildRuns(result?.success && Array.isArray(result.data) ? result.data : [])
    }
    void refresh()
    return () => { cancelled = true }
  }, [currentScopeId])
  ```
  注：`activeChildRuns` state 仅用于 `activeChildRunDebugRow` 的 projection-空白 fallback 数据；其触发场景是新 child-run 启动 → projection 写入 → push event → renderer fetch projection（已覆盖）。Stage O 之后 mount-time `activeChildRuns` 主要用作"Ready 启动后第一次扫描已存在的活动 child run"。
- 新增 useEffect 订阅 `onTaskProjectionsChanged`，cleanup **同时**取消 pending debounce timer + unsubscribe IPC：
  ```ts
  useEffect(() => {
    if (!window.electronAPI?.agent?.onTaskProjectionsChanged) return
    const debouncer = createDebouncedFetch(refreshPersistedTaskProjections, 100)
    const off = window.electronAPI.agent.onTaskProjectionsChanged((event) => {
      if (filteredScopes.some((scope) => scope.id === event.scopeId)) debouncer.run()
    })
    return () => {
      try { off?.() } catch { /* ignore */ }
      debouncer.cancel()  // v8 — 关闭 pending timer，防止 unmount 后回调
    }
  }, [filteredScopes, refreshPersistedTaskProjections])
  ```
- 删除 `useEffect(refreshPersistedTaskProjections, [..., persistedScopeRuns])`（`:2716-2718`）的 `persistedScopeRuns` 依赖——push 通道接管"projection 变了"信号；保留 `currentScopeId / filteredScopes.length` 触发以覆盖切 scope。

`createDebouncedFetch` helper（v8 接口）：

```ts
// src/renderer/modules/agent/debouncedFetch.ts
export interface DebouncedFetcher {
  run(): void
  cancel(): void
}

export function createDebouncedFetch(fn: () => void, delay: number): DebouncedFetcher {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    run: () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; fn() }, delay)
    },
    cancel: () => {
      if (timer !== null) { clearTimeout(timer); timer = null }
    },
  }
}
```

单测随主测一起加（`src/__tests__/debounced-fetch.test.ts`：run-合并、cancel-阻断、cancel-重入安全 三个 case）。

#### 1.2 `inMemoryTaskRuns`：whitelist-only 字段（v3 新增 — 闭合 R01）

**File: `src/renderer/components/agent/ChatPanel.tsx:2247-2286`**

`inMemoryTaskRuns` 当前直接从 `scopeRunStates` 构造 `TaskCardRun`，blacklist 字段（`taskTitle / steps / waitingFor / resumableActions / taskContinuation / progress / blockedReason / recentArtifacts`）全部来自 in-memory `run.X`——即便 §1.3 的 `mergedTaskRuns` 后续会用 projection 覆盖，**初始 TaskCardRun 上仍然带着这些 blacklist 字段值**，并在 `:2347-2348` 通过 `...run` spread 进入合并对象。这就是 R01 的物理路径。

v3 把 `inMemoryTaskRuns` body 改成 **WHITELIST-only**（其余字段 `null` / `[]` / `undefined`）：

```ts
const inMemoryTaskRuns = useMemo<TaskCardRun[]>(() => {
  return filteredScopes
    .map((scope) => {
      const run = scopeRunStates[scope.id]
      if (!run || !isTaskVisible({ ...run, scopeId: scope.id, title: scope.title, updatedAt: run.updatedAt || scope.updatedAt })) {
        return null
      }
      return taskProjectionToTaskCardRun({
        // O1 whitelist 字段（in-memory 来源合法）
        scopeId: scope.id,
        taskId: run.taskId || run.taskContinuation?.taskId || null,
        phase: run.phase,
        terminalReason: run.terminalReason,
        title: scope.title,
        toolTrace: run.toolTrace,
        responseMessageId: run.responseMessageId || null,
        responseSegmentToolTraceStart: run.responseSegmentToolTraceStart ?? 0,
        error: run.error,
        updatedAt: run.updatedAt || scope.updatedAt,
        memoryCapture: run.memoryCapture,
        // O1 blacklist 字段强制为 null/空——只能由 projection 在 mergedTaskRuns 第二轮赋值
        taskTitle: null,
        taskSummary: null,
        steps: [],
        currentStepId: null,
        waitingFor: 'none',
        resumableActions: [],
        recentArtifacts: [],
        taskContinuation: null,
        progress: null,
        status: undefined,
        interactionState: undefined,
        budgetUsagePercent: null,
        stepBudget: null,
        budgetWarningLevel: undefined,
        degradationReason: undefined,
        recoveryHistory: undefined,
        blockedReason: null,
        taskType: undefined,
        executionDiagnostics: undefined,
      })
    })
    .filter((value): value is TaskCardRun => value !== null)
}, [filteredScopes, scopeRunStates])
```

代价：projection 落地前一帧的"运行中卡片" 不再显示历史 in-memory `taskTitle` / `steps`——但 §0.2 的 main 侧 placeholder `'正在生成…'` 已经把 projection 第一帧填上了 title，且 `mergedTaskRuns` 第二轮会立刻用 projection 覆盖。

#### 1.3 `mergedTaskRuns`：projection-only 字段 + 删 spread（O1）

**File: `src/renderer/components/agent/ChatPanel.tsx:2288-2411`**

把以下字段的 `projection?.X || run.X` 全部改为 `projection?.X ?? null` 或 `?? []`：

| 字段 | 现状（line） | Stage O |
|---|---|---|
| `status` | 已经是 `projection?.status`（:2302, :2350）✓ | 保持 |
| `taskTitle` | `projection?.taskTitle \|\| run.taskTitle`（:2304, :2351） | `projection?.taskTitle ?? null`；flicker 由 §0.2 main 侧 placeholder 修复 |
| `taskSummary` | 同上 | `projection?.taskSummary ?? null` |
| `steps` | `projection?.steps ? projection.steps : run.steps \|\| []` | `normalizeProjectionSteps(projection?.steps) ?? []`（v5 修正：沿用现有 normalizer 桥接 `TaskProjectionStepData`→`ScopeRunTaskStep` shape） |
| `currentStepId` | `projection?.currentStepId \|\| run.currentStepId` | `projection?.currentStepId ?? null` |
| `waitingFor` | `projection ? resolveProjectionWaitingFor(...) : run.waitingFor` | `resolveProjectionWaitingFor(projection)` 单参 |
| `resumableActions` | `projection?.resumableActions...length>0 ? projection.resumableActions : (run.resumableActions \|\| [])` | `projection?.resumableActions ?? []`（main 侧 §2.1 兜底） |
| `recentArtifacts` | 同上 fallback | `projection?.recentArtifacts ?? []` |
| `taskContinuation` | `resolveTaskContinuationForProjection(projection, run.taskContinuation)` | `projection?.continuationRef ?? null`；helper 删除 |
| `progress` | `projection?.progress \|\| run.progress \|\| null` | `projection?.progress ?? null` |
| `blockedReason` | `resolveProjectionBlockedReason(projection, run.blockedReason)` | `projection?.blockedReason ?? null`；helper 删除 |
| `interactionState`, `taskType`, `budget*`, `degradationReason`, `recoveryHistory` | `projection?.X` ✓ | 保持 |
| `terminalReason` | `run.terminalReason`（来自 ScopeRunState） | 保持（O1 白名单——`deriveTaskCardRuntimeState` 通过它判断 background / budget / blocked，是 status 之外的独立信号） |

允许从 `run.X` 派生的字段（O1 白名单，由 §3.1 gate 强制）：
- `phase`（取自 `scopeRunEvent`，projection 没有等价字段）
- `terminalReason`（同上，是 `deriveTaskCardRuntimeState` 的输入）
- `title`（scope title，与 projection 解耦）
- `toolTrace`（renderer-only 工具轨迹）
- `responseMessageId` / `responseSegmentToolTraceStart`
- `error` 字符串（仅 phase==='error' 时展示一次性副本，不参与状态判定）
- `updatedAt`（sort key）
- `memoryCapture`（独立侧通道）

**第二轮 `merged.set` 必须显式列字段，不能 `...run` 兜底（v3 新增 — 闭合 R01/R02）。** `:2347-2348` 当前是 `taskProjectionToTaskCardRun({ ...run, taskId: ..., status: ... })`；v3 改为：

```ts
merged.set(run.scopeId, taskProjectionToTaskCardRun({
  // 白名单字段从 inMemoryTaskRuns 拷贝
  scopeId: run.scopeId,
  phase: run.phase,
  terminalReason: run.terminalReason,
  title: run.title,
  toolTrace: run.toolTrace,
  responseMessageId: run.responseMessageId,
  responseSegmentToolTraceStart: run.responseSegmentToolTraceStart,
  error: run.error,
  updatedAt: run.updatedAt,
  memoryCapture: run.memoryCapture,
  // 黑名单字段从 projection 直读，无 fallback
  taskId: projection?.taskId || run.taskId || persistedRun?.taskId || run.taskContinuation?.taskId || null,
  status: projection?.status,
  taskTitle: projection?.taskTitle ?? null,
  taskSummary: projection?.taskSummary ?? null,
  steps: normalizeProjectionSteps(projection?.steps) ?? [],
  currentStepId: projection?.currentStepId ?? null,
  waitingFor: resolveProjectionWaitingFor(projection),
  resumableActions: projection?.resumableActions ?? [],
  recentArtifacts: projection?.recentArtifacts ?? [],
  taskContinuation: projection?.continuationRef ?? null,
  progress: projection?.progress ?? null,
  taskType: projection?.taskType,
  interactionState: projection?.interactionState,
  budgetUsagePercent: projection?.budgetUsagePercent,
  stepBudget: projection?.budget?.stepBudget,
  budgetWarningLevel: projection?.budgetWarningLevel,
  degradationReason: projection?.degradationReason,
  recoveryHistory: projection?.recoveryHistory,
  blockedReason: projection?.blockedReason ?? null,
}, projection, persistedRun))
```

`taskId` 例外保留多源 fallback（白名单字段 — projection / runtime / continuation 任一来源都允许；`run.taskContinuation?.taskId` 是 continuation-bound 的 stable id）。

#### 1.4 `activeChildRunDebugRow`：固定占位 taskSummary

**File: `src/renderer/components/agent/ChatPanel.tsx:259-349`**

- 删除 `childRunTaskSummary(row)` 函数及全部调用。
- `activeChildRunDebugRow` 内：
  - `taskSummary: DEBUG_PLACEHOLDER_TASK_SUMMARY`
  - `steps[0].detail: DEBUG_PLACEHOLDER_TASK_SUMMARY`
  - `steps[0].title`：保留 `row.progress?.stage || '后台技能执行'`（不是状态判断，是阶段名）
- `resumableActions / waitingFor / phase / status` 仍由 `task-status-vocabulary.ts` 的 `childRunToProjectionStatus / childRunToPhase / childRunToWaitingFor / childRunToTaskActions` 决定，这是 Stage 6 L5 已经集中过的 derive 函数（不读消息文本）。

`DEBUG_PLACEHOLDER_TASK_SUMMARY = '后台任务（projection 暂未覆盖）'` 集中常量见 §1.4。

#### 1.5 修复 `deriveTaskCardRuntimeState` 优先级 + 统一 `TaskCardVisualState` (O4)

**File: `src/renderer/modules/agent/taskCardViewModel.ts`**

a) 删除 `:77-83` 的本地 enum：
```ts
// removed (replaced by import from task-status-vocabulary)
// export type TaskCardVisualState = 'background_running' | 'budget_paused' | 'waiting' | 'done' | 'failed' | 'running'
```
改为：
```ts
import { phaseToUserLabel, projectionStatusToUserLabel, taskCardVisualStateLabel } from './task-status-vocabulary'
import type { TaskCardVisualState } from './task-status-vocabulary'
```
（合并到现有 import 行 `:8`。）

b) 重写 `deriveTaskCardRuntimeState`（`:372-412`）：
```ts
export function deriveTaskCardRuntimeState(run: TaskCardRunLike): TaskCardRuntimeState {
  const hasLiveBackground = hasBackgroundSignal(run)
  const hasBudgetPaused = hasBudgetPausedSignal(run)
  const isAgentHandoff = isInternalAgentHandoffTask(run)

  // O4: rank-100 — failed only when no live background. budget irrelevant.
  if ((run.phase === 'error' || run.status === 'failed') && !hasLiveBackground) {
    return { visualState: 'failed', statusLabel: taskCardVisualStateLabel('failed'), actionSet: ['retry', 'cancel', 'open_artifact'] }
  }
  // O4: rank-90 — background outranks budget_paused.
  if (hasLiveBackground) {
    return { visualState: 'background_running', statusLabel: taskCardVisualStateLabel('background_running'), actionSet: ['continue', 'open_artifact', 'cancel'] }
  }
  // O4: rank-80
  if (hasBudgetPaused) {
    return { visualState: 'budget_paused', statusLabel: taskCardVisualStateLabel('budget_paused'), actionSet: ['continue', 'retry', 'cancel'] }
  }
  // O4: rank-70 — waiting (split into handoff/input by isAgentHandoff)
  if (
    (run.waitingFor && run.waitingFor !== 'none')
    || hasBlockedTerminalReason(run)
    || run.terminalReason === 'checkpoint_user_input'
    || run.status === 'blocked'
    || run.interactionState === 'awaiting_clarification'
    || run.interactionState === 'awaiting_confirmation'
    || run.interactionState === 'human_takeover'
  ) {
    const visualState: TaskCardVisualState = isAgentHandoff ? 'waiting_handoff' : 'waiting_input'
    const actions = (run.resumableActions || []).filter((action): action is TaskCardAction =>
      action === 'continue' || action === 'retry' || action === 'open_artifact' || action === 'cancel',
    )
    return {
      visualState,
      statusLabel: taskCardVisualStateLabel(visualState),
      actionSet: actions.length > 0 ? actions : ['continue', 'cancel'],
    }
  }
  // O4: rank-50
  if (run.phase === 'done' || run.status === 'done') {
    return {
      visualState: 'done',
      statusLabel: taskCardVisualStateLabel('done'),
      actionSet: hasRecentArtifact(run) ? ['open_artifact'] : [],
    }
  }
  // O4: rank-10 (fallback)
  return { visualState: 'running', statusLabel: taskStatusLabel(run.status) || taskPhaseLabel(run.phase), actionSet: ['cancel'] }
}
```

c) 添加 `DEBUG_PLACEHOLDER_TASK_SUMMARY`：

**File: `src/renderer/modules/agent/task-status-vocabulary.ts`**

```ts
/**
 * Stage O — fallback placeholder used by `activeChildRunDebugRow` when the
 * persisted `task_projections` table has not yet caught up with an active
 * child run. The literal must live here (single source) so the
 * status-vocabulary gate can prevent renderer files from inlining a
 * status-flavored Chinese string.
 */
export const DEBUG_PLACEHOLDER_TASK_SUMMARY = '后台任务（projection 暂未覆盖）'
```

#### 1.6 收紧 / 删除 4 个 fallback helper

**File: `src/renderer/components/agent/ChatPanel.tsx`**

**保留并收紧（v4 修正——v3 误删会丢 interactionState→waitingFor 翻译）**：
- `resolveProjectionWaitingFor`（`:216-226`）：保留函数体、删除 `fallback` 参数。新签名：
  ```ts
  function resolveProjectionWaitingFor(projection: PersistedTaskProjection | null): ScopeRunState['waitingFor'] {
    if (!projection) return 'none'
    if (projection.waitingFor) return projection.waitingFor
    if (projection.interactionState === 'awaiting_confirmation') return 'confirmation'
    if (projection.interactionState === 'awaiting_clarification') return 'clarification'
    if (projection.interactionState === 'human_takeover') return 'agent_result'
    return 'none'
  }
  ```
  这条 mapping 是按钮渲染（`ChatPanel.tsx:1166-1193`）的唯一来源，不能压平。`mergedTaskRuns` 调用方改为 `resolveProjectionWaitingFor(projection)` 单参，gate 通过（参数 `projection` 在 allowlist 上）。

**删除（无需保留）**：
- `resolveProjectionBlockedReason`（`:228-234`）— 改为 `projection?.blockedReason ?? null` 单行
- `shouldPreferProjectionContinuation`（`:236-249`）— 不再需要
- `resolveTaskContinuationForProjection`（`:251-257`）— 改为 `projection?.continuationRef ?? null` 单行

#### 1.7 CSS / className 配套（O4.1）

`grep -rn "data-state=.*waiting" src/renderer/` 查 CSS selector / className；如存在 `waiting` 单值 selector，扩展为 `waiting_handoff | waiting_input` 两个；如 visualState 仅作为 `taskCardVisualStateLabel(state)` 的 key（最常见路径），无 CSS 改动需要。Codex v2 review 已 grep 确认（G07）：renderer 中没有 `visualState === 'waiting'` 的字符串比较，所以本节预期为零代码改动；保留这一调研项作为 v3 实施第一步的验证 checkpoint。

#### 1.8 `parseSerializedTaskSnapshot`：rename `snapshot` → `projection`（v4 新增——闭合 v3-R01）

**File: `src/renderer/components/agent/ChatPanel.tsx:2449-2487`**

`parseSerializedTaskSnapshot` 把保存在 `message.meta.taskSnapshot`（`:3165`）的历史任务卡 frozen 数据反序列化成 `TaskCardRun`。它读 `snapshot.taskTitle / snapshot.steps / snapshot.waitingFor / ...` 这些 blacklist 字段——但语义上 `SerializedTaskSnapshot`（`:133-159`）就是过去某帧的 projection 投影（chat 把当时的状态序列化保存了下来），它**不是**新的非投影状态源。

为了让 §3.1 gate 用统一的"`projection.X` allowlist"规则覆盖到这个 constructor，v4 把局部变量重命名：

```ts
const parseSerializedTaskSnapshot = useCallback((raw: unknown): TaskCardRun | null => {
  if (!raw || typeof raw !== 'object') return null
  const projection = raw as SerializedTaskSnapshot      // ← 原 `snapshot`，rename
  if (!projection.scopeId || !projection.updatedAt) return null
  return taskProjectionToTaskCardRun({
    scopeId: projection.scopeId,
    taskId: projection.taskId || projection.taskContinuation?.taskId || null,
    phase: projection.phase,
    title: projection.title || '任务',
    taskTitle: projection.taskTitle,
    taskSummary: projection.taskSummary,
    steps: projection.steps,
    currentStepId: projection.currentStepId || null,
    waitingFor: projection.waitingFor,
    resumableActions: projection.resumableActions,
    recentArtifacts: projection.recentArtifacts,
    taskContinuation: projection.taskContinuation,
    progress: projection.progress,
    memoryCapture: projection.memoryCapture,
    blockedReason: projection.blockedReason,
    error: projection.error,
    updatedAt: projection.updatedAt,
    toolTrace: (projection.toolTrace || []).map(/* unchanged */),
    // ...其余字段照旧
  })
}, [])
```

无行为变化（仅 rename）。Gate 看到 RHS 全部以 `projection.` 起头，pass。

**注（v5 更诚实的措辞）**：`SerializedTaskSnapshot` 与 `TaskProjectionRecordData` **不是同构**——前者源自 `ScopeRunState`（`runtimeDriver.ts:27-58` 序列化 `ScopeRunState` 字段，含 `agent / phase / toolTrace`），后者是 main 侧的 projection 表行（含 `runId / module / status / interactionState / createdAt`）。两者**形状重叠但不等价**。

把局部变量从 `snapshot` 改名 `projection` 是一项**显式的 gate 配合**：因为 gate 把"identifier 字面量名为 `projection`" 视为"我承诺这条 RHS 是 projection-source"的声明，rename 让本 constructor 在 gate 视角下与其它 projection-source constructor 同等被检查。**这不是声称 SerializedTaskSnapshot 等于 TaskProjectionRecordData**——它是一种 gate 友好的命名约定，其语义责任由 maintainer 承担（`parseSerializedTaskSnapshot` 函数体的所有 `projection.X` 读都来自合法的 frozen-snapshot 字段）。

Stage O 不重写 chat 序列化格式（不在范围内）。后续 stage 可以把 `SerializedTaskSnapshot` 字段集合靠齐 `Pick<TaskProjectionRecordData, ...>`，让"projection-source 声明" 从 maintainer 责任升级为 type 强制。

#### 1.9 统一 `isBackgroundTaskRun` 与 `deriveTaskCardRuntimeState`（v3 新增 — 闭合 v2-Y02）

**File: `src/renderer/components/agent/ChatPanel.tsx:635-653`**

`isBackgroundTaskRun` 当前用独立的 `waitingFor / terminalReason / blockerType` 检查决定卡片归属（前台 vs 后台 pile），与 `deriveTaskCardRuntimeState` 是两条平行决策路径。Stage O 把它改为 single-source：

```ts
function isBackgroundTaskRun(run: TaskCardRun | null | undefined): boolean {
  if (!run) return false
  const taskId = String(run.taskId || run.taskContinuation?.taskId || '').trim()
  const childOrDetachedIdentity = Boolean(
    run.taskContinuation?.childRunId
    || run.taskContinuation?.detachedTaskId
    || taskId.startsWith('skill-child:')
    || taskId.startsWith('detached:'),
  )
  const visualState = deriveTaskCardRuntimeState(run).visualState
  return visualState === 'background_running'
    || visualState === 'budget_paused'
    || (childOrDetachedIdentity && hasTaskRunResumeIdentity(run))
}
```

含义保持不变：
- `background_running` 与 `budget_paused` 都进入"后台 pile"——即便 §6.13 说它们的 visual label 不同（"后台运行中" vs "预算已暂停"），UI 分组上都是非前台。
- `childOrDetachedIdentity && hasTaskRunResumeIdentity` 是 child / detached 任务的额外归属规则，与 visual state 正交（一个 `done` 的 child task 也归后台 pile，方便"打开产物"按钮入口集中）。

这条修改让"卡片归属"与"卡片状态"共享 `deriveTaskCardRuntimeState` 一个决策源，后续要调整优先级只需要改一个函数。

### Phase 2 — main 侧填空：projection 必须能独立支撑 UI

#### 2.1 `task-projection-sync.ts` `resolveResumableActions` 补 `running` 分支

`task-projection-sync.ts:332-354` 当前在 status='running' 时返回 `[]`——O1 之后 ChatPanel 的"运行中卡片" `resumableActions` 直接 `?? []`，按钮全灰。在函数末尾、return `[]` 之前补：

```ts
// Stage O §2.1 — projection-only fields require a sensible running default.
if (status === 'running') {
  if (summary.taskContinuation) return ['cancel']
  return []
}
```

不动现有 blocked / failed 分支。

#### 2.2 child-runner 写 projection 时塞 `resumableActions` / `recentArtifacts`

**File: `src/main/modules/agent-control/skill-child-runner.ts`** 附近的 `buildChildTaskProjectionRecord`

实施前调研 codex review 已部分覆盖（codex 指出 `child-projections write waitingFor: 'background'` at `:2093`）。打开文件确认当前是否在 child-running 状态下也写 `resumableActions: []`；如是，按 §2.1 规则补齐。`recentArtifacts` 类似——从 `args.active.outputDir / runStatePath` 派生 `[{ kind:'folder', path: outputDir, ... }]` 形态，已存在则保持。

如果实地确认 child-runner 已经写了合理的 `resumableActions`，§2.2 跳过。具体行号在 v2→v3 codex 评审中验证。

#### 2.3 placeholder title 兜底（Y02 修复）

见 §0.2 task-projection-sync.ts 末尾说明。

#### 2.4 `supersede` reasonHint（v3 新增 — 闭合 v2-Y01）

**File: `src/main/modules/agent-control/task-projection-sync.ts:247-257`**

`supersedeLegacySiblings` 调用 `store.update(sibling.taskId, {...})`；v3 改为 `store.update(sibling.taskId, {...}, { reasonHint: 'supersede' })`，使 repository emit 的 `change` 事件 reason 字段为 `'supersede'`，可被 §3.3 gate 与 §5.1 测试的 supersede emit shape 断言区分。其它 update（`sync` / `child`）继续走默认 `'update'`/`'create'` reason。

### Phase 3 — CI gates

#### 3.1 新 gate：`scripts/check-task-card-projection-only.cjs`

扫描 `src/renderer/components/agent/ChatPanel.tsx`（白名单文件，可扩展为 `src/renderer/components/agent/**/*.tsx` 与 `src/renderer/modules/agent/taskCardViewModel.ts`），对每个 `taskProjectionToTaskCardRun({ ... })` 调用，检查对象字面量字段：

- **黑名单字段**（必须只来自 `projection?.X` / `projection?.X ?? null|[]|'none'`，不允许 `|| run.X` / `?? run.X` / 三元里出现 `run.X`）：
  `status`, `interactionState`, `waitingFor`, `blockedReason`, `resumableActions`, `taskContinuation`, `recentArtifacts`, `progress`, `budget*`, `degradationReason`, `recoveryHistory`, `taskType`, `currentStepId`, `steps`, **`taskTitle`**（v2 新增）, **`taskSummary`**（v2 新增）。
- **白名单字段**（允许任何来源）：`scopeId`, `taskId`, `phase`, `terminalReason`, `title`, `toolTrace`, `responseMessageId`, `responseSegmentToolTraceStart`, `error`, `updatedAt`, `memoryCapture`, `__brand`。

实现：lite parser（不需要完整 AST）。**v4 算法重写为 hard whitelist**：

- 找到 `taskProjectionToTaskCardRun(` 出现位置，从其后第一个 `{` 开始括号匹配抓到对应 `}`。
- **对象字面量内**任何顶层 `\.\.\.<identifier>` spread 都视作违例 — 包括 `...run` / `...persistedRun` / `...projection`。理由：spread 隐式携带源对象上的同名字段，gate 字段级检查无法看清；强制显式列字段。
- 对 `{...}` 内每个顶层 `<key>: <expr>,` 行（key 是 identifier 或 string literal）做检查。
- 若 `key` 在 **白名单** 字段集（见 §1.3 末尾的"白名单字段"列表）：放行，不检查 RHS。
- 若 `key` 在 **黑名单** 字段集（`status / interactionState / waitingFor / blockedReason / resumableActions / taskContinuation / recentArtifacts / progress / budgetUsagePercent / stepBudget / budgetWarningLevel / degradationReason / recoveryHistory / taskType / currentStepId / steps / taskTitle / taskSummary`）：RHS 必须满足以下**任一**允许形态（用 trimmed 字符串规则匹配）：
  1. **Projection 链**：`projection.<...>` 或 `projection?.<...>`（任意深度链；含 `projection?.budget?.stepBudget` 这种）。
  2. **Projection 链 + literal tail**：`(1) ?? <literal>` 或 `(1) || <literal>`（literal ∈ `{null, undefined, [], {}, 'none', 0, true, false}` 或 `'<single-quoted>' / "<double-quoted>"`）。多重链允许：`(1) ?? (1) ?? <literal>` 同样合法（中间不许出现非 projection identifier）。
  3. **命名 helper**（v5 完整列表）：
     - `resolveProjectionWaitingFor(projection)`
     - `resolveProjectionBlockedReason(projection)`
     - `normalizeProjectionSteps(projection?.steps)` 或 `normalizeProjectionSteps(projection.steps)`
     可以 `?? <literal>` / `|| <literal>` 收尾（如 `normalizeProjectionSteps(projection?.steps) ?? []`）。这三个 helper 的函数体由 gate 单独 grep（不允许含 `run.<黑名单字段>` 引用 — 双重防护）。
  4. **Bare literal RHS**（v5 新增——闭合 v4-R01）：`null` / `undefined` / `[]` / `{}` / `'<str>'` / `"<str>"` / 整数 / `true` / `false` / `'none'`。这些是"明确空值"，不携带任何 identifier-source；用于 `inMemoryTaskRuns` 把 blacklist 字段空白化。
  5. 其它任何形态（`run.X` / `persistedRun.X` / `snapshot.X` / `cached.X` / 内嵌任意 `<非 projection identifier>.<黑名单字段>` / 多行三元里出现 `<run.X>` 等） → 违例。
- 关键收敛：blacklist field 的合法 source 闭包是 {`projection.X`, 三个命名 helper 输出, bare literal}。任何"new name 进 source"都要先入 case (3) 命名 helper 列表，gate 增量更新。
- 跨多行字段（如 `steps: (projection?.steps ?? [])`）：用括号深度计算 expr 边界。

**身份判定**：gate 对"identifier 是否叫 `projection`" 做字面量识别——它信任作者只把项目内的 projection 数据起这个名字。这意味着 §1.8 `parseSerializedTaskSnapshot` 把局部变量从 `snapshot` 改名 `projection` 是被 gate 认可的"projection-source 声明"。如果未来要新增另一个projection-shape 适配器，写在同一函数内的局部 `const projection = adapt(other)` 也能通过 — 这是 deliberate 设计：把"我这条 RHS 是 projection-source"的责任前移到命名约定。

测试 `scripts/__tests__/check-task-card-projection-only.test.cjs`，10 个 fixture：
- (a) projection-only 字段全合法 → pass
- (b) `resumableActions: projection?.resumableActions || run.resumableActions` → fail（`run.X` 在尾）
- (c) `taskTitle: projection?.taskTitle || run.taskTitle` → fail
- (d) `phase: run.phase` → pass（白名单字段）
- (e) `...run` 出现在调用对象字面量 → fail
- (f) `waitingFor: resolveProjectionWaitingFor(projection)` → pass（命名 helper）
- (g) `taskTitle: snapshot.taskTitle`（identifier 不叫 projection）→ fail
- (h) `taskTitle: projection.taskTitle` in `parseSerializedTaskSnapshot` body → pass
- (i) **`taskTitle: null`** / **`status: undefined`** / **`steps: []`**（v5 新增 case-4）→ pass
- (j) **`steps: normalizeProjectionSteps(projection?.steps) ?? []`**（v5 新增 case-3）→ pass

#### 3.2 新 gate：`scripts/check-renderer-no-status-text-guess.cjs`

**收紧后的扫描范围**（参照 `scripts/check-status-vocabulary-single-source.cjs:9-16,101-105` 的 vocabulary gate 形态）：
- 仅扫描"消费 task-card 数据" 的 renderer 文件——具体定义为：文件 import 了 `TaskProjectionRecordData | ActiveChildRunSummaryData` *或者* 从 `task-card-from-projection` 导入 `TaskCardRun`。
- 用上述 import-trigger 列表过滤；非 task-card 文件不扫（自动豁免 `SkillAskUserPrompt.tsx`、`SkillInlinedToast.tsx` 等不消费 task-card 类型的胶囊文件，避免 `'提交失败'` 这类业务字符串误伤）。

**禁止两类 pattern**：

(A) 完整的 5 句中文短语：`'后台任务已完成' | '后台任务已取消' | '后台任务失败' | '后台任务等待继续' | '后台任务正在运行'`。允许出现的文件白名单：
   - `task-status-vocabulary.ts`（唯一 vocabulary 单源 — 同时托管 `DEBUG_PLACEHOLDER_TASK_SUMMARY` 常量）

(B) 反向 includes / endsWith / startsWith pattern，且**同一行**还包含 `if (`、`return `、`set<Identifier>(`、`switch (` 之一。具体禁用模式：
   - `\.includes\(['"](完成|失败|等待|后台)['"]\)`
   - `\.endsWith\(['"]中['"]\)`
   - `\.startsWith\(['"]已['"]\)`
   触发条件：上述 regex 命中 + 同行另含决策关键字。允许的反例：`taskCardVisualStateLabel(state).includes('完成')` 这种"vocabulary 输出再反向解析" 仍然违例（必须先 normalize 状态，再走 vocabulary）。

实现：lite regex；测试 `scripts/__tests__/check-renderer-no-status-text-guess.test.cjs` 含 fixture：
- (a) 字面量出现在 `task-status-vocabulary.ts` → pass
- (b) 完整短语出现在 ChatPanel.tsx → fail
- (c) `'提交失败'` 出现在 `SkillAskUserPrompt.tsx`（不 import task-card 类型） → pass（不扫）
- (d) `if (taskSummary.includes('完成'))` 出现在 ChatPanel.tsx → fail
- (e) `'确定取消后台任务吗？'` 字符串字面量（不是完整 5 句） → pass

#### 3.3 新 gate：`scripts/check-projection-push-event-wired.cjs`

确认四件事：
1. `src/main/modules/repositories/task-projection-repository.ts` 内 `class TaskProjectionRepository` 同时含 `emitter.emit('change'`（或 `events.emit('change'`）。
2. `src/main/modules/claude-bridge/ipc-handler.ts` 内含 `webContents.send('agent:taskProjectionsChanged'`。
3. `src/preload/index.ts` 内含 `'agent:taskProjectionsChanged'` 字符串。
4. `src/renderer/components/agent/ChatPanel.tsx` 内含 `onTaskProjectionsChanged(`。

任一缺失则 fail。`scripts/__tests__/check-projection-push-event-wired.test.cjs` fixture 通过临时改写最小重现 OK。

#### 3.4 新 gate：`scripts/check-no-active-child-run-polling.cjs`

扫描 `src/renderer/**`：禁止任何 `setInterval(...)` 闭包体内 `agent.listActiveChildRuns(`，**除非**该 setInterval 闭包前 5 行内有注释 `// gate-allow:active-child-run-debug`。

测试：fixture `with-poll-no-marker → fail`、`with-poll-with-marker → pass`、`no-poll → pass`。

#### 3.5 扩展现有 `scripts/check-status-vocabulary-single-source.cjs`

把 `'后台任务（projection 暂未覆盖）'` 加入 canonical 字符串集合：
- 该字符串只允许出现在 `task-status-vocabulary.ts`（导出为 `DEBUG_PLACEHOLDER_TASK_SUMMARY`）。
- 所有渲染端 task-card 表面（即 vocabulary gate 已扫描的文件集合）必须通过引用 `DEBUG_PLACEHOLDER_TASK_SUMMARY` symbol 而非内联字面量来使用。

新增的 gate self-test 加在 `scripts/__tests__/check-status-vocabulary-single-source.test.cjs`（如已存在）或独立 fixture：
- (a) `taskSummary: DEBUG_PLACEHOLDER_TASK_SUMMARY` → pass
- (b) `taskSummary: '后台任务（projection 暂未覆盖）'`（在 ChatPanel.tsx） → fail

### Phase 4 — verify wiring

**File: `package.json`**

```jsonc
"test:o:gates": "node --test scripts/__tests__/check-task-card-projection-only.test.cjs scripts/__tests__/check-renderer-no-status-text-guess.test.cjs scripts/__tests__/check-projection-push-event-wired.test.cjs scripts/__tests__/check-no-active-child-run-polling.test.cjs",
"test:o:focus": "npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/derive-task-card-runtime-state-priority.test.ts src/__tests__/task-projection-repository-emits-change.test.ts src/__tests__/task-projection-reconciler-silent-write.test.ts src/__tests__/agent-task-projections-changed-ipc.test.ts src/__tests__/task-card-projection-only.test.ts src/__tests__/ui-contracts/task-card-projection-only.contract.test.ts",
"verify:o": "npm run verify:n && node scripts/check-task-card-projection-only.cjs && node scripts/check-renderer-no-status-text-guess.cjs && node scripts/check-projection-push-event-wired.cjs && node scripts/check-no-active-child-run-polling.cjs && npm run test:o:gates && npm run test:o:focus"
```

把顶层 `verify` / `verify:cloud` 起步链 `verify:n` → `verify:o`：

```jsonc
"verify": "npm run verify:native && npm run verify:o && npm run test",
"verify:cloud": "npm run rebuild:native && npm run verify:o && npm run test"
```

### Phase 5 — Tests

#### 5.1 行为测试（src/__tests__/）

**`derive-task-card-runtime-state-priority.test.ts`** — 6 档优先级 × 关键交叉对，至少 8 个 case：
- `failed + no background + no budget` → `failed`
- `failed + hasLiveBackground` → `background_running`（v2 修正前会是 `failed`，所以这是回归基础）
- `failed + hasBudgetPaused + no background` → `failed`（v2 修正前会是 `budget_paused`）
- `hasLiveBackground + hasBudgetPaused` → `background_running`（v2 修正前会是 `budget_paused`）
- `hasBudgetPaused + waiting` → `budget_paused`
- `waiting + isAgentHandoff` → `waiting_handoff`
- `waiting + !isAgentHandoff` → `waiting_input`
- `done + recentArtifacts.length>0` → `done` + `actionSet=['open_artifact']`

**`task-projection-repository-emits-change.test.ts`** — create / update / deleteByScope / supersede 各 emit 一次 change（`EventEmitter.on('change')` 计数）；`silent: true` 抑制 emit。

**`task-projection-reconciler-silent-write.test.ts`** — reconciler 触发的 `store.update` 实际被 silent 调用（mock store `update` 检查 `options.silent === true`）。

**`agent-task-projections-changed-ipc.test.ts`** — 涵盖三 case：
   1. runtime emit → ipc-handler send → 假 mainWindow `webContents.send` 收到 `'agent:taskProjectionsChanged'` + 正确 payload。
   2. `cleanupAgentRuntime()` 之后再 emit，`webContents.send` **不被**调用（unsubscribe 生效）。
   3. **dev-reload re-entry**（v8 新增——闭合 v7-Y01 测试 gap）：连续两次 `setupAgentIPC(...)`，repository emit 一次 change，`webContents.send` 必须只收到 **1 次**（第二次 setupAgentIPC 应该把第一次的监听 off 掉，没有 leak）。

**`task-card-projection-only.test.ts`** — 用真实 ChatPanel 的 `mergedTaskRuns` 输入 fixture：当 `projection.status='failed'` 而 `run.phase='running'` 时，TaskCardRun.status='failed'（projection 单赢）；run.taskContinuation.X / run.resumableActions / run.blockedReason 不参与决策。

#### 5.2 Renderer / preload contract 测试

复用 `src/__tests__/ui-contracts/` 模式：
- `task-card-projection-only.contract.test.ts`：mock projection + scope-run state，断言 mergedTaskRuns 输出的 TaskCardRun 黑名单字段都来自 projection。

### Phase 6 — Files map

#### Create

- `src/renderer/modules/agent/debouncedFetch.ts`（新 helper，5 行）
- `scripts/check-task-card-projection-only.cjs`
- `scripts/__tests__/check-task-card-projection-only.test.cjs`
- `scripts/check-renderer-no-status-text-guess.cjs`
- `scripts/__tests__/check-renderer-no-status-text-guess.test.cjs`
- `scripts/check-projection-push-event-wired.cjs`
- `scripts/__tests__/check-projection-push-event-wired.test.cjs`
- `scripts/check-no-active-child-run-polling.cjs`
- `scripts/__tests__/check-no-active-child-run-polling.test.cjs`
- `src/__tests__/derive-task-card-runtime-state-priority.test.ts`
- `src/__tests__/task-projection-repository-emits-change.test.ts`
- `src/__tests__/task-projection-reconciler-silent-write.test.ts`
- `src/__tests__/agent-task-projections-changed-ipc.test.ts`
- `src/__tests__/task-card-projection-only.test.ts`
- `src/__tests__/ui-contracts/task-card-projection-only.contract.test.ts`

#### Modify

- `src/main/modules/repositories/task-projection-repository.ts`（增 EventEmitter + emit + `silent` option）
- `src/main/modules/agent-control/run-contracts.ts`（增 `TaskProjectionChangeEvent` 类型；`TaskProjectionStore` 写方法签名加 options）
- `src/main/modules/agent-control/runtime.ts`（增 `getTaskProjectionStore()` getter）
- `src/main/modules/claude-bridge/ipc-handler.ts`（订阅 store change → webContents.send）
- `src/main/modules/agent-control/task-projection-reconciler.ts`（`store.update(...)` 传 `silent: true`）
- `src/main/modules/agent-control/task-projection-sync.ts`（§2.1 `resolveResumableActions` 加 running 分支；§2.3 placeholder title）
- `src/main/modules/agent-control/skill-child-runner.ts`（§2.2，按调研结果决定是否改）
- `src/preload/index.ts`（新 `onTaskProjectionsChanged`）
- `src/renderer/types/electron.d.ts`（新 type 出口）
- `src/renderer/components/agent/ChatPanel.tsx`（删 polling 与 4 helper、删 `childRunTaskSummary`、加 push 订阅、改 `inMemoryTaskRuns` 为 whitelist-only、改 `mergedTaskRuns` 显式列字段不用 spread、改 `isBackgroundTaskRun` 走 `deriveTaskCardRuntimeState`）
- `src/renderer/modules/agent/task-status-vocabulary.ts`（增 `DEBUG_PLACEHOLDER_TASK_SUMMARY`；export 现有 `TaskCardVisualState`）
- `src/renderer/modules/agent/taskCardViewModel.ts`（删本地 `TaskCardVisualState` 重复 enum；改 import；重排 `deriveTaskCardRuntimeState` 优先级；更新返回 `'waiting_handoff' | 'waiting_input'`）
- `src/renderer/components/ready/TaskPanel.tsx`（如有 `visualState === 'waiting'` 比较，改为新两个值；调研项）
- `scripts/check-status-vocabulary-single-source.cjs`（§3.5 加 `DEBUG_PLACEHOLDER_TASK_SUMMARY` 单源约束）
- `package.json`（`verify:o`、`test:o:gates`、`test:o:focus`、顶层 `verify` / `verify:cloud`）
- `CLAUDE.md`（新增 §6.22 Stage O 简短说明，引用本计划路径）
- `AGENTS.md`（同步新增对应 §6.22；CLAUDE.md §12 与 AGENTS.md §12 都要求两份指引同步，差异仅限标题/称谓）

#### Read-only consult

- `src/main/modules/agent-control/run-projection.ts`（理解 `recordEvent` 触发 sync 的链路）
- `src/main/modules/agent-control/skill-task-tracker.ts`（lifecycle event 写 projection 的位置；O2 wrap 自动覆盖）

## 4. Acceptance scenarios

### Scenario A — Skill child run 失败 + 后台已死
Input: child run 走到 `failed`，main emit projection update `status:'failed', continuationRef:{outputDir,...}`；该卡片 TaskCardRun 的 `waitingFor !== 'background'` 且 `taskContinuation.blockerType !== 'background_running'` 且 `terminalReason !== 'checkpoint_background'`。
Expected:
- `agent:taskProjectionsChanged` push 触发 renderer 100ms 内 fetch。
- TaskCardRun.status='failed'，`deriveTaskCardRuntimeState` → `visualState='failed'`。
- 标签"失败"；按钮：重试 / 取消 / 打开产物。

### Scenario B — 同卡片同时 failed + hasBackground（Stage 6 L6 数据 shape 上不应同时存在；但加为防御性场景）
Input: 一张卡片 projection 写 `status:'failed'`，且同卡片 `taskContinuation.blockerType === 'background_running'`（异常态）。
Expected:
- v2 修复后 → `visualState='background_running'`（rank-90 大于 rank-100 在 hasBackground=true 条件下的降级）。
- 用户视角：卡片显示"后台运行中"——避免"失败" 标签盖住仍活的后台子任务。
- 注：CLAUDE.md §6.13 的"失败且无后台存活" 约束就是为此场景设计——单卡级别的 background 信号优先于 failed。

### Scenario C — 失败被 transient running scope-run-event "盖住" 的旧 bug 不再可重现
Input: 主进程先 emit `status:'failed'` 到 projection，紧接着 emit `phase:'running'` 的 scopeRunEvent。
Expected:
- TaskCardRun.status 始终来自 projection（=`failed`），不会被 `run.phase='running'` 修改（gate §3.1 强制）。
- 因为该卡片 `hasBackgroundSignal=false`，`deriveTaskCardRuntimeState` → `visualState='failed'`。
- 旧路径若 fallback 到 `run.phase`，cards 会临时显示"进行中"——Stage O 之后这条不可重现。

### Scenario D — Polling timer 退役
Input: renderer mount，scope 不变，main 在 30s 内 emit 5 次 projection update。
Expected:
- `agent:listActiveChildRuns` 调用次数 = 1（mount 一次）+ 0（无 timer）。
- `agent:listTaskProjections` 调用次数 ≤ 5（每次 push 触发，可能因 100ms 防抖合并）。
- 旧路径会调用 `agent:listActiveChildRuns` 至少 15 次（30s/2s）。

### Scenario E — Reconciler 写入 silent
Input: renderer 调 `agent:listTaskProjections`，main 内联 reconcile 触发 `store.update`（O2.1 silent=true）。
Expected: 不发出 `'agent:taskProjectionsChanged'` 推送；renderer 不会 cascade 二次 fetch。

### Scenario F — Gate self-test：projection-only fallback 重新出现
PR 在 `mergedTaskRuns` 加回 `resumableActions: projection?.resumableActions || run.resumableActions`。
Expected: `verify:o` 在 `check-task-card-projection-only.cjs` 失败，reason "blacklist field uses run.X fallback"。

### Scenario G — Gate self-test：renderer 文本猜状态重新出现（决策上下文）
PR 在 ChatPanel.tsx 加 `if (taskSummary.includes('已完成')) setStatus('done')`。
Expected: `verify:o` 在 `check-renderer-no-status-text-guess.cjs` 失败。

### Scenario H — Gate self-test：renderer 文本字符串非决策上下文（白名单）
PR 在 ChatPanel.tsx 加 `<button>取消后台任务</button>`（不在 if/return/set... 上下文）。
Expected: gate pass（这是 UI 文案不是状态判定）。

### Scenario I — Gate self-test：projection 写入未触发 push
PR 删除 `task-projection-repository.ts` 里的 `emitter.emit('change', ...)`。
Expected: `verify:o` 在 `check-projection-push-event-wired.cjs` 失败，reason "TaskProjectionRepository missing change emit"。

### Scenario J — Gate self-test：polling timer 重新出现
PR 在 ChatPanel.tsx 加 `setInterval(() => listActiveChildRuns(), 2000)` 不带 marker 注释。
Expected: `verify:o` 在 `check-no-active-child-run-polling.cjs` 失败。

### Scenario K — Gate self-test：placeholder 字面量内联
PR 直接在 ChatPanel.tsx 写 `taskSummary: '后台任务（projection 暂未覆盖）'`。
Expected: `verify:o` 在 `check-status-vocabulary-single-source.cjs` 失败。

## 5. Risk register

- **R1 push 风暴：** child-runner 在 finalize close 阶段连续 update projection 5+ 次。100ms 防抖在 renderer 侧吸收；如果 main 侧需要进一步合并，§0.2 的 `reasonHint` 字段保留供后续增强。
- **R2 type-only import 边界：** `TaskProjectionChangeEvent` 类型走与 `TaskProjectionRecordData` 同一通道（`src/renderer/types/electron.d.ts`），不破坏 main↔renderer 隔离。
- **R3 `taskTitle` placeholder：** §0.2 增加的 `'正在生成…'` 是 main 侧 placeholder（projection 第一次落地），覆盖 v1 `phase=responding` 的 fallback 需求；renderer 永远 projection-only。
- **R4 projection-only 之后 "running 任务无 resumableActions"：** §2.1 已经补 main 侧的 running+continuation 默认动作。
- **R5 子任务 step.detail 仍由 child task 拼接：** `task-projection-sync.ts:472-520` 的 `mergeChildTaskIntoParentSteps` 把 child status 翻译成 `'已完成' | '失败' | ...` 拼到 parent step.detail。这是 main-side derive，不读 renderer 文本，不在 §3.2 gate 范围；列在 risk 用于提醒后续观察。
- **R6 `event.changedTaskIds` 默认空数组的兼容：** `deleteByScope` 删了一批，list-then-delete 拿到 ids；其他 reason 默认单 id 数组。Renderer 收到时只用 scopeId 触发全量 fetch；payload 字段保留为后续 v3 升级的细粒度 patch。
- **R7 `TaskCardVisualState` enum 统一对下游 CSS 影响：** §1.6 已列调研项；如有 `'waiting'` 字面量被 className/data-state 引用，改为新两个值。
- **R8 V2 `silent` 选项是新增 API surface：** `TaskProjectionStore.update / create` 接口加 options 参数；现有调用方不传仍兼容（默认 emit）。
- **R9 V5 `inMemoryTaskRuns` 字段切换的可观察 UI 行为（v5 reframe — 不再宣称"用户基本无感"）：** §1.2 把 8 个 blacklist 字段空白化后，`isTaskVisible`（`ChatPanel.tsx:624-632`）需要至少一项 title/summary/steps/progress/memoryCapture 才显示卡。所以"projection 还没落地" 的瞬间卡片就**真的看不到**——这是 Stage O 的有意设计（不再伪造状态），但**用户可见**。
  - **Happy path**：第一次 main 侧 `syncTaskProjection`（`runtime.ts:2172`）写完 → repository emit `change` → IPC `agent:taskProjectionsChanged` → renderer 100ms debounce → `refreshPersistedTaskProjections` → setState。整链在本地 IPC 下大约 1×RTT，约 10–50ms 量级。
  - **Sad path**：projection 写入失败（DB 抖动）/push 监听被销毁（mainWindow.isDestroyed）/renderer 还没 mount 完成。此时卡片要等 ChatPanel 现存的 `useEffect(refreshPersistedTaskProjections, [currentScopeId, filteredScopes.length])` 触发——可能在用户切 scope 时才补。**这条间隔可见且不可接受**。
  - **缓解备选**：`inMemoryTaskRuns` 写字面量占位 `taskTitle: '正在启动…'`（v5 gate case-4 允许 bare literal 在 blacklist 字段——见 §3.1 case (4)）。这把 sad-path 间隔关闭，只暴露 placeholder 文案给用户，不暴露假状态。v5 默认**不**开口子（保留更严格的"消失"语义），但实测有用户报告时此 patch 可独立 land，与 v5 gate 兼容。
- **R10 V3 `isBackgroundTaskRun` 改后的归属一致性：** 现实现里"`childOrDetachedIdentity && hasTaskRunResumeIdentity` 的 done 任务也归后台" 的语义保留；如果未来想 done child task 进前台 pile，单点改 `isBackgroundTaskRun` 即可，不会影响 visual state。

## 6. Why these changes are minimal

按 §0.5 战略原则自检：

1. **先合同：** O1–O5 是 5 条机器可验证合同，O6 把它们钉到 4+1 条 gate 里。✓
2. **修根因：** "UI 抖 / 失败被覆盖 / 后台还活着但显示完成" 共享一条根因——*projection 不是 UI 字段的唯一读源 + 状态推导从消息文本获得二级输入 + 优先级与文档不一致*。本计划只改这一条根因，不在症状层加补丁。
3. **拒绝 legacy 兼容分支：** 删除 4 个 fallback helper、删除 `childRunTaskSummary`、删除 polling timer、删除两份 `TaskCardVisualState` 中的本地版本——不留 `if (legacyMode) ...`。
4. **形态意识：** v1 想新建一个独立 derive 函数，被 codex 指出 `deriveTaskCardRuntimeState` 已经是合适宿主——v2 选修不选立。
5. **CI 强制：** 5 条合同全在 §3 落地为硬门，不是文档约束。
6. **跨边界状态一致性显式建模：** §0.2 的 store-wrapper 是 main↔renderer 的"写后即推"门，与 §6 战略原则一致；`silent` 选项处理 fetch-driven reconcile 的回环；不允许 renderer 从消息文本 / scope-run patch 兜底状态。
