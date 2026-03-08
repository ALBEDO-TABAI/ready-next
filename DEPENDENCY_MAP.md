# Module Dependency Map

> Updated: 2026-03-07

## 总体依赖链
```text
Renderer (React / Zustand)
  -> Preload (window.electronAPI)
  -> Main IPC handlers
  -> DB / FS / BrowserView / skills runtime / sidecar / external AI providers
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

### 3. Design
`DesignMode`
-> `electronAPI.design.*`
-> `src/main/modules/design-engine/*`
-> TLDraw 文件与会话能力

### 4. Video
`VideoMode`
-> `electronAPI.video.*`
-> `src/main/modules/video-engine/*`
-> Remotion 预览 / 轨道 / 导出

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

### 6. Agent
`ChatPanel / useAgent`
-> `electronAPI.agent.*`
-> `src/main/modules/claude-bridge/*`
-> `src/main/modules/tools/*`
-> Browser / Document / Skill / System tool executor

Agent 主链路中额外依赖：
- `src/main/modules/openai-responses.ts`：SSE / JSON 兼容解析
- `src/main/modules/claude-bridge/tool-bridge.ts`：文本工具桥接
- `src/main/modules/agent-control/session-continuity.ts`：浏览器连续性上下文

### 7. Skills
`SkillsCenterPanel`
-> `electronAPI.skills.*`
-> `src/main/modules/skills-runtime/runtime-manager.ts`
-> Embedded skill assets / managed custom skills / jobs / schedules

### 8. Remote IM / Sidecar
`agent-control runtime`
-> `sidecar manager`
-> `src/python/ready_sidecar/*`
-> 远程通道事件、心跳、附件落盘、主进程会话写入

## Renderer 侧状态依赖
- `useMode`：工作台模式
- `useWorkspace`：侧边栏、文件树、技能中心、布局比例
- `useTheme`：主题
- `useAgent`：会话、消息、工具胶囊、运行状态
- `useSettings`：AI 供应商与模型配置
- `useBrowserTabs`：浏览器 tab 与导航状态
- `useDocTabs`：文档标签状态
- `useDesignSession`：设计会话状态

## 关键排障文件
- `src/shared/ai-providers.ts`
- `src/main/modules/claude-bridge/direct-chat.ts`
- `src/main/modules/claude-bridge/tool-bridge.ts`
- `src/main/modules/tools/browser-tools.ts`
- `src/main/modules/skills-runtime/runtime-manager.ts`
