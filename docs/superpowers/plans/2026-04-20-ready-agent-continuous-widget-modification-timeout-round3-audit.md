# 2026-04-20 · 连续改 widget 超时 Round-3 审计

> 基线：`f57cc85 fix(agent): add widget edit lease so meta-correction follow-ups stay on pipeline`（widget-edit-lease 落地之后）。
> 症状：再次优化后仍出现 `renderer-watchdog:*` / `Timed out waiting for renderer tool action result: ${tool}` 类超时；连续两轮 widget 修改在 lease 过期或非 pipeline 路径上会复现。
> 目标：对 round2（G-Z1..G-Z12）给出「已修 / 半修 / 未修」证据，并补齐 widget-edit-lease + widget v0.1 之后出现的新缺口，形成完整修改计划。

---

## 1. G-Z1..G-Z12 状态核对（按文件:行号取证）

| 代号 | 概述 | 现状 | 证据 |
| --- | --- | --- | --- |
| G-Z1 | 送新消息时取消旧 tool action | ✅ FIXED | `direct-chat.ts:725` 送信抢占处先调 `cancelPendingToolActions?.(name, sessionId)` 再 abort；`ipc-handler.ts:111-128` 实现 `cancelToolActionRequestsBySession`，并在 `setCancelPendingToolActions` (L159)、`agent:newSession` (L222)、`agent:kill` (L236) 挂接。 |
| G-Z2 | Renderer 队列里的抢占竞态 | ❌ OPEN | `runtimeDriver.ts:582` 同步写入 `{settled:false, abort: no-op}` 到 `activeToolRequests`；真正的 `abort` 只在 `runWithWatchdog` 进入后 (L535-540) 绑到 `cancelPromise`。在 prev 队列未 resolve 的窗口内，cancel IPC 触发的 `entry.abort()` 调到 no-op，`settled` 仍为 false。随后 `runWithWatchdog` 入口的早结算检查 (L502-503) 仅看 `existing?.settled`，结果判为「未结算」，继续执行已被取消的工作。 |
| G-Z3 | pipeline executor 吞掉 signal | ✅ FIXED | `document-task-pipeline-executor.ts` `writeDocumentWidget` (L1042-1043)、`verifyDocumentTaskPlanWrite` (L1107-1108)、`saveTab` (L1450-1458) 等关键入口改为 `throwIfAborted + wrapToolCall`，旧的 `void params.signal` 写法已清除。 |
| G-Z4 | tiptap widget update 缺 ack | ❌ OPEN | 仍依赖 `raceWithTimeout(runUpdate(), 15_000)` 兜底；编辑器 commit 完成并没有向 main 回写结构化事件。`MarkdownEditor.tsx` 内改动是本地 state / prosemirror transaction 层面，没有 IPC 确认。 |
| G-Z5 | doc.* tool 超时保护 | 🟡 PARTIAL | `documentActions.ts:1280` 的 `update_widget`（15s）、`1232` `compile_widget_spec`（10s）已包裹；但 `list_widgets (1159-1182)`、`insert_widget (1131-1157)`、`remove_widget (1292+)`、`set_content / append_content (1103-1129)`、`open_tab (1070-1084)` 仍只吃队列侧 120s watchdog，主进程 pipeline 侧本轮新增的 `document.saveTab` / `document.listWidgets` `raceWithTimeout` 已有，但 renderer 侧对应分支仍无本地超时。 |
| G-Z6 | widget 草稿缓存按 widgetId 清理 | ❌ OPEN | 仍只有 `deleteCachedWidgetDraft(singleKey)`，在 executor 1389 / 1427 / 1893 逐点删除。没有 `deleteCachedWidgetDraftsByWidgetId` 或按 `targetWidgetId` 遍历的清理器，于是改同一个 widget 的第 N 次请求如命中上一轮已固化的缓存，就会拿到过期草稿再次下发写入。 |
| G-Z7 | 缓存 key 按 target 内容 hash | ✅ FIXED | `document-task-cache-key.ts:42-44` 已改为 `binding.role === 'target_document' ? hashText(params.targetSnapshot?.content ?? binding.resource.text ?? '') : hashText(binding.resource.text)`。 |
| G-Z8 | messageComposer 对 widget 启发式过宽 | ❌ OPEN | `messageComposer.ts:21` 仍是 `/(widget|show-widget|文档|卡片|图表|组件|章节|正文|段落)/`；仅扩了 meta-correction 关键词 (L22/L31)。词典层面没有收敛：用户说「正文」「段落」依旧触发 widget 附件注入。 |
| G-Z9 | 队列幂等性 | ❌ OPEN | `runtimeDriver.ts:582` 无条件覆盖同 requestId 的 entry；没有 `if (activeToolRequests.has(requestId)) return` 的幂等保护，若同一 requestId 被 dispatch 两次（抢占重试 / IPC 重放）会丢掉前一个的 abort 句柄。 |
| G-Z10 | payload 缺 scopeId | ❌ OPEN | `ipc-handler.ts:152-155` `webContents.send('agent:toolActionRequest', { requestId, ...payload })`，payload 仍只有 `{agent, sessionId, runId, tool, args}`。renderer 端通过 `resolveScopeIdForRunPayload` 反查，若 scope run 已被切掉就只能报 `Scope run not found`。 |
| G-Z11 | tiptap commit 事件 | ❌ OPEN | 与 G-Z4 同源；`MarkdownEditor.tsx` 没有向外广播 widget-updated 事件，pipeline 的「成功」依据仍是 IPC 返回而非编辑器真实落地。 |
| G-Z12 | renderer 队列日志接入 ready-tools.log | 🟡 PARTIAL | browser 侧工具走 `ready-tools.log`；`runtimeDriver.ts` 队列 dispatch / watchdog / cancel 仍只发 `logAgentMetric`，无法在 ready-tools.log 里按时间线看到「入队 → 执行 → 结算」的线索。 |

