---
title: 后台逐篇采集任务在聊天侧可见（note_collect → TaskProjection）实施计划
date: 2026-06-05
status: approved（Codex AGREE 2026-06-05）
owner: 白
executor: Claude
enforce: true
note: Bug 2 续作。用户从管家聊天派发浏览器逐篇采集后，note_collect 后台任务在聊天里没有任何提示（监督面板只在 BrowserMode）。让 note_collect 投影进现有 agent TaskProjection，作为原生聊天任务卡显示，scope 绑定到派发它的会话。先与 Codex 计划循环，一致后开发，再结果评审。
related:
  - docs/superpowers/plans/2026-06-04-browser-collection-subagent-implementation.md（形态 B 主体，§11 已 APPROVE）
  - 引擎/runner：src/main/modules/browser-engine/content-task-runner.ts（note_collect）
  - 投影库：src/main/modules/repositories/task-projection-repository.ts（create/update/listByScope + emit change）
  - 运行时取数：src/main/modules/agent-control/runtime-core/runtime.ts:686 getTaskProjectionStore()
  - 聊天消费：src/renderer/components/agent/ChatPanel.tsx（onTaskProjectionsChanged 订阅 + backgroundTaskRuns 渲染）
  - 监督 IPC（已建，复用其 scope 之外的部分）：src/main/modules/browser-engine/ipc-supervision.ts
---

## 0. 一句话

让 `note_collect` 后台任务投影进现有 agent TaskProjection 仓库，绑定到派发它的会话 scopeId，从而在管家聊天里作为**原生后台任务卡**实时显示进度（X/N 篇、当前笔记），完成/取消时收尾——渲染侧基本零改动（ChatPanel 已订阅并渲染 backgroundTaskRuns）。

## 1. 前因后果（实测）

- 实测：用户从管家聊天派发"采集这个博主的笔记每篇建文件夹下载图片"，曝光修复后 agent 能拿到浏览器工具，但**聊天里看不到任何后台任务提示**。
- 已查清两层：
  1. （已修 8367631e）agent 之前根本没调用 browser_collect_notes（文档误判 + 缺工作流引导）。
  2. （本计划）即便 note_collect 真正启动，它只存在于 browser_tasks 表，**从不投影到 renderer**；监督面板 `AgentBrowserSupervisionPanel` 只挂在 BrowserMode，与聊天面板在不同 React 树。
- 用户心智模型：聊天里就有任务卡（截图里的"文档改写操作"就是一张 TaskProjection 卡）。所以正确做法是把采集任务也变成这种**原生任务卡**，而不是另起一个浮动 chip。

## 2. 目标 / 成功标准

- 从某会话派发的 note_collect，在**该会话**的聊天里出现一张后台任务卡，标题"浏览器逐篇采集"，副标题/进度反映"已采集 X/N，当前：<笔记>"。
- 进度随后台推进实时更新（沿用现有 `agent:taskProjectionsChanged` 推送 + ChatPanel 订阅）。
- 任务完成→卡片转完成态；取消/冻结→转取消态。
- scope 绑定：只在派发它的会话显示，不串台到其他会话。
- 渲染侧零或最小改动；不破坏既有 TaskProjection / TaskCard 合同。

## 3. 设计（方案 A：投影进 TaskProjection；推荐）

### 3.1 数据流
`browser_collect_notes`（工具，已知 sessionId/scopeId）→ `controller.startNoteCollection(plan, scopeId)` → note_collect payload 带 `scopeId` → content-task-runner 在 note_collect 生命周期（start/progress/complete/cancel）调用注入的 **taskProjectionSink.upsert(record)** → runtime 的 TaskProjectionRepository.create/update → emit `change` → IPC `agent:taskProjectionsChanged` → ChatPanel 已订阅 → 重取 listTaskProjections(scopeId) → 渲染原生任务卡。

### 3.2 scopeId 串接（WP1）
- `executeBrowserTool` 已有 `sessionId` 参数；browser_collect_notes case 把它带进 `controller.startNoteCollection(plan, scopeId)`。
- `startNoteCollection` 把 scopeId 写入 note_collect payload；`runNoteCollect` 读出来用于投影。
- `BrowserCapabilityTaskHandle` 无 scopeId 字段——不改表结构，scopeId 只走 payload + 投影记录。

### 3.3 投影 sink 注入（WP2，解耦）
- browser-engine 不直接 import agent-control。BrowserController 新增可后设的 `taskProjectionSink`（接口：`upsert(record): void; remove(taskId, scopeId): void`）。
- `setupAgentIPC` 在 `setBrowserController(controller)` 时，额外 `controller.setTaskProjectionSink(sink)`，sink 由 `runtime.getTaskProjectionStore()` 背书（upsert = get→create/update）。
- content-task-runner 通过构造注入或 controller 转发拿到 sink（注意：runner 在 controller 构造里就 new 了，sink 后设，所以用可变 setter）。

