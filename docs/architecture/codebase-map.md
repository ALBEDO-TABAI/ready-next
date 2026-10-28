# Ready 当前代码地图

> 核对日期：2026-09-29
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
| RSS | `src/renderer/pages/modes/RSSMode.tsx` | `src/main/modules/rss-engine/` | 按改动选择 RSS 焦点测试与阶段 gate |
| Calendar | `src/renderer/pages/modes/CalendarMode.tsx` | `src/main/modules/calendar-engine/` | `npm run verify:calendar` |

Agent、文件面板、技能中心和设置页是跨工作面的能力，不是额外的 Workbench mode。

## 3. Main 模块

`src/main/modules/` 中的主要职责：

| 目录 | 职责 |
| --- | --- |
| `agent-control/` | Codex 主链、会话、任务投影、工具策略、新 Ready 长期记忆与远程助手 |
| `claude-bridge/` | Agent IPC 与 provider 宿主接线；不是旧 DirectChat 执行主链 |
| `tools/` | 工具定义、参数校验、授权后的执行分发 |
| `skills-runtime/` | embedded/custom skill 扫描、安装、运行与长期任务句柄 |
| `browser-engine/` | BrowserView、标签、导航、采集、隐私、Power Browser 与后台任务 |
| `document-engine/` | 文档读写、预览、导出与 Widget；保留的旧文档任务管线不进入 Codex 生产调度 |
| `rss-engine/` | RSS 订阅、采集、草稿和诊断 |
| `calendar-engine/` | 日历事件、来源、提醒与时间解析 |
| `file-emergence/` / `tag-forge/` | 文件涌现、项目身份、注意力信号与受控标签写入 |
| `repositories/` / `database/` | SQLite 数据访问与持久化真值 |
| `settings-engine/` | 设置持久化、迁移与稳定凭据库 |
| `mcp/` | MCP 配置、连接与授权接线 |
| `search-engine/` | 本地索引与检索 |

完整目录以工作区为准：

```bash
rg --files src/main/modules | cut -d/ -f1-4 | sort -u
```

## 4. Agent live 主链

生产执行入口是：

```text
claude-bridge IPC
  -> CodexHostOrchestrator
  -> Codex ingress + atomic persistence
  -> ReadyCodexLifecycleAdapter / native app-server turn
  -> canonical closeout transaction
  -> durable projection + visible response
```

关键入口：

- `src/main/modules/agent-control/runtime-core/runtime.ts`
- `src/main/modules/agent-control/runtime-core/codex-host-orchestrator.ts`
- `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts`：只创建共享状态并按依赖顺序接线；各部分在 `codex-runtime/composition/`，每个工厂经参数拿依赖，原可变状态集中在 `live-state.ts` 的 `CodexCompositionLive`
- `src/main/modules/agent-control/codex-runtime/ready-codex-lifecycle-adapter.ts`
- `src/main/modules/tools/tool-executor.ts`

`AgentSdkRuntime`、`ReadyAgentOrchestrator`、`direct-chat.ts`、`turn-engine.ts` 与旧 Dynamic Delivery/Boost 都不是生产入口。Codex 工具面以准入前冻结的 Ready tool snapshot 为权威，不得从旧 SDK-shaped parity 入口旁路。

### 模型接入（2026-09-26 核对）

以下文件均位于 `src/main/modules/agent-control/codex-runtime/`。`codex-model-gateway.ts` 保持原公开入口，只持有 HTTP 生命周期及单次请求转发顺序；不会直接承载数据库或协议状态机。

| 职责 | 文件 |
| --- | --- |
| HTTP 读写、请求身份与冻结权限校验 | `codex-model-gateway-http.ts`、`codex-model-gateway-request.ts` |
| 原生 Responses 事件一致性与流式交付 | `codex-model-gateway-native-validation.ts`、`codex-model-gateway-native-stream.ts` |
| Chat 请求转换与响应流转换 | `codex-model-gateway-chat.ts`、`codex-model-gateway-chat-stream.ts` |
| Messages、OAuth、Z.ai 及缺少消息阶段的适配 | `codex-model-gateway-messages.ts`、`codex-model-gateway-oauth.ts`、`codex-zai-responses.ts`、`codex-provider-message-phase.ts` |
| 凭据脱敏、上游错误和超时/重试规则 | `codex-provider-credential-filter.ts`、`codex-model-gateway-provider-errors.ts`、`codex-model-gateway-policy.ts`、`codex-model-gateway-retry.ts` |
| 数据库记录与宿主准入/凭据端口 | `codex-model-gateway-repository.ts`、`codex-model-gateway-authority.ts` |
| 跨模块端口类型与基础校验 | `codex-model-gateway-types.ts`、`codex-model-gateway-common.ts` |

