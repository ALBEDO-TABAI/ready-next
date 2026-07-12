# Ready 开发文档

> 更新时间：2026-07-12
> 本文是开发入口，不保存阶段流水账。代码与 `package.json` 优先；详细运行时合同见 `docs/architecture/current-runtime-contracts.md`。

## 1. 先确定真值源

按以下顺序判断当前事实：

1. 类型、生产调用方、数据库 schema 和 `package.json`
2. 行为测试、专项 gate 与真实 Electron 结果
3. `docs/architecture/current-runtime-contracts.md`
4. 当前 `*-implementation.md` 计划
5. 审计、诊断、旧计划和 Git 历史

文件名含 “final / current / snapshot” 不代表仍有效。历史审计若与 live 代码冲突，只能说明当时状态。

## 2. 架构概览

```text
Renderer (React / Zustand)
  -> Preload (window.electronAPI)
  -> Main IPC / Agent runtime
  -> SQLite / FS / BrowserView / skills / provider
```

稳定入口：

- Main 微入口：`src/main/boot-entry.ts`（先显示启动动画，再加载重模块）
- Main 应用宿主：`src/main/index.ts`
- Preload：`src/preload/index.ts`
- Renderer：`src/renderer/main.tsx`
- Router：`src/renderer/App.tsx`
- Workbench：`src/renderer/pages/WorkbenchMode.tsx`
- Shared：`src/shared/`

模块、依赖与目录合并维护在 `docs/architecture/codebase-map.md`，不再维护手工文件数量快照。

## 3. 工作台与跨工作面能力

| 领域 | Renderer | Main | 验证起点 |
| --- | --- | --- | --- |
| Browser | `src/renderer/pages/modes/BrowserMode.tsx`、`src/renderer/components/browser/` | `src/main/modules/browser-engine/` | `verify:browser-reliability` |
| Document | `src/renderer/pages/modes/DocumentMode.tsx`、`src/renderer/components/document/` | `src/main/modules/document-engine/` | `verify:widget-ready` |
| RSS | `src/renderer/pages/modes/RSSMode.tsx`、`src/renderer/components/rss/` | `src/main/modules/rss-engine/` | 相关 RSS 焦点测试 |
| Calendar | `src/renderer/pages/modes/CalendarMode.tsx`、`src/renderer/components/calendar/` | `src/main/modules/calendar-engine/` | `verify:calendar` |
| Agent | `src/renderer/components/agent/`、`src/renderer/stores/useAgent.ts` | `src/main/modules/claude-bridge/`、`src/main/modules/agent-control/`、`src/main/modules/tools/` | `verify:stability` |
| Skills | `src/renderer/components/layout/SkillsCenterPanel.tsx`、设置页 | `src/main/modules/skills-runtime/` | skill 对应 gate |
| Files / Emergence | `src/renderer/components/layout/`、`src/renderer/modules/file-emergence/` | `src/main/modules/file-emergence/`、`src/main/modules/tag-forge/` | `verify:file-emergence`、`verify:tag-forge` |
| Settings | `src/renderer/pages/Settings.tsx`、`src/renderer/stores/useSettings.ts` | `src/main/modules/settings-engine/` | `verify:native` + 设置焦点测试 |

UI 文件定位先看 `UI_ADJUSTMENT_GUIDE.md`。

## 4. Agent 生产主链

当前生产执行由 `AgentSdkRuntime` 与 `AgentSdkTurnOrchestrator` 承担：

```text
IPC request
  -> resolve scope/resources
  -> build prompt + tool surface
  -> provider stream / tool loop
  -> collect proof
  -> finalizeRunOutcome
  -> persist run meta, projection and assistant output
```

关键文件：

- `src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts`
- `src/main/modules/agent-control/runtime-core/agent-sdk-turn-orchestrator.ts`
- `src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts`
- `src/main/modules/agent-control/runtime-core/run-finalizer.ts`
- `src/main/modules/agent-control/task-projection/`
- `src/main/modules/tools/tool-executor.ts`

