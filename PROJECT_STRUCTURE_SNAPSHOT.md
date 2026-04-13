# Project Structure Snapshot

> Updated: 2026-04-13

## 顶层目录
```text
ready/
├── src/
│   ├── main/        # Electron 主进程与模块引擎
│   ├── preload/     # IPC bridge
│   ├── renderer/    # React UI 与状态管理
│   └── shared/      # 共享类型与 AI 配置能力层
├── assets/          # 内置技能与静态资源
├── docs/            # 设计、计划、实验文档
├── scripts/         # 辅助脚本
└── *.md             # 核心协作文档
```

## 主进程模块目录
- `src/main/modules/agent-control`
- `src/main/modules/browser-engine`
- `src/main/modules/calendar-engine`
- `src/main/modules/claude-bridge`
- `src/main/modules/document-engine`
- `src/main/modules/memory-management`
- `src/main/modules/repositories`
- `src/main/modules/rss-engine`
- `src/main/modules/settings-engine`
- `src/main/modules/skills-runtime`
- `src/main/modules/tools`

## Renderer 关键目录
### 页面模式
- `src/renderer/pages/modes/BrowserMode.tsx`
- `src/renderer/pages/modes/DocumentMode.tsx`
- `src/renderer/pages/modes/RSSMode.tsx`
- `src/renderer/pages/modes/CalendarMode.tsx`

### 组件分区
- `src/renderer/components/agent`
- `src/renderer/components/browser`
- `src/renderer/components/calendar`
- `src/renderer/components/document`
- `src/renderer/components/layout`
- `src/renderer/components/memory`
- `src/renderer/components/motion`
- `src/renderer/components/personality`
- `src/renderer/components/profile`
- `src/renderer/components/ready`
- `src/renderer/components/rss`
- `src/renderer/components/settings`
- `src/renderer/components/ui`
- `src/renderer/components/workbench`

### 状态管理
- `useAgent`
- `useBrowserTabs`
- `useCalendarSession`
- `useDocTabs`
- `useMode`
- `useRSSSession`
- `useSettings`
- `useTheme`
- `useWorkspace`

## 核心协作文档
- `AGENTS.md`
- `CHANGELOG.md`
- `DOCUMENTATION.md`
- `DEPENDENCY_MAP.md`
- `FEATURE_MODULE_MAP.md`
- `LESSONS_LEARNED.md`
- `PROGRESS.md`
- `PROJECT_OVERVIEW.md`
- `PROJECT_STRUCTURE_SNAPSHOT.md`
