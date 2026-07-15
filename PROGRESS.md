# Ready 开发进展

> 更新时间：2026-07-15
> 本文件只保留当前看板。完整历史见 `CHANGELOG.md`、Git 与 `docs/superpowers/plans/`；旧测试流水账不再在这里累积。

## 1. 当前基线

- 应用版本：`0.7.1`（以 `package.json` 为准）。
- 技术基线：Electron 42.3、React 19、TypeScript 5.7、Vite 6、Tailwind CSS 4、SQLite/better-sqlite3。
- Workbench mode：`browser | document | rss | calendar`。
- Agent live 主链：`AgentSdkRuntime -> AgentSdkTurnOrchestrator -> finalizeRunOutcome`。
- `direct-chat.ts`、`turn-engine.ts` 与 `skill_executions` workflow 状态机均已退役，不是待继续拆分的现行入口。
- 当前代码与依赖地图：`docs/architecture/codebase-map.md`。
- 当前不可破合同：`docs/architecture/current-runtime-contracts.md`。

## 2. 近期已完成

### Agent 与交付

- Agent foundation 与 Dynamic Delivery 已收口：默认 adaptive，worker 无工具，Owner 独占写入/确认/外部动作，候选稿先隔离再由 fresh verifier 判定。
- run 终态统一进入 `finalizeRunOutcome()`，连续性、watchdog、no-progress 与旧 run 晚到覆盖问题建立专项合同。
- OpenAI-compatible chat/responses 与 Anthropic provider 已进入真 SSE 路径，并保留受控降级。
- 阶段一、三、四的知识卡、专项 Agent、任务包、最小传话、预路由与生命周期合同已有对应 `verify:evolution-*` 入口。

### Skills 与工具面

- capability floor 已由 SDK executor 与 orchestrator live 强制；current document 与 local resource 的读写边界分开。
- embedded skill 改为目录扫描和 drop-in 注册，`use_skill` 负责模型侧显式激活，custom shell 需要逐技能同意。
- Creative Production 技能组已嵌入；Tag Forge 已从只读方法论扩展为受 receipt、授权路径与索引 readback 约束的结构化能力。
- MCP、安装命令与远程文件回传已有代码侧授权和确认入口。

### 文档、浏览器与工作台

- 文档 Widget 已统一到 Ready 令牌、结构真值、点阵图表、关系图/流程图、CSP nonce 与事件接收器。
- 文档模式已补齐预览内编辑、未命名标签拖存、标签外观同步和顶栏导出。
- Browser 已补浏览数据/Cookie 管理、Safe/Power 边界与竖向标签组交互；跨窗口 flyout hover 已修复。
- 启动微入口、工作台控制区和大型 UI 文件拆分已落地。
- 文件涌现与 Tag Forge P0-P5 已完成独立对抗复审；持久反馈、防复活、项目身份、receipt/readback、长期评估和真实 SQLite 覆盖已收口。

## 3. 0.7.1 发布

`0.6.1` 之后的变化已统一收口为 `0.7.1` 发布，包括：

- 工作台控制区与标签交互调整。
- Creative Production embedded skills。
- Browser 竖向标签 flyout 修复。
- 文件涌现与 Tag Forge P0-P5。
- 安装包模型接入、运行时下载续传、历史任务状态、用户偏好和文档打开性能的系统修复。

当前 arm64 DMG 已完成构建、签名、挂载、全新用户启动、NovaCode 实际聊天、任务状态和文档打开验收，结果已回填 `CHANGELOG.md`。

工作区中的未提交 Packer 或其他实验改动不在本看板的“已完成”口径内，除非另有完成合同和验证记录。

## 4. 最近有效证据

以下是对应功能 closeout 已记录的证据，不代表本次文档整理重新执行了全量产品回归：

- Agent foundation / Dynamic Delivery：`verify:agent-foundation`、`verify:dynamic-delivery`、SQLite 覆盖与隔离快照验证。
- 文档 Widget：`verify:widget-ready` 与真实 Electron 亮暗主题、编辑、保存、重开验证。
- 文件涌现 / Tag Forge：`verify:file-emergence`、`verify:tag-forge`、真实 Electron/SQLite、迁移连续性、`typecheck` 与生产构建。
- 版本一致性：`npm run verify:version`。

每次新任务仍需在当前工作区重跑与改动相称的命令，不能把这里的历史绿灯当成本轮通过。

## 5. 下一步判定规则

1. 先查看最新 `*-implementation.md` 和当前工作区，不从本文件猜阶段完成度。
2. 未提交、未验证或只在审计中提出的工作不得写成“已完成”。
3. 发布前以 `package.json`、`CHANGELOG.md`、真实包体和安装后 smoke 为准。
4. 新的阶段细节写入对应 plan/audit；这里只更新影响全局方向的状态变化。
5. 任何旧文档若仍把 DirectChat、TurnEngine、Design/Video mode 或 workflow coordinator 当现行入口，应视为历史材料。