---

## 2. Widget-Edit-Lease + widget v0.1 引入的新缺口

### NEW-1 · Lease TTL 绝对 120s，刷新仅挂在 pipeline 写入
- `widget-edit-lease.ts:20` `DEFAULT_TTL_MS = 120_000`，`acquire` 直接 `now + ttl`，没有滑动过期。
- 续期路径只有两处：
  1. `document-task-pipeline-executor.ts:2051-2061`（envelope 已经带 widget_target 时续）。
  2. `document-task-pipeline-executor.ts:2196-2205`（pipeline 真正执行 write/locate 成功时续）。
- 若用户一次对话间隔 > 120s，或中间有一轮被 `intent_context` 判成 `direct_answer` / `browser_workflow` / 纯 read，没有跑 pipeline write → lease 永远不会刷新 → 过期后 envelope 又缺 widget_target → sticky 路径失效 → 回到 round2 前那条「free tool loop + 45s provider 超时」的回归路径。
- 这是 round3 真正的新增回归入口：lease 没修复超时，只是把符合条件的一路挪到了 pipeline。

### NEW-2 · `session.lastDocumentContextInput` 与 forceDocumentTool 绑定，与 lease 兜底不对称
- `turn-engine.ts:505-508`：
  ```ts
  let toolPolicy = preparedRunCapabilities.toolPolicy
  if ((toolPolicy as any).forceDocumentTool) {
    session.lastDocumentContextInput = contextualUserInput
  }
  ```
- `execution-intent-resolver.ts:60-63` 里 lease 承担的是「即使 envelope 没 widget_target，也置 hasWidgetTargetContext=true」。但是 `forceDocumentTool` 的真值由 policy 计算，在 lease-only（非 envelope）分支上不保证为 true，于是 `lastDocumentContextInput` 不会被保存。
- 下一轮若用户只发一句「再把 KPI 改蓝一点」之类短语：
  - lease 已过期 → envelope 无 widget_target → intent-resolver 无 sticky → pipeline 不进入 → 回落到裸 tool loop。
  - 由于上一轮 `lastDocumentContextInput` 是空的，回放链也拿不回上下文。
