---
title: Ready Agent 定时任务产品与架构设计
date: 2026-07-13
status: superseded
enforce: false
implementation_plan: ../plans/2026-07-13-agent-scheduled-tasks-implementation.md
---

# Ready Agent 定时任务产品与架构设计

> 历史记录：该产品入口所依赖的 Agent 执行链已被 Codex 生产主链替换。2026-08-12 起公开入口、IPC 与调度器完整退役；旧数据仅保留为审计历史。本文不再是当前产品合同。

## 0. 结论

Ready 不需要从零再造一套“cron 工具”。仓库里已经有持久化、IPC、Python sidecar 定时触发和把指令送进指定会话的半成品，但它还不是可交付的用户功能。

目标形态是：**一个持久、可追踪的时间触发器，在到点时向绑定的会话发起一轮正常 Agent 任务。** 这一轮继续使用生产主链，由 Agent 根据当时的指令、上下文、配置和授权选择工具与 skill；定时任务本身不冻结工具清单，也不获得额外权限。

入口放在聊天输入框上方四模式切换器的右侧，作为独立的时钟按钮。它不是第五个 Workbench mode，也不改变 `browser | document | rss | calendar` 的既有语义。

## 1. 本文完成标准

本文必须把以下问题写成可验证合同，而不是只画界面：

1. 什么内容被持久化，什么内容每次执行时重新解析。
2. 一次、每天、每周、每月、间隔和 cron 如何表达。
3. 时区、夏令时、休眠、关机、错过执行与重复触发如何处理。
4. 定时任务怎样进入正确的会话、Agent 和工作区。
5. 工具、skill、权限确认、外部登录和失败如何处理。
6. 同一任务重叠、同一会话繁忙、重试和手动“立即运行”如何处理。
7. 用户怎样创建、查看、暂停、编辑、删除和追踪结果。
8. 现有半成品哪些复用、哪些必须退役，避免双调度和 legacy 分支。

## 2. 假设与范围

### 2.1 假设

- 第一版是本机能力，只有 Ready 运行时才能真正执行；关机期间的任务在下次启动时按错过执行规则处理。
- 用户创建任务时绑定 Agent 和工作区。默认由 Main 同时创建一个专用的持久任务会话，避免周期结果污染当前聊天；高级选项可明确改为当前会话。
- 用户指令原文是主要意图来源。Agent 在每次触发时重新做工具与 skill 选择。
- 用户使用“一次 / 每天 / 工作日 / 每周 / 每月 / 每年 / 每隔一段时间”等结构化规则。第一版不暴露原始 cron 文本；“类似 cron”指覆盖常见时间组合，而不是要求用户学习表达式。
- 最小时间精度为分钟。秒级自动化不在第一版范围内。

### 2.2 不做

- 不把时钟按钮做成第五个工作台模式。
- 不允许定时任务绕过操作确认、站点登录、系统权限或 provider 能力限制。
- 不让用户预先勾选一个永久不变的工具清单。
- 不把现有 `skills_schedules` 直接包装成新面板；普通定时任务必须进入完整 Agent 主链，具体 skill 由该轮选择。
- 不依赖系统 crontab、launchd 或 Windows Task Scheduler；它们无法自然承载 Ready 的会话、权限、任务投影和结果回写。
- 不把原始 cron 作为普通用户界面或新的 wire contract；已有 cron 只作为一次性迁移输入。
- 不把调度业务塞进 `AgentSdkTurnOrchestrator`。调度器只负责产生一次待执行任务，Agent 主链只负责执行。

## 3. 当前实现真值

### 3.1 已有、可复用

| 能力 | 当前落点 | 判断 |
| --- | --- | --- |
| 任务定义持久化 | `agent_schedules`、`DatabaseManager` | 可迁移复用 |
| 创建、列表、暂停、恢复、删除、立即运行 IPC | `claude-bridge/ipc/schedule-group.ts` 与 preload 类型 | 可演进，不能直接当成最终合同 |
| 送入指定会话 | `schedule-execution.ts -> sendScoped()` | 正确主方向 |
| 会话、Agent、工作区元数据 | `payload_json` | 现为松散字段，需结构化 |
| Agent 正常工具和 skill 选择 | `sendScoped -> RunCoordinator -> AgentSdkRuntime` | 必须继续复用 |
| cron 触发 | Python sidecar + APScheduler | 只能作为现状迁移来源，不应成为最终唯一时钟 |
| 手动立即运行 | `ScheduleService.runScheduleNow()` | 可复用语义 |

