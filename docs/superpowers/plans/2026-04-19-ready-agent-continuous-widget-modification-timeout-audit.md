---
title: Continuous Widget Modification Timeout Audit
date: 2026-04-19
branch: codex/document-widget-pipeline-cache
status: audit-only (no code changes)
audience: ready-agent & document pipeline maintainers
scope: document ↔ widget (信息卡) ↔ agent runtime interaction, specifically the "2+ 轮连续改卡后工具请求超时" symptom
related:
  - docs/superpowers/plans/2026-04-17-ready-agent-runtime-realignment-info-card-gap-trace.md
  - docs/superpowers/plans/2026-04-18-ready-agent-info-card-modification-gap-audit.md
  - docs/superpowers/plans/2026-04-18-ready-agent-runtime-realignment-second-round-audit.md
---

## 0. User statement (verbatim)

> 刚对当前项目中的 agent 进行连续的卡片修改调整，在两轮之后会出现 agent 错误工具请求超时的问题，深入查看一下是不是文档模块、信息卡生成和修改、agent 模块间还存在什么缺口或者设计缺陷，先不进行具体修改，找到所有的缺口、问题、待优化内容、修改错误内容，列出到文档中，之后再来针对性地列出修改计划进行优化

## 1. Scope & method

- **Symptom audited**: 连续两轮以上对同一 widget 发出修改指令后，第 N (N≥2) 轮出现 `工具请求超时 / Timed out waiting for renderer tool action result: <tool>` 失败。第 1 轮成功，第 2 轮才暴露问题 → 不是首包生成问题，是 **跨轮状态/通道** 问题。
- **Explicitly NOT re-audited**:
  - 2026-04-17/04-18 两轮 audit 已覆盖的 "schema 验证 / 草稿构建失败" 路径 (P0–P3 已落地于 commit `0312c14`, `cbce0d5`, `1a891cc`)；那条路径的症状是 "卡片没生成出来"，不是 "超时"。
  - Pipeline 通用的 plan/insight 缺口（已在 `2026-04-18-ready-agent-runtime-realignment-second-round-audit.md` 记录）。
- **Method**: 从用户动作出发反向穷举跨轮共享的状态 / 单点队列 / 超时窗口 / 资源快照；对每个嫌疑点给出 file:line 锚点与现状引用，再汇总「症状 → 直接原因 → 架构缺口」映射。
- **Output**: 本文件只列缺口与分级，不落代码修改；分阶段 remediation plan 作为 §7 骨架，等用户确认后再细化并分批实施。

## 2. 跨轮超时的端到端路径回放

一轮「改卡」从用户回车到工具完成的主链路：

1. **renderer 组装消息**：`messageComposer.filterAttachmentsForComposedAgentInput` 判定是否保留 `document-widget-target` 附件（黏性启发式，见 §4.2）。
2. **主进程路由 + pipeline**：`DocumentTaskPipeline.run` → `build_insight / compose_widget` 两段 → 从 `sessionWidgetDraftCaches` / `documentWidgetDraftCache` 读草稿（见 §4.3）。
3. **pipeline 回落 / 或 agent 直接发工具调用** → 触发 `orchestrator.requestRendererToolAction(...)` → `ipcMain` 把 `agent:toolActionRequest` 通过 `mainWindow.webContents.send` 推给 renderer（见 §4.4）。
4. **renderer 收件串行队列**：`runtimeDriver.ts:475` 的 `toolActionRequestQueue = toolActionRequestQueue.then(...)` 单通道串行执行 `executeModuleToolAction` → 在 `documentActions.ts` 里落到 `resolveWidgetCodeInput` / `setTabContent` 等 UI side-effect（见 §4.1）。
5. **tiptap / markdown 编辑器落地 DOM**：更新 store → Tiptap `setContent` → 渲染完成后 resolve → renderer 回 `agent:completeToolActionRequest`。
6. **主进程 120s 看门狗**：`ipc-handler.ts:105-108` 的 `setTimeout(..., 120_000)` 若先于 complete 触发，即抛 `Timed out waiting for renderer tool action result: <tool>`；这就是用户看到的「工具请求超时」。

这条链路从第 1 轮到第 2 轮之间，存在 **6 类跨轮遗留** 会叠加成 120s 超时：
renderer 单链串行队列 (A) / 主进程待 ack 表 (B) / 草稿缓存 (C) / 附件黏性 (D) / continuation 正则状态 (E) / tiptap 异步写回 (F)。下节分别展开。

