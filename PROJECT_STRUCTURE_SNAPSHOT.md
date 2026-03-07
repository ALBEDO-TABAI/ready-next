# Project Structure Snapshot

> Updated: 2026-03-07

## 顶层目录
```text
ready/
├── src/
│   ├── main/        # Electron 主进程与模块引擎
│   ├── preload/     # IPC bridge
│   ├── renderer/    # React UI 与状态管理
│   └── shared/      # 共享类型与 AI 配置能力层
├── assets/          # 内置技能与静态资源
├── exports/         # 导出产物
├── logs/            # 本地日志目录
├── scripts/         # 辅助脚本
└── *.md             # 协作文档与项目说明
```

## 核心统计（当前仓库）
- `src/main`: 58 files
- `src/renderer`: 101 files
- `src/preload`: 1 file
- `src/shared`: 1 file
- `src/__tests__`: 10 files

## 主进程模块目录
- `src/main/modules/agent-control`
- `src/main/modules/browser-engine`
- `src/main/modules/calendar-engine`
- `src/main/modules/claude-bridge`
- `src/main/modules/design-engine`
- `src/main/modules/document-engine`
- `src/main/modules/rss-engine`
- `src/main/modules/settings-engine`
- `src/main/modules/skills-runtime`
- `src/main/modules/tools`
- `src/main/modules/video-engine`

## Renderer 关键目录
### 页面模式
- `src/renderer/pages/modes/BrowserMode.tsx`
- `src/renderer/pages/modes/DocumentMode.tsx`
- `src/renderer/pages/modes/DesignMode.tsx`
- `src/renderer/pages/modes/VideoMode.tsx`
- `src/renderer/pages/modes/RSSMode.tsx`
- `src/renderer/pages/modes/CalendarMode.tsx`

### 组件分区
- `src/renderer/components/agent`
- `src/renderer/components/browser`
- `src/renderer/components/calendar`
- `src/renderer/components/creative`
- `src/renderer/components/design`
- `src/renderer/components/document`
- `src/renderer/components/layout`
- `src/renderer/components/motion`
- `src/renderer/components/ready`
- `src/renderer/components/rss`
- `src/renderer/components/settings`
- `src/renderer/components/ui`

### 状态管理
- `useAgent`
- `useBrowserTabs`
- `useDesignSession`
- `useDocTabs`
- `useMode`
- `useSettings`
- `useTheme`
- `useWorkspace`

## 测试文件
- `src/__tests__/agent-control.test.ts`
- `src/__tests__/ai-provider-capabilities.test.ts`
- `src/__tests__/browser-popup-policy.test.ts`
- `src/__tests__/browser-tools.test.ts`
- `src/__tests__/database.test.ts`
- `src/__tests__/ipc-handlers.test.ts`
- `src/__tests__/responses-parser.test.ts`
- `src/__tests__/rss-analysis-manager.test.ts`
- `src/__tests__/stores.test.ts`
- `src/__tests__/tool-bridge.test.ts`

## 文档集合
- `CHANGELOG.md`
- `CLAUDE.md`
- `DOCUMENTATION.md`
- `DEPENDENCY_MAP.md`
- `FEATURE_MODULE_MAP.md`
- `LESSONS_LEARNED.md`
- `PROGRESS.md`
- `PROJECT_OVERVIEW.md`
- `PROJECT_STRUCTURE_SNAPSHOT.md`