协议模块不得反向加载 HTTP 服务或数据库，运行时依赖不得成环。`codex-gateway-module-boundaries.test.ts` 已加入 E3 验证入口，约束职责边界及文件规模；真实行为仍由网关、供应商、原生持久化和固定 app-server 测试验收。真实供应商候选摘要同时包含拆出的接入源文件。

## 5. Agent Control 分区

在 `src/main/modules/agent-control/` 修改前，先按职责定位：

- `codex-runtime/`：Codex 准入、原生 thread/turn、工具桥、生命周期与 canonical closeout。
- `runtime-core/`：产品宿主、DomainAdapter、连续性，以及不在生产图中的旧 SDK 支撑代码。
- `domain-adapters/`：域能力、工具面准备与 capability floors 纯函数。
- `tools-runtime/`、`tool-policy/`：工具注册、结果形状与执行策略。
- `task-projection/`：任务卡与 run 元数据真值。
- `skills/`、`child-run/`、`sub-agent/`：历史技能或子任务账本及非 Codex 支撑代码；当前 Codex 不从这些模块启动 child-loop 或公开续跑。
- `session/`、`compaction/`、`system-reminders/`：上下文与会话生命周期。
- `ready-memory/`：当前手动长期记忆、冻结快照、只读搜索与撤销；生产自动整理保持关闭。
- `knowledge/`、`emergence/` 等剩余支撑：文件涌现读取隔离的信念卡，不恢复旧人格、预路由、自动模型维护或专项 Agent。
- `safety/`、`quality/`：确认闸门、证据与完成判定。

### 5.1 当前重点状态拥有者

| 问题 | 入口 |
| --- | --- |
| 原生历史操作兼容性 | `src/main/modules/agent-control/codex-runtime/codex-runtime-compatibility.ts`、`assets/runtime-continuity/` |
| 本地聊天项目目录 | `src/main/modules/agent-control/codex-runtime/chat-project-directory.ts`、`src/renderer/components/agent/ProjectSelector.tsx` |
| 当前发送/恢复资格 | `src/main/modules/agent-control/codex-runtime/codex-action-surface.ts`、`codex-lifecycle-action-surface.ts` |
| 上下文边界与绑定 | `src/main/modules/agent-control/codex-runtime/codex-context-boundary.ts`、`codex-binding-repository.ts`（门面，只做委托；SQL 与事务在 `binding-repository/` 分层模块） |
| 远程收信、去重与执行 | `src/main/modules/agent-control/runtime-core/remote-channel-service.ts`、`remote-channel-event-repository.ts`、`remote-codex-turn.ts` |
| 微信/飞书连接与持久队列 | `src/python/ready_sidecar/channels/`、`src/python/ready_sidecar/event_store.py` |
| 稳定凭据 | `src/main/modules/settings-engine/credential-vault.ts`、`credential-vault-reconciliation.ts` |
| 编译与包体来源 | `scripts/build-with-source-identity.cjs`、`scripts/release-package-identity.cjs`、`scripts/write-release-receipt.cjs` |

表内省略目录的文件位于同一行首个文件的目录。

## 6. Renderer 入口

- 工作台壳：`src/renderer/pages/WorkbenchMode.tsx`
- Agent：`src/renderer/components/agent/ChatPanel.tsx`、`src/renderer/stores/useAgent.ts`
- 文件与侧栏：`src/renderer/components/layout/`
- Browser：`src/renderer/components/browser/`、`src/renderer/stores/useBrowserTabs.ts`
- Document：`src/renderer/components/document/`、`src/renderer/stores/useDocTabs.ts`
- RSS：`src/renderer/components/rss/`、`src/renderer/stores/useRSSSession.ts`
- Calendar：`src/renderer/components/calendar/`、`src/renderer/stores/useCalendarSession.ts`
- Settings：`src/renderer/pages/Settings.tsx`、`src/renderer/components/settings/`
- UI 调整导览：`UI_ADJUSTMENT_GUIDE.md`

## 7. 排障起点

1. 先确认是哪一层拥有状态：Renderer、Preload、Main、DB 还是原生覆盖层。
2. IPC 问题同时查 Main handler、Preload API 和 `src/renderer/types/electron.d.ts`。
3. Agent 运行问题先查 run 元数据、任务投影与三份临时日志，不从旧计划猜执行链。
4. SQLite 相关问题先跑 `npm run verify:native`，普通 Node skip 不算覆盖。
5. BrowserView 可见性问题先核对 host 显隐和 bounds，再看 DOM 层级。