## 3. 症状 → 直接原因 → 架构缺口 映射总表

| # | 用户可见症状 | 直接原因（第 2 轮时的状态） | 架构缺口 | 严重度 |
|---|---|---|---|---|
| S1 | `Timed out waiting for renderer tool action result: <tool>` | renderer 单一 toolActionRequestQueue 仍在跑第 1 轮残留任务，第 2 轮请求等在链尾 | 整个渲染进程仅一条全局串行队列，无 per-scope、无可取消、无 watchdog | **P0** |
| S2 | 相同超时 + 主进程日志里 pending 表未被清 | 主进程 `pendingToolActionRequests` 只按 120s 计时器清，`stopGeneration` / `kill` 不传播取消 | 主进程没有 per-request 取消通道，`agent:toolActionRequest` 和会话/scope 没绑定 | **P0** |
| S3 | 第 2 轮生成的 widget 仍然是第 1 轮的视觉/字段（"改了没效果"），再点一次才触发超时 | `sessionWidgetDraftCaches` + `documentWidgetDraftCache` 无 TTL、cache key 不含 `widgetId / tabId / content hash`，第 2 轮的同义问句命中第 1 轮草稿 | 草稿 cache key 不反映已修改的目标 widget 实际状态；clearSessionCache 只在 `newSession`/`cleanup` 调用 | **P1** |
| S4 | 日志/envelope 里仍然带着旧的 `widgetCode` 片段（比第 2 轮正文还长） | `messageComposer.shouldKeepDocumentWidgetTargetAttachment` 基于正则启发式保留 `document-widget-target`，但 attachment 里的 `widgetCode` 是第 1 轮点击时抓的快照 | widget target attachment 没有「每轮重取当前 widgetCode」的机制，跨轮自然陈旧 | **P1** |
| S5 | 超时前 pipeline 长时间卡在 `generating_widget_spec` / `locating_target_widget` | `resolveWidgetCodeInput` → `compileDocumentWidgetComponentSpec` → `buildScheduleRuntimeSnapshot` 等无超时；IPC 回包若丢失链路就永远 pending | renderer 侧对 `window.electronAPI.agent.*` 返回不设兜底 timeout；pipeline / moduleExecutor 的 timeout 只覆盖部分 RSS/calendar 动作（moduleExecutor.ts:17 `timeoutMs=4000`），未覆盖 `document_*` 动作 | **P1** |
| S6 | 第 2 轮 continuation 串了第 1 轮的 Task ID | continuation 仍然是 `2026-04-18-ready-agent-runtime-realignment-second-round-audit.md` §3.2 记的「regex-only 正则协议」；没有结构化绑定到当前 run / scope | continuation state 只按正则解析上一轮文本，跨轮碰到相似措辞会复用旧的 Task/Exec/Step ID，导致 pipeline 路由到"继续上一轮"分支并复用缓存 | **P2** |
| S7 | 超时之后再点一次立刻好 | renderer 队列排空后 orphan 任务解完，第 3 轮请求直接取到新上下文 | 进一步佐证 S1 是队头阻塞，不是单次 IPC 损坏 | 佐证项 |
| S8 | 极个别情况出现 "Scope run not found for tool action request" | `resolveScopeIdForRunPayload` 在主进程侧无法反查到 scope（session 已切或 scope 被 GC） | 主进程→renderer 的 toolActionRequest payload 没有带 scopeId，renderer 需要按 agent/runId 反查，反查表自身也会漂移 | **P2** |

## 4. 详细缺口清单（按层）

### 4.1 Renderer 工具动作队列（P0 — 最高嫌疑根因）

**现状**（`src/renderer/modules/agent/runtimeDriver.ts:475-571`）：

```ts
let toolActionRequestQueue: Promise<void> = Promise.resolve()
const cleanupToolActionRequest = window.electronAPI.agent.onToolActionRequest
  ? window.electronAPI.agent.onToolActionRequest((data) => {
    toolActionRequestQueue = toolActionRequestQueue
      .then(async () => {
        const scopeId = resolveScopeIdForRunPayload(data)
        ...
        const result = await executeModuleToolAction({ scopeId, ..., args, runId, ... })
        await window.electronAPI.agent.completeToolActionRequest({ requestId, handled, payload })
      })
      .catch(async (error) => { ... await window.electronAPI.agent.completeToolActionRequest({ requestId, handled: false, error }) })
  })
  : () => { /* older test stubs */ }
```

