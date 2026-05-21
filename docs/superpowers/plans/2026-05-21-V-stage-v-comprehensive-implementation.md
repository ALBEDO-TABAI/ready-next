---
name: V-stage-v-comprehensive-implementation
stage: V
date: 2026-05-21
status: implementation
parent: 2026-05-20-U-release-readiness-implementation.md
enforce: true
locked_at: 2026-05-21
locked_after_codex_rounds: 10
---

# Stage V — Comprehensive Plan (LOCKED v10, implementation)

> **Convergence trajectory** (codex review rounds): r1=7 → r2=4 → r3=3 → r4=4 → r5=3 → r6=3 → r7=1 → r8=1 → r9=1 → r10=0 → **LOCK**

承接 Stage U Phase 5/6 v2 已落地的 20 PR（目录拆分 + barrel + gate 加强）。
本计划合并 codex round-2 标记为 deferable 的高风险工作 + 用户新增的「多会话并发」底子。

**Draft v5 修订说明**：v4 修了 round-3 的 3 blockers；codex round-4 又标出 4 个窄 must-fix：
(1) shell target 在 §2 模块表 / §12 Q1 仍写 ≤ 800，与 §2 rationale + R20 的 ≤ 1000 不一致；
(2) V1.9a 行段不完整——漏 state 声明 (2319, 2327-2334) + detach (2559-2587) + effect wiring (3121-3136, 3250-3283)；
(3) V3.3d drop 规则太死——存在合法 `null sessionId + 有 conversationId` 的 persisted card 会被误丢，应用 conversationId fallback；
(4) V5 scanner pattern `event.sender.send` 不匹配真实 `session.sender.send`；`sendToRenderer` 是成员调用 (`controller.sendToRenderer` / `this.host.sendToRenderer`)，需匹配 `*.sendToRenderer(`。
v5 patch §2 target reconcile + V1.9a 范围补全；§4 V3.3d conversationId fallback；§6 scanner pattern。round-4 findings 汇总于 §13。

## 0. 范围与硬约束

### 范围
- V1 ChatPanel.tsx 4675 LOC 拆分（**v2 修订**：基于实际剩余 5 个内置组件）
- V2 IPC handler 拆分（claude-bridge 1970 LOC / 76 channels 实测；rss 1932 / 25；document 1326 / 26）
- V3 多会话并发底子（1-3 并行 session，**v2 修订**：blocker 是 renderer store + module-global timers，不是 AgentSessionManager）
- V4 Verify-chain slim（U6.1/U6.2 顺延）
- V5 IPC contract gate（**v3 修订**：三类合同 diff——INVOKE / SEND/ON / PUSH 三种 channel 方向各自配对）
- V6 ChatPanel fixture infra 复盘 U5.3-prep