- 结果：看似 lease 覆盖了连续修改，实际上存在「本轮走 lease-sticky 成功，下一轮无可回放」的双保险缺口。

### NEW-3 · Executor 从 lease 合成的 envelopeWidgetTarget 文本为空
- `document-task-pipeline-executor.ts:2024-2041` 当 envelope 没有真 widget_target 但 lease 存在时，合成一个 synthetic resource：`text: ''`, `summary: null`, `order: 0`。
- 下游 `document-task-cache-key.ts` 在 role=`target_document` 分支用 `params.targetSnapshot?.content ?? binding.resource.text ?? ''`，但非 target 角色仍然落到 `hashText(binding.resource.text)` = 空串 hash。
- 同一 widget 的多次「只 lease 合成、没有 envelope 真 target」会命中同一 cache key，导致 round2 已修的 G-Z7 在 lease 合成路径下仍然会退化为「按 widgetId 命中同一缓存」，等效复发 G-Z6 症状。

### NEW-4 · Cancel-IPC 丢 payload 时 renderer 无自救
- `ipc-handler.ts` 中 cancel 通知带 `cancelled ids` 数组；若 renderer 在重载过程中漏收该 IPC（例如 workbench HMR / mode switch），`activeToolRequests` 里的 entry 永远不会进入 settled 状态，但 main 已经把它从 pending 表中拿掉。后续 `completeToolActionRequest(requestId)` 的 ack 就会变成 no-op → watchdog 仍会照常触发，主进程再次感知为 renderer 超时。缺少的是 renderer 自身的「TTL 扫描器」：当 entry 在队列里排队 > cancelBudget 仍未执行，应主动 abort 并回写 `handled:false, cancelled`。

### NEW-5 · widget v0.1 skeleton arbitrate 在 locate 阶段的命中代价
- `arbitrateSkeletonForUserText` 被放在渲染端与 pipeline 两侧都跑；pipeline executor 的 locate 分支会再次调用，且对未命中关键词的 H1/H2 做降级。
- 问题：该函数在 locate 阶段是同步 CPU 开销，但 `document-task-pipeline-host-contract.test.ts` 当前期望它不在 locate 路径运行（测试里期望只 query + compare）。如果出现「先降级 → 再重跑 compose」的二次触发，locate 本身就会把耗时从 ~200ms 抬到 ~700ms+；在 15s 硬超时下尚有余量，但叠加 NEW-4 的 renderer 队列排队，就是最后触发 `renderer-watchdog:15000` 的临门一脚。建议在 locate 阶段跳过 arbitrate、仅 compose 路径执行。

---

## 3. 静态契约测试漂移清单（非运行期缺口，但挡 CI）

这四项仅是测试断言与实现漂移，**不会**改变运行时行为，修复排在 P3：

1. `document-tool-session-context`：断言 `session.lastDocumentContextInput = contextualUserInput` + `toolLoopSession = toolGuidance ? {...session, ...} : session` 位于 `direct-chat.ts`；实际已搬到 `turn-engine.ts:506-508`。
2. `tool-executor-guard`：正则仍锁 `executorAllowedToolNames ||`；实际改成了 `selectedDomainPrepareResult?.allowedToolNames || reconciledRunCapabilities.allowedToolNames`（`turn-engine.ts:696`）。
3. `pipeline.update.includes-existing-widget-in-prompt` 子用例 2：期望 serialize 里有 `widgetCode: this.clipWidgetCodeForPrompt`；当前改为输出 `{id, index, title, mode, component, hasComponentSpec, canPatch}` 结构化 summary。
4. `stores.useAgent` 子用例 18：mock `sendRuntimeMessage` 捕获从「scopeId 字符串」改为「`{scopeId, message, requestId, continuationIntent}` 对象」。

