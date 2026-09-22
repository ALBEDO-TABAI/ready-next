---
title: Continuous Widget Modification Timeout — Round 2 Audit (post-Ω0/Ω1/Ω2)
date: 2026-04-19
branch: codex/document-widget-pipeline-cache
status: audit-only (no code changes)
audience: ready-agent & document pipeline maintainers
scope: "Ω0/Ω1/Ω2 落地后仍在复发的 2+ 轮连续改卡超时问题；在前一轮 audit 的基础上再做一次实地代码核对"
related:
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-04-19-ready-agent-continuous-widget-modification-timeout-audit.md
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-04-18-ready-agent-runtime-realignment-second-round-audit.md
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

## 0. 触发事件

用户反馈：在 `c7160ce`(Ω0) / `b69b5ab`(Ω1) / `19b138606`(Ω2) 三轮修复落地后，继续在文档模块做信息卡连续修改，**仍然**在 2+ 轮之后遇到"工具请求超时 / Timed out waiting for renderer tool action result"。

本文档不是理论推演，而是对 post-Ω 的代码做逐行核对 + 日志取样 —— 把仍然存在、且有 file:line 证据的缺口列出来，并附上每一条的验证路径。

## 1. 已核对的运行时证据

- `ready-directchat.log` (04-19 06:13–06:14)：只捕捉到 `agent:listConversationScopes` 几条日志，**没有** 超时事件被打出来。这本身就是一个可观测性缺口（见 G-Z12）。
- `ready-browser.log`：只记录 BrowserView visibility 切换，与 document pipeline 无关。
- `ready-tools.log`：**该文件不存在**，虽然 CLAUDE.md §11 明确说"工具执行：`<系统临时目录>/ready-tools.log`"。Tool 执行的真正日志通道没有建立。
- Electron data 目录下 `agent-memory / agent-sidecar-runtime / agents / Session Storage` 都没有 document tool 相关 trace。

结论：在现有日志通道下，主进程是否在 renderer 队列阻塞期间真的每次打了 "pending 120s" 计时器无法直接拉证据；只能退回代码逻辑推理。下面的每条缺口会标出如何在修复阶段补观测以自证。

## 2. 已完成的修复（Ω0/Ω1/Ω2 实际落地面）

| 编号 | 修复目标 | 实际落在哪 | 是否对齐 plan §7 |
|---|---|---|---|
| Ω0.1 per-scope queue | `runtimeDriver.ts:477` `scopeQueues = new Map<scopeId, Promise<void>>()` | 是 |
| Ω0.2 renderer watchdog | `runtimeDriver.ts:481-576` `budgetForTool` + `runWithWatchdog` | 是 |
| Ω0.3 cancel IPC | `ipc-handler.ts:111-128` `cancelToolActionRequestsBySession` + `agent:cancelToolActionRequest` | 是 |
| Ω0.4 pending index | `ipc-handler.ts:97,148-151` `sessionPendingIndex` `(agent,sessionId)→Set<requestId>` | 是 |
| Ω1.1 cache key widgetId/tabId | `document-task-cache-key.ts:35-36,52-53` | **部分** — 仍缺内容 hash（G-Z7） |
| Ω1.2 draft TTL + write-succeeded invalidate | `document-task-pipeline-executor.ts:1391-1397, 1816-1822, 1840` TTL=90s | **部分** — 只按当前 key 失效（G-Z6） |
| Ω1.3 widget target snapshot refresh | `widget-target-attachment.ts:48` `refreshDocumentWidgetTargetSnapshot` | 是 |
| Ω1.4 messageComposer 启发式收敛 | `messageComposer.ts:8-32` 未动，仍保留 `文档|正文|段落|章节 + 改|收紧|浅一点` | **否**（G-Z8） |
| Ω2.1 document IPC timeout | `documentActions.ts:21-29, 75-79, 1063-1067, 1097` 仅 `compile_widget_spec` (10s) + `update_widget` 整条 (15s) | **部分** — `list_widgets / insert_widget / remove_widget / replace_text / ...` 未覆盖（G-Z5） |
| Ω2.2 per-tab widget write lock | `documentActions.ts:31, 1094-1106` | 是 |
| Ω2.3 tiptap commit ack | —— | **否**，未实施（G-Z4） |
| Ω3 scopeId 直连 payload | —— | 否（G-Z10） |
| Ω4 观测 | —— | 否（G-Z12） |