### 硬约束（继承 Stage U）
- never push to remote / never `--no-verify` / never force-push
- 不做大规模 history rewrite；fix-forward only
- 每个 staging 操作前 `git reset HEAD >/dev/null`，再 `git add <显式文件>`
- commit 用 `git -c user.email=101425723+ALBEDO-TABAI@users.noreply.github.com -c user.name=白`
- commit message 末尾追加 `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

### WIP 现状（v2 实测）
turn-engine.ts / Settings.tsx / map-domain-adapter.ts / execution-intent-resolver.ts /
task-execution-router.ts / Fastcard.tsx **当前 working tree clean**（map 作者 4073695e 已落地）。
原 Stage U 约束的 dirty WIP 已沉淀；本期可以正常 touch 这些文件，但仍遵循「只做当前目标需要的最小改动」。

## 1. 现状盘点（v2 重新核对）

| 区域 | 文件 | 实测 LOC | 实测规模 |
| --- | --- | --- | --- |
| ChatPanel shell | `src/renderer/components/agent/ChatPanel.tsx` | 4675 | 已抽出 5 个 sibling 组件（见 §2）；剩余是 5 个内联组件 + helpers |
| ipc-handler (agent) | `src/main/modules/claude-bridge/ipc-handler.ts` | 1970 | **76** 个 `ipcMain.handle/on`（修正 round-1） |
| direct-chat | `src/main/modules/claude-bridge/direct-chat.ts` | 1761 | turn engine 调度入口；本期不动 |
| ipc-handler (rss) | `src/main/modules/rss-engine/ipc-handler.ts` | 1932 | **25** 个 handler |
| ipc-handler (document) | `src/main/modules/document-engine/ipc-handler.ts` | 1326 | 26 个 handler |
| ipc-handler (browser) | `src/main/modules/browser-engine/ipc-handler.ts` | 1415 | service-based，不在本期 |
| AgentSessionManager | `agent-control/session/session-manager.ts` | 41 | `tasks` Map 单 key；调用方 `runtime-core/orchestrator.ts:451` 用 `toTaskKey(agent, sessionId)` 已 composite |
| useAgent | `src/renderer/stores/useAgent.ts` | 1812 | **顶层 flat state** + **模块级 `pendingSendTimer`/`pendingSendBuffer`**（L211-220） |
| ChatPanel 已有 siblings | `agent/{ChatHeader,ChatMessages,ChatInput,SoftFailureCapsule,ChatAttachments}.tsx` | 578/690/123/?/? | round-1 codex 已确认抽离 |
| useAgent 直接消费者 | `App.tsx` + `ReadyMode.tsx` + 5 个 ready/* + 4 个 agent/* + 3 个 modules/* | — | 全店订阅大户：ChatPanel / TaskPanel / MeetingChat |

## 2. V1 — ChatPanel 拆分（v2 全面重写）

### v1 错误 + v2 修订
v1 列了 markdown / task / recall / 附件 / shell / composer 5 个模块——其中
recall / 附件 / composer 等价的 ChatHeader / ChatMessages / ChatInput / SoftFailureCapsule /
ChatAttachments **已经存在**为 sibling 文件（`ChatPanel.tsx:86-90` import）。v1 的目标
完全没看清现状。v2 基于实际 ChatPanel.tsx 内部剩余的内联组件 + helpers 重写。

### v2 实际拆分目标
ChatPanel.tsx 当前结构（实测）：
| 区段 | 行范围 | LOC | 内容 |
| --- | --- | --- | --- |
| imports + types | 1-185 | 185 | 不动 |
| projection helpers | 187-401 | 215 | 内联工具函数（待抽离到 helpers） |
| markdown parser | 404-575 | 172 | `parseMarkdown` + table 解析 |
| inline renderer | 581-624 | 44 | `renderInline` |
| `MarkdownContent` | 626-753 | 128 | 内联 React 组件 |
| badge/visibility | 755-863 | 109 | helpers |
| **`TaskCard`** | 865-1446 | **582** | 最大内联组件 |
| `ToolTraceCard` | 1447-1563 | 117 | 子组件 |
| `ChatPanelMotionLayer` | 1564-1625 | 62 | 布局 |
| `CollapsedChatRail` | 1626-1679 | 54 | 布局 |
| **`ModelSelector`** | 1684-2016 | **333** | 大下拉选择器 |
| `AttachmentIcon` + attachment helpers | 2021-2265 | 245 | 附件预览相关 |
| ChatPanel 主 shell | 2266-4675 | 2410 | 主组件 + zustand subscribe + handlers |

### 拆分模块（v3 — 修订 shell target 可达性）

v2 把 shell target 设 ≤ 1500 LOC 不可达——主 shell L2266-4675 内仍有大块逻辑（store
destructure 2266-2306、task-run merging 2589-2842、task/tool snapshot rendering 3576-3825、
attachment preview modal 4507-4675）。v3 把这些都列为 explicit 抽离对象，shell target 改 ≤ **1000 LOC**（v5 reconcile，v6 修正本行最后残留的 ≤800 stale 文本）。

| 模块 | 路径 | 包含 | 预估 LOC |
| --- | --- | --- | --- |
| `chat-panel/markdown/index.tsx` | parser + renderInline + `MarkdownContent` | 404-753 | ~350 |
| `chat-panel/task/TaskCard.tsx` | `TaskCard` + `ToolTraceCard` | 865-1563 | ~700 |
| `chat-panel/model-selector/ModelSelector.tsx` | `ModelSelector` (仅 useSettings + useNavigate，**无 IPC**) | 1684-2016 | ~333 |
| `chat-panel/layout/MotionLayer.tsx` | `ChatPanelMotionLayer` + `CollapsedChatRail` | 1564-1679 | ~120 |
| `chat-panel/attachments-preview/index.tsx` | `AttachmentIcon` + preview helpers + **attachment preview modal** | 2021-2265 + 4507-4675 | ~410 |
| `chat-panel/helpers/projection.ts` + `chat-panel/helpers/badges.ts` | projection / badge / visibility 纯函数 helpers | 187-401 + 755-863 | ~325 |
| `chat-panel/task-merge/use-task-run-merge.ts` | **task-run merging hook**（v3）——纯 `useMemo` 派生（codex round-3 确认 pure） | 2589-2842 抽 hook | ~250 |
| `chat-panel/task-snapshot/TaskToolSnapshot.tsx` | **task/tool snapshot 子组件**（v4 修订标签——含 JSX，**TSX 子组件**而非 hook） | 3576-3846 抽组件 | ~270 |
| `chat-panel/recall-state/use-channel-session-recall.ts` | V1.9a：channel + session-recall state 和 callbacks。Hook **必须 return**（v7 完整列）：`selectedChannelKey` (2429)、`filteredScopes` (2453)、`currentAgentData` (used at 4443-4444)、`currentChannel`、`channelOptions`（v7 新增，原 channelEffects 内部字段提到顶层 return）、`recallState`、`detachCallback`、`channelEffects` 其余 handle；gap 2421-2468 absorbed into hook | 2319 + 2327-2334 + 2341-2468 (含 gap) + 2469-2587 + 3121-3136 + 3250-3283 | ~310 |
| `chat-panel/drag-drop/use-attachment-intake.ts` | V1.9b：drag/drop 附件接入 hook | 3848-4141 | ~290 |
| `chat-panel/task-interaction/use-task-interaction-handlers.ts` | V1.9c：task interaction handlers | 3285-3574 | ~290 |
| ChatPanel.tsx (shell after) | 主 shell + store subscribe + 顶层布局 + props 串联 | 剩余 | **目标 ≤ 1000 LOC**（v5 reconcile：模块表 / 开放问题 / R20 三处统一） |

**V1.9 系列必须做**（v5 修订）：v3 把 shell target 设 ≤ 800 但只列了 V1.7/V1.8 + preview modal 抽离（共 ~690 LOC），剩余 ~1720 仍超目标。v4 commit V1.9a/b/c 三段抽离（codex round-3 行段）；v5 进一步把 V1.9a 范围扩到 codex round-4 指出的完整闭包（state + detach + wiring，~280 LOC 而非 ~170）。总抽 ≈ 1560 LOC，shell 剩 ≈ 850-880 LOC。**target 锁定为 ≤ 1000 LOC**（含新增 import + hook call 行）。若执行后超 1000，加 V1.10 兜底抽离（候选：顶层 layout helpers）。

### 拆分序列（v3）
1. **V1.0 fixture 基建**：4 个 semantic case（empty / streaming / tool_running / task-card），
   jsdom + createRoot + flushSync；mount 当前 ChatPanel 作为 baseline snapshot
2. **V1.1 helpers** 抽到 `chat-panel/helpers/{projection,badges}.ts`（纯函数，零 React，
   **constraint**：不接受 sessionId-shape props——纯数据 in/out，确保 V3.3a 之前可做）
3. **V1.2 markdown 模块**（纯 React 函数组件，零 useAgent 依赖）
4. **V1.3 layout 模块**（MotionLayer + CollapsedChatRail，几乎无状态）
5. **V1.4 attachments-preview 模块**（含 preview modal 抽离）
6. **V1.5 ModelSelector 模块**（仅 useSettings + useNavigate，本期不动 IPC 形态）
7. **V1.6 TaskCard + ToolTraceCard 模块**（最复杂——内部含大量 projection 状态；接受 sessionId prop）
8. **V1.7 task-merge hook** 抽 `use-task-run-merge`（v3——pure `useMemo`）
9. **V1.8 task-snapshot TSX 子组件** 抽 `TaskToolSnapshot.tsx`（v4 修订——含 JSX，是组件不是 hook）
10. **V1.9a channel/recall hook** 抽 `use-channel-session-recall`（2341-2420 + 2469-2557）
11. **V1.9b drag/drop hook** 抽 `use-attachment-intake`（3848-4141）
12. **V1.9c task interaction hook** 抽 `use-task-interaction-handlers`（3285-3574）

### Gate
- 每步：`npm run typecheck` + 既有 ui-contracts/* + V1.0 fixture snapshot diff = 0
- 移动文件走 R100 path-only；任何行为变更必须独立 PR + 行为测试

### 风险与缓解
- **R1 (高)**：TaskCard 582 LOC 内部使用 ChatPanel scope 内的 state。**缓解**：先把它 props 化
  （所有依赖的 store value/handler 走 props），再剪去
- **R2 (中)**：fixture snapshot 误锁 ARIA / class 微差。**缓解**：snapshot 只 lock 语义节点结构 +
  关键文本，不锁 class 字符串
- **R3a (中)**：task-merge hook 抽离时 state 状态机时序可能漏。**缓解**：抽离前先加行为测试 lock
  现有 merge 顺序，diff = 0 验证

## 3. V2 — IPC handler 拆分（v2 重写，基于实测 76 channels）

### 共同骨架（V2.0 deps-injection skeleton）
```typescript
// src/main/modules/<engine>/ipc/types.ts
export interface IpcChannelGroup<Deps> {
  readonly namespace: string
  register(ipcMain: IpcMain, deps: Deps): IpcDisposeHandle
}