### 3.4 投影记录映射（WP3）
- TaskProjectionRecord：`{ taskId, scopeId, runId: taskId, taskType: 'short_task'（或合适值）, module: 'browser', taskTitle: '浏览器逐篇采集', taskSummary: '已采集 X/N，当前：<note>', status: mapStatus(browserStatus), interactionState/waitingFor: 'background', steps: [一个进度步], createdAt/updatedAt }`。
- 状态映射 mapStatus：queued/running/paused→running 系；completed→completed；failed→failed；cancelled→cancelled（按 TaskProjectionStatus 枚举取最接近值，构建期核对）。
- 投影时机：startTask 后建一条 running；每篇 checkpoint 更新 progress/summary；终态（completed/cancelled/failed）更新 status + 收尾。

### 3.5 渲染侧（WP4，最小）
- ChatPanel 已订阅 `agent:taskProjectionsChanged` 并把 projections 合并进 backgroundTaskRuns 渲染（Explore：基本无需改动）。
- 构建期需核对：module='browser' + waitingFor='background' 的记录能被 backgroundTaskRuns 过滤器接纳、TaskCard 能优雅渲染（标题/进度/状态，无 skill 专属假设）。若过滤器或 TaskCard 对 browser 模块有未覆盖分支，做最小适配（仅显示，不新增本地状态猜测——遵守 projection 单源）。

### 3.6 生命周期挂点、重启恢复与清理（Codex 计划评审补充）
- **可信进度（不只启动写）**：投影必须挂在 runner 的真实生命周期点，否则卡片出现但不更新：`startTask`→queued、`runTask`→running、note_collect 的 `onProgress`/`onCheckpoint`→进度+summary、终态（completed/cancelled/failed）→收尾。每篇 checkpoint 都 upsert。
- **重启/恢复时序**：`resumePendingTasks()` 在 BrowserController 构造里就跑（ipc-handler.ts:373），早于 `setupAgentIPC`（index.ts:470）设 sink——恢复的 note_collect 在 sink 未就绪时无法投影。对策：`setTaskProjectionSink()` 设入时，**回投**当前 active 的 note_collect 任务（listTasks('note_collect') → upsert），从而捕获启动期已恢复/在跑的任务；后续生命周期点正常 upsert。payload 已持久化 scopeId，恢复任务能拿到 scope。
- **scope 清理（已有入口，作为验收点）**：会话删除走 runtime deleteConversation → `taskProjectionStore.deleteByScope(scopeId)`，已会清掉该 scope 的投影，无需新增清理代码；验收：删会话后采集卡随之消失。
- **无 scopeId / 非聊天路径**：generic `browser:startTask`/resume 可能起 note_collect 而无 scopeId；sink.upsert 在无 scopeId 时直接跳过投影（不报错、不串台）。

## 4. 备选（方案 B：聊天侧浮动 chip，已否决为主方案）
- 在 WorkbenchMode/聊天树挂一个 `AgentBrowserSupervisionPanel` 变体，轮询 `getAgentSupervisionState`。
- 否决理由：非 scope 绑定（所有会话都显示全部采集任务，会串台）；与用户预期的"原生任务卡"不一致；要额外做 workbenchMode 门控。可作为 BrowserMode 内已存在的监督面板保留，不用于聊天。

## 5. 复用 vs 新建
- 复用：TaskProjectionRepository（create/update/emit）、ChatPanel 订阅与渲染、note_collect runner 生命周期点、监督 IPC 的 list/control（聊天卡 MVP 只读进度，不含二级中断）。
- 新建：scopeId 串接、taskProjectionSink 注入与映射、（如需）backgroundTaskRuns/TaskCard 对 browser 模块的最小适配。

## 6. 非目标
- 聊天任务卡内的二级确认中断（MVP 只读可见；中断仍在 BrowserMode 面板；后续可加 cancel）。
- 投影 visible_collect/research 等其它 browser 任务（仅 note_collect）。
- 改 browser_tasks 表结构。

## 7. 工作包
- WP1 scopeId 串接：tool → startNoteCollection(scopeId) → payload。
- WP2 sink 注入：BrowserController.setTaskProjectionSink + setupAgentIPC 背书 runtime 投影库。
- WP3 content-task-runner 投影 note_collect 生命周期（建/更/收尾 + 状态/进度映射）。
- WP4 渲染核对/最小适配（backgroundTaskRuns 接纳 + TaskCard 渲染）。
- WP5 测试 + 实测。

