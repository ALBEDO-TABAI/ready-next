---
title: Ready Agent 定时任务实施计划
date: 2026-07-13
status: superseded
enforce: false
design: ../specs/2026-07-13-agent-scheduled-tasks-product-design.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Ready Agent 定时任务实施计划

> 历史记录：该方案依赖的 Agent 执行链已被 Codex 生产主链替换。2026-08-12 起公开入口、IPC 与调度器完整退役；旧数据仅保留为审计历史。本文不再是当前实现合同。

## 0. 交付目标

把现有隐藏的 Agent cron 半成品迁移成用户可用、可恢复、可追踪的定时任务功能，并在聊天输入框上方的四模式切换器右侧增加独立时钟入口。

本计划不包含 RSS 后台刷新；RSS 先按自身确定性调度完成修复。两者只共享调度工程经验。

## 1. 完成定义

- 时钟按钮、管理面板、创建/编辑表单和执行历史可在真实 Electron 中使用。
- 一次、每天、工作日、每周、每月、每年、间隔和自定义日历规则可创建并展示未来时间。
- Main 独立于 sidecar 计算和领取到期任务。
- 每次到点都有 durable occurrence，崩溃、重启、休眠和重复事件不会造成双跑。
- 定时指令经正确 scope 进入生产 Agent 主链，运行时正常选择工具与 skill。
- 高风险操作继续走现有确认；退出、重启或超时后确认作废，不能自动批准或补执行。
- 同一 schedule 不并发；繁忙会话不被后台任务抢占。
- 旧数据迁移明确，无 scope 旧任务暂停等待修复，不保留 unscoped legacy 发送。
- 专项 gate、`typecheck`、`verify:native`、真实 Electron 时钟与重启验证全部通过。

## 2. 不可破合同

1. **先合同后代码**：先写纯函数的时间、claim、状态机和迁移测试，再接 UI。
2. **单一权威**：Main + SQLite 是通用定时任务真值；sidecar 不再同时触发。
3. **先落 occurrence 后执行**：没有 durable occurrence 的触发不得进入 Agent。
4. **幂等领取**：同一个计划时刻只能领取一次。
5. **明确 scope**：新任务 scope 必填；旧无 scope 任务暂停，不走 unscoped fallback。
6. **正常 Agent 主链**：不直接调工具，不冻结 skill，不复活退役状态机。
7. **不抢占**：后台 occurrence 只在目标 scope 空闲时派发，用户消息优先。
8. **确认不降级**：未来时间授权不等于未来动作确认。
9. **Main 算时间**：Renderer 只展示 Main 返回的 `nextRunAt` 与预览结果。
10. **通知不是数据库**：Renderer 漏掉事件时重新 list 仍能恢复完整状态。

## 3. 目标数据合同

### 3.1 任务定义

在下一条顺序 migration 中创建结构化的 `scheduled_tasks`，从旧 `agent_schedules` 一次性搬迁后删除旧表、旧 IPC 和 sidecar cron 入口。迁移可以暂时经过两张表，但生产运行时绝不能双读或双调度。建议字段：

```text
instruction                  TEXT NOT NULL
schedule_spec_version        INTEGER NOT NULL DEFAULT 1
schedule_spec_json           TEXT NOT NULL
timezone                     TEXT NOT NULL
scope_id                     TEXT
agent_id                     TEXT NOT NULL
workspace_roots_json         TEXT NOT NULL DEFAULT '[]'
missed_policy                TEXT NOT NULL DEFAULT 'coalesce_latest'
last_occurrence_at           TEXT
next_run_at                  TEXT
migration_state              TEXT
```

旧 `prompt` 在迁移后成为 `instruction` 真值或被明确退役；旧 `cron_expr` 只保留到迁移完成，不再让新代码双读。不要长期保留“两套字段择一”的兼容分支。

`schedule_spec_json` 使用 discriminated union：