## 3. 仍然存在的缺口清单（有代码证据）

### G-Z1（P0） — 第 2 轮 `agent:send` 不级联取消第 1 轮 renderer 队列

**证据**：`src/main/modules/claude-bridge/direct-chat.ts:702-707`

```ts
if (session.abortController) {
  session.generation += 1
  session.abortController.abort()
  session.abortController = null
  log(`sendMessage preempted previous in-flight run for agent=${name}`)
}
```

这里**只** abort 主进程侧的 `abortController`。没有任何调用到 `cancelToolActionRequestsBySession(agent, sessionId)`。查遍代码，该函数唯一的调用点是 `ipc-handler.ts:221 (agent:newSession)` 和 `ipc-handler.ts:235 (agent:kill)`。

**第 2 轮 `agent:send` 的实际路径**：

1. 主进程 abort 第 1 轮 pipeline（`AbortError` 抛出）。
2. 第 1 轮已经在 `pendingToolActionRequests` 里的 N 条条目（list/update/save/verify 一套至少 4 条）**不会被 reject**。120s 定时器照常走。
3. 主进程无副作用地发起第 2 轮 pipeline，继续调 `requestModuleToolAction(...)`。
4. renderer 侧 per-scope queue 的 key 是 `scopeId`（scopeless 请求才 per-request）。两轮 scopeId 相同 → 第 2 轮的新 request 在队列末端排队。
5. 第 1 轮每个 document tool 的 renderer 预算是 30s；队尾原本有 3–5 条，最坏情况下要等 150s 才轮到第 2 轮的第一个 list_widgets。
6. 与此同时主进程第 2 轮对每条请求的 120s 兜底先到期 → 冒 `Timed out waiting for renderer tool action result: <tool>` —— 这就是用户看到的超时文本。

**影响**：这是 post-Ω 时代 "连续改卡第 2+ 轮超时" 最直接的根因。Ω0 做了 per-scope 队列、watchdog、cancel IPC 三件套，但 **send-preempt 忘了接进来**。

**验证路径**：
- 给 `sendMessage` 第 702 行加一条 log，打印 `pendingToolActionRequests` 大小；期望在"第 2 轮 send 刚到"那一刻大小 > 0。
- 给 renderer `scopeQueues` 入队/出队打 log；期望第 2 轮入队时 queue 里还有第 1 轮的 pending task。

---

### G-Z2（P0） — renderer cancel 竞态：abort 在 runWithWatchdog 运行前到达时被静默丢弃

**证据**：`src/renderer/modules/agent/runtimeDriver.ts:578-647` 与 `531-540`

入队的第一步（`onToolActionRequest` 里）：

```ts
activeToolRequests.set(data.requestId, { settled: false, abort: () => { /* set below */ } })
```

真正的 abort 在任务开始跑 `runWithWatchdog` 时才注入：

```ts
const cancelPromise = new Promise<never>((_, reject) => {
  const entry = activeToolRequests.get(requestId)
  if (entry) {
    entry.abort = () => {
      if (entry.settled) return
      entry.settled = true
      reject(new Error('cancelled'))
    }
  }
})
```

而 cancel handler：

```ts
window.electronAPI.agent.onCancelToolActionRequest((data) => {
  for (const rid of ids) {
    const entry = activeToolRequests.get(rid)
    if (!entry || entry.settled) continue
    entry.abort()  // ← 如果此刻 abort 还是最初的 no-op，这一句直接打水漂
  }
})
```