## 8. 风险
- scopeId 缺失（非聊天派发路径）：sink.upsert 在无 scopeId 时跳过投影（不报错、不串台）。
- 解耦：browser-engine 经注入 sink 触达投影库，不静态依赖 agent-control（与 executeBrowserTool 懒加载同思路）。
- TaskCard 对 browser 模块的渲染假设：构建期核对，必要时最小适配，不破坏 projection 单源（renderer 不新增完成/等待猜测）。
- 重复投影/泄漏：终态后不再更新；scope 删除时 remove（可选）。

## 9. 验证
- 单元：content-task-runner 在 start/checkpoint/终态调用注入的 fake sink，断言投影记录的 scopeId/status/summary 正确；无 scopeId 时不投影。
- 合同：状态映射覆盖 queued/running/paused/completed/failed/cancelled。
- 实测：从聊天派发 → 该会话出现采集任务卡 + 实时进度 → 完成收尾；其他会话不串台。

## 10. 评审循环记录

### Round 1（2026-06-05，Codex → AGREE）
Codex 深入只读审查确认：projection store 可吃任意 module 并 emit change、scope 删除有 deleteByScope 清理入口、runner 有 startTask/runTask/onProgress/onCheckpoint/终态生命周期挂点；并识别 resume 时序（resumePendingTasks 早于 setBrowserController）与非聊天触发路径两个边界。计划据此补 §3.6（sink 后设回投、每篇+终态 upsert、deleteByScope 验收点、无 scopeId 跳过）。终审："§3.6 covers all four required points." → AGREE。进入开发。

## 11. 实施记录（Claude，2026-06-05，待 Codex 结果评审）

- **WP1 scopeId 串接**：browser_collect_notes case 把 executeBrowserTool 的 sessionId 传给 `controller.startNoteCollection(plan, scopeId)`；写入 note_collect payload.scopeId（无则不带）。
- **WP2 sink 注入**：`BrowserTaskProjectionSink/Input`（browser-engine 自有最小契约）；`BrowserController.setTaskProjectionSink` 转发给 runner；runner `setTaskProjectionSink` 设入即 `reprojectActiveNoteCollect`（回投 active note_collect，捕获 resume 时序）。`setupAgentIPC` 用 `makeNoteCollectProjectionSink(runtime)` 背书 `runtime.getTaskProjectionStore()`，把 input 映射成 run-contracts 的 TaskProjectionRecord（module:'browser'、taskType:'multi_step_task'、status 映射 running/completed/failed/killed、running 时 waitingFor:'background'、progress 用 taskSummary 承载）。
- **WP3 生命周期投影**：runNoteCollect 在 start/每篇 onCheckpoint/终态/各失败早退点 upsert；cancelTask 也直接 upsert 'cancelled'（兜底 loop 已退出的竞态）。
- **WP4 渲染（核对，零改动）**：读 use-task-run-merge 确认第 4 pass 为 persistedTaskProjections 里**每条** projection 合成卡片，key=`${scopeId}:task:${taskId}`（browser 任务 taskId 与主任务不同→不撞键、不去重），status 'running'→'tool_running' phase + waitingFor:'background'→background_running→后台堆；ChatPanel 已订阅 agent:taskProjectionsChanged 刷新 → 无需改 renderer。
- **WP5 测试**：content-task-runner-note-collect.test 新增投影 3 例（start+逐篇+终态 scope 绑定、无 scopeId 不投影、freeze→cancelled 卡）。typecheck 绿。
- **待实测**：真实从聊天派发后该会话出现采集卡 + 实时进度 + 完成/中断收尾；其它会话不串台；重启后恢复任务回投。

### 结果评审 Round 1（2026-06-05，Codex → REQUEST-CHANGES，3 条已修）
Codex 确认 scopeId 串接、sink 解耦、生命周期投影、deleteByScope 清理基本到位，但揪出 3 个真实缺陷（推翻了"渲染零改动"）：
1. **未捕获异常卡在 running**：runBrowserCollection 若在 running 投影后抛错，scheduleTask 外层 catch 只标 browser task failed，聊天卡永远停在 background_running。→ runNoteCollect 增 catch，抛错时同时标 task failed + 投影 'failed'。
2. **前台串台**：projection.ts selectFallbackProjection 在无 taskId 命中时会兜底抓同 scope 任一 live projection——running note_collect 会被某前台卡抓走，pass 4 又因键已存在跳过后台卡。→ resolveProjectionForTaskRun 的兜底过滤掉 module:'browser'（它走 pass 4 自己的卡）。
3. **完成即消失**：终态 waitingFor:'none' + 'completed' 被 isCompletedTerminalRun 立刻移出后台堆，且无 responseMessageId 无法落前台快照卡 → 采集一完成卡片就消失。→ sink 终态先 dwell（保持 background + ✓ 完成 summary）30s，再 settle 到真终态；settle 步 createIfMissing=false，避免 deleteByScope 后被 late timer 复活。
测试：runner 抛错→failed 投影 1 例；projection.ts 兜底排除 browser 3 例。typecheck 绿。