```ts
type ScheduleSpecV1 =
  | { kind: 'once'; localDate: string; localTime: string }
  | { kind: 'interval'; every: number; unit: 'minute' | 'hour' | 'day'; anchorAt: string }
  | {
      kind: 'calendar'
      frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
      localTime: string
      weekdays?: number[]
      months?: number[]
      dayOfMonth?: number
      lastDayOfMonth?: boolean
      until?: string
      count?: number
    }
```

### 3.2 执行账本

新增 `agent_schedule_occurrences`：

```text
id, schedule_id, scheduled_for, triggered_at, trigger_source,
claim_status, attempt, run_id, task_id,
delay_ms, started_at, finished_at,
error_kind, error_message, created_at, updated_at
```

约束与索引：

- 确定性 `id` 或唯一 `(schedule_id, scheduled_for, trigger_source_key)`。
- `(claim_status, scheduled_for)` 用于恢复扫描。
- `(schedule_id, created_at DESC)` 用于历史列表。
- 删除 schedule 时 occurrence 默认保留审计，任务定义使用软删除或快照字段；若产品决定硬删，必须先把名称/指令摘要快照到 occurrence。

### 3.3 Renderer wire 类型

共享类型必须明确：

- `AgentScheduleDefinition`
- `ScheduleSpecV1`
- `AgentScheduleOccurrence`
- `SchedulePreview`
- `ScheduleBlockedReason`
- `ScheduleMutationRequest`

禁止 Renderer 继续依赖松散的 `Record<string, unknown>` payload 解释 scope、Agent 和 workspace。

## 4. 分阶段实施

### P0 — 时间与状态合同

目标：在不接 Electron、DB 或 Agent 的情况下证明所有关键规则。

新增纯模块建议：

- `src/main/modules/scheduled-tasks/schedule-spec.ts`
- `src/main/modules/scheduled-tasks/schedule-next-run.ts`
- `src/main/modules/scheduled-tasks/schedule-occurrence-state.ts`

时间计算复用仓库已有的 `@js-temporal/polyfill`，不再引入第三套日期库；日历现有 `timezone-utils` 可借鉴，但定时任务的预览与运行必须收敛到自己的同一计算入口。

先红测试：

1. once/daily/workday/weekly/monthly/yearly/interval/custom-calendar 的未来三次时间。
2. IANA 时区跨日与非整数 UTC 偏移。
3. 春季不存在时间顺延，秋季重复时间只出现一次。
4. 月份没有第 29/30/31 日时跳过。
5. 应用关闭 10 分钟、2 小时、2 天后的 missed policy。
6. 多个错过周期合并成最新一次。
7. 同一 scheduledFor 的重复 reconcile 产生同一 occurrence id。
8. schedule 被编辑后旧 occurrence 不被重算或篡改。
9. 无法产生未来时间的规则、秒级表达、低于 5 分钟 interval 被拒绝。

Gate：所有纯函数测试通过；时间计算器不依赖 Renderer 或 sidecar。

### P1 — Main 单一调度权威与迁移

目标：Main 能在没有 sidecar 的情况下持久安排、领取和恢复 occurrence。

建议新增：

- `schedule-repository.ts`：任务与 occurrence 的唯一 DB 读写入口。
- `schedule-coordinator.ts`：start/stop/reconcile/reschedule。
- `schedule-clock.ts`：one-shot timer 与注入时钟适配。

主进程接线：

- app ready 后数据库和 Agent runtime 可用时启动 coordinator。
- `powerMonitor.resume` 调用同一 `reconcile('resume')`。
- app shutdown 只清内存 timer。
- 创建、编辑、暂停、恢复、删除后调用 `reschedule()`。

事务合同：

1. 读取 due schedule。
2. 插入或领取 occurrence；唯一冲突视为已领取。
3. 计算并落库下一次时间。
4. 提交事务。
5. 将 occurrence 放入执行队列。

迁移规则：