### 3.2 现状不能直接上线的原因

1. 调度依赖可选的 Python sidecar 和 `remote_channels_enabled / sidecar_autostart`；关闭远程通道可能连定时任务也一起停。
2. sidecar 只保有内存镜像，应用停止后没有执行；重新启动时没有可靠的错过执行结算。
3. 所有 cron 固定按 UTC 解释，没有用户时区和夏令时合同。
4. 数据库的 `next_run_at` 没有成为调度真值；执行成功后还会被清空。
5. 触发事件是内存队列，队列在崩溃时可丢，且没有 occurrence 幂等键。
6. 只有 `last_run_at`，没有逐次执行账本，无法回答“为何没跑、跑到哪、是否等待确认”。
7. 同一任务只在 sidecar 内限制单实例；Main 收到事件后没有 durable claim，崩溃重启可能重复执行。
8. 无 scope 的旧任务会走 unscoped legacy 发送；正式产品不能把结果发到不确定的位置。
9. 指令被改写成 `[cron:名称] ...`，用户原文与系统来源没有分层。
10. 直接向繁忙会话发送可能抢占当前 run；定时任务需要排队，不能干扰用户正在进行的对话。
11. 高风险工具确认依赖当前交互窗口且冻结上下文不能跨重启；后台触发时必须可见地等待，退出或超时后明确作废，不能静默失败或自动补执行。
12. Renderer 没有真正的管理面板，用户看不到下一次执行、历史、失败和待确认状态。

## 4. 第一性原理模型

定时任务不是一次“延迟调用工具”，而是三层对象：

```text
ScheduleDefinition（用户长期意图）
        ↓ 到点并领取
ScheduleOccurrence（这一次是否应执行、何时执行、状态如何）
        ↓ 会话空闲且权限可用
Agent Run（正常生产主链，自己选择工具与 skill）
```

三个对象必须有不同身份：

- `scheduleId`：长期任务身份；编辑后仍可追踪同一任务。
- `occurrenceId`：某个计划时刻的唯一身份，建议由 `scheduleId + scheduledFor` 确定性生成。
- `runId/taskId`：真正 Agent 执行身份，由现有运行主链创建。

只有 `ScheduleOccurrence` 能解决崩溃恢复、重复触发、历史记录、错过执行，并把一次触发可靠关联到后续确认和结果。只在 `agent_schedules` 上写 `last_run_at` 不足以构成交付级功能。

## 5. 用户可见模型

### 5.1 创建字段

| 字段 | 第一版行为 |
| --- | --- |
| 名称 | 可自动取指令首句，用户可改 |
| 指令 | 保存用户原文，不添加可见前缀 |
| 频率 | 一次、每天、工作日、每周、每月、每年、间隔、自定义日历规则 |
| 时间 | 根据频率显示日期、时间、星期、月日或间隔 |
| 时区 | 默认当前系统 IANA 时区，明确展示，可修改 |
| Agent | 默认当前会话 Agent，可选择其他已配置 Agent |
| 会话 | 默认新建专用任务会话；可明确选择当前会话；保存时必须落成真实 scope |
| 工作区 | 默认当前工作区；执行时必须仍可访问 |
| 状态 | 启用或暂停 |

“高级设置”只放低频选项：结束日期、执行次数和错过执行策略。重叠策略第一版固定，不让普通用户承担不必要选择。

### 5.2 频率表达