**时序竞态**：
- t=0 onToolActionRequest 到达，写入 `activeToolRequests`，abort = no-op。任务挂在 `prev.then(runWithWatchdog)` 上，prev 没结束。
- t=1ms cancel IPC 到达（比如 `newSession` 立刻发），命中 no-op 的 abort；settled 仍然是 false。
- t=30s prev resolve，runWithWatchdog 开始；`existing?.settled` 为 false → 任务照常跑。cancel 已经丢了，没有触发点。

**影响**：
- 即使将来修复 G-Z1 让 send-preempt 下发 cancel IPC，如果 abort 时机正好撞在"入队但未 runWithWatchdog" 窗口，仍然抓不到。
- 对于短间隔连续 send 的场景（用户 double-enter、语音连发）这个窗口并不稀罕。

**验证路径**：人为在 `runWithWatchdog` 入口前 `await sleep(200ms)`；send 之后立即 newSession；确认任务还是跑完了。

---

### G-Z3（P0） — `writeDocumentWidget` / `verifyDocumentTaskPlanWrite` 显式丢弃 AbortSignal

**证据**：`src/main/modules/agent-control/document-task-pipeline-executor.ts:1017-1019, 1070-1072`

```ts
private async writeDocumentWidget(params: {
    ...
    signal: AbortSignal
  }): Promise<string> {
    void params.signal   // ← 显式丢弃
    ...
  }
```

同样的 `void params.signal` 出现在 `verifyDocumentTaskPlanWrite (1072)`, `saveDocument (2100)`, `listWidgets (2105)`, `removeWidget (2110)`。

**影响**：Pipeline 顶层的 `Promise.race([fn(), abortPromise])`（`document-task-pipeline.ts:397-401`）会让 pipeline 本身 reject，但 `writeDocumentWidget` 已经发出去的 `requestModuleToolAction(...)` 不会被取消 —— 这个请求进了主进程 `pendingToolActionRequests`，最后要么等 renderer 回 ack，要么 120s 超时。在 G-Z1 尚未修复的背景下，第 2 轮的超时几乎 100% 来自这里。

**验证路径**：把 `void params.signal` 换成 `params.signal.addEventListener('abort', ...)` 并把 signal 传递给 `requestModuleToolAction`；再给主进程的 `requestRendererToolAction` 加 signal 支持，abort 时立即 reject + `releasePendingRequest`。

---

### G-Z4（P1） — Ω2.3 tiptap commit ack 承诺未兑现

**证据**：`src/renderer/modules/agent/documentActions.ts:1078, 1090`

```ts
docStore.setTabContent(tab.id, updated.content)
return `已更新 widget（字段级 patch）：...`
```

以及 `src/renderer/components/document/TiptapEditor.tsx` 本次 diff 里只改了 onRename/onCopy 两个分支，**没有**新增"commit-ready" 的 Promise 通道。

**影响**：
- useDocTabs 同步更新 → `list_widgets` 读 store 是正确的，这部分没问题。
- 但 Tiptap 的 `setContent` 在大文档里经常产生 1–3s 的"内容已更新但 DOM 还没重绘完" 的窗口。用户在这个窗口看不到变化，会立刻再发一轮 "再改一下" → 叠加在 G-Z1 上直接复现超时。
- 对 2026-04-19 plan §7 Ω2.3 的验收口径（"大文档连续改卡不再出现 '写完但界面还在旧版' 的半成品态"）未达成。

**验证路径**：
- 跑 R5：10k+ 字文档 `update_widget`，在 documentActions.ts:1078 前后加时间戳 → TiptapEditor 的 useEffect/onUpdate 被触发的时间戳；差值期望 >1s 常态。
- 修复方案：TiptapEditor 暴露 `waitForCommit(tabId)` → `documentActions.update_widget` 在 `setTabContent` 后 await 它再 return。

---

### G-Z5（P1） — 绝大多数 `document.*` 分支仍无兜底 `raceWithTimeout`

**证据**：`src/renderer/modules/agent/documentActions.ts` 的 `performDocAction` 中：