---

## 4. 分级修复计划

> 按「是否直接导致超时」排序，P0 必须随下一轮补丁一起落。

### P0 — 直接消除运行期超时复发路径
1. **NEW-1 Lease 滑动刷新**：每次 intent-resolver 判定 `leaseStickyEligible=true` 即顺手 `acquire`（不需等 pipeline 执行完），并把 TTL 增量到「上次 acquire + 30s」或「再 120s」中较大者。同时在 `direct-chat.ts` 送信抢占成功时做一次 lease 健康探测，若 `expireAt - now < 30_000` 则主动刷新。
2. **G-Z2 Renderer 抢占竞态**：`runtimeDriver.ts:582` 同步注入的 entry 要携带可用的 `abort`——把 `cancelPromise` 的 resolver 在 onToolActionRequest 分支里预先创建并注入，`runWithWatchdog` 复用这个 resolver，而不是再创建新的。同时 `runWithWatchdog` 入口改为 `existing?.cancelled === true → 直接 complete(handled:false, 'cancelled')`。
3. **NEW-2 lastDocumentContextInput 对齐 lease**：取消 `forceDocumentTool` 的硬绑定，改为「`hasWidgetTargetContext || forceDocumentTool → 保存 contextualUserInput`」，保证 lease-sticky 一旦命中就一并写入回放上下文。
4. **NEW-3 合成 envelope text 补真文本**：从 lease snapshot 额外携带 widget 最新的 textSnippet / componentSpec 摘要（需在 `acquireWidgetEditLease` 时由 pipeline 提供，或在 resolver 处基于 tabId 反查 document-engine 的最新 snapshot），避免合成路径缓存碰撞。
5. **G-Z5 覆盖剩余 doc actions**：在 `documentActions.ts` 给 `list_widgets / insert_widget / remove_widget / set_content / append_content / open_tab` 全部套 `raceWithTimeout` + `throwIfAborted`，超时预算参考 `getDocumentToolTimeout`。

### P1 — 提升可观测性与幂等性
6. **G-Z4 / G-Z11 tiptap commit ack**：`MarkdownEditor.tsx` widget 写入成功时向 main 广播 `document:widgetCommitted { tabId, widgetId, reqId }`，pipeline executor 的 write 步骤从等 tool-action IPC ack 改为等 commit 事件（或 race commit + ack 以兼容旧入口）。
7. **G-Z6 按 widgetId 批量失效草稿缓存**：在 widget-cache 模块里加 `deleteCachedWidgetDraftsByWidgetId(widgetId)`，在 executor 成功 write/locate、以及 NEW-1 滑动刷新的同一时刻触发。
8. **G-Z10 payload 注入 scopeId**：`ipc-handler.ts` 发 `agent:toolActionRequest` 时带上 `scopeId`，renderer 直接信任字段，把 `resolveScopeIdForRunPayload` 的反查降级为 fallback。
9. **NEW-4 Renderer 队列自救 TTL**：为每个排队中的 entry 再加一个「入队最大停留 Ns，超则自动 cancel + ack」。
10. **G-Z9 队列幂等**：`activeToolRequests.set` 改为 `if (!activeToolRequests.has(requestId)) set else return`，防止重入覆盖。

### P2 — 边界收敛
11. **G-Z8 messageComposer 关键词收敛**：把「章节 / 正文 / 段落」从默认 widget 触发词剥离，转为「章节：+ widget/卡片/组件/图表」共现才命中；完全脱离字面 widget 词需要依托 lease sticky 而非此处扩张。
12. **NEW-5 locate 分支跳过 arbitrate**：pipeline executor 在 locate 分支直接复用 compose 前的 skeleton 结果，避免二次 arbitrate。

