# Ready 项目说明

> 核对日期：2026-09-29；依据已提交应用源码与清单，不代表重新完成安装验收。

## 1. 产品定位

Ready 是由@上班摸鱼 开发的，面向知识工作者和创作者的通用桌面工作台，把浏览、文档、RSS、日历、AI Agent、技能和远程协作放在同一条连续工作流里。产品目标不是堆叠更多独立页面，而是让资料进入、理解、行动、保存和恢复都拥有清楚的状态与证据。

## 2. 当前工作面

Workbench 只有四个 mode，代码真值在 `src/renderer/stores/useMode.ts`：

- Browser：原生 BrowserView、多标签与竖向标签轨、书签/历史/下载/隐私管理、Safe/Power Browser 与 Agent 执行链。
- Document：多标签、多格式读写、预览内编辑、结构化 Widget、PDF/Markdown 资源包导出；支持文本与 DOCX 的只读书本阅读、位置恢复、字号和背景设置。
- RSS：订阅、采集、草稿、诊断与浏览器接管。
- Calendar：日/周/月视图、事件 CRUD、来源和提醒。

跨工作面的公共能力：

- Agent：单一 Ready 助手、隔离会话、历史续聊、草稿保留、明确的新上下文恢复、任务结果与 Browser 独立复核。普通续聊、重试失败任务和开始新上下文是不同动作。
- Skills：embedded/custom skill 扫描、导入和显式选择；当前 Codex 在进入回合前冻结技能与工具权限。能发现技能不代表其脚本或旧子任务执行链已接入。
- Files：文件树、搜索、阅读进度、项目身份、文件涌现与 Tag Forge。
- 聊天项目目录：为每个本地会话保存默认交付文件夹，本轮显式引用优先；不改变助手内部运行目录，也不自动扫描整目录。
- Settings / Remote：AI provider、模型能力、MCP、手动长期记忆、凭据管理、微信/飞书本人绑定后的远程问答和文件回传。

长期记忆支持手工增删改、固定、读取开关和本地会话贡献开关；自动整理尚未开放。旧人格、专项 Agent 与旧记忆设置已移除。Agent 定时任务和公开子任务续跑也不在当前产品入口中。

Design/Video 已不是 Workbench mode；相关需求由文档、画板、媒体工具或技能承载，不得为旧文档复活已删除页面。

## 3. 当前 Agent 架构

生产主链是：

```text
claude-bridge IPC
  -> CodexHostOrchestrator
  -> Codex ingress + atomic persistence
  -> ReadyCodexLifecycleAdapter / native app-server turn
  -> canonical closeout transaction
  -> durable projection + visible response
```

`AgentSdkRuntime`、`ReadyAgentOrchestrator`、`direct-chat.ts` 与 `turn-engine.ts` 都不是生产入口。工具面由 Ready 在 Codex 准入前按能力、授权、资源引用和 capability floor 解析并冻结；旧 Dynamic Delivery/Boost 不得重新接回。

模型统一经本机 Codex 网关连接，上游按冻结配置使用 Responses、Chat Completions 或 Anthropic Messages。设置连接测试复用该入口；协议已接入和真实供应商验收是不同状态，具体配置与限制见 `PROGRESS.md`。

详细入口见 `docs/architecture/codebase-map.md`，不可破合同见 `docs/architecture/current-runtime-contracts.md`。

## 4. 技术基线

版本与依赖只信 `package.json`：

- Electron 42.3
- 应用版本 0.8.0；固定 Codex runtime 0.160.1，清单见 `assets/codex-runtime/runtime-manifest.json`
- React 19
- TypeScript 5.7
- Vite 6 + electron-vite
- Tailwind CSS 4 + CSS variables
- Zustand
- SQLite / better-sqlite3
- Tiptap、Univer、Mammoth、XLSX、react-pdf 等文档能力

当前发布配置和 Codex 二进制固定为 macOS arm64。Windows 的源码约束与准备流程仍保留，但不等于当前已提供可用 Windows 发行包；见 `docs/platform/windows-development.md`。

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
