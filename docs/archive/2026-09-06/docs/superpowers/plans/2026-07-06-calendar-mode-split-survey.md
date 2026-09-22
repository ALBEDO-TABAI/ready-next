---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# CalendarMode 拆分探察（仅缝图，不施工）

日期：2026-07-06
范围：`src/renderer/pages/modes/CalendarMode.tsx`

## 结论

本轮不建议盲切 `CalendarMode.tsx`。它的主要复杂度不是 JSX 行数，而是多个闭包共享同一批状态：可见窗口加载、Schedule-X runtime、事件编辑弹窗、提醒 capsule、远程消息建议、来源订阅同步和 Agent 日历工具适配器互相读取同一份 `events/sources/currentDate/viewType`。

安全做法是先抽确定性纯 helper，再抽 UI 壳；真正拆 hook 前需要先给状态边界写行为测试。

## Hook 与依赖地图

核心状态：

- `currentDate`：驱动 Schedule-X 当前窗口、header、mini/month grid、agent summary、导航、远程建议创建后跳转。
- `events` / `eventsRef`：Schedule-X 事件源、mini/month 投影、事件编辑/删除 optimistic update、agent adapter、助手摘要。
- `sources`：事件颜色投影、来源侧栏、远程建议目标日历、agent adapter、助手摘要。
- `selectedDate`：侧栏选中日期和 cache。
- `isMock` / `dataLoaded` / `hasActivated` / `loadError`：Electron IPC 加载、mock 标识、懒初始化和错误展示。
- `viewType`：Schedule-X 视图、header、导航跨度、agent adapter。
- `assistantOpen`：CalendarWorkbenchShell 助手抽屉开关。
- `modalOpen` / `modalMode` / `editingEvent` / `modalDefault*`：EventModal create/edit/quick-create 共用状态。
- `reminderCapsule`：提醒 IPC 推送、点击跳转、自动消失。
- `remoteSuggestion` / `remoteSuggestionBusy` / `remoteSuggestionError`：远程消息建议卡和创建日程流程。
- `menuSubscribeOpen` / `menuSubUrl` / `menuSubName` / `menuSubError`：新建菜单里的订阅弹窗。

关键 refs：

- `mainViewRef` / `createButtonRef`：传给 quick-create 和 WorkbenchShell。
- `becameVisibleRef`：控制首次激活加载。
- `lastFetchedWindowRef`：避免同月重复拉取。
- `remoteSuggestionSeenRef`：去重远程建议。
- `menuPickIcsFileInputRef`：菜单触发隐藏文件选择器。

关键 memo/callback：

- `coloredEvents` 依赖 `events + sources`，是 Schedule-X 和投影的共同输入。
- `fetchEventsForWindow` 写 `events/loadError/lastFetchedWindowRef`，被初始加载、月切换、事件保存/删除后刷新复用。
- `loadCalendarData` 写 `events/sources/isMock/dataLoaded/loadError`，被激活 effect、同步来源、远程建议和 modal 保存/删除复用。
- `handleModalSave` 捕获 `modalMode/editingEvent/createCalendarEvent/loadCalendarData`，同时写 modal state 与 events。
- `handleDeleteEvent` 捕获 `eventsRef/loadCalendarData`，依赖 EventModal 写入的 window 临时 scope。
- `calendarAssistantSummary` 依赖 `coloredEvents/currentDate/enabledSourceIds/sources`。
- `calendarContextValue` 依赖 edit/update/delete/sources，是 CalendarProvider 的公开合同。

## 候选缝图

### 缝 A：纯 helper 外移（低风险）

可移动：

- `getDateRange`
- `overlapsRange`
- wire event normalization 内部可先抽为 `parseCalendarEventForRenderer(rawEvent)`

需要 props/state：无。

验证：

- `calendar-wire-round-trip`
- `calendar-event-sync-contract`
- `calendar-month-fallback-interactions`

