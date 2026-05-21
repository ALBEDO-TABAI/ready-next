# Project Structure Snapshot

> Updated: 2026-05-21

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
- `src/main/modules/agent-control`（Stage U Phase 5 v2 完成，详见下）
- `src/main/modules/browser-engine`
- `src/main/modules/calendar-engine`
- `src/main/modules/claude-bridge`
- `src/main/modules/document-engine`（含 Stage U U5.2 迁入的 `pipeline/`）
- `src/main/modules/memory-management`
- `src/main/modules/repositories`
- `src/main/modules/rss-engine`
- `src/main/modules/settings-engine`
- `src/main/modules/skills-runtime`
- `src/main/modules/tools`

### agent-control 子目录（Stage U Phase 5 v2 落地）
```text
src/main/modules/agent-control/
├── ask-user/          # 2 文件 — ask-user 桥
├── child-run/         # 3 文件 — 非 skill 子运行控制
├── compaction/        # 3 文件 — 上下文压缩
├── contracts/         # 11 文件 — 跨层合同 + 类型
├── domain-adapters/   # 16 文件 — DomainAdapter + capability
├── memory/            # 3 文件 — 外部记忆 + secret-storage
├── runtime-core/      # 13 文件 — 主运行时 + turn frame
├── session/           # 5 文件 — 会话生命周期 + recall
├── skills/            # 33 文件 — Skill 运行时
├── sub-agent/         # 子 agent 运行（既有）
├── system-reminders/  # 6 文件 — reminder 注册 + composer
├── task-projection/   # 13 文件 — 任务投影 + cleanup
├── tool-policy/       # 4 文件 — 执行级工具策略
├── tools-runtime/     # 12 文件 — 工具批执行 + registry
└── *.ts               # 38 文件 — 未分组 helper（含 turn-engine.ts post-Stage U 拆分候选）
```

### document-engine 子目录
```text
src/main/modules/document-engine/
├── pipeline/          # 10 文件 — 文档任务 pipeline（Stage U U5.2 从 agent-control/ 迁入）
└── *.ts               # 既有 ipc-handler、ebook-importer、commit registry 等
```

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