**问题**：

- **G-A1**：整条渲染进程的生命周期内，**只有一条 `toolActionRequestQueue` 串行链**。没有按 `scopeId / agent / runId / 工具类型` 分片。任何一轮里的卡顿都是队头阻塞，直接拖住后续所有轮的工具请求。
- **G-A2**：队列 task **没有 timeout / AbortSignal**。`executeModuleToolAction` 若在第 1 轮卡住（例如 tiptap `setTabContent` 返回晚于工具层 15s 预算，或 `compileDocumentWidgetComponentSpec` IPC 无应答），没有任何看门狗把它踢出。
- **G-A3**：`stopGeneration` / `kill` 调用到达主进程时，`agent:toolActionRequest` 已经在主→渲的 IPC 路上或已在队列尾等待执行；主进程侧 **没有给 renderer 发 "取消 requestId X"** 的对等消息，也没有断掉 `pendingToolActionRequests.set(requestId, ...)`。于是第 2 轮的 "新 session / abort" 也清不干净第 1 轮队尾。
- **G-A4**：当 `resolveScopeIdForRunPayload` 返回 null（session 已切），代码直接回 `handled:false` 就 `return`（runtimeDriver.ts:481-488），但 **队列本身已经被这段 async 占用**。若在此之前还有更早的 orphan task 在跑，依旧排不出来。
- **G-A5**：`.catch` 路径回 `completeToolActionRequest` 但仍旧保留了整条链（未替换为新的 `Promise.resolve()`）。一旦某一轮抛出非 Error 对象或 `completeToolActionRequest` 本身 reject（preload 丢失/窗口销毁），下一轮立刻进入 catch，但仍然是串行执行 — 没有隔离。

### 4.2 渲染侧 widget target 附件黏性（P1）

**现状**（`src/renderer/modules/agent/messageComposer.ts:7-37`）：

```ts
function shouldKeepDocumentWidgetTargetAttachment(content: string, attachment: ChatAttachment): boolean {
  const normalized = content.trim()
  if (!normalized) return false
  const widgetTitle = String(attachment.widgetTitle || attachment.title || attachment.name || '').trim()
  if (widgetTitle && normalized.toLowerCase().includes(widgetTitle.toLowerCase())) return true
  if (/更新当前文档里的\s+.+widget[:：]?/i.test(normalized)) return true
  const hasWidgetSubject = /(widget|show-widget|文档|卡片|图表|组件|章节|正文|段落)/i.test(normalized)
  const hasEditVerb = /(更新|修改|调整|优化|替换|删除|新增|插入|改|去掉|拿掉|补上|统一|恢复|重写|保存)/i.test(normalized)
  if (hasWidgetSubject && hasEditVerb) return true
  if (/^(再|继续|把|让|统一|改|调整|优化|去掉|移除|淡一点|浅一点|更.*一点|收紧|拉开|简化)/.test(normalized)) return true
  return false
}
```

**问题**：

- **G-B1**：attachment 的 `widgetCode / widgetTitle / widgetSnapshot` 在 `createDocumentWidgetTargetAttachment` 点击时就固化了。第 2 轮发 "再收紧一点" 时，这个 attachment **被重新拼到 prompt 里**，但里面的代码块仍然是第 1 轮修改 **之前** 的样子。
- **G-B2**：黏性判定是启发式正则。只要用户续写用了 `再 / 调整 / 改 / ...` 或带了 `widget / 卡片`，就强制保留 — 等价于主动放大了 G-B1。
- **G-B3**：没有 "轮与轮之间刷新 attachment" 的显式路径。`addDocumentWidgetTargetReference` 只在用户重新点击 widget 头时触发；两轮同一气的语音/键盘输入不会命中。
- **G-B4**：在正常 prompt 里第 2 轮句子通常较短（"字段再少一行" / "颜色浅一点"），正则全部命中 → prompt 里又附了一份完整 widgetCode + widgetTitle → main 侧 envelope 把它放回 `document_context` → pipeline 又拿旧 widget 当 target → cache key 命中旧草稿（见 §4.3）。

### 4.3 草稿缓存 cache key（P1）

**现状**（`src/main/modules/agent-control/document-task-cache-key.ts`）：