- **一次**：本地日期 + 本地时间 + 时区。
- **每天**：每天本地时间。
- **每周**：一个或多个星期 + 本地时间。
- **每月**：月中日期 + 本地时间。不存在该日期的月份跳过，不偷偷改成月末。
- **间隔**：从明确锚点开始，每 N 分钟 / 小时 / 天；最小 5 分钟，避免误触发和平台压力。
- **每年**：月份、日期和本地时间。
- **自定义日历规则**：在结构化选择器中组合月份、月日、星期、时间、结束日期或执行次数；界面即时显示未来三次执行时间，无法产生下一次时间时禁止保存。

持久化不能只保存 cron 字符串。应保存带版本的结构化 `schedule_spec`；旧 cron 只用于迁移，迁移完成后新主链不再读它。

### 5.3 时区和夏令时

- 保存 IANA 时区，例如 `Asia/Singapore`，不只保存 UTC 偏移。
- 系统时区改变后，任务仍按自己保存的时区运行；面板提示“当前系统时区已变化”。
- 春季跳时导致某个本地时间不存在：在当天第一个有效时刻执行一次，并标记“因夏令时顺延”。
- 秋季回拨导致同一个本地时间出现两次：只执行一次；occurrence key 以任务时区下的计划日期和时间去重。
- 时间预览与真实调度必须使用同一套计算器，禁止 Renderer 和 Main 各算一套。

### 5.4 错过执行

第一版固定为可解释的默认值：

- 一次性任务：下次 Ready 启动或从休眠恢复时补跑一次，并标明延迟时长。
- 重复任务：24 小时内错过多个周期时只补最新一次；更早的周期记录为“已错过”，不集中轰炸。
- 用户选择“错过就跳过”时，只记账，不执行。
- 补跑与正常到点使用同一 occurrence claim，不能各跑一次。

### 5.5 重叠与会话繁忙

- 同一 `scheduleId` 同时最多有一个执行中 occurrence。
- 执行期间再次到点：只保留一个最新待执行 occurrence，旧的合并为 `skipped_coalesced`。
- 目标会话正由用户或其他任务执行时：定时 occurrence 进入队列，不抢占当前 run。
- 用户消息优先于后台队列。会话空闲后再启动最早的有效 occurrence。
- “立即运行”也创建 occurrence，使用相同队列、权限和记账流程，不开旁路。

## 6. Agent、工具与 skill 合同

### 6.1 正确入口

到点后调度层构造一条结构化的 scheduled-turn envelope，再通过 `sendScoped()` 进入生产主链。至少包含：

- `scheduleId / occurrenceId / scheduledFor / triggeredAt / triggerSource`
- 绑定的 `scopeId / agent / workspaceRoots`
- `userRequestVerbatim`
- 是否为补跑及延迟时长

系统来源放在 message meta / turn envelope，不污染用户可见原文。

### 6.2 工具与 skill

- 每次执行都按当时的 provider 能力、已安装 skill、外部服务配置和用户指令重新解析。
- 指令明确点名 skill 或文档资源时，继续服从现有 capability floor 与 `SkillTurnIdentity + SkillToolAuthorization`。
- 指令没有点名 skill 时，由模型看 `id/name/description` 后使用 `use_skill`；调度器不写关键词路由。
- 工具或 skill 后来被移除、禁用或未配置时，本次 occurrence 进入失败或等待配置，不使用过期快照硬跑。
- 定时任务不得恢复已经退役的 `skill_executions` 状态机，也不直接调用 `skills_schedules`。

### 6.3 作用域

- 新任务保存时必须绑定真实 `scopeId`。默认由 Main 创建专用持久会话，并与任务写入形成一个完整操作；用户选择当前会话时才复用现有 scope。
- 执行时 scope 已删除：occurrence 标为 `blocked_scope_missing`，任务自动暂停并提示用户修复目标，不创建新隐形会话。
- Agent 不存在或不可用：标为 `blocked_agent_unavailable`。
- 工作区不可访问：标为 `blocked_workspace_unavailable`。
- 禁止最终产品保留 unscoped send fallback。

## 7. 权限与安全

### 7.1 基本原则

“允许每天执行这条指令”不等于“永久批准未来所有外部动作”。调度授权只允许系统在约定时间发起 Agent turn。

### 7.2 创建时预检

保存前做非破坏性预检并展示：