- 有 `payload.scopeId/conversationId` 的旧任务：迁移 scope、Agent、workspace；能无歧义转成结构化规则的旧 cron 按 UTC 迁移。
- 无 scope 的旧任务：迁移为暂停 + `migration_state='needs_scope'`，在面板提示选择会话。
- 无法无损转成结构化规则或本身非法的 cron：暂停 + `migration_state='needs_schedule_review'`，由用户确认新规则，不能留下运行时双读分支。
- 移除 sidecar 的 schedule mirror、schedule trigger 轮询和 `/cron` 调度所有权；不能 Main 与 sidecar 双跑。
- `skills_schedules` 保持内部 skill action 调度，不接入新面板，也不冒充 Agent 定时任务。

先红测试：

- sidecar 未启动/远程通道关闭仍会到点。
- 冷启动、休眠恢复、重复 reconcile 只领取一次。
- 更新频率立即改排；暂停/删除清除内存 timer。
- 旧 scope 数据正确迁移；无 scope 数据被暂停。
- 崩溃发生在 claim 后、执行前，重启可恢复 queued occurrence。

Gate：Main scheduler 聚焦测试 + `npm run verify:native`。

### P2 — Agent 执行队列、权限与结果

目标：occurrence 可靠进入生产 Agent 主链，且不抢占会话。

改造 `schedule-execution.ts`：

- 输入从 `AgentScheduleRecord` 升级为 definition + occurrence。
- 用户可见内容保留 `userRequestVerbatim`，schedule 来源放 meta/envelope。
- 移除 `[cron:name]` 可见前缀。
- 移除 unscoped send fallback。
- `runScheduleNow` 先建 manual occurrence，再走相同队列。
- Agent 接收前的派发成功/失败写 occurrence claim；Agent 接收后的运行、确认与终态只通过现有 TaskProjection / run finalization 关联展示。

新增 scope-aware queue：

- 同一 schedule 单实例。
- 同一 scope 串行，用户主动 run 优先。
- scope active 时 queued，不调用会抢占旧 run 的 send。
- dispatch 后写 `runId/taskId`；所有终态经现有 run finalization 和 projection 真值回流。
- RunCoordinator 输入增加结构化 `taskOrigin='system_background'`、`runOrigin='scheduled_task'` 和 occurrence 来源；不能把后台任务伪装成普通 user root。

确认合同：

- 后台高风险动作使用现有 pending confirmation，并把 occurrence/run/scope 关联带到确认卡。
- 应用仍运行且未超时时，批准继续同一 run；拒绝或过期有明确终态。
- app 退出或重启后冻结确认作废，不能恢复执行或从指令开头重跑。

工具/skill 测试：

- 指令明确点名 skill 时 capability floor 生效。
- 指令未点名时模型仍能经 `use_skill` 选择。
- 未安装/失效 skill 明确失败或等待配置。
- provider 不支持工具时不伪装已完成。
- 非浏览器高风险工具不会自动执行。
- schedule turn 使用正确 Agent、scope、workspace 和原文。

Gate：Agent schedule 行为测试、稳定性相关 gate、真实会话执行 proof。

### P3 — IPC 与实时投影

目标：UI 只消费结构化真值。

目标 IPC：

```text
scheduledTasks:list
scheduledTasks:get
scheduledTasks:preview
scheduledTasks:create
scheduledTasks:update
scheduledTasks:pause
scheduledTasks:resume
scheduledTasks:delete
scheduledTasks:runNow
scheduledTasks:listOccurrences
scheduledTasks:onChanged
```

要求：

- Main handler、preload API、Renderer 类型同时修改。
- `previewSchedule` 与真实 next-run 使用同一计算函数。
- `onScheduleChanged` 只是失效通知；UI 收到后重新 list/get，避免事件载荷变成第二真值。
- mutation 统一返回 typed error kind：非法时间、目标缺失、冲突、不可编辑状态等。
- IPC 注册/注销和 payload validation 有行为测试。

Gate：IPC contract、preload/renderer typecheck、重启后 list readback。

### P4 — 时钟入口与管理面板

目标：按设计文档完成最小完整 UI。

建议文件边界：