```ts
return [ params.step, targetIdentity, normalizeQuestion(params.question), hashText(bindingKey) ].join('::')
```

其中 `targetIdentity = targetSnapshot?.path || targetBinding?.path || targetSnapshot?.title || targetBinding?.name`。

**问题**：

- **G-C1**：**cache key 不含 `widgetId / occurrence / tabId / 当前文档内容哈希`**。同一个文档、相同问句 ("再收紧一点")、同一 target 路径 → 第 2 轮直接命中第 1 轮的 draft。用户看到的就是 "看起来没改动 / 改错了 / 要求再改一次" → 继续堆积 tool request → 遇到 §4.1 的队列死循环。
- **G-C2**：`sessionWidgetDraftCaches` 按 session LRU (cap 6)，**无 TTL**；`documentWidgetDraftCache`（共享，跨 session）**既无 TTL 也无容量上限**，进程生命周期内累积。
- **G-C3**：`clearSessionCache` 只在 `newSession` / `cleanup` 调用（`direct-chat.ts:604, 1446`）。`stopGeneration`（`direct-chat.ts:630`）不会清，轮次切换也不会清 — 没有 "每轮 / 每次成功写入文档后失效旧 draft" 的路径。
- **G-C4**：P3 落下的 "build 失败时 invalidate draft" (`deleteCachedWidgetDraft`) 只覆盖失败分支；**成功分支** 写回文档后 draft 仍然保留，下一轮同句又吃到它。
- **G-C5**：key 里的 `normalizeQuestion` 做了 lower + 空白压缩，用户用 "再浅一点" vs "浅一点" 都会归一，放大 G-C1 碰撞面。

### 4.4 主进程 IPC 工具请求通道（P0）

**现状**（`src/main/modules/claude-bridge/ipc-handler.ts:88-149`）：

```ts
const pendingToolActionRequests = new Map<string, { resolve, reject, timer }>()
const requestRendererToolAction = async (payload) => {
  ...
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingToolActionRequests.delete(requestId)
      reject(new Error(`Timed out waiting for renderer tool action result: ${payload.tool}`))
    }, 120_000)
    pendingToolActionRequests.set(requestId, { resolve, reject, timer })
    mainWindow.webContents.send('agent:toolActionRequest', { requestId, ...payload })
  })
}
```

**问题**：

- **G-D1**：120s 超时是 renderer 队列的"二次观察窗"。只要 §4.1 里的队头阻塞超过 120s（第 1 轮有一次 tiptap / compileDocumentWidgetComponentSpec 慢响应即可），主进程侧的 reject 就会把最终错误文本冒到用户：`Timed out waiting for renderer tool action result: <tool>`。
- **G-D2**：`pendingToolActionRequests` **没有 sessionId / agent / runId 维度的索引**。`stopGeneration(name)` 没有能力 `pending.forEach(... pending.reject(new AbortError()))`。
- **G-D3**：payload 里也没携带 `scopeId`（只有 `agent / sessionId / runId / tool / args`），renderer 侧 §4.1 的 `resolveScopeIdForRunPayload` 是按现有状态反查，天然滞后 1 轮。
- **G-D4**：没有 `agent:cancelToolActionRequest` 之类的对等 IPC；窗口销毁时仅靠 `mainWindow.isDestroyed()` 判定一次（第 100 行），跑到 pending 里的请求只能等 120s。
- **G-D5**：renderer 回 `completeToolActionRequest` 前若 renderer 崩溃 / 重载，主进程不会收到任何信号，只能等 120s。没有 heartbeat / progress ping。

### 4.5 Pipeline / renderer 工具动作本身无兜底 timeout（P1）

**现状**：

- `src/renderer/modules/agent/moduleExecutor.ts:17` 定义了 `timeoutMs = 4000`，但只被 rss / calendar 这类轻 IPC 使用。
- `src/renderer/modules/agent/documentActions.ts` 里 `update_widget / list_widgets / resolveWidgetCodeInput / setTabContent` 等调用链 **没有 timeout 包裹**。
- `resolveWidgetCodeInput` 继续等 `compileDocumentWidgetComponentSpec(...)`，其内部又会触发 `buildScheduleRuntimeSnapshot → window.electronAPI.agent.listSchedules()` 等 IPC；若任何一步 IPC 长时间不响应，整个 queued task 阻塞 — 队列内唯一的退出是异常或 resolve。
- 主 tool 层 `tool-execution-timeout-policy.ts` (DEFAULT=15s / DOC_WRITE=30s / BROWSER=60s / SKILL=120s) 只覆盖 agent 主循环侧的 tool 执行；**不覆盖** 主→渲的 `requestRendererToolAction` 链路（那条路径只有 ipc-handler.ts:108 的 120s）。