| 动作 | 是否有 raceWithTimeout |
|---|---|
| `compile_widget_spec`（内部） | ✅ 10s |
| `update_widget` 整体 | ✅ 15s |
| `insert_widget` | ❌ |
| `list_widgets` | ❌ |
| `remove_widget` | ❌ |
| `replace_text` / `replace_exact` | ❌ |
| `format_section` / `rewrite_section` | ❌ |
| `save_tab` | ❌ |
| `set_content` / `append_content` | ❌ |
| `new_tab` / `open_tab` / `switch_tab` / `rename_tab` | ❌ |

**影响**：
- `open_tab` 分支实际会 `await window.electronAPI.document.readFile(...)` 再 `parseDocx(...)` —— 大 docx 没有兜底 timeout。
- `list_widgets` 跑 regex.matchAll + 收集 —— 小文档没事，但恶意/超大 widget_code 在 regex 回溯上可能长尾。
- 加上 G-Z2 的"空 abort" 窗口，用户点 cancel 也救不回来。

**验证路径**：把每个分支包进 `raceWithTimeout(..., 15_000, 'doc:<action>')`，保持语义不变。

---

### G-Z6（P1） — draft cache write-succeeded 只失效当前 key，不抹同 widgetId 的陈旧 key

**证据**：`document-task-pipeline-executor.ts:1391-1397`

```ts
this.deleteCachedWidgetDraft(
  params.sessionId,
  params.job.instruction,
  params.job,
  targetSnapshot,
  'write-succeeded',
)
```

`deleteCachedWidgetDraft` (1851) 只按本轮的 `buildDocumentWidgetDraftCacheKey(question, job, snapshot)` 生成一个 key 做失效。

**影响**：
- 第 1 轮 question="再收紧一点" + widget=widget_A + tab=tab_X，cache key=K1。写完失效 K1。
- 第 2 轮 question="浅一点" + widget_A + tab_X，cache key=K2。K2 里有新 draft。
- 第 3 轮 question="再收紧一点"（与第 1 轮同）+ widget_A + tab_X，又生成 K1。**但 K1 已经失效，不会命中**。这一部分其实是安全的。
- **不安全**的是：若第 1 轮 question="改一下"（非常泛）没有明确写意图，pipeline 返回草稿并命中失败/回退，缓存未失效（plan §4.3 G-C4 已修复成功分支；但**失败分支**见 `1353`，是按 session 单 key 删，而**第 1 轮 session 的 question 和第 3 轮可能细微不同**）。
- 更根本的问题：一轮改卡可能多次进入 pipeline（重试 / 重算）。每次都生成不同 key，但 widgetId/tabId 相同。应该按"同 widgetId/tabId 一把抹"。

**验证路径**：扩展出 `deleteCachedWidgetDraftsByWidgetId(sessionId, widgetId, tabId)`，在 write-succeeded 时调用。

---

### G-Z7（P1） — cache key 仍缺当前 widget 源码 hash

**证据**：`document-task-cache-key.ts:38-47`

```ts
const bindingKey = params.job.bindings
  .map((binding) => {
    const identity = binding.resource.path || binding.resource.name
    const textHash = binding.role === 'target_document'
      ? 'target'   // ← 写死，不看内容
      : hashText(binding.resource.text)
    return `${binding.role}:${identity}:${textHash}`
  })
  ...
```

**影响**：对于 `target_document` 角色（即正在被改的文档/widget），cache key 里的 text hash 永远是常量 `'target'`。即便第 1 轮刚改过 widget 内容，第 2 轮相似 question 照样命中旧 draft（在 TTL 90s 内）。与 Ω1.2 的 write-succeeded 失效形成相互矛盾 —— 失效是按 key 做的，key 又跟内容无关。

**验证路径**：把 `'target'` 改成 `hashText(binding.resource.text)` 或 `hashText(widgetRecord.widgetCode)`；改完之后 Ω1.2 的失效+TTL 才是正交安全的。

---