- `ChatPanel.tsx`：只负责把独立入口放进 mode dock；开关状态和工作区界面由 Workbench 宿主持有。
- `ScheduledTasksButton.tsx`：按钮、badge、tooltip、无障碍。
- `ScheduledTasksWorkspace.tsx`：中间工作区容器与 BrowserView 持续遮罩。
- `ScheduledTasksPanel.tsx`：液态玻璃界面壳、筛选、加载/错误/空状态。
- `ScheduledTaskEditor.tsx`：创建/编辑表单与 schedule preview。
- `ScheduledTaskCard.tsx`：列表卡和快捷动作。
- `ScheduledTaskHistory.tsx`：occurrence 历史与处理入口。
- `scheduled-tasks.css`：独立样式，复用现有液态玻璃 token。

不要把面板塞进 `DraggableModeTabs.tsx`，也不要把大量业务继续堆进 `ChatPanel.tsx`。

行为测试：

1. 时钟按钮在四模式切换器右侧，但四模式数组仍只有四项。
2. 点击、键盘、Esc 的开关行为；工作区界面不因点击内部空白误关。
3. 空状态、新建、编辑、暂停、恢复、删除、立即运行。
4. 自定义规则无效时不能保存，预览未来三次与 Main 一致。
5. badge 区分启用和需要处理。
6. 失败、scope 缺失、待确认都能直接看懂并进入处理。
7. 浅色/深色、缩放、窄侧栏、输入框展开状态无裁切。
8. 打开时持续隐藏 BrowserView，关闭后恢复；玻璃投影不递归复制自身。

真实 Electron 验证：

- 按用户截图位置核对按钮尺寸、间距、层级和点击热区。
- 独立界面打开时左右侧栏仍可见，顶部、滚动区与保存区无裁切。
- 真实创建一个两分钟后任务并观察自动入会话。

### P5 — 恢复、诊断与发布 gate

目标：证明这不是“当前会话里看起来能用”的一次性 UI。

真实场景矩阵：

| 场景 | 必须观察到 |
| --- | --- |
| 正常到点 | ±10 秒内创建 occurrence 并开始排队/执行 |
| Ready 关闭后错过一次性任务 | 下次启动补跑一次，显示延迟 |
| Ready 关闭后错过多个重复周期 | 只补最新一次，其余记为合并/错过 |
| macOS 睡眠跨过计划时刻 | resume 后一次补跑 |
| 到点时目标 scope 正在运行 | 后台任务排队，不抢占 |
| 同一 schedule 执行超过下个周期 | 不并发，只保留最新待执行 |
| 执行中强杀应用 | 重启按 durable handle 恢复或明确 interrupted，不重复外部动作 |
| 等待确认时重启 | 原确认明确过期，之前高风险动作不补执行；用户可手动重新运行 |
| sidecar 关闭 | 定时任务正常运行 |
| scope 被删除 | 自动暂停并提示修复，不发到其他会话 |
| provider/skill 配置丢失 | 明确 blocked/failed，可修复后重试 |

日志与诊断：

- 记录 schedule/occurrence/run 三种 id、计划时间、领取来源、状态变化和 error kind。
- 不记录密钥、完整附件内容或不必要的用户敏感原文。
- 面板历史与诊断日志必须能按 occurrence id 对齐。

## 5. 验证命令

实施时按实际 package scripts 补一个 `verify:agent-schedules` 聚合入口，至少包含：

```bash
npm run typecheck
npm run verify:ipc-contract
npm run verify:native
npm run verify:stability
npm run test
npm run build
```

若全量测试存在与本功能无关的既有失败，必须给出独立复现和边界证明；专项 gate 本身不得 skip 或以 source grep 冒充行为通过。

### 2026-07-13 实际验收记录