`direct-chat.ts` 和 `turn-engine.ts` 已退役删除。遇到旧文档或注释引用时，不能据此新建兼容入口。

## 5. 新功能与修改流程

### 5.1 开工

1. 写明成功时可观察到什么。
2. 找到 live 调用方与权威状态拥有者。
3. 检查同类入口和已有测试，确认不是只修一个症状。
4. 架构级改动先建 `docs/superpowers/plans/YYYY-MM-DD-*-implementation.md` 和机器合同。

### 5.2 跨进程最小闭环

跨 Main / Preload / Renderer 的能力通常同时需要：

1. Main handler 或 service
2. Preload 白名单 API
3. Renderer 的 `electron.d.ts`
4. UI/状态消费方
5. 行为测试或合同 gate
6. 受影响的单一权威文档

不是每次都要更新所有根文档；只更新真正拥有该事实的入口。

### 5.3 数据与权限

- 先确定 DB、Main、Renderer 或文件系统谁是权威方。
- 创建、保存、确认和子任务结果必须有明确的持久化确认门或恢复策略。
- 权限由 typed envelope、授权层和代码策略决定，不从用户原文猜测。
- 涉及 SQLite、设置、索引或本地持久化时，先跑 `npm run verify:native`。

### 5.4 UI

- BrowserView 覆盖、液态玻璃、窗口材质和 Windows chrome 必须在真实 Electron 表面验证。
- 共用尺寸与布局先找 `src/renderer/modules/workbench/` 和主题 token，不在页面内复制魔数。
- 通用 CSS reset、Widget 设计语言和大文件健康规则见当前运行时合同及根指引。

## 6. 工具错误合同

工具执行统一返回 `src/main/modules/agent-control/tools-runtime/tool-result-types.ts` 中的结构化结果：

- 未注册与未授权是两种互斥错误。
- 输入错误、用户拒绝、host 不可用、provider 错误等使用登记过的 error kind。
- 普通工具失败回灌模型，让同一回合可以纠正；Abort 或宿主基础设施不可用才允许冒泡。
- Renderer 只消费明确的 recoverable/terminal 语义，不从错误文案猜测状态。
- metric 与日志是旁路观测，记录失败不能打断请求。
- 新错误形状必须同步 `src/main/modules/agent-control/contracts/error-kinds.ts`、相关 gate 和可见文案。

排障入口：

- 执行：`src/main/modules/tools/tool-executor.ts`
- 结果形状：`src/main/modules/agent-control/tools-runtime/tool-result-types.ts`
- Agent 错误归一：`src/main/modules/claude-bridge/error-contract.ts`
- 错误登记：`src/main/modules/agent-control/contracts/error-kinds.ts`

## 7. 开发与验证命令

```bash
npm run dev
npm run verify:native
npm run typecheck
npm run test
npm run verify
npm run build
```

专项 gate 必须从当前 `package.json` 选择，不从旧进展文档复制。测试边界、SQLite skip 和 verify 归属见 `docs/superpowers/testing-conventions.md`。

## 8. 日志与排障

日志目录由 `os.tmpdir()` 决定：

- `ready-directchat.log`：Agent 与浏览器决策
- `ready-tools.log`：工具执行
- `ready-browser.log`：BrowserView、popup、导航

推荐排障顺序：

1. 复现并记下 requestId / scope / 时间。
2. 看用户可见终态与任务投影是否一致。
3. 对齐三份日志与 DB/run meta。
4. 沿 Renderer -> Preload -> Main -> DB/FS/provider 检查所有权。
5. 写失败测试或最小探针后再修复。
6. 重新跑焦点测试、专项 gate 和与风险匹配的真机回归。

## 9. 文档维护

- 文档入口与状态口径见 `docs/README.md`。
- `PROGRESS.md` 只做当前看板；历史交给 Git、`CHANGELOG.md` 和实施计划。
- 审计/诊断记录当时证据，不得在没有 live 复核时提升为现行合同。
- 根目录不再新增模块图、依赖图、结构快照或专项平台交接件。
- 路径、版本、命令和“当前”声明修改后必须重新核对。