### G-Z8（P2） — messageComposer 黏性启发式仍过宽

**证据**：`src/renderer/modules/agent/messageComposer.ts:21-29` 未被 Ω1.4 收敛。

```ts
const hasWidgetSubject = /(widget|show-widget|文档|卡片|图表|组件|章节|正文|段落)/i.test(normalized)
const hasEditVerb = /(更新|修改|调整|优化|替换|删除|新增|插入|改|去掉|拿掉|补上|统一|恢复|重写|保存)/i.test(normalized)
if (hasWidgetSubject && hasEditVerb) return true

if (/^(再|继续|把|让|统一|改|调整|优化|去掉|移除|淡一点|浅一点|更.*一点|收紧|拉开|简化)/.test(normalized)) return true
```

**影响**：
- "正文再改一下" 这种纯文档意图也会命中 → widget target attachment 被强制保留。
- Ω1.3 的 refreshDocumentWidgetTargetSnapshot 虽然会 re-fetch widgetCode，但仍然在 envelope 里附了一整块 `Widget 更新上下文` 块（messageComposer.ts:171-188），含完整 widgetCode + show-widget fence —— 对 insight LLM 调用是额外几千到上万 token。大文档 widget 叠上这个，60s buildInsight 预算会更紧。
- 这个风险与本次超时症状的关系：**间接放大** build_insight 超时概率。

**验证路径**：把判据改成显式 `widgetTitle in prompt` 或用户句中出现 `widget / 卡片 / show-widget` 本体；去掉 "文档/正文/段落/章节"。

---

### G-Z9（P2） — onToolActionRequest 无 in-flight 幂等

**证据**：`runtimeDriver.ts:580-582`

```ts
const queueKey = resolveScopeIdForRunPayload(data) || `scopeless:${data.requestId}`
activeToolRequests.set(data.requestId, { settled: false, abort: () => { /* set below */ } })
```

`set(requestId, ...)` 会覆盖同 ID 的老 entry；随后又追加一条 queue 任务到 `scopeQueues.set(queueKey, next)`。如果渲染端崩溃重载或 IPC 确实收到两次同 requestId（webContents 退化时 Electron 会重放），老任务的 settled 状态被覆盖为 false、新队尾多出一条 —— 同一请求被执行两次。

**影响**：对 `update_widget` 这类非幂等动作，第二次执行可能把 widget 再改一遍；对 list_widgets 没损伤。

**验证路径**：入队前 `if (activeToolRequests.has(requestId)) { ack duplicate; return }`。

---

### G-Z10（P2） — scopeId 必须走反查表，且反查天然滞后 1 轮

**证据**：`runtimeDriver.ts:504-513, 580`

```ts
const scopeId = resolveScopeIdForRunPayload(data)
if (!scopeId) {
  activeToolRequests.delete(requestId)
  await window.electronAPI.agent.completeToolActionRequest({
    requestId,
    handled: false,
    error: 'Scope run not found for tool action request',
  })
  return
}
```

以及 payload 结构（`ipc-handler.ts:152`）：

```ts
mainWindow.webContents.send('agent:toolActionRequest', {
  requestId,
  ...payload,   // agent / sessionId / runId / tool / args — 无 scopeId
})
```

**影响**：
- session 切换中的瞬态下，renderer store 可能反查不到 scopeId，任务立刻 ack 为 "Scope run not found" → 主进程 pipeline 当失败处理。
- 与超时症状链路是并行的：不是直接导致超时，但在"用户快速切回会话"场景下会让第 2 轮直接报错。

**验证路径**：`requestRendererToolAction` 的 payload 里强制携带 `scopeId`（由 orchestrator 在发起时算好）。

---

### G-Z11（P2） — useDocTabs ↔ Tiptap 缺跨层观测事件

**证据**：grep 全项目没有 `tiptapCommitReady`、`waitForTabReady`、`onTiptapIdle` 之类接口。

**影响**：未来要落 G-Z4 必须先建立这个通道；目前 documentActions 只能 fire-and-forget setTabContent。

