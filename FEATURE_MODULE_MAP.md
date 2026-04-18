# Feature Module Map

> Updated: 2026-04-18

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
- 用户级技能：custom skills，支持导入、移除、说明更新与运行调度
- Skill tools：由 `skills-runtime` 动态转换为 `skill_*` 工具，供 Agent 直接调用

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

## Agent Control 当前分层
- `src/main/modules/claude-bridge/direct-chat.ts`：组装 provider / session / run cleanup 宿主，注册各 domain adapter，把运行时入口接到 `TurnEngine`
- `src/main/modules/agent-control/turn-engine.ts`：统一执行主链，按 route 选 adapter，再推进 prepare / dispatch / applyResult / buildProjectionPatch
- `src/main/modules/agent-control/domain-adapter.ts`：adapter 合同、薄注册 helper、工具名前缀过滤
- `src/main/modules/agent-control/browser-domain-adapter.ts`：浏览器域接线层，复用既有 browser orchestrator
- `src/main/modules/agent-control/document-domain-adapter.ts`：文档域接线层，复用既有 document orchestrator、tool-loop orchestrator，并直连文档 pipeline 执行器
- `src/main/modules/agent-control/document-task-pipeline-executor.ts`：文档制卡 / 更新链路执行器，统一承接快照读取、insight 与 widget draft 缓存、task-plan 编排和最终写回
- `src/main/modules/agent-control/skill-domain-adapter.ts`
- `src/main/modules/agent-control/rss-domain-adapter.ts`
- `src/main/modules/agent-control/calendar-domain-adapter.ts`
- `src/main/modules/agent-control/feishu-domain-adapter.ts`