### P3 — CI / 日志
13. **G-Z12 ready-tools.log**：把 runtimeDriver 的 dispatch/ack/cancel 事件追加写入 ready-tools.log；保证每一次 `renderer-watchdog:*` 都能对应一条入队时间戳。
14. **静态契约测试漂移**：按第 3 节 4 项逐条同步到现有实现的新位置。

---

## 5. 验证口径（落地后必须跑）

- `npm run typecheck`
- `npm run test -- widget` 与 `document-task-pipeline-host-contract` / `subtask-runtime-contract` / `stores` 三组合
- 手工：同一 widget 连续 4 轮修改；每两轮之间停留 150s，验证 lease 过期后仍能回到 pipeline、且不再出现 `renderer-watchdog:*`。
- 工具日志：`ready-tools.log` 应出现 `agent:toolActionRequest dispatched → executed → ack`，或 `cancelled`，不能出现「只 dispatched 无后续」的孤儿。

---

## 6. 引用位置索引（便于评审回看）

- `src/main/modules/claude-bridge/direct-chat.ts:725` — 抢占取消
- `src/main/modules/claude-bridge/ipc-handler.ts:111-128`、`152-155`、`222`、`236` — cancel + payload + 会话钩子
- `src/main/modules/agent-control/turn-engine.ts:427-434`、`505-508`、`696` — lease 接入 / contextInput 条件 / routedAllowedToolNames
- `src/main/modules/agent-control/execution-intent-resolver.ts:60-63`、`80` — sticky 判定 + 诊断
- `src/main/modules/agent-control/document-task-pipeline-executor.ts:2021-2061`、`2188-2208`、`1042-1043`、`1107-1108`、`1450-1458` — lease 合成 / 续期 / signal
- `src/main/modules/agent-control/widget-edit-lease.ts:20`、`29-43`、`45-54` — TTL 常量与 acquire/resolve
- `src/main/modules/agent-control/document-task-cache-key.ts:42-44` — target content hash
- `src/renderer/modules/agent/runtimeDriver.ts:495-577`、`580-590`、`650-663` — 队列 / cancel / epoch
- `src/renderer/modules/agent/documentActions.ts:1070-1310` — doc.* 工具各分支
- `src/renderer/modules/agent/messageComposer.ts:21-33` — widget 启发式

---

## 7. 落地状态（2026-04-21 更新）

P0 + P1 + P2 + P3 全部落地：