**问题**：

- **G-E1**：tool 层 timeout 和 renderer 侧 IPC timeout **不在同一条语义轴上**，且双层中间的队列没有任何 watchdog；两层 timeout 中间的 105–120s 黑洞就是用户看到的"什么都没发生然后报超时"。
- **G-E2**：`update_widget` 依赖 tiptap 的异步 `setContent`；tiptap 在大文档里 `setContent` 会触发 1–3 秒的 re-parse，`documentActions` 并未等待 DOM commit ✔ 的显式信号 — 有几率短包但长尾。
- **G-E3**：`documentActions.update_widget` 没有 per-tabId inflight lock。第 2 轮跟第 1 轮若重叠（例如用户尚未看到第 1 轮 "完成" 态就按回车），会发生两次 setTabContent 互相踩踏，tiptap 可能停在中间态，进一步放大 G-E2。

### 4.6 Continuation / Task ID 正则协议残余（P2）

- 已在 `2026-04-18-ready-agent-runtime-realignment-second-round-audit.md` §3.2 记录：continuation 仍按正则从上一条文本里拉 `Task ID / Execution ID / Step ID`。
- 跨轮问题：第 1 轮最后一条 assistant 文本通常会复述 Task ID；第 2 轮 envelope 构造时若命中同样的正则，pipeline 会被路由到"继续上次任务"分支，**复用 §4.3 的 draft cache**，放大 S3/S4。
- 这里不是新缺口，是既有缺口在 "连续改卡" 场景下的放大器，故列入本次 audit。

### 4.7 Tiptap 写回与 document 状态同步（P2）

- `src/renderer/components/document/TiptapEditor.tsx` 在本次改动中被修改（git status 标 M）。需要确认 `setContent` 的 resolve 时机是否与 `documentActions.update_widget` 的 `await` 时序吻合。
- 若 tiptap replace 是 fire-and-forget（`commands.setContent(...)` 返回 boolean 而不是 Promise），则 §4.1 队列已经 resolve 完成但 DOM 仍在重排，第 2 轮立即发起的 `list_widgets` 可能读到半成品。
- 没有发现当前 `documentActions` 里对 `waitForTabReady / waitForTiptapIdle` 这类钩子的调用。应在 remediation 时补证。

### 4.8 附件 / 会话 scope 的隐性漂移（P2/P3）

- `chat-input-bridge.ts:50-66` 的 `addDocumentWidgetTargetReference` 只按 `source==='document-widget-target'` 去重并替换；**不会主动失效**。若用户第 2 轮切到另一个 tab 再切回来，attachment 还是原第 1 轮那个。
- `widget-target-attachment.ts` 里 `createDocumentWidgetTargetAttachment` 捕获点击态；一旦 widget 被 update_widget 写回，snapshot 不主动刷。
- 这与 G-B1 组合出典型 "改完一次后，再发任何 '调整一下' 都带着旧 widgetCode" 的体感问题。

## 5. 为什么 2026-04-18 的 P0–P3 没能关这些缺口

本次 audit 发现的缺口绝大多数 **不在** 04-18 三轮 commits 的覆盖面里：

| 04-18 落地内容（来自 PROGRESS.md） | 是否触及本次缺口 |
|---|---|
| P0 `list_widgets` 结构化 JSON + `show-widget` fence | 否 — 仅治草稿结构 |
| P1 controlled target selection / widget-centered insight chunks | 否 — 仍走同一条 draft cache |
| P2 `componentSpecPatch` 支持 / 失败路径 cache invalidation | 部分 — 只覆盖 §4.3 的失败分支，成功分支未处理 (G-C4) |
| P3 list/remove intent routing / 动态 phaseOrder | 否 — 与跨轮队列 / IPC timeout 无关 |

**未触达**：renderer 全局 toolActionRequestQueue 单链（§4.1）、主进程 `pendingToolActionRequests` 无取消通道（§4.4）、widget target attachment 黏性 + snapshot 陈旧（§4.2 + §4.8）、draft cache 成功分支不失效 + 无 TTL + 共享 cache 无上限（§4.3）、renderer 侧 document IPC 无兜底 timeout（§4.5）、continuation 正则协议残余（§4.6）、tiptap commit ack（§4.7）。