- 真实 Electron 中完成了中心工作区、创建、自动到点、会话回流、删除和重启读回验收。测试任务在 `2026-07-13 14:20:00 +08:00` 到点创建唯一 occurrence，并在约 3 秒后把原始指令的结果写回专用会话；验收任务随后已删除，历史账本保留。
- 真实界面确认：左右侧栏保留，编辑器顶部、滚动区和保存区无裁切；BrowserView 在工作区打开期间持续隐藏；面板使用液态玻璃且无外围阴影；独立时钟按钮为 36×36 圆形，图标与四模式入口同尺寸、同灰度，激活时为亮白状态。
- 对抗性审查及修复循环后，`typecheck`、IPC 合同、Electron 原生 ABI、原生 SQLite 迁移与账本 2/2、定时任务及相邻生产入口测试 62/62、CSS 层级检查、正式构建和差异格式检查全部通过，无 skip。
- 定时任务专项恢复测试覆盖了休眠恢复后的跨点合并、繁忙 scope、重叠周期、执行中强杀后的明确中断且不重发、等待确认时重启后确认过期且不补动作、目标缺失、provider 派发失败，以及已点名 skill 临时失效时明确失败。真实 Electron 直接观察了正常到点，以及应用关闭后重启读回并在随后计划时刻正常触发；未把物理休眠整台开发机或强杀真实外部 provider 冒充人工真机证明。
- 聚合入口中的 `verify:stability` 仍被本功能外既有文件 `agent-sdk-turn-execution.ts` 的 904 行上限（阈值 900）拦截；全量测试仍有既有 Electron/Node 原生 ABI 隔离失败和一项 skill hint 断言失败。定时任务专项测试未失败，正式构建通过，边界已独立复现。

## 6. 文件改动边界

预计会触及：

- Main：schedule repository/coordinator/clock/execution、database migration、app lifecycle。
- Preload/shared：结构化 schedule/occurrence 类型和 IPC。
- Renderer：ChatPanel mode dock、新按钮、面板、编辑器、历史和样式。
- Tests：时间纯函数、SQLite、IPC、scope queue、Agent tool/skill、UI behavior、真实 Electron fixture。
- Docs：完成后把已经落地且稳定的合同摘要写入 `current-runtime-contracts.md`，并更新本计划状态与真实 gate 结果。

不应触及：

- `WorkbenchMode` 四模式定义。
- RSS 获取业务与 RSS 自动刷新状态机。
- 已退役的 direct-chat/turn-engine/skill_executions 路径。
- 无关 UI 重排、全局 CSS reset 或 sidecar 远程通道行为。

## 7. 发布顺序

1. P0 时间合同。
2. P1 Main 调度与数据迁移。
3. P2 Agent 队列、权限和账本。
4. P3 IPC/readback。
5. P4 时钟按钮与面板。
6. P5 恢复矩阵与真实 Electron 证明。

P1 未完成前不能只发布 UI；P2 未完成前不能宣称“Agent 可自动完成所有事情”；P5 未通过前不能默认启用旧任务迁移。

## 8. 最终验收清单

- [x] 用户能从截图标记位置打开定时任务工作区。
- [x] 四模式切换仍只有 browser/document/rss/calendar。
- [x] 创建、列表、编辑、暂停、恢复、删除、立即运行可用。
- [x] 下一次执行由 Main 计算并能跨重启读回。
- [x] 任务不依赖 sidecar，关闭 sidecar 时仍会触发。
- [x] 一次/重复/自定义日历/时区/DST/错过执行合同全部有测试。
- [x] occurrence 状态与历史可追踪，无双跑。
- [x] 正确 scope/Agent/workspace 收到原始指令。
- [x] 每次运行重新进入生产 Agent 主链选择工具和 skill，不冻结旧工具面。
- [x] 高风险动作沿用生产确认边界，后台任务没有额外权限。
- [x] 目标会话繁忙时不抢占。
- [x] 重启读回及随后到点已完成真实 Electron 验收；休眠跨点、执行中强杀、等待确认时重启和已点名 skill 临时失效均有定时任务专项恢复测试，且不会双跑或补执行高风险动作。
- [x] `typecheck`、专项 gate、`verify:native` 和 build 通过；全仓既有稳定性/全量测试失败已独立记录边界。
- [x] 大文件健康日志按实际净增情况更新。