风险：低。注意 `getDateRange` 同时传给 `useCalendarAgentAdapter`，导出路径要稳定。

### 缝 B：订阅 / 导入菜单状态 hook（中风险）

候选文件：`src/renderer/modules/calendar/useCalendarSourceMenuActions.ts`

需要提升/传入：

- `loadCalendarData`
- `setLoadError`
- `menuPickIcsFileInputRef`
- `menuSubscribeOpen/menuSubUrl/menuSubName/menuSubError`
- `handleImportIcs/handleSubscribeUrl/handleSyncSourceNow/handleMenuIcsFileChange/submitMenuSubscribeForm`

风险：中。`handleImportIcs` 和 `handleSubscribeUrl` 当前故意不把 `loadCalendarData` 放进 deps；抽 hook 前要决定用 ref 固定最新函数，还是补齐依赖并接受函数重建。

### 缝 C：EventModal 控制 hook（高风险）

候选文件：`src/renderer/modules/calendar/useCalendarEventModalController.ts`

需要提升/传入：

- `modalOpen/modalMode/editingEvent/modalDefaultHour/modalDefaultDescription/modalDefaultReminders/modalDefaultRecurrenceRule`
- `createCalendarEvent`
- `eventsRef/setEvents`
- `loadCalendarData`
- `setSelectedSessionEvent`
- `quickCreate`

风险：高。`handleModalSave` 同时处理普通事件、重复事件单次覆盖、未来拆分、series 更新和 optimistic UI；`handleDeleteEvent` 还读取 `window.__readyCalendarPendingDeleteScope`。拆前必须补事件编辑/删除行为测试。

### 缝 D：提醒与远程建议浮层（中风险）

候选文件：

- `CalendarReminderCapsule.tsx`
- `CalendarRemoteSuggestionCard.tsx`
- 可选 hook：`useCalendarRemoteSuggestion`

需要 props：

- reminder：`reminderCapsule/displayTimezone/handleReminderCapsuleClick/handleReminderCapsuleDismiss`
- remote suggestion：`remoteSuggestion/remoteSuggestionBusy/remoteSuggestionError/displayTimezone/handleRemoteSuggestionCreate/handleRemoteSuggestionDismiss`

风险：中。UI 本身独立，但点击会写 `currentDate`、`selectedSessionEvent` 并触发 `loadCalendarData(true)`。

### 缝 E：助手摘要与 ask-agent（中风险）

候选文件：`src/renderer/modules/calendar/useCalendarAssistantSummary.ts`

需要传入：

- `coloredEvents`
- `enabledSourceIds`
- `sources`
- `currentDate`
- `headerTitle`

风险：中低。摘要计算纯度较高，但 `handleCalendarAssistantAskAgent` 写 agent 输入框，不能移动到纯 shared 层。

### 缝 F：CalendarWorkbenchShell props 装配（高风险）

候选文件：`CalendarModeShellHost.tsx`

需要 props：几乎所有当前状态和 handler。

风险：高。不建议作为第一刀；它只减少行数，不降低状态复杂度，还容易让 props 巨表变成新问题。

## 推荐实施顺序

1. 先抽缝 A：纯 helper，补最小测试。
2. 再抽缝 E：助手摘要 hook，保持 `appendToAgentInput` 在 renderer module。
3. 再抽缝 D：两个浮层纯组件，只传 props。
4. 最后评估缝 B/C。事件 modal 控制必须先补重复事件 single/future/series 保存与删除的回归测试。

## 暂不切的原因

- `useScheduleXCalendar`、`useCalendarQuickCreate`、`useCalendarAgentAdapter` 都在主组件内共享状态，当前没有独立状态机边界。
- `loadCalendarData` 是多条路径的共同刷新源，抽错会造成月切换空白、事件保存后不刷新、远程建议创建后不跳转这类隐性回归。
- EventModal 的重复事件逻辑同时依赖 renderer state、IPC 返回和 window 临时 scope，风险最高。