## 6. 复现实验建议（供 remediation 阶段验证）

用于分别证实 / 证伪每个缺口。Audit 阶段不执行，只登记路径。

- **R1**（证 G-A1）：在 `runtimeDriver.ts` 注入人为 5s sleep 到第一次 `executeModuleToolAction`，观察第 2 轮请求是否精确延迟到第一次 sleep 结束后才开始。预期：是 → §4.1 成立。
- **R2**（证 G-D1）：手动让 renderer 侧 `completeToolActionRequest` 不回，等 120s，断言 assistant 侧看到 `Timed out waiting for renderer tool action result: <tool>` 文本。预期：是 → §4.4 成立。
- **R3**（证 G-C1）：在第 1 轮改卡成功后，不新开会话，直接发同样的修改指令；断言主进程 log 出现 `document widget draft session cache hit key=...`。预期：是 → §4.3 G-C1/C4 成立。
- **R4**（证 G-B1/B4）：截取第 2 轮 `agent:send` 的 message payload，grep `widgetCode` 字段是否仍是第 1 轮修改前的片段。预期：是 → §4.2 成立。
- **R5**（证 G-E2）：对 2000+ 行大文档跑 `update_widget`，对比 `documentActions.update_widget` 发出 setTabContent 的时间戳与 tiptap render commit 的时间戳差。预期：>1s 常态。

## 7. 分阶段 remediation plan 骨架（等确认后再细化）

> 本节只列编号、目标、验收口径，具体代码改动写在后续 commit-ready plan 文档。分期原则：先封"卡住不报错"的通道（P0），再封"看起来改了但没改"的语义（P1），其它并行收尾。

### Phase Ω0 — 立即止血（P0，目标：彻底消除 120s 超时文本）

- **Ω0.1** renderer 队列 per-scope 化：把 `toolActionRequestQueue` 从全局单链改成 `Map<scopeId|agent, Promise<void>>`；每个 scope 自己一条链，跨 scope 不阻塞；未知 scope 走独立 ephemeral chain。
- **Ω0.2** renderer 队列 task 内加 per-task watchdog（默认 30s for document tools / 60s for browser / 沿用主 tool policy 的 budget），到点强制 `completeToolActionRequest({ handled:false, error:'renderer-task-watchdog' })`，并把 queue 推进到下一个。
- **Ω0.3** 主进程新增 `agent:cancelToolActionRequest` IPC（main→renderer），在 `stopGeneration(name)` / `newSession` / `kill` 里按 agent/sessionId 批量取消，renderer 收到就从队列里摘掉对应 requestId 并立即 `completeToolActionRequest({ handled:false, error:'cancelled' })`。
- **Ω0.4** `pendingToolActionRequests` 增加维度：以 `{ agent, sessionId, requestId }` 建 Map；提供 `cancelBySession(name, sessionId?)`；`stopGeneration` 调用它。
- **验收**：手动阻塞第 1 轮 renderer 端 10s，第 2 轮能 2s 内拿到结果；手动 `stopGeneration` 后第 1 轮 pending 立即 reject 为 `cancelled`，不触发 120s 超时文本。

### Phase Ω1 — 语义一致（P1，目标：第 N 轮改卡确实改对的是当前 widget）

- **Ω1.1** `buildDocumentTaskStepCacheKey` 加入 `widgetId / tabId / 当前文档内容哈希（对目标 widget 片段即可）`；key 仍然 join 成串，hash 化避免膨胀。
- **Ω1.2** `sessionWidgetDraftCaches` + `documentWidgetDraftCache` 引入 TTL（默认 90s）和条目 cap（共享 cache 32/总上限）。成功写回文档后，主动 invalidate 目标 widget 的所有 draft key（复用 `deleteCachedWidgetDraft` 扩展为 `deleteCachedWidgetDraftsByWidgetId`）。
- **Ω1.3** widget target attachment 在"轮间"主动刷新：每次 agent:send 之前，由 renderer 调用 `refreshDocumentWidgetTargetSnapshot(tabId, widgetId)` 读取当前 widget 源码并重写 attachment；黏性正则改为仅决定是否"保留引用"，snapshot 本身始终重取。
- **Ω1.4** `messageComposer.shouldKeepDocumentWidgetTargetAttachment` 的启发式正则收敛：去掉 "文档 / 正文 / 段落 / 章节" 这类过宽关键词，避免对非 widget 任务误黏。
- **验收**：连续 3 轮改同一张卡，每轮 envelope 的 widgetCode 与写回后的文档一致；同问句第 2 轮不再命中第 1 轮 draft。