| 项目 | 状态 | 关键改动 |
| --- | --- | --- |
| P0-1 Lease 滑动 TTL + 健康刷新 | ✅ applied | `widget-edit-lease.ts` 新增 `refresh`；`execution-intent-resolver` lease-sticky 命中时滑动续期并在 `intent_context` metric 中带 `leaseRefreshed`；`direct-chat.sendMessage` 抢占后探测 lease 余量 <30s 主动续 120s。 |
| P0-2 Renderer 队列抢占竞态 | ✅ applied | `runtimeDriver.ts` entry 扩为 `{settled, cancelled, abort, queuedAt}`；cancel IPC 真正置 `cancelled=true`；`runWithWatchdog` 入口检查 `cancelled || queuedTooLong` 直接 complete(handled:false)。 |
| P0-3 lastDocumentContextInput 对齐 lease | ✅ applied | `turn-engine.ts:505-508` 改为 `forceDocumentTool \|\| hasWidgetTargetContext → 保存`；静态契约测试同步到 turn-engine。 |
| P0-4 合成 envelope 补真文本 | ✅ applied | `ActiveWidgetEditLease` 新增 `widgetFingerprint / widgetTextSample`；pipeline executor 在 acquire 时基于 `componentSpec / widgetCode` 计算 hash + 样本；合成 envelope 与 cache-key 读取新字段。 |
| P0-5 剩余 doc.* 异步路径超时 | ✅ applied | `documentActions.ts` 的 `open_tab.load` 与 `insert_widget.compile` 包裹 `raceWithTimeout(10_000)`；同步分支保持原样并加注释。 |
| P1-1 tiptap commit ack | ✅ applied | 新增 `document-commit-registry.ts` 单例；`document:widgetCommitted` IPC 通道贯通 preload → ipc-handler；`writeDocumentWidget` update 分支成功后 `waitForCommitAfter(10s)`，超时仅 warn 不阻塞。 |
| P1-2 按 widgetId 批量失效缓存 | ✅ applied | `document-task-pipeline-executor` 新增 `deleteCachedWidgetDraftsByWidgetId`；write 成功后按 `targetWidgetId` 清理上一轮草稿。 |
| P1-3 payload 携带 scopeId | ✅ applied | `claude-bridge/ipc-handler.ts:152+` `webContents.send('agent:toolActionRequest', { requestId, scopeId: sessionId \|\| undefined, ...payload })`；`runtimeDriver.resolveScopeIdForRunPayload` 优先读 payload 字段。 |
| P1-4 Renderer 队列自救 TTL | ✅ applied | `QUEUE_SELF_RESCUE_MS = 180_000`；`runWithWatchdog` 入口以 `queuedAt` 判定排队过久 → 走 `queue-self-rescue` 分支 complete。 |
| P1-5 队列幂等 | ✅ applied | `onToolActionRequest` 在 `activeToolRequests.has(requestId)` 时直接 return，并 `logAgentMetric('tool_request_duplicate', ...)`。 |
| P2-1 messageComposer widget 启发式收敛（G-Z8） | ✅ applied | `messageComposer.ts:21` `hasWidgetSubject` 收敛为 `/(widget\|show-widget\|卡片\|信息卡\|图表\|组件)/i`，剥离「文档/章节/正文/段落」歧义词；新 `messageComposer-widget-subject.test.ts` 锁定 5 条场景。 |
| P2-2 NEW-5 回归锁定 | ✅ applied | 新 `pipeline-locate-skips-arbitrate.test.ts` 断言 `document-task-pipeline-executor.ts` 不再直接调用 `arbitrateSkeletonForUserText`，共享层定义保持 export。调研确认当前代码已无运行期调用，只补静态守护。 |
| P3-1 runtimeDriver 事件接入 ready-tools.log（G-Z12） | ✅ applied | 新 `tool-event-log.ts` helper + `ipcMain.on('tools:logToolEvent')` 监听；preload 暴露 `electronAPI.tools.logToolEvent`；`runtimeDriver.ts` 在 dispatch / duplicate / self-rescue / watchdog / cancel / ack 6 个节点打点；新 `runtimeDriver-tool-event-log.test.ts` 锁定 6 点 + preload/ipc 线路。 |
| P3-2 静态契约测试漂移同步 | ✅ applied | `tool-executor-guard.test.ts:22` 改为 `selectedDomainPrepareResult?.allowedToolNames`；`pipeline.update.includes-existing-widget-in-prompt.test.ts` 放宽 serialize 正则并新增 component/canPatch 正向断言；`stores.test.ts` retry-once 改读 `sendScopedCalls.map(c => c.scopeId)` 并校验 message/requestId；`document-widget-target-context.test.ts:162` 拆成 `envelopeHasWidgetTarget` + `hasWidgetTargetContext = envelopeHasWidgetTarget \|\| leaseStickyEligible` 两条断言。 |

验证：
- `npm run typecheck` 通过（node + web 两套）。
- 目标测试：`messageComposer-widget-subject` / `pipeline-locate-skips-arbitrate` / `runtimeDriver-tool-event-log` / `tool-executor-guard` / `pipeline.update.includes-existing-widget-in-prompt` / `document-widget-target-context` / `stores` 合计 123 条全绿。
- `npm run test` 全量：1111 pass / 20 fail（较 P1 落地后 28 fail 下降 8 条）；剩余 20 条均为 UI shell / browser 启动契约与 `window is not defined` 预置环境问题，不在本轮 P2/P3 范围。