---

### G-Z12（P3） — tool 层观测缺失

**证据**：
- `ready-tools.log` 在本地不存在（CLAUDE.md §11 宣称有，但没有实际写入路径）。
- `ready-directchat.log` 只有 ipc 调用 ack，没有 renderer 队列事件、pending 表变更、draft cache 命中/失效。
- plan §7 Ω4 完全未实施。

**影响**：每次用户报超时都要靠猜 + 代码 review；无法在用户现场直接拉出"第 N 轮发送时 pending 表大小是多少 / queue 里积了几条"。

**验证路径**：
- renderer：入队 / 出队 / watchdog 触发 / cancel / settled 各打一条 `ready-tools.log`。
- main：`requestRendererToolAction` 入 pending / 120s 触发 / cancelToolActionRequestsBySession 命中数 / agent:send preempt 打印 pending size。
- cache：session/shared/draft 命中与失效原因。

## 4. 症状 → 直接根因 → 架构缺口（合订表）

| 症状 | 直接根因 | 架构缺口 | 严重度 |
|---|---|---|---|
| 第 2 轮 `agent:send` 后 30–150s 才见到 tool 推进，然后冒 `Timed out waiting for renderer tool action result: <tool>` | send-preempt 只 abort 主侧 controller，renderer 队列里积压的第 1 轮 tool 任务照常顺序执行；主的 120s 兜底先到 | G-Z1（级联取消缺失）+ G-Z3（signal 丢弃）+ G-Z5（分支无兜底 timeout） | **P0** |
| 手动 `stop / 新建会话` 之后，偶发"老任务还是跑到底" | cancel IPC 到达时 entry.abort 仍是 no-op（runWithWatchdog 未入口） | G-Z2 | **P0** |
| 用户看到 UI 没更新就再点一次 → 队列雪崩 | setTabContent 后 Tiptap DOM 重绘滞后，无 commit-ack | G-Z4 + G-Z11 | **P1** |
| 相似问句第 N 轮拿到旧 draft | write-succeeded 只失效单 key；cache key 不含目标 widget 内容 hash | G-Z6 + G-Z7 | **P1** |
| insight/widget 阶段 60s 到期，envelope 里塞了完整 widgetCode + show-widget fence | messageComposer 黏性过宽 | G-Z8 | **P2** |
| 偶发"Scope run not found for tool action request" | payload 不带 scopeId，renderer 反查漂移 | G-Z10 | **P2** |
| 很少出现的重复执行 / 重复写 | onToolActionRequest 无幂等 | G-Z9 | **P2** |
| 用户报告时无可核对证据 | tools.log 未建立，tools/queue/pending 无观测 | G-Z12 | **P3** |

## 5. Round-2 修进计划骨架（未落码，只登记）

> 优先级严格按 P0 → P1 → P2 → P3 推进。每个阶段落地前先补观测（§6）。

### Phase Ω0+ — 封住 send-preempt 级联取消

- **Ω0+.1** `direct-chat.ts:sendMessage` 在 `session.abortController.abort()` 之后调用 `this.deps.cancelToolActionRequestsBySession(agent, sessionId)`（需要从 orchestrator/ipc-handler 把这个 hook 注进来）。
- **Ω0+.2** 把 `requestRendererToolAction` 的 Promise 接 `signal`：pipeline 调用时传入当前 run 的 signal；abort 触发 → main-side 立即 `releasePendingRequest + reject` + 发 `agent:cancelToolActionRequest`。
- **Ω0+.3** `runtimeDriver.ts` `onToolActionRequest` 预置真 abort：在 `activeToolRequests.set` 时挂一个 `pendingAbort = false` 标志；cancel IPC 到达时若任务未进入 runWithWatchdog，把 `pendingAbort = true`；runWithWatchdog 入口 `if (pendingAbort) { ack cancelled; return }`。
- **验收**：手动让第 1 轮 renderer 端 sleep 10s；第 2 轮 send 立即到；期望第 2 轮 2s 内看到 tool 开始推进，第 1 轮 pending 全部 ack `cancelled` 而不是 `Timed out...`。

