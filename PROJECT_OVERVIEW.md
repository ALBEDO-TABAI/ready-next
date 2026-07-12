# Ready 项目说明

> 更新时间：2026-07-12

## 1. 产品定位

Ready 是面向知识工作者和创作者的桌面工作台，把浏览、文档、RSS、日历、AI Agent、技能和远程协作放在同一条连续工作流里。产品目标不是堆叠更多独立页面，而是让资料进入、理解、行动、保存和恢复都拥有清楚的状态与证据。

## 2. 当前工作面

Workbench 只有四个 mode，代码真值在 `src/renderer/stores/useMode.ts`：

- Browser：原生 BrowserView、多标签与竖向标签轨、书签/历史/下载/隐私管理、Safe/Power Browser 与 Agent 执行链。
- Document：多标签、多格式读写、预览内编辑、结构化 Widget、PDF/Markdown 资源包导出。
- RSS：订阅、采集、草稿、诊断与浏览器接管。
- Calendar：日/周/月视图、事件 CRUD、来源和提醒。

跨工作面的公共能力：

- Agent：统一 scope、任务投影、后台任务、恢复、完成判定与 Dynamic Delivery。
- Skills：embedded/custom skill 扫描、显式激活、授权、导入、长期句柄和 MCP/安装入口。
- Files：文件树、搜索、阅读进度、项目身份、文件涌现与 Tag Forge。
- Settings / Remote：AI provider、模型能力、MCP、知识系统、远程消息和文件回传。

Design/Video 已不是 Workbench mode；相关需求由文档、画板、媒体工具或技能承载，不得为旧文档复活已删除页面。

## 3. 当前 Agent 架构

生产主链是：

```text
claude-bridge IPC
  -> AgentSdkRuntime
  -> AgentSdkTurnOrchestrator
  -> provider / tool executor
  -> finalizeRunOutcome
  -> durable projection + visible closeout
```

`direct-chat.ts` 与 `turn-engine.ts` 已删除。工具面由 SDK executor 与 orchestrator 在本轮按能力、授权、资源引用和 capability floor 生成。`run-capability-controller.ts` 仍提供 live helper；只有其中的 `resolveRunCapabilities` 当前没有生产调用方，只作 SDK-shaped parity。

详细入口见 `docs/architecture/codebase-map.md`，不可破合同见 `docs/architecture/current-runtime-contracts.md`。

## 4. 技术基线

版本与依赖只信 `package.json`：

- Electron 42.3
- React 19
- TypeScript 5.7
- Vite 6 + electron-vite
- Tailwind CSS 4 + CSS variables
- Zustand
- SQLite / better-sqlite3
- Tiptap、Univer、Mammoth、XLSX、react-pdf 等文档能力

源码分层：

- Main：`src/main/`
- Preload：`src/preload/`
- Renderer：`src/renderer/`
- Shared：`src/shared/`

## 5. 文档入口

- 开发与排障：`DOCUMENTATION.md`
- 当前状态：`PROGRESS.md`
- 文档导航与生命周期：`docs/README.md`
- 当前代码地图：`docs/architecture/codebase-map.md`
- 当前硬合同：`docs/architecture/current-runtime-contracts.md`
- UI 修改入口：`UI_ADJUSTMENT_GUIDE.md`
- 发布记录：`CHANGELOG.md`

## 6. 日志与验收

日志位于 Node/Electron `os.tmpdir()`：

- `ready-directchat.log`：Agent 与浏览器决策
- `ready-tools.log`：工具执行
- `ready-browser.log`：BrowserView、popup 与导航

普通开发从 `npm run dev` 开始；SQLite-backed 改动先跑 `npm run verify:native`。专项验证以 `package.json` 当前脚本为准，完整交付至少完成 `npm run typecheck` 与改动对应的 focus/gate。