- Agent/provider 是否可用。
- 指令明确点名的 skill 是否安装并配置。
- 明确依赖的浏览器、文件夹、外部连接是否当前可访问。
- 目标会话与工作区是否存在。

预检只给“现在看起来能否运行”的结果，不承诺未来一定可用。

### 7.3 执行时权限

- 读取、研究、分析、生成草稿等继续按现有普通工具合同执行。
- 发送消息、提交表单、删除/覆盖文件、支付、发布、审批等需明确确认的动作，后台 turn 不能自动确认。
- 遇到确认时，Agent 的任务投影进入现有等待确认状态，并在任务面板与目标会话出现确认卡；occurrence 只保存 run/task 关联，不复制第二套确认状态机。
- 应用仍运行且确认未过期时，用户批准后继续同一个 run。拒绝、超时、应用退出或重启时本次确认作废并明确终止；不能在重启后自动补执行已经过期的高风险动作。
- 不允许用户用“以后都同意”绕过现有高风险确认分类。若未来需要有限预授权，必须另立设计合同。

## 8. 持久化与状态机

### 8.1 ScheduleDefinition 最小字段

```text
id, name, instruction, scheduleSpecVersion, scheduleSpecJson,
timezone, scopeId, agentId, workspaceRootsJson,
enabled, nextRunAt, lastOccurrenceAt,
missedPolicy, createdAt, updatedAt
```

`nextRunAt` 是 Main 计算并持久化的真值；Renderer 只展示，不自行推导。

### 8.2 ScheduleOccurrence 最小字段

```text
id, scheduleId, scheduledFor, triggeredAt, triggerSource,
claimStatus, attempt, runId, taskId,
startedAt, finishedAt, errorKind, errorMessage,
delayMs, createdAt, updatedAt
```

唯一约束：`(scheduleId, scheduledFor, triggerSource-normalized)` 或等价确定性 occurrence id。手动立即运行使用独立 manual occurrence id。

### 8.3 状态归属

occurrence 只记录调度与派发状态：

```text
queued -> dispatching -> dispatched
                    \-> dispatch_failed
queued -> skipped_missed / skipped_coalesced / blocked_target
```

`dispatched` 之后，运行中、等待确认、完成、失败、取消和可继续状态全部以现有 TaskProjection / run finalization 为真；面板通过 `runId/taskId` 关联展示，禁止在 schedule 表里复制一套 Agent 状态机。

每次 claim 状态变化必须落库后再发 Renderer 通知。通知丢失时，重新打开面板可从数据库和任务投影恢复真值。

## 9. 调度宿主

### 9.1 Main 是唯一权威

通用 Agent 定时任务应由 Electron Main 拥有：

- Main 本来就拥有数据库、会话、Agent runtime、应用生命周期和 Renderer 通知。
- 定时任务不应依赖远程通道 sidecar 是否启用。
- Python sidecar 可以继续服务远程通道，但它不再拥有通用定时任务的时钟真值。

### 9.2 运行方式

- 启动：扫描启用任务，结算错过 occurrence，领取到期任务，安排最近一个 one-shot timer。
- 变更：创建、编辑、暂停、恢复、删除后立即重新计算最近时间。
- 到点：事务内创建/领取 occurrence，并立即持久化新的 `nextRunAt`，然后才异步执行。
- 休眠恢复：监听 Electron `powerMonitor.resume`，执行同一套 reconcile。
- 防漂移：低频 reconciliation timer 只做校验兜底，不作为主要时间真值。
- 停止：应用退出时取消内存 timer；数据库状态保持可恢复。

### 9.3 崩溃恢复

- `queued`：重新入队。
- `dispatching`：使用稳定 request/source message id 做幂等核对；能证明尚未被 Agent 接收时才重新排队。
- `dispatched`：只关联既有 TaskProjection；有 durable handle 时走现有续跑合同，没有时明确标记中断，不从原指令盲目重放。
- 等待确认时退出或重启：确认过期并明确结束，不恢复或自动执行冻结的高风险动作。

## 10. 界面设计

### 10.1 入口