### Phase Ω1+ — 草稿一致性收尾

- **Ω1+.1** `document-task-cache-key.ts` 把 `target_document` 的 textHash 从常量 `'target'` 换成 `hashText(binding.resource.text.slice(0, 20_000))`（防止巨大文档 hash 成本过高）。
- **Ω1+.2** `document-task-pipeline-executor.ts` 新增 `deleteCachedWidgetDraftsByWidgetId(sessionId, widgetId, tabId)`，write-succeeded 时连同本轮 key + 同 widgetId/tabId 的所有 key 一把删。
- **Ω1+.3** `messageComposer.ts:shouldKeepDocumentWidgetTargetAttachment` 收敛：去掉"文档/正文/段落/章节"；保留"widget / show-widget / 卡片 / 图表 / 组件" + widgetTitle 命中。加单测覆盖"正文再改一下"这类负例。
- **验收**：连续 3 轮相似问句改同一卡，每轮 envelope grep `widgetCode` 只出现一份，且每轮与实际 DOM 一致；cache 命中 log 不再出现相同 K 跨轮。

### Phase Ω2+ — 文档 IPC 全面兜底 + tiptap commit ack

- **Ω2+.1** documentActions.ts 所有 `performDocAction` 分支包 `raceWithTimeout(op, 15_000, 'doc:<action>')`；`open_tab` / `parseDocx` 单独给 30s（大 docx）。
- **Ω2+.2** TiptapEditor 暴露 `getCommitAwaitable(tabId): Promise<void>`，documentActions 的 `update_widget/insert_widget/set_content` 在 `setTabContent` 后 await 它（有 2s 超时兜底；超时走 fire-and-forget 但记 log）。
- **验收**：10k+ 字大文档连续改卡，DOM 更新最慢不超过 500ms；没有出现"改完没反应又点一次"的观感。

### Phase Ω3+ — scopeId 结构化 + 幂等

- **Ω3+.1** `requestRendererToolAction` payload 强制带 `scopeId`，由 orchestrator 发起时算；renderer `resolveScopeIdForRunPayload` 退化为直取 payload.scopeId，失败才回 store 反查。
- **Ω3+.2** `runtimeDriver.onToolActionRequest` 加 `if (activeToolRequests.has(requestId)) { ack 'duplicate-request'; return }`。
- **验收**：session 快速切换 10 轮，没有 "Scope run not found" 与重复执行。

### Phase Ω4+ — 观测落地（前置条件）

- **Ω4+.1** 建立 `ready-tools.log`（与 CLAUDE.md §11 声明一致），renderer 侧入队 / 出队 / watchdog / cancel / duplicate 各打一条；main 侧 pending 变化、cancelBySession 命中、send-preempt 时 pending 大小各打一条。
- **Ω4+.2** renderer 加 `window.__readyDebug.toolQueueDump()` + `pendingDump()`。
- **验收**：用户再报超时时，能直接在 log 里检索到：当时第 N 轮入队时间 / 第 N-1 轮积压数量 / 最后哪条触发 watchdog。

## 6. 复现实验清单（修前跑 baseline，修后跑回归）