// src/main/modules/<engine>/ipc-handler.ts
export function registerEngineIpc(ipcMain: IpcMain, deps: EngineDeps): IpcDisposeHandle {
  const groups: IpcChannelGroup<EngineDeps>[] = [/* 各 group */]
  const disposes = groups.map(g => g.register(ipcMain, deps))
  return { dispose: () => disposes.forEach(d => d.dispose()) }
}
```

### V2.1 claude-bridge 拆分（76 channels → **15 groups**，v2 修订）

v1 列 8 groups 漏掉了 channel/login (8) + schedule (6) + chat persistence (8) +
memory (8) + trigger (4) = 漏了 34 channels。v2 全量覆盖：

| Group | 文件 | 包含 channel | 估 LOC |
| --- | --- | --- | --- |
| AskUserGroup | `ipc/ask-user-group.ts` | `skills:askUser:*` + `agent:askUserQuestions:*` (5 ch) | ~200 |
| ToolEventGroup | `ipc/tool-event-group.ts` | `tools:logToolEvent` + `agent:completeToolActionRequest` | ~60 |
| AgentLifecycleGroup | `ipc/agent-lifecycle-group.ts` | `agent:send/newSession/kill/sendScoped` | ~180 |
| AgentRuntimeGroup | `ipc/agent-runtime-group.ts` | `agent:getRuntimeStatus/getCapabilityRuntimeSnapshot/listChannels` | ~80 |
| ConversationGroup | `ipc/conversation-group.ts` | `agent:listConversationScopes/listScopeRuns/getConversationScopeMessages/createLocalScope/listScopeAttachments/getScopeAttachment/clearRemoteAttachmentCache/getRemoteAttachmentCacheStats` (8 ch) | ~250 |
| TaskProjectionGroup | `ipc/task-projection-group.ts` | `agent:listTaskProjections/getTaskProjection` | ~100 |
| RecallGroup | `ipc/recall-group.ts` | `agent:searchSessionRecall/listRecentSessions/getSessionRecallCapsule/listAttachedSessionRecallContexts/getReferenceSkillHint/attachSessionRecallContext/detachSessionRecallContext/resumeSessionCandidate` (8 ch) | ~250 |
| DetachedTaskGroup | `ipc/detached-task-group.ts` | `agent:startDetachedSkillAction/inspectDetachedSkillTask/listDetachedSkillTasks/cancelDetachedSkillTask` | ~120 |
| RunControlGroup | `ipc/run-control-group.ts` | `agent:listActiveChildRuns/cancelChildRun/suspendRun/resumeRun/respondToInteraction` | ~200 |
| TelemetryGroup | `ipc/telemetry-group.ts` | `agent:emitRendererMetric` | ~40 |
| ChannelManagementGroup | `ipc/channel-management-group.ts` | `agent:upsertChannel/testChannel/startWechatLogin/getWechatLoginStatus/submitWechatLoginVerifyCode/deleteChannel/setChannelEnabled/sendChannelProbe` (8 ch) | ~300 |
| ScheduleGroup | `ipc/schedule-group.ts` | `agent:listSchedules/upsertSchedule/runScheduleNow/pauseSchedule/resumeSchedule/deleteSchedule` (6 ch) | ~150 |
| ChatPersistenceGroup | `ipc/chat-persistence-group.ts` | `chat:getConversations/getMessages/deleteConversation/saveMessage/createConversation/updateConversationTitle/pickFiles/readFileForAI` (8 ch) | ~200 |
| MemoryGroup | `ipc/memory-group.ts` | `agent:memory:query/create/update/delete/stats/lifecycle:status/lifecycle:runMaintenance/createFromConversation` (8 ch) | ~250 |
| TriggerGroup | `ipc/trigger-group.ts` | `agent:trigger:list/create/update/createWithMemories` (4 ch) | ~100 |

总计 ≈ 76 channels / 2480 LOC（含 group boilerplate，略大于现 1970 LOC，可接受）。
ipc-handler.ts 收口为 ≤ 200 LOC 的 group registry。

### V2.2 rss-engine 拆分（**25** channels → 7 groups，v3 修订）

v2 漏了 `rss:exportFeed` (`rss-engine/ipc-handler.ts:1232`) 和 `rss:startItemAnalysis` (`:1018`) 两个多行注册——regex 单行扫描漏掉，v3 用 typescript compiler API 扫到全部 25 个。

| Group | 包含 |
| --- | --- |
| SourceGroup | `rss:getSources/addSource/removeSource/getDraftStoreSources` |
| ItemGroup | `rss:getItems/markRead/markReadBatch/deleteItems/toggleStarred/clearDraftStore` |
| AnalysisGroup | `rss:getItemAnalysisProgress/listItemAnalysisJobs/pauseAnalysisJob/resumeAnalysisJob/deleteAnalysisJob/startItemAnalysis` |
| FetchGroup | `rss:fetchAll/refreshSource/benchmarkSources/status/stats` |
| DiagnosticsGroup | `rss:repairRuntime/diagnostics` |
| ExportGroup | `rss:exportOpml/exportFeed` |

### V2.3 document-engine 拆分（**26** channels → 7 groups，v3 修订）

v2 列了 5 groups——v3 实测 26 个 channel 覆盖到 7 groups 才完整。

| Group | 包含 |
| --- | --- |
| FileIoGroup | `document:read/write/saveAs/list/openFolder/openPath/showInFolder/createFile` |
| FileMutationGroup | `document:mkdir/rename/delete/copy/move/stat` |
| MarkGroup | `document:listMarks/createMark/updateMark/deleteMark` |
| WatchGroup | `document:watchDirectories` |
| WorkspaceGroup | `document:exportWorkspace/importWorkspace/getHome` |
| ParserGroup | `document:parseDocx/parseXlsx/importEbookAsMarkdown` |
| WidgetGroup | `document:widgetCommitted` |

### V2.4 search-engine 拆分（new — v3）

codex round-2 finding：`document:listSources/indexDocument/reindexAllSources/reindexWorkspace/searchIndex/getBacklinks/getGraph/directoryChanged/startWatcher/stopWatcher` 实际注册在 **`src/main/modules/search-engine/ipc-handler.ts`**（v2 完全遗漏）。v3 加 search-engine 进 V2 范围：

| Group | 包含 |
| --- | --- |
| SourceIndexGroup | `document:listSources/indexDocument/reindexAllSources/reindexWorkspace/cancelReindex` |
| QueryGroup | `document:searchIndex/getBacklinks/getGraph` |
| WatcherGroup | `document:startWatcher/stopWatcher` |

注：`document:directoryChanged` 是 push 通道（main → renderer），实际从 `document-engine/ipc-handler.ts:575-578` 发出，不属于 search-engine 拆分范围。`document:cancelReindex` (search-engine ipc-handler.ts:250-252) v3 漏列，v4 补入。

### Gate
- 每 group：行为测试 mock deps，断言 channel handler 返回 `IPCResponse` shape
- V5 IPC 合同 gate 强制 三类合同（INVOKE / SEND·ON / PUSH）channel 集合配对（详见 §6）
- 拆分 commit 走 R100 path-only；行为变更必须独立 PR

### 风险
- **R4 (高)**：handler 直接 import 全局 singleton（如 `taskProjectionRepository`）。
  **缓解**：第一步只搬源码不动 import 习惯；第二步逐 group 改 deps 注入
- **R5 (高)**：deps 接口爆炸——15 group × N 个依赖很容易写成 god-deps。**缓解**：每 group
  自己一个最小 deps 接口；只在 `registerEngineIpc` 顶层组合一次
- **R6 (中)**：拆完之后 ipc-handler.ts diff 是「删除大量行」+「替换为 group registry」——
  无法走 move-only gate。**缓解**：每个 group 一个独立 PR（move + 替换 registry 同 PR），
  PR description 说明等价性

## 4. V3 — 多会话并发底子（v2 修订：真正的 blocker 在 renderer）

### v1 错误 + v2 修订
v1 把 blocker 锁定在 `AgentSessionManager` 单 key——实际上 `runtime-core/orchestrator.ts:451`
已经用 `this.toTaskKey(agent, sessionId)` 做 composite key 调用，main 侧 task state
对 multi-session **已经支持**。真正的 blocker 是：

1. **renderer useAgent 顶层 flat state**：`messages/inputValue/sessionId/conversationId/currentScopeId` 全部顶层（`useAgent.ts:125`），一次只能 hold 一个 session
2. **模块级全局 timer**：`pendingSendTimer`/`pendingSendBuffer`（`useAgent.ts:211-220`）是模块顶层 `let`——多 session 并发会互相覆盖
3. **全店订阅大户**：ChatPanel / TaskPanel / MeetingChat 全店订阅；session 切换 = 整 store rerender
4. **preload bridge sessionId optional**：`preload/index.ts:48` + `electron.d.ts:741`——renderer 调用面允许漏传

### 用户故事
1. 用户提交 agent 任务，看到任务卡进入 running
2. 不等完成，点击「新建会话」（renderer UI）
3. 新会话独立侧栏标签，输入下一个任务；最多 3 个并行
4. 切换会话 = 切换 ChatPanel content（不杀任务）；旧会话仍在后台跑
5. session 完成后自动通知 toast，点击切回

### 架构方案（v2）

#### V3.1 main 侧（小改）
- `AgentSessionManager` 本身不动（已 composite via orchestrator——`runtime-core/orchestrator.ts:451` 用 `toTaskKey(agent, sessionId)`）
- `AgentSessionManager.listStates()` 当前返回的 key 是 composite 字符串（`agent::sessionId`）——加 `SessionDescriptor` 解析层（`session-manager.ts:13-40`），不能把 composite key 当裸 agent 用
- 在 `runtime-core/orchestrator.ts` 加 `listAllSessions(): SessionSummary[]` API 返回 `(agent, sessionId, state, lastTurnAt)` 三元组
- 加 `closeSession(agent, sessionId)`：cleanup turn engine pool entry + flush projection
- 并发上限 enforce 钩在 `ReadyAgentOrchestrator.send` 和 `newSession`（`orchestrator.ts:236-242`、`446-451`）——**入口名 v2 错写为 `startSession()`，v3 改正**

#### V3.2 IPC 多路复用
- **不**把 `agent:send` sessionId 从 optional 改 required（breaking change 太大）
- 新增 `agent:listActiveSessions` / `agent:closeSession` IPC channel
- 既有 `agent:event` 等推送事件 payload 加 sessionId（**v2 §6 IPC gate** 强制 push-side 也带）
- preload bridge 给新 channel 加方法；老 channel 保持兼容（sessionId 可选）但在 renderer 侧
  强制 wrapper 必填

#### V3.3 renderer 状态拆分（**核心**）
两阶段切：

**V3.3a read-side wrap（先做）**：保持现有 flat state，但加 `sessions: Record<sessionId, SessionSlice>`
顶层字段 + `activeSessionId`；selector 全部走 `state.sessions[activeSessionId] ?? state`
做兼容 fallback。**消费者无感知**，老 selector 全活。

**V3.3b write-side migrate（后做）**：把 `messages/inputValue/scopeRuns/taskProjections/streaming` 等
per-session 字段从顶层挪到 `sessions[id].slice`；同步更新 set 函数。每动一个字段一个 PR。

**V3.3c module-global 修复（v3 扩到 4 个 globals）**：v2 只列了 `pendingSendTimer`/`pendingSendBuffer`——
v3 实测 `useAgent.ts:149-152` 还有 `pendingSendCount`/`pendingSendFlushAt` 在 store 顶层
且通过 `set()` 被 timer 路径写入（`:1134-1143`）。4 个全部要按 sessionId 隔离：

- `pendingSendTimer`、`pendingSendBuffer` 从模块顶层 `let` 改 `Map<sessionId, PendingSend>`
- `pendingSendCount`、`pendingSendFlushAt` 从顶层 store field 改 `sessions[sessionId].pendingSendCount/FlushAt`
- timer fire 时按 sessionId 拿 buffer + 写回对应 session slice
- **HMR**：dev hot-reload 模块重载会丢 Map 引用——加 `if (import.meta.hot) import.meta.hot.dispose(() => maps.clear())` 钩子

**这一步必须先做**，否则任何 multi-session UI 都会撞 timer。

**V3.3d listener-side direct setState 修复（v3 新加 + v4 加 null-guard）**：`useAgent.ts:1682-1707` 在
`initAgentInteractionListeners` 里直接 `useAgent.setState((prev) => ({ messages: [...prev.messages, ...] }))`——
绕过任何 selector wrapping。multi-session 下会把 cards 写到错误的 session。修复：
- listener handler 内根据 `event.sessionId` 找到对应 session slice，setState 时只动该 slice
- `currentScopeId` mismatch 时仍写入对应 session（**不要 drop**——后续切换需要看到）
- **v5 null-guard 规则（codex round-4 修订）**：`event.sessionId` 当前在 preload (`preload/index.ts:1045-1050`)
  和 renderer types (`electron.d.ts:3212-3217`) 仍是 nullable。**注意合法 null 路径存在**：
  `ask-user-questions.ts:525-526` 显式 `sessionId: deps.sessionId || null`；persist 层
  (`ipc-handler.ts:238-242`) 接受 `conversationId` 非空 + `sessionId` 为 null 的组合。
  所以**不能**直接 drop——会把 persisted live card 静默丢掉。listener 必须：
  ```typescript
  // v7: validated three-level fallback——non-null sessionId 必须 isLiveSession 才接受
  function isLiveSession(state: AgentStoreState, id: string | null | undefined): id is string {
    if (!id) return false
    const slice = state.sessions[id]
    return !!slice && !['done', 'error', 'cancelled', 'closed'].includes(slice.state)
  }

  const targetSessionId =
    (isLiveSession(state, event.sessionId) ? event.sessionId : null)
    ?? lookupSessionByConversation(event.conversationId)  // 内部已过滤 terminated
    ?? state.activeSessionId  // last-resort 仍渲染，绝不丢
  if (!targetSessionId) {
    metrics.recordOrphanedCard(event.cardId, 'no-active-session-and-keys-null')
    return
  }
  if (targetSessionId !== event.sessionId) {
    const reason =
      !event.sessionId ? 'null-sessionId' :
      !state.sessions[event.sessionId] ? 'unknown-session' :
      'stale-or-terminated-session'
    metrics.recordCardFallback(event.cardId, reason)
  }
  // 写入 sessions[targetSessionId]
  ```
  **Edge cases**（v6 codex round-5 列）：
  - stale sessionId（已 close 但仍 push）：`lookupSession` 也找不到时走 activeSessionId；记 stale-session metric
  - 同 conversation 多 session 映射歧义：`lookupSessionByConversation` 取 most-recent active 返回；记 ambiguous metric
  - terminated session：lookup 函数过滤掉 state ∈ {done, error, cancelled, **closed**} 的 session（v8 codex round-7 修订：与 `isLiveSession` 守卫使用同一 exclusion 集，避免 closed session 通过 conversation fallback 被重入）
  `lookupSessionByConversation` 查 `sessions` Record 找哪个 session 当前 `conversationId === event.conversationId`，
  找不到再 fallback to `activeSessionId`（最后兜底；记 metric 但仍渲染）。**关键**：
  drop 只在 `sessionId` + `conversationId` 双双为 null 时发生——比 v4 死 drop 安全得多，避免静默用户数据丢失。

#### V3.4 renderer UI
- 侧栏 session 标签条（≤ 3 标签 + 「+ 新建」按钮）
- 任务后台跑时标签显示状态点
- 切换 = 切 `activeSessionId`，ChatPanel 用 `useShallow` + `sessions[activeSessionId]` 订阅
- session 完成 toast 由 `agent:event` 全局监听派发

### 并发上限（v2 加固）
- 硬限 3 session——**main 与 renderer 各自独立 enforce**（codex round-1 Q7 建议）
- main：`orchestrator.startSession()` 检查 `getActiveCount() < 3`
- renderer：「+ 新建」按钮在 `sessionOrder.length >= 3` 时 disable + 提示
- 第 4 个 session 创建无论从哪侧来都必须被拒绝（有行为测试）

### 拆分序列（v3 重排）
1. **V3.0 IPC contract gate (V5)** 先落地（合同先行，给后续步骤当护栏）
2. **V3.1 main**：`listAllSessions`/`closeSession` API + SessionDescriptor 解析层 + 行为测试
3. **V3.2 IPC event payload 加 sessionId** + preload bridge 更新 + V5 gate 检测
4. **V3.3c module-global 4 个 globals 全部按 sessionId 隔离**（独立 PR——最容易出问题）+ HMR 钩子
5. **V3.3d listener-side direct setState 改 session-aware**（独立 PR）
6. **V3.3a useAgent 加 `sessions` Record + `activeSessionId` 顶层字段** + selector wrap fallback
7. **V3.3b 逐字段 write-side migrate**（每字段一 PR）
8. **V3.4a session tab UI**
9. **V3.4b session 完成 toast + 切回逻辑**
10. **V3.5 多 session 上限 enforce（main+renderer 双侧）+ 行为测试**

### Gate
- 行为测试 `multi-session-isolation.test.ts`：
  - 起 2 session 各发 1 task
  - 强制 session A 进 tool_running，切到 session B
  - 断言 B input 不影响 A projection
  - 断言 A 完成能 emit event 且 B 不被打断
- 行为测试 `pending-send-timer-isolation.test.ts`：
  - 同时触发两 session 的 coalesced send
  - 断言两 session 各自的 buffer/timer 不串
- 行为测试 `session-limit-enforcement.test.ts`：
  - 起 3 session，第 4 个创建 main + renderer 双方拒绝
- IPC gate：所有 `agent:*` event payload 必须含 sessionId（V5 introspection）

### 风险
- **R7 (中)**：useAgent V3.3b 逐字段 migrate 期间，selector 同时有 flat + Record 两套读路径——
  存在 transient state inconsistency 风险。**缓解**：每字段 migrate PR 必须带行为测试覆盖
  「同字段读两次返回一致」
- **R8 (高)**：ChatPanel / TaskPanel / MeetingChat 全店订阅——任意 session slice 变化都
  触发整 store rerender。**缓解**：本期不做 perf 优化，但在 V3.3a 引入 `useShallow` 包装
  常用 selector，留 perf 切口给后续
- **R9 (高)**：V3.3c module-global timer 改 Map 期间，老代码路径若有遗漏会丢消息。
  **缓解**：先加行为测试锁定 single-session 的 coalesced send 行为，再改实现，diff = 0
- **R10 (中)**：3 个 turn engine 实例内存（~150MB）。**缓解**：实测一次，若超 200MB 给 oversized warning
- **R11 (中)**：LLM rate limit。**缓解**：复用 `llm-resilience.ts` queue
- **R12 (低)**：session 上限只在 main 检查时被绕过（renderer disable 被开发者工具改）。
  **缓解**：main 必须独立检查，不依赖 renderer disable

## 5. V4 — Verify-chain slim

承接 codex round-2 §1.E：当前 `npm run verify` 含历史阶段 gate，部分已超保鲜期。

### 步骤
1. **V4.1**：基线 — `time npm run verify` 记录每 sub-step 时长 + pass/fail
2. **V4.2**：owner 标注 — 每 `verify:*` 找原阶段 plan 确认是否仍 enforce
3. **V4.3**：已 superseded 的改 dry-run（不删，保留可手动跑）
4. **V4.4**：merge gate 收口为 5 核心 verify（typecheck / unit / native / silent-catch / move-only）+ **新加 ipc-contract**

### Gate
- 修改 verify 前必须先跑 baseline，commit message 引用 baseline diff
- 任何标 superseded 的 step 必须能引用一个 plan 文档说明被谁取代

## 6. V5 — IPC 合同 gate（v3 重写，三类合同 + 映射层）

### v2 错误 + v3 修订
**最终设计：三类合同（INVOKE / SEND·ON / PUSH）**——v3 起取代了 v2 的早期 2-set 草案（早期草案仅覆盖 invoke 对称 + push 子集 + methods 一致，漏 ipcMain.on/ipcRenderer.send 一类，已废弃）。
仍**漏一个方向**——`ipcRenderer.send` / `ipcMain.on` fire-and-forget 通道。实测在
`preload/index.ts:337/360/542/1026` + `claude-bridge/ipc-handler.ts:551` + `document-engine/ipc-handler.ts:514`
都有 send/on 模式。v3 改 **3 类 channel 集合**：

### v3 设计（3 类）
```typescript
// scripts/check-ipc-contract.cjs（使用 typescript compiler API，不引入 ts-morph）
// 1. 扫 src/main/**/*.ts:
//    a) ipcMain.handle 第一参数 → INVOKE_HANDLED
//    b) ipcMain.on 第一参数 → SEND_RECEIVED
//    c) PUSH_EMITTED 来源（v5 修订——覆盖 codex round-4 标出的真实形态）：
//       - *.webContents.send（broad；matches webContents.send / win.webContents.send / mainWindow.webContents.send 等）
//       - *.sender.send（matches event.sender.send / session.sender.send，
//         见 document-engine/ipc-handler.ts:566-575）
//       - *.sendToRenderer(（member 调用形式：matches controller.sendToRenderer /
//         this.host.sendToRenderer，见 browser-engine/ipc-handler.ts:1402-1407、
//         utility-menu-service.ts:104-109、clip-dragged-tab-runner.ts:303-304）
//       Scanner 走 AST CallExpression：判断 callee.expression 是 PropertyAccess，
//       name 在 {send, sendToRenderer}，前缀 PropertyAccess.name 在
//       {webContents, sender, *} 时按上面 3 类归并。然后取 firstArg 字面量。
//
//    d) 非字面量 firstArg 处理规则（v6 修订——codex round-5 blocker）：
//       若 firstArg 不是 string literal（如 content-study-runner.ts:181-182 传变量 `channel`，
//       browser-engine/ipc-handler.ts:418-420 转发 runtime variable），scanner **不静默跳过**，
//       而是发 NON_LITERAL_PUSH 警告——必须在 allowlist 中显式登记
//       （v7 format: `{ callsite: 'file:line', variable: 'channel', channels: ['a','b','c'],
//         reason: '...', owner: '...', expiry: 'YYYY-MM-DD' }`——expiry 与 §6 后续 allowlist
//         policy + R14 保持一致），说明该 callsite 可能 fan out 到哪些 channel。
//       allowlist 缺失或过期 = gate fail。
// 2. 扫 src/preload/index.ts:
//    a) ipcRenderer.invoke 第一参数 → INVOKE_USED
//    b) ipcRenderer.send 第一参数 → SEND_USED
//    c) ipcRenderer.on 第一参数 → PUSH_LISTENED
//    d) exposeInMainWorld 内方法名 → METHODS_EXPOSED
// 3. 扫 src/renderer/types/electron.d.ts:
//    a) 接口字段 → METHODS_TYPED
// 4. 断言：
//    A. INVOKE_HANDLED == INVOKE_USED       (request/response 对称)
//    B. SEND_USED ⊆ SEND_RECEIVED            (renderer 发出的 channel main 必须有 listener)
//    C. PUSH_EMITTED ⊆ PUSH_LISTENED         (main 发出的 channel renderer 必须有 listener)
//    D. METHODS_EXPOSED == METHODS_TYPED     (preload 方法 == renderer 类型)
//    E. 例外通过 explicit allowlist（不是 prefix），whitelist 列每个 channel 名 + owner + 原因 + expiry
```

### 实现技术（v3 修订）
- **不引入 ts-morph**（不在 package.json）；用 `typescript` compiler API 直接走 AST，沿用
  `scripts/check-silent-catch.cjs:7` 的现有模式
- gate output 4 段（A/B/C/D），每段独立断言；allowlist 一段单独 report

### 接入 verify
- `npm run verify:ipc-contract` 进 `verify:e` merge gate（V4.4 5+1 核心 verify 之一）

### 风险
- **R13 (低)**：typescript compiler API 扫描慢。**缓解**：cache AST per file；仅 verify 时跑
- **R14 (低)**：allowlist 膨胀。**缓解**：whitelist entry 必须含 owner + 原因 + expiry（无 expiry 的不接受）

## 7. V6 — ChatPanel fixture 复盘

承接 U5.3-prep agent 死在 65 tool uses 的失败。

### 复盘
- 单 agent dispatch ChatPanel 4675 LOC fixture 超时
- 解：**任务分到 ≤ 1500 LOC**，每 agent 只搬一个子模块 fixture
- V1.0 fixture 4 个 baseline case + jsdom skeleton 为骨架；后续 V1.x 各 PR 自行加 1 个 fixture case

### Gate
- V1.0 fixture baseline test 必须先绿
- 后续 V1.x 拆分 PR diff 必须 fixture snapshot 不变（行为锁）

## 8. 顺序与并行度（v2 调整）

```
V5 (IPC gate)            ─────┐
                                ├──> V2 (IPC 拆分)