- 在 `.ready-chat-mode-tabs-dock` 内，把现有四模式切换器与新按钮并列。
- 新按钮是约 36×36 的独立液态玻璃圆形按钮，使用与四模式同尺寸、同灰度和同激活白光的时钟图标，与切换器间距约 8px。
- 不修改 `WorkbenchMode`、`DraggableModeTabs` 的四模式数组和拖拽语义。
- 有启用任务时可显示轻量状态点；有失败或待确认时显示醒目的注意点。不要显示不断跳动的动画。
- Tooltip 与无障碍名称使用“定时任务”。支持键盘聚焦、Enter/Space 打开、Esc 关闭。

### 10.2 独立工作界面

时钟按钮只作为入口；总览、编辑和历史占用中间工作区，左侧导航与右侧聊天栏保持可见。它不是第五个 Workbench mode，也不受聊天输入区高度约束。界面使用应用内液态玻璃底层、细边界且不加外圈悬浮阴影；宽度和高度跟随中间工作区，四周保留小幅安全间距。

空状态：

- 标题“定时任务”。
- 一句话解释“在指定时间让 Agent 自动开始一项工作”。
- 主按钮“新建定时任务”。

列表状态：

- 顶部：标题、启用数量、新建按钮。
- 筛选：全部 / 运行中 / 需要处理。
- 卡片：名称、指令摘要、下次时间、频率、Agent、状态。
- 快捷动作：立即运行、暂停/恢复、编辑、更多（含删除）。删除需确认。
- 失败或待确认卡优先显示原因与“处理”动作，不用模糊红点代替说明。

编辑状态：

- 默认只展示名称、指令、频率、时间、时区、Agent。
- 会话和工作区使用当前值，允许明确修改。
- 保存前展示自然语言预览，例如“每周一至周五 09:00，Asia/Singapore；下次 7 月 14 日 09:00”。
- 自定义规则显示未来三次时间；规则无下一次时间、目标会话缺失或一次性时间已过去时禁止保存并给出直接说明。

历史状态：

- 每个任务可展开最近执行：计划时间、实际开始、耗时、结果、失败原因、对应会话入口。
- `waiting_confirmation` 直接提供“去处理”。
- 补跑显示“应用关闭期间错过，已于启动后补跑”。

### 10.3 独立界面与原生 BrowserView

独立界面跨越中间画布。打开时必须持有 BrowserView 遮罩锁并隐藏原生内容；关闭或卸载时释放锁，由 BrowserMode 重新显示活动页并同步 bounds。液态玻璃背景只能复制界面背后的工作内容节点，不能复制包含自身的祖先节点，避免递归投影和显存增长。

## 11. RSS 自动刷新与通用定时任务的边界

RSS 自动刷新可以复用“Main 单实例调度、冷启动补跑、持久化真值、Renderer 通知”的工程模式，但不应该建成一个隐藏 Agent 定时任务：

- RSS 刷新是确定性的产品后台同步，不需要模型判断。
- 它应直接调用 RSS 获取服务，避免耗费模型、被会话繁忙阻塞或触发不必要的工具授权。
- 用户创建的“每天总结我关注的 RSS”才是 Agent 定时任务：到点后 Agent 可以先读最新 RSS，再总结或执行其他步骤。

因此，两者先后顺序是：先修好 RSS 自身后台刷新；再按本文实现通用定时任务。二者共享原则，不共享业务状态机。

## 12. 成功标准

功能只有同时满足以下条件才可对用户开放：

1. 不打开定时任务面板也会到点执行。
2. 关机、重启、休眠恢复后的补跑规则可预测且不会重复。
3. 时区与夏令时行为有自动测试和真实时钟验证。
4. 执行进入绑定会话和工作区，原文可追溯。
5. 工具与 skill 在执行时通过正常主链选择。
6. 高风险动作不会因“这是定时任务”而绕过确认。
7. 同一任务不并发，同一会话不会被后台任务抢占。
8. 用户能看见下一次执行、最近历史、失败和待处理事项。
9. 关闭 sidecar 或远程通道后，通用定时任务仍可运行。
10. 旧无 scope 任务不会继续偷偷走 unscoped fallback。