- **R-Z1**（G-Z1 / G-Z3 证实）：第 1 轮 update_widget 请求发出后人为让 renderer 端 `runtimeDriver.ts:585` 延迟 10s 才进入 runWithWatchdog；立即发第 2 轮改卡 `update_widget`；**期望现状**：第 2 轮 120s 左右超时；**期望修后**：第 2 轮 2s 内开始，第 1 轮 pending 全部 ack cancelled。
- **R-Z2**（G-Z2 证实）：在 `runWithWatchdog` 入口处 `await sleep(300)`；send 之后立即调用 `agent:newSession`；**期望现状**：老任务跑完；**期望修后**：老任务立刻 ack cancelled。
- **R-Z3**（G-Z4 证实）：打开 `需求文档.md`（≥10k 字），`update_widget` 目标为一个 `stats_card`；记录 `docStore.setTabContent` 返回时间 vs TiptapEditor 的 onUpdate 第一次触发时间。
- **R-Z4**（G-Z6 / G-Z7 证实）：同 widget 发 3 轮"再紧一点 / 浅一点 / 再紧一点"；观察 `document widget draft session cache hit` log 是否在第 3 轮命中第 1 轮 draft（即使 TTL 内）。
- **R-Z5**（G-Z10 证实）：第 1 轮 send 之后立即切换到另一个 agent 再切回来；观察是否出现 `Scope run not found for tool action request`。
- **R-Z6**（G-Z12 验证）：用户场景抓不到 `ready-tools.log` 本身就是该实验的失败路径 —— 修复阶段先补 log，再跑全部 R-Z1..Z5。

## 7. 决策清单

1. G-Z1 修法要么在 ipc-handler 层，要么在 direct-chat 层。建议在 direct-chat 依赖里注一个 `cancelToolActionRequestsBySession` 回调；避免 direct-chat 直接耦合 ipc-handler 的模块。
2. G-Z2 的 "pendingAbort = true" flag 需要和 runWithWatchdog 入口统一约定。另一种写法是 runWithWatchdog 一进来就先检查 activeToolRequests；如果 entry.settled 已是 true（cancel 通过 settled=true 来标记），则直接短路。这需要 cancel IPC handler 在 entry.abort 还是 no-op 的情况下也能把 settled 置 true —— 把 abort 改成通用的 "如果 settle 过就不重复置" 的纯状态机。
3. G-Z4 是否阻塞 Ω0+ ：不阻塞 —— Ω0+ 治根本，Ω2+.2 治观感。但 Ω0+ 修完后仍会有"UI 慢"的体感，要让用户知道。
4. G-Z6 / G-Z7 是否同时上：建议同步，否则 cache 语义仍然矛盾（key 不看内容，失效又按 key）。
5. G-Z8 消息 composer 正则收敛风险：可能影响已有 "一句话改卡" 的附件保留率。需要回归 `messageComposer.test` 以及 `document-widget-target-context.test`。

---

## 8. 与既有文档接驳

- 本文件是 `2026-04-19-ready-agent-continuous-widget-modification-timeout-audit.md` 的 Round-2 延续；第一轮 audit 列的 G-A/B/C/D/E 部分已在 Ω0/Ω1/Ω2 commits 里合上，剩余未合的缺口都映射到本轮 G-Z1..Z12。
- 与 `2026-04-18-ready-agent-info-card-modification-gap-audit.md` （P0–P3，治"卡片根本没生成"）不冲突 —— 本轮只治"卡片可以生成但 2+ 轮后超时"的运行时路径。
- **不落 CHANGELOG / PROGRESS 条目**；等 Phase Ω0+ 第一次 commit 再补。

## 9. 推荐的实施顺序（给下一步修复者）

1. 先落 **Phase Ω4+ 观测** —— 任何其他修复之前，要保证下次出问题能立即拿到现场证据。
2. 然后 **Phase Ω0+**（送命级根因，P0）—— 覆盖 G-Z1 / G-Z2 / G-Z3 三个互相耦合的取消路径。
3. **Phase Ω2+** —— 同批解决 G-Z4 / G-Z5 / G-Z11，提升"看起来改对了" 的第一印象。
4. **Phase Ω1+** —— G-Z6 / G-Z7 / G-Z8，收紧 cache 与 envelope 一致性。
5. **Phase Ω3+** —— 结构性收尾。

顺序原则：先让超时文本消失（Ω0+），再让 UI 感受正常（Ω2+），再消除"改了没效果"的语义漂移（Ω1+），最后治杂项（Ω3+）。观测（Ω4+）必须最前，否则回归验收缺乏证据。

---

_该 audit 不落代码修改。后续 remediation plan 与 commits 请按 §5 顺序推进。_