### Phase Ω2 — 渲染侧 document IPC 兜底（P1）

- **Ω2.1** `documentActions.ts` 所有 `window.electronAPI.agent.*` 调用统一包 `withTimeout(op, 15_000 /* 文档默认 */)`；`compileDocumentWidgetComponentSpec` / `buildScheduleRuntimeSnapshot` 单独给 10s 预算，超时回退到纯 widgetCode 串。
- **Ω2.2** `update_widget` 增加 per-tabId inflight lock（Map<tabId, Promise>），第 2 轮排队等前一个 tiptap commit 完成后再执行；主进程侧可继续 fire-and-forget。
- **Ω2.3** Tiptap setContent 改成返回 "commit done" Promise（在 onUpdate 第一次触发后 resolve），`documentActions.update_widget` `await` 这个 promise 再 resolve 给队列。
- **验收**：大文档（10k+ 字）连续改卡不再出现"写完但界面还在旧版"的半成品态。

### Phase Ω3 — Continuation / scope 漂移（P2）

- **Ω3.1** Continuation 从正则协议迁移到结构化：主进程在 scope 状态里显式存 `TaskContinuationToken`，renderer 在 agent:send 前按 scope 读；不再依赖上一轮 assistant 文本的正则匹配。
- **Ω3.2** `agent:toolActionRequest` payload 强制携带 `scopeId`；renderer 侧 `resolveScopeIdForRunPayload` 退化为 "直接取 payload.scopeId"。
- **验收**：跨 session 切换后不再出现 continuation 串台 / "Scope run not found for tool action request" 偶发。

### Phase Ω4 — 日志 / 可观测（P2）

- **Ω4.1** 所有跨轮超时事件统一打到 `ready-directchat.log` + `ready-tools.log`，带 `scopeId / sessionId / runId / tool / requestId / 队列 backlog 长度`。
- **Ω4.2** renderer 侧 toolActionRequestQueue 在 dev 模式暴露 `window.__readyDebug.toolQueueDump()`，供未来复现时快速打印。

## 8. 与既有文档 / 未决事项的接驳

- 与 `2026-04-18-ready-agent-runtime-realignment-second-round-audit.md` §3.2 continuation regex 缺口合并 → Phase Ω3。
- 与 `2026-04-18-ready-agent-info-card-modification-gap-audit.md` (P0–P3) **不冲突**：那份治的是 "卡片根本没生成" 的 schema 路径，本份治的是 "卡片能生成但跨轮超时/串台" 的运行时路径。
- 本文件只登记缺口；**不创建 CHANGELOG / PROGRESS 条目**，等 Phase Ω0 第一次 commit 时再补。
- 后续 remediation commit plan 建议单独写成 `2026-04-19-...-remediation-plan.md`（按 Phase Ω0/Ω1/Ω2/Ω3/Ω4 分 commit），不要与本 audit 合并。

## 9. 决策检查清单（给下一步修复者）

开动前先回答：

1. 把 renderer queue 从单链拆成 per-scope 的那一刻，需要决定"未绑定 scope 的请求"走独立队列 vs 共享队列 — 目前倾向独立队列（避免回归到全局串行）。
2. cache key 加 widgetId 之后，是否需要继续保留 "shared `documentWidgetDraftCache`" 这一层？若保留，需明确 TTL；若不保留，删除并仅保留 `sessionWidgetDraftCaches`。
3. attachment 每轮重取 widgetCode 的代价（需要读磁盘/store），是否要放在 debounce 里做；是否需要一个 "用户明确不带 widget 上下文" 的退出键（比如附件关闭按钮）。
4. tiptap commit ack 改造会影响现有 `TiptapEditor.tsx` / `note-preview-parser.ts`（git status 里都 M），需要确认是否与 codex 分支上的其它改动兼容。

---

_该 audit 不落代码修改。后续 remediation plan 与 commits 请按 §7 的 Ω0→Ω4 顺序推进，每期落地前先补实验（§6 R1–R5）。_
