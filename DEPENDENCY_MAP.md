# Module Dependency Map

> Updated: 2026-04-13

## 总体依赖链
```text
Renderer (React / Zustand)
  -> Preload (window.electronAPI)
  -> Main IPC handlers
  -> DB / FS / BrowserView / skills runtime / external AI providers
```

## 聚合入口
### 主进程
- `src/main/index.ts`
  - 注册窗口、协议、数据库、IPC 与各模块引擎

### 渲染进程
- `src/renderer/main.tsx`
  - React 启动、bootstrap 错误兜底
- `src/renderer/App.tsx`
  - 路由：`/`, `/workbench`, `/ready`, `/settings`, `* -> /workbench`

## 关键链路
### 1. Browser
`BrowserMode / browser components`
-> `electronAPI.browser.*`
-> `src/main/modules/browser-engine/ipc-handler.ts`
-> BrowserView / session / history / bookmark / popup policy

### 2. Document
`DocumentMode / document components`
-> `electronAPI.document.*`
-> `src/main/modules/document-engine/ipc-handler.ts`
-> 文本抽取 / 文档读写 / autosave

### 3. RSS
`RSSMode / rss components`
-> `electronAPI.rss.*`
-> `src/main/modules/rss-engine/ipc-handler.ts`
-> 订阅源更新 / 分析 / 诊断 / browser handoff

### 4. Calendar
`CalendarMode / calendar components`
-> `electronAPI.calendar.*`
-> `src/main/modules/calendar-engine/ipc-handler.ts`
-> 事件 CRUD / 来源管理 / quick create

### 5. Settings / AI Provider
`Settings.tsx`
-> `useSettings`
-> `electronAPI.settings.*`
-> `src/main/modules/settings-engine/*`
-> `src/shared/ai-providers.ts`

该链路统一解析：
- provider 默认值
- 协议（Anthropic/OpenAI）
- wire API（chat/responses）
- tools / vision / native video 能力

### 6. Agent / Memory
`ChatPanel / useAgent`
-> `electronAPI.agent.*`
-> `src/main/modules/claude-bridge/*`
-> `src/main/modules/agent-control/*`
-> `src/main/modules/tools/*`
-> Browser / Document / Skill / System / Memory executor

附加依赖：
- `src/main/modules/openai-responses.ts`：SSE / JSON 兼容解析
- `src/main/modules/claude-bridge/tool-bridge.ts`：文本工具桥接
- `src/main/modules/repositories/memory-repository.ts`：长期记忆存取
- `src/main/modules/repositories/task-projection-repository.ts`：任务投影、父子任务关联、projection-first 真值
- `src/main/modules/agent-control/run-cleanup-registry.ts`：run-scoped cleanup 注册与统一回收

### 7. Skills
`SkillsCenterPanel`
-> `electronAPI.skills.*`
-> `src/main/modules/skills-runtime/runtime-manager.ts`
-> Embedded skill assets / managed custom skills / jobs / schedules

## Renderer 侧状态依赖
- `useMode`：工作台模式
- `useWorkspace`：侧边栏、文件树、技能中心、布局比例
- `useTheme`：主题
- `useAgent`：会话、消息、工具胶囊、运行状态
- `useSettings`：AI 供应商与模型配置
- `useBrowserTabs`：浏览器 tab 与导航状态
- `useCalendarSession`：日程会话状态
- `useDocTabs`：文档标签状态
- `useRSSSession`：RSS 会话状态

## 关键排障文件
- `src/shared/ai-providers.ts`
- `src/main/modules/claude-bridge/direct-chat.ts`
- `src/main/modules/claude-bridge/tool-bridge.ts`
- `src/main/modules/tools/browser-tools.ts`
- `src/main/modules/skills-runtime/runtime-manager.ts`
