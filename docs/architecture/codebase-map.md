# Ready 当前代码地图

> 更新时间：2026-10-01
> 本文合并并取代根目录旧的模块图、依赖图和结构快照。它只记录稳定入口，不维护容易失真的文件数量。

## 1. 运行结构

```text
Renderer (React / Zustand)
  -> Preload (window.electronAPI)
  -> Main IPC / runtime
  -> SQLite / 文件系统 / BrowserView / skills / provider
```

- 主进程微入口：`src/main/boot-entry.ts`（构建为 `out/main/index.js`，先显示启动动画）
- 主进程应用宿主：`src/main/index.ts`（由微入口分片预热后动态加载）
- Preload 入口：`src/preload/index.ts`
- Renderer 启动：`src/renderer/main.tsx`
- 应用路由：`src/renderer/App.tsx`
- 跨进程共享：`src/shared/`
- AI 配置与能力：`src/shared/ai-providers.ts`

## 2. 用户工作面

当前工作台模式的代码真值是 `src/renderer/stores/useMode.ts`，只有四种：

| 工作面 | Renderer 入口 | Main 入口 | 主要回归 |
| --- | --- | --- | --- |
| Browser | `src/renderer/pages/modes/BrowserMode.tsx` | `src/main/modules/browser-engine/` | `npm run verify:browser-reliability` |
| Document | `src/renderer/pages/modes/DocumentMode.tsx` | `src/main/modules/document-engine/` | `npm run verify:widget-ready` |
| RSS | `src/renderer/pages/modes/RSSMode.tsx` | `src/main/modules/rss-engine/` | `npm run verify:rss-workspace` |
| Calendar | `src/renderer/pages/modes/CalendarMode.tsx` | `src/main/modules/calendar-engine/` | `npm run verify:calendar` |

Agent、文件面板、技能中心和设置页是跨工作面的能力，不是额外的 Workbench mode。

## 3. Main 模块

`src/main/modules/` 中的主要职责：

| 目录 | 职责 |
| --- | --- |
| `agent-control/` | Agent SDK 回合、会话、任务投影、工具策略、记忆、专项 Agent 与维护回合 |
| `claude-bridge/` | Agent IPC 与 provider 宿主接线；不是旧 DirectChat 执行主链 |
| `tools/` | 工具定义、参数校验、授权后的执行分发 |
| `skills-runtime/` | embedded/custom skill 扫描、安装、运行与长期任务句柄 |
| `browser-engine/` | BrowserView、标签、导航、采集、隐私、Power Browser 与后台任务 |
| `document-engine/` | 文档读写、预览、导出、Widget 与文档任务管线 |
| `rss-engine/` | RSS 订阅、采集、共享查询/正文、栏目归属、自动整理、事件与底稿；任务由 `database/rss-processing-store.ts` 保存，分类结果/当前指针由 `rss-organization-store.ts` 保存，事件/事实/证据由 `rss-event-store.ts` 保存 |
| `calendar-engine/` | 日历事件、来源、提醒与时间解析 |
| `file-emergence/` / `tag-forge/` | 文件涌现、项目身份、注意力信号与受控标签写入 |
| `repositories/` / `database/` | SQLite 数据访问与持久化真值 |
| `settings-engine/` | 设置持久化与迁移 |
| `mcp/` | MCP 配置、连接与授权接线 |
| `search-engine/` | 本地索引与检索 |

主资料库的连接生命周期由 `database.ts` 的 `DatabaseManager` 管理；产品读写位于
`database/rss-store.ts`、`calendar-store.ts`、`browser-store.ts`、`chat-store.ts`、
`settings-store.ts`、`channel-store.ts`。六个 Store 经 `manager.rss/calendar/browser/chat/settings/channels`
共享主连接，已有 Repository 保留产品接口适配，不能再将 SQL 回填到总管理器。
连接合同在 `database/connection.ts`，领域记录类型在 `database/records.ts`；搜索 worker 原有的独立连接边界不受此次拆分影响。
回归入口：`npm run verify:storage`。架构与验收见
[数据保存职责拆分](../superpowers/plans/2026-09-30-database-domain-storage-split-implementation.md)。

完整目录以工作区为准：

```bash
find src/main/modules -mindepth 1 -maxdepth 1 -type d | sort
```

## 4. Agent live 主链

生产执行入口是：

```text
claude-bridge IPC
  -> AgentSdkRuntime
  -> AgentSdkTurnOrchestrator
  -> tool definitions / provider stream
  -> tool executor
  -> finalizeRunOutcome
  -> durable projection + visible closeout
```

关键入口：

- `src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts`
- `src/main/modules/agent-control/runtime-core/agent-sdk-turn-orchestrator.ts`
- `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts`
- `src/main/modules/agent-control/runtime-core/run-finalizer.ts`
- `src/main/modules/tools/tool-executor.ts`

`direct-chat.ts` 与 `turn-engine.ts` 已删除。`run-capability-controller.ts` 仍有 live helper；只有 `resolveRunCapabilities` 没有生产调用方并保留 SDK-shaped parity，不能把该函数当作 live 工具面的权威入口。

## 5. Agent Control 分区

在 `src/main/modules/agent-control/` 修改前，先按职责定位：

- `runtime-core/`：生产回合、provider、frame、终止与连续性。
- `domain-adapters/`：域能力、工具面准备与 capability floors 纯函数。
- `tools-runtime/`、`tool-policy/`：工具注册、结果形状与执行策略。
- `task-projection/`：任务卡与 run 元数据真值。
- `skills/`、`child-run/`、`sub-agent/`：技能或子任务生命周期。
- `session/`、`compaction/`、`system-reminders/`：上下文与会话生命周期。
- `agents/`、`knowledge/`、`maintenance/`、`emergence/`：专项 Agent、知识卡、维护与涌现。
- `safety/`、`quality/`：确认闸门、证据与完成判定。

## 6. Renderer 入口

- 工作台壳：`src/renderer/pages/WorkbenchMode.tsx`
- Agent：`src/renderer/components/agent/ChatPanel.tsx`、`src/renderer/stores/useAgent.ts`
- 文件与侧栏：`src/renderer/components/layout/`
- Browser：`src/renderer/components/browser/`、`src/renderer/stores/useBrowserTabs.ts`
- Document：`src/renderer/components/document/`、`src/renderer/stores/useDocTabs.ts`
- RSS：`src/renderer/components/rss/`、`src/renderer/stores/useRSSSession.ts`；列表入口为 `modules/rss/useRSSWorkspace.ts`，消费 Main 查询；`RSSArticleReader` 与 Document 共享 `components/document/MarkdownContent.tsx`，原生 RSS 预览宿主已退役。
- Calendar：`src/renderer/components/calendar/`、`src/renderer/stores/useCalendarSession.ts`
- Settings：`src/renderer/pages/Settings.tsx`、`src/renderer/components/settings/`
- UI 调整导览：`UI_ADJUSTMENT_GUIDE.md`

## 7. 排障起点

1. 先确认是哪一层拥有状态：Renderer、Preload、Main、DB 还是原生覆盖层。
2. IPC 问题同时查 Main handler、Preload API 和 `src/renderer/types/electron.d.ts`。
3. Agent 运行问题先查 run 元数据、任务投影与三份临时日志，不从旧计划猜执行链。
4. SQLite 相关问题先跑 `npm run verify:native`，普通 Node skip 不算覆盖。
5. BrowserView 可见性问题先核对 host 显隐和 bounds，再看 DOM 层级。