V4 (verify slim baseline) ────┘                ╲
                                                ╲
V6 → V1.0 fixture → V1.1 helpers ────╮          ╲
                                       ├──> V1.x  ╲
V3.3c module-global timer 修复 ──┐    ╱           ╲
V3.1 + V3.2 main/IPC session ──┤   ╱            ╲ 
V3.3a/b useAgent migrate ──────┴──┴──> V3.4 UI ──>──>──> 收尾
```

**关键路径调整（codex round-1 §5）**：
- 原 v1：V5 → V2 → V3，V1 并行
- v2：V5 → V3.3c (timer 修复) → V3.3a (sessions Record) **先于** V1.x 启动
  因为 V1 抽离子组件时需要 sessionId 作 prop——若 V3.3a 未做，V1 子组件只能假设 single session，
  V3 落地时又要回头改

### 阶段交付里程碑（v2）
- **M1（~4 PR）**：V5 gate + V4 verify 基线 + V6/V1.0 fixture + V3.3c timer 修复
- **M2（~4 PR）**：V3.1 main + V3.2 IPC + V3.3a sessions Record + selector wrap
- **M3（~7 PR）**：V1.1-V1.6 ChatPanel 拆分（子组件 props 接受 sessionId）
- **M4（~12 PR）**：V2 三 engine IPC 拆分（claude-bridge 15 group + rss 6 + document 5）
- **M5（~6 PR）**：V3.3b write-side migrate + V3.4 UI + V3.5 上限 enforce
- **总计**：~33 PR（vs v1 估 27；v2 因 V2 group 数从 8 → 15 增加）

## 9. 测试策略

- 行为测试占主导（CLAUDE.md §6）
- 每 PR 至少带 1 个行为测试或合同 gate
- fixture / snapshot 仅用于行为锁
- 节点：`node:test`（既有约定）
- SQLite-backed 走 `npm run verify:native`
- 多 session：新增 3 个行为测试套件（isolation / pending-send-timer / session-limit）

## 10. 风险总表（v3 汇总）

| ID | 风险 | 等级 | 模块 | 缓解 |
| --- | --- | --- | --- | --- |
| R1 | TaskCard 内部状态深耦合 | 高 | V1.6 | 先 props 化再剪 |
| R2 | fixture snapshot 误锁 | 中 | V6 | snapshot 只锁语义 |
| R3a | task-merge/snapshot hook 抽离丢时序 | 中 | V1.7/V1.8 | 行为测试 lock，diff=0 验证 |
| R4 | IPC group 引用全局 singleton | 高 | V2 | 两步走（搬 → 注入） |
| R5 | god-deps 接口 | 高 | V2 | 每 group 最小 deps |
| R6 | ipc-handler.ts diff 不是 move-only | 中 | V2 | 独立 PR + 等价说明 |
| R7 | useAgent transient inconsistency | 中 | V3.3b | 行为测试 lock 字段一致性 |
| R8 | 全店订阅 perf | 高 | V3.3a | `useShallow` 包装，perf 留后续 |
| R9 | 4 globals 改 sessionId 隔离丢消息 | 高 | V3.3c | 先 lock 行为，diff=0 |
| R10 | 3 实例内存 | 中 | V3 | 超 200MB warning |
| R11 | LLM rate limit | 中 | V3 | 复用 resilience |
| R12 | session 上限绕过 | 低 | V3.5 | main 独立检查 |
| R13 | typescript compiler API 扫描慢 | 低 | V5 | per-file cache，仅 verify 用 |
| R14 | whitelist 膨胀 | 低 | V5 | 强制 owner+原因+expiry |
| R15 | V3.3c Map 跨 hot-reload 残留 | 中 | V3.3c | `import.meta.hot.dispose` 钩子 |
| R16 | useAgent 1812 LOC 单文件——拆 sessions 时合并冲突高 | 中 | V3.3 | 每字段独立 PR，rebase 友好 |
| R17 | listener-side direct setState 跨 session 串数据 | 高 | V3.3d | V3.3c+d 独立 PR，行为测试覆盖 cross-session card 路由 |
| R18 | RSS/document/search-engine 漏 channel（v2 漏判） | 中 | V2 | v3 用 typescript compiler API 全量重扫前先做 audit script |
| R19 | V5 gate 漏 ipcMain.on / ipcRenderer.send 一类 | 高 | V5 | v3 改 3 类断言（A/B/C/D） |
| R20 | ChatPanel shell target 调整为 ≤ **1000 LOC**（v4，v3 ≤ 800 不可达） | 低 | V1 | V1.7/V1.8/V1.9a-c 共抽 ~1440 LOC，剩 ~970；超标加 V1.10 兜底 |
| R21 | SessionDescriptor 解析与 composite key 不对齐 | 中 | V3.1 | `session-manager.ts` 加 parseKey 单测 |
| R22 | V5 scanner 漏 `event.sender.send` / `sendToRenderer` wrapper（round-3 blocker） | 高 | V5 | §6 scanner spec 加 3 种 callee 形态 + 行为测试断 sample push channel 被识别 |
| R23 | listener-side null `event.sessionId` 静默写 `sessions[null]` 污染 store（round-3 blocker） | 高 | V3.3d | drop + metric 兜底；V5 IPC gate 逐步消除 null 路径 |

## 11. 不在本期范围

- turn-engine.ts / direct-chat.ts 本体拆分（归入 Stage W 候选）
- ChatPanel 之外的 renderer 组件拆分
- 跨 session 协作（A 引用 B 结果）
- session 持久化（断电恢复）
- multi-session perf 调优（全店订阅优化等）

## 12. 开放问题（v3 — codex round-2 答复已采纳，留少数 v3 新问题）

**round-2 答复已采纳并融入正文**：
- Q1 HMR 钩子：必加（V3.3c）→ 写入正文 §4
- Q2 Memory+Trigger 合并：不合（API 表面独立）→ §3 保持分开
- Q3 ModelSelector IPC adapter：drop（无 IPC 依赖）→ §2/R3 已删
- Q4 哪些字段必须全局：capability/model settings + send coalescing prefs；per-session：messages/input/streaming/scopeRuns/taskProjections/4 pending-send fields → §4 V3.3b 写入
- Q5 `internal:*` prefix：太松，改 explicit allowlist（name + owner + reason + expiry）→ §6 写入
- Q6 spot-check cadence：M1 后 + M2 后 + flip enforce 前各 1 次 → 写入 §14 流程

**v5 新开放问题**：
1. ChatPanel shell ≤ 1000 LOC 目标（v5 锁定）是否需要 fixture lock LOC 上限做硬约束？
2. V5 explicit allowlist 是否要存独立 JSON 文件（机器可读）而非散在 ts comment？
3. V3.3d listener-side cross-session card 路由——cards 写到非 active session 时是否要给 unread badge？UX 决策点
4. V3.3d conversationId fallback 后，scope→session 映射是否需要单独 lookup（avoid 重建）？

## 13. Codex finding 处理记录

### Round-1 findings → v2
| Finding | 处理 |
| --- | --- |
| §2 V1 stale | §2 全面重写 |
| §3 V2 counts off | §3 全面重写 → 15 groups |
| §4 V3 blocker 误判 | §4 重写 |
| §6 V5 早期三集合方案不可行 | §6 改三类合同（INVOKE / SEND·ON / PUSH） |
| §8 ordering | 采纳 |
| Q1-Q8 答复 | 采纳 |
| useAgent blast radius + pendingSendTimer | R8/R9 列高风险 |

### Round-2 findings → v3
| Finding | 等级 | 处理 |
| --- | --- | --- |
| §2 shell ≤ 1500 不可达——store destructure / task-run merging / snapshot rendering / preview modal 还内联 | must-fix | §2 加 V1.7/V1.8 hook 抽离 + 把 preview modal 并进 attachments-preview；shell target 降为 ≤ 800；新增 R20 兜底 |
| §2/R3 ModelSelector IPC adapter 多余（只用 useSettings + useNavigate） | must-fix | §2 删 R3；§2 模块表标 "无 IPC"；§12 Q3 同步 |
| §3 第 177-180 行还有旧单集合句子 | must-fix | §3 Gate 行改写：「3 类 channel 集合配对」 |
| §3 RSS 漏 `exportFeed`/`startItemAnalysis` (多行注册 regex 漏判) | must-fix | §3 V2.2 加 + 注释说明 v3 改用 typescript compiler API 全扫 |
| §3 document 漏 listSources/index/reindex/search/backlinks/graph/directoryChanged/startWatcher/stopWatcher | must-fix | §3 加 V2.4 search-engine 拆分；document-engine 7 groups 全列 |
| §4 V3.3c 漏 pendingSendCount/pendingSendFlushAt | must-fix | §4 V3.3c 扩到 4 globals 全部 |
| §4 `orchestrator.startSession()` 不存在 | must-fix | §4 改 send/newSession 真实入口 |
| §4 listener-side direct setState 跨 session leak | must-fix | §4 加 V3.3d + R17（高风险）|
| §6 V5 漏 ipcMain.on / ipcRenderer.send 一类 | must-fix | §6 改 3 类断言 A/B/C/D + R19 |
| §6 ts-morph 未在 package.json | must-fix | §6 改用 typescript compiler API（沿用 `check-silent-catch.cjs` 模式） |
| §8 V1.1 helpers 顺序 | consider | §2 V1.1 加 constraint "pure helpers, no session-shaped props" |
| §10 risk 漏（gate 漏一类 / 漏 channel 类 / listener writes / shell 不可达 / SessionDescriptor） | must-fix | §10 加 R17/R18/R19/R20/R21 |
| Q1 HMR 钩子 | must-fix | §4 V3.3c 写入 `import.meta.hot.dispose` |
| Q2 Memory+Trigger 合 | consider | 保持分开 |
| Q3 ModelSelector IPC adapter | must-fix | 删 |
| Q4 fields global vs per-session | consider | §4 V3.3b 写入分类 |
| Q5 internal:* prefix | must-fix | §6 改 explicit allowlist + owner+reason+expiry |
| Q6 spot-check cadence | consider | §14 写入 M1/M2/flip 三个检查点 |
| 整体 verdict: 还需另一轮 | — | v3 draft 已被 codex round-3 review |

### Round-3 findings → v4
| Finding | 等级 | 处理 |
| --- | --- | --- |
| §2 shell ≤ 800 LOC 不可达——V1.7+V1.8+modal 只去 ~690 LOC | must-fix | §2 加 V1.9a/b/c 三段具体行段抽离；shell target 改 ≤ 1000；R20 降为低 |
| §2 V1.8 应是 TSX 子组件，不是 hook（含 JSX 渲染） | nice-to-have | §2 改标签 `TaskToolSnapshot.tsx` |
| §3 V2.4 漏 `document:cancelReindex` | nice-to-have | §3 V2.4 SourceIndexGroup 加入 |
| §3 `document:directoryChanged` 实际 owner 是 document-engine（push 方向） | nice-to-have | §3 注释更正 |
| §4 V3.3d 漏 null-sessionId guard | must-fix | §4 V3.3d 加 drop + metric 规则；R23 高风险 |
| §6 V5 scanner 漏 `event.sender.send` / `sendToRenderer` wrapper | must-fix | §6 scanner spec 加 3 种 callee 形态；R22 高风险 |
| Q1-Q6 v3 答复 | consider | 全部确认采纳 |
| 整体 verdict: 还需 round-4 | — | v4 draft 已被 codex round-4 review |

### Round-4 findings → v5
| Finding | 等级 | 处理 |
| --- | --- | --- |
| §2 shell target ≤ 800 vs ≤ 1000 不一致（模块表 + Q1 仍 800） | must-fix | §2 模块表行改 ≤ 1000；§12 Q1 同步 |
| §2 V1.9a 范围不自闭——漏 state 2319+2327-2334 / detach 2559-2587 / effect wiring 3121-3136+3250-3283 | must-fix | §2 V1.9a 行段补全为 7 段，LOC 估 170 → 280 |
| §4 V3.3d 死 drop 会丢 persisted card（合法 null sessionId + 有 conversationId） | must-fix | §4 改 conversationId fallback + lookupSessionByConversation + activeSessionId 最后兜底；真正双 null 才 drop |
| §6 V5 scanner pattern `event.sender.send` 不匹配 `session.sender.send`；`sendToRenderer` 是成员调用 | must-fix | §6 改 AST 匹配 `*.sender.send` + `*.sendToRenderer(`；scanner 走 PropertyAccess + CallExpression |
| §3 注脚 directoryChanged owner | nice-to-have | 已采纳（v4 已加） |
| §3 cancelReindex | nice-to-have | 已采纳（v4 已加） |
| §2 V1.8 hook → TSX 子组件 | nice-to-have | 已采纳（v4 已改） |
| 整体 verdict: 4 must-fix 都是窄修订，patch 即可 | — | v5 draft 已被 codex round-5 review |

### Round-5 findings → v6
| Finding | 等级 | 处理 |
| --- | --- | --- |
| §2 line 89 仍残留 ≤800 stale 文本 | must-fix | 改 ≤ 1000，注明 v6 修订 |
| §4 V3.3d pseudocode 与 prose 不一致（pseudocode 漏 activeSessionId fallback） | must-fix | pseudocode 加 `?? state.activeSessionId` + metric 分支；列 edge cases（stale/ambiguous/terminated） |
| §6 V5 scanner 漏非字面量 firstArg policy（content-study-runner:181、browser-engine/ipc-handler:418） | must-fix | scanner 加 d) NON_LITERAL_PUSH 警告 + allowlist 显式登记规则；缺失 = gate fail |
| §2 V1.9a hook return surface 应该枚举（recommendation） | consider | 采纳——V1.9a 行加 `Hook 必须 return:` 列表 |
| 整体 verdict: 3 must-fix patch 即可 lock | — | v6 draft 已被 codex round-6 review |

### Round-6 findings → v7
| Finding | 等级 | 处理 |
| --- | --- | --- |
| §4 V3.3d pseudocode `event.sessionId` 直接接受，不验 stale/terminated | must-fix | 加 `isLiveSession()` 守卫；非 live 时 fall through 到 conversation lookup |
| §6 NON_LITERAL_PUSH allowlist 漏 expiry，与 §6 后续 allowlist policy + R14 不一致 | must-fix | format 加 `expiry: 'YYYY-MM-DD'`；过期 = gate fail |
| §2 V1.9a return 漏 `currentChannel` + `channelOptions` | must-fix | 列入 v7 完整 return 列 |
| 整体 verdict: 3 微调即可 lock | — | v7 draft 已被 codex round-7 review |

### Round-7 findings → v8
| Finding | 等级 | 处理 |
| --- | --- | --- |
| §4 V3.3d `isLiveSession` 排除 closed，但 `lookupSessionByConversation` 文字 filter 漏 closed → 被 fallback 重入 | must-fix | edge case 行补 `closed` 进 exclusion set，两处守卫对齐 |
| 整体 verdict: 1 行修订即可 lock | — | v8 draft 已被 codex round-8 review |

### Round-8 findings → v9
| Finding | 等级 | 处理 |
| --- | --- | --- |
| §0 + §6 标题仍写早期 2-set 标签与 §3/§6 body 的「3 类合同」矛盾 | must-fix | §0 + §6 标题统一为「三类合同（INVOKE / SEND·ON / PUSH）」 |
| 整体 verdict: 标签对齐即 lock | — | 本文 = v9 draft，请 codex round-9 confirm lock |

## 14. 下一步

1. 本 draft v7 交付 codex round-7 最终确认
2. 若无新 must-fix → LOCK 计划，rename 为 implementation 并启动 M1 dispatch
3. 若有新 finding → 继续迭代（已收敛轨迹：r1=7→r2=4→r3=3→r4=4→r5=3→r6=3）
3. 对齐后：
   - 重命名为 `2026-05-21-V-stage-v-comprehensive-implementation.md`
   - frontmatter `status: implementation`、`enforce: true`
   - 按 §8 顺序 dispatch agent teams 执行 M1-M5
4. Codex spot-check 检查点（采纳 round-2 Q6）：
   - M1 完成后：codex review V5 gate + V4 baseline + V3.3c 实现
   - M2 完成后：codex review V3.1/V3.2 main 侧 + V3.3a selector wrap
   - 翻 frontmatter enforce: true 前：codex review 多 session 行为测试 + 上限 enforce
