# Feature Module Map

> Updated: 2026-05-21

## 模块清单
| 模块 | 前端入口 | 主进程模块 | 状态 |
|---|---|---|---|
| 浏览器 Browser | `src/renderer/pages/modes/BrowserMode.tsx` | `src/main/modules/browser-engine` | 可用，持续优化 Agent 泛化 |
| 文稿 Document | `src/renderer/pages/modes/DocumentMode.tsx` | `src/main/modules/document-engine` | 可用 |
| 设计 Design | `src/renderer/pages/modes/DesignMode.tsx` | `src/main/modules/design-engine` | 可用，持续迭代 |
| 剪辑 Video | `src/renderer/pages/modes/VideoMode.tsx` | `src/main/modules/video-engine` | 可用，持续迭代 |
| RSS | `src/renderer/pages/modes/RSSMode.tsx` | `src/main/modules/rss-engine` | 可用 |
| 日程 Calendar | `src/renderer/pages/modes/CalendarMode.tsx` | `src/main/modules/calendar-engine` | 可用 |
| Agent / AI 中控 | `src/renderer/components/agent/ChatPanel.tsx` | `src/main/modules/claude-bridge` | 可用，持续迭代 |
| 会话控制 / 远程 IM | `src/renderer/components/agent/*` | `src/main/modules/agent-control` | 可用，持续迭代 |
| 技能中心 / 运行时 | `src/renderer/components/layout/SkillsCenterPanel.tsx` | `src/main/modules/skills-runtime` | 可用 |
| 应用工具层 | 无独立页面 | `src/main/modules/tools` | 可用 |
| AI 设置 / 供应商配置 | `src/renderer/pages/Settings.tsx` | `src/main/modules/settings-engine` + `src/shared/ai-providers.ts` | 可用 |

## 共享壳层与通用层
- 布局壳层：`src/renderer/components/layout/*`
- 通用 UI：`src/renderer/components/ui/*`
- 状态管理：`src/renderer/stores/*`
- 共享配置 / 类型：`src/shared/*`
- 预加载桥接：`src/preload/index.ts`

## 技能分层
- 系统级技能：embedded skills，随应用资产一起分发
- 用户级技能：custom skills，支持本地目录导入、从 GitHub / tarball 链接安装、移除、说明更新与运行调度
- Skill tools：由 `skills-runtime` 动态转换为 `skill_*` 工具，供 Agent 直接调用
- 远程安装：技能中心 URL 输入框 + Agent `install_skill` 工具两条前门汇入单一 `installSkillFromSource`，`trustAck` 确认后由宿主下载/扫描/安装；风险源经 `ask_user_questions` 呈现具体原因（`skill-source-registry.ts`、`skill-source-fetcher.ts`、`shared/skill-source-types.ts`、`tools/builtins/install-skill.ts`）

## 重要现状
- 旧 `image` 模式已下线，统一为 `design`
- Browser Agent 主线是 V7 任务图执行与证据复核
- Agent Control 现在额外承载 session recall 主链：历史会话索引、旧会话胶囊引用、本地向量召回
- Agent Control 现在还承载 task projection 真值、父子任务关联和 run-scoped cleanup registry
- Agent Control 现已新增 `ToolRuntime`：工具批执行、恢复结果包装、cleanup 回收与结构化工具结果真相都收口在这一层
- Agent Control 的域内编排现已进入统一 adapter 生命周期：`TurnEngine` 只对接 `DomainAdapter` 合同，Browser / Document / Skill / RSS / Calendar / Feishu 各自通过 adapter 提供工具白名单、域内提示、前置接管和任务投影补丁
- `task-execution-router` 现已只负责 route 解析，不再混带 executor 级工具过滤或提示语；这些域内策略已迁到各自 adapter 的 `prepare()` 阶段
- `host-capability-dispatcher` 现阶段只保留 `openclaw` 宿主快捷执行，文档格式整理 / 改写 / 结构化制卡更新这类确定性链路已回收到 document 域
- 文档“先读再制卡 / 先读再更新卡片”的共享缓存、快照读取、draft 写回与 task-plan 编排现已集中在 `DocumentTaskPipelineExecutor`，不再由 `DirectChatEngine` 直接持有
- AI 配置已从“按 provider 写死”过渡到“工作区预设 + 当前生效配置 + 能力层解析”
- 设置页模型入口已收敛为 `OpenAI / Anthropic / Gemini / 自定义`
- 聊天区模型切换只展示 `showInChatSwitcher = true` 的预设
- `fox` 这类 OpenAI 兼容通道在工具调用上默认走文本桥接降级
- `src/main/modules/tools` 继续只负责各 domain tool dispatch；旧字符串结果会在 executor 层统一包装成结构化结果后再回到主链

## Agent Control 当前分层（Stage U Phase 5 v2 落地后）

agent-control 顶层文件已按功能拆入 13 个子目录（Stage U U5.1a* PR 序列），另有 document-pipeline 跨模块迁出到 `document-engine/pipeline/`（U5.2）。其余少量未分组文件留在 agent-control 顶层。

### 子目录与职责
- `domain-adapters/` — DomainAdapter 合同 + 各域接线层 + capability 解析（domain-adapter.ts、browser/document/rss/calendar/feishu/skill/research/host-capability-dispatcher.ts、capability-resolver.ts、run-capability-controller.ts、message-capability-filter.ts、browser-action-heuristics.ts、browser-task-planner.ts 等 16 文件）
- `runtime-core/` — 主运行时与回合主链（agent-sdk-runtime.ts、runtime.ts、orchestrator.ts、parallel-branch-orchestrator.ts、subtask-runtime.ts、task-step-runtime.ts、execution-loop-orchestrator.ts、turn-frame*/turn-state/turn-transcript/turn-feature-flags 等 13 文件）
- `skills/` — Skill 系列运行时（skill-child-runner.ts、skill-context-orchestrator.ts、skill-task-supervisor.ts、skill-tool-authorization.ts 等 33 文件）
- `tools-runtime/` — 工具批执行 + registry + gateway（tool-runtime.ts、tool-registry.ts、tool-gateway.ts、tool-definition.ts、tool-execution-hooks.ts、tool-parallelism-policy.ts 等 12 文件）
- `task-projection/` — 任务投影真值 + run-scoped cleanup（task-projection-*、run-projection.ts、run-coordinator.ts、run-collector.ts、run-cleanup-registry.ts、run-budget-policy.ts、run-state-* 等 13 文件）
- `contracts/` — 跨层合同 + 类型（run-contracts.ts、types.ts、error-kinds.ts、request-envelope.ts、continuation-state.ts、resume-handle.ts、resume-lexicon.ts、clarification-* 等 11 文件）
- `system-reminders/` — 系统提醒注册表 + composer + reminder authors + hook registry（system-reminder-registry.ts、system-reminder-assembly.ts、hook-registry.ts、current-date/browser-task-correction/pet-stickynote-retry reminders 等 6 文件）
- `session/` — 会话生命周期 + recall + thread meta（session-continuity.ts、session-manager.ts、session-recall-service.ts、thread-meta-repository.ts、active-skill-context.ts 共 5 文件）
- `compaction/` — 上下文压缩（context-compression.ts、layered-compactor.ts、layered-compactor-l2-stub.ts 共 3 文件）
- `child-run/` — 非 skill 子运行控制（child-run-circuit-breaker.ts、child-run-handle-resolver.ts、child-run-retry-policy.ts 共 3 文件）
- `tool-policy/` — 执行级工具策略（execution-tool-config.ts、execution-tool-policy.ts、execution-tool-skill-filters.ts、pet-tool-loop-policy.ts 共 4 文件）
- `memory/` — 外部记忆 + 生命周期 + secret-storage（external-memory-provider-slot.ts、memory-lifecycle.ts、secret-storage.ts 共 3 文件）
- `ask-user/` — 用户结构化反问桥（ask-user-bridge.ts、ask-user-questions-bridge.ts 共 2 文件）
- `sub-agent/` — 子 agent 运行（既有）

### 顶层未分组文件（38 个，多数为待分组 helper）
turn-engine.ts（待 Stage U 后期拆分）、prompt-assembly.ts、execution-intent-resolver.ts、intent-classifier.ts、task-execution-router.ts、task-type-resolver.ts、live-info-intent.ts、restart-intent-classifier.ts、message-correction-detector.ts、task-operation-intent.ts、metrics.ts、policy-arbitration.ts、reflection-service.ts、reference-skill-hint-display.ts、send-scoped-confirmation.ts、sidecar-manager.ts、provider-runtime-resolver.ts、video-expert-child-driver.ts、worker-projection.ts、worker-session.ts、vea-resume-action.ts、widget-edit-lease.ts、token-attribution-dimensions.ts、token-usage-middleware.ts、interaction-state-detector.ts、design-tool-loop-orchestrator.ts、document-domain-helpers.ts、detached-skill-task-tracker.ts、atomic-write.ts、auto-title.ts、link-parent-abort.ts、output-dir-lifecycle.ts、progress-scorer.ts、projection-observability-metrics.ts、stage-n-boot-assertion.ts、thinking-compatibility.ts、timer-disposal.ts、waste-scorer.ts。

### 跨模块迁出（Stage U U5.2）
- `document-engine/pipeline/` — 文档任务 pipeline 执行器、source materials、insight cache、task-plan、subtask runner、tool-loop orchestrator 等 10 文件（Stage U 之前位于 agent-control/）

### 入口约束（保留不动）
- `src/main/modules/claude-bridge/direct-chat.ts`：组装 provider / session / run cleanup 宿主，注册各 domain adapter，把运行时入口接到 `TurnEngine`
- `src/main/modules/agent-control/turn-engine.ts`：统一执行主链，按 route 选 adapter，再推进 prepare / dispatch / applyResult / buildProjectionPatch（4793 LOC，post-Stage-U 拆分候选）
